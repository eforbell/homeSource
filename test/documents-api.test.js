'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedPut, authedDel, authedFetch, createTestDocument, getPool } = require('./helpers');
const { saveFileRecord, storeFile, getFilePath } = require('../lib/files');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const PKICrypto = require('../public/pki-crypto');

let parent, kid, parentCookie, kidCookie;
let pool;

before(async () => {
  await startServer();
  await resetDatabase();
  pool = getPool();
  parent = await createMember('DocParent', 'parent', 'pass123');
  kid = await createMember('DocKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass123');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('GET /api/documents', () => {
  it('returns 401 without auth', async () => {
    const { url } = require('./helpers');
    const res = await fetch(url('api/documents'));
    assert.equal(res.status, 401);
  });

  it('returns empty list initially', async () => {
    const res = await authedGet('api/documents', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.documents.length, 0);
    assert.equal(data.total, 0);
  });
});

describe('document CRUD', () => {
  let docId;

  it('creates a document (via DB)', async () => {
    const doc = await createTestDocument(parent.id, {
      title: 'Test Warranty',
      document_type: 'warranty',
      description: 'HVAC system warranty document'
    });
    assert.ok(doc.id);
    assert.equal(doc.title, 'Test Warranty');
    assert.equal(doc.document_type, 'warranty');
    docId = doc.id;
  });

  it('lists the created document', async () => {
    const res = await authedGet('api/documents', parentCookie);
    const data = await res.json();
    assert.equal(data.total, 1);
    assert.equal(data.documents[0].title, 'Test Warranty');
  });

  it('gets document detail', async () => {
    const res = await authedGet(`api/documents/${docId}`, parentCookie);
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.id, docId);
    assert.equal(doc.title, 'Test Warranty');
    assert.ok(Array.isArray(doc.owners));
    assert.ok(Array.isArray(doc.tags));
    assert.ok(Array.isArray(doc.files));
  });

  it('updates document metadata', async () => {
    const res = await authedPut(`api/documents/${docId}`, parentCookie, {
      title: 'Updated Warranty',
      description: 'Updated description'
    });
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.title, 'Updated Warranty');
    assert.equal(doc.description, 'Updated description');
  });

  it('blocks mutation of encryption fields through generic update endpoint', async () => {
    const res = await authedPut(`api/documents/${docId}`, parentCookie, {
      encryption_mode: 'plaintext',
      is_encrypted: false,
      encryption_metadata: {}
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /immutable via this endpoint/i);
  });

  it('returns 404 for non-existent document', async () => {
    const res = await authedGet('api/documents/99999', parentCookie);
    assert.equal(res.status, 404);
  });

  it('filters by document_type', async () => {
    await createTestDocument(parent.id, { title: 'Tax Doc', document_type: 'tax' });

    const res = await authedGet('api/documents?type=warranty', parentCookie);
    const data = await res.json();
    assert.equal(data.total, 1);
    assert.equal(data.documents[0].document_type, 'warranty');
  });

  it('archives a document', async () => {
    const res = await authedDel(`api/documents/${docId}`, parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    const listRes = await authedGet('api/documents', parentCookie);
    const listData = await listRes.json();
    const found = listData.documents.find(d => d.id === docId);
    assert.equal(found, undefined, 'archived doc should not appear in active list');
  });
});

describe('encrypted document upload flags', () => {
  it('persists encryption mode and metadata from upload', async () => {
    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% encrypted test\n%%EOF')], { type: 'application/pdf' });
    form.append('file', pdf, 'encrypted-test.pdf');
    form.append('metadata', JSON.stringify({
      title: 'Encrypted Upload',
      document_type: 'other',
      encryption_mode: 'passphrase',
      encryption_metadata: { version: 1, mode: 'passphrase', files: { upload: { cipher: 'aes-256-gcm' } } }
    }));

    const res = await authedFetch('api/documents', parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 201);
    const created = await res.json();

    const detailRes = await authedGet(`api/documents/${created.id}`, parentCookie);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.is_encrypted, true);
    assert.equal(detail.encryption_mode, 'passphrase');
    assert.equal(detail.encryption_metadata.mode, 'passphrase');
    assert.equal(detail.encryption_key_id, null);
  });

  it('blocks adding files to encrypted documents', async () => {
    const encrypted = await createTestDocument(parent.id, {
      title: 'Encrypted File Add Block',
      is_encrypted: true,
      encryption_mode: 'passphrase',
      encryption_metadata: { version: 1, mode: 'passphrase' }
    });

    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' });
    form.append('file', pdf, 'extra.pdf');

    const res = await authedFetch(`api/documents/${encrypted.id}/files`, parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /unavailable for encrypted documents/i);
  });
});

describe('encrypt existing document in place', () => {
  const pki = require('../lib/pki');
  const parentKeyPassphrase = 'convert-parent-key-passphrase';
  let parentKey;

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

  function buildPassphraseEncryptionMetadata() {
    return {
      version: 1,
      mode: 'passphrase',
      files: {
        upload: {
          cipher: 'aes-256-gcm',
          iv_b64: 'abc',
          tag_length_bits: 128,
          wrapped_dek: {
            kind: 'passphrase_pbkdf2',
            salt_b64: 'def',
            wrap_iv_b64: 'ghi',
            wrapped_dek_b64: 'jkl',
            pbkdf2: { iterations: 600000, hash: 'SHA-256', derived_bits: 256 }
          },
          encrypted_file_meta: {
            iv_b64: 'mno',
            payload_b64: 'pqr'
          }
        }
      }
    };
  }

  async function createPlaintextDocFixture() {
    const doc = await createTestDocument(parent.id, {
      title: 'Encrypt Existing Fixture',
      document_type: 'other',
      metadata: { note: 'before encryption' }
    });
    const originalStored = await storeFile(Buffer.from('%PDF-1.4\n% plaintext fixture\n%%EOF'), 'fixture.pdf', 'application/pdf');
    const originalRecord = await saveFileRecord(doc.id, originalStored);
    const thumbStored = await storeFile(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'thumb.jpg', 'image/jpeg');
    thumbStored.file_type = 'thumbnail';
    const thumbnailRecord = await saveFileRecord(doc.id, thumbStored);
    const shareRes = await authedPost(`api/documents/${doc.id}/share`, parentCookie, { access_level: 'view' });
    assert.equal(shareRes.status, 201);
    return { doc, originalRecord, thumbnailRecord };
  }

  beforeEach(async () => {
    parentKey = await createPassphraseProtectedKey(parent.id, 'Convert Parent PKI Key', parentKeyPassphrase);
  });

  it('converts a plaintext document to passphrase encryption and removes old artifacts', async () => {
    const { doc, originalRecord, thumbnailRecord } = await createPlaintextDocFixture();
    const oldOriginalPath = getFilePath(originalRecord.stored_filename);
    const oldThumbPath = getFilePath(thumbnailRecord.stored_filename);
    assert.equal(fs.existsSync(oldOriginalPath), true);
    assert.equal(fs.existsSync(oldThumbPath), true);

    const encryptedBytes = Buffer.from('encrypted-passphrase-ciphertext');
    const form = new FormData();
    form.append('file', new Blob([encryptedBytes], { type: 'application/octet-stream' }), 'fixture.enc');
    form.append('metadata', JSON.stringify({
      encryption_mode: 'passphrase',
      encryption_metadata: buildPassphraseEncryptionMetadata()
    }));

    const res = await authedFetch(`api/documents/${doc.id}/encrypt`, parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.id, doc.id);
    assert.equal(updated.is_encrypted, true);
    assert.equal(updated.encryption_mode, 'passphrase');

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.id, doc.id);
    assert.equal(detail.files.length, 1);
    assert.equal(detail.files[0].file_type, 'original');
    assert.equal(detail.files[0].mime_type, 'application/octet-stream');
    assert.equal(detail.metadata.note, 'before encryption');
    assert.equal(detail.encryption_mode, 'passphrase');
    assert.equal(detail.encryption_key_id, null);

    const downloadRes = await authedGet(`api/documents/${doc.id}/files/${detail.files[0].id}/download`, parentCookie);
    assert.equal(downloadRes.status, 200);
    const storedBytes = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepEqual(storedBytes, encryptedBytes);

    assert.equal(fs.existsSync(oldOriginalPath), false);
    assert.equal(fs.existsSync(oldThumbPath), false);
    const { rows: shareRows } = await pool.query('SELECT id FROM share_links WHERE document_id = $1', [doc.id]);
    assert.equal(shareRows.length, 0);
    const { rows: auditRows } = await pool.query(
      `SELECT action, details FROM audit_log WHERE entity_type = 'document' AND entity_id = $1 AND action = 'document.encrypted.passphrase' ORDER BY id DESC LIMIT 1`,
      [doc.id]
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].details.deleted_share_count, 1);
    assert.equal(auditRows[0].details.cleanup_failure_count, 0);

    const reanalyzeRes = await authedPost(`api/documents/${doc.id}/magicindex/reanalyze`, parentCookie, { user_hint: 'retry' });
    assert.equal(reanalyzeRes.status, 409);
    const shareCreateRes = await authedPost(`api/documents/${doc.id}/share`, parentCookie, { access_level: 'view' });
    assert.equal(shareCreateRes.status, 409);
  });

  it('converts a plaintext document to single-holder PKI encryption', async () => {
    const { doc, originalRecord } = await createPlaintextDocFixture();
    const oldOriginalPath = getFilePath(originalRecord.stored_filename);
    const encryptedBytes = Buffer.from('encrypted-pki-ciphertext');
    const form = new FormData();
    form.append('file', new Blob([encryptedBytes], { type: 'application/octet-stream' }), 'fixture-pki.enc');
    form.append('metadata', JSON.stringify({
      encryption_mode: 'pki',
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            wrapped_dek: {
              kind: 'pki_x25519',
              ephemeral_public_key_b64: 'abc',
              hkdf_salt_b64: 'def',
              wrapped_dek_b64: 'ghi'
            },
            holders: [{
              member_id: parent.id,
              encryption_key_id: parentKey.id,
              key_fingerprint: parentKey.key_fingerprint,
              role: 'owner'
            }]
          }
        }
      }
    }));

    const res = await authedFetch(`api/documents/${doc.id}/encrypt`, parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.encryption_mode, 'pki');
    assert.equal(updated.encryption_key_id, parentKey.id);

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.encryption_mode, 'pki');
    assert.equal(detail.encryption_key_id, parentKey.id);
    assert.equal(detail.files.length, 1);
    assert.equal(fs.existsSync(oldOriginalPath), false);

    const keyInfoRes = await authedGet(`api/documents/${doc.id}/key-info`, parentCookie);
    assert.equal(keyInfoRes.status, 200);
    const keyInfo = await keyInfoRes.json();
    assert.equal(keyInfo.encryption_key_id, parentKey.id);
    assert.equal(keyInfo.key.id, parentKey.id);
  });

  it('converts a plaintext document to multi-holder PKI encryption', async () => {
    const { doc } = await createPlaintextDocFixture();
    const backupKey = await createPassphraseProtectedKey(parent.id, 'Parent Backup PKI Key', parentKeyPassphrase);
    const encryptedBytes = Buffer.from('encrypted-pki-ciphertext-multi');
    const form = new FormData();
    form.append('file', new Blob([encryptedBytes], { type: 'application/octet-stream' }), 'fixture-pki-multi.enc');
    form.append('metadata', JSON.stringify({
      encryption_mode: 'pki',
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'cipher-iv',
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: parentKey.id,
                key_fingerprint: parentKey.key_fingerprint,
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
                  ephemeral_public_key_b64: 'jkl',
                  hkdf_salt_b64: 'mno',
                  wrapped_dek_b64: 'pqr'
                }
              }
            ]
          }
        }
      }
    }));

    const res = await authedFetch(`api/documents/${doc.id}/encrypt`, parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.encryption_mode, 'pki');
    assert.equal(updated.encryption_key_id, parentKey.id);

    const keyInfoRes = await authedGet(`api/documents/${doc.id}/key-info`, parentCookie);
    assert.equal(keyInfoRes.status, 200);
    const keyInfo = await keyInfoRes.json();
    assert.equal(keyInfo.encryption_key_id, parentKey.id);
    assert.equal(keyInfo.primary_key.id, parentKey.id);
    assert.equal(keyInfo.holders.length, 2);
    assert.equal(keyInfo.holders[0].role, 'owner');
    assert.equal(keyInfo.holders[1].role, 'backup');
    assert.equal(keyInfo.holders[1].encryption_key_id, backupKey.id);
  });

  it('rejects encrypt-in-place for documents with multiple original uploads', async () => {
    const doc = await createTestDocument(parent.id, { title: 'Two uploads fixture' });
    const first = await storeFile(Buffer.from('%PDF-1.4\n% first\n%%EOF'), 'first.pdf', 'application/pdf');
    const second = await storeFile(Buffer.from('%PDF-1.4\n% second\n%%EOF'), 'second.pdf', 'application/pdf');
    const firstRecord = await saveFileRecord(doc.id, first);
    const secondRecord = await saveFileRecord(doc.id, second);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('cipher')], { type: 'application/octet-stream' }), 'two.enc');
    form.append('metadata', JSON.stringify({
      encryption_mode: 'passphrase',
      encryption_metadata: buildPassphraseEncryptionMetadata()
    }));

    const res = await authedFetch(`api/documents/${doc.id}/encrypt`, parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /multiple uploads/i);
    assert.equal(fs.existsSync(getFilePath(firstRecord.stored_filename)), true);
    assert.equal(fs.existsSync(getFilePath(secondRecord.stored_filename)), true);
  });

  it('rejects encrypt-in-place for kid users and already encrypted docs', async () => {
    const doc = await createTestDocument(parent.id, { title: 'Kid blocked fixture' });
    const stored = await storeFile(Buffer.from('%PDF-1.4\n% fixture\n%%EOF'), 'kid.pdf', 'application/pdf');
    await saveFileRecord(doc.id, stored);
    const buildEncryptForm = () => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('cipher')], { type: 'application/octet-stream' }), 'kid.enc');
      form.append('metadata', JSON.stringify({
        encryption_mode: 'passphrase',
        encryption_metadata: buildPassphraseEncryptionMetadata()
      }));
      return form;
    };

    const kidRes = await authedFetch(`api/documents/${doc.id}/encrypt`, kidCookie, {
      method: 'POST',
      body: buildEncryptForm()
    });
    assert.equal(kidRes.status, 403);

    const encrypted = await createTestDocument(parent.id, {
      title: 'Already encrypted fixture',
      is_encrypted: true,
      encryption_mode: 'passphrase',
      encryption_metadata: buildPassphraseEncryptionMetadata()
    });
    const encryptedStored = await storeFile(Buffer.from('ciphertext'), 'already.enc', 'application/octet-stream');
    await saveFileRecord(encrypted.id, encryptedStored);

    const alreadyRes = await authedFetch(`api/documents/${encrypted.id}/encrypt`, parentCookie, {
      method: 'POST',
      body: buildEncryptForm()
    });
    assert.equal(alreadyRes.status, 409);
  });
});


