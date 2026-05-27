#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function usage() {
  console.log(`Usage:
  node bin/decrypt-backup-archive.js --input <backup.tar.gz.enc> --output <backup.tar.gz> --passphrase <passphrase>

Examples:
  node bin/decrypt-backup-archive.js \\
    --input /tmp/homesource-backup-2026-05-26T19-09-14.tar.gz.enc \\
    --output /tmp/homesource-backup.tar.gz \\
    --passphrase "correct horse battery staple"
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

function decryptArchive(buffer, passphrase) {
  const version = buffer.readUInt8(0);
  if (version !== 1) {
    throw new Error(`Unsupported backup archive version: ${version}`);
  }
  const salt = buffer.subarray(1, 33);
  const iv = buffer.subarray(33, 45);
  const tag = buffer.subarray(45, 61);
  const ciphertext = buffer.subarray(61);

  const key = crypto.scryptSync(passphrase, salt, 32, {
    N: 2 ** 16,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h || !args.input || !args.output || !args.passphrase) {
    usage();
    process.exit(args.help || args.h ? 0 : 1);
  }

  const inputPath = path.resolve(process.cwd(), String(args.input));
  const outputPath = path.resolve(process.cwd(), String(args.output));
  const passphrase = String(args.passphrase);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Encrypted backup not found: ${inputPath}`);
  }

  const encrypted = fs.readFileSync(inputPath);
  const plaintext = decryptArchive(encrypted, passphrase);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, plaintext);

  console.log(`✅ Decrypted backup archive`);
  console.log(`   input: ${inputPath}`);
  console.log(`   output: ${outputPath}`);
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
