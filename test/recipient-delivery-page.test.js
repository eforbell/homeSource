'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const assert = require('node:assert/strict');

it('resumes a live recipient session but never promises reissue without the original link token', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'recipient-delivery.html'), 'utf8');
  assert.match(source, /sessionStorage\.getItem\(recipientBearerStorageKey\)/);
  assert.match(source, /api\('api\/continuity\/recipient\/manifest'\)/);
  assert.match(source, /if \(token\) \{[\s\S]*reissueButton\.hidden = false;/);
  assert.match(source, /Re-open the original link from your email to request a replacement\./);
  assert.match(source, /reissueButton\.hidden = true;/);
});
