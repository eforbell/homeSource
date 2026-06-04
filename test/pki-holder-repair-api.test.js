'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, getPool } = require('./helpers');
const { saveFileRecord, storeFile, getFilePath } = require('../lib/files');
const pki = require('../lib/pki');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const PKICrypto = require('../public/pki-crypto');

let pool;
let parent;
let kid;
let parentCookie;
let primaryKey;
let backupKey;
let replacementKey;

async function createPassphraseProtectedKey(memberId, label, passphrase) {
  const keypair = await PKICrypto.generateMemberKeypair();
  const { kek, salt } = await PKICrypto.deriveKekFromPassphrase(passphrase);
  const wrappedPrivateKey = await PKICrypto.wrapPrivateKey(keypair.privateKey, kek);
  return pki.registerMemberKey({
    memberId,
    publicKey: PKICrypto.toBase64(keypair.publicKeyRaw),
    encryptedPrivateKey: JSON.stringify({
      kind: 'passphrase_pbkdf2_v1',
      kdf: 'pbkdf2-sha256',
      iterations: 600000,
      salt_b64: PKICrypto.toBase64(salt),
      wrapped_private_key_b64: PKICrypto.toBase64(wrappedPrivateKey)
    }),
    algorithm: 'x25519',
    credentialId: null,
    prfEnabled: false,
    protectionTier: 'passphrase',
    label,
    verificationMethod: 'passphrase',
  });
}

async function createPkiDoc({ title, holders, encryptionKeyId }) {
  const { createDocument } = require('../lib/documents');
  const doc = await createDocument({
    title,
    document_type: 'other',
    source_type: 'upload',
    created_by: parent.id,
    is_encrypted: true,
    encryption_mode: 'pki',
    encryption_key_id: encryptionKeyId,
    encryption_metadata: {
      version: 1,
      mode: 'pki',
      files: {
        upload: {
          cipher: 'aes-256-gcm',
          iv_b64: 'legacy-iv',
          tag_length_bits: 128,
          holders,
          encrypted_file_meta: {
            iv_b64: 'meta-iv',
            payload_b64: 'meta-payload'
          }
        }
      }
    }
  }, [parent.id]);
  const stored = await storeFile(Buffer.from('existing-pki-ciphertext'), `${title}.enc`, 'application/octet-stream');
  const record = await saveFileRecord(doc.id, stored);
  return { doc, record };
}

