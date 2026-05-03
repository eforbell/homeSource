#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { readTextPreview } = require('../lib/magic-index');
const { getMagicIndexConfig } = require('../lib/magic-index/config');

function usage() {
  console.log(`
Usage:
  node bin/magicindex-preview.js /path/to/file.pdf
  node bin/magicindex-preview.js /path/to/file.pdf --json
  node bin/magicindex-preview.js /path/to/file.pdf --chars 4000

What it does:
  - runs the same HomeSource preview extraction path used before MagicIndex model calls
  - shows source/extractor/error/text_preview_chars
  - prints the exact extracted preview text
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.csv': return 'text/csv';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args._.length) {
    usage();
    process.exit(args._.length ? 0 : 1);
  }

  const filePath = path.resolve(args._[0]);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const config = getMagicIndexConfig();
  const maxChars = Math.max(1, Number(args.chars || config.max_chars || 12000));
  const preview = readTextPreview(filePath, maxChars);
  const payload = {
    filePath,
    filename: path.basename(filePath),
    mimeType: inferMimeType(filePath),
    maxChars,
    extraction_evidence: {
      source: preview.source,
      extractor: preview.extractor,
      extraction_error: preview.error || null,
      text_preview_chars: Number(preview.text?.length || 0)
    },
    textPreview: preview.text || ''
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`file: ${payload.filePath}`);
  console.log(`filename: ${payload.filename}`);
  console.log(`mimeType: ${payload.mimeType}`);
  console.log(`source: ${payload.extraction_evidence.source}`);
  console.log(`extractor: ${payload.extraction_evidence.extractor || 'none'}`);
  console.log(`error: ${payload.extraction_evidence.extraction_error || 'none'}`);
  console.log(`text_preview_chars: ${payload.extraction_evidence.text_preview_chars}`);
  console.log('\n--- text preview start ---\n');
  process.stdout.write(payload.textPreview || '');
  console.log('\n\n--- text preview end ---');
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
