'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { pool, withTransaction } = require('./db');
const { getMailerConfig } = require('./mailer');
const { getFilePath } = require('./files');
const { tokenHash } = require('./continuity-delivery');

const RECIPIENT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECIPIENT_SESSION_TTL_MS = 60 * 60 * 1000;
const CLAIM_TTL_MS = 15 * 60 * 1000;

function asDate(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('date must be valid');
  return date;
}

function genericUnavailable() {
  const error = new Error('This private delivery is unavailable');
  error.code = 'RECIPIENT_UNAVAILABLE';
  return error;
}

function deliveryUrl(token, env = process.env) {
  const { buildAppUrl } = require('./app-url');
  return buildAppUrl('recipient-delivery.html', { env, token });
}

function recipientDeliveryMessage(item, token, messageId, env = process.env) {
  const replacement = Number(item.attempt_count || 0) > 1;
  return {
    to: item.recipient_email,
    messageId,
    subject: replacement ? 'Your replacement private Home Source link is ready' : 'Your private Home Source delivery is ready',
    text: `${replacement ? 'A replacement' : 'A'} private Home Source delivery link is ready. This link is personal and expires in seven days:\n\n${deliveryUrl(token, env)}\n\nThis link opens only the private items prepared for you. It does not open a Home Source account or the family vault.`
  };
}

async function claimRecipientOutboxAttempt({ now = new Date(), workerId, env = process.env, dbPool = pool }) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT outbox.*, grant_row.status AS grant_status, grant_row.expires_at AS grant_expires_at,
              run.status AS run_status, switch.status AS switch_status
       FROM continuity_notification_outbox outbox
       JOIN continuity_delivery_grants grant_row ON grant_row.id = outbox.delivery_grant_id
       JOIN continuity_delivery_runs run ON run.id = outbox.delivery_run_id
       JOIN continuity_switches switch ON switch.id = outbox.switch_id
       WHERE outbox.notification_type = 'recipient_delivery'
         AND (outbox.status = 'deferred'
           OR (outbox.status = 'pending' AND outbox.next_attempt_at <= $1)
           OR (outbox.status = 'claimed' AND outbox.claim_expires_at <= $1))
       ORDER BY outbox.next_attempt_at, outbox.id
       LIMIT 1 FOR UPDATE OF outbox, grant_row, run, switch SKIP LOCKED`, [at]
    );
    const item = rows[0];
    if (!item) return null;
    const valid = item.grant_status === 'active' && asDate(item.grant_expires_at) > at
      && ['delivery_active', 'delivery_complete'].includes(item.run_status)
      && ['delivery_active', 'delivery_complete'].includes(item.switch_status);
    if (getMailerConfig(env).transport === 'disabled') {
      await db.query(
        `UPDATE continuity_notification_outbox SET status = 'blocked_configuration', blocked_at = $2,
                claimed_by = NULL, claim_expires_at = NULL, last_error_class = 'mail_transport_disabled', updated_at = $2
         WHERE id = $1`, [item.id, at]
      );
      return { blocked: true, status: 'blocked_configuration' };
    }
    if (!valid) {
      await db.query(
        `UPDATE continuity_notification_outbox
         SET status = 'superseded', superseded_at = $2, claimed_by = NULL, claim_expires_at = NULL,
             last_error_class = 'delivery_state_changed', updated_at = $2 WHERE id = $1`, [item.id, at]
      );
      return { blocked: true, status: 'superseded' };
    }
    await db.query(
      `UPDATE continuity_delivery_tokens SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_grant_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`, [item.delivery_grant_id, at]
    );
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(asDate(item.grant_expires_at).getTime(), at.getTime() + RECIPIENT_LINK_TTL_MS));
    const { rows: tokens } = await db.query(
      `INSERT INTO continuity_delivery_tokens (delivery_grant_id, purpose, token_hash, expires_at, created_at)
       VALUES ($1, 'access', $2, $3, $4) RETURNING id`,
      [item.delivery_grant_id, tokenHash(rawToken), expiresAt, at]
    );
    const messageId = `<continuity-recipient-${item.delivery_grant_id}-${Number(item.attempt_count) + 1}@homesource.local>`;
    const { rows: updated } = await db.query(
      `UPDATE continuity_notification_outbox
       SET status = 'claimed', delivery_token_id = $2, message_id = $3, attempt_count = attempt_count + 1,
           claimed_by = $4, claim_expires_at = $5, last_error_class = NULL, updated_at = $6
       WHERE id = $1 RETURNING *`,
      [item.id, tokens[0].id, messageId, workerId, new Date(at.getTime() + CLAIM_TTL_MS), at]
    );
    return { item: updated[0], token: rawToken, messageId };
  });
}

async function completeRecipientOutboxAttempt({ item, workerId, result, now = new Date(), maxAttempts, retryDelaysMs, dbPool = pool }) {
  const at = asDate(now);
  if (result.delivered) {
    const { rowCount } = await dbPool.query(
      `UPDATE continuity_notification_outbox SET status = 'sent', sent_at = $2, claimed_by = NULL,
              claim_expires_at = NULL, last_error_class = NULL, updated_at = $2
       WHERE id = $1 AND claimed_by = $3`, [item.id, at, workerId]
    );
    return { sent: rowCount === 1, ignored: rowCount !== 1 };
  }
  const permanent = result.retryable === false || Number(item.attempt_count) >= Number(maxAttempts);
  const delay = retryDelaysMs[Math.min(Number(item.attempt_count) - 1, retryDelaysMs.length - 1)];
  const { rowCount } = await dbPool.query(
    `UPDATE continuity_notification_outbox
     SET status = $2, failed_at = CASE WHEN $2::text = 'failed' THEN $3::timestamptz ELSE NULL::timestamptz END,
         next_attempt_at = $4, claimed_by = NULL, claim_expires_at = NULL, last_error_class = $5, updated_at = $3
     WHERE id = $1 AND claimed_by = $6`,
    [item.id, permanent ? 'failed' : 'pending', at, new Date(at.getTime() + delay),
      String(result.error_class || result.reason || 'delivery_failed').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80), workerId]
  );
  return { sent: false, ignored: rowCount !== 1 };
}

async function recordRecipientEvent(db, { switchId, cycle, type, details, dedupeKey, occurredAt }) {
  await db.query(
    `INSERT INTO continuity_events (switch_id, event_type, schedule_cycle, details, dedupe_key, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [switchId, type, cycle, JSON.stringify(details), dedupeKey, occurredAt]
  );
}

