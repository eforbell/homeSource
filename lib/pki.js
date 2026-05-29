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
            key_fingerprint, protection_tier, label, credential_verified,
            verification_method, credential_transports, credential_device_type,
            credential_backed_up, credential_attachment, verified_at,
            recovery_wrapped_private_key IS NOT NULL AS recovery_enabled,
            created_at, last_used_at
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
            label, member_id, credential_verified, verification_method,
            credential_transports, credential_device_type, credential_backed_up,
            credential_attachment, verified_at,
            recovery_wrapped_private_key IS NOT NULL AS recovery_enabled,
            created_at, revoked_at, last_used_at
     FROM encryption_keys
     WHERE id = $1 AND member_id = $2 AND key_type = 'member'`,
    [keyId, memberId]
  );
  return rows[0] || null;
}

async function getMemberKeyMaterial(keyId, memberId) {
  const { rows } = await pool.query(
    `SELECT id, key_type, public_key, encrypted_private_key, algorithm,
            credential_id, prf_enabled, key_fingerprint, protection_tier,
            label, member_id, credential_verified, verification_method,
            credential_transports, credential_device_type, credential_backed_up,
            credential_attachment, verified_at,
            recovery_wrapped_private_key IS NOT NULL AS recovery_enabled,
            created_at, revoked_at, last_used_at
     FROM encryption_keys
     WHERE id = $1 AND member_id = $2 AND key_type = 'member' AND revoked_at IS NULL`,
    [keyId, memberId]
  );
  return rows[0] || null;
}

async function registerMemberKey({
  memberId,
  publicKey,
  encryptedPrivateKey,
  algorithm,
  credentialId,
  prfEnabled,
  protectionTier,
  label,
  credentialVerified = false,
  verificationMethod = 'manual',
  credentialTransports = [],
  credentialDeviceType = null,
  credentialBackedUp = null,
  credentialAttachment = null,
  verifiedAt = null,
}) {
  const keyFingerprint = computeFingerprint(publicKey);
  const { rows } = await pool.query(
    `INSERT INTO encryption_keys
       (key_type, member_id, public_key, encrypted_private_key, algorithm,
        credential_id, prf_enabled, key_fingerprint, protection_tier, label,
        credential_verified, verification_method, credential_transports,
        credential_device_type, credential_backed_up, credential_attachment, verified_at)
     VALUES ('member', $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16)
     RETURNING id, key_type, member_id, public_key, algorithm, credential_id,
               prf_enabled, key_fingerprint, protection_tier, label,
               credential_verified, verification_method, credential_transports,
               credential_device_type, credential_backed_up, credential_attachment,
               verified_at, recovery_wrapped_private_key IS NOT NULL AS recovery_enabled,
               created_at, revoked_at, last_used_at`,
    [
      memberId,
      publicKey,
      encryptedPrivateKey,
      algorithm,
      credentialId,
      prfEnabled,
      keyFingerprint,
      protectionTier,
      label,
      credentialVerified,
      verificationMethod,
      JSON.stringify(Array.isArray(credentialTransports) ? credentialTransports : []),
      credentialDeviceType,
      credentialBackedUp,
      credentialAttachment,
      verifiedAt,
    ]
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
  const envelope = doc.encryption_metadata || {};
  const fileEntries = Object.values(envelope.files || {});
  const primaryEntry = fileEntries[0] || null;
  const envelopeHolders = Array.isArray(primaryEntry?.holders) ? primaryEntry.holders : [];
  const holderKeyIds = [...new Set(envelopeHolders.map((holder) => Number(holder.encryption_key_id)).filter(Boolean))];

  let keysById = new Map();
  if (holderKeyIds.length) {
    const keyResult = await pool.query(
      `SELECT id, key_type, public_key, algorithm, credential_id, prf_enabled,
              key_fingerprint, protection_tier, label, member_id,
              credential_verified, verification_method, credential_transports,
              credential_device_type, credential_backed_up, credential_attachment,
              verified_at, created_at, revoked_at, last_used_at
       FROM encryption_keys
       WHERE id = ANY($1::int[])`,
      [holderKeyIds]
    );
    keysById = new Map(keyResult.rows.map((row) => [Number(row.id), row]));
  } else if (doc.encryption_key_id) {
    const keyResult = await pool.query(
      `SELECT id, key_type, public_key, algorithm, credential_id, prf_enabled,
              key_fingerprint, protection_tier, label, member_id,
              credential_verified, verification_method, credential_transports,
              credential_device_type, credential_backed_up, credential_attachment,
              verified_at, created_at, revoked_at, last_used_at
       FROM encryption_keys WHERE id = $1`,
      [doc.encryption_key_id]
    );
    if (keyResult.rows[0]) keysById.set(Number(keyResult.rows[0].id), keyResult.rows[0]);
  }

  const holders = envelopeHolders.map((holder, index) => {
    const key = keysById.get(Number(holder.encryption_key_id)) || null;
    return {
      member_id: holder.member_id,
      encryption_key_id: holder.encryption_key_id,
      role: holder.role || (index === 0 ? 'owner' : 'backup'),
      key_fingerprint: holder.key_fingerprint,
      label: key?.label || null,
      protection_tier: key?.protection_tier || null,
      verification_method: key?.verification_method || null,
      credential_verified: key?.credential_verified || false,
      credential_id: key?.credential_id || null,
      revoked_at: key?.revoked_at || null
    };
  });

  const key = doc.encryption_key_id ? (keysById.get(Number(doc.encryption_key_id)) || null) : null;
  const primaryKey = key || (holders.length ? keysById.get(Number(holders[0].encryption_key_id)) || null : null);

  return {
    document_id: doc.id,
    is_encrypted: doc.is_encrypted,
    encryption_mode: doc.encryption_mode,
    encryption_metadata: doc.encryption_metadata,
    encryption_key_id: doc.encryption_key_id,
    key,
    primary_key: primaryKey,
    holders
  };
}

async function saveRecoveryWrap(keyId, memberId, recoveryWrappedPrivateKey, recoveryType = 'mnemonic_bip39') {
  const { rows } = await pool.query(
    `UPDATE encryption_keys
     SET recovery_wrapped_private_key = $3,
         recovery_type = $4
     WHERE id = $1 AND member_id = $2 AND key_type = 'member' AND revoked_at IS NULL
     RETURNING id, key_type, member_id, public_key, algorithm, credential_id,
               prf_enabled, key_fingerprint, protection_tier, label,
               credential_verified, verification_method, credential_transports,
               credential_device_type, credential_backed_up, credential_attachment,
               verified_at, recovery_wrapped_private_key IS NOT NULL AS recovery_enabled,
               created_at, revoked_at, last_used_at`,
    [keyId, memberId, recoveryWrappedPrivateKey, recoveryType]
  );
  return rows[0] || null;
}

async function validatePkiUpload(envelope, uploadingMemberId) {
  const fileKeys = Object.keys(envelope.files || {});
  let validatedKeyId = null;
  const { rows: memberRows } = await pool.query(
    'SELECT role FROM family_members WHERE id = $1',
    [uploadingMemberId]
  );
  const uploadingMemberRole = memberRows[0]?.role || null;

  for (const fileKey of fileKeys) {
    const entry = envelope.files[fileKey];
    if (!Array.isArray(entry.holders) || entry.holders.length === 0) {
      throw new Error('PKI uploads require at least one holder per file');
    }

    const seenKeyIds = new Set();
    let foundCrossMemberHolder = false;

    for (let index = 0; index < entry.holders.length; index += 1) {
      const holder = entry.holders[index];
      const role = holder.role || (index === 0 ? 'owner' : 'backup');
      if (!['owner', 'backup', 'beneficiary'].includes(role)) {
        throw new Error(`PKI holder role ${role} is not allowed`);
      }
      if (!holder.encryption_key_id) {
        throw new Error('PKI holder must specify encryption_key_id');
      }
      if (seenKeyIds.has(Number(holder.encryption_key_id))) {
        throw new Error('PKI upload contains duplicate holder encryption_key_id values');
      }
      seenKeyIds.add(Number(holder.encryption_key_id));
      if (!holder.member_id) {
        throw new Error('PKI holder must specify member_id');
      }
      if (!holder.key_fingerprint) {
        throw new Error('PKI holder must specify key_fingerprint');
      }
      if (entry.holders.length > 1 && (!holder.wrapped_dek || holder.wrapped_dek.kind !== 'pki_x25519')) {
        throw new Error('Multi-holder PKI uploads require holder-local wrapped_dek metadata for every holder');
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
      if (row.member_id !== Number(holder.member_id)) {
        throw new Error(`Encryption key ${holder.encryption_key_id} does not belong to declared member`);
      }
      if (row.key_fingerprint !== holder.key_fingerprint) {
        throw new Error(`Key fingerprint mismatch for encryption key ${holder.encryption_key_id}`);
      }
      if (Number(holder.member_id) !== uploadingMemberId) {
        foundCrossMemberHolder = true;
      }
      if (role === 'backup' && Number(holder.member_id) !== uploadingMemberId) {
        throw new Error('PKI backup holders must belong to the uploading member');
      }
      if (role === 'beneficiary' && Number(holder.member_id) === uploadingMemberId) {
        throw new Error('PKI beneficiary holders must belong to a different member');
      }
      if (index === 0) {
        if (Number(holder.member_id) !== uploadingMemberId) {
          throw new Error('The primary PKI holder must belong to the uploading member');
        }
        validatedKeyId = row.id;
      }
    }

    if (foundCrossMemberHolder && uploadingMemberRole !== 'parent') {
      throw new Error('Only parent members may assign cross-member PKI holders');
    }
  }
  return validatedKeyId;
}

module.exports = {
  computeFingerprint,
  listMemberKeys,
  getMemberKey,
  getMemberKeyMaterial,
  registerMemberKey,
  revokeMemberKey,
  updateKeyLastUsed,
  getDocumentKeyInfo,
  saveRecoveryWrap,
  validatePkiUpload
};
