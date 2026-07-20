'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { pool, withTransaction } = require('./db');
const { getMailerConfig, sendMail } = require('./mailer');
const { getFilePath, saveFileRecord, storeFile } = require('./files');
const brrr = require('./brrr');
const continuityPackets = require('./continuity-packets');
const continuityReadiness = require('./continuity-readiness');
const continuityDelivery = require('./continuity-delivery');

const INTERVALS = new Set([30, 90, 180]);
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const MAX_ATTEMPTS = 6;

function asDate(value, name = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || /[\r\n]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError('A valid reminder email is required');
  }
  return email;
}

function validateSchedule(intervalDays, gracePeriodDays) {
  const interval = Number(intervalDays);
  const grace = Number(gracePeriodDays);
  if (!INTERVALS.has(interval)) throw new TypeError('interval_days must be 30, 90, or 180');
  if (!Number.isInteger(grace) || grace < 7 || grace >= interval) {
    throw new TypeError('grace_period_days must be at least 7 and shorter than interval_days');
  }
  return { interval, grace };
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return parts;
}

function civilEpoch(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function resolveCivilTime(parts, timeZone) {
  const wanted = civilEpoch(parts);
  let guess = wanted;
  for (let i = 0; i < 5; i++) {
    const actual = civilEpoch(zonedParts(new Date(guess), timeZone));
    const delta = wanted - actual;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }
  return new Date(guess);
}

function addCalendarDays(value, days, timeZone = process.env.HOUSEHOLD_TIMEZONE || 'America/New_York') {
  const date = asDate(value);
  const current = zonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(current.year, current.month - 1, current.day + Number(days), current.hour, current.minute, current.second));
  return resolveCivilTime({
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds()
  }, timeZone);
}

function deriveTone(switchRow, now = new Date()) {
  if (!switchRow) return null;
  if (switchRow.status !== 'armed') return switchRow.status;
  const due = asDate(switchRow.next_checkin_due_at);
  const at = asDate(now);
  if (at >= due) return 'overdue';
  if (at >= addCalendarDays(due, -7)) return 'approaching';
  return 'healthy';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeErrorClass(value) {
  const normalized = String(value || 'delivery_failed').toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 80);
  return normalized || 'delivery_failed';
}

async function recordEvent(db, { switchId, type, actorId = null, cycle = 0, details = {}, dedupeKey, occurredAt = new Date() }) {
  const { rows } = await db.query(
    `INSERT INTO continuity_events (switch_id, event_type, actor_id, schedule_cycle, details, dedupe_key, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
     RETURNING *`,
    [switchId, type, actorId, cycle, JSON.stringify(details), dedupeKey, occurredAt]
  );
  return rows[0];
}

async function loadRecipients(db, switchId) {
  const { rows } = await db.query(
    `SELECT cr.*, m.name AS member_name, vt.name AS trustee_name, vt.email AS trustee_email,
            vt.status AS trustee_status
     FROM continuity_recipients cr
     LEFT JOIN family_members m ON m.id = cr.member_id
     LEFT JOIN vault_trustees vt ON vt.id = cr.trustee_id
     WHERE cr.switch_id = $1 ORDER BY cr.notification_order, cr.id`,
    [switchId]
  );
  return rows;
}

async function getSwitchForOwner(ownerId, db = pool) {
  const { rows } = await db.query(
    `SELECT cs.*, d.title AS letter_title,
            ((SELECT COUNT(*)::int FROM continuity_notification_outbox o
              WHERE o.switch_id = cs.id AND o.status IN ('pending', 'claimed')) +
             (SELECT COUNT(*)::int FROM continuity_brrr_outbox o
              WHERE o.switch_id = cs.id AND o.status IN ('pending', 'claimed'))) AS pending_outbox_count,
            ((SELECT COUNT(*)::int FROM continuity_notification_outbox o
              WHERE o.switch_id = cs.id AND o.status IN ('failed', 'blocked_configuration')) +
             (SELECT COUNT(*)::int FROM continuity_brrr_outbox o
              WHERE o.switch_id = cs.id AND o.status IN ('failed', 'blocked_configuration'))) AS failed_outbox_count
     FROM continuity_switches cs
     LEFT JOIN documents d ON d.id = cs.letter_document_id
     WHERE cs.owner_id = $1 AND cs.status <> 'cancelled'
     ORDER BY cs.id DESC LIMIT 1`,
    [Number(ownerId)]
  );
  if (!rows[0]) return null;
  const item = rows[0];
  item.recipients = await loadRecipients(db, item.id);
  item.delivery_run = await continuityDelivery.getRunForOwner({ ownerId, switchId: item.id }, db);
  item.tone = deriveTone(item);
  return item;
}

async function validateRecipients(db, recipients) {
  if (!Array.isArray(recipients) || recipients.length < 1) throw new TypeError('At least one continuity recipient is required');
  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < recipients.length; i++) {
    const input = recipients[i] || {};
    const memberId = Number(input.member_id || 0) || null;
    const trusteeId = Number(input.trustee_id || 0) || null;
    if (Boolean(memberId) === Boolean(trusteeId)) throw new TypeError('Each recipient must identify one beneficiary or trustee');
    if (memberId) {
      const { rows } = await db.query(`SELECT id, role FROM family_members WHERE id = $1`, [memberId]);
      if (!rows[0] || rows[0].role !== 'kid') throw new TypeError('Continuity beneficiaries must be household kids');
      if (seen.has(`m:${memberId}`)) throw new TypeError('Duplicate continuity recipient');
      seen.add(`m:${memberId}`);
      normalized.push({ memberId, trusteeId: null, role: 'beneficiary', order: i + 1 });
    } else {
      const { rows } = await db.query(`SELECT id, status FROM vault_trustees WHERE id = $1`, [trusteeId]);
      if (!rows[0] || rows[0].status !== 'registered') throw new TypeError('Continuity trustees must be registered');
      if (seen.has(`t:${trusteeId}`)) throw new TypeError('Duplicate continuity recipient');
      seen.add(`t:${trusteeId}`);
      normalized.push({ memberId: null, trusteeId, role: 'trustee', order: i + 1 });
    }
  }
  return normalized;
}

