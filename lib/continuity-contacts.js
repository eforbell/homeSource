'use strict';

const crypto = require('node:crypto');
const { pool } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

class ContactError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ContactError';
    this.statusCode = statusCode;
  }
}

function positiveId(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ContactError(`${name} is invalid`);
  return parsed;
}

function asDate(value, name = 'date') {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ContactError(`${name} is invalid`);
  return parsed;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ContactError('A valid email address is required');
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !EMAIL_RE.test(normalized) || /[\r\n]/.test(normalized)) {
    throw new ContactError('A valid email address is required');
  }
  return normalized;
}

function hashToken(token) {
  if (typeof token !== 'string' || !token) throw new ContactError('Verification token is required');
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function maskEmail(value) {
  const normalized = normalizeEmail(value);
  const [local, domain] = normalized.split('@');
  return `${local.slice(0, 1)}**@${domain}`;
}

function safeContact(row) {
  return {
    id: Number(row.id),
    member_id: Number(row.member_id),
    member_name: row.member_name,
    channel_type: row.channel_type,
    normalized_address: row.normalized_address,
    status: row.status,
    verified_at: row.verified_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function requireOwnedSwitch(db, { ownerId, switchId, editable = false }) {
  const owner = positiveId(ownerId, 'owner_id');
  const id = positiveId(switchId, 'switch_id');
  const statuses = editable ? `AND status = 'draft'` : `AND status <> 'cancelled'`;
  const { rows } = await db.query(
    `SELECT id, owner_id, status FROM continuity_switches
     WHERE id = $1 AND owner_id = $2 ${statuses}
     FOR UPDATE`,
    [id, owner]
  );
  if (!rows[0]) throw new ContactError(editable ? 'Editable continuity switch not found' : 'Continuity switch not found', 404);
  return rows[0];
}

async function requireBeneficiary(db, { switchId, memberId }) {
  const member = positiveId(memberId, 'member_id');
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.role
     FROM continuity_recipients cr
     JOIN family_members m ON m.id = cr.member_id
     WHERE cr.switch_id = $1 AND cr.member_id = $2
       AND cr.role = 'beneficiary' AND m.role = 'kid'
     FOR UPDATE OF m`,
    [positiveId(switchId, 'switch_id'), member]
  );
  if (!rows[0]) throw new ContactError('Contact subject must be a kid beneficiary on this switch');
  return rows[0];
}

async function insertVerificationToken(db, contactId, now) {
  const token = createToken();
  const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS);
  const { rows } = await db.query(
    `INSERT INTO member_contact_verification_tokens
       (contact_channel_id, purpose, token_hash, expires_at, created_at)
     VALUES ($1, 'email_control', $2, $3, $4)
     RETURNING id, contact_channel_id, purpose, expires_at, created_at`,
    [positiveId(contactId, 'contact_id'), hashToken(token), expiresAt, now]
  );
  return { ...rows[0], token };
}

async function replaceUsableTokens(db, contactId, now) {
  await db.query(
    `UPDATE member_contact_verification_tokens
     SET replaced_at = COALESCE(replaced_at, $2)
     WHERE contact_channel_id = $1 AND consumed_at IS NULL AND replaced_at IS NULL`,
    [positiveId(contactId, 'contact_id'), now]
  );
}

async function startMemberEmailVerification({ ownerId, switchId, memberId, email, now = new Date() }) {
  const at = asDate(now);
  const address = normalizeEmail(email);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOwnedSwitch(client, { ownerId, switchId, editable: true });
    const beneficiary = await requireBeneficiary(client, { switchId, memberId });
    const { rows: existingRows } = await client.query(
      `SELECT mcc.*, m.name AS member_name
       FROM member_contact_channels mcc
       JOIN family_members m ON m.id = mcc.member_id
       WHERE mcc.member_id = $1 AND mcc.channel_type = 'email' AND mcc.status <> 'revoked'
       FOR UPDATE OF mcc`,
      [beneficiary.id]
    );
    let contact = existingRows[0] || null;

    if (contact && contact.normalized_address === address && contact.status === 'verified') {
      await client.query('COMMIT');
      return { contact: safeContact(contact), token: null, expires_at: null, already_verified: true };
    }

    if (contact && contact.normalized_address !== address) {
      await replaceUsableTokens(client, contact.id, at);
      await client.query(
        `UPDATE member_contact_channels
         SET status = 'revoked', revoked_at = $2, updated_at = $2
         WHERE id = $1`,
        [contact.id, at]
      );
      contact = null;
    }

    if (!contact) {
      const { rows } = await client.query(
        `INSERT INTO member_contact_channels
           (member_id, channel_type, normalized_address, status, created_by, created_at, updated_at)
         VALUES ($1, 'email', $2, 'pending', $3, $4, $4)
         RETURNING *, $5::text AS member_name`,
        [beneficiary.id, address, positiveId(ownerId, 'owner_id'), at, beneficiary.name]
      );
      contact = rows[0];
    } else {
      await replaceUsableTokens(client, contact.id, at);
    }

    const verification = await insertVerificationToken(client, contact.id, at);
    await client.query('COMMIT');
    return {
      contact: safeContact({ ...contact, member_name: beneficiary.name }),
      token: verification.token,
      expires_at: verification.expires_at,
      already_verified: false
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && err.constraint === 'idx_member_contact_channels_unique_current_address') {
      throw new ContactError('That email address is already assigned to another active continuity contact');
    }
    throw err;
  } finally {
    client.release();
  }
}

async function resendMemberEmailVerification({ ownerId, switchId, contactId, now = new Date() }) {
  const at = asDate(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOwnedSwitch(client, { ownerId, switchId, editable: true });
    const { rows } = await client.query(
      `SELECT mcc.*, m.name AS member_name
       FROM member_contact_channels mcc
       JOIN family_members m ON m.id = mcc.member_id
       JOIN continuity_recipients cr ON cr.member_id = mcc.member_id
       WHERE mcc.id = $1 AND cr.switch_id = $2 AND cr.role = 'beneficiary'
         AND m.role = 'kid' AND mcc.channel_type = 'email' AND mcc.status = 'pending'
       FOR UPDATE OF mcc, m`,
      [positiveId(contactId, 'contact_id'), positiveId(switchId, 'switch_id')]
    );
    const contact = rows[0];
    if (!contact) throw new ContactError('Pending continuity contact not found', 404);
    await replaceUsableTokens(client, contact.id, at);
    const verification = await insertVerificationToken(client, contact.id, at);
    await client.query('COMMIT');
    return {
      contact: safeContact(contact),
      token: verification.token,
      expires_at: verification.expires_at
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listMemberContacts({ ownerId, switchId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOwnedSwitch(client, { ownerId, switchId });
    const { rows } = await client.query(
      `SELECT mcc.*, m.name AS member_name
       FROM continuity_recipients cr
       JOIN family_members m ON m.id = cr.member_id AND m.role = 'kid'
       JOIN member_contact_channels mcc ON mcc.member_id = m.id
         AND mcc.channel_type = 'email' AND mcc.status <> 'revoked'
       WHERE cr.switch_id = $1 AND cr.role = 'beneficiary'
       ORDER BY cr.notification_order, m.name`,
      [positiveId(switchId, 'switch_id')]
    );
    await client.query('COMMIT');
    return rows.map(safeContact);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function revokeMemberContact({ ownerId, switchId, contactId, now = new Date() }) {
  const at = asDate(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireOwnedSwitch(client, { ownerId, switchId, editable: true });
    const { rows } = await client.query(
      `SELECT mcc.*, m.name AS member_name
       FROM member_contact_channels mcc
       JOIN family_members m ON m.id = mcc.member_id
       JOIN continuity_recipients cr ON cr.member_id = mcc.member_id
       WHERE mcc.id = $1 AND cr.switch_id = $2 AND cr.role = 'beneficiary'
         AND mcc.status <> 'revoked'
       FOR UPDATE OF mcc`,
      [positiveId(contactId, 'contact_id'), positiveId(switchId, 'switch_id')]
    );
    if (!rows[0]) throw new ContactError('Continuity contact not found', 404);
    await replaceUsableTokens(client, rows[0].id, at);
    const { rows: revokedRows } = await client.query(
      `UPDATE member_contact_channels
       SET status = 'revoked', revoked_at = $2, updated_at = $2
       WHERE id = $1
       RETURNING *`,
      [rows[0].id, at]
    );
    await client.query('COMMIT');
    return safeContact({ ...revokedRows[0], member_name: rows[0].member_name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getValidMemberEmailVerification(token, now = new Date(), db = pool) {
  let tokenHash;
  try {
    tokenHash = hashToken(token);
  } catch {
    return null;
  }
  const { rows } = await db.query(
    `SELECT mcvt.id AS token_id, mcvt.contact_channel_id AS contact_id, mcvt.expires_at,
            mcc.member_id, mcc.normalized_address, m.name AS member_name
     FROM member_contact_verification_tokens mcvt
     JOIN member_contact_channels mcc ON mcc.id = mcvt.contact_channel_id
     JOIN family_members m ON m.id = mcc.member_id
     WHERE mcvt.token_hash = $1 AND mcvt.purpose = 'email_control'
       AND mcvt.consumed_at IS NULL AND mcvt.replaced_at IS NULL
       AND mcvt.expires_at > $2 AND mcc.status = 'pending'`,
    [tokenHash, asDate(now)]
  );
  if (!rows[0]) return null;
  return {
    token_id: Number(rows[0].token_id),
    contact_id: Number(rows[0].contact_id),
    member_id: Number(rows[0].member_id),
    recipient_name: rows[0].member_name,
    masked_address: maskEmail(rows[0].normalized_address),
    expires_at: rows[0].expires_at
  };
}

async function verifyMemberEmail({ token, now = new Date() }) {
  const at = asDate(now);
  let tokenHash;
  try {
    tokenHash = hashToken(token);
  } catch {
    return null;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT mcvt.id AS token_id, mcvt.contact_channel_id, mcc.*, m.name AS member_name
       FROM member_contact_verification_tokens mcvt
       JOIN member_contact_channels mcc ON mcc.id = mcvt.contact_channel_id
       JOIN family_members m ON m.id = mcc.member_id
       WHERE mcvt.token_hash = $1 AND mcvt.purpose = 'email_control'
         AND mcvt.consumed_at IS NULL AND mcvt.replaced_at IS NULL
         AND mcvt.expires_at > $2 AND mcc.status = 'pending'
       FOR UPDATE OF mcvt, mcc`,
      [tokenHash, at]
    );
    const match = rows[0];
    if (!match) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      'UPDATE member_contact_verification_tokens SET consumed_at = $2 WHERE id = $1',
      [match.token_id, at]
    );
    await client.query(
      `UPDATE member_contact_verification_tokens
       SET replaced_at = COALESCE(replaced_at, $2)
       WHERE contact_channel_id = $1 AND id <> $3 AND consumed_at IS NULL AND replaced_at IS NULL`,
      [match.contact_channel_id, at, match.token_id]
    );
    const { rows: contactRows } = await client.query(
      `UPDATE member_contact_channels
       SET status = 'verified', verified_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [match.contact_channel_id, at]
    );
    if (!contactRows[0]) throw new ContactError('Continuity contact is no longer pending', 404);
    await client.query('COMMIT');
    return safeContact({ ...contactRows[0], member_name: match.member_name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ContactError,
  TOKEN_LIFETIME_MS,
  normalizeEmail,
  hashToken,
  maskEmail,
  startMemberEmailVerification,
  resendMemberEmailVerification,
  listMemberContacts,
  revokeMemberContact,
  getValidMemberEmailVerification,
  verifyMemberEmail
};
