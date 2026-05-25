'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PKICrypto = require('../public/pki-crypto');

describe('PKICrypto', () => {

  describe('generateMemberKeypair', () => {
    it('generates X25519 keypair with correct exports', async () => {
      const kp = await PKICrypto.generateMemberKeypair();
      assert.ok(kp.publicKey);
      assert.ok(kp.privateKey);
      assert.equal(kp.publicKeyRaw.length, 32);
      assert.ok(kp.privateKeyPkcs8.length > 0);
    });
  });

  describe('computeKeyFingerprint', () => {
    it('produces deterministic colon-separated hex fingerprint', async () => {
      const kp = await PKICrypto.generateMemberKeypair();
      const fp1 = await PKICrypto.computeKeyFingerprint(kp.publicKeyRaw);
      const fp2 = await PKICrypto.computeKeyFingerprint(kp.publicKeyRaw);
      assert.equal(fp1, fp2);
      assert.match(fp1, /^[0-9a-f]{4}(:[0-9a-f]{4}){15}$/);
    });

    it('different keys produce different fingerprints', async () => {
      const kp1 = await PKICrypto.generateMemberKeypair();
      const kp2 = await PKICrypto.generateMemberKeypair();
      const fp1 = await PKICrypto.computeKeyFingerprint(kp1.publicKeyRaw);
      const fp2 = await PKICrypto.computeKeyFingerprint(kp2.publicKeyRaw);
      assert.notEqual(fp1, fp2);
    });
  });

  describe('PRF-based KEK derivation', () => {
    it('derives a usable KEK from PRF output', async () => {
      const prfOutput = crypto.getRandomValues(new Uint8Array(32));
      const kek = await PKICrypto.deriveKekFromPrf(prfOutput);
      assert.ok(kek);
      assert.equal(kek.algorithm.name, 'AES-KW');
    });

    it('accepts array-shaped PRF output from provider implementations', async () => {
      const prfOutput = Array.from(crypto.getRandomValues(new Uint8Array(32)));
      const kek = await PKICrypto.deriveKekFromPrf(prfOutput);
      assert.ok(kek);
      assert.equal(kek.algorithm.name, 'AES-KW');
    });
  });

  describe('Passphrase-based KEK derivation', () => {
    it('derives KEK and returns salt', async () => {
      const { kek, salt } = await PKICrypto.deriveKekFromPassphrase('test-passphrase');
      assert.ok(kek);
      assert.equal(salt.length, 32);
    });

    it('same passphrase + salt produces equivalent KEK', async () => {
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const r1 = await PKICrypto.deriveKekFromPassphrase('test', salt);
      const r2 = await PKICrypto.deriveKekFromPassphrase('test', salt);
      const testKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      const w1 = await crypto.subtle.wrapKey('raw', testKey, r1.kek, 'AES-KW');
      const w2 = await crypto.subtle.wrapKey('raw', testKey, r2.kek, 'AES-KW');
      assert.deepEqual(new Uint8Array(w1), new Uint8Array(w2));
    });
  });

  describe('Private key wrap/unwrap', () => {
    it('round-trips private key through AES-KW', async () => {
      const kp = await PKICrypto.generateMemberKeypair();
      const prfOutput = crypto.getRandomValues(new Uint8Array(32));
      const kek = await PKICrypto.deriveKekFromPrf(prfOutput);

      const wrapped = await PKICrypto.wrapPrivateKey(kp.privateKey, kek);
      assert.ok(wrapped.length > 0);

      const unwrapped = await PKICrypto.unwrapPrivateKey(wrapped, kek);
      assert.ok(unwrapped);
    });

    it('wrong KEK fails unwrap', async () => {
      const kp = await PKICrypto.generateMemberKeypair();
      const kek1 = await PKICrypto.deriveKekFromPrf(crypto.getRandomValues(new Uint8Array(32)));
      const kek2 = await PKICrypto.deriveKekFromPrf(crypto.getRandomValues(new Uint8Array(32)));

      const wrapped = await PKICrypto.wrapPrivateKey(kp.privateKey, kek1);
      await assert.rejects(() => PKICrypto.unwrapPrivateKey(wrapped, kek2));
    });
  });

  describe('Document DEK wrap/unwrap (ECIES)', () => {
    it('round-trips DEK through ECDH + AES-KW', async () => {
      const owner = await PKICrypto.generateMemberKeypair();
      const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

      const { wrappedDek, ephemeralPublicKey, salt } = await PKICrypto.wrapDekForOwner(dek, owner.publicKey);
      assert.ok(wrappedDek.length > 0);
      assert.equal(ephemeralPublicKey.length, 32);
      assert.equal(salt.length, 32);

      const recovered = await PKICrypto.unwrapDekAsOwner(wrappedDek, ephemeralPublicKey, salt, owner.privateKey);
      assert.ok(recovered);

      const plaintext = new TextEncoder().encode('hello PKI vault');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, plaintext);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, recovered, ciphertext);
      assert.deepEqual(new Uint8Array(decrypted), plaintext);
    });

    it('wrong owner key fails unwrap', async () => {
      const owner = await PKICrypto.generateMemberKeypair();
      const wrongOwner = await PKICrypto.generateMemberKeypair();
      const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);

      const { wrappedDek, ephemeralPublicKey, salt } = await PKICrypto.wrapDekForOwner(dek, owner.publicKey);

      await assert.rejects(() =>
        PKICrypto.unwrapDekAsOwner(wrappedDek, ephemeralPublicKey, salt, wrongOwner.privateKey)
      );
    });
  });

  describe('BIP39 Recovery mnemonic', () => {
    it('generates 12-word mnemonic', async () => {
      const { mnemonic, entropyBytes } = await PKICrypto.generateRecoveryMnemonic();
      const words = mnemonic.split(' ');
      assert.equal(words.length, 12);
      assert.equal(entropyBytes.length, 16);
    });

    it('mnemonic round-trips through KEK derivation and key wrapping', async () => {
      const { mnemonic } = await PKICrypto.generateRecoveryMnemonic();
      const kek = await PKICrypto.deriveKekFromMnemonic(mnemonic);
      assert.ok(kek);

      const kp = await PKICrypto.generateMemberKeypair();
      const wrapped = await PKICrypto.wrapPrivateKey(kp.privateKey, kek);
      const kek2 = await PKICrypto.deriveKekFromMnemonic(mnemonic);
      const unwrapped = await PKICrypto.unwrapPrivateKey(wrapped, kek2);
      assert.ok(unwrapped);
    });

    it('corrupted mnemonic fails validation', async () => {
      const { mnemonic } = await PKICrypto.generateRecoveryMnemonic();
      const words = mnemonic.split(' ');
      words[0] = words[0] === 'abandon' ? 'ability' : 'abandon';
      words[1] = words[1] === 'zoo' ? 'zone' : 'zoo';
      await assert.rejects(
        () => PKICrypto.deriveKekFromMnemonic(words.join(' ')),
        /checksum/
      );
    });

    it('rejects wrong word count', async () => {
      await assert.rejects(
        () => PKICrypto.deriveKekFromMnemonic('abandon ability able'),
        /12 words/
      );
    });

    it('rejects unknown words', async () => {
      await assert.rejects(
        () => PKICrypto.deriveKekFromMnemonic('abandon ability able about above absent absorb abstract absurd abuse access notaword'),
        /Unknown recovery word/
      );
    });
  });

  describe('buildPkiEnvelope', () => {
    it('builds valid envelope structure', () => {
      const envelope = PKICrypto.buildPkiEnvelope({
        wrappedDek: new Uint8Array([1, 2, 3]),
        ephemeralPublicKey: new Uint8Array(32),
        salt: new Uint8Array(32),
        iv: new Uint8Array(12),
        memberId: 1,
        encryptionKeyId: 42,
        keyFingerprint: 'a1b2:c3d4'
      });
      assert.equal(envelope.version, 1);
      assert.equal(envelope.mode, 'pki');
      assert.equal(envelope.files.upload.cipher, 'aes-256-gcm');
      assert.equal(envelope.files.upload.wrapped_dek.kind, 'pki_x25519');
      assert.equal(envelope.files.upload.holders.length, 1);
      assert.equal(envelope.files.upload.holders[0].role, 'owner');
      assert.equal(envelope.files.upload.holders[0].member_id, 1);
    });
  });

  describe('Base64 helpers', () => {
    it('round-trips arbitrary data', () => {
      const data = crypto.getRandomValues(new Uint8Array(64));
      const b64 = PKICrypto.toBase64(data);
      const decoded = PKICrypto.fromBase64(b64);
      assert.deepEqual(decoded, data);
    });

    it('handles empty input', () => {
      const b64 = PKICrypto.toBase64(new Uint8Array(0));
      const decoded = PKICrypto.fromBase64(b64);
      assert.equal(decoded.length, 0);
    });
  });

  describe('Full pipeline: register → encrypt → decrypt', () => {
    it('completes end-to-end PKI encryption cycle', async () => {
      const member = await PKICrypto.generateMemberKeypair();

      const { kek, salt: kekSalt } = await PKICrypto.deriveKekFromPassphrase('my-secure-passphrase');
      const wrappedPrivateKey = await PKICrypto.wrapPrivateKey(member.privateKey, kek);

      const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const plaintext = new TextEncoder().encode('Top secret family document');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, plaintext));

      const wrapped = await PKICrypto.wrapDekForOwner(dek, member.publicKey);

      const envelope = PKICrypto.buildPkiEnvelope({
        ...wrapped,
        iv,
        memberId: 1,
        encryptionKeyId: 42,
        keyFingerprint: await PKICrypto.computeKeyFingerprint(member.publicKeyRaw)
      });

      // --- Decrypt ---

      const { kek: kek2 } = await PKICrypto.deriveKekFromPassphrase('my-secure-passphrase', kekSalt);
      const privateKey = await PKICrypto.unwrapPrivateKey(wrappedPrivateKey, kek2);

      const file = envelope.files.upload;
      const recoveredDek = await PKICrypto.unwrapDekAsOwner(
        PKICrypto.fromBase64(file.wrapped_dek.wrapped_dek_b64),
        PKICrypto.fromBase64(file.wrapped_dek.ephemeral_public_key_b64),
        PKICrypto.fromBase64(file.wrapped_dek.hkdf_salt_b64),
        privateKey
      );

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: PKICrypto.fromBase64(file.iv_b64) },
        recoveredDek,
        ciphertext
      );

      assert.deepEqual(new Uint8Array(decrypted), plaintext);
    });
  });
});