async function validateLetterEnvelope(db, { ownerId, recipients, encryptionMetadata }) {
  const entry = encryptionMetadata?.files?.upload;
  if (Number(encryptionMetadata?.version) !== 2 || encryptionMetadata?.mode !== 'pki' || !entry) {
    throw new TypeError('Continuity letters require a version 2 PKI upload envelope');
  }
  const holders = Array.isArray(entry.holders) ? entry.holders : [];
  if (!holders.length) throw new TypeError('Continuity letter envelope requires holders');
  const normalizedRecipients = await validateRecipients(db, recipients);
  const expected = new Map(normalizedRecipients.map((recipient) => [
    recipient.memberId ? `m:${recipient.memberId}` : `t:${recipient.trusteeId}`, recipient
  ]));
  let ownerHolder = null;
  const matched = new Set();
  for (const holder of holders) {
    const keyId = Number(holder.encryption_key_id || 0);
    if (!keyId || !holder.key_fingerprint || holder?.wrapped_dek?.kind !== 'pki_x25519') {
      throw new TypeError('Every continuity holder requires active key identity and holder-local wrapped DEK metadata');
    }
    const { rows } = await db.query(
      `SELECT id, key_type, member_id, trustee_id, key_fingerprint, revoked_at
       FROM encryption_keys WHERE id = $1`, [keyId]
    );
    const key = rows[0];
    if (!key || key.revoked_at || key.key_fingerprint !== holder.key_fingerprint) {
      throw new TypeError('Continuity letter holder key is unavailable or mismatched');
    }
    if (Number(holder.member_id) === Number(ownerId) && !holder.trustee_id && holder.role === 'owner') {
      if (holder.sealed === true || key.key_type !== 'member' || Number(key.member_id) !== Number(ownerId)) {
        throw new TypeError('The owning parent holder must be active and unsealed');
      }
      if (ownerHolder) throw new TypeError('Continuity letter requires exactly one owning-parent holder');
      ownerHolder = holder;
      continue;
    }
    const identity = holder.member_id ? `m:${Number(holder.member_id)}` : `t:${Number(holder.trustee_id)}`;
    const recipient = expected.get(identity);
    if (!recipient || matched.has(identity)) throw new TypeError('Letter envelope recipient set does not match switch recipients');
    if (holder.sealed !== true || holder.sealed_until !== 'deadman_trigger' || holder.role !== recipient.role) {
      throw new TypeError('Every continuity recipient holder must remain sealed until the continuity trigger');
    }
    if (recipient.memberId && (key.key_type !== 'member' || Number(key.member_id) !== recipient.memberId)) {
      throw new TypeError('Beneficiary holder key does not belong to the selected member');
    }
    if (recipient.trusteeId && (key.key_type !== 'trustee' || Number(key.trustee_id) !== recipient.trusteeId)) {
      throw new TypeError('Trustee holder key does not belong to the selected trustee');
    }
    matched.add(identity);
  }
  if (!ownerHolder) throw new TypeError('Continuity letter requires an active unsealed owning-parent holder');
  if (matched.size !== expected.size || holders.length !== expected.size + 1) {
    throw new TypeError('Letter envelope recipient set does not match switch recipients');
  }
  return { ownerHolder, recipients: normalizedRecipients, holders };
}

