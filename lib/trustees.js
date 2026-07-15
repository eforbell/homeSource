'use strict';

const crypto = require('node:crypto');
const { pool } = require('./db');
const { computeFingerprint } = require('./pki');

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

async function createTrustee({ name, relationship = null, email, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO vault_trustees (name, relationship, email, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [requiredText(name, 'name'), relationship?.trim() || null, requiredText(email, 'email'), Number(createdBy)]
  );
  return rows[0];
}

function hashInvitationToken(token) {
  return crypto.createHash('sha256').update(requiredText(token, 'token')).digest('hex');
}

function createInvitationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createTrusteeInvitation({ trusteeId, expiresAt = null }) {
  const token = createInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const { rows } = await pool.query(
    `INSERT INTO trustee_invitations (trustee_id, token_hash, expires_at)
     SELECT id, $2, COALESCE($3::timestamptz, NOW() + INTERVAL '7 days')
     FROM vault_trustees
     WHERE id = $1 AND status = 'invited'
     RETURNING id, trustee_id, expires_at, created_at`,
    [Number(trusteeId), tokenHash, expiresAt]
  );
  if (!rows[0]) throw new Error('Trustee is not available for invitation');
  return { ...rows[0], token };
}

async function getValidTrusteeInvitation(token, db = pool) {
  const { rows } = await db.query(
    `SELECT ti.id, ti.trustee_id, ti.expires_at, vt.name, vt.relationship, vt.status,
            creator.name AS created_by_name
     FROM trustee_invitations ti
     JOIN vault_trustees vt ON vt.id = ti.trustee_id
     JOIN family_members creator ON creator.id = vt.created_by
     WHERE ti.token_hash = $1
       AND ti.used_at IS NULL
       AND ti.expires_at > NOW()
       AND vt.status = 'invited'
     FOR UPDATE OF ti, vt`,
    [hashInvitationToken(token)]
  );
  return rows[0] || null;
}

function requiredKeyMaterial(value, field) {
  return requiredText(value, field);
}

async function registerTrusteeFromInvitation({ token, publicKey, encryptedPrivateKey, algorithm = 'x25519', protectionTier = 'passphrase', label = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invitation = await getValidTrusteeInvitation(token, client);
    if (!invitation) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: keyRows } = await client.query(
      `INSERT INTO encryption_keys
         (key_type, trustee_id, public_key, encrypted_private_key, algorithm, key_fingerprint, protection_tier, label, verification_method)
       VALUES ('trustee', $1, $2, $3, $4, $5, $6, $7, 'passphrase')
       RETURNING id, key_type, trustee_id, public_key, algorithm, key_fingerprint,
                 protection_tier, label, created_at, revoked_at, last_used_at`,
      [
        invitation.trustee_id,
        requiredKeyMaterial(publicKey, 'public_key'),
        requiredKeyMaterial(encryptedPrivateKey, 'encrypted_private_key'),
        requiredText(algorithm, 'algorithm'),
        computeFingerprint(publicKey),
        requiredText(protectionTier, 'protection_tier'),
        typeof label === 'string' && label.trim() ? label.trim() : null
      ]
    );
    const { rows: trusteeRows } = await client.query(
      `UPDATE vault_trustees
       SET status = 'registered', registered_at = NOW()
       WHERE id = $1 AND status = 'invited'
       RETURNING id, name, relationship, email, status, created_by, created_at, registered_at`,
      [invitation.trustee_id]
    );
    if (!trusteeRows[0]) throw new Error('Trustee is not available for registration');
    await client.query(
      'UPDATE trustee_invitations SET used_at = NOW() WHERE id = $1 AND used_at IS NULL',
      [invitation.id]
    );
    await client.query('COMMIT');
    return { trustee: trusteeRows[0], key: keyRows[0], invitation };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listTrustees() {
  const { rows } = await pool.query(
    `SELECT vt.id, vt.name, vt.relationship, vt.email, vt.status, vt.created_by,
            vt.created_at, vt.registered_at, vt.revoked_at,
            COUNT(dd.id)::int AS designation_count
     FROM vault_trustees vt
     LEFT JOIN document_designations dd ON dd.trustee_id = vt.id
     GROUP BY vt.id
     ORDER BY vt.name ASC`
  );
  return rows;
}

async function revokeTrustee(id) {
  const { rows } = await pool.query(
    `UPDATE vault_trustees
     SET status = 'revoked', revoked_at = NOW()
     WHERE id = $1 AND status <> 'revoked'
     RETURNING id, name, relationship, email, status, created_by, created_at, registered_at, revoked_at`,
    [Number(id)]
  );
  return rows[0] || null;
}

async function upsertDesignation(client, { documentId, memberId = null, trusteeId = null, role, encryptionKeyId, sealed = true }) {
  const hasMember = Number.isInteger(Number(memberId)) && Number(memberId) > 0;
  const hasTrustee = Number.isInteger(Number(trusteeId)) && Number(trusteeId) > 0;
  if (hasMember === hasTrustee) throw new TypeError('A designation requires exactly one recipient identity');
  if ((role === 'beneficiary') !== hasMember || (role === 'trustee') !== hasTrustee) {
    throw new TypeError('Designation role must match its recipient identity');
  }
  const { rows } = await client.query(
    `INSERT INTO document_designations
       (document_id, member_id, trustee_id, role, sealed, sealed_until, encryption_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (document_id, encryption_key_id)
     DO UPDATE SET member_id = EXCLUDED.member_id, trustee_id = EXCLUDED.trustee_id,
                   role = EXCLUDED.role, sealed = EXCLUDED.sealed,
                   sealed_until = CASE WHEN EXCLUDED.sealed THEN 'deadman_trigger' ELSE 'unsealed' END
     RETURNING *`,
    [Number(documentId), hasMember ? Number(memberId) : null, hasTrustee ? Number(trusteeId) : null, role, sealed === true, sealed === true ? 'deadman_trigger' : 'unsealed', Number(encryptionKeyId)]
  );
  return rows[0];
}

async function createDesignation({ documentId, memberId = null, trusteeId = null, role, encryptionKeyId = null }) {
  const hasMember = Number.isInteger(Number(memberId)) && Number(memberId) > 0;
  const hasTrustee = Number.isInteger(Number(trusteeId)) && Number(trusteeId) > 0;
  if (hasMember === hasTrustee) throw new TypeError('A designation requires exactly one recipient identity');
  if ((role === 'beneficiary') !== hasMember || (role === 'trustee') !== hasTrustee) {
    throw new TypeError('Designation role must match its recipient identity');
  }
  if (!['beneficiary', 'trustee'].includes(role)) throw new TypeError('Invalid designation role');

  const { rows } = await pool.query(
    `INSERT INTO document_designations (document_id, member_id, trustee_id, role, encryption_key_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [Number(documentId), hasMember ? Number(memberId) : null, hasTrustee ? Number(trusteeId) : null, role, encryptionKeyId || null]
  );
  return rows[0];
}

module.exports = {
  createTrustee,
  createTrusteeInvitation,
  getValidTrusteeInvitation,
  hashInvitationToken,
  registerTrusteeFromInvitation,
  listTrustees,
  revokeTrustee,
  upsertDesignation,
  createDesignation
};
