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

  it('rejects encrypted mode without a supported metadata version', () => {
    assert.throws(
      () => normalizeEncryptionInput({ encryption_mode: 'passphrase', encryption_metadata: { mode: 'passphrase' } }),
      /version must be 1 or 2/
    );
  });

  it('normalizes pki mode with valid envelope', () => {
    const meta = {
      version: 1,
      mode: 'pki',
      files: {
        upload: {
          cipher: 'aes-256-gcm',
          wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' },
          holders: [{ member_id: 1, encryption_key_id: 1, key_fingerprint: 'abcd', role: 'owner' }]
        }
      }
    };
    const out = normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: meta });
    assert.equal(out.is_encrypted, true);
    assert.equal(out.encryption_mode, 'pki');
  });

  it('rejects pki mode without wrapped_dek', () => {
    const meta = { version: 1, mode: 'pki', files: { upload: { holders: [{ member_id: 1 }] } } };
    assert.throws(
      () => normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: meta }),
      /PKI envelope/
    );
  });

  it('rejects pki mode without holders', () => {
    const meta = { version: 1, mode: 'pki', files: { upload: { wrapped_dek: { kind: 'pki_x25519' } } } };
    assert.throws(
      () => normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: meta }),
      /PKI envelope/
    );
  });


  it('normalizes pki mode with holder-local wrapped DEKs', () => {
    const meta = {
      version: 1,
      mode: 'pki',
      policy: { access_model: 'any_one_holder', threshold: 1 },
      files: {
        upload: {
          cipher: 'aes-256-gcm',
          holders: [
            {
              member_id: 1,
              encryption_key_id: 1,
              key_fingerprint: 'abcd',
              role: 'owner',
              wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
            },
            {
              member_id: 1,
              encryption_key_id: 2,
              key_fingerprint: 'efgh',
              role: 'backup',
              wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
            }
          ]
        }
      }
    };
    const out = normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: meta });
    assert.equal(out.encryption_mode, 'pki');
    assert.equal(out.encryption_metadata.files.upload.holders.length, 2);
  });

  it('rejects multi-holder pki mode without holder-local wrapped_dek', () => {
    const meta = {
      version: 1,
      mode: 'pki',
      files: {
        upload: {
          wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' },
          holders: [
            { member_id: 1, encryption_key_id: 1, key_fingerprint: 'abcd', role: 'owner' },
            { member_id: 1, encryption_key_id: 2, key_fingerprint: 'efgh', role: 'backup' }
          ]
        }
      }
    };
    assert.throws(
      () => normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: meta }),
      /holder-local wrapped_dek/
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