async function stageLetter({ ownerId, switchId, recipients, encryptionMetadata, encryptedBytes, operationKey }) {
  if (!Buffer.isBuffer(encryptedBytes) || encryptedBytes.length < 1) throw new TypeError('Encrypted letter bytes are required');
  const op = String(operationKey || '').trim();
  if (!op || op.length > 120) throw new TypeError('A bounded operation_key is required');
  const dedupe = `switch:${switchId}:letter-stage:${op}`;
  const existing = await pool.query(
    `SELECT (details->>'document_id')::int AS document_id FROM continuity_events WHERE dedupe_key = $1`, [dedupe]
  );
  if (existing.rows[0]?.document_id) {
    const { rows } = await pool.query(`SELECT * FROM documents WHERE id = $1 AND status = 'staged'`, [existing.rows[0].document_id]);
    if (rows[0]) return rows[0];
  }
  const stored = await storeFile(encryptedBytes, 'the-letter.txt.enc', 'application/octet-stream');
  let previousFiles = [];
  let storedWasUsed = true;
  try {
    const result = await withTransaction(async (db) => {
      const { rows: switchRows } = await db.query(
        `SELECT * FROM continuity_switches WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [switchId, ownerId]
      );
      const item = switchRows[0];
      if (!item || !['draft', 'armed', 'paused'].includes(item.status)) throw new Error('Continuity letter cannot be staged in this state');
      const replay = await db.query(`SELECT details->>'document_id' AS document_id FROM continuity_events WHERE dedupe_key = $1`, [dedupe]);
      if (replay.rows[0]?.document_id) {
        const replayDoc = await db.query(`SELECT * FROM documents WHERE id = $1 AND status = 'staged'`, [Number(replay.rows[0].document_id)]);
        if (replayDoc.rows[0]) { storedWasUsed = false; return replayDoc.rows[0]; }
      }
      const validated = await validateLetterEnvelope(db, { ownerId, recipients, encryptionMetadata });
      const previousStagedId = item.staged_letter_document_id;
      const preservePreviousStaged = Boolean(item.staged_packet_version_id);
      if (item.staged_letter_document_id && !preservePreviousStaged) {
        const fileResult = await db.query('SELECT stored_filename FROM document_files WHERE document_id = $1', [item.staged_letter_document_id]);
        previousFiles = fileResult.rows.map((row) => row.stored_filename);
      }
      const { rows: docs } = await db.query(
        `INSERT INTO documents
           (title, description, document_type, source_type, status, metadata, is_encrypted,
            encryption_mode, encryption_metadata, encryption_key_id, created_by)
         VALUES ('The Letter', NULL, 'legal', 'authored', 'staged', $1, TRUE, 'pki', $2, $3, $4)
         RETURNING *`,
        [JSON.stringify({ continuity_letter: true }), JSON.stringify(encryptionMetadata), validated.ownerHolder.encryption_key_id, ownerId]
      );
      const doc = docs[0];
      await db.query(
        `INSERT INTO document_owners (document_id, member_id, ownership_type) VALUES ($1, $2, 'owner')`,
        [doc.id, ownerId]
      );
      await saveFileRecord(doc.id, stored, db);
      for (const holder of validated.holders.filter((candidate) => candidate.role !== 'owner')) {
        await db.query(
          `INSERT INTO document_designations
             (document_id, member_id, trustee_id, role, sealed, sealed_until, encryption_key_id)
           VALUES ($1, $2, $3, $4, TRUE, 'deadman_trigger', $5)`,
          [doc.id, holder.member_id || null, holder.trustee_id || null, holder.role, holder.encryption_key_id]
        );
      }
      if (item.staged_packet_version_id) {
        await db.query(
          `UPDATE continuity_packet_versions SET status = 'superseded', superseded_at = NOW()
           WHERE id = $1 AND status = 'staged'`, [item.staged_packet_version_id]
        );
      }
      await db.query(
        `UPDATE continuity_switches SET staged_letter_document_id = $2,
                staged_packet_version_id = NULL, updated_at = NOW() WHERE id = $1`,
        [item.id, doc.id]
      );
      if (previousStagedId) {
        if (preservePreviousStaged) await db.query(`UPDATE documents SET status = 'archived' WHERE id = $1 AND status = 'staged'`, [previousStagedId]);
        else await db.query('DELETE FROM documents WHERE id = $1 AND status = $2', [previousStagedId, 'staged']);
      }
      await recordEvent(db, {
        switchId: item.id, type: 'letter.staged', actorId: ownerId, cycle: item.schedule_cycle,
        details: { document_id: doc.id, recipient_count: validated.recipients.length }, dedupeKey: dedupe
      });
      return doc;
    });
    if (!storedWasUsed) {
      try { fs.unlinkSync(getFilePath(stored.stored_filename)); } catch {}
      return result;
    }
    for (const filename of previousFiles) {
      try { fs.unlinkSync(getFilePath(filename)); } catch (err) {
        console.error(`SECURITY: staged continuity artifact cleanup failed: ${filename}`, err.message);
      }
    }
    return result;
  } catch (err) {
    try { fs.unlinkSync(getFilePath(stored.stored_filename)); } catch {}
    throw err;
  }
}

async function commitStagedLetter({ ownerId, switchId, now = new Date(), operationKey }) {
  const at = asDate(now);
  const op = String(operationKey || crypto.randomUUID()).slice(0, 120);
  const dedupe = `switch:${switchId}:letter-commit:${op}`;
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM continuity_switches WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [switchId, ownerId]
    );
    const item = rows[0];
    if (!item || !['draft', 'armed', 'paused'].includes(item.status)) throw new Error('Continuity letter cannot be committed in this state');
    const replay = await db.query('SELECT id FROM continuity_events WHERE dedupe_key = $1', [dedupe]);
    if (replay.rows[0]) return item;
    if (!item.staged_letter_document_id) throw new Error('An encrypted staged letter is required');
    const { rows: docs } = await db.query(
      `SELECT * FROM documents WHERE id = $1 AND status = 'staged' AND source_type = 'authored' FOR UPDATE`,
      [item.staged_letter_document_id]
    );
    const doc = docs[0];
    if (!doc || doc.encryption_mode !== 'pki' || doc.is_encrypted !== true) throw new Error('The staged letter is not a valid encrypted authored document');
    const { rows: projected } = await db.query(
      `SELECT member_id, trustee_id, role, encryption_key_id FROM document_designations WHERE document_id = $1 ORDER BY id`, [doc.id]
    );
    await validateLetterEnvelope(db, {
      ownerId, recipients: projected, encryptionMetadata: doc.encryption_metadata
    });
    await continuityReadiness.assertActivationReadiness({ db, switchRow: item, ownerId, now: at });
    const packet = await continuityPackets.activatePacket(db, { switchRow: item, ownerId, now: at });
    const wasDraft = item.status === 'draft';
    const cycle = wasDraft ? Number(item.schedule_cycle) + 1 : Number(item.schedule_cycle);
    const nextDue = wasDraft ? addCalendarDays(at, item.interval_days) : item.next_checkin_due_at;
    if (item.letter_document_id) {
      await db.query(`UPDATE documents SET status = 'archived' WHERE id = $1`, [item.letter_document_id]);
    }
    await db.query(`UPDATE documents SET status = 'active' WHERE id = $1`, [doc.id]);
    await db.query('DELETE FROM continuity_recipients WHERE switch_id = $1', [item.id]);
    for (let i = 0; i < projected.length; i++) {
      const recipient = projected[i];
      await db.query(
        `INSERT INTO continuity_recipients (switch_id, member_id, trustee_id, role, notification_order)
         VALUES ($1, $2, $3, $4, $5)`, [item.id, recipient.member_id, recipient.trustee_id, recipient.role, i + 1]
      );
    }
    const { rows: updated } = await db.query(
      `UPDATE continuity_switches SET letter_document_id = $2, staged_letter_document_id = NULL,
              status = $3, schedule_cycle = $4, next_checkin_due_at = $5, updated_at = $6,
              active_packet_version_id = $7, staged_packet_version_id = NULL
       WHERE id = $1 RETURNING *`,
      [item.id, doc.id, wasDraft ? 'armed' : item.status, cycle, nextDue, at, packet.id]
    );
    await recordEvent(db, {
      switchId: item.id, type: wasDraft ? 'switch.armed' : 'letter.replaced', actorId: ownerId,
      cycle, details: { document_id: doc.id, prior_document_id: item.letter_document_id || null,
        packet_version_id: packet.id, packet_version: Number(packet.version_number) },
      dedupeKey: dedupe, occurredAt: at
    });
    return updated[0];
  });
}

async function saveDraft({ ownerId, reminderEmail, intervalDays, gracePeriodDays = 14, recipients, operationKey }) {
  const email = normalizeEmail(reminderEmail);
  const { interval, grace } = validateSchedule(intervalDays, gracePeriodDays);
  const op = String(operationKey || crypto.randomUUID()).slice(0, 120);
  return withTransaction(async (db) => {
    const normalizedRecipients = await validateRecipients(db, recipients);
    const { rows } = await db.query(
      `INSERT INTO continuity_switches (owner_id, reminder_email, interval_days, grace_period_days)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id) WHERE status <> 'cancelled'
       DO UPDATE SET reminder_email = EXCLUDED.reminder_email,
                     interval_days = EXCLUDED.interval_days,
                     grace_period_days = EXCLUDED.grace_period_days,
                     updated_at = NOW()
       RETURNING *`,
      [ownerId, email, interval, grace]
    );
    const switchRow = rows[0];
    if (switchRow.status !== 'draft') throw new Error('Only a draft switch can change setup recipients or cadence');
    await db.query('DELETE FROM continuity_recipients WHERE switch_id = $1', [switchRow.id]);
    for (const recipient of normalizedRecipients) {
      await db.query(
        `INSERT INTO continuity_recipients (switch_id, member_id, trustee_id, role, notification_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [switchRow.id, recipient.memberId, recipient.trusteeId, recipient.role, recipient.order]
      );
    }
    await recordEvent(db, {
      switchId: switchRow.id, type: 'switch.draft_saved', actorId: ownerId,
      cycle: switchRow.schedule_cycle, details: { recipient_count: normalizedRecipients.length },
      dedupeKey: `switch:${switchRow.id}:draft:${op}`
    });
    switchRow.recipients = await loadRecipients(db, switchRow.id);
    switchRow.tone = 'draft';
    return switchRow;
  });
}

