'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const assert = require('node:assert/strict');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');

it('keeps the hidden attribute effective over component display rules', () => {
  // .btn sets display, which would otherwise show controls the sessionless pages hide.
  const css = read('style.css');
  assert.match(css, /\.btn\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  for (const page of ['check-in.html', 'trustee-action.html', 'recipient-delivery.html', 'continuity-contact.html']) {
    assert.match(read(page), /href="style\.css"/, `${page} must load the [hidden] rule`);
  }
});

it('encrypts the Letter file metadata in the browser', () => {
  const source = read('continuity.html');
  const encryptLetter = source.slice(source.indexOf('async function encryptLetter'), source.indexOf('async function loadSwitch'));
  assert.match(encryptLetter, /crypto\.subtle\.encrypt\(\{ name:'AES-GCM', iv:metaIv, tagLength:128 \}, dek,/);
  assert.match(encryptLetter, /encrypted_file_meta:\{ iv_b64:PKICrypto\.toBase64\(metaIv\), payload_b64:PKICrypto\.toBase64\(encryptedMeta\) \}/);
  assert.doesNotMatch(encryptLetter, /encrypted_file_meta:\{ original_filename/);
});

it('offers Retry notifications only for failed rows on the shown switch', () => {
  const source = read('continuity.html');
  assert.match(source, /const failedCount = Number\(item\?\.failed_outbox_count \|\| 0\);/);
  assert.doesNotMatch(source, /failedCount = \(operations\?\.outbox/);
});