async function requestRecipientReissue(rawToken, { now = new Date() } = {}) {
  const at = asDate(now);
  if (!rawToken || typeof rawToken !== 'string') return { queued: false };
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT grant_row.id AS delivery_grant_id, grant_row.expires_at, run.id AS delivery_run_id,
              run.schedule_cycle, switch.id AS switch_id, run.status AS run_status, switch.status AS switch_status
       FROM continuity_delivery_tokens token
       JOIN continuity_delivery_grants grant_row ON grant_row.id = token.delivery_grant_id
       JOIN continuity_delivery_runs run ON run.id = grant_row.delivery_run_id
       JOIN continuity_switches switch ON switch.id = run.switch_id
       WHERE token.token_hash = $1 AND token.purpose = 'access'
         AND grant_row.status = 'active' AND grant_row.expires_at > $2
         AND run.status IN ('delivery_active', 'delivery_complete')
         AND switch.status IN ('delivery_active', 'delivery_complete')
       FOR UPDATE OF grant_row, token`, [tokenHash(rawToken), at]
    );
    const match = rows[0];
    if (!match) return { queued: false };
    const { rowCount } = await db.query(
      `UPDATE continuity_notification_outbox
       SET status = 'pending', delivery_token_id = NULL, next_attempt_at = $2,
           claimed_by = NULL, claim_expires_at = NULL, sent_at = NULL, failed_at = NULL,
           blocked_at = NULL, superseded_at = NULL, last_error_class = NULL, updated_at = $2
       WHERE delivery_grant_id = $1 AND notification_type = 'recipient_delivery'
         AND status <> 'superseded'`, [match.delivery_grant_id, at]
    );
    // The transaction must roll back rather than leave a recipient with invalidated links
    // and no queued replacement if a future state change breaks this invariant.
    if (rowCount !== 1) throw genericUnavailable();
    await db.query(
      `UPDATE continuity_delivery_tokens SET replaced_at = COALESCE(replaced_at, $2)
       WHERE delivery_grant_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
      [match.delivery_grant_id, at]
    );
    await db.query(
      `UPDATE continuity_delivery_sessions SET revoked_at = COALESCE(revoked_at, $2)
       WHERE delivery_grant_id = $1 AND revoked_at IS NULL`, [match.delivery_grant_id, at]
    );
    await recordRecipientEvent(db, {
      switchId: match.switch_id, cycle: match.schedule_cycle, type: 'delivery.recipient_reissue_queued',
      details: { delivery_grant_id: Number(match.delivery_grant_id) },
      dedupeKey: `delivery-grant:${match.delivery_grant_id}:reissue:${crypto.randomUUID()}`, occurredAt: at
    });
    return { queued: true };
  });
}