async function invalidateTokens(db, switchId, at = new Date()) {
  await db.query(
    `UPDATE continuity_checkin_tokens SET replaced_at = COALESCE(replaced_at, $2)
     WHERE switch_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
    [switchId, at]
  );
}

async function supersedeOutbox(db, switchId, at = new Date()) {
  await db.query(
    `UPDATE continuity_notification_outbox
     SET status = 'superseded', superseded_at = $2, claimed_by = NULL, claim_expires_at = NULL, updated_at = $2
     WHERE switch_id = $1 AND status IN ('pending', 'claimed', 'blocked_configuration')`,
    [switchId, at]
  );
  await db.query(
    `UPDATE continuity_brrr_outbox
     SET status = 'superseded', superseded_at = $2, claimed_by = NULL, claim_expires_at = NULL, updated_at = $2
     WHERE switch_id = $1 AND status IN ('pending', 'claimed', 'blocked_configuration')`,
    [switchId, at]
  );
}

async function checkIn({ switchId, ownerId = null, rawToken = null, now = new Date(), operationKey = null }) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM continuity_switches WHERE id = $1 FOR UPDATE', [switchId]);
    const switchRow = rows[0];
    if (!switchRow || switchRow.status !== 'armed') throw new Error('This check-in is not available');
    if (ownerId !== null && Number(switchRow.owner_id) !== Number(ownerId)) throw new Error('This check-in is not available');
    if (ownerId !== null && operationKey) {
      const dedupe = `switch:${switchRow.id}:checkin:${operationKey}`;
      const replay = await db.query('SELECT id FROM continuity_events WHERE dedupe_key = $1', [dedupe]);
      if (replay.rows[0]) return switchRow;
    }
    let tokenRow = null;
    if (rawToken !== null) {
      const tokenResult = await db.query(
        `SELECT * FROM continuity_checkin_tokens
         WHERE switch_id = $1 AND token_hash = $2 AND consumed_at IS NULL AND replaced_at IS NULL
           AND expires_at > $3 FOR UPDATE`,
        [switchId, tokenHash(rawToken), at]
      );
      tokenRow = tokenResult.rows[0];
      if (!tokenRow || Number(tokenRow.schedule_cycle) !== Number(switchRow.schedule_cycle)) throw new Error('This check-in is not available');
      await db.query('UPDATE continuity_checkin_tokens SET consumed_at = $2 WHERE id = $1', [tokenRow.id, at]);
    }
    await invalidateTokens(db, switchRow.id, at);
    await supersedeOutbox(db, switchRow.id, at);
    const cycle = Number(switchRow.schedule_cycle) + 1;
    const nextDue = addCalendarDays(at, switchRow.interval_days);
    const { rows: updated } = await db.query(
      `UPDATE continuity_switches SET schedule_cycle = $2, last_checkin_at = $3,
              next_checkin_due_at = $4, updated_at = $3
       WHERE id = $1 RETURNING *`,
      [switchRow.id, cycle, at, nextDue]
    );
    await recordEvent(db, {
      switchId: switchRow.id, type: 'switch.checked_in', actorId: ownerId,
      cycle, details: { channel: rawToken === null ? 'app' : 'email', next_checkin_due_at: nextDue },
      dedupeKey: `switch:${switchRow.id}:checkin:${operationKey || tokenRow?.id || crypto.randomUUID()}`, occurredAt: at
    });
    return updated[0];
  });
}

async function transitionOwnerAction({ switchId, ownerId, action, now = new Date(), operationKey = null }) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM continuity_switches WHERE id = $1 AND owner_id = $2 FOR UPDATE', [switchId, ownerId]);
    const item = rows[0];
    if (!item) throw new Error('Continuity switch not found');
    const dedupeKey = operationKey ? `switch:${item.id}:${action}:${operationKey}` : null;
    if (dedupeKey) {
      const replay = await db.query('SELECT id FROM continuity_events WHERE dedupe_key = $1', [dedupeKey]);
      if (replay.rows[0]) return item;
    }
    let nextStatus;
    let nextDue = item.next_checkin_due_at;
    let cycle = Number(item.schedule_cycle);
    if (action === 'pause' && item.status === 'armed') nextStatus = 'paused';
    else if (action === 'resume' && item.status === 'paused') {
      nextStatus = 'armed'; cycle += 1; nextDue = addCalendarDays(at, item.interval_days);
    } else if (action === 'cancel' && ['armed', 'paused', 'draft'].includes(item.status)) nextStatus = 'cancelled';
    else throw new Error(`Cannot ${action} a switch in ${item.status} state`);
    if (action === 'pause' || action === 'cancel') {
      await invalidateTokens(db, item.id, at);
      await supersedeOutbox(db, item.id, at);
    }
    const { rows: updated } = await db.query(
      `UPDATE continuity_switches SET status = $2, schedule_cycle = $3, next_checkin_due_at = $4,
              paused_at = CASE WHEN $2 = 'paused' THEN $5 WHEN $2 = 'armed' THEN NULL ELSE paused_at END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN $5 ELSE cancelled_at END,
              updated_at = $5 WHERE id = $1 RETURNING *`,
      [item.id, nextStatus, cycle, nextDue, at]
    );
    const eventType = { pause: 'switch.paused', resume: 'switch.resumed', cancel: 'switch.cancelled' }[action];
    await recordEvent(db, {
      switchId: item.id, type: eventType, actorId: ownerId, cycle,
      dedupeKey: dedupeKey || `switch:${item.id}:${action}:${crypto.randomUUID()}`, occurredAt: at
    });
    return updated[0];
  });
}

function milestoneSchedule(item) {
  const due = asDate(item.next_checkin_due_at);
  return [
    { type: 'reminder_approaching', at: addCalendarDays(due, -7), rank: 1 },
    { type: 'reminder_due', at: due, rank: 2 },
    { type: 'reminder_overdue', at: addCalendarDays(due, 7), rank: 3 },
    { type: 'grace_expired', at: addCalendarDays(due, item.grace_period_days), rank: 4 }
  ];
}

async function enqueueOutbox(db, item, event, type, now) {
  const notificationType = type === 'grace_expired' ? 'delivery_pending_owner_notice' : type;
  const messageId = `<continuity-${item.id}-${item.schedule_cycle}-${notificationType}-0@homesource.local>`;
  const { rows } = await db.query(
    `INSERT INTO continuity_notification_outbox
       (switch_id, event_id, schedule_cycle, notification_type, recipient_email, message_id, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (switch_id, schedule_cycle, notification_type, recipient_email)
     DO UPDATE SET event_id = EXCLUDED.event_id
     RETURNING *`,
    [item.id, event.id, item.schedule_cycle, notificationType, item.reminder_email, messageId, now]
  );
  await db.query(
    `INSERT INTO continuity_brrr_outbox
       (switch_id, event_id, notification_channel_id, schedule_cycle, notification_type,
        channel_config_version, target_fingerprint, next_attempt_at)
     SELECT $1, $2, channel.id, $3, $4, channel.config_version, channel.target_fingerprint, $5
     FROM member_notification_channels channel
     WHERE channel.member_id = $6 AND channel.channel_type = 'brrr' AND channel.enabled = TRUE
       AND channel.target_secret IS NOT NULL AND channel.target_fingerprint IS NOT NULL
     ON CONFLICT (switch_id, schedule_cycle, notification_type, notification_channel_id)
     DO UPDATE SET event_id = EXCLUDED.event_id`,
    [item.id, event.id, item.schedule_cycle, notificationType, now, item.owner_id]
  );
  return rows[0];
}

async function advanceDueSwitches({ now = new Date(), dbPool = pool } = {}) {
  const at = asDate(now);
  const runResult = await dbPool.query(
    `INSERT INTO continuity_scheduler_runs (job_type, status) VALUES ('state_advance', 'running') RETURNING id`
  );
  const runId = runResult.rows[0].id;
  let claimed = 0;
  let transitions = 0;
  try {
    const result = await withTransaction(async (db) => {
      const { rows: items } = await db.query(
        `SELECT * FROM continuity_switches
         WHERE status = 'armed' AND next_checkin_due_at - INTERVAL '8 days' <= $1
         ORDER BY id FOR UPDATE SKIP LOCKED`, [at]
      );
      claimed = items.length;
      for (const item of items) {
        const due = milestoneSchedule(item).filter((milestone) => milestone.at <= at);
        if (!due.length) continue;
        let newest = null;
        for (const milestone of due) {
          const dedupe = `switch:${item.id}:cycle:${item.schedule_cycle}:${milestone.type}`;
          const existing = await db.query('SELECT id FROM continuity_events WHERE dedupe_key = $1', [dedupe]);
          if (existing.rows[0]) continue;
          const event = await recordEvent(db, {
            switchId: item.id, type: `switch.${milestone.type}`, cycle: item.schedule_cycle,
            details: { scheduled_for: milestone.at }, dedupeKey: dedupe, occurredAt: at
          });
          transitions += 1;
          newest = { milestone, event };
        }
        if (!newest) continue;
        await supersedeOutbox(db, item.id, at);
        if (newest.milestone.type === 'grace_expired') {
          await db.query(
            `UPDATE continuity_switches SET status = 'delivery_pending', delivery_pending_at = $2, updated_at = $2 WHERE id = $1`,
            [item.id, at]
          );
          await invalidateTokens(db, item.id, at);
        }
        await enqueueOutbox(db, item, newest.event, newest.milestone.type, at);
      }
      const initialized = await continuityDelivery.initializePendingRuns(db, at);
      const released = await continuityDelivery.advanceRunDeadlines(db, at);
      transitions += initialized.transitioned + released;
      claimed += initialized.created + released;
      return { claimed, transitions, delivery_runs_created: initialized.created, delivery_runs_released: released };
    });
    await dbPool.query(
      `UPDATE continuity_scheduler_runs SET status = 'succeeded', claimed_count = $2,
              transition_count = $3, completed_at = NOW() WHERE id = $1`,
      [runId, claimed, transitions]
    );
    return result;
  } catch (err) {
    await dbPool.query(
      `UPDATE continuity_scheduler_runs SET status = 'failed', claimed_count = $2,
              transition_count = $3, error_class = $4, completed_at = NOW() WHERE id = $1`,
      [runId, claimed, transitions, safeErrorClass(err.code || err.name)]
    ).catch(() => {});
    throw err;
  }
}

function checkinUrl(token, env = process.env) {
  const raw = String(env.APP_URL || '').trim();
  if (!raw) throw new Error('APP_URL is not configured');
  const url = new URL('check-in.html', raw.endsWith('/') ? raw : `${raw}/`);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('APP_URL must use HTTPS except on localhost');
  }
  url.searchParams.set('token', token);
  return url.toString();
}

function reminderMessage(item, token, messageId, env = process.env) {
  const boundary = item.notification_type === 'delivery_pending_owner_notice';
  return {
    to: item.recipient_email,
    messageId,
    subject: boundary ? 'Home Source check-in needs your attention' : 'A gentle Home Source check-in',
    text: boundary
      ? 'Your Home Source check-in grace period ended and the continuity verification process has started. Designated witnesses may now be contacted, but no beneficiary grant was created and no sealed material was opened. Sign in to Home Source to review or stop it by proving you are here.'
      : `A Home Source check-in is due. Use this single-purpose link to check in:\n\n${checkinUrl(token, env)}\n\nThe link expires in seven days and does not create an app session. No document contents are included.`
  };
}

async function claimOutboxAttempt({ now, workerId, env, dbPool }) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, cs.status AS switch_status
       FROM continuity_notification_outbox o
       JOIN continuity_switches cs ON cs.id = o.switch_id
       WHERE o.notification_type <> 'trustee_verification'
         AND ((o.status = 'pending' AND o.next_attempt_at <= $1)
          OR (o.status = 'claimed' AND o.claim_expires_at <= $1))
       ORDER BY o.next_attempt_at, o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
      [now]
    );
    const item = rows[0];
    if (!item) return null;
    const config = getMailerConfig(env);
    if (config.transport === 'disabled') {
      await db.query(
        `UPDATE continuity_notification_outbox SET status = 'blocked_configuration', blocked_at = $2,
                last_error_class = 'mail_transport_disabled', updated_at = $2 WHERE id = $1`,
        [item.id, now]
      );
      return { blocked: true, status: 'blocked_configuration' };
    }
    const attempt = Number(item.attempt_count) + 1;
    const messageId = `<continuity-${item.id}-${attempt}@homesource.local>`;
    let token = null;
    if (item.notification_type !== 'delivery_pending_owner_notice') {
      if (item.switch_status !== 'armed') {
        await db.query(`UPDATE continuity_notification_outbox SET status = 'superseded', superseded_at = $2, updated_at = $2 WHERE id = $1`, [item.id, now]);
        return { blocked: true, status: 'superseded' };
      }
      token = crypto.randomBytes(32).toString('base64url');
      await invalidateTokens(db, item.switch_id, now);
      await db.query(
        `INSERT INTO continuity_checkin_tokens (switch_id, schedule_cycle, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [item.switch_id, item.schedule_cycle, tokenHash(token), new Date(now.getTime() + TOKEN_TTL_MS)]
      );
    }
    const { rows: updated } = await db.query(
      `UPDATE continuity_notification_outbox SET status = 'claimed', attempt_count = $2,
              message_id = $3, claimed_by = $4, claim_expires_at = $5, updated_at = $6
       WHERE id = $1 RETURNING *`,
      [item.id, attempt, messageId, workerId, new Date(now.getTime() + 15 * 60_000), now]
    );
    return { item: updated[0], token, messageId };
  });
}

