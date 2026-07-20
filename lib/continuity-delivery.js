'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { pool, withTransaction } = require('./db');
const { getMailerConfig } = require('./mailer');
const { buildAppUrl } = require('./app-url');
const { calculateSha256, getFilePath } = require('./files');

const TRUSTEE_ACTION_WINDOW_MS = 72 * 60 * 60 * 1000;
const TRUSTEE_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function asDate(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('date must be valid');
  return date;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function oneYearAfter(value) {
  const source = asDate(value);
  const result = new Date(source.getTime());
  const month = result.getUTCMonth();
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCFullYear(result.getUTCFullYear() + 1);
  result.setUTCMonth(month);
  const finalDay = new Date(Date.UTC(result.getUTCFullYear(), month + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, finalDay));
  return result;
}

function safeErrorClass(value) {
  const normalized = String(value || 'delivery_failed').toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_').slice(0, 80);
  return normalized || 'delivery_failed';
}

async function recordEvent(db, { switchId, type, cycle, details = {}, dedupeKey, occurredAt }) {
  const { rows } = await db.query(
    `INSERT INTO continuity_events
       (switch_id, event_type, schedule_cycle, details, dedupe_key, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
     RETURNING *`,
    [switchId, type, cycle, JSON.stringify(details), dedupeKey, occurredAt]
  );
  return rows[0];
}

async function initializePendingRuns(db, now = new Date()) {
  const at = asDate(now);
  const { rows: switches } = await db.query(
    `SELECT cs.*
     FROM continuity_switches cs
     WHERE cs.status = 'delivery_pending'
     ORDER BY cs.id
     FOR UPDATE OF cs SKIP LOCKED`
  );
  let created = 0;
  let transitioned = 0;
  for (const item of switches) {
    if (!item.active_packet_version_id) {
      await db.query(
        `UPDATE continuity_switches SET status = 'delivery_blocked', updated_at = $2
         WHERE id = $1`, [item.id, at]
      );
      transitioned += 1;
      continue;
    }
    const packet = await db.query(
      `SELECT id FROM continuity_packet_versions
       WHERE id = $1 AND switch_id = $2 AND status = 'active'`,
      [item.active_packet_version_id, item.id]
    );
    if (!packet.rows[0]) {
      await db.query(
        `UPDATE continuity_switches SET status = 'delivery_blocked', updated_at = $2
         WHERE id = $1`, [item.id, at]
      );
      transitioned += 1;
      continue;
    }
    const { rows: witnesses } = await db.query(
      `SELECT designation.trustee_id, trustee.status AS trustee_status,
              contact.id AS contact_channel_id, contact.normalized_address
       FROM continuity_switch_trustees designation
       JOIN vault_trustees trustee ON trustee.id = designation.trustee_id
       LEFT JOIN trustee_contact_channels contact
         ON contact.trustee_id = trustee.id AND contact.channel_type = 'email'
        AND contact.status = 'verified'
       WHERE designation.switch_id = $1
       ORDER BY designation.trustee_id`, [item.id]
    );
    const invalidWitness = witnesses.some((witness) =>
      witness.trustee_status !== 'registered' || !witness.contact_channel_id || !witness.normalized_address);
    const initialStatus = invalidWitness
      ? 'delivery_blocked'
      : witnesses.length ? 'trustee_notification_pending' : 'recipient_delivery';
    const { rows: inserted } = await db.query(
      `INSERT INTO continuity_delivery_runs
         (switch_id, schedule_cycle, packet_version_id, status, released_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4::text = 'recipient_delivery' THEN $5::timestamptz END, $5, $5)
       ON CONFLICT (switch_id, schedule_cycle) DO NOTHING
       RETURNING *`,
      [item.id, item.schedule_cycle, item.active_packet_version_id, initialStatus, at]
    );
    const run = inserted[0];
    if (!run) continue;
    created += 1;
    for (const witness of witnesses.filter((candidate) => candidate.contact_channel_id)) {
      const { rows: snapshots } = await db.query(
        `INSERT INTO continuity_delivery_run_trustees
           (delivery_run_id, trustee_id, contact_channel_id, destination_snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [run.id, witness.trustee_id, witness.contact_channel_id, witness.normalized_address, at]
      );
      if (initialStatus !== 'trustee_notification_pending') continue;
      const snapshot = snapshots[0];
      const messageId = `<continuity-trustee-${run.id}-${snapshot.id}-0@homesource.local>`;
      await db.query(
        `INSERT INTO continuity_notification_outbox
           (switch_id, schedule_cycle, notification_type, recipient_email, message_id,
            delivery_run_id, delivery_run_trustee_id, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, 'trustee_verification', $3, $4, $5, $6, $7, $7, $7)
         ON CONFLICT (delivery_run_id, delivery_run_trustee_id, notification_type)
           WHERE delivery_run_id IS NOT NULL
         DO NOTHING`,
        [item.id, item.schedule_cycle, snapshot.destination_snapshot, messageId,
          run.id, snapshot.id, at]
      );
    }
    await db.query(
      `UPDATE continuity_switches SET status = $2, updated_at = $3 WHERE id = $1`,
      [item.id, initialStatus, at]
    );
    await recordEvent(db, {
      switchId: item.id,
      type: initialStatus === 'recipient_delivery' ? 'delivery.released_without_trustees'
        : initialStatus === 'delivery_blocked' ? 'delivery.preflight_blocked' : 'delivery.trustees_queued',
      cycle: item.schedule_cycle,
      details: { delivery_run_id: run.id, packet_version_id: Number(run.packet_version_id), trustee_count: witnesses.length },
      dedupeKey: `switch:${item.id}:cycle:${item.schedule_cycle}:delivery-run`, occurredAt: at
    });
    transitioned += 1;
  }
  return { created, transitioned };
}

async function advanceRunDeadlines(db, now = new Date()) {
  const at = asDate(now);
  const { rows: runs } = await db.query(
    `SELECT run.* FROM continuity_delivery_runs run
     WHERE (run.status = 'trustee_window' AND run.trustee_action_deadline_at <= $1)
        OR (run.status = 'trustee_paused' AND run.pause_deadline_at <= $1)
     ORDER BY run.id FOR UPDATE OF run SKIP LOCKED`, [at]
  );
  for (const run of runs) {
    await db.query(
      `UPDATE continuity_delivery_runs
       SET status = 'recipient_delivery', released_at = $2, updated_at = $2 WHERE id = $1`,
      [run.id, at]
    );
    await db.query(
      `UPDATE continuity_switches SET status = 'recipient_delivery', updated_at = $2
       WHERE id = $1`, [run.switch_id, at]
    );
    await db.query(
      `UPDATE continuity_trustee_action_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_run_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
      [run.id, at]
    );
    await recordEvent(db, {
      switchId: run.switch_id, type: 'delivery.trustee_window_resolved', cycle: run.schedule_cycle,
      details: { delivery_run_id: run.id, resolution: run.status === 'trustee_paused' ? 'pause_expired' : 'window_expired' },
      dedupeKey: `delivery-run:${run.id}:recipient-delivery`, occurredAt: at
    });
  }
  return runs.length;
}

function matchingRecipientHolder(entry, recipient, evidence) {
  const holders = Array.isArray(entry?.holders) ? entry.holders : [];
  return holders.filter((holder) => {
    const identityMatches = recipient.member_id
      ? Number(holder.member_id) === Number(recipient.member_id) && !holder.trustee_id
      : Number(holder.trustee_id) === Number(recipient.trustee_id) && !holder.member_id;
    return identityMatches
      && holder.role === recipient.role
      && holder.sealed === true
      && holder.sealed_until === 'deadman_trigger'
      && Number(holder.encryption_key_id) === Number(evidence.encryption_key_id)
      && holder.key_fingerprint === evidence.key_fingerprint
      && holder.wrapped_dek?.kind === 'pki_x25519';
  });
}

async function recipientContactEvidence(db, recipient, ownerId) {
  if (recipient.member_id) {
    const { rows: members } = await db.query(
      'SELECT id, role FROM family_members WHERE id = $1 FOR SHARE', [recipient.member_id]
    );
    if (members[0]?.role !== 'kid') return { reason: 'recipient_ineligible' };
    const { rows: contacts } = await db.query(
      `SELECT id, normalized_address FROM member_contact_channels
       WHERE member_id = $1 AND channel_type = 'email' AND status = 'verified' FOR SHARE`,
      [recipient.member_id]
    );
    if (contacts.length !== 1) return { reason: 'contact_unavailable' };
    return { member_contact_channel_id: contacts[0].id, destination: contacts[0].normalized_address };
  }
  const { rows: trustees } = await db.query(
    `SELECT id, status, created_by FROM vault_trustees WHERE id = $1 FOR SHARE`, [recipient.trustee_id]
  );
  if (trustees[0]?.status !== 'registered' || Number(trustees[0]?.created_by) !== Number(ownerId)) {
    return { reason: 'recipient_ineligible' };
  }
  const { rows: contacts } = await db.query(
    `SELECT id, normalized_address FROM trustee_contact_channels
     WHERE trustee_id = $1 AND channel_type = 'email' AND status = 'verified' FOR SHARE`,
    [recipient.trustee_id]
  );
  if (contacts.length !== 1) return { reason: 'contact_unavailable' };
  return { trustee_contact_channel_id: contacts[0].id, destination: contacts[0].normalized_address };
}

async function preflightGrantItem(db, recipient, evidence) {
  const { rows: documents } = await db.query(
    'SELECT * FROM documents WHERE id = $1 FOR SHARE', [evidence.document_id]
  );
  const document = documents[0];
  if (!document || document.status !== 'active' || document.is_encrypted !== true
      || document.encryption_mode !== 'pki') {
    return { eligibility_status: 'blocked', reason: 'document_unavailable' };
  }
  const envelope = document.encryption_metadata;
  const entry = envelope?.files?.upload;
  if (Number(envelope?.version) !== 2 || envelope?.mode !== 'pki' || !entry
      || entry.cipher !== 'aes-256-gcm' || typeof entry.iv_b64 !== 'string'
      || !entry.iv_b64 || Number(entry.tag_length_bits || 128) !== 128) {
    return { eligibility_status: 'blocked', reason: 'envelope_invalid' };
  }
  const holders = matchingRecipientHolder(entry, recipient, evidence);
  if (holders.length !== 1) return { eligibility_status: 'blocked', reason: 'holder_mismatch' };

  const { rows: designations } = await db.query(
    'SELECT * FROM document_designations WHERE id = $1 FOR SHARE', [evidence.designation_id]
  );
  const designation = designations[0];
  const designationMatches = designation
    && Number(designation.document_id) === Number(document.id)
    && designation.role === recipient.role
    && designation.sealed === true
    && designation.sealed_until === 'deadman_trigger'
    && Number(designation.encryption_key_id) === Number(evidence.encryption_key_id)
    && (recipient.member_id
      ? Number(designation.member_id) === Number(recipient.member_id) && !designation.trustee_id
      : Number(designation.trustee_id) === Number(recipient.trustee_id) && !designation.member_id);
  if (!designationMatches) return { eligibility_status: 'blocked', reason: 'designation_mismatch' };

  const { rows: keys } = await db.query(
    'SELECT * FROM encryption_keys WHERE id = $1 FOR SHARE', [evidence.encryption_key_id]
  );
  const key = keys[0];
  const keyMatches = key && !key.revoked_at && key.key_fingerprint === evidence.key_fingerprint
    && (recipient.member_id
      ? key.key_type === 'member' && Number(key.member_id) === Number(recipient.member_id) && !key.trustee_id
      : key.key_type === 'trustee' && Number(key.trustee_id) === Number(recipient.trustee_id) && !key.member_id);
  if (!keyMatches) return { eligibility_status: 'blocked', reason: 'key_unavailable' };

  const { rows: files } = await db.query(
    `SELECT * FROM document_files WHERE document_id = $1 AND file_type = 'original'
     ORDER BY version DESC, id DESC FOR SHARE`, [document.id]
  );
  if (files.length !== 1 || !/^[a-f0-9]{64}$/.test(String(files[0].sha256 || ''))) {
    return { eligibility_status: 'blocked', reason: 'file_unavailable' };
  }
  let fileBytes;
  try {
    fileBytes = fs.readFileSync(getFilePath(files[0].stored_filename));
  } catch {
    return { eligibility_status: 'blocked', reason: 'file_unavailable' };
  }
  if (fileBytes.length !== Number(files[0].file_size_bytes)
      || calculateSha256(fileBytes) !== files[0].sha256) {
    return { eligibility_status: 'blocked', reason: 'file_integrity_mismatch' };
  }
  const artifactMetadata = {
    cipher: 'aes-256-gcm', iv_b64: entry.iv_b64, tag_length_bits: 128
  };
  if (entry.encrypted_file_meta) {
    const encryptedMetadata = entry.encrypted_file_meta;
    if (typeof encryptedMetadata.iv_b64 !== 'string' || !encryptedMetadata.iv_b64
        || typeof encryptedMetadata.payload_b64 !== 'string' || !encryptedMetadata.payload_b64) {
      return { eligibility_status: 'blocked', reason: 'envelope_invalid' };
    }
    artifactMetadata.encrypted_file_meta = {
      iv_b64: encryptedMetadata.iv_b64, payload_b64: encryptedMetadata.payload_b64
    };
  }
  return {
    eligibility_status: 'ready',
    document_file_id: Number(files[0].id),
    designation_id: Number(designation.id),
    encryption_key_id: Number(key.id),
    key_fingerprint: key.key_fingerprint,
    envelope_file_key: 'upload',
    artifact_metadata: artifactMetadata,
    wrapped_dek: structuredClone(holders[0].wrapped_dek),
    file_sha256: files[0].sha256
  };
}

async function blockUntrustedRun(db, run, now, reason) {
  await db.query(
    `UPDATE continuity_delivery_runs SET status = 'delivery_blocked', updated_at = $2
     WHERE id = $1 AND status = 'recipient_delivery'`, [run.id, now]
  );
  await db.query(
    `UPDATE continuity_switches SET status = 'delivery_blocked', updated_at = $2
     WHERE id = $1 AND status = 'recipient_delivery'`, [run.switch_id, now]
  );
  await recordEvent(db, {
    switchId: run.switch_id, type: 'delivery.grant_preflight_blocked', cycle: run.schedule_cycle,
    details: { delivery_run_id: Number(run.id), reason_class: reason },
    dedupeKey: `delivery-run:${run.id}:grant-preflight-blocked`, occurredAt: now
  });
}

async function activateRecipientGrants(db, now = new Date()) {
  const at = asDate(now);
  const { rows: runs } = await db.query(
    `SELECT run.*, cs.owner_id, cs.active_packet_version_id,
            packet.status AS packet_status
     FROM continuity_delivery_runs run
     JOIN continuity_switches cs ON cs.id = run.switch_id
     LEFT JOIN continuity_packet_versions packet ON packet.id = run.packet_version_id
     WHERE run.status = 'recipient_delivery' AND cs.status = 'recipient_delivery'
     ORDER BY run.id FOR UPDATE OF run, cs SKIP LOCKED`
  );
  let grantsCreated = 0;
  let activeGrants = 0;
  let blockedGrants = 0;
  let runsProcessed = 0;
  for (const run of runs) {
    let runActiveGrants = 0;
    let runBlockedGrants = 0;
    const existing = await db.query(
      'SELECT COUNT(*)::int AS count FROM continuity_delivery_grants WHERE delivery_run_id = $1', [run.id]
    );
    if (existing.rows[0].count > 0) continue;
    runsProcessed += 1;
    if (run.packet_status !== 'active'
        || Number(run.active_packet_version_id) !== Number(run.packet_version_id)) {
      await blockUntrustedRun(db, run, at, 'packet_policy_invalid');
      continue;
    }
    const { rows: recipients } = await db.query(
      `SELECT * FROM continuity_packet_recipients
       WHERE packet_version_id = $1 ORDER BY packet_order`, [run.packet_version_id]
    );
    if (!recipients.length) {
      await blockUntrustedRun(db, run, at, 'packet_policy_invalid');
      continue;
    }
    for (const recipient of recipients) {
      const contact = await recipientContactEvidence(db, recipient, run.owner_id);
      const { rows: coverage } = await db.query(
        `SELECT evidence.*, packet_document.document_id, packet_document.item_kind,
                packet_document.packet_order
         FROM continuity_packet_recipient_documents evidence
         JOIN continuity_packet_documents packet_document
           ON packet_document.id = evidence.packet_document_id
          AND packet_document.packet_version_id = evidence.packet_version_id
         WHERE evidence.packet_recipient_id = $1 AND evidence.coverage_status = 'covered'
         ORDER BY packet_document.packet_order`, [recipient.id]
      );
      const items = [];
      for (const evidence of coverage) {
        items.push({ evidence, result: await preflightGrantItem(db, recipient, evidence) });
      }
      const hasLetter = coverage.some((item) => item.item_kind === 'letter');
      const firstBlockedItem = items.find((item) => item.result.eligibility_status === 'blocked');
      const blockedReason = contact.reason || (!hasLetter ? 'packet_policy_invalid' : firstBlockedItem?.result.reason);
      const active = !blockedReason;
      const grantExpiry = active ? oneYearAfter(at) : null;
      const { rows: grants } = await db.query(
        `INSERT INTO continuity_delivery_grants
           (delivery_run_id, packet_version_id, packet_recipient_id, member_id, trustee_id,
            role, member_contact_channel_id, trustee_contact_channel_id, destination_snapshot,
            status, blocked_reason_class, activated_at, expires_at, blocked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
         RETURNING *`,
        [run.id, run.packet_version_id, recipient.id, recipient.member_id, recipient.trustee_id,
          recipient.role, contact.member_contact_channel_id || null,
          contact.trustee_contact_channel_id || null, contact.destination || null,
          active ? 'active' : 'blocked', blockedReason || null, active ? at : null,
          grantExpiry, active ? null : at, at]
      );
      const grant = grants[0];
      grantsCreated += 1;
      if (active) {
        activeGrants += 1;
        runActiveGrants += 1;
      } else {
        blockedGrants += 1;
        runBlockedGrants += 1;
      }
      for (let index = 0; index < items.length; index += 1) {
        const { evidence, result } = items[index];
        await db.query(
          `INSERT INTO continuity_delivery_items
             (delivery_grant_id, packet_version_id, packet_document_id, item_ordinal,
              item_kind, eligibility_status, blocked_reason_class, document_file_id,
              designation_id, encryption_key_id, key_fingerprint, envelope_file_key,
              artifact_metadata, wrapped_dek, file_sha256, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [grant.id, run.packet_version_id, evidence.packet_document_id, index + 1,
            evidence.item_kind, result.eligibility_status, result.reason || null,
            result.document_file_id || null, result.designation_id || null,
            result.encryption_key_id || null, result.key_fingerprint || null,
            result.envelope_file_key || null,
            result.artifact_metadata ? JSON.stringify(result.artifact_metadata) : null,
            result.wrapped_dek ? JSON.stringify(result.wrapped_dek) : null,
            result.file_sha256 || null, at]
        );
      }
      if (!active) continue;
      const initialToken = crypto.randomBytes(32).toString('base64url');
      const tokenExpiry = new Date(Math.min(grantExpiry.getTime(), at.getTime() + TOKEN_STAGING_TTL_MS));
      const { rows: tokenRows } = await db.query(
        `INSERT INTO continuity_delivery_tokens
           (delivery_grant_id, purpose, token_hash, expires_at, created_at)
         VALUES ($1, 'access', $2, $3, $4) RETURNING id`,
        [grant.id, tokenHash(initialToken), tokenExpiry, at]
      );
      await db.query(
        `INSERT INTO continuity_notification_outbox
           (switch_id, schedule_cycle, notification_type, recipient_email, message_id,
            delivery_run_id, delivery_grant_id, delivery_token_id,
            next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, 'recipient_delivery', $3, $4, $5, $6, $7, $8, $8, $8)`,
        [run.switch_id, run.schedule_cycle, contact.destination,
          `<continuity-recipient-${grant.id}-0@homesource.local>`, run.id, grant.id,
          tokenRows[0].id, at]
      );
    }
    if (runActiveGrants > 0) {
      await db.query(
        `UPDATE continuity_delivery_runs
         SET status = 'delivery_active', first_grant_activated_at = COALESCE(first_grant_activated_at, $2),
             updated_at = $2 WHERE id = $1`, [run.id, at]
      );
      await db.query(
        `UPDATE continuity_switches SET status = 'delivery_active', updated_at = $2 WHERE id = $1`,
        [run.switch_id, at]
      );
    }
    await recordEvent(db, {
      switchId: run.switch_id,
      type: runActiveGrants > 0 ? 'delivery.recipient_grants_activated' : 'delivery.recipient_grants_blocked',
      cycle: run.schedule_cycle,
      details: {
        delivery_run_id: Number(run.id), active_grant_count: runActiveGrants,
        blocked_grant_count: runBlockedGrants
      },
      dedupeKey: `delivery-run:${run.id}:recipient-grants`, occurredAt: at
    });
  }
  return {
    runs_processed: runsProcessed, grants_created: grantsCreated,
    active_grants: activeGrants, blocked_grants: blockedGrants
  };
}

function trusteeActionUrl(token, env = process.env) {
  return buildAppUrl('trustee-action.html', { env, token });
}

function trusteeNotificationMessage(item, token, messageId, env = process.env) {
  return {
    to: item.recipient_email,
    messageId,
    subject: 'A Home Source continuity check needs your attention',
    text: `You are a designated continuity witness. You may use this private link to place one 30-day pause after the shared witness window begins:\n\n${trusteeActionUrl(token, env)}\n\nThis link grants pause authority only. It does not grant access to any letter, document, file, envelope, key, recipient list, or Home Source account.`
  };
}

async function blockRunForNotification(db, runId, switchId, cycle, now, errorClass) {
  await db.query(
    `UPDATE continuity_delivery_runs
     SET status = 'trustee_notification_blocked', updated_at = $2
     WHERE id = $1 AND status IN ('trustee_notification_pending', 'trustee_notification_blocked')`,
    [runId, now]
  );
  await db.query(
    `UPDATE continuity_switches SET status = 'trustee_notification_blocked', updated_at = $2
     WHERE id = $1 AND status IN ('trustee_notification_pending', 'trustee_notification_blocked')`,
    [switchId, now]
  );
  await recordEvent(db, {
    switchId, type: 'delivery.trustee_notification_blocked',
    cycle,
    details: { delivery_run_id: runId, error_class: safeErrorClass(errorClass) },
    dedupeKey: `delivery-run:${runId}:trustee-notification-blocked`, occurredAt: now
  });
}

async function claimTrusteeOutboxAttempt({ now = new Date(), workerId, env = process.env }) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT outbox.*, run.status AS run_status, switch.status AS switch_status
       FROM continuity_notification_outbox outbox
       JOIN continuity_delivery_runs run ON run.id = outbox.delivery_run_id
       JOIN continuity_switches switch ON switch.id = outbox.switch_id
       WHERE outbox.notification_type = 'trustee_verification'
         AND ((outbox.status = 'pending' AND outbox.next_attempt_at <= $1)
           OR (outbox.status = 'claimed' AND outbox.claim_expires_at <= $1))
       ORDER BY outbox.next_attempt_at, outbox.id
       LIMIT 1 FOR UPDATE OF outbox, run SKIP LOCKED`, [at]
    );
    const item = rows[0];
    if (!item) return null;
    if (!['trustee_notification_pending', 'trustee_notification_blocked'].includes(item.run_status)
        || !['trustee_notification_pending', 'trustee_notification_blocked'].includes(item.switch_status)) {
      await db.query(
        `UPDATE continuity_notification_outbox
         SET status = 'superseded', superseded_at = $2, claimed_by = NULL,
             claim_expires_at = NULL, last_error_class = 'delivery_run_state_changed', updated_at = $2
         WHERE id = $1`, [item.id, at]
      );
      return { blocked: true, status: 'superseded' };
    }
    const config = getMailerConfig(env);
    if (config.transport === 'disabled') {
      await db.query(
        `UPDATE continuity_notification_outbox SET status = 'blocked_configuration', blocked_at = $2,
                claimed_by = NULL, claim_expires_at = NULL,
                last_error_class = 'mail_transport_disabled', updated_at = $2 WHERE id = $1`,
        [item.id, at]
      );
      await blockRunForNotification(
        db, item.delivery_run_id, item.switch_id, item.schedule_cycle, at, 'mail_transport_disabled'
      );
      return { blocked: true, status: 'blocked_configuration' };
    }
    await db.query(
      `UPDATE continuity_trustee_action_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_run_trustee_id = $1 AND purpose = 'pause'
         AND consumed_at IS NULL AND replaced_at IS NULL`,
      [item.delivery_run_trustee_id, at]
    );
    const token = crypto.randomBytes(32).toString('base64url');
    const { rows: tokens } = await db.query(
      `INSERT INTO continuity_trustee_action_tokens
         (delivery_run_id, delivery_run_trustee_id, purpose, token_hash, expires_at, created_at)
       VALUES ($1, $2, 'pause', $3, $4, $5) RETURNING *`,
      [item.delivery_run_id, item.delivery_run_trustee_id, tokenHash(token),
        new Date(at.getTime() + TOKEN_STAGING_TTL_MS), at]
    );
    const attempt = Number(item.attempt_count) + 1;
    const messageId = `<continuity-trustee-${item.delivery_run_id}-${item.delivery_run_trustee_id}-${attempt}@homesource.local>`;
    const { rows: updated } = await db.query(
      `UPDATE continuity_notification_outbox
       SET status = 'claimed', attempt_count = $2, message_id = $3, trustee_action_token_id = $4,
           claimed_by = $5, claim_expires_at = $6, updated_at = $7
       WHERE id = $1 RETURNING *`,
      [item.id, attempt, messageId, tokens[0].id, workerId,
        new Date(at.getTime() + 15 * 60_000), at]
    );
    return { item: updated[0], token, messageId };
  });
}

async function completeTrusteeOutboxAttempt({ item, workerId, now = new Date(), result, maxAttempts, retryDelaysMs }) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows: lockedRows } = await db.query(
      `SELECT outbox.*, run.status AS run_status
       FROM continuity_notification_outbox outbox
       JOIN continuity_delivery_runs run ON run.id = outbox.delivery_run_id
       WHERE outbox.id = $1 FOR UPDATE OF outbox, run`, [item.id]
    );
    const locked = lockedRows[0];
    if (!locked || locked.status !== 'claimed' || locked.claimed_by !== workerId) return { ignored: true };
    if (result.delivered) {
      await db.query(
        `UPDATE continuity_notification_outbox SET status = 'sent', sent_at = $2,
                claimed_by = NULL, claim_expires_at = NULL, last_error_class = NULL, updated_at = $2
         WHERE id = $1`, [locked.id, at]
      );
      await db.query(
        `UPDATE continuity_delivery_run_trustees
         SET first_successful_send_at = COALESCE(first_successful_send_at, $2)
         WHERE id = $1`, [locked.delivery_run_trustee_id, at]
      );
      const { rows: completion } = await db.query(
        `SELECT COUNT(*) FILTER (WHERE first_successful_send_at IS NULL)::int AS incomplete,
                MAX(first_successful_send_at) AS final_success_at
         FROM continuity_delivery_run_trustees WHERE delivery_run_id = $1`,
        [locked.delivery_run_id]
      );
      if (completion[0].incomplete === 0
          && ['trustee_notification_pending', 'trustee_notification_blocked'].includes(locked.run_status)) {
        const startedAt = asDate(completion[0].final_success_at);
        const deadline = new Date(startedAt.getTime() + TRUSTEE_ACTION_WINDOW_MS);
        await db.query(
          `UPDATE continuity_delivery_runs
           SET status = 'trustee_window', trustee_window_started_at = $2,
               trustee_action_deadline_at = $3, updated_at = $2 WHERE id = $1`,
          [locked.delivery_run_id, startedAt, deadline]
        );
        await db.query(
          `UPDATE continuity_switches SET status = 'trustee_window', updated_at = $2
           WHERE id = $1`, [locked.switch_id, startedAt]
        );
        await db.query(
          `UPDATE continuity_trustee_action_tokens SET expires_at = $2
           WHERE delivery_run_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
          [locked.delivery_run_id, deadline]
        );
        await recordEvent(db, {
          switchId: locked.switch_id, type: 'delivery.trustee_window_started', cycle: locked.schedule_cycle,
          details: { delivery_run_id: Number(locked.delivery_run_id), action_deadline_at: deadline },
          dedupeKey: `delivery-run:${locked.delivery_run_id}:trustee-window`, occurredAt: startedAt
        });
        return { sent: true, windowStarted: true, deadline };
      }
      return { sent: true, windowStarted: false };
    }
    const permanent = result.retryable === false || Number(locked.attempt_count) >= maxAttempts;
    const delay = retryDelaysMs[Math.min(Number(locked.attempt_count) - 1, retryDelaysMs.length - 1)];
    const errorClass = safeErrorClass(result.error_class || result.reason);
    await db.query(
      `UPDATE continuity_notification_outbox
       SET status = $2, failed_at = CASE WHEN $2::text = 'failed' THEN $3::timestamptz END,
           next_attempt_at = $4, claimed_by = NULL, claim_expires_at = NULL,
           last_error_class = $5, updated_at = $3 WHERE id = $1`,
      [locked.id, permanent ? 'failed' : 'pending', at, new Date(at.getTime() + delay), errorClass]
    );
    if (permanent) {
      await blockRunForNotification(
        db, locked.delivery_run_id, locked.switch_id, locked.schedule_cycle, at, errorClass
      );
    }
    return { sent: false, permanent };
  });
}

async function getTrusteeAction(rawToken, now = new Date(), db = pool) {
  if (!rawToken) return null;
  const at = asDate(now);
  const { rows } = await db.query(
    `SELECT token.id AS token_id, token.expires_at, token.consumed_at, token.replaced_at,
            run.id AS delivery_run_id, run.status, run.trustee_action_deadline_at,
            run.pause_deadline_at
     FROM continuity_trustee_action_tokens token
     JOIN continuity_delivery_runs run ON run.id = token.delivery_run_id
     WHERE token.token_hash = $1 AND token.purpose = 'pause'`, [tokenHash(rawToken)]
  );
  const match = rows[0];
  if (!match) return null;
  if (match.status === 'trustee_paused' && match.pause_deadline_at) {
    return { status: 'paused', pause_deadline_at: match.pause_deadline_at };
  }
  if (match.status !== 'trustee_window' || match.consumed_at || match.replaced_at
      || asDate(match.expires_at) <= at || asDate(match.trustee_action_deadline_at) <= at) return null;
  return { status: 'available', action_deadline_at: match.trustee_action_deadline_at };
}

async function pauseWithTrusteeToken({ rawToken, now = new Date() }) {
  const at = asDate(now);
  if (!rawToken) return null;
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT token.id AS token_id, token.expires_at, token.consumed_at, token.replaced_at,
              run.*, snapshot.trustee_id
       FROM continuity_trustee_action_tokens token
       JOIN continuity_delivery_runs run ON run.id = token.delivery_run_id
       JOIN continuity_delivery_run_trustees snapshot ON snapshot.id = token.delivery_run_trustee_id
       WHERE token.token_hash = $1 AND token.purpose = 'pause'
       FOR UPDATE OF token, run`, [tokenHash(rawToken)]
    );
    const match = rows[0];
    if (!match) return null;
    if (match.status === 'trustee_paused' && match.pause_deadline_at) {
      return { status: 'paused', pause_deadline_at: match.pause_deadline_at, replayed: true };
    }
    if (match.status !== 'trustee_window' || match.consumed_at || match.replaced_at
        || asDate(match.expires_at) <= at || asDate(match.trustee_action_deadline_at) <= at) return null;
    const deadline = new Date(at.getTime() + TRUSTEE_PAUSE_MS);
    await db.query('UPDATE continuity_trustee_action_tokens SET consumed_at = $2 WHERE id = $1', [match.token_id, at]);
    await db.query(
      `UPDATE continuity_trustee_action_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_run_id = $1 AND id <> $3 AND consumed_at IS NULL AND replaced_at IS NULL`,
      [match.id, at, match.token_id]
    );
    await db.query(
      `UPDATE continuity_delivery_runs
       SET status = 'trustee_paused', paused_at = $2, pause_deadline_at = $3, updated_at = $2
       WHERE id = $1`, [match.id, at, deadline]
    );
    await db.query(
      `UPDATE continuity_switches SET status = 'trustee_paused', updated_at = $2
       WHERE id = $1`, [match.switch_id, at]
    );
    await recordEvent(db, {
      switchId: match.switch_id, type: 'delivery.trustee_paused', cycle: match.schedule_cycle,
      details: { delivery_run_id: match.id, trustee_id: match.trustee_id, pause_deadline_at: deadline },
      dedupeKey: `delivery-run:${match.id}:trustee-pause`, occurredAt: at
    });
    return { status: 'paused', pause_deadline_at: deadline, replayed: false };
  });
}

async function recoverOwner({ ownerId, switchId, now = new Date(), operationKey, computeNextDue = null }) {
  const at = asDate(now);
  const op = String(operationKey || crypto.randomUUID()).slice(0, 120);
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM continuity_switches WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [Number(switchId), Number(ownerId)]
    );
    const item = rows[0];
    if (!item) throw new Error('Continuity switch not found');
    const dedupeKey = `switch:${item.id}:recover:${op}`;
    const replay = await db.query('SELECT id FROM continuity_events WHERE dedupe_key = $1', [dedupeKey]);
    if (replay.rows[0]) return item;
    const allowed = ['delivery_pending', 'delivery_blocked', 'trustee_notification_pending',
      'trustee_notification_blocked', 'trustee_window', 'trustee_paused', 'recipient_delivery',
      'delivery_active'];
    if (!allowed.includes(item.status)) throw new Error(`Cannot recover a switch in ${item.status} state`);
    const { rows: runs } = await db.query(
      `SELECT * FROM continuity_delivery_runs
       WHERE switch_id = $1 AND schedule_cycle = $2 FOR UPDATE`, [item.id, item.schedule_cycle]
    );
    const run = runs[0];
    if (run?.first_grant_activated_at || item.status === 'delivery_active') {
      throw new Error('Owner recovery is unavailable after recipient delivery activation');
    }
    if (run) {
      await db.query(
        `UPDATE continuity_delivery_runs
         SET status = 'owner_recovered', recovered_at = $2, updated_at = $2 WHERE id = $1`,
        [run.id, at]
      );
      await db.query(
        `UPDATE continuity_trustee_action_tokens
         SET replaced_at = COALESCE(replaced_at, $2)
         WHERE delivery_run_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
        [run.id, at]
      );
    }
    await db.query(
      `UPDATE continuity_notification_outbox
       SET status = 'superseded', superseded_at = $2, claimed_by = NULL,
           claim_expires_at = NULL, updated_at = $2
       WHERE switch_id = $1 AND status IN ('pending', 'claimed', 'blocked_configuration', 'failed')`,
      [item.id, at]
    );
    await db.query(
      `UPDATE continuity_brrr_outbox
       SET status = 'superseded', superseded_at = $2, claimed_by = NULL,
           claim_expires_at = NULL, updated_at = $2
       WHERE switch_id = $1 AND status IN ('pending', 'claimed', 'blocked_configuration', 'failed')`,
      [item.id, at]
    );
    const cycle = Number(item.schedule_cycle) + 1;
    const nextDue = computeNextDue
      ? asDate(computeNextDue(at, item.interval_days))
      : new Date(at.getTime() + Number(item.interval_days) * 24 * 60 * 60 * 1000);
    const { rows: updated } = await db.query(
      `UPDATE continuity_switches
       SET status = 'armed', schedule_cycle = $2, last_checkin_at = $3,
           next_checkin_due_at = $4, delivery_pending_at = NULL, updated_at = $3
       WHERE id = $1 RETURNING *`, [item.id, cycle, at, nextDue]
    );
    await recordEvent(db, {
      switchId: item.id, type: 'switch.owner_recovered', cycle,
      details: { prior_delivery_run_id: run?.id || null, next_checkin_due_at: nextDue },
      dedupeKey, occurredAt: at
    });
    return updated[0];
  });
}

async function getRunForOwner({ ownerId, switchId }, db = pool) {
  const { rows } = await db.query(
    `SELECT run.*,
            (SELECT COUNT(*)::int FROM continuity_delivery_run_trustees snapshot
             WHERE snapshot.delivery_run_id = run.id) AS trustee_count,
            (SELECT COUNT(*)::int FROM continuity_delivery_run_trustees snapshot
             WHERE snapshot.delivery_run_id = run.id AND snapshot.first_successful_send_at IS NOT NULL) AS trustees_notified,
            (SELECT COUNT(*)::int FROM continuity_delivery_grants grant_row
             WHERE grant_row.delivery_run_id = run.id) AS grant_count,
            (SELECT COUNT(*)::int FROM continuity_delivery_grants grant_row
             WHERE grant_row.delivery_run_id = run.id AND grant_row.status = 'active') AS active_grant_count,
            (SELECT COUNT(*)::int FROM continuity_delivery_grants grant_row
             WHERE grant_row.delivery_run_id = run.id AND grant_row.status = 'blocked') AS blocked_grant_count
     FROM continuity_delivery_runs run
     JOIN continuity_switches switch ON switch.id = run.switch_id
     WHERE run.switch_id = $1 AND switch.owner_id = $2
     ORDER BY run.id DESC LIMIT 1`,
    [Number(switchId), Number(ownerId)]
  );
  const run = rows[0];
  if (!run) return null;
  run.grants = (await db.query(
    `SELECT grant_row.id, grant_row.member_id, grant_row.trustee_id, grant_row.role,
            grant_row.destination_snapshot, grant_row.status, grant_row.blocked_reason_class,
            grant_row.activated_at, grant_row.expires_at,
            COUNT(item.id)::int AS item_count,
            COUNT(item.id) FILTER (WHERE item.eligibility_status = 'blocked')::int AS blocked_item_count
     FROM continuity_delivery_grants grant_row
     LEFT JOIN continuity_delivery_items item ON item.delivery_grant_id = grant_row.id
     WHERE grant_row.delivery_run_id = $1
     GROUP BY grant_row.id ORDER BY grant_row.packet_recipient_id`, [run.id]
  )).rows;
  return run;
}

module.exports = {
  TOKEN_STAGING_TTL_MS,
  TRUSTEE_ACTION_WINDOW_MS,
  TRUSTEE_PAUSE_MS,
  advanceRunDeadlines,
  activateRecipientGrants,
  claimTrusteeOutboxAttempt,
  completeTrusteeOutboxAttempt,
  getRunForOwner,
  getTrusteeAction,
  initializePendingRuns,
  pauseWithTrusteeToken,
  recoverOwner,
  safeErrorClass,
  tokenHash,
  trusteeActionUrl,
  trusteeNotificationMessage
};
