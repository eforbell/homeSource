'use strict';

const crypto = require('node:crypto');
const { pool } = require('./db');
const { getMailerConfig } = require('./mailer');
const { normalizeEmail, maskEmail } = require('./continuity-contacts');
const brrr = require('./brrr');

const CHALLENGE_LIFETIME_MS = 30 * 60 * 1000;

class ReadinessError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ReadinessError';
    this.statusCode = statusCode;
  }
}

function id(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ReadinessError(`${name} is invalid`);
  return parsed;
}

function at(value = new Date()) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ReadinessError('date is invalid');
  return parsed;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeErrorClass(error) {
  const code = String(error?.code || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  if (code) return code;
  const status = Number(error?.statusCode || 0);
  return status ? `http_${status}` : 'delivery_error';
}

function safeBrrrChannel(row) {
  if (!row) return {
    channel_type: 'brrr', enabled: false, has_secret: false, secret_mask: '',
    label: null, config_version: 0, transport_tested: false, last_transport_status: null
  };
  return {
    id: Number(row.id),
    channel_type: 'brrr',
    label: row.label,
    enabled: row.enabled === true,
    has_secret: Boolean(row.target_secret),
    secret_mask: row.target_secret ? brrr.maskSecret(row.target_secret) : '',
    config_version: Number(row.config_version),
    transport_tested: Boolean(row.transport_tested_at && row.last_transport_status === 'accepted'),
    transport_tested_at: row.transport_tested_at,
    last_transport_status: row.last_transport_status,
    updated_at: row.updated_at
  };
}

async function requireParent(db, ownerId) {
  const { rows } = await db.query('SELECT id, name FROM family_members WHERE id = $1 AND role = \'parent\' FOR UPDATE', [id(ownerId, 'owner_id')]);
  if (!rows[0]) throw new ReadinessError('Parent operator not found', 404);
  return rows[0];
}

async function requireEditableSwitch(db, ownerId, switchId) {
  const { rows } = await db.query(
    `SELECT * FROM continuity_switches
     WHERE id = $1 AND owner_id = $2 AND status IN ('draft', 'armed', 'paused') FOR UPDATE`,
    [id(switchId, 'switch_id'), id(ownerId, 'owner_id')]
  );
  if (!rows[0]) throw new ReadinessError('Editable continuity switch not found', 404);
  return rows[0];
}

async function saveBrrrChannel({ ownerId, secret, enabled, label = null, now = new Date() }) {
  const moment = at(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireParent(client, ownerId);
    const { rows } = await client.query(
      `SELECT * FROM member_notification_channels WHERE member_id = $1 AND channel_type = 'brrr' FOR UPDATE`,
      [id(ownerId, 'owner_id')]
    );
    const existing = rows[0] || null;
    const target = secret === undefined
      ? existing?.target_secret || null
      : (String(secret || '').trim() ? brrr.normalizeBrrrTarget(secret) : null);
    const nextEnabled = enabled === true;
    if (nextEnabled && !target) throw new ReadinessError('Save a brrr target before enabling it');
    const targetFingerprint = target ? brrr.fingerprintTarget(target) : null;
    const changed = !existing || existing.target_fingerprint !== targetFingerprint || existing.enabled !== nextEnabled;
    const version = existing ? Number(existing.config_version) + (changed ? 1 : 0) : 1;
    const { rows: savedRows } = await client.query(
      `INSERT INTO member_notification_channels
         (member_id, channel_type, label, target_secret, target_fingerprint, enabled, config_version,
          transport_tested_at, last_transport_status, last_transport_error_class, created_at, updated_at)
       VALUES ($1, 'brrr', $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, $7)
       ON CONFLICT (member_id, channel_type) DO UPDATE SET
         label = EXCLUDED.label, target_secret = EXCLUDED.target_secret,
         target_fingerprint = EXCLUDED.target_fingerprint, enabled = EXCLUDED.enabled,
         config_version = EXCLUDED.config_version,
         transport_tested_at = CASE WHEN member_notification_channels.target_fingerprint IS DISTINCT FROM EXCLUDED.target_fingerprint OR member_notification_channels.enabled IS DISTINCT FROM EXCLUDED.enabled THEN NULL ELSE member_notification_channels.transport_tested_at END,
         last_transport_status = CASE WHEN member_notification_channels.target_fingerprint IS DISTINCT FROM EXCLUDED.target_fingerprint OR member_notification_channels.enabled IS DISTINCT FROM EXCLUDED.enabled THEN NULL ELSE member_notification_channels.last_transport_status END,
         last_transport_error_class = CASE WHEN member_notification_channels.target_fingerprint IS DISTINCT FROM EXCLUDED.target_fingerprint OR member_notification_channels.enabled IS DISTINCT FROM EXCLUDED.enabled THEN NULL ELSE member_notification_channels.last_transport_error_class END,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id(ownerId, 'owner_id'), String(label || '').trim().slice(0, 80) || null, target, targetFingerprint, nextEnabled, version, moment]
    );
    await client.query('COMMIT');
    return safeBrrrChannel(savedRows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function clearBrrrChannel({ ownerId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM member_notification_channels mnc USING family_members m
     WHERE mnc.member_id = m.id AND mnc.member_id = $1 AND m.role = 'parent' AND mnc.channel_type = 'brrr'`,
    [id(ownerId, 'owner_id')]
  );
  return rowCount > 0;
}

async function getBrrrChannel(ownerId, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM member_notification_channels WHERE member_id = $1 AND channel_type = 'brrr'`,
    [id(ownerId, 'owner_id')]
  );
  return rows[0] || null;
}

async function recordBrrrTransport({ ownerId, accepted, errorClass = null, now = new Date() }) {
  const { rows } = await pool.query(
    `UPDATE member_notification_channels SET
       transport_tested_at = $2, last_transport_status = $3,
       last_transport_error_class = $4, updated_at = $2
     WHERE member_id = $1 AND channel_type = 'brrr'
     RETURNING *`,
    [id(ownerId, 'owner_id'), at(now), accepted ? 'accepted' : 'failed', accepted ? null : String(errorClass || 'delivery_error').slice(0, 80)]
  );
  return safeBrrrChannel(rows[0]);
}

function emailConfiguration(switchRow, env = process.env) {
  const address = normalizeEmail(switchRow.reminder_email);
  const mail = getMailerConfig(env);
  const safeConfig = {
    transport: mail.transport,
    reason: mail.reason || null,
    from: mail.from || null,
    host: mail.options?.host || null,
    port: mail.options?.port || null,
    secure: mail.options?.secure || false,
    requireTLS: mail.options?.requireTLS || false
  };
  const configHash = digest(JSON.stringify(safeConfig));
  return {
    channel_type: 'email',
    configuration_version: `email:${configHash}`,
    target_fingerprint: digest(`${address}|${configHash}`),
    target_mask: maskEmail(address),
    target: address,
    enabled: true,
    transport_configured: mail.transport !== 'disabled'
  };
}

async function channelConfiguration(db, { switchRow, ownerId, channelType, env = process.env }) {
  if (channelType === 'email') return emailConfiguration(switchRow, env);
  if (channelType !== 'brrr') throw new ReadinessError('Unknown continuity notification channel', 404);
  const row = await getBrrrChannel(ownerId, db);
  if (!row?.enabled || !row.target_secret || !row.target_fingerprint) throw new ReadinessError('Enabled brrr channel not found', 404);
  return {
    channel_type: 'brrr',
    configuration_version: `brrr:${row.id}:${row.config_version}`,
    target_fingerprint: row.target_fingerprint,
    target_mask: brrr.maskSecret(row.target_secret),
    target: row.target_secret,
    enabled: true,
    transport_configured: true,
    row
  };
}

async function createReachabilityChallenge({ ownerId, switchId, channelType, now = new Date(), env = process.env }) {
  const moment = at(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const switchRow = await requireEditableSwitch(client, ownerId, switchId);
    const config = await channelConfiguration(client, { switchRow, ownerId, channelType, env });
    await client.query(
      `UPDATE continuity_operator_channel_attestations SET replaced_at = $3
       WHERE switch_id = $1 AND channel_type = $2 AND replaced_at IS NULL`,
      [switchRow.id, channelType, moment]
    );
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const expiresAt = new Date(moment.getTime() + CHALLENGE_LIFETIME_MS);
    const { rows } = await client.query(
      `INSERT INTO continuity_operator_channel_attestations
         (switch_id, owner_id, channel_type, configuration_version, target_fingerprint,
          challenge_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [switchRow.id, id(ownerId, 'owner_id'), channelType, config.configuration_version,
        config.target_fingerprint, digest(code), expiresAt, moment]
    );
    await client.query('COMMIT');
    return { attestation: rows[0], code, config };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function recordChallengeTransport({ attestationId, accepted, errorClass = null, now = new Date() }) {
  const { rows } = await pool.query(
    `UPDATE continuity_operator_channel_attestations SET
       transport_accepted_at = CASE WHEN $2::boolean THEN $3::timestamptz ELSE NULL::timestamptz END,
       transport_error_class = CASE WHEN $2::boolean THEN NULL::text ELSE $4::text END
     WHERE id = $1 RETURNING *`,
    [id(attestationId, 'attestation_id'), accepted === true, at(now), accepted ? null : String(errorClass || 'delivery_error').slice(0, 80)]
  );
  return rows[0] || null;
}

async function currentAttestation(db, switchId, channelType, config, now) {
  const { rows } = await db.query(
    `SELECT * FROM continuity_operator_channel_attestations
     WHERE switch_id = $1 AND channel_type = $2 AND replaced_at IS NULL
       AND configuration_version = $3 AND target_fingerprint = $4
       AND expires_at > $5`,
    [switchId, channelType, config.configuration_version, config.target_fingerprint, now]
  );
  return rows[0] || null;
}

async function readinessForSwitchRow({ db, switchRow, ownerId, now, env }) {
  const emailConfig = emailConfiguration(switchRow, env);
  const brrrRow = await getBrrrChannel(ownerId, db);
  const brrrEnabled = Boolean(brrrRow?.enabled && brrrRow.target_secret && brrrRow.target_fingerprint);
  const brrrConfig = brrrEnabled ? await channelConfiguration(db, { switchRow, ownerId, channelType: 'brrr', env }) : null;
  const emailAttestation = await currentAttestation(db, switchRow.id, 'email', emailConfig, now);
  const brrrAttestation = brrrConfig ? await currentAttestation(db, switchRow.id, 'brrr', brrrConfig, now) : null;
  const email = {
    channel_type: 'email', required: true, enabled: true, target_mask: emailConfig.target_mask,
    transport_configured: emailConfig.transport_configured,
    transport_tested: Boolean(emailAttestation?.transport_accepted_at),
    reachability_acknowledged: Boolean(emailAttestation?.acknowledged_at),
    acknowledged_at: emailAttestation?.acknowledged_at || null
  };
  const brrrChannel = safeBrrrChannel(brrrRow);
  const brrrState = {
    ...brrrChannel, required: brrrEnabled, target_mask: brrrChannel.secret_mask,
    transport_configured: Boolean(brrrRow?.target_secret),
    transport_tested: Boolean(brrrRow?.transport_tested_at && brrrRow.last_transport_status === 'accepted'),
    reachability_acknowledged: Boolean(brrrAttestation?.acknowledged_at),
    acknowledged_at: brrrAttestation?.acknowledged_at || null
  };
  return {
    switch_id: Number(switchRow.id), channels: { email, brrr: brrrState },
    ready_to_arm: email.transport_configured && email.transport_tested && email.reachability_acknowledged
      && (!brrrEnabled || (brrrState.transport_tested && brrrState.reachability_acknowledged))
  };
}

async function getReadiness({ ownerId, switchId, now = new Date(), env = process.env }, db = pool) {
  const moment = at(now);
  const { rows } = await db.query(
    `SELECT * FROM continuity_switches
     WHERE id = $1 AND owner_id = $2 AND status IN ('draft', 'armed', 'paused')`,
    [id(switchId, 'switch_id'), id(ownerId, 'owner_id')]
  );
  const switchRow = rows[0];
  if (!switchRow) throw new ReadinessError('Editable continuity switch not found', 404);
  return readinessForSwitchRow({ db, switchRow, ownerId, now: moment, env });
}

async function assertActivationReadiness({ db, switchRow, ownerId, now = new Date(), env = process.env }) {
  const readiness = await readinessForSwitchRow({
    db, switchRow, ownerId: id(ownerId, 'owner_id'), now: at(now), env
  });
  if (!readiness.ready_to_arm) throw new ReadinessError('Current operator reachability evidence is required before activation');
  return readiness;
}

async function acknowledgeReachability({ ownerId, switchId, channelType, code, now = new Date(), env = process.env }) {
  const moment = at(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const switchRow = await requireEditableSwitch(client, ownerId, switchId);
    const config = await channelConfiguration(client, { switchRow, ownerId, channelType, env });
    const attestation = await currentAttestation(client, switchRow.id, channelType, config, moment);
    if (!attestation || attestation.acknowledged_at) throw new ReadinessError('Reachability challenge is unavailable or expired', 404);
    if (digest(String(code || '').trim().toUpperCase()) !== attestation.challenge_hash) {
      const attempts = Number(attestation.attempt_count) + 1;
      await client.query(
        `UPDATE continuity_operator_channel_attestations
         SET attempt_count = $2, replaced_at = CASE WHEN $2 >= 5 THEN $3 ELSE replaced_at END
         WHERE id = $1`,
        [attestation.id, attempts, moment]
      );
      await client.query('COMMIT');
      throw new ReadinessError('Reachability code is incorrect');
    }
    await client.query(
      `UPDATE continuity_operator_channel_attestations SET acknowledged_at = $2 WHERE id = $1`,
      [attestation.id, moment]
    );
    await client.query('COMMIT');
    return getReadiness({ ownerId, switchId, now: moment, env });
  } catch (error) {
    if (!error || error.message !== 'Reachability code is incorrect') await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = {
  ReadinessError,
  safeErrorClass,
  saveBrrrChannel,
  clearBrrrChannel,
  getBrrrChannel,
  recordBrrrTransport,
  createReachabilityChallenge,
  recordChallengeTransport,
  getReadiness,
  assertActivationReadiness,
  acknowledgeReachability
};