async function claimBrrrOutboxAttempt({ now, workerId }) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT o.*, cs.status AS switch_status,
              channel.enabled AS channel_enabled, channel.target_secret,
              channel.target_fingerprint AS current_target_fingerprint,
              channel.config_version AS current_config_version
       FROM continuity_brrr_outbox o
       JOIN continuity_switches cs ON cs.id = o.switch_id
       LEFT JOIN member_notification_channels channel ON channel.id = o.notification_channel_id
       WHERE ((o.status = 'pending' AND o.next_attempt_at <= $1)
          OR (o.status = 'claimed' AND o.claim_expires_at <= $1))
       ORDER BY o.next_attempt_at, o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
      [now]
    );
    const item = rows[0];
    if (!item) return null;
    const currentConfiguration = item.channel_enabled === true && item.target_secret
      && item.current_target_fingerprint === item.target_fingerprint
      && Number(item.current_config_version) === Number(item.channel_config_version);
    if (!currentConfiguration) {
      await db.query(
        `UPDATE continuity_brrr_outbox SET status = 'superseded', superseded_at = $2,
                claimed_by = NULL, claim_expires_at = NULL,
                last_error_class = 'channel_configuration_changed', updated_at = $2
         WHERE id = $1`,
        [item.id, now]
      );
      return { blocked: true, status: 'superseded' };
    }
    const validSwitchState = item.notification_type === 'delivery_pending_owner_notice'
      ? item.switch_status === 'delivery_pending'
      : item.switch_status === 'armed';
    if (!validSwitchState) {
      await db.query(
        `UPDATE continuity_brrr_outbox SET status = 'superseded', superseded_at = $2,
                claimed_by = NULL, claim_expires_at = NULL,
                last_error_class = 'switch_state_changed', updated_at = $2
         WHERE id = $1`,
        [item.id, now]
      );
      return { blocked: true, status: 'superseded' };
    }
    const attempt = Number(item.attempt_count) + 1;
    const { rows: updated } = await db.query(
      `UPDATE continuity_brrr_outbox SET status = 'claimed', attempt_count = $2,
              claimed_by = $3, claim_expires_at = $4, updated_at = $5
       WHERE id = $1 RETURNING *`,
      [item.id, attempt, workerId, new Date(now.getTime() + 15 * 60_000), now]
    );
    return { item: updated[0], target: item.target_secret };
  });
}

