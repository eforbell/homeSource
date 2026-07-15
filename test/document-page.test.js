'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');
const assert = require('node:assert/strict');

it('renders trustee names as document holders without treating them as members', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'document.html'), 'utf8');
  assert.match(source, /holder\.trustee_name\s*\|\|\s*holder\.member_name/);
  assert.match(source, /Trustee #\$\{holder\.trustee_id\}/);
  assert.match(source, /registered holder keys/);
  assert.match(source, /Unknown holder/);
});
