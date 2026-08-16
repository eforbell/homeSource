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

it('lets desktop users collapse document details to widen the portrait viewer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'document.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  assert.match(html, /id="document-sidebar-toggle"/);
  assert.match(html, /aria-controls="document-sidebar"/);
  assert.match(html, /class="document-sidebar"/);
  assert.match(html, /homeSource\.documentSidebarCollapsed/);
  assert.match(html, /setAttribute\('aria-expanded', String\(!collapsed\)\)/);
  assert.match(css, /\.doc-layout\.sidebar-collapsed\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /\.doc-layout\.sidebar-collapsed \.document-sidebar\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.document-sidebar-toggle\s*\{\s*display:\s*none;/);
});