function brrrReminderMessage() {
  return {
    title: 'Home Source',
    message: 'A private Home Source check-in needs your attention.'
  };
}

function isPermanentBrrrError(error) {
  if (error instanceof TypeError) return true;
  const status = Number(error?.statusCode || 0);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function dispatchOutbox({
  now = new Date(), env = process.env, mailer = { sendMail },
  brrrSender = brrr.sendBrrrNotification, dbPool = pool,
  workerId = `continuity-${process.pid}`
} = {}) {
  const at = asDate(now);
  const runResult = await dbPool.query(
    `INSERT INTO continuity_scheduler_runs (job_type, status) VALUES ('outbox_dispatch', 'running') RETURNING id`
  );
  const runId = runResult.rows[0].id;
  let claimed = 0;
  let sent = 0;
  let failed = 0;
  const channels = {
    email: { claimed: 0, sent: 0, failed: 0, blocked: 0, superseded: 0 },
    brrr: { claimed: 0, sent: 0, failed: 0, blocked: 0, superseded: 0 }
  };
  try {
    while (true) {
      const claimedAttempt = await claimOutboxAttempt({ now: at, workerId, env, dbPool });
      if (!claimedAttempt) break;
      if (claimedAttempt.blocked) {
        channels.email[claimedAttempt.status === 'superseded' ? 'superseded' : 'blocked'] += 1;
        if (claimedAttempt.status !== 'superseded') failed += 1;
        continue;
      }
      claimed += 1;
      channels.email.claimed += 1;
      const { item, token, messageId } = claimedAttempt;
      let result;
      try {
        result = await mailer.sendMail(reminderMessage(item, token, messageId, env));
      } catch (err) {
        result = { delivered: false, reason: safeErrorClass(err.code || err.name), retryable: err instanceof TypeError ? false : true };
      }
      if (result.delivered) {
        await dbPool.query(
          `UPDATE continuity_notification_outbox SET status = 'sent', sent_at = $2,
                  claimed_by = NULL, claim_expires_at = NULL, last_error_class = NULL, updated_at = $2
           WHERE id = $1 AND claimed_by = $3`, [item.id, at, workerId]
        );
        sent += 1;
        channels.email.sent += 1;
      } else {
        const permanent = result.retryable === false || Number(item.attempt_count) >= MAX_ATTEMPTS;
        const delay = RETRY_DELAYS_MS[Math.min(Number(item.attempt_count) - 1, RETRY_DELAYS_MS.length - 1)];
        await dbPool.query(
          `UPDATE continuity_notification_outbox
           SET status = $2, failed_at = CASE WHEN $2::text = 'failed' THEN $3::timestamptz ELSE NULL::timestamptz END,
               next_attempt_at = $4, claimed_by = NULL, claim_expires_at = NULL,
               last_error_class = $5, updated_at = $3 WHERE id = $1 AND claimed_by = $6`,
          [item.id, permanent ? 'failed' : 'pending', at, new Date(at.getTime() + delay), safeErrorClass(result.error_class || result.reason), workerId]
        );
        failed += 1;
        channels.email.failed += 1;
      }
    }
    while (true) {
      const claimedAttempt = await continuityDelivery.claimTrusteeOutboxAttempt({ now: at, workerId, env });
      if (!claimedAttempt) break;
      if (claimedAttempt.blocked) {
        channels.email[claimedAttempt.status === 'superseded' ? 'superseded' : 'blocked'] += 1;
        if (claimedAttempt.status !== 'superseded') failed += 1;
        continue;
      }
      claimed += 1;
      channels.email.claimed += 1;
      const { item, token, messageId } = claimedAttempt;
      let result;
      try {
        result = await mailer.sendMail(continuityDelivery.trusteeNotificationMessage(item, token, messageId, env));
      } catch (err) {
        result = { delivered: false, reason: safeErrorClass(err.code || err.name), retryable: !(err instanceof TypeError) };
      }
      const completed = await continuityDelivery.completeTrusteeOutboxAttempt({
        item, workerId, now: at, result, maxAttempts: MAX_ATTEMPTS, retryDelaysMs: RETRY_DELAYS_MS
      });
      if (completed.sent) {
        sent += 1;
        channels.email.sent += 1;
      } else if (!completed.ignored) {
        failed += 1;
        channels.email.failed += 1;
      }
    }
    while (true) {
      const claimedAttempt = await claimBrrrOutboxAttempt({ now: at, workerId });
      if (!claimedAttempt) break;
      if (claimedAttempt.blocked) {
        channels.brrr[claimedAttempt.status === 'superseded' ? 'superseded' : 'blocked'] += 1;
        if (claimedAttempt.status !== 'superseded') failed += 1;
        continue;
      }
      claimed += 1;
      channels.brrr.claimed += 1;
      const { item, target } = claimedAttempt;
      try {
        await brrrSender(target, brrrReminderMessage());
        await dbPool.query(
          `UPDATE continuity_brrr_outbox SET status = 'sent', sent_at = $2,
                  claimed_by = NULL, claim_expires_at = NULL, last_error_class = NULL, updated_at = $2
           WHERE id = $1 AND claimed_by = $3`,
          [item.id, at, workerId]
        );
        sent += 1;
        channels.brrr.sent += 1;
      } catch (error) {
        const permanent = isPermanentBrrrError(error) || Number(item.attempt_count) >= MAX_ATTEMPTS;
        const delay = RETRY_DELAYS_MS[Math.min(Number(item.attempt_count) - 1, RETRY_DELAYS_MS.length - 1)];
        await dbPool.query(
          `UPDATE continuity_brrr_outbox
           SET status = $2, failed_at = CASE WHEN $2::text = 'failed' THEN $3::timestamptz ELSE NULL::timestamptz END,
               next_attempt_at = $4, claimed_by = NULL, claim_expires_at = NULL,
               last_error_class = $5, updated_at = $3 WHERE id = $1 AND claimed_by = $6`,
          [item.id, permanent ? 'failed' : 'pending', at, new Date(at.getTime() + delay),
            safeErrorClass(error.code || (error.statusCode ? `http_${error.statusCode}` : error.name)), workerId]
        );
        failed += 1;
        channels.brrr.failed += 1;
      }
    }
    await dbPool.query(
      `UPDATE continuity_scheduler_runs SET status = 'succeeded', claimed_count = $2,
              sent_count = $3, failed_count = $4, completed_at = NOW() WHERE id = $1`,
      [runId, claimed, sent, failed]
    );
    return { claimed, sent, failed, channels };
  } catch (err) {
    await dbPool.query(
      `UPDATE continuity_scheduler_runs SET status = 'failed', claimed_count = $2,
              sent_count = $3, failed_count = $4, error_class = $5, completed_at = NOW() WHERE id = $1`,
      [runId, claimed, sent, failed, safeErrorClass(err.code || err.name)]
    ).catch(() => {});
    throw err;
  }
}

async function getTokenSwitch(rawToken, db = pool, now = new Date()) {
  const { rows } = await db.query(
    `SELECT ct.id AS token_id, ct.switch_id, ct.expires_at, cs.status
     FROM continuity_checkin_tokens ct JOIN continuity_switches cs ON cs.id = ct.switch_id
     WHERE ct.token_hash = $1 AND ct.consumed_at IS NULL AND ct.replaced_at IS NULL
       AND ct.expires_at > $2 AND cs.status = 'armed'`,
    [tokenHash(rawToken), now]
  );
  return rows[0] || null;
}

async function getOperationsStatus(db = pool) {
  const { rows: runs } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (job_type) job_type, status, started_at, completed_at, error_class
       FROM continuity_scheduler_runs ORDER BY job_type, started_at DESC
     )
     SELECT latest.*,
            (SELECT MAX(ok.completed_at) FROM continuity_scheduler_runs ok
             WHERE ok.job_type = latest.job_type AND ok.status = 'succeeded') AS last_successful_at
     FROM latest ORDER BY job_type`
  );
  const { rows: counts } = await db.query(
    `SELECT channel,
            COUNT(*) FILTER (WHERE status IN ('pending', 'claimed'))::int AS pending,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'blocked_configuration')::int AS blocked
     FROM (
       SELECT 'email'::text AS channel, status FROM continuity_notification_outbox
       UNION ALL
       SELECT 'brrr'::text AS channel, status FROM continuity_brrr_outbox
     ) attempts
     GROUP BY channel`
  );
  const config = getMailerConfig();
  const byChannel = Object.fromEntries(['email', 'brrr'].map((channel) => [channel,
    counts.find((row) => row.channel === channel) || { channel, pending: 0, failed: 0, blocked: 0 }
  ]));
  const outbox = ['pending', 'failed', 'blocked'].reduce((total, field) => {
    total[field] = Number(byChannel.email[field]) + Number(byChannel.brrr[field]);
    return total;
  }, {});
  return {
    runs, outbox, channels: byChannel,
    mail: { transport: config.transport, ready: config.transport !== 'disabled', reason: config.reason || null }
  };
}

async function retryOutboxForOwner({ ownerId, switchId, now = new Date() }) {
  return withTransaction(async (db) => {
    const email = await db.query(
      `UPDATE continuity_notification_outbox o
       SET status = 'pending', next_attempt_at = $3, failed_at = NULL, blocked_at = NULL,
           claimed_by = NULL, claim_expires_at = NULL, updated_at = $3
       FROM continuity_switches cs
       WHERE o.switch_id = cs.id AND cs.id = $1 AND cs.owner_id = $2
         AND o.status IN ('failed', 'blocked_configuration')
       RETURNING o.id`, [switchId, ownerId, now]
    );
    const brrrAttempts = await db.query(
      `UPDATE continuity_brrr_outbox o
       SET status = 'pending', next_attempt_at = $3, failed_at = NULL, blocked_at = NULL,
           claimed_by = NULL, claim_expires_at = NULL, updated_at = $3
       FROM continuity_switches cs
       WHERE o.switch_id = cs.id AND cs.id = $1 AND cs.owner_id = $2
         AND o.status IN ('failed', 'blocked_configuration')
       RETURNING o.id`, [switchId, ownerId, now]
    );
    const { rows: blockedRuns } = await db.query(
      `UPDATE continuity_delivery_runs run
       SET status = 'trustee_notification_pending', updated_at = $3
       FROM continuity_switches cs
       WHERE run.switch_id = cs.id AND cs.id = $1 AND cs.owner_id = $2
         AND run.status = 'trustee_notification_blocked'
       RETURNING run.id`, [switchId, ownerId, now]
    );
    if (blockedRuns.length) {
      await db.query(
        `UPDATE continuity_switches SET status = 'trustee_notification_pending', updated_at = $3
         WHERE id = $1 AND owner_id = $2 AND status = 'trustee_notification_blocked'`,
        [switchId, ownerId, now]
      );
    }
    return email.rows.length + brrrAttempts.rows.length;
  });
}

async function recoverOwner(input) {
  return continuityDelivery.recoverOwner({
    ...input,
    computeNextDue: (at, intervalDays) => addCalendarDays(at, intervalDays)
  });
}

module.exports = {
  INTERVALS,
  TOKEN_TTL_MS,
  addCalendarDays,
  advanceDueSwitches,
  checkIn,
  deriveTone,
  dispatchOutbox,
  commitStagedLetter,
  getOperationsStatus,
  getSwitchForOwner,
  getTokenSwitch,
  normalizeEmail,
  recordEvent,
  retryOutboxForOwner,
  recoverOwner,
  saveDraft,
  stageLetter,
  tokenHash,
  getTrusteeAction: continuityDelivery.getTrusteeAction,
  pauseWithTrusteeToken: continuityDelivery.pauseWithTrusteeToken,
  transitionOwnerAction,
  validateRecipients,
  validateLetterEnvelope,
  validateSchedule
};
