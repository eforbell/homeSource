'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

it('trustee action page exposes one sessionless pause without document or account APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'trustee-action.html'), 'utf8');
  assert.match(source, /api\/continuity\/trustee-action\/validate/);
  assert.match(source, /api\/continuity\/trustee-action\/pause/);
  assert.match(source, /credentials:'omit'/);
  assert.match(source, /cannot open a Home Source account or reveal any letter, document, recipient, envelope, or key/i);
  assert.doesNotMatch(source, /api\/documents|api\/files|api\/encryption|api\/auth\/login/);
});
