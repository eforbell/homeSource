// Operator-side ceremonies, each mirroring the request bodies of the page named in its comment
// and using the shipped browser crypto (public/pki-crypto.js) rather than a reimplementation.
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO, rememberSecret } from './env.mjs';

const require = createRequire(path.join(REPO, 'public', 'pki-crypto.js'));
export const PKICrypto = require('./pki-crypto.js');
const { toBase64, fromBase64 } = PKICrypto;

async function exportDekB64(dek) {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', dek)));
}

// public/settings.js preparePassphraseRegistration + saveRegisteredKey (passphrase fallback).
export async function registerPassphraseKey(session, passphrase, label) {
  const keypair = await PKICrypto.generateMemberKeypair();
  const { kek, salt } = await PKICrypto.deriveKekFromPassphrase(passphrase);
  const wrappedPrivateKey = await PKICrypto.wrapPrivateKey(keypair.privateKey, kek);
  const localFingerprint = await PKICrypto.computeKeyFingerprint(keypair.publicKeyRaw);
  const key = await session.post(`api/members/${session.member.id}/keys`, {
    public_key: toBase64(keypair.publicKeyRaw),
    encrypted_private_key: JSON.stringify({
      kind: 'passphrase_pbkdf2_v1', kdf: 'pbkdf2-sha256', iterations: 600000,
      salt_b64: toBase64(salt), wrapped_private_key_b64: toBase64(wrappedPrivateKey)
    }),
    algorithm: 'x25519', credential_id: null, prf_enabled: false, protection_tier: 'passphrase', label
  });
  rememberSecret(toBase64(keypair.privateKeyPkcs8));
  return { key, localFingerprint, privateKey: keypair.privateKey, privateKeyPkcs8: keypair.privateKeyPkcs8 };
}

// public/settings.js "Test key": fetch wrapped material, unlock locally, record the test.
export async function testKeyUnlock(session, keyId, passphrase) {
  const material = await session.get(`api/members/${session.member.id}/keys/${keyId}/material`);
  const wrapped = PKICrypto.parseWrappedPrivateKeyPayload(material);
  const { kek } = await PKICrypto.deriveKekFromPassphrase(passphrase, fromBase64(wrapped.salt_b64));
  await PKICrypto.unwrapPrivateKey(fromBase64(wrapped.wrapped_private_key_b64), kek);
  await session.post(`api/members/${session.member.id}/keys/${keyId}/tested`, {});
  return true;
}

// public/settings.js recovery-code step.
export async function enableRecoveryWords(session, keyId, privateKey) {
  const { mnemonic } = await PKICrypto.generateRecoveryMnemonic();
  const recoveryKek = await PKICrypto.deriveKekFromMnemonic(mnemonic);
  const wrappedPrivateKey = await PKICrypto.wrapPrivateKey(privateKey, recoveryKek);
  await session.post(`api/members/${session.member.id}/keys/${keyId}/recovery`, {
    recovery_wrapped_private_key: JSON.stringify({ kind: 'recovery_mnemonic_v1', wrapped_private_key_b64: toBase64(wrappedPrivateKey) }),
    recovery_type: 'mnemonic_bip39'
  });
  rememberSecret(mnemonic);
  return mnemonic;
}

// public/upload.html plaintext upload.
export function uploadPlain(session, { title, documentType, filename, mime, bytes, issued, expiry, description }) {
  return session.upload('api/documents', { filename, mime, bytes }, {
    title, description, document_type: documentType, issued_date: issued, expiry_date: expiry,
    magicindex_enabled: false, source_type: 'upload'
  });
}

// public/upload.html encryptSelectedFileWithPki: the owner key is the only holder at upload.
export async function uploadPki(session, ownerKey, passphrase, { title, documentType, filename, mime, bytes }) {
  const material = await session.get(`api/members/${session.member.id}/keys/${ownerKey.id}/material`);
  const wrapped = PKICrypto.parseWrappedPrivateKeyPayload(material);
  const { kek } = await PKICrypto.deriveKekFromPassphrase(passphrase, fromBase64(wrapped.salt_b64));
  await PKICrypto.unwrapPrivateKey(fromBase64(wrapped.wrapped_private_key_b64), kek);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: contentIv, tagLength: 128 }, dek, bytes));
  const metaIv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedMeta = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: metaIv, tagLength: 128 }, dek,
    new TextEncoder().encode(JSON.stringify({ original_filename: filename, mime_type: mime }))));
  const publicKey = await PKICrypto.importMemberPublicKey(fromBase64(ownerKey.public_key));
  const wrappedDek = await PKICrypto.wrapDekForOwner(dek, publicKey);
  const metadata = PKICrypto.buildPkiEnvelope({
    iv: contentIv,
    holders: [{
      memberId: session.member.id, encryptionKeyId: ownerKey.id, keyFingerprint: ownerKey.key_fingerprint, role: 'owner',
      wrappedDek: wrappedDek.wrappedDek, ephemeralPublicKey: wrappedDek.ephemeralPublicKey, salt: wrappedDek.salt
    }],
    encryptedFileMeta: { iv_b64: toBase64(metaIv), payload_b64: toBase64(encryptedMeta) }
  });
  const doc = await session.upload('api/documents',
    { filename: `${crypto.randomUUID()}.enc`, mime: 'application/octet-stream', bytes: ciphertext },
    { title, document_type: documentType, magicindex_enabled: false, source_type: 'upload', encryption_mode: 'pki', encryption_metadata: metadata });
  const dekB64 = rememberSecret(await exportDekB64(dek));
  return { doc, dekB64 };
}

