'use strict';

const { pool } = require('./db');
const { createHash } = require('crypto');
const audit = require('./audit');

function computeFingerprint(publicKeyBase64) {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  const hash = createHash('sha256').update(raw).digest('hex');
  return hash.match(/.{4}/g).join(':');
}

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
    `SELECT id, key_type, public_key, algorithm,
            credential_id, prf_enabled, key_fingerprint, protection_tier,
            label, member_id, created_at, revoked_at, last_used_at
     FROM encryption_keys
     WHERE id = $1 AND member_id = $2 AND key_type = 'member'`,
    [keyId, memberId]
  );
  return rows[0] || null;
}

async function registerMemberKey({ memberId, publicKey, encryptedPrivateKey, algorithm, credentialId, prfEnabled, protectionTier, label }) {
  const keyFingerprint = computeFingerprint(publicKey);
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

async function revokeMemberKey(keyId, memberId, actorId) {
  const { rows } = await pool.query(
    `UPDATE encryption_keys
     SET revoked_at = NOW()
     WHERE id = $1 AND member_id = $2 AND key_type = 'member' AND revoked_at IS NULL
     RETURNING id, key_type, member_id, public_key, algorithm, credential_id,
               prf_enabled, key_fingerprint, protection_tier, label,
               created_at, revoked_at, last_used_at`,
    [keyId, memberId]
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

async function validatePkiUpload(envelope, uploadingMemberId) {
  const fileKeys = Object.keys(envelope.files || {});
  for (const fileKey of fileKeys) {
    const entry = envelope.files[fileKey];
    if (!Array.isArray(entry.holders) || entry.holders.length === 0) {
      throw new Error('PKI envelope requires at least one holder');
    }
    for (const holder of entry.holders) {
      if (!holder.encryption_key_id) {
        throw new Error('PKI holder must specify encryption_key_id');
      }
      const key = await pool.query(
        `SELECT id, member_id, key_fingerprint, revoked_at
         FROM encryption_keys
         WHERE id = $1 AND key_type = 'member'`,
        [holder.encryption_key_id]
      );
      const row = key.rows[0];
      if (!row) {
        throw new Error(`Encryption key ${holder.encryption_key_id} not found`);
      }
      if (row.revoked_at) {
        throw new Error(`Encryption key ${holder.encryption_key_id} has been revoked`);
      }
      if (holder.member_id && row.member_id !== holder.member_id) {
        throw new Error(`Encryption key ${holder.encryption_key_id} does not belong to declared member`);
      }
      if (holder.key_fingerprint && row.key_fingerprint !== holder.key_fingerprint) {
        throw new Error(`Key fingerprint mismatch for encryption key ${holder.encryption_key_id}`);
      }
    }
  }
  const primaryHolder = envelope.files[fileKeys[0]].holders[0];
  return primaryHolder.encryption_key_id;
}

module.exports = {
  computeFingerprint,
  listMemberKeys,
  getMemberKey,
  registerMemberKey,
  revokeMemberKey,
  updateKeyLastUsed,
  getDocumentKeyInfo,
  validatePkiUpload
};
