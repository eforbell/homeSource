'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedPost, getPool } = require('./helpers');
const { createDocument } = require('../lib/documents');
const { storeFile, saveFileRecord } = require('../lib/files');
const pki = require('../lib/pki');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const PKICrypto = require('../public/pki-crypto');

let parent;
let parentCookie;
let pool;

before(async () => {
  await startServer();
  await resetDatabase();
  pool = getPool();
  parent = await createMember('BackupParent', 'parent', 'backup-pass');
  parentCookie = await loginAs(parent, 'backup-pass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('backup export with encrypted documents', () => {
  async function createRealPkiFixture(title) {
    const plaintext = Buffer.from(`Highly sensitive content for ${title}`, 'utf8');
    const keypair = await PKICrypto.generateMemberKeypair();
    const ownerPublicKey = await PKICrypto.importMemberPublicKey(keypair.publicKeyRaw);
    const { mnemonic } = await PKICrypto.generateRecoveryMnemonic();
    const recoveryKek = await PKICrypto.deriveKekFromMnemonic(mnemonic);
    const recoveryWrappedPrivateKey = await PKICrypto.wrapPrivateKey(keypair.privateKey, recoveryKek);
    const fakePrfWrappedPrivateKey = await PKICrypto.wrapPrivateKey(keypair.privateKey, recoveryKek);

    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: PKICrypto.toBase64(keypair.publicKeyRaw),
      encryptedPrivateKey: JSON.stringify({
        kind: 'webauthn_prf_v1',
        prf_salt_b64: Buffer.from('backup-prf-salt-real').toString('base64'),
        wrapped_private_key_b64: PKICrypto.toBase64(fakePrfWrappedPrivateKey)
      }),
      algorithm: 'x25519',
      credentialId: `backup-credential-${Date.now()}-${Math.random()}`,
      prfEnabled: true,
      protectionTier: 'hardware',
      label: `${title} Key`,
      credentialVerified: true,
      verificationMethod: 'webauthn',
      credentialTransports: ['usb'],
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      credentialAttachment: 'cross-platform',
      verifiedAt: new Date(),
    });
    await pki.saveRecoveryWrap(
      key.id,
      parent.id,
      JSON.stringify({
        kind: 'recovery_mnemonic_v1',
        wrapped_private_key_b64: PKICrypto.toBase64(recoveryWrappedPrivateKey)
      }),
      'mnemonic_bip39'
    );

    await pool.query(
      `INSERT INTO webauthn_credentials
         (member_id, credential_id, credential_public_key, registration_prf_salt, counter,
          credential_device_type, credential_backed_up, credential_attachment,
          credential_transports, requested_method)
       VALUES ($1, $2, $3, $4, 0, 'singleDevice', false, 'cross-platform', '["usb"]'::jsonb, 'security_key')`,
      [parent.id, key.credential_id, 'backup-public-key', 'backup-prf-salt-real']
    );

    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const contentIv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: contentIv, tagLength: 128 },
      dek,
      plaintext
    );
    const metaIv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedMeta = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: metaIv, tagLength: 128 },
      dek,
      new TextEncoder().encode(JSON.stringify({
        original_filename: `${title}.txt`,
        mime_type: 'text/plain'
      }))
    );
    const wrappedDek = await PKICrypto.wrapDekForOwner(dek, ownerPublicKey);
    const doc = await createDocument({
      title,
      document_type: 'legal',
      source_type: 'upload',
      metadata: { note: 'pki backup fixture' },
      is_encrypted: true,
      encryption_mode: 'pki',
      encryption_key_id: key.id,
      encryption_metadata: PKICrypto.buildPkiEnvelope({
        wrappedDek: wrappedDek.wrappedDek,
        ephemeralPublicKey: wrappedDek.ephemeralPublicKey,
        salt: wrappedDek.salt,
        iv: contentIv,
        memberId: parent.id,
        encryptionKeyId: key.id,
        keyFingerprint: key.key_fingerprint,
        encryptedFileMeta: {
          iv_b64: PKICrypto.toBase64(metaIv),
          payload_b64: PKICrypto.toBase64(new Uint8Array(encryptedMeta))
        }
      }),
      created_by: parent.id
    }, [parent.id]);
    const stored = await storeFile(Buffer.from(ciphertext), `${title}.enc`, 'application/octet-stream');
    await saveFileRecord(doc.id, stored);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keypair.privateKey));
    return { doc, key, mnemonic, plaintext, pkcs8 };
  }

  it('preserves encrypted document flags/metadata in backup database export', async () => {
    await createDocument({
      title: 'Encrypted Backup Fixture',
      document_type: 'legal',
      source_type: 'upload',
      metadata: { note: 'encrypted fixture' },
      is_encrypted: true,
      encryption_mode: 'passphrase',
      encryption_metadata: { version: 1, mode: 'passphrase', files: { upload: { cipher: 'aes-256-gcm' } } },
      created_by: parent.id
    }, [parent.id]);

    const exportRes = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(exportRes.status, 200);
    const payload = await exportRes.json();
    assert.ok(payload.file.endsWith('.tar.gz'));

    const backupPath = path.join(process.cwd(), 'data', 'test', 'exports', payload.file);
    assert.equal(fs.existsSync(backupPath), true, 'backup archive should exist');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-test-'));
    try {
      execFileSync('tar', ['-xzf', backupPath, '-C', tmpDir], { stdio: 'pipe' });
      const rootEntry = fs.readdirSync(tmpDir)[0];
      const dbPath = path.join(tmpDir, rootEntry, 'database.json');
      const dbExport = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      const encryptedDoc = (dbExport.documents || []).find(d => d.title === 'Encrypted Backup Fixture');
      assert.ok(encryptedDoc, 'encrypted fixture document should be present in backup database export');
      assert.equal(encryptedDoc.is_encrypted, true);
      assert.equal(encryptedDoc.encryption_mode, 'passphrase');
      assert.equal(encryptedDoc.encryption_metadata?.version, 1);
      const exportedMember = (dbExport.family_members || []).find(m => Number(m.id) === Number(parent.id));
      assert.ok(exportedMember, 'family member should be present in backup export');
      assert.equal(Object.hasOwn(exportedMember, 'passphrase_hash'), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes PKI key material needed for future recovery workflows', async () => {
    const key = await pki.registerMemberKey({
      memberId: parent.id,
      publicKey: Buffer.from('backup-pki-key').toString('base64'),
      encryptedPrivateKey: JSON.stringify({
        kind: 'webauthn_prf_v1',
        prf_salt_b64: Buffer.from('backup-prf-salt').toString('base64'),
        wrapped_private_key_b64: Buffer.from('wrapped-private-key').toString('base64')
      }),
      algorithm: 'x25519',
      credentialId: 'backup-credential-1',
      prfEnabled: true,
      protectionTier: 'hardware',
      label: 'Backup PKI Key',
      credentialVerified: true,
      verificationMethod: 'webauthn',
      credentialTransports: ['usb'],
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      credentialAttachment: 'cross-platform',
      verifiedAt: new Date(),
    });
    await pki.saveRecoveryWrap(
      key.id,
      parent.id,
      JSON.stringify({
        kind: 'recovery_mnemonic_v1',
        wrapped_private_key_b64: Buffer.from('wrapped-recovery-key').toString('base64')
      }),
      'mnemonic_bip39'
    );

    await pool.query(
      `INSERT INTO webauthn_credentials
         (member_id, credential_id, credential_public_key, registration_prf_salt, counter,
          credential_device_type, credential_backed_up, credential_attachment,
          credential_transports, requested_method)
       VALUES ($1, $2, $3, $4, 0, 'singleDevice', false, 'cross-platform', '["usb"]'::jsonb, 'security_key')`,
      [parent.id, 'backup-credential-1', 'backup-public-key', 'backup-prf-salt']
    );

    await createDocument({
      title: 'PKI Backup Fixture',
      document_type: 'legal',
      source_type: 'upload',
      metadata: { note: 'pki backup fixture' },
      is_encrypted: true,
      encryption_mode: 'pki',
      encryption_key_id: key.id,
      encryption_metadata: {
        version: 1,
        mode: 'pki',
        files: {
          upload: {
            cipher: 'aes-256-gcm',
            iv_b64: Buffer.from('iv-123456789012').toString('base64'),
            wrapped_dek: {
              kind: 'pki_x25519',
              ephemeral_public_key_b64: Buffer.from('ephemeral-public').toString('base64'),
              hkdf_salt_b64: Buffer.from('hkdf-salt').toString('base64'),
              wrapped_dek_b64: Buffer.from('wrapped-dek').toString('base64')
            },
            holders: [{
              member_id: parent.id,
              encryption_key_id: key.id,
              key_fingerprint: key.key_fingerprint,
              role: 'owner'
            }]
          }
        }
      },
      created_by: parent.id
    }, [parent.id]);

    const exportRes = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(exportRes.status, 200);
    const payload = await exportRes.json();
    const backupPath = path.join(process.cwd(), 'data', 'test', 'exports', payload.file);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-pki-test-'));
    try {
      execFileSync('tar', ['-xzf', backupPath, '-C', tmpDir], { stdio: 'pipe' });
      const rootEntry = fs.readdirSync(tmpDir)[0];
      const dbPath = path.join(tmpDir, rootEntry, 'database.json');
      const dbExport = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      assert.ok(Array.isArray(dbExport.encryption_keys), 'encryption_keys table should be exported');
      assert.ok(Array.isArray(dbExport.webauthn_credentials), 'webauthn_credentials table should be exported');
      const exportedKey = dbExport.encryption_keys.find((row) => Number(row.id) === Number(key.id));
      assert.ok(exportedKey, 'PKI key row should be present in backup export');
      assert.match(exportedKey.encrypted_private_key, /prf_salt_b64/);
      assert.match(exportedKey.recovery_wrapped_private_key, /wrapped_private_key_b64/);
      assert.match(exportedKey.recovery_wrapped_private_key, /d3JhcHBlZC1yZWNvdmVyeS1rZXk=/);
      const exportedCredential = dbExport.webauthn_credentials.find((row) => row.credential_id === 'backup-credential-1');
      assert.ok(exportedCredential, 'webauthn credential row should be present in backup export');
      assert.equal(exportedCredential.registration_prf_salt, 'backup-prf-salt');
      const pkiDoc = dbExport.documents.find((row) => row.title === 'PKI Backup Fixture');
      assert.ok(pkiDoc, 'PKI document should be present in backup export');
      assert.equal(pkiDoc.encryption_mode, 'pki');
      assert.equal(Number(pkiDoc.encryption_key_id), key.id);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('decrypts a PKI-encrypted backup fixture with the recovery CLI using recovery code and private key', async () => {
    const fixture = await createRealPkiFixture('PKI Backup Decrypt Fixture');
    const exportRes = await authedPost('api/backup/export', parentCookie, { encrypted: false });
    assert.equal(exportRes.status, 200);
    const payload = await exportRes.json();
    const backupPath = path.join(process.cwd(), 'data', 'test', 'exports', payload.file);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-pki-decrypt-'));
    const outRecovery = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-pki-recovery-out-'));
    const outPrivateKey = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-pki-private-out-'));
    try {
      execFileSync('tar', ['-xzf', backupPath, '-C', tmpDir], { stdio: 'pipe' });
      const rootEntry = fs.readdirSync(tmpDir)[0];
      const backupRoot = path.join(tmpDir, rootEntry);
      const dbPath = path.join(backupRoot, 'database.json');
      const privateKeyPath = path.join(tmpDir, 'member-key.pk8');
      fs.writeFileSync(privateKeyPath, fixture.pkcs8);

      execFileSync(process.execPath, [
        'bin/decrypt-backup-encrypted-doc.js',
        '--database', dbPath,
        '--backup-root', backupRoot,
        '--mode', 'pki',
        '--recovery-code', fixture.mnemonic,
        '--doc-id', String(fixture.doc.id),
        '--out-dir', outRecovery
      ], { cwd: process.cwd(), stdio: 'pipe' });

      execFileSync(process.execPath, [
        'bin/decrypt-backup-encrypted-doc.js',
        '--database', dbPath,
        '--backup-root', backupRoot,
        '--mode', 'pki',
        '--private-key', privateKeyPath,
        '--doc-id', String(fixture.doc.id),
        '--out-dir', outPrivateKey
      ], { cwd: process.cwd(), stdio: 'pipe' });

      const recoveryFiles = fs.readdirSync(outRecovery);
      const privateFiles = fs.readdirSync(outPrivateKey);
      assert.equal(recoveryFiles.length, 1);
      assert.equal(privateFiles.length, 1);
      const recoveryPlaintext = fs.readFileSync(path.join(outRecovery, recoveryFiles[0]));
      const privatePlaintext = fs.readFileSync(path.join(outPrivateKey, privateFiles[0]));
      assert.deepEqual(recoveryPlaintext, fixture.plaintext);
      assert.deepEqual(privatePlaintext, fixture.plaintext);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outRecovery, { recursive: true, force: true });
      fs.rmSync(outPrivateKey, { recursive: true, force: true });
    }
  });

  it('decrypts an encrypted backup archive and then recovers a PKI document from it', async () => {
    const fixture = await createRealPkiFixture('PKI Encrypted Archive Fixture');
    const exportRes = await authedPost('api/backup/export', parentCookie, {
      encrypted: true,
      passphrase: 'outer-backup-passphrase'
    });
    assert.equal(exportRes.status, 200);
    const payload = await exportRes.json();
    const encryptedBackupPath = path.join(process.cwd(), 'data', 'test', 'exports', payload.file);
    assert.ok(encryptedBackupPath.endsWith('.tar.gz.enc'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-enc-'));
    const decryptedTarPath = path.join(tmpDir, 'backup.tar.gz');
    const extractedDir = path.join(tmpDir, 'extracted');
    const outRecovery = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-enc-recovery-out-'));
    try {
      execFileSync(process.execPath, [
        'bin/decrypt-backup-archive.js',
        '--input', encryptedBackupPath,
        '--output', decryptedTarPath,
        '--passphrase', 'outer-backup-passphrase'
      ], { cwd: process.cwd(), stdio: 'pipe' });
      assert.equal(fs.existsSync(decryptedTarPath), true);

      fs.mkdirSync(extractedDir, { recursive: true });
      execFileSync('tar', ['-xzf', decryptedTarPath, '-C', extractedDir], { stdio: 'pipe' });
      const rootEntry = fs.readdirSync(extractedDir)[0];
      const backupRoot = path.join(extractedDir, rootEntry);
      const dbPath = path.join(backupRoot, 'database.json');

      execFileSync(process.execPath, [
        'bin/decrypt-backup-encrypted-doc.js',
        '--database', dbPath,
        '--backup-root', backupRoot,
        '--mode', 'pki',
        '--recovery-code', fixture.mnemonic,
        '--doc-id', String(fixture.doc.id),
        '--out-dir', outRecovery
      ], { cwd: process.cwd(), stdio: 'pipe' });

      const recoveryFiles = fs.readdirSync(outRecovery);
      assert.equal(recoveryFiles.length, 1);
      const recovered = fs.readFileSync(path.join(outRecovery, recoveryFiles[0]));
      assert.deepEqual(recovered, fixture.plaintext);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outRecovery, { recursive: true, force: true });
    }
  });

  it('rejects truncated encrypted backup archives with a clear error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homesource-backup-short-'));
    const shortPath = path.join(tmpDir, 'short.tar.gz.enc');
    const outputPath = path.join(tmpDir, 'out.tar.gz');
    fs.writeFileSync(shortPath, Buffer.alloc(10));
    try {
      assert.throws(() => {
        execFileSync(process.execPath, [
          'bin/decrypt-backup-archive.js',
          '--input', shortPath,
          '--output', outputPath,
          '--passphrase', 'irrelevant'
        ], { cwd: process.cwd(), stdio: 'pipe' });
      }, /too short/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