// public/document.html submitSealDesignation -> buildExtendedEnvelopeWithHolder(sealed: true).
export async function sealDesignation(session, { documentId, ownerKey, passphrase, targetKey, memberId = null, trusteeId = null }) {
  const doc = await session.get(`api/documents/${documentId}`);
  const keyInfo = await session.get(`api/documents/${documentId}/key-info`);
  const entry = doc.encryption_metadata.files.upload;
  const current = entry.holders.find((holder) => Number(holder.encryption_key_id) === Number(ownerKey.id) && holder.sealed !== true);
  if (!current) throw new Error(`owner key ${ownerKey.id} is not an unsealed holder of document ${documentId}`);
  const holderWrappedDek = current.wrapped_dek || entry.wrapped_dek;
  const material = await session.get(`api/members/${session.member.id}/keys/${ownerKey.id}/material`);
  const wrapped = PKICrypto.parseWrappedPrivateKeyPayload(material);
  const { kek } = await PKICrypto.deriveKekFromPassphrase(passphrase, fromBase64(wrapped.salt_b64));
  const privateKey = await PKICrypto.unwrapPrivateKey(fromBase64(wrapped.wrapped_private_key_b64), kek);
  const dek = await PKICrypto.unwrapDekAsOwner(fromBase64(holderWrappedDek.wrapped_dek_b64),
    fromBase64(holderWrappedDek.ephemeral_public_key_b64), fromBase64(holderWrappedDek.hkdf_salt_b64), privateKey, true);
  const publicKey = await PKICrypto.importMemberPublicKey(fromBase64(targetKey.public_key));
  const wrappedDek = await PKICrypto.wrapDekForOwner(dek, publicKey);
  const infoHolders = Array.isArray(keyInfo?.holders) ? keyInfo.holders : [];
  const holders = entry.holders.map((holder, index) => {
    const info = infoHolders.find((candidate) => String(candidate.encryption_key_id) === String(holder.encryption_key_id));
    return {
      member_id: holder.member_id,
      ...(holder.trustee_id ? { trustee_id: holder.trustee_id } : {}),
      encryption_key_id: holder.encryption_key_id,
      key_fingerprint: holder.key_fingerprint,
      role: holder.role || info?.role || (index === 0 ? 'owner' : 'backup'),
      ...(holder.sealed === true ? { sealed: true, sealed_until: holder.sealed_until || 'deadman_trigger' } : {}),
      wrapped_dek: holder.wrapped_dek || entry.wrapped_dek
    };
  });
  holders.push({
    ...(memberId ? { member_id: memberId } : {}),
    ...(trusteeId ? { trustee_id: trusteeId } : {}),
    encryption_key_id: targetKey.id,
    key_fingerprint: targetKey.key_fingerprint,
    role: trusteeId ? 'trustee' : 'beneficiary',
    sealed: true, sealed_until: 'deadman_trigger',
    wrapped_dek: {
      kind: 'pki_x25519',
      ephemeral_public_key_b64: toBase64(wrappedDek.ephemeralPublicKey),
      hkdf_salt_b64: toBase64(wrappedDek.salt),
      wrapped_dek_b64: toBase64(wrappedDek.wrappedDek)
    }
  });
  const policy = doc.encryption_metadata.policy || {};
  const encryptionMetadata = {
    version: 2, mode: 'pki',
    policy: {
      plaintext_metadata: policy.plaintext_metadata || 'minimal',
      server_plaintext_processing: policy.server_plaintext_processing === true,
      access_model: policy.access_model || 'any_one_holder',
      threshold: Number(policy.threshold || 1)
    },
    files: {
      upload: {
        cipher: entry.cipher || 'aes-256-gcm', iv_b64: entry.iv_b64, tag_length_bits: Number(entry.tag_length_bits || 128),
        holders, ...(entry.encrypted_file_meta ? { encrypted_file_meta: entry.encrypted_file_meta } : {})
      }
    }
  };
  return session.post(`api/documents/${documentId}/designations/seal`, { encryption_metadata: encryptionMetadata });
}

// public/document.html PKI unlock: a holder decrypts its own document locally.
export async function decryptAsMember(session, documentId, key, passphrase) {
  const doc = await session.get(`api/documents/${documentId}`);
  const entry = doc.encryption_metadata.files.upload;
  const holder = entry.holders.find((candidate) => Number(candidate.encryption_key_id) === Number(key.id));
  const material = await session.get(`api/members/${session.member.id}/keys/${key.id}/material`);
  const wrapped = PKICrypto.parseWrappedPrivateKeyPayload(material);
  const { kek } = await PKICrypto.deriveKekFromPassphrase(passphrase, fromBase64(wrapped.salt_b64));
  const privateKey = await PKICrypto.unwrapPrivateKey(fromBase64(wrapped.wrapped_private_key_b64), kek);
  const w = holder.wrapped_dek || entry.wrapped_dek;
  const dek = await PKICrypto.unwrapDekAsOwner(fromBase64(w.wrapped_dek_b64), fromBase64(w.ephemeral_public_key_b64), fromBase64(w.hkdf_salt_b64), privateKey);
  const original = doc.files.find((file) => file.file_type === 'original');
  const res = await session.raw('GET', `api/documents/${documentId}/files/${original.id}/download`);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(entry.iv_b64), tagLength: 128 }, dek, res.buffer));
}
