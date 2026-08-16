'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
  assert.match(html, /matchMedia\('\(min-width: 769px\)'\)/);
  assert.match(html, /addEventListener\('change', renderDocumentSidebarState\)/);
  assert.match(css, /\.doc-layout\.sidebar-collapsed\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /\.doc-layout\.sidebar-collapsed \.document-sidebar\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.document-sidebar-toggle\s*\{\s*display:\s*none;/);
});

it('synchronizes persisted sidebar state across desktop and mobile viewports', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'document.html'), 'utf8');
  const start = html.indexOf("    const documentLayout = document.querySelector('.doc-layout');");
  const end = html.indexOf('    function isEncryptedDoc(doc)', start);
  const script = html.slice(start, end);
  const classes = new Set();
  const listeners = {};
  const mediaListeners = {};
  const layout = { classList: {
    toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
  } };
  const toggle = {
    textContent: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, handler) { listeners[name] = handler; },
  };
  const media = {
    matches: true,
    addEventListener(name, handler) { mediaListeners[name] = handler; },
  };
  const storage = new Map([['homeSource.documentSidebarCollapsed', 'true']]);
  vm.runInNewContext(script, {
    document: { querySelector: () => layout, getElementById: () => toggle },
    window: { matchMedia: () => media },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });

  assert.equal(classes.has('sidebar-collapsed'), true);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(toggle.textContent, 'Show details');

  media.matches = false;
  mediaListeners.change();
  assert.equal(classes.has('sidebar-collapsed'), false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');

  media.matches = true;
  mediaListeners.change();
  assert.equal(classes.has('sidebar-collapsed'), true);
  listeners.click();
  assert.equal(classes.has('sidebar-collapsed'), false);
  assert.equal(storage.get('homeSource.documentSidebarCollapsed'), 'false');
});
