'use strict';

// Proof that a browser holds a member key's private key, before Home Source lets it re-protect that key
// (move it to a new security key or passkey). The server can't read the new wrap it is sent, so without this
// a buggy page or a borrowed session could replace a working wrap with one that opens nothing.
//
// The challenge is a random secret wrapped to the key's public key exactly as a document key is (ECIES over
// X25519, public/pki-crypto.js). Only the private key unwraps it; the browser answers with the secret. Each
// challenge is single-use, lasts ten minutes, and a new one for the same key replaces the old. They live in
// memory: Home Source is one process, and a restart only means starting again.

const crypto = require('crypto');
const PKICrypto = require('../public/pki-crypto');

const TTL_MS = 10 * 60 * 1000;
const pending = new Map();

const slot = (memberId, keyId) => `${Number(memberId)}:${Number(keyId)}`;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest();

function sweep(now) {
  for (const [key, entry] of pending) if (entry.expiresAt <= now) pending.delete(key);
}

async function issue(memberId, keyId, publicKeyB64, { now = Date.now() } = {}) {
  sweep(now);
  const secret = crypto.randomBytes(32);
  const dek = await crypto.webcrypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const publicKey = await PKICrypto.importMemberPublicKey(PKICrypto.fromBase64(publicKeyB64));
  const { wrappedDek, ephemeralPublicKey, salt } = await PKICrypto.wrapDekForOwner(dek, publicKey);
  pending.set(slot(memberId, keyId), { digest: digest(secret), expiresAt: now + TTL_MS });
  return {
    kind: 'pki_x25519',
    ephemeral_public_key_b64: PKICrypto.toBase64(ephemeralPublicKey),
    hkdf_salt_b64: PKICrypto.toBase64(salt),
    wrapped_dek_b64: PKICrypto.toBase64(wrappedDek),
    expires_at: new Date(now + TTL_MS).toISOString(),
  };
}

// Consumes the challenge whatever the answer, so a wrong answer can't be retried against it.
function consume(memberId, keyId, proofB64, { now = Date.now() } = {}) {
  const key = slot(memberId, keyId);
  const entry = pending.get(key);
  pending.delete(key);
  if (!entry || entry.expiresAt <= now) {
    throw new Error('No key check is in progress for this key. Start again.');
  }
  const proof = typeof proofB64 === 'string' ? Buffer.from(proofB64, 'base64') : Buffer.alloc(0);
  if (proof.length !== 32 || !crypto.timingSafeEqual(digest(proof), entry.digest)) {
    throw new Error('The recovery words did not unlock this key. Start again.');
  }
}

module.exports = { issue, consume, _pending: pending };
