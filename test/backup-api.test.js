'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedPost } = require('./helpers');
const { createDocument } = require('../lib/documents');

let parent;
let parentCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('BackupParent', 'parent', 'backup-pass');
  parentCookie = await loginAs(parent, 'backup-pass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('backup export with encrypted documents', () => {
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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
