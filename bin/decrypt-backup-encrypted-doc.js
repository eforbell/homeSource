#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
const PKICrypto = require('../public/pki-crypto');
const { subtle } = crypto.webcrypto;
const PBKDF2_ITERATIONS = 600000;

function usage() {
  console.log(`Usage:
  node bin/decrypt-backup-encrypted-doc.js --database <database.json> --backup-root <extracted-backup-root> [--mode <passphrase|pki>] [--passphrase <passphrase>] [--private-key <path>] [--recovery-code <code>] [--doc-id <id> | --title <title>] [--out-dir <dir>]

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

  node bin/decrypt-backup-encrypted-doc.js \\
    --database /tmp/backup/homesource-backup-2026-05-22/database.json \\
    --backup-root /tmp/backup/homesource-backup-2026-05-22 \\
    --mode pki \\
    --recovery-code "abandon ability ..." \\
    --doc-id 42

  node bin/decrypt-backup-encrypted-doc.js \\
    --database /tmp/backup/homesource-backup-2026-05-22/database.json \\
    --backup-root /tmp/backup/homesource-backup-2026-05-22 \\
    --mode pki \\
    --private-key /tmp/member-key.pk8 \\
    --title "Estate Plan 2026"
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

function resolveEncryptedPathInsideBackupRoot(backupRoot, storedFilename) {
  const root = path.resolve(backupRoot);
  const encryptedPath = path.resolve(root, String(storedFilename || ''));
  if (!(encryptedPath === root || encryptedPath.startsWith(root + path.sep))) {
    throw new Error(`File path escapes backup root: ${storedFilename}`);
  }
  return encryptedPath;
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
  if (typeof crypto.argon2Sync !== 'function') {
    throw new Error('Node runtime does not support crypto.argon2Sync (required for passphrase_argon2id backup decryption)');
  }
  const memory_kib = Number(params.memory_kib || 65536);
  const iterations = Number(params.iterations || 3);
  const parallelism = Number(params.parallelism || 1);
  const hash_len = Number(params.hash_len || 32);
  const key = crypto.argon2Sync('argon2id', {
    message: Buffer.from(passphrase, 'utf8'),
    nonce: Buffer.from(salt),
    memory: memory_kib,
    passes: iterations,
    parallelism,
    tagLength: hash_len
  });
  return subtle.importKey('raw', key, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

function parseWrappedJson(jsonLike, fieldName) {
  if (!jsonLike) throw new Error(`Missing ${fieldName}`);
  const payload = typeof jsonLike === 'string' ? JSON.parse(jsonLike) : jsonLike;
  return payload;
}

function findEncryptionKey(keys, id) {
  return (Array.isArray(keys) ? keys : []).find((row) => Number(row.id) === Number(id)) || null;
}

async function loadPrivateKeyFromFile(privateKeyPath) {
  const raw = fs.readFileSync(privateKeyPath);
  const text = raw.toString('utf8');
  let pkcs8Bytes = raw;
  if (/BEGIN PRIVATE KEY/.test(text)) {
    const b64 = text
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '');
    pkcs8Bytes = Buffer.from(b64, 'base64');
  }
  return subtle.importKey('pkcs8', pkcs8Bytes, { name: 'X25519' }, false, ['deriveBits']);
}

async function resolveOwnerPrivateKey({ doc, db, args }) {
  const keyId = Number(doc.encryption_key_id);
  if (!keyId) throw new Error('PKI document is missing encryption_key_id');
  const keyRow = findEncryptionKey(db.encryption_keys, keyId);
  if (!keyRow) throw new Error(`Encryption key ${keyId} not found in backup export`);

  if (args['private-key']) {
    return loadPrivateKeyFromFile(path.resolve(process.cwd(), String(args['private-key'])));
  }

  if (args['recovery-code']) {
    const recoveryWrap = parseWrappedJson(keyRow.recovery_wrapped_private_key, 'recovery_wrapped_private_key');
    if (recoveryWrap.kind !== 'recovery_mnemonic_v1' || !recoveryWrap.wrapped_private_key_b64) {
      throw new Error('Unsupported or missing recovery wrap for this key');
    }
    const recoveryKek = await PKICrypto.deriveKekFromMnemonic(String(args['recovery-code']));
    return PKICrypto.unwrapPrivateKey(
      PKICrypto.fromBase64(recoveryWrap.wrapped_private_key_b64),
      recoveryKek
    );
  }

  throw new Error('PKI mode requires either --private-key <path> or --recovery-code <code>');
}

async function decryptPassphraseMode({ doc, originalFile, backupRoot, args }) {
  const uploadMeta = doc.encryption_metadata?.files?.upload;
  if (!uploadMeta?.wrapped_dek || !uploadMeta.iv_b64) {
    throw new Error('Missing encryption metadata: files.upload');
  }

  const encryptedPath = resolveEncryptedPathInsideBackupRoot(backupRoot, originalFile.stored_filename);
  if (!fs.existsSync(encryptedPath)) throw new Error(`Encrypted file not found: ${encryptedPath}`);

  const salt = toBytesB64(uploadMeta.wrapped_dek.salt_b64);
  const wrapIv = toBytesB64(uploadMeta.wrapped_dek.wrap_iv_b64);
  const wrappedDek = toBytesB64(uploadMeta.wrapped_dek.wrapped_dek_b64);
  const contentIv = toBytesB64(uploadMeta.iv_b64);
  const wrapTagLength = Number(uploadMeta.wrapped_dek.tag_length_bits || 128);
  const contentTagLength = Number(uploadMeta.tag_length_bits || 128);
  const wrapKind = String(uploadMeta.wrapped_dek.kind || 'passphrase_pbkdf2');
  let wrapKey;
  if (wrapKind === 'passphrase_argon2id') {
    wrapKey = await deriveArgon2idWrapKey(String(args.passphrase), salt, uploadMeta.wrapped_dek.argon2id || {});
  } else if (wrapKind === 'passphrase_pbkdf2') {
    wrapKey = await deriveWrapKey(String(args.passphrase), salt);
  } else {
    throw new Error(`Unsupported wrapped_dek.kind "${wrapKind}" in this CLI`);
  }
  const rawDek = await subtle.decrypt({ name: 'AES-GCM', iv: wrapIv, tagLength: wrapTagLength }, wrapKey, wrappedDek);
  const contentKey = await subtle.importKey('raw', rawDek, 'AES-GCM', false, ['decrypt']);
  const encryptedBytes = fs.readFileSync(encryptedPath);
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: contentIv, tagLength: contentTagLength }, contentKey, encryptedBytes);
  return { plaintext: Buffer.from(plaintext), contentKey, uploadMeta, encryptedPath };
}

async function decryptPkiMode({ doc, originalFile, backupRoot, db, args }) {
  const uploadMeta = doc.encryption_metadata?.files?.upload;
  if (!uploadMeta?.wrapped_dek || !uploadMeta.iv_b64) {
    throw new Error('Missing encryption metadata: files.upload');
  }
  const encryptedPath = resolveEncryptedPathInsideBackupRoot(backupRoot, originalFile.stored_filename);
  if (!fs.existsSync(encryptedPath)) throw new Error(`Encrypted file not found: ${encryptedPath}`);

  const privateKey = await resolveOwnerPrivateKey({ doc, db, args });
  const contentKey = await PKICrypto.unwrapDekAsOwner(
    PKICrypto.fromBase64(uploadMeta.wrapped_dek.wrapped_dek_b64),
    PKICrypto.fromBase64(uploadMeta.wrapped_dek.ephemeral_public_key_b64),
    PKICrypto.fromBase64(uploadMeta.wrapped_dek.hkdf_salt_b64),
    privateKey
  );
  const encryptedBytes = fs.readFileSync(encryptedPath);
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: PKICrypto.fromBase64(uploadMeta.iv_b64), tagLength: Number(uploadMeta.tag_length_bits || 128) },
    contentKey,
    encryptedBytes
  );
  return { plaintext: Buffer.from(plaintext), contentKey, uploadMeta, encryptedPath };
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
  if (args.help || args.h || !args.database || !args['backup-root'] || (!args['doc-id'] && !args.title)) {
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
  const modeArg = args.mode ? String(args.mode).toLowerCase() : null;

  const doc = findDocument(documents, args);
  if (!doc) throw new Error('Document not found by --doc-id or --title');
  if (!doc.is_encrypted || !doc.encryption_mode || doc.encryption_mode === 'plaintext') {
    throw new Error(`Document id=${doc.id} is not encrypted`);
  }
  if (modeArg && modeArg !== String(doc.encryption_mode)) {
    throw new Error(`Requested --mode ${modeArg} does not match document encryption_mode ${doc.encryption_mode}`);
  }

  const originalFile = files.find(f => Number(f.document_id) === Number(doc.id) && f.file_type === 'original');
  if (!originalFile) throw new Error('No original file row found for document');
  let decryptResult;
  if (doc.encryption_mode === 'passphrase') {
    if (!args.passphrase) throw new Error('Passphrase mode requires --passphrase <passphrase>');
    decryptResult = await decryptPassphraseMode({ doc, originalFile, backupRoot, args });
  } else if (doc.encryption_mode === 'pki') {
    decryptResult = await decryptPkiMode({ doc, originalFile, backupRoot, db, args });
  } else {
    throw new Error(`Unsupported encryption_mode "${doc.encryption_mode}" in this CLI`);
  }

  let originalFilename = `doc-${doc.id}-decrypted.bin`;
  if (decryptResult.uploadMeta.encrypted_file_meta?.payload_b64 && decryptResult.uploadMeta.encrypted_file_meta?.iv_b64) {
    const metaIv = toBytesB64(decryptResult.uploadMeta.encrypted_file_meta.iv_b64);
    const metaPayload = toBytesB64(decryptResult.uploadMeta.encrypted_file_meta.payload_b64);
    const metaRaw = await subtle.decrypt({ name: 'AES-GCM', iv: metaIv, tagLength: 128 }, decryptResult.contentKey, metaPayload);
    const meta = JSON.parse(Buffer.from(metaRaw).toString('utf8'));
    if (meta?.original_filename) originalFilename = meta.original_filename;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, sanitizeFilename(originalFilename));
  fs.writeFileSync(outputPath, decryptResult.plaintext);

  console.log(`✅ Decrypted document id=${doc.id}`);
  console.log(`   title: ${doc.title}`);
  console.log(`   mode: ${doc.encryption_mode}`);
  console.log(`   input: ${decryptResult.encryptedPath}`);
  console.log(`   output: ${outputPath}`);
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
