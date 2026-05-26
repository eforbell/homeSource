'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { pool } = require('./db');
const { STORAGE_PATH } = require('./files');

async function createBackup(options = {}) {
  const { encrypted = false, passphrase = null } = options;
  const ensureDirs = require('./files').ensureDirs;
  const { exportsDir } = ensureDirs();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `homesource-backup-${timestamp}`;
  const tarName = `${baseName}.tar.gz`;
  const finalName = encrypted ? `${tarName}.enc` : tarName;
  const tarPath = path.join(exportsDir, tarName);
  const finalPath = path.join(exportsDir, finalName);

  const { rows: [logEntry] } = await pool.query(
    "INSERT INTO backup_log (backup_type, status) VALUES ('full', 'started') RETURNING *"
  );

  try {
    const dbExport = await exportDatabase();
    const docCount = dbExport.documents.length;

    const manifest = {
      version: '1.0.0',
      app: 'home-source',
      created_at: new Date().toISOString(),
      document_count: docCount,
      encrypted,
      tables: Object.keys(dbExport)
    };

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(tarPath);
      const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      archive.append(JSON.stringify(manifest, null, 2), { name: `${baseName}/manifest.json` });
      archive.append(JSON.stringify(dbExport, null, 2), { name: `${baseName}/database.json` });

      const docsRoot = path.join(STORAGE_PATH, 'documents');
      if (fs.existsSync(docsRoot)) {
        archive.directory(docsRoot, `${baseName}/documents`);
      }

      archive.finalize();
    });

    if (encrypted && passphrase) {
      await encryptFile(tarPath, finalPath, passphrase);
      fs.unlinkSync(tarPath);
    }

    const stats = fs.statSync(finalPath);

    await pool.query(
      "UPDATE backup_log SET status = 'completed', file_path = $1, file_size_bytes = $2, document_count = $3, encrypted = $4, completed_at = NOW() WHERE id = $5",
      [finalName, stats.size, docCount, encrypted, logEntry.id]
    );

    return { id: logEntry.id, file: finalName, size_bytes: stats.size, document_count: docCount, encrypted };
  } catch (err) {
    await pool.query(
      "UPDATE backup_log SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err.message, logEntry.id]
    );
    throw err;
  }
}

async function exportDatabase() {
  const tables = [
    'family_members',
    'encryption_keys',
    'key_holders',
    'webauthn_credentials',
    'documents',
    'document_files',
    'document_owners',
    'tags',
    'document_tags',
    'share_links',
    'app_config',
    'audit_log'
  ];

  const data = {};
  for (const table of tables) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);
    data[table] = rows;
  }
  return data;
}

async function encryptFile(inputPath, outputPath, passphrase) {
  const salt = crypto.randomBytes(32);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);

  const input = fs.readFileSync(inputPath);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Header: version(1) + salt(32) + iv(12) + tag(16) + encrypted data
  const header = Buffer.alloc(1);
  header.writeUInt8(1, 0);

  fs.writeFileSync(outputPath, Buffer.concat([header, salt, iv, tag, encrypted]));
}

async function getBackupStatus() {
  const { rows: policyRows } = await pool.query(
    "SELECT value FROM app_config WHERE key = 'backup_policy'"
  );
  const policy = policyRows[0] ? JSON.parse(policyRows[0].value) : { frequency_days: 30, notify_overdue_days: 7 };

  const { rows: lastBackup } = await pool.query(
    "SELECT * FROM backup_log WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1"
  );

  const last = lastBackup[0] || null;
  const now = new Date();
  let posture = 'none';

  if (last) {
    const daysSince = (now - new Date(last.completed_at)) / (1000 * 60 * 60 * 24);
    if (daysSince <= policy.frequency_days - policy.notify_overdue_days) {
      posture = 'good';
    } else if (daysSince <= policy.frequency_days) {
      posture = 'due_soon';
    } else {
      posture = 'overdue';
    }
  }

  return {
    policy,
    last_backup: last,
    posture,
    next_expected: last ? new Date(new Date(last.completed_at).getTime() + policy.frequency_days * 24 * 60 * 60 * 1000) : null
  };
}

async function getBackupLog() {
  const { rows } = await pool.query('SELECT * FROM backup_log ORDER BY started_at DESC LIMIT 50');
  return rows;
}

module.exports = { createBackup, getBackupStatus, getBackupLog };
