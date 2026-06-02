'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedDel, authedPost } = require('./helpers');
const pki = require('../lib/pki');

let parent;
let kid;
let parentCookie;
let kidCookie;

async function createPkiDocForKey({ title, owner, primaryKey, extraHolders = [], extraFiles = {} }) {
  const { createDocument } = require('../lib/documents');
  return createDocument({
    title,
    document_type: 'other',
    source_type: 'upload',
    created_by: owner.id,
    is_encrypted: true,
    encryption_mode: 'pki',
    encryption_key_id: primaryKey.id,
    encryption_metadata: {
      version: 1,
      mode: 'pki',
      files: {
        upload: {
          cipher: 'aes-256-gcm',
          iv_b64: 'abc',
          holders: [
            {
              member_id: owner.id,
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
  }, [owner.id]);
}

describe('PKI key dependency and revoke guard API', () => {
  before(async () => {
    await startServer();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Parker', 'parent', 'pass123');
    kid = await createMember('Kira', 'kid', 'kidpass');
    parentCookie = await loginAs(parent, 'pass123');
    kidCookie = await loginAs(kid, 'kidpass');
  });

  it('lets the key owner inspect dependency summaries for their own key', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('dependency-key').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Dependency Test',
    });
    const backupKey = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('dependency-backup').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"ghi"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Dependency Backup',
    });

    await createPkiDocForKey({
      title: 'Dependency Doc',
      owner: parent,
      primaryKey: key,
      extraHolders: [{
        member_id: parent.id,
        encryption_key_id: backupKey.id,
        key_fingerprint: backupKey.key_fingerprint,
        role: 'backup',
        wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
      }]
    });

    const ownerRes = await authedGet(`api/members/${parent.id}/keys/${key.id}/dependencies`, parentCookie);
    assert.equal(ownerRes.status, 200);
    const ownerData = await ownerRes.json();
    assert.equal(ownerData.document_count, 1);
    assert.equal(ownerData.summary.safe_docs, 1);
    assert.equal(ownerData.documents[0].status, 'alternate_holders_available');
  });

  it('does not let another member inspect dependency summaries for a key', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('dependency-forbidden').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Dependency Forbidden',
    });

    const otherRes = await authedGet(`api/members/${parent.id}/keys/${key.id}/dependencies`, kidCookie);
    assert.equal(otherRes.status, 403);
  });

  it('blocks revoke when the key is the sole active holder for a PKI document', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('sole-holder-key').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Sole Holder Test',
    });

    await createPkiDocForKey({
      title: 'Sole Holder Protected Doc',
      owner: parent,
      primaryKey: key
    });

    const ownerRes = await authedDel(`api/members/${parent.id}/keys/${key.id}`, parentCookie);
    assert.equal(ownerRes.status, 409);
    const ownerData = await ownerRes.json();
    assert.equal(ownerData.code, 'PKI_KEY_SOLE_ACTIVE_HOLDER');
    assert.equal(ownerData.affected_documents.length, 1);
    assert.equal(ownerData.affected_documents[0].title, 'Sole Holder Protected Doc');
  });

  it('blocks revoke when dependency metadata is inconsistent', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('inconsistent-key').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Inconsistent Test',
    });

    const { createDocument } = require('../lib/documents');
    await createDocument({
      title: 'Inconsistent Protected Doc',
      document_type: 'other',
      source_type: 'upload',
      created_by: parent.id,
      is_encrypted: true,
      encryption_mode: 'pki',
      encryption_key_id: key.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        files: {
          upload: { cipher: 'aes-256-gcm', iv_b64: 'abc' },
          copy: {
            cipher: 'aes-256-gcm',
            iv_b64: 'def',
            holders: [{
              member_id: parent.id,
              encryption_key_id: key.id,
              key_fingerprint: key.key_fingerprint,
              role: 'owner',
              wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
            }]
          }
        }
      }
    }, [parent.id]);

    const ownerRes = await authedDel(`api/members/${parent.id}/keys/${key.id}`, parentCookie);
    assert.equal(ownerRes.status, 409);
    const ownerData = await ownerRes.json();
    assert.equal(ownerData.code, 'PKI_KEY_DEPENDENCY_INCONSISTENT');
    assert.equal(ownerData.affected_documents[0].title, 'Inconsistent Protected Doc');
  });

  it('rejects add-holder when existing holder integrity is altered', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('integrity-owner').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"def"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Integrity Owner',
    });
    const backupKey = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('integrity-backup').toString('base64'),
      encryptedPrivateKey: '{"kind":"passphrase_pbkdf2_v1","salt_b64":"abc","wrapped_private_key_b64":"ghi"}',
      algorithm: 'x25519',
      credentialId: null,
      prfEnabled: false,
      protectionTier: 'passphrase',
      label: 'Integrity Backup',
    });

    const doc = await createPkiDocForKey({
      title: 'Integrity Test Doc',
      owner: parent,
      primaryKey: key
    });

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/add`, parentCookie, {
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
                encryption_key_id: key.id,
                key_fingerprint: key.key_fingerprint,
                role: 'owner',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'TAMPERED', hkdf_salt_b64: 'def', wrapped_dek_b64: 'ghi' }
              },
              {
                member_id: parent.id,
                encryption_key_id: backupKey.id,
                key_fingerprint: backupKey.key_fingerprint,
                role: 'backup',
                wrapped_dek: { kind: 'pki_x25519', ephemeral_public_key_b64: 'jkl', hkdf_salt_b64: 'mno', wrapped_dek_b64: 'pqr' }
              }
            ]
          }
        }
      }
    });
    assert.ok([400, 409].includes(res.status), `Expected 400 or 409, got ${res.status}`);
    const data = await res.json();
    assert.match(data.error, /existing PKI holder|holder.*metadata|integrity/i);
  });
});