describe('extend existing PKI document access', () => {
  const pki = require('../lib/pki');
  let primaryKey;
  let backupKey;

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

  beforeEach(async () => {
    primaryKey = await createPassphraseProtectedKey(parent.id, 'Existing Primary Key', 'existing-primary-passphrase');
    backupKey = await createPassphraseProtectedKey(parent.id, 'New Backup Key', 'new-backup-passphrase');
  });

  async function createLegacySingleHolderPkiDoc() {
    const doc = await createTestDocument(parent.id, {
      title: 'Existing PKI Doc',
      document_type: 'other',
      is_encrypted: true,
      encryption_mode: 'pki',
      encryption_key_id: primaryKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            tag_length_bits: 128,
            wrapped_dek: {
              kind: 'pki_x25519',
              ephemeral_public_key_b64: 'abc',
              hkdf_salt_b64: 'def',
              wrapped_dek_b64: 'ghi'
            },
            holders: [{
              member_id: parent.id,
              encryption_key_id: primaryKey.id,
              key_fingerprint: primaryKey.key_fingerprint,
              role: 'owner'
            }],
            encrypted_file_meta: {
              iv_b64: 'meta-iv',
              payload_b64: 'meta-payload'
            }
          }
        }
      }
    }, [parent.id]);
    const stored = await storeFile(Buffer.from('existing-pki-ciphertext'), 'existing.enc', 'application/octet-stream');
    const record = await saveFileRecord(doc.id, stored);
    return { doc, record };
  }

  it('adds a same-member backup key to an existing PKI document without changing ciphertext bytes', async () => {
    const { doc, record } = await createLegacySingleHolderPkiDoc();
    const beforeBytes = fs.readFileSync(getFilePath(record.stored_filename));
    const res = await authedPost(`api/documents/${doc.id}/pki-holders/add`, parentCookie, {
      primary_encryption_key_id: primaryKey.id,
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
                encryption_key_id: backupKey.id,
                key_fingerprint: backupKey.key_fingerprint,
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
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.document.encryption_key_id, primaryKey.id);

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.encryption_mode, 'pki');
    assert.equal(detail.encryption_key_id, primaryKey.id);
    assert.equal(detail.encryption_metadata.files.upload.holders.length, 2);
    assert.equal(detail.encryption_metadata.files.upload.holders[0].wrapped_dek.kind, 'pki_x25519');
    assert.equal(detail.encryption_metadata.files.upload.holders[1].role, 'backup');

    const keyInfoRes = await authedGet(`api/documents/${doc.id}/key-info`, parentCookie);
    const keyInfo = await keyInfoRes.json();
    assert.equal(keyInfo.holders.length, 2);
    assert.equal(keyInfo.holders[1].label, 'New Backup Key');

    const afterBytes = fs.readFileSync(getFilePath(record.stored_filename));
    assert.deepEqual(afterBytes, beforeBytes);
  });

  it('rejects holder-extension route for non-PKI docs', async () => {
    const doc = await createTestDocument(parent.id, {
      title: 'Plaintext Doc',
      document_type: 'other'
    });
    const res = await authedPost(`api/documents/${doc.id}/pki-holders/add`, parentCookie, {
      primary_encryption_key_id: 123,
      encryption_metadata: { version: 1, mode: 'pki', files: { upload: { holders: [] } } }
    });
    assert.equal(res.status, 409);
  });

  it('rejects attempts to remove existing holders through add route', async () => {
    const { doc } = await createLegacySingleHolderPkiDoc();
    const res = await authedPost(`api/documents/${doc.id}/pki-holders/add`, parentCookie, {
      primary_encryption_key_id: primaryKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
            holders: []
          }
        }
      }
    });
    assert.equal(res.status, 400);
  });

  it('allows parent to add a beneficiary holder from a different household member', async () => {
    const { doc } = await createLegacySingleHolderPkiDoc();
    const kidKey = await createPassphraseProtectedKey(kid.id, 'Kid Key', 'kid-passphrase');
    const res = await authedPost(`api/documents/${doc.id}/pki-holders/add`, parentCookie, {
      primary_encryption_key_id: primaryKey.id,
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
                member_id: kid.id,
                encryption_key_id: kidKey.id,
                key_fingerprint: kidKey.key_fingerprint,
                role: 'beneficiary',
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
    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.encryption_metadata.files.upload.holders.length, 2);
    assert.equal(detail.encryption_metadata.files.upload.holders[1].role, 'beneficiary');
    assert.equal(detail.encryption_metadata.files.upload.holders[1].member_id, kid.id);

    const keyInfoRes = await authedGet(`api/documents/${doc.id}/key-info`, parentCookie);
    const keyInfo = await keyInfoRes.json();
    assert.equal(keyInfo.holders.length, 2);
    assert.equal(keyInfo.holders[1].member_name, kid.name);
  });

  it('rejects beneficiary holder that belongs to the acting member', async () => {
    const { doc } = await createLegacySingleHolderPkiDoc();
    const res = await authedPost(`api/documents/${doc.id}/pki-holders/add`, parentCookie, {
      primary_encryption_key_id: primaryKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
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
                role: 'beneficiary',
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
  });

  it('rejects holder with invalid role through add route', async () => {
    const { doc } = await createLegacySingleHolderPkiDoc();
    const kidKey = await createPassphraseProtectedKey(kid.id, 'Kid Key 2', 'kid-pass-2');
    const res = await authedPost(`api/documents/${doc.id}/pki-holders/add`, parentCookie, {
      primary_encryption_key_id: primaryKey.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'legacy-iv',
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
                member_id: kid.id,
                encryption_key_id: kidKey.id,
                key_fingerprint: kidKey.key_fingerprint,
                role: 'owner',
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
  });
});

describe('kid access control', () => {
  let parentDoc, kidDoc;

  before(async () => {
    parentDoc = await createTestDocument(parent.id, { title: 'Parent Only Doc' });
    kidDoc = await createTestDocument(kid.id, {
      title: 'Kid Doc',
      owner_ids: [kid.id]
    });
  });

  it('kid can list own documents', async () => {
    const res = await authedGet('api/documents', kidCookie);
    const data = await res.json();
    const titles = data.documents.map(d => d.title);
    assert.ok(titles.includes('Kid Doc'));
  });

  it('kid cannot update documents', async () => {
    const res = await authedPut(`api/documents/${kidDoc.id}`, kidCookie, { title: 'Hacked' });
    assert.equal(res.status, 403);
  });

  it('kid cannot delete documents', async () => {
    const res = await authedDel(`api/documents/${kidDoc.id}`, kidCookie);
    assert.equal(res.status, 403);
  });
});

describe('cross-member document auth surfaces', () => {
  let parentDoc;
  let parentFile;

  before(async () => {
    parentDoc = await createTestDocument(parent.id, {
      title: 'Parent Protected Doc',
      metadata: { magicindex: { state: 'complete', queued_at: new Date().toISOString() } }
    });
    const stored = await storeFile(Buffer.from('%PDF-1.4\n% auth test\n%%EOF'), 'parent-protected.pdf', 'application/pdf');
    parentFile = await saveFileRecord(parentDoc.id, stored);
    const shareRes = await authedPost(`api/documents/${parentDoc.id}/share`, parentCookie, {
      access_level: 'view'
    });
    assert.equal(shareRes.status, 201);
  });

  it('kid cannot view parent document detail', async () => {
    const res = await authedGet(`api/documents/${parentDoc.id}`, kidCookie);
    assert.equal(res.status, 403);
  });

  it('kid cannot view parent magicindex status', async () => {
    const res = await authedGet(`api/documents/${parentDoc.id}/magicindex-status`, kidCookie);
    assert.equal(res.status, 403);
  });

  it('kid cannot list parent share links', async () => {
    const res = await authedGet(`api/documents/${parentDoc.id}/shares`, kidCookie);
    assert.equal(res.status, 403);
  });

  it('kid cannot download parent file', async () => {
    const res = await authedGet(`api/documents/${parentDoc.id}/files/${parentFile.id}/download`, kidCookie);
    assert.equal(res.status, 403);
  });

  it('document file download route allows same-origin framing for preview', async () => {
    const res = await authedGet(`api/documents/${parentDoc.id}/files/${parentFile.id}/download`, parentCookie);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
  });
});

describe('document owners', () => {
  let doc;

  before(async () => {
    doc = await createTestDocument(parent.id, { title: 'Owner Test Doc' });
  });

  it('adds an owner', async () => {
    const res = await authedPost(`api/documents/${doc.id}/owners`, parentCookie, {
      member_id: kid.id,
      ownership_type: 'joint'
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.member_id, kid.id);
    assert.equal(data.ownership_type, 'joint');
  });

  it('removes an owner', async () => {
    const res = await authedDel(`api/documents/${doc.id}/owners/${kid.id}`, parentCookie);
    assert.equal(res.status, 200);
  });

  it('kid cannot add owners', async () => {
    const res = await authedPost(`api/documents/${doc.id}/owners`, kidCookie, {
      member_id: parent.id
    });
    assert.equal(res.status, 403);
  });
});

describe('MagicIndex re-analysis', () => {
  let doc;
  let encryptedDoc;

  before(async () => {
    doc = await createTestDocument(parent.id, {
      title: 'Reanalyze Me',
      metadata: { magicindex: { state: 'complete' } }
    });
    await saveFileRecord(doc.id, {
      file_type: 'original',
      stored_filename: 'test-reanalyze.pdf',
      original_filename: 'test-reanalyze.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: 128
    });

    encryptedDoc = await createTestDocument(parent.id, {
      title: 'Encrypted Reanalyze Blocked',
      is_encrypted: true,
      encryption_mode: 'passphrase',
      encryption_metadata: { version: 1, mode: 'passphrase' }
    });
  });

  it('queues a parent-triggered re-analysis with user hint', async () => {
    const longHint = `This is a vehicle registration. ${'A'.repeat(600)}`;
    const res = await authedPost(`api/documents/${doc.id}/magicindex/reanalyze`, parentCookie, {
      user_hint: longHint
    });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.ok, true);

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.metadata.magicindex.state, 'pending');
    assert.equal(detail.metadata.magicindex.user_hint.length, 500);
    assert.match(detail.metadata.magicindex.user_hint, /^This is a vehicle registration\./);

    const { rows } = await pool.query(
      `SELECT job_type, payload FROM processing_jobs WHERE document_id = $1 AND job_type = 'magicindex' ORDER BY id DESC LIMIT 1`,
      [doc.id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job_type, 'magicindex');
    assert.equal(rows[0].payload.user_hint.length, 500);
  });

  it('blocks kid-triggered re-analysis', async () => {
    const res = await authedPost(`api/documents/${doc.id}/magicindex/reanalyze`, kidCookie, {
      user_hint: 'Nope'
    });
    assert.equal(res.status, 403);
  });

  it('blocks duplicate re-analysis while pending', async () => {
    const res = await authedPost(`api/documents/${doc.id}/magicindex/reanalyze`, parentCookie, {
      user_hint: 'Try again'
    });
    assert.equal(res.status, 409);
  });

  it('blocks re-analysis for encrypted documents', async () => {
    const res = await authedPost(`api/documents/${encryptedDoc.id}/magicindex/reanalyze`, parentCookie, {
      user_hint: 'Try'
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /unavailable for encrypted documents/i);
  });

  after(async () => {
    await pool.query('DELETE FROM processing_jobs WHERE document_id = $1', [doc.id]);
  });
});

describe('PKI upload validation', () => {
  const pki = require('../lib/pki');
  let parentKey;
  let kidKey;
  const parentKeyPassphrase = 'parent-key-passphrase';

  function buildPkiMetadata(holderOverrides = {}) {
    return {
      title: 'PKI Upload',
      document_type: 'other',
      encryption_mode: 'pki',
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            wrapped_dek: {
              kind: 'pki_x25519',
              ephemeral_public_key_b64: 'abc',
              hkdf_salt_b64: 'def',
              wrapped_dek_b64: 'ghi'
            },
            holders: [{
              member_id: parent.id,
              encryption_key_id: parentKey.id,
              key_fingerprint: parentKey.key_fingerprint,
              role: 'owner',
              ...holderOverrides
            }]
          }
        }
      }
    };
  }

  function buildMultiHolderPkiMetadata(backupKey) {
    return {
      title: 'PKI Upload Multi Holder',
      document_type: 'other',
      encryption_mode: 'pki',
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        policy: { access_model: 'any_one_holder', threshold: 1 },
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: 'cipher-iv',
            holders: [
              {
                member_id: parent.id,
                encryption_key_id: parentKey.id,
                key_fingerprint: parentKey.key_fingerprint,
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
                  ephemeral_public_key_b64: 'jkl',
                  hkdf_salt_b64: 'mno',
                  wrapped_dek_b64: 'pqr'
                }
              }
            ]
          }
        }
      }
    };
  }

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

  beforeEach(async () => {
    parentKey = await createPassphraseProtectedKey(parent.id, 'Parent PKI Key', parentKeyPassphrase);
    kidKey = await createPassphraseProtectedKey(kid.id, 'Kid PKI Key', 'kid-key-passphrase');
  });

  it('persists validated encryption_key_id for PKI upload', async () => {
    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% pki test\n%%EOF')], { type: 'application/pdf' });
    form.append('file', pdf, 'pki-valid.pdf');
    form.append('metadata', JSON.stringify(buildPkiMetadata()));

    const res = await authedFetch('api/documents', parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.encryption_key_id, parentKey.id);

    const detailRes = await authedGet(`api/documents/${created.id}`, parentCookie);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.encryption_key_id, parentKey.id);
  });

  it('accepts multi-holder PKI upload and returns holder-aware key info', async () => {
    const backupKey = await createPassphraseProtectedKey(parent.id, 'Parent Backup PKI Key', 'parent-backup-passphrase');
    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% pki multi holder test\n%%EOF')], { type: 'application/pdf' });
    form.append('file', pdf, 'pki-multi-valid.pdf');
    form.append('metadata', JSON.stringify(buildMultiHolderPkiMetadata(backupKey)));

    const res = await authedFetch('api/documents', parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.encryption_key_id, parentKey.id);

    const keyInfoRes = await authedGet(`api/documents/${created.id}/key-info`, parentCookie);
    assert.equal(keyInfoRes.status, 200);
    const keyInfo = await keyInfoRes.json();
    assert.equal(keyInfo.encryption_key_id, parentKey.id);
    assert.equal(keyInfo.primary_key.id, parentKey.id);
    assert.equal(keyInfo.holders.length, 2);
    assert.equal(keyInfo.holders[0].label, 'Parent PKI Key');
    assert.equal(keyInfo.holders[1].label, 'Parent Backup PKI Key');
    assert.equal(keyInfo.holders[1].role, 'backup');
  });

  it('stores ciphertext and encrypted metadata for a real PKI upload flow', async () => {
    const file = new File([Buffer.from('%PDF-1.4\n% super secret family plan\n%%EOF')], 'family-plan.pdf', { type: 'application/pdf' });
    const materialRes = await authedGet(`api/members/${parent.id}/keys/${parentKey.id}/material`, parentCookie);
    assert.equal(materialRes.status, 200);
    const material = await materialRes.json();
    const wrapped = JSON.parse(material.encrypted_private_key);
    const { kek } = await PKICrypto.deriveKekFromPassphrase(parentKeyPassphrase, PKICrypto.fromBase64(wrapped.salt_b64));
    const privateKey = await PKICrypto.unwrapPrivateKey(PKICrypto.fromBase64(wrapped.wrapped_private_key_b64), kek);
    const ownerPublicKey = await PKICrypto.importMemberPublicKey(PKICrypto.fromBase64(material.public_key));
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const contentIv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: contentIv, tagLength: 128 },
      dek,
      new Uint8Array(await file.arrayBuffer())
    );
    const metaIv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedMeta = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: metaIv, tagLength: 128 },
      dek,
      new TextEncoder().encode(JSON.stringify({ original_filename: file.name, mime_type: file.type }))
    );
    assert.ok(privateKey);
    const wrappedDek = await PKICrypto.wrapDekForOwner(dek, ownerPublicKey);
    const envelope = PKICrypto.buildPkiEnvelope({
      wrappedDek: wrappedDek.wrappedDek,
      ephemeralPublicKey: wrappedDek.ephemeralPublicKey,
      salt: wrappedDek.salt,
      iv: contentIv,
      memberId: parent.id,
      encryptionKeyId: parentKey.id,
      keyFingerprint: parentKey.key_fingerprint,
      encryptedFileMeta: {
        iv_b64: PKICrypto.toBase64(metaIv),
        payload_b64: PKICrypto.toBase64(new Uint8Array(encryptedMeta))
      }
    });
    const form = new FormData();
    form.append('file', new Blob([ciphertextBuffer], { type: file.type }), 'family-plan.enc');
    form.append('metadata', JSON.stringify({
      title: 'Family Plan PKI',
      document_type: 'other',
      encryption_mode: 'pki',
      encryption_metadata: envelope,
      magicindex_enabled: true
    }));

    const res = await authedFetch('api/documents', parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.encryption_key_id, parentKey.id);

    const detailRes = await authedGet(`api/documents/${created.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.is_encrypted, true);
    assert.equal(detail.encryption_mode, 'pki');
    assert.equal(detail.metadata.magicindex.state, 'disabled');
    assert.equal(detail.files.length, 1);
    assert.equal(detail.files[0].file_type, 'original');
    const downloadRes = await authedGet(`api/documents/${created.id}/files/${detail.files[0].id}/download`, parentCookie);
    assert.equal(downloadRes.status, 200);
    const storedBytes = Buffer.from(await downloadRes.arrayBuffer());
    assert.notDeepEqual(storedBytes, Buffer.from('%PDF-1.4\n% super secret family plan\n%%EOF'));

    const refreshedMaterialRes = await authedGet(`api/members/${parent.id}/keys/${parentKey.id}/material`, parentCookie);
    const refreshedMaterial = await refreshedMaterialRes.json();
    assert.ok(refreshedMaterial.last_used_at);

    const keyInfoRes = await authedGet(`api/documents/${created.id}/key-info`, parentCookie);
    assert.equal(keyInfoRes.status, 200);
    const keyInfo = await keyInfoRes.json();
    assert.equal(keyInfo.encryption_mode, 'pki');
    assert.equal(keyInfo.encryption_key_id, parentKey.id);
    assert.equal(keyInfo.key.id, parentKey.id);
  });

  it('rejects PKI upload bound to another member key', async () => {
    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% pki foreign key\n%%EOF')], { type: 'application/pdf' });
    form.append('file', pdf, 'pki-foreign.pdf');
    form.append('metadata', JSON.stringify(buildPkiMetadata({
      encryption_key_id: kidKey.id,
      key_fingerprint: kidKey.key_fingerprint
    })));

    const res = await authedFetch('api/documents', parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /(declared member|uploading member)/i);
  });

  it('rejects PKI upload with mismatched fingerprint', async () => {
    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% pki bad fingerprint\n%%EOF')], { type: 'application/pdf' });
    form.append('file', pdf, 'pki-fingerprint.pdf');
    form.append('metadata', JSON.stringify(buildPkiMetadata({
      key_fingerprint: 'dead:beef:dead:beef:dead:beef:dead:beef:dead:beef:dead:beef:dead:beef:dead:beef'
    })));

    const res = await authedFetch('api/documents', parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /fingerprint mismatch/i);
  });

  it('rejects PKI upload with revoked key', async () => {
    await pki.revokeMemberKey(parentKey.id, parent.id, parent.id);

    const form = new FormData();
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% pki revoked key\n%%EOF')], { type: 'application/pdf' });
    form.append('file', pdf, 'pki-revoked.pdf');
    form.append('metadata', JSON.stringify(buildPkiMetadata()));

    const res = await authedFetch('api/documents', parentCookie, {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /revoked/i);
  });
});