async function expireRecipientGrants({ now = new Date() } = {}) {
  const at = asDate(now);
  return withTransaction(async (db) => {
    const { rows: grants } = await db.query(
      `SELECT grant_row.id, grant_row.delivery_run_id, run.switch_id, run.schedule_cycle
       FROM continuity_delivery_grants grant_row
       JOIN continuity_delivery_runs run ON run.id = grant_row.delivery_run_id
       WHERE grant_row.status = 'active' AND grant_row.expires_at <= $1
       ORDER BY grant_row.id FOR UPDATE OF grant_row, run SKIP LOCKED`, [at]
    );
    const runIds = new Set();
    for (const grant of grants) {
      await db.query(
        `UPDATE continuity_delivery_grants SET status = 'expired', expired_at = $2, updated_at = $2
         WHERE id = $1 AND status = 'active'`, [grant.id, at]
      );
      await db.query(
        `UPDATE continuity_delivery_tokens SET replaced_at = COALESCE(replaced_at, $2)
         WHERE delivery_grant_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`, [grant.id, at]
      );
      await db.query(
        `UPDATE continuity_delivery_sessions SET revoked_at = COALESCE(revoked_at, $2)
         WHERE delivery_grant_id = $1 AND revoked_at IS NULL`, [grant.id, at]
      );
      await db.query(
        `UPDATE continuity_notification_outbox SET status = 'superseded', superseded_at = $2,
             claimed_by = NULL, claim_expires_at = NULL, last_error_class = 'grant_expired', updated_at = $2
         WHERE delivery_grant_id = $1 AND notification_type = 'recipient_delivery'
           AND status IN ('deferred', 'pending', 'claimed', 'failed', 'blocked_configuration')`, [grant.id, at]
      );
      await recordRecipientEvent(db, {
        switchId: grant.switch_id, cycle: grant.schedule_cycle, type: 'delivery.recipient_grant_expired',
        details: { delivery_grant_id: Number(grant.id) },
        dedupeKey: `delivery-grant:${grant.id}:expired`, occurredAt: at
      });
      runIds.add(Number(grant.delivery_run_id));
    }
    let completedRuns = 0;
    for (const runId of runIds) {
      const { rows } = await db.query(
        `SELECT run.id, run.switch_id FROM continuity_delivery_runs run
         WHERE run.id = $1 AND run.status = 'delivery_active'
           AND NOT EXISTS (SELECT 1 FROM continuity_delivery_grants grant_row
                           WHERE grant_row.delivery_run_id = run.id AND grant_row.status = 'active')
         FOR UPDATE`, [runId]
      );
      const run = rows[0];
      if (!run) continue;
      await db.query(`UPDATE continuity_delivery_runs SET status = 'delivery_complete', updated_at = $2 WHERE id = $1`, [run.id, at]);
      await db.query(
        `UPDATE continuity_switches SET status = 'delivery_complete', updated_at = $2
         WHERE id = $1 AND status = 'delivery_active'`, [run.switch_id, at]
      );
      completedRuns += 1;
    }
    return { grants_expired: grants.length, runs_completed: completedRuns };
  });
}

