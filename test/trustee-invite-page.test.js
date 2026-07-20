'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const assert = require('node:assert/strict');

it('trustee invitation page is sessionless and registers a client-wrapped key', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'trustee-invite.html'), 'utf8');
  assert.doesNotMatch(source, /nav\.js|data-nav-page/);
  assert.match(source, /api\/trustee-invitations/);
  assert.match(source, /PKICrypto\.generateMemberKeypair/);
  assert.match(source, /PKICrypto\.deriveKekFromPassphrase/);
  assert.match(source, /requireSecureCrypto/);
  assert.match(source, /secure HTTPS connection/);
  assert.match(source, /wrapped_private_key_b64/);
  assert.match(source, /key_fingerprint !== fingerprint/);
});

it('trustee contact replacement page uses a sessionless non-authorizing confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'trustee-contact.html'), 'utf8');
  assert.match(source, /trustee-contact-verification\/validate/);
  assert.match(source, /trustee-contact-verification\/confirm/);
  assert.match(source, /does not change your key or grant document access/i);
  assert.doesNotMatch(source, /api\/auth\/login|hs_session/);
});
