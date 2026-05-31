'use strict';

(function (exports) {
  const PBKDF2_ITERATIONS = 600000;
  const ARGON2ID_PARAMS = { memory_kib: 65536, iterations: 3, parallelism: 1, hash_len: 32 };

  const ARGON2_CDN_URL = 'https://cdn.jsdelivr.net/npm/argon2-browser@1.18.0/dist/argon2-bundled.min.js';
  const ARGON2_SRI = 'sha384-XOR3aNvHciLPIf6r+2glkrmbBbLmIJ1EChMXjw8eBKBf8gE0rDq1TyUNuRdorOqi';

  function toBase64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < arr.length; i += chunk) {
      binary += String.fromCharCode(...arr.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fromUtf8(text) {
    return new TextEncoder().encode(String(text || ''));
  }

  function bytesToUtf8(bytes) {
    return new TextDecoder().decode(bytes);
  }

  let _argon2LoadPromise = null;

  function argon2Available() {
    return !!(window.argon2 && typeof window.argon2.hash === 'function');
  }

  function loadArgon2() {
    if (argon2Available()) return Promise.resolve();
    if (_argon2LoadPromise) return _argon2LoadPromise;
    _argon2LoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ARGON2_CDN_URL;
      script.integrity = ARGON2_SRI;
      script.crossOrigin = 'anonymous';
      script.onload = () => {
        if (argon2Available()) resolve();
        else reject(new Error('Argon2 script loaded but argon2.hash is not available'));
      };
      script.onerror = () => {
        _argon2LoadPromise = null;
        reject(new Error('Failed to load Argon2 library'));
      };
      document.head.appendChild(script);
    });
    return _argon2LoadPromise;
  }

  async function derivePbkdf2Key(passphrase, salt, params, usages) {
    const iterations = Number((params && params.iterations) || PBKDF2_ITERATIONS);
    const hash = String((params && params.hash) || 'SHA-256');
    const extractable = !!(usages && usages.includes('encrypt'));
    const passKey = await crypto.subtle.importKey('raw', fromUtf8(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iterations, hash: hash },
      passKey,
      { name: 'AES-GCM', length: 256 },
      extractable,
      usages || ['decrypt']
    );
  }

  async function deriveArgon2idKey(passphrase, salt, params, usages) {
    if (!argon2Available()) {
      await loadArgon2();
    }
    if (!argon2Available()) {
      throw new Error('Argon2id is unavailable in this browser');
    }
    const memory_kib = Number((params && params.memory_kib) || ARGON2ID_PARAMS.memory_kib);
    const iterations = Number((params && params.iterations) || ARGON2ID_PARAMS.iterations);
    const parallelism = Number((params && params.parallelism) || ARGON2ID_PARAMS.parallelism);
    const hash_len = Number((params && params.hash_len) || ARGON2ID_PARAMS.hash_len);
    const extractable = !!(usages && usages.includes('encrypt'));
    const result = await window.argon2.hash({
      pass: passphrase,
      salt: salt,
      time: iterations,
      mem: memory_kib,
      parallelism: parallelism,
      hashLen: hash_len,
      type: window.argon2.ArgonType.Argon2id
    });
    const raw = result.hash instanceof Uint8Array ? result.hash : new Uint8Array(result.hash);
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, extractable, usages || ['decrypt']);
  }

  exports.CryptoHelpers = {
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    ARGON2ID_PARAMS: ARGON2ID_PARAMS,
    toBase64: toBase64,
    fromBase64: fromBase64,
    fromUtf8: fromUtf8,
    bytesToUtf8: bytesToUtf8,
    derivePbkdf2Key: derivePbkdf2Key,
    deriveArgon2idKey: deriveArgon2idKey,
    loadArgon2: loadArgon2,
    argon2Available: argon2Available
  };
})(typeof window !== 'undefined' ? window : global);