async function exchangeAccessToken(rawToken, { now = new Date(), dbPool = pool } = {}) {
  const at = asDate(now);
  if (!rawToken || typeof rawToken !== 'string') throw genericUnavailable();
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT token.id AS token_id, grant_row.id AS delivery_grant_id, grant_row.expires_at
       FROM continuity_delivery_tokens token
       JOIN continuity_delivery_grants grant_row ON grant_row.id = token.delivery_grant_id
       JOIN continuity_delivery_runs run ON run.id = grant_row.delivery_run_id
       JOIN continuity_switches switch ON switch.id = run.switch_id
       WHERE token.token_hash = $1 AND token.purpose = 'access' AND token.consumed_at IS NULL
         AND token.replaced_at IS NULL AND token.expires_at > $2
         AND grant_row.status = 'active' AND grant_row.expires_at > $2
         AND run.status IN ('delivery_active', 'delivery_complete')
         AND switch.status IN ('delivery_active', 'delivery_complete')
       FOR UPDATE OF token, grant_row`, [tokenHash(rawToken), at]
    );
    const match = rows[0];
    if (!match) throw genericUnavailable();
    const bearer = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(asDate(match.expires_at).getTime(), at.getTime() + RECIPIENT_SESSION_TTL_MS));
    await db.query('UPDATE continuity_delivery_tokens SET consumed_at = $2 WHERE id = $1', [match.token_id, at]);
    await db.query(
      `INSERT INTO continuity_delivery_sessions (delivery_grant_id, bearer_hash, created_at, expires_at, last_active_at)
       VALUES ($1, $2, $3, $4, $3)`, [match.delivery_grant_id, tokenHash(bearer), at, expiresAt]
    );
    const manifest = await manifestForGrant(db, match.delivery_grant_id);
    return { bearer, expires_at: expiresAt.toISOString(), items: manifest };
  });
}

async function sessionForBearer(rawBearer, { now = new Date(), db = pool } = {}) {
  const at = asDate(now);
  if (!rawBearer || typeof rawBearer !== 'string') return null;
  const { rows } = await db.query(
    `SELECT session.id AS session_id, session.delivery_grant_id, session.last_active_at
     FROM continuity_delivery_sessions session
     JOIN continuity_delivery_grants grant_row ON grant_row.id = session.delivery_grant_id
     JOIN continuity_delivery_runs run ON run.id = grant_row.delivery_run_id
     JOIN continuity_switches switch ON switch.id = run.switch_id
     WHERE session.bearer_hash = $1 AND session.revoked_at IS NULL AND session.expires_at > $2
       AND grant_row.status = 'active' AND grant_row.expires_at > $2
       AND run.status IN ('delivery_active', 'delivery_complete')
       AND switch.status IN ('delivery_active', 'delivery_complete')`, [tokenHash(rawBearer), at]
  );
  const session = rows[0];
  if (!session) return null;
  if (at.getTime() - asDate(session.last_active_at).getTime() >= 5 * 60 * 1000) {
    await db.query('UPDATE continuity_delivery_sessions SET last_active_at = $2 WHERE id = $1', [session.session_id, at]);
  }
  return session;
}

async function manifestForGrant(db, grantId) {
  const { rows } = await db.query(
    `SELECT item_ordinal FROM continuity_delivery_items
     WHERE delivery_grant_id = $1 AND eligibility_status = 'ready' ORDER BY item_ordinal`, [grantId]
  );
  return rows.map((row) => ({ ordinal: Number(row.item_ordinal), label: `Private document ${row.item_ordinal}` }));
}

async function getRecipientManifest(rawBearer, options = {}) {
  const session = await sessionForBearer(rawBearer, options);
  if (!session) throw genericUnavailable();
  return { items: await manifestForGrant(options.db || pool, session.delivery_grant_id) };
}

function hashStoredFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function wrappedDekMatches(current, stored) {
  return current?.kind === 'pki_x25519'
    && current.ephemeral_public_key_b64 === stored?.ephemeral_public_key_b64
    && current.hkdf_salt_b64 === stored?.hkdf_salt_b64
    && current.wrapped_dek_b64 === stored?.wrapped_dek_b64;
}

async function resolveExactItem(rawBearer, ordinal, { now = new Date(), db = pool } = {}) {
  const session = await sessionForBearer(rawBearer, { now, db });
  if (!session || !Number.isInteger(Number(ordinal)) || Number(ordinal) < 1) throw genericUnavailable();
  const { rows } = await db.query(
    `SELECT item.*, grant_row.member_id, grant_row.trustee_id, grant_row.role
     FROM continuity_delivery_items item
     JOIN continuity_delivery_grants grant_row ON grant_row.id = item.delivery_grant_id
     WHERE item.delivery_grant_id = $1 AND item.item_ordinal = $2 AND item.eligibility_status = 'ready'`,
    [session.delivery_grant_id, Number(ordinal)]
  );
  const item = rows[0];
  if (!item) throw genericUnavailable();
  const { rows: docs } = await db.query('SELECT * FROM documents WHERE id = (SELECT document_id FROM document_files WHERE id = $1)', [item.document_file_id]);
  const doc = docs[0];
  const entry = doc?.encryption_metadata?.files?.[item.envelope_file_key];
  const holders = Array.isArray(entry?.holders) ? entry.holders : [];
  const holder = holders.find((candidate) => (item.member_id
    ? Number(candidate.member_id) === Number(item.member_id) && !candidate.trustee_id
    : Number(candidate.trustee_id) === Number(item.trustee_id) && !candidate.member_id)
    && candidate.role === item.role && candidate.sealed === true && candidate.sealed_until === 'deadman_trigger'
    && Number(candidate.encryption_key_id) === Number(item.encryption_key_id)
    && candidate.key_fingerprint === item.key_fingerprint && wrappedDekMatches(candidate.wrapped_dek, item.wrapped_dek));
  const { rows: files } = await db.query('SELECT * FROM document_files WHERE id = $1 AND document_id = $2', [item.document_file_id, doc?.id || 0]);
  const { rows: designations } = await db.query('SELECT * FROM document_designations WHERE id = $1', [item.designation_id]);
  const { rows: keys } = await db.query('SELECT * FROM encryption_keys WHERE id = $1', [item.encryption_key_id]);
  const designation = designations[0]; const key = keys[0]; const file = files[0];
  const valid = doc?.status === 'active' && doc.is_encrypted === true && doc.encryption_mode === 'pki'
    && Number(doc.encryption_metadata?.version) === 2 && doc.encryption_metadata?.mode === 'pki'
    && entry?.cipher === 'aes-256-gcm' && typeof entry.iv_b64 === 'string'
    && file?.file_type === 'original' && file.sha256 === item.file_sha256
    && designation && Number(designation.document_id) === Number(doc.id) && designation.role === item.role
    && designation.sealed === true && designation.sealed_until === 'deadman_trigger'
    && Number(designation.encryption_key_id) === Number(item.encryption_key_id)
    && (item.member_id ? Number(designation.member_id) === Number(item.member_id) && !designation.trustee_id
      : Number(designation.trustee_id) === Number(item.trustee_id) && !designation.member_id)
    && key && !key.revoked_at && key.key_fingerprint === item.key_fingerprint
    && (item.member_id ? key.key_type === 'member' && Number(key.member_id) === Number(item.member_id)
      : key.key_type === 'trustee' && Number(key.trustee_id) === Number(item.trustee_id)) && holder;
  if (!valid) throw genericUnavailable();
  return { session, item, file, key };
}

async function getRecipientItem(rawBearer, ordinal, options = {}) {
  const { item, key } = await resolveExactItem(rawBearer, ordinal, options);
  return {
    ordinal: Number(item.item_ordinal), label: `Private document ${item.item_ordinal}`,
    artifact: { ...item.artifact_metadata, wrapped_dek: item.wrapped_dek },
    key_material: {
      encrypted_private_key: key.encrypted_private_key, credential_id: key.credential_id,
      credential_verified: key.credential_verified, verification_method: key.verification_method,
      protection_tier: key.protection_tier, prf_enabled: key.prf_enabled
    }
  };
}

async function streamRecipientCiphertext(rawBearer, ordinal, res, options = {}) {
  const { item, file } = await resolveExactItem(rawBearer, ordinal, options);
  const filePath = getFilePath(file.stored_filename);
  if (!fs.existsSync(filePath)) throw genericUnavailable();
  try {
    if (await hashStoredFile(filePath) !== item.file_sha256) throw genericUnavailable();
  } catch (error) {
    if (error?.code === 'RECIPIENT_UNAVAILABLE') throw error;
    throw genericUnavailable();
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
}

module.exports = {
  RECIPIENT_LINK_TTL_MS, RECIPIENT_SESSION_TTL_MS, claimRecipientOutboxAttempt,
  completeRecipientOutboxAttempt, deliveryUrl, exchangeAccessToken, expireRecipientGrants,
  getRecipientItem, getRecipientManifest, genericUnavailable, recipientDeliveryMessage,
  requestRecipientReissue, resolveExactItem, streamRecipientCiphertext
};
