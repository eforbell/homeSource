'use strict';

  (function(exports) {

  function toBufferSource(value, label) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    if (Array.isArray(value)) {
      return Uint8Array.from(value).buffer;
    }
    throw new TypeError(`${label || 'Value'} must be a BufferSource`);
  }

  function base64urlToBuffer(value) {
    const padLength = (4 - (value.length % 4)) % 4;
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLength);
    return fromBase64(base64).buffer;
  }

  function toPublicKeyRequestOptions(optionsJSON) {
    const options = JSON.parse(JSON.stringify(optionsJSON));
    options.challenge = base64urlToBuffer(options.challenge);
    options.allowCredentials = (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id),
    }));
    if (options.extensions?.prf?.evalByCredential) {
      const converted = {};
      for (const [credentialId, value] of Object.entries(options.extensions.prf.evalByCredential)) {
        converted[credentialId] = {};
        if (value.first) converted[credentialId].first = base64urlToBuffer(value.first);
        if (value.second) converted[credentialId].second = base64urlToBuffer(value.second);
      }
      options.extensions = {
        ...options.extensions,
        prf: {
          ...options.extensions.prf,
          evalByCredential: converted,
        },
      };
    }
    return options;
  }

  function parseWrappedPrivateKeyPayload(keyLike) {
    if (!keyLike?.encrypted_private_key) throw new Error('This key is missing wrapped private key material');
    const payload = typeof keyLike.encrypted_private_key === 'string'
      ? JSON.parse(keyLike.encrypted_private_key)
      : keyLike.encrypted_private_key;
    if (!payload?.kind || !payload?.wrapped_private_key_b64) {
      throw new Error('Wrapped private key is malformed');
    }
    return payload;
  }

  // ── Key generation ──

  async function generateMemberKeypair() {
    const keypair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey));
    const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keypair.privateKey));
    return {
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      publicKeyRaw,
      privateKeyPkcs8
    };
  }

  // ── Key fingerprint ──

  async function computeKeyFingerprint(publicKeyRaw) {
    const digest = await crypto.subtle.digest('SHA-256', publicKeyRaw);
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{4}/g).join(':');
  }

  // ── PRF-based key protection ──

  async function deriveKekFromPrf(prfOutput) {
    const keyMaterial = await crypto.subtle.importKey('raw', toBufferSource(prfOutput, 'PRF output'), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('homesource-member-kek-v1') },
      keyMaterial,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );
  }

  // ── Passphrase-based key protection (fallback) ──

  async function deriveKekFromPassphrase(passphrase, salt) {
    if (!salt) salt = crypto.getRandomValues(new Uint8Array(32));
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
      keyMaterial,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );
    return { kek, salt };
  }

  // ── Private key wrapping ──

  async function wrapPrivateKey(privateKey, kek) {
    const wrapped = await crypto.subtle.wrapKey('pkcs8', privateKey, kek, 'AES-KW');
    return new Uint8Array(wrapped);
  }

  async function unwrapPrivateKey(wrappedKeyBytes, kek) {
    return crypto.subtle.unwrapKey(
      'pkcs8', wrappedKeyBytes, kek, 'AES-KW',
      { name: 'X25519' }, false, ['deriveBits']
    );
  }

  // ── Document DEK wrapping (ECIES pattern, single-owner) ──

  async function wrapDekForOwner(dek, ownerPublicKey) {
    const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const salt = crypto.getRandomValues(new Uint8Array(32));

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: ownerPublicKey },
      ephemeral.privateKey,
      256
    );

    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('homesource-dek-wrap-v1') },
      hkdfKey,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey']
    );

    const wrappedDek = new Uint8Array(await crypto.subtle.wrapKey('raw', dek, wrappingKey, 'AES-KW'));
    const ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

    return { wrappedDek, ephemeralPublicKey, salt };
  }

  async function importMemberPublicKey(publicKeyRaw) {
    return crypto.subtle.importKey(
      'raw',
      publicKeyRaw,
      { name: 'X25519' },
      false,
      []
    );
  }

  async function unwrapDekAsOwner(wrappedDekBytes, ephemeralPublicKeyRaw, salt, ownerPrivateKey, extractable) {
    const ephemeralPublicKey = await crypto.subtle.importKey(
      'raw', ephemeralPublicKeyRaw, { name: 'X25519' }, false, []
    );

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: ephemeralPublicKey },
      ownerPrivateKey,
      256
    );

    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('homesource-dek-wrap-v1') },
      hkdfKey,
      { name: 'AES-KW', length: 256 },
      false,
      ['unwrapKey']
    );

    return crypto.subtle.unwrapKey(
      'raw', wrappedDekBytes, wrappingKey, 'AES-KW',
      { name: 'AES-GCM', length: 256 }, extractable === true, ['encrypt', 'decrypt']
    );
  }

  // ── Base64 helpers ──

  function toBase64(uint8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(uint8).toString('base64');
    let binary = '';
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    return btoa(binary);
  }

  function fromBase64(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── BIP39 Recovery Codes ──

  let _bip39Words = null;

  async function loadBip39Wordlist() {
    if (_bip39Words) return _bip39Words;
    // Try fetching from local file first (browser)
    try {
      if (typeof fetch !== 'undefined' && typeof window !== 'undefined') {
        const resp = await fetch('bip39-english.txt');
        if (resp.ok) {
          const text = await resp.text();
          _bip39Words = text.trim().split('\n').map(w => w.trim());
          if (_bip39Words.length === 2048) return _bip39Words;
        }
      }
    } catch (_) { /* fall through */ }
    // Node.js fallback
    try {
      if (typeof require !== 'undefined') {
        const fs = require('fs');
        const path = require('path');
        const text = fs.readFileSync(path.join(__dirname, 'bip39-english.txt'), 'utf8');
        _bip39Words = text.trim().split('\n').map(w => w.trim());
        if (_bip39Words.length === 2048) return _bip39Words;
      }
    } catch (_) { /* fall through */ }
    throw new Error('BIP39 wordlist not available');
  }

  async function generateRecoveryMnemonic() {
    const words = await loadBip39Wordlist();
    const entropy = crypto.getRandomValues(new Uint8Array(16)); // 128 bits
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));

    // Build bit string: entropy bits + first 4 bits of hash (checksum)
    let bits = '';
    for (const byte of entropy) bits += byte.toString(2).padStart(8, '0');
    bits += hash[0].toString(2).padStart(8, '0').slice(0, 4); // 4 checksum bits

    // Split into 12 groups of 11 bits
    const mnemonic = [];
    for (let i = 0; i < 12; i++) {
      const index = parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
      mnemonic.push(words[index]);
    }

    return { mnemonic: mnemonic.join(' '), entropyBytes: entropy };
  }

  async function deriveKekFromMnemonic(mnemonicString) {
    const words = await loadBip39Wordlist();
    const mnemonicWords = mnemonicString.trim().toLowerCase().split(/\s+/);
    if (mnemonicWords.length !== 12) throw new Error('Recovery mnemonic must be 12 words');

    // Convert words back to indices, reconstruct bits
    let bits = '';
    for (const word of mnemonicWords) {
      const index = words.indexOf(word);
      if (index === -1) throw new Error(`Unknown recovery word: "${word}"`);
      bits += index.toString(2).padStart(11, '0');
    }

    // Extract entropy (first 128 bits) and checksum (last 4 bits)
    const entropyBits = bits.slice(0, 128);
    const checksumBits = bits.slice(128, 132);

    // Reconstruct entropy bytes
    const entropy = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      entropy[i] = parseInt(entropyBits.slice(i * 8, (i + 1) * 8), 2);
    }

    // Verify checksum
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));
    const expectedChecksum = hash[0].toString(2).padStart(8, '0').slice(0, 4);
    if (checksumBits !== expectedChecksum) {
      throw new Error('Invalid recovery mnemonic (checksum failed)');
    }

    // Derive KEK from entropy via HKDF
    const keyMaterial = await crypto.subtle.importKey('raw', entropy, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('homesource-recovery-kek-v1') },
      keyMaterial,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );
  }

  // ── Build PKI envelope metadata ──

  function buildPkiEnvelope({ wrappedDek, ephemeralPublicKey, salt, iv, tagLengthBits, memberId, encryptionKeyId, keyFingerprint, encryptedFileMeta, holders }) {
    var normalizedHolders = Array.isArray(holders) && holders.length
      ? holders.map(function (holder) {
          return {
            member_id: holder.memberId,
            encryption_key_id: holder.encryptionKeyId,
            key_fingerprint: holder.keyFingerprint,
            role: holder.role || 'owner',
            wrapped_dek: {
              kind: 'pki_x25519',
              ephemeral_public_key_b64: toBase64(holder.ephemeralPublicKey),
              hkdf_salt_b64: toBase64(holder.salt),
              wrapped_dek_b64: toBase64(holder.wrappedDek)
            }
          };
        })
      : [{
          member_id: memberId,
          encryption_key_id: encryptionKeyId,
          key_fingerprint: keyFingerprint,
          role: 'owner'
        }];

    var envelope = {
      version: 1,
      mode: 'pki',
      policy: { plaintext_metadata: 'minimal', server_plaintext_processing: false, access_model: 'any_one_holder', threshold: 1 },
      files: {
        upload: {
          cipher: 'aes-256-gcm',
          iv_b64: toBase64(iv),
          tag_length_bits: tagLengthBits || 128,
          holders: normalizedHolders
        }
      }
    };
    if (!holders || !holders.length) {
      envelope.files.upload.wrapped_dek = {
        kind: 'pki_x25519',
        ephemeral_public_key_b64: toBase64(ephemeralPublicKey),
        hkdf_salt_b64: toBase64(salt),
        wrapped_dek_b64: toBase64(wrappedDek)
      };
    }
    if (encryptedFileMeta) {
      envelope.files.upload.encrypted_file_meta = encryptedFileMeta;
    }
    return envelope;
  }

  // ── Export ──

  var PKICrypto = {
    generateMemberKeypair: generateMemberKeypair,
    computeKeyFingerprint: computeKeyFingerprint,
    deriveKekFromPrf: deriveKekFromPrf,
    deriveKekFromPassphrase: deriveKekFromPassphrase,
    wrapPrivateKey: wrapPrivateKey,
    unwrapPrivateKey: unwrapPrivateKey,
    importMemberPublicKey: importMemberPublicKey,
    wrapDekForOwner: wrapDekForOwner,
    unwrapDekAsOwner: unwrapDekAsOwner,
    generateRecoveryMnemonic: generateRecoveryMnemonic,
    deriveKekFromMnemonic: deriveKekFromMnemonic,
    buildPkiEnvelope: buildPkiEnvelope,
    toBase64: toBase64,
    fromBase64: fromBase64,
    loadBip39Wordlist: loadBip39Wordlist,
    toBufferSource: toBufferSource,
    base64urlToBuffer: base64urlToBuffer,
    toPublicKeyRequestOptions: toPublicKeyRequestOptions,
    parseWrappedPrivateKeyPayload: parseWrappedPrivateKeyPayload
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PKICrypto;
  } else {
    exports.PKICrypto = PKICrypto;
  }

})(typeof window !== 'undefined' ? window : globalThis);
