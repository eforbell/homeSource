'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, getPool, resetDatabase, createMember } = require('./helpers');

let pool;
let parent;

function encodePublicKey(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

before(async () => {
  await startServer();
  pool = getPool();
});

after(async () => {
  await stopServer();
});

beforeEach(async () => {
  await resetDatabase();
  parent = await createMember('Alice', 'parent', 'pass123');
});

describe('PKI key management', () => {

  describe('registerMemberKey', () => {
    it('registers a key with correct fields', async () => {
      const pki = require('../lib/pki');
      const publicKey = encodePublicKey('pub-key-data');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey,
        encryptedPrivateKey: 'enc-priv-key-data',
        algorithm: 'x25519',
        credentialId: 'cred-123',
        prfEnabled: true,
        protectionTier: 'hardware',
        label: 'YubiKey 5'
      });

      assert.ok(key.id);
      assert.equal(key.key_type, 'member');
      assert.equal(key.member_id, parent.id);
      assert.equal(key.public_key, publicKey);
      assert.equal(key.algorithm, 'x25519');
      assert.equal(key.credential_id, 'cred-123');
      assert.equal(key.prf_enabled, true);
      assert.equal(key.key_fingerprint, pki.computeFingerprint(publicKey));
      assert.equal(key.protection_tier, 'hardware');
      assert.equal(key.label, 'YubiKey 5');
      assert.ok(key.created_at);
      assert.equal(key.revoked_at, null);
      assert.equal(key.last_used_at, null);
    });
  });

  describe('listMemberKeys', () => {
    it('returns only non-revoked keys for the member', async () => {
      const pki = require('../lib/pki');
      const kid = await createMember('Bob', 'kid');

      const key1 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Key 1'
      });

      await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub2'),
        encryptedPrivateKey: 'enc2',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Key 2'
      });

      // Register a key for a different member
      await pki.registerMemberKey({
        memberId: kid.id,
        publicKey: encodePublicKey('pub3'),
        encryptedPrivateKey: 'enc3',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Kid Key'
      });

      // Revoke key1
      await pki.revokeMemberKey(key1.id, parent.id, parent.id);

      const keys = await pki.listMemberKeys(parent.id);
      assert.equal(keys.length, 1);
      assert.equal(keys[0].label, 'Key 2');
    });
  });

  describe('getMemberKey', () => {
    it('returns key details including revoked ones', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Test Key'
      });

      await pki.revokeMemberKey(key.id, parent.id, parent.id);

      const fetched = await pki.getMemberKey(key.id, parent.id);
      assert.ok(fetched);
      assert.equal(fetched.id, key.id);
      assert.ok(fetched.revoked_at);
      assert.equal(Object.hasOwn(fetched, 'encrypted_private_key'), false);
    });

    it('returns null for non-existent key', async () => {
      const pki = require('../lib/pki');
      const result = await pki.getMemberKey(99999, parent.id);
      assert.equal(result, null);
    });
  });

  describe('revokeMemberKey', () => {
    it('sets revoked_at and returns the key', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Revoke Me'
      });

      const revoked = await pki.revokeMemberKey(key.id, parent.id, parent.id);
      assert.ok(revoked);
      assert.ok(revoked.revoked_at);
      assert.equal(revoked.id, key.id);
    });

    it('returns null on already-revoked key', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Double Revoke'
      });

      await pki.revokeMemberKey(key.id, parent.id, parent.id);
      const second = await pki.revokeMemberKey(key.id, parent.id, parent.id);
      assert.equal(second, null);
    });
  });

  describe('updateKeyLastUsed', () => {
    it('updates the timestamp', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub-last-used'),
        encryptedPrivateKey: 'enc-last-used',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Use Me'
      });

      assert.equal(key.last_used_at, null);
      await pki.updateKeyLastUsed(key.id);
      const fetched = await pki.getMemberKey(key.id, parent.id);
      assert.ok(fetched.last_used_at);
    });
  });

  describe('getDocumentKeyInfo', () => {
    it('returns holder-aware key info while preserving compatibility fields', async () => {
      const pki = require('../lib/pki');
      const { createDocument } = require('../lib/documents');
      const key1 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Primary'
      });
      const key2 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('pub2'),
        encryptedPrivateKey: 'enc2',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Backup'
      });
      const doc = await createDocument({
        title: 'PKI Holder Info',
        document_type: 'other',
        source_type: 'upload',
        created_by: parent.id,
        is_encrypted: true,
        encryption_mode: 'pki',
        encryption_key_id: key1.id,
        encryption_metadata: {
          version: 1,
          mode: 'pki',
          files: {
            upload: {
              cipher: 'aes-256-gcm',
              iv_b64: 'abc',
              holders: [
                {
                  member_id: parent.id,
                  encryption_key_id: key1.id,
                  key_fingerprint: key1.key_fingerprint,
                  role: 'owner',
                  wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
                },
                {
                  member_id: parent.id,
                  encryption_key_id: key2.id,
                  key_fingerprint: key2.key_fingerprint,
                  role: 'backup',
                  wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
                }
              ]
            }
          }
        }
      }, [parent.id]);

      const info = await pki.getDocumentKeyInfo(doc.id);
      assert.equal(info.encryption_key_id, key1.id);
      assert.equal(info.key.id, key1.id);
      assert.equal(info.primary_key.id, key1.id);
      assert.equal(info.holders.length, 2);
      assert.equal(info.holders[0].label, 'Primary');
      assert.equal(info.holders[1].label, 'Backup');
      assert.equal(info.holders[1].role, 'backup');
    });
  });

  describe('getKeyDependencySummary', () => {
    async function createPkiDoc({ title, primaryKey, extraHolders = [], fileKey = 'upload', extraFiles = {} }) {
      const { createDocument } = require('../lib/documents');
      return createDocument({
        title,
        document_type: 'other',
        source_type: 'upload',
        created_by: parent.id,
        is_encrypted: true,
        encryption_mode: 'pki',
        encryption_key_id: primaryKey.id,
        encryption_metadata: {
          version: 1,
          mode: 'pki',
          files: {
            [fileKey]: {
              cipher: 'aes-256-gcm',
              iv_b64: 'abc',
              holders: [
                {
                  member_id: parent.id,
                  encryption_key_id: primaryKey.id,
                  key_fingerprint: primaryKey.key_fingerprint,
                  role: 'owner',
                  wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
                },
                ...extraHolders
              ]
            },
            ...extraFiles
          }
        }
      }, [parent.id]);
    }

    it('returns zero counts when the key is unused by PKI docs', async () => {
      const pki = require('../lib/pki');
      const key = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('unused-pub'),
        encryptedPrivateKey: 'enc-unused',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Unused'
      });

      const summary = await pki.getKeyDependencySummary(key.id, parent.id);
      assert.ok(summary);
      assert.equal(summary.document_count, 0);
      assert.equal(summary.summary.safe_docs, 0);
      assert.equal(summary.summary.at_risk_docs, 0);
      assert.equal(summary.summary.already_stranded_docs, 0);
      assert.equal(summary.summary.inconsistent_docs, 0);
      assert.deepEqual(summary.documents, []);
    });

    it('classifies docs with another active holder as alternate_holders_available', async () => {
      const pki = require('../lib/pki');
      const key1 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('alt-pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Primary'
      });
      const key2 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('alt-pub2'),
        encryptedPrivateKey: 'enc2',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Backup'
      });

      await createPkiDoc({
        title: 'Alternate Holder Doc',
        primaryKey: key1,
        extraHolders: [{
          member_id: parent.id,
          encryption_key_id: key2.id,
          key_fingerprint: key2.key_fingerprint,
          role: 'backup',
          wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
        }]
      });

      const summary = await pki.getKeyDependencySummary(key1.id, parent.id);
      assert.equal(summary.document_count, 1);
      assert.equal(summary.summary.safe_docs, 1);
      assert.equal(summary.summary.at_risk_docs, 0);
      assert.equal(summary.documents[0].status, 'alternate_holders_available');
      assert.equal(summary.documents[0].active_holder_count, 2);
    });

    it('classifies docs as sole_active_holder when the target key is the only active holder', async () => {
      const pki = require('../lib/pki');
      const key1 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('sole-pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Primary'
      });
      const key2 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('sole-pub2'),
        encryptedPrivateKey: 'enc2',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Backup'
      });
      await pki.revokeMemberKey(key2.id, parent.id, parent.id);

      await createPkiDoc({
        title: 'Sole Active Holder Doc',
        primaryKey: key1,
        extraHolders: [{
          member_id: parent.id,
          encryption_key_id: key2.id,
          key_fingerprint: key2.key_fingerprint,
          role: 'backup',
          wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
        }]
      });

      const summary = await pki.getKeyDependencySummary(key1.id, parent.id);
      assert.equal(summary.summary.safe_docs, 0);
      assert.equal(summary.summary.at_risk_docs, 1);
      assert.equal(summary.documents[0].status, 'sole_active_holder');
      assert.equal(summary.documents[0].active_holder_count, 1);
      assert.equal(summary.documents[0].revoked_holder_count, 1);
    });

    it('classifies docs as all_holders_revoked when no active holders remain', async () => {
      const pki = require('../lib/pki');
      const key1 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('revoked-pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Primary'
      });
      const key2 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('revoked-pub2'),
        encryptedPrivateKey: 'enc2',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Backup'
      });

      await createPkiDoc({
        title: 'All Revoked Doc',
        primaryKey: key1,
        extraHolders: [{
          member_id: parent.id,
          encryption_key_id: key2.id,
          key_fingerprint: key2.key_fingerprint,
          role: 'backup',
          wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
        }]
      });
      await pki.revokeMemberKey(key1.id, parent.id, parent.id);
      await pki.revokeMemberKey(key2.id, parent.id, parent.id);

      const summary = await pki.getKeyDependencySummary(key1.id, parent.id);
      assert.equal(summary.summary.already_stranded_docs, 1);
      assert.equal(summary.documents[0].status, 'all_holders_revoked');
      assert.equal(summary.documents[0].active_holder_count, 0);
      assert.equal(summary.documents[0].revoked_holder_count, 2);
    });

    it('classifies malformed metadata as holder_metadata_inconsistent', async () => {
      const pki = require('../lib/pki');
      const { createDocument } = require('../lib/documents');
      const key1 = await pki.registerMemberKey({
        memberId: parent.id,
        publicKey: encodePublicKey('bad-pub1'),
        encryptedPrivateKey: 'enc1',
        algorithm: 'x25519',
        credentialId: null,
        prfEnabled: false,
        protectionTier: 'passphrase',
        label: 'Primary'
      });

      await createDocument({
        title: 'Malformed Holder Doc',
        document_type: 'other',
        source_type: 'upload',
        created_by: parent.id,
        is_encrypted: true,
        encryption_mode: 'pki',
        encryption_key_id: key1.id,
        encryption_metadata: {
          version: 1,
          mode: 'pki',
          files: {
            upload: {
              cipher: 'aes-256-gcm',
              iv_b64: 'abc'
            },
            copy: {
              cipher: 'aes-256-gcm',
              iv_b64: 'def',
              holders: [{
                member_id: parent.id,
                encryption_key_id: key1.id,
                key_fingerprint: key1.key_fingerprint,
                role: 'owner',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
              }]
            }
          }
        }
      }, [parent.id]);

      const summary = await pki.getKeyDependencySummary(key1.id, parent.id);
      assert.equal(summary.summary.inconsistent_docs, 1);
      assert.equal(summary.documents[0].status, 'holder_metadata_inconsistent');
    });
  });
});