describe('PKI holder repair API', () => {
  before(async () => {
    await startServer();
    pool = getPool();
  });

  after(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('RepairParent', 'parent', 'pass123');
    kid = await createMember('RepairKid', 'kid', 'kidpass');
    parentCookie = await loginAs(parent, 'pass123');
    primaryKey = await createPassphraseProtectedKey(parent.id, 'Existing Primary Key', 'existing-primary-passphrase');
    backupKey = await createPassphraseProtectedKey(parent.id, 'New Backup Key', 'new-backup-passphrase');
    replacementKey = await createPassphraseProtectedKey(parent.id, 'Replacement Key', 'replacement-passphrase');
  });

  it('replaces a revoked same-member holder without changing ciphertext bytes', async () => {
    const { doc, record } = await createPkiDoc({
      title: 'revoked-primary-replace',
      encryptionKeyId: primaryKey.id,
      holders: [{
        member_id: parent.id,
        encryption_key_id: primaryKey.id,
        key_fingerprint: primaryKey.key_fingerprint,
        role: 'owner',
        wrapped_dek: {
          kind: 'pki_x25519',
          ephemeral_public_key_b64: 'abc',
          hkdf_salt_b64: 'def',
          wrapped_dek_b64: 'ghi'
        }
      }]
    });
    const beforeBytes = fs.readFileSync(getFilePath(record.stored_filename));
    await pki.revokeMemberKey(primaryKey.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/replace`, parentCookie, {
      primary_encryption_key_id: replacementKey.id,
      old_holder_key_id: primaryKey.id,
      new_holder_key_id: replacementKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: replacementKey.id,
                key_fingerprint: replacementKey.key_fingerprint,
                role: 'owner',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'jkl',
                  hkdf_salt_b64: 'mno',
                  wrapped_dek_b64: 'pqr'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.document.encryption_key_id, replacementKey.id);

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.encryption_metadata.files.upload.holders.length, 1);
    assert.equal(detail.encryption_metadata.files.upload.holders[0].encryption_key_id, replacementKey.id);
    assert.equal(detail.encryption_metadata.files.upload.holders[0].role, 'owner');
    assert.equal(detail.encryption_key_id, replacementKey.id);

    const afterBytes = fs.readFileSync(getFilePath(record.stored_filename));
    assert.deepEqual(afterBytes, beforeBytes);
  });

  it('rejects holder replacement if the replacement role changes', async () => {
    const { doc } = await createPkiDoc({
      title: 'revoked-primary-role-mismatch',
      encryptionKeyId: primaryKey.id,
      holders: [{
        member_id: parent.id,
        encryption_key_id: primaryKey.id,
        key_fingerprint: primaryKey.key_fingerprint,
        role: 'owner',
        wrapped_dek: {
          kind: 'pki_x25519',
          ephemeral_public_key_b64: 'abc',
          hkdf_salt_b64: 'def',
          wrapped_dek_b64: 'ghi'
        }
      }]
    });
    await pki.revokeMemberKey(primaryKey.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/replace`, parentCookie, {
      primary_encryption_key_id: replacementKey.id,
      old_holder_key_id: primaryKey.id,
      new_holder_key_id: replacementKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: replacementKey.id,
                key_fingerprint: replacementKey.key_fingerprint,
                role: 'backup',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'jkl',
                  hkdf_salt_b64: 'mno',
                  wrapped_dek_b64: 'pqr'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /inherit the replaced holder role/i);
  });

  it('rejects holder replacement if unchanged holder metadata is altered', async () => {
    const secondRevoked = await createPassphraseProtectedKey(parent.id, 'Second Revoked Holder', 'second-revoked-passphrase');
    const { doc } = await createPkiDoc({
      title: 'unchanged-holder-integrity',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: secondRevoked.id,
          key_fingerprint: secondRevoked.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });
    await pki.revokeMemberKey(secondRevoked.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/replace`, parentCookie, {
      primary_encryption_key_id: primaryKey.id,
      old_holder_key_id: secondRevoked.id,
      new_holder_key_id: replacementKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: primaryKey.id,
                key_fingerprint: primaryKey.key_fingerprint,
                role: 'beneficiary',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'abc',
                  hkdf_salt_b64: 'def',
                  wrapped_dek_b64: 'ghi'
                }
              },
              {
                member_id: parent.id,
                encryption_key_id: replacementKey.id,
                key_fingerprint: replacementKey.key_fingerprint,
                role: 'backup',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'jkl',
                  hkdf_salt_b64: 'mno',
                  wrapped_dek_b64: 'pqr'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /cannot be modified by the replace-holder route/i);
  });

  it('replaces a revoked primary on a multi-holder doc and points to the replacement holder', async () => {
    const { doc, record } = await createPkiDoc({
      title: 'multi-holder-primary-replace',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: backupKey.id,
          key_fingerprint: backupKey.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });
    const beforeBytes = fs.readFileSync(getFilePath(record.stored_filename));
    await pki.revokeMemberKey(primaryKey.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/replace`, parentCookie, {
      old_holder_key_id: primaryKey.id,
      new_holder_key_id: replacementKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: replacementKey.id,
                key_fingerprint: replacementKey.key_fingerprint,
                role: 'owner',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'jkl',
                  hkdf_salt_b64: 'mno',
                  wrapped_dek_b64: 'pqr'
                }
              },
              {
                member_id: parent.id,
                encryption_key_id: backupKey.id,
                key_fingerprint: backupKey.key_fingerprint,
                role: 'backup',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'stu',
                  hkdf_salt_b64: 'vwx',
                  wrapped_dek_b64: 'yza'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.document.encryption_key_id, replacementKey.id);

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.encryption_metadata.files.upload.holders.length, 2);
    assert.equal(detail.encryption_metadata.files.upload.holders[0].encryption_key_id, replacementKey.id);
    assert.equal(detail.encryption_metadata.files.upload.holders[1].encryption_key_id, backupKey.id);
    assert.equal(detail.encryption_key_id, replacementKey.id);

    const afterBytes = fs.readFileSync(getFilePath(record.stored_filename));
    assert.deepEqual(afterBytes, beforeBytes);
  });

  it('removes a revoked holder without changing ciphertext bytes when an active holder remains', async () => {
    const { doc, record } = await createPkiDoc({
      title: 'remove-revoked-holder',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: backupKey.id,
          key_fingerprint: backupKey.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });
    const beforeBytes = fs.readFileSync(getFilePath(record.stored_filename));
    await pki.revokeMemberKey(backupKey.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/remove`, parentCookie, {
      remove_holder_key_id: backupKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: primaryKey.id,
                key_fingerprint: primaryKey.key_fingerprint,
                role: 'owner',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'abc',
                  hkdf_salt_b64: 'def',
                  wrapped_dek_b64: 'ghi'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.document.encryption_key_id, primaryKey.id);

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.encryption_metadata.files.upload.holders.length, 1);
    assert.equal(detail.encryption_metadata.files.upload.holders[0].encryption_key_id, primaryKey.id);

    const afterBytes = fs.readFileSync(getFilePath(record.stored_filename));
    assert.deepEqual(afterBytes, beforeBytes);
  });

  it('reassigns the compatibility pointer if the removed revoked holder was primary', async () => {
    const { doc } = await createPkiDoc({
      title: 'remove-revoked-primary-pointer',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: backupKey.id,
          key_fingerprint: backupKey.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });
    await pki.revokeMemberKey(primaryKey.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/remove`, parentCookie, {
      remove_holder_key_id: primaryKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: backupKey.id,
                key_fingerprint: backupKey.key_fingerprint,
                role: 'backup',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'stu',
                  hkdf_salt_b64: 'vwx',
                  wrapped_dek_b64: 'yza'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.document.encryption_key_id, backupKey.id);
  });

  it('rejects removal if the target holder is not revoked', async () => {
    const { doc } = await createPkiDoc({
      title: 'remove-active-holder-reject',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: backupKey.id,
          key_fingerprint: backupKey.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/remove`, parentCookie, {
      remove_holder_key_id: backupKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: primaryKey.id,
                key_fingerprint: primaryKey.key_fingerprint,
                role: 'owner',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'abc',
                  hkdf_salt_b64: 'def',
                  wrapped_dek_b64: 'ghi'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /supports removing revoked holders only/i);
  });

  it('rejects removal if it would leave the document without any active unlock holders', async () => {
    const { doc } = await createPkiDoc({
      title: 'remove-last-active-path-reject',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: backupKey.id,
          key_fingerprint: backupKey.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });
    await pki.revokeMemberKey(primaryKey.id, parent.id, parent.id);
    await pki.revokeMemberKey(backupKey.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/remove`, parentCookie, {
      remove_holder_key_id: primaryKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: backupKey.id,
                key_fingerprint: backupKey.key_fingerprint,
                role: 'backup',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'stu',
                  hkdf_salt_b64: 'vwx',
                  wrapped_dek_b64: 'yza'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /without any active unlock holders/i);
  });

  it('rejects removal if submitted envelope adds a new holder', async () => {
    const extraKey = await createPassphraseProtectedKey(parent.id, 'Extra Added Key', 'extra-added-passphrase');
    const { doc } = await createPkiDoc({
      title: 'remove-with-added-holder-reject',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: backupKey.id,
          key_fingerprint: backupKey.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });
    await pki.revokeMemberKey(backupKey.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/remove`, parentCookie, {
      remove_holder_key_id: backupKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: primaryKey.id,
                key_fingerprint: primaryKey.key_fingerprint,
                role: 'owner',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'abc',
                  hkdf_salt_b64: 'def',
                  wrapped_dek_b64: 'ghi'
                }
              },
              {
                member_id: parent.id,
                encryption_key_id: extraKey.id,
                key_fingerprint: extraKey.key_fingerprint,
                role: 'backup',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'jkl',
                  hkdf_salt_b64: 'mno',
                  wrapped_dek_b64: 'pqr'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /does not allow adding replacement holders/i);
  });

  it('rejects removal if unchanged holder metadata is altered', async () => {
    const secondRevoked = await createPassphraseProtectedKey(parent.id, 'Second Revoked Holder', 'second-revoked-passphrase');
    const { doc } = await createPkiDoc({
      title: 'remove-unchanged-holder-integrity',
      encryptionKeyId: primaryKey.id,
      holders: [
        {
          member_id: parent.id,
          encryption_key_id: primaryKey.id,
          key_fingerprint: primaryKey.key_fingerprint,
          role: 'owner',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'abc',
            hkdf_salt_b64: 'def',
            wrapped_dek_b64: 'ghi'
          }
        },
        {
          member_id: parent.id,
          encryption_key_id: secondRevoked.id,
          key_fingerprint: secondRevoked.key_fingerprint,
          role: 'backup',
          wrapped_dek: {
            kind: 'pki_x25519',
            ephemeral_public_key_b64: 'stu',
            hkdf_salt_b64: 'vwx',
            wrapped_dek_b64: 'yza'
          }
        }
      ]
    });
    await pki.revokeMemberKey(secondRevoked.id, parent.id, parent.id);

    const res = await authedPost(`api/documents/${doc.id}/pki-holders/remove`, parentCookie, {
      remove_holder_key_id: secondRevoked.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            },
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: primaryKey.id,
                key_fingerprint: primaryKey.key_fingerprint,
                role: 'beneficiary',
                wrapped_dek: {
                  kind: 'pki_x25519',
                  ephemeral_public_key_b64: 'abc',
                  hkdf_salt_b64: 'def',
                  wrapped_dek_b64: 'ghi'
                }
              }
            ]
          }
        }
      }
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /cannot be modified by the remove-holder route/i);
  });
});
