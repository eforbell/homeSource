'use strict';

const crypto = require('node:crypto');
const { pool } = require('./db');
const { normalizeEmail, maskEmail } = require('./continuity-contacts');

const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

class TrusteeContactError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'TrusteeContactError';
    this.statusCode = statusCode;
  }
}

function positiveId(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TrusteeContactError(`${name} is invalid`);
  return parsed;
}

function asDate(value = new Date()) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TrusteeContactError('date is invalid');
  return parsed;
}

function hashToken(token) {
  if (typeof token !== 'string' || !token) throw new TrusteeContactError('Verification token is required');
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeContact(row) {
  return {
    id: Number(row.id),
    trustee_id: Number(row.trustee_id),
    trustee_name: row.trustee_name,
    channel_type: row.channel_type,
    normalized_address: row.normalized_address,
    target_mask: maskEmail(row.normalized_address),
    status: row.status,
    verification_source: row.verification_source,
    verified_at: row.verified_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function requireOwnedRegisteredTrustee(db, ownerId, trusteeId) {
  const { rows } = await db.query(
    `SELECT id, name, email, status, created_by
     FROM vault_trustees
     WHERE id = $1 AND created_by = $2 AND status = 'registered'
     FOR UPDATE`,
    [positiveId(trusteeId, 'trustee_id'), positiveId(ownerId, 'owner_id')]
  );
  if (!rows[0]) throw new TrusteeContactError('Registered trustee not found', 404);
  return rows[0];
}

async function replaceUsableTokens(db, contactId, now) {
  await db.query(
    `UPDATE trustee_contact_verification_tokens
     SET replaced_at = COALESCE(replaced_at, $2)
     WHERE contact_channel_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
    [positiveId(contactId, 'contact_id'), now]
  );
}

async function insertToken(db, contactId, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS);
  await db.query(
    `INSERT INTO trustee_contact_verification_tokens
       (contact_channel_id, purpose, token_hash, expires_at, created_at)
     VALUES ($1, 'email_control', $2, $3, $4)`,
    [positiveId(contactId, 'contact_id'), hashToken(token), expiresAt, now]
  );
  return { token, expires_at: expiresAt };
}

async function assertAddressAvailable(db, trusteeId, address) {
  const { rows } = await db.query(
    `SELECT 1
     FROM vault_trustees vt
     WHERE vt.id <> $1 AND vt.status <> 'revoked' AND LOWER(BTRIM(vt.email)) = $2
     UNION ALL
     SELECT 1
     FROM trustee_contact_channels channel
     WHERE channel.trustee_id <> $1 AND channel.status <> 'revoked'
       AND channel.channel_type = 'email' AND channel.normalized_address = $2
     LIMIT 1`,
    [positiveId(trusteeId, 'trustee_id'), address]
  );
  if (rows[0]) throw new TrusteeContactError('That email address is already assigned to another trustee');
}

async function startEmailReplacement({ ownerId, trusteeId, email, now = new Date() }) {
  const moment = asDate(now);
  let address;
  try { address = normalizeEmail(email); } catch { throw new TrusteeContactError('A valid email address is required'); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const trustee = await requireOwnedRegisteredTrustee(client, ownerId, trusteeId);
    await assertAddressAvailable(client, trustee.id, address);
    const { rows } = await client.query(
      `SELECT * FROM trustee_contact_channels
       WHERE trustee_id = $1 AND channel_type = 'email' AND status <> 'revoked'
       ORDER BY id FOR UPDATE`,
      [trustee.id]
    );
    const verified = rows.find((row) => row.status === 'verified');
    const pending = rows.find((row) => row.status === 'pending');
    if (verified?.normalized_address === address) {
      if (pending) {
        await replaceUsableTokens(client, pending.id, moment);
        await client.query(
          `UPDATE trustee_contact_channels SET status = 'revoked', revoked_at = $2, updated_at = $2
           WHERE id = $1`, [pending.id, moment]
        );
      }
      await client.query('COMMIT');
      return {
        contact: safeContact({ ...verified, trustee_name: trustee.name }),
        token: null, expires_at: null, already_verified: true
      };
    }
    if (pending) {
      await replaceUsableTokens(client, pending.id, moment);
      await client.query(
        `UPDATE trustee_contact_channels SET status = 'revoked', revoked_at = $2, updated_at = $2
         WHERE id = $1`, [pending.id, moment]
      );
    }
    const { rows: inserted } = await client.query(
      `INSERT INTO trustee_contact_channels
         (trustee_id, channel_type, normalized_address, status, created_at, updated_at)
       VALUES ($1, 'email', $2, 'pending', $3, $3)
       RETURNING *`,
      [trustee.id, address, moment]
    );
    const verification = await insertToken(client, inserted[0].id, moment);
    await client.query('COMMIT');
    return {
      contact: safeContact({ ...inserted[0], trustee_name: trustee.name }),
      ...verification, already_verified: false
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new TrusteeContactError('That email address is already assigned to another trustee');
    throw error;
  } finally { client.release(); }
}

async function resendEmailReplacement({ ownerId, trusteeId, contactId, now = new Date() }) {
  const moment = asDate(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const trustee = await requireOwnedRegisteredTrustee(client, ownerId, trusteeId);
    const { rows } = await client.query(
      `SELECT * FROM trustee_contact_channels
       WHERE id = $1 AND trustee_id = $2 AND channel_type = 'email' AND status = 'pending'
       FOR UPDATE`,
      [positiveId(contactId, 'contact_id'), trustee.id]
    );
    if (!rows[0]) throw new TrusteeContactError('Pending trustee contact not found', 404);
    await replaceUsableTokens(client, rows[0].id, moment);
    const verification = await insertToken(client, rows[0].id, moment);
    await client.query('COMMIT');
    return { contact: safeContact({ ...rows[0], trustee_name: trustee.name }), ...verification };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function cancelEmailReplacement({ ownerId, trusteeId, contactId, now = new Date() }) {
  const moment = asDate(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOwnedRegisteredTrustee(client, ownerId, trusteeId);
    const { rows } = await client.query(
      `SELECT * FROM trustee_contact_channels
       WHERE id = $1 AND trustee_id = $2 AND channel_type = 'email' AND status = 'pending'
       FOR UPDATE`,
      [positiveId(contactId, 'contact_id'), positiveId(trusteeId, 'trustee_id')]
    );
    if (!rows[0]) throw new TrusteeContactError('Pending trustee contact not found', 404);
    await replaceUsableTokens(client, rows[0].id, moment);
    const { rows: revoked } = await client.query(
      `UPDATE trustee_contact_channels SET status = 'revoked', revoked_at = $2, updated_at = $2
       WHERE id = $1 RETURNING *`, [rows[0].id, moment]
    );
    await client.query('COMMIT');
    return safeContact(revoked[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function getValidEmailReplacement(token, now = new Date(), db = pool) {
  let tokenDigest;
  try { tokenDigest = hashToken(token); } catch { return null; }
  const { rows } = await db.query(
    `SELECT token.id AS token_id, token.expires_at, channel.*, trustee.name AS trustee_name
     FROM trustee_contact_verification_tokens token
     JOIN trustee_contact_channels channel ON channel.id = token.contact_channel_id
     JOIN vault_trustees trustee ON trustee.id = channel.trustee_id
     WHERE token.token_hash = $1 AND token.purpose = 'email_control'
       AND token.consumed_at IS NULL AND token.replaced_at IS NULL
       AND token.expires_at > $2 AND channel.status = 'pending' AND trustee.status = 'registered'`,
    [tokenDigest, asDate(now)]
  );
  if (!rows[0]) return null;
  return {
    trustee_name: rows[0].trustee_name,
    target_mask: maskEmail(rows[0].normalized_address),
    status: rows[0].status,
    expires_at: rows[0].expires_at
  };
}

async function verifyEmailReplacement({ token, now = new Date() }) {
  const moment = asDate(now);
  let tokenDigest;
  try { tokenDigest = hashToken(token); } catch { return null; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT token.id AS token_id, token.contact_channel_id, channel.*,
              trustee.name AS trustee_name, trustee.status AS trustee_status
       FROM trustee_contact_verification_tokens token
       JOIN trustee_contact_channels channel ON channel.id = token.contact_channel_id
       JOIN vault_trustees trustee ON trustee.id = channel.trustee_id
       WHERE token.token_hash = $1 AND token.purpose = 'email_control'
         AND token.consumed_at IS NULL AND token.replaced_at IS NULL
         AND token.expires_at > $2 AND channel.status = 'pending' AND trustee.status = 'registered'
       FOR UPDATE OF token, channel, trustee`,
      [tokenDigest, moment]
    );
    const match = rows[0];
    if (!match) {
      await client.query('ROLLBACK');
      return null;
    }
    await assertAddressAvailable(client, match.trustee_id, match.normalized_address);
    await client.query(
      `UPDATE trustee_contact_channels
       SET status = 'revoked', revoked_at = $2, updated_at = $2
       WHERE trustee_id = $1 AND channel_type = 'email' AND status = 'verified'`,
      [match.trustee_id, moment]
    );
    const { rows: verified } = await client.query(
      `UPDATE trustee_contact_channels
       SET status = 'verified', verification_source = 'contact_verification',
           verified_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [match.contact_channel_id, moment]
    );
    if (!verified[0]) throw new TrusteeContactError('Trustee contact is no longer pending', 404);
    await client.query('UPDATE vault_trustees SET email = $2 WHERE id = $1', [match.trustee_id, match.normalized_address]);
    await client.query('UPDATE trustee_contact_verification_tokens SET consumed_at = $2 WHERE id = $1', [match.token_id, moment]);
    await client.query(
      `UPDATE trustee_contact_verification_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE contact_channel_id = $1 AND id <> $3 AND consumed_at IS NULL AND replaced_at IS NULL`,
      [match.contact_channel_id, moment, match.token_id]
    );
    await client.query('COMMIT');
    return safeContact({ ...verified[0], trustee_name: match.trustee_name });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new TrusteeContactError('That email address is already assigned to another trustee');
    throw error;
  } finally { client.release(); }
}

module.exports = {
  TrusteeContactError,
  TOKEN_LIFETIME_MS,
  startEmailReplacement,
  resendEmailReplacement,
  cancelEmailReplacement,
  getValidEmailReplacement,
  verifyEmailReplacement
};