describe('validatePkiUpload', () => {

  it('accepts multi-holder uploads for the uploading member and returns the primary key id', async () => {
    const pki = require('../lib/pki');
    const key1 = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: encodePublicKey('pub1'),
      encryptedPrivateKey: 'enc1',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Primary'
    });
    const key2 = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: encodePublicKey('pub2'),
      encryptedPrivateKey: 'enc2',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Backup'
    });

    const keyId = await pki.validatePkiUpload({
      files: {
        upload: {
          holders: [
            {
              member_id: parent.id,
              encryption_key_id: key1.id,
              key_fingerprint: key1.key_fingerprint,
              role: 'owner',
              wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
            },
            {
              member_id: parent.id,
              encryption_key_id: key2.id,
              key_fingerprint: key2.key_fingerprint,
              role: 'backup',
              wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
            }
          ]
        }
      }
    }, parent.id);

    assert.equal(keyId, key1.id);
  });

  it('rejects duplicate holder key ids', async () => {
    const pki = require('../lib/pki');
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: encodePublicKey('pub1'),
      encryptedPrivateKey: 'enc1',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Primary'
    });

    await assert.rejects(
      () => pki.validatePkiUpload({
        files: {
          upload: {
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: key.id,
                key_fingerprint: key.key_fingerprint,
                role: 'owner',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
              },
              {
                member_id: parent.id,
                encryption_key_id: key.id,
                key_fingerprint: key.key_fingerprint,
                role: 'backup',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
              }
            ]
          }
        }
      }, parent.id),
      /duplicate/i
    );
  });

  it('allows revoked existing holders when existingHolderKeyIds is provided', async () => {
    const pki = require('../lib/pki');
    const key1 = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: encodePublicKey('revoked-existing-pub1'),
      encryptedPrivateKey: 'enc1',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Revoked Primary'
    });
    const key2 = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: encodePublicKey('revoked-existing-pub2'),
      encryptedPrivateKey: 'enc2',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'New Backup'
    });
    await pki.revokeMemberKey(key1.id, parent.id, parent.id);

    const keyId = await pki.validatePkiUpload({
      files: {
        upload: {
          holders: [
            {
              member_id: parent.id,
              encryption_key_id: key1.id,
              key_fingerprint: key1.key_fingerprint,
              role: 'owner',
              wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
            },
            {
              member_id: parent.id,
              encryption_key_id: key2.id,
              key_fingerprint: key2.key_fingerprint,
              role: 'backup',
              wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
            }
          ]
        }
      }
    }, parent.id, { existingHolderKeyIds: [key1.id] });
    assert.equal(keyId, key1.id);
  });

  it('still rejects revoked keys that are NOT in existingHolderKeyIds', async () => {
    const pki = require('../lib/pki');
    const key1 = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: encodePublicKey('revoked-new-pub1'),
      encryptedPrivateKey: 'enc1',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Revoked New'
    });
    await pki.revokeMemberKey(key1.id, parent.id, parent.id);

    await assert.rejects(
      () => pki.validatePkiUpload({
        files: {
          upload: {
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: key1.id,
                key_fingerprint: key1.key_fingerprint,
                role: 'owner',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
              }
            ]
          }
        }
      }, parent.id),
      /revoked/i
    );
  });

  it('rejects cross-member holders for non-parent uploaders', async () => {
    const pki = require('../lib/pki');
    const kid = await createMember('Bob', 'kid');
    const kidKey = await pki.registerMemberKey({
      memberId: kid.id,
      publicKey: encodePublicKey('kid-pub1'),
      encryptedPrivateKey: 'enc1',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Kid Primary'
    });
    const parentKey = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: encodePublicKey('parent-pub1'),
      encryptedPrivateKey: 'enc2',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Parent Alt'
    });

    await assert.rejects(
      () => pki.validatePkiUpload({
        files: {
          upload: {
            holders: [
              {
                member_id: kid.id,
                encryption_key_id: kidKey.id,
                key_fingerprint: kidKey.key_fingerprint,
                role: 'owner',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'abc', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
              },
              {
                member_id: parent.id,
                encryption_key_id: parentKey.id,
                key_fingerprint: parentKey.key_fingerprint,
                role: 'beneficiary',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
              }
            ]
          }
        }
      }, kid.id),
      /parent/i
    );
  });
});
