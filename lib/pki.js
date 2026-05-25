'use strict';

const { pool } = require('./db');
const audit = require('./audit');

async function listMemberKeys(memberId) {
  const { rows } = await pool.query(
    `SELECT id, key_type, public_key, algorithm, credential_id, prf_enabled,
            key_fingerprint, protection_tier, label, created_at, last_used_at
     FROM encryption_keys
     WHERE member_id = $1 AND key_type = 'member' AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [memberId]
  );
  return rows;
}

async function getMemberKey(keyId, memberId) {
  const { rows } = await pool.query(
    `SELECT id, key_type, public_key, encrypted_private_key, algorithm,
            credential_id, prf_enabled, key_fingerprint, protection_tier,
            label, member_id, created_at, revoked_at, last_used_at
     FROM encryption_keys
     WHERE id = $1 AND member_id = $2 AND key_type = 'member'`,
    [keyId, memberId]
  );
  return rows[0] || null;
}

async function registerMemberKey({ memberId, publicKey, encryptedPrivateKey, algorithm, credentialId, prfEnabled, keyFingerprint, protectionTier, label }) {
  const { rows } = await pool.query(
    `INSERT INTO encryption_keys
       (key_type, member_id, public_key, encrypted_private_key, algorithm,
        credential_id, prf_enabled, key_fingerprint, protection_tier, label)
     VALUES ('member', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, key_type, member_id, public_key, algorithm, credential_id,
               prf_enabled, key_fingerprint, protection_tier, label,
               created_at, revoked_at, last_used_at`,
    [memberId, publicKey, encryptedPrivateKey, algorithm, credentialId, prfEnabled, keyFingerprint, protectionTier, label]
  );
  return rows[0];
}

async function revokeMemberKey(keyId, actorId) {
  const { rows } = await pool.query(
    `UPDATE encryption_keys
     SET revoked_at = NOW()
     WHERE id = $1 AND key_type = 'member' AND revoked_at IS NULL
     RETURNING id, key_type, member_id, public_key, algorithm, credential_id,
               prf_enabled, key_fingerprint, protection_tier, label,
               created_at, revoked_at, last_used_at`,
    [keyId]
  );
  if (!rows[0]) return null;
  await audit.log('key.revoked', 'encryption_key', keyId, actorId, {
    member_id: rows[0].member_id,
    label: rows[0].label
  });
  return rows[0];
}

async function updateKeyLastUsed(keyId) {
  await pool.query(
    'UPDATE encryption_keys SET last_used_at = NOW() WHERE id = $1',
    [keyId]
  );
}

async function getDocumentKeyInfo(documentId) {
  const { rows } = await pool.query(
    `SELECT id, encryption_metadata, encryption_key_id, encryption_mode, is_encrypted
     FROM documents WHERE id = $1`,
    [documentId]
  );
  if (!rows[0]) return null;
  const doc = rows[0];
  let key = null;
  if (doc.encryption_key_id) {
    const keyResult = await pool.query(
      `SELECT id, key_type, public_key, algorithm, credential_id, prf_enabled,
              key_fingerprint, protection_tier, label, member_id,
              created_at, revoked_at, last_used_at
       FROM encryption_keys WHERE id = $1`,
      [doc.encryption_key_id]
    );
    key = keyResult.rows[0] || null;
  }
  return {
    document_id: doc.id,
    is_encrypted: doc.is_encrypted,
    encryption_mode: doc.encryption_mode,
    encryption_metadata: doc.encryption_metadata,
    encryption_key_id: doc.encryption_key_id,
    key
  };
}

module.exports = {
  listMemberKeys,
  getMemberKey,
  registerMemberKey,
  revokeMemberKey,
  updateKeyLastUsed,
  getDocumentKeyInfo
};
