'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEncryptionInput, isEncryptedDocument } = require('../lib/encryption-mode');

describe('normalizeEncryptionInput', () => {
  it('defaults to plaintext mode', () => {
    const out = normalizeEncryptionInput({});
    assert.equal(out.is_encrypted, false);
    assert.equal(out.encryption_mode, 'plaintext');
    assert.deepEqual(out.encryption_metadata, {});
  });

  it('normalizes passphrase mode and preserves metadata', () => {
    const meta = { version: 1, mode: 'passphrase' };
    const out = normalizeEncryptionInput({ encryption_mode: 'passphrase', encryption_metadata: meta });
    assert.equal(out.is_encrypted, true);
    assert.equal(out.encryption_mode, 'passphrase');
    assert.deepEqual(out.encryption_metadata, meta);
  });

  it('rejects invalid encryption mode', () => {
    assert.throws(
      () => normalizeEncryptionInput({ encryption_mode: 'unknown' }),
      /Invalid encryption_mode/
    );
  });

  it('rejects mismatched mode between encryption_mode and metadata.mode', () => {
    assert.throws(
      () => normalizeEncryptionInput({ encryption_mode: 'timelock', encryption_metadata: { mode: 'passphrase' } }),
      /must match/
    );
  });
});

describe('isEncryptedDocument', () => {
  it('detects encrypted docs from boolean or mode', () => {
    assert.equal(isEncryptedDocument({ is_encrypted: true }), true);
    assert.equal(isEncryptedDocument({ encryption_mode: 'passphrase' }), true);
    assert.equal(isEncryptedDocument({ is_encrypted: false, encryption_mode: 'plaintext' }), false);
  });
});
