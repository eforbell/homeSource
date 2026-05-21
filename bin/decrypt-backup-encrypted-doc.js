#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argon2 = require('argon2-browser');

const { subtle } = crypto.webcrypto;
const PBKDF2_ITERATIONS = 600000;

function usage() {
  console.log(`Usage:
  node bin/decrypt-backup-encrypted-doc.js --database <database.json> --backup-root <extracted-backup-root> --passphrase <passphrase> [--doc-id <id> | --title <title>] [--out-dir <dir>]

Examples:
  node bin/decrypt-backup-encrypted-doc.js \\
    --database /tmp/backup/homesource-backup-2026-05-22/database.json \\
    --backup-root /tmp/backup/homesource-backup-2026-05-22 \\
    --passphrase "correct horse battery staple" \\
    --doc-id 42

  node bin/decrypt-backup-encrypted-doc.js \\
    --database /tmp/backup/homesource-backup-2026-05-22/database.json \\
    --backup-root /tmp/backup/homesource-backup-2026-05-22 \\
    --passphrase "correct horse battery staple" \\
    --title "Passport - Eric" \\
    --out-dir /tmp/decrypted
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    i++;
  }
  return args;
}

function toBytesB64(s) {
  return Buffer.from(s, 'base64');
}

function sanitizeFilename(name) {
  return String(name || 'decrypted.bin').replace(/[\\/:*?"<>|]/g, '_').trim() || 'decrypted.bin';
}

async function deriveWrapKey(passphrase, salt) {
  const passphraseKey = await subtle.importKey('raw', Buffer.from(passphrase, 'utf8'), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    passphraseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function deriveArgon2idWrapKey(passphrase, salt, params = {}) {
  const memory_kib = Number(params.memory_kib || 65536);
  const iterations = Number(params.iterations || 3);
  const parallelism = Number(params.parallelism || 1);
  const hash_len = Number(params.hash_len || 32);
  const result = await argon2.hash({
    pass: passphrase,
    salt: new Uint8Array(salt),
    time: iterations,
    mem: memory_kib,
    parallelism,
    hashLen: hash_len,
    type: argon2.ArgonType.Argon2id
  });
  const raw = result.hash instanceof Uint8Array ? result.hash : new Uint8Array(result.hash);
  return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

function findDocument(documents, args) {
  if (args['doc-id']) {
    const id = Number(args['doc-id']);
    return documents.find(d => Number(d.id) === id) || null;
  }
  if (args.title) {
    const matches = documents.filter(d => String(d.title || '').toLowerCase() === String(args.title).toLowerCase());
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Multiple documents found for title "${args.title}". Use --doc-id.`);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h || !args.database || !args['backup-root'] || !args.passphrase || (!args['doc-id'] && !args.title)) {
    usage();
    process.exit(args.help || args.h ? 0 : 1);
  }

  const databasePath = path.resolve(process.cwd(), String(args.database));
  const backupRoot = path.resolve(process.cwd(), String(args['backup-root']));
  const outDir = path.resolve(process.cwd(), String(args['out-dir'] || process.cwd()));

  const rawDb = fs.readFileSync(databasePath, 'utf8');
  const db = JSON.parse(rawDb);
  const documents = Array.isArray(db.documents) ? db.documents : [];
  const files = Array.isArray(db.document_files) ? db.document_files : [];

  const doc = findDocument(documents, args);
  if (!doc) throw new Error('Document not found by --doc-id or --title');
  if (!doc.is_encrypted || !doc.encryption_mode || doc.encryption_mode === 'plaintext') {
    throw new Error(`Document id=${doc.id} is not encrypted`);
  }
  if (doc.encryption_mode !== 'passphrase') {
    throw new Error(`This tool currently supports passphrase mode only (found: ${doc.encryption_mode})`);
  }

  const uploadMeta = doc.encryption_metadata?.files?.upload;
  if (!uploadMeta?.wrapped_dek || !uploadMeta.iv_b64) {
    throw new Error('Missing encryption metadata: files.upload');
  }

  const originalFile = files.find(f => Number(f.document_id) === Number(doc.id) && f.file_type === 'original');
  if (!originalFile) throw new Error('No original file row found for document');

  const encryptedPath = path.resolve(backupRoot, String(originalFile.stored_filename || ''));
  if (!fs.existsSync(encryptedPath)) throw new Error(`Encrypted file not found: ${encryptedPath}`);

  const salt = toBytesB64(uploadMeta.wrapped_dek.salt_b64);
  const wrapIv = toBytesB64(uploadMeta.wrapped_dek.wrap_iv_b64);
  const wrappedDek = toBytesB64(uploadMeta.wrapped_dek.wrapped_dek_b64);
  const contentIv = toBytesB64(uploadMeta.iv_b64);
  const wrapKind = String(uploadMeta.wrapped_dek.kind || 'passphrase_pbkdf2');
  let wrapKey;
  if (wrapKind === 'passphrase_argon2id') {
    wrapKey = await deriveArgon2idWrapKey(String(args.passphrase), salt, uploadMeta.wrapped_dek.argon2id || {});
  } else if (wrapKind === 'passphrase_pbkdf2') {
    wrapKey = await deriveWrapKey(String(args.passphrase), salt);
  } else {
    throw new Error(`Unsupported wrapped_dek.kind "${wrapKind}" in this CLI`);
  }
  const rawDek = await subtle.decrypt({ name: 'AES-GCM', iv: wrapIv, tagLength: 128 }, wrapKey, wrappedDek);
  const contentKey = await subtle.importKey('raw', rawDek, 'AES-GCM', false, ['decrypt']);

  const encryptedBytes = fs.readFileSync(encryptedPath);
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: contentIv, tagLength: 128 }, contentKey, encryptedBytes);

  let originalFilename = `doc-${doc.id}-decrypted.bin`;
  if (uploadMeta.encrypted_file_meta?.payload_b64 && uploadMeta.encrypted_file_meta?.iv_b64) {
    const metaIv = toBytesB64(uploadMeta.encrypted_file_meta.iv_b64);
    const metaPayload = toBytesB64(uploadMeta.encrypted_file_meta.payload_b64);
    const metaRaw = await subtle.decrypt({ name: 'AES-GCM', iv: metaIv, tagLength: 128 }, contentKey, metaPayload);
    const meta = JSON.parse(Buffer.from(metaRaw).toString('utf8'));
    if (meta?.original_filename) originalFilename = meta.original_filename;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, sanitizeFilename(originalFilename));
  fs.writeFileSync(outputPath, Buffer.from(plaintext));

  console.log(`✅ Decrypted document id=${doc.id}`);
  console.log(`   title: ${doc.title}`);
  console.log(`   input: ${encryptedPath}`);
  console.log(`   output: ${outputPath}`);
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
