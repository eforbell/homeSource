const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'upload.html'), 'utf8');
const importSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'import.html'), 'utf8');

test('scanner crop mode includes rotate controls and perspective toggle', () => {
  assert.match(source, /id="corner-rotate-left-btn"/);
  assert.match(source, /id="corner-rotate-right-btn"/);
  assert.match(source, /id="scan-perspective-enabled"/);
  assert.match(source, /id="preview-rotate-left-btn"/);
  assert.match(source, /id="preview-rotate-right-btn"/);
  assert.match(source, /Crop<\/button>/);
  assert.match(source, /Skip Crop<\/button>/);
});

test('scanner script supports rotating frozen frames and optional perspective correction', () => {
  assert.match(source, /function rotateCanvas\(source, degrees\)/);
  assert.match(source, /function rotateFrozenFrame\(degrees\)/);
  assert.match(source, /function rotatePreview\(degrees\)/);
  assert.match(source, /const usePerspective = document\.getElementById\('scan-perspective-enabled'\)\.checked/);
  assert.match(source, /if \(usePerspective\) \{/);
  assert.match(source, /document\.getElementById\('corner-rotate-left-btn'\)\.addEventListener\('click'/);
  assert.match(source, /document\.getElementById\('corner-rotate-right-btn'\)\.addEventListener\('click'/);
  assert.match(source, /document\.getElementById\('preview-rotate-left-btn'\)\.addEventListener\('click'/);
  assert.match(source, /document\.getElementById\('preview-rotate-right-btn'\)\.addEventListener\('click'/);
});

test('upload picker accept list includes doc/docx/txt extensions', () => {
  assert.match(source, /id="file-input"[^>]*accept="[^"]*\.doc[^"]*"/);
  assert.match(source, /id="file-input"[^>]*accept="[^"]*\.docx[^"]*"/);
  assert.match(source, /id="file-input"[^>]*accept="[^"]*\.txt[^"]*"/);
});

test('batch import picker accept list includes doc/docx/txt extensions', () => {
  assert.match(importSource, /id="batch-files"[^>]*accept="[^"]*\.doc[^"]*"/);
  assert.match(importSource, /id="batch-files"[^>]*accept="[^"]*\.docx[^"]*"/);
  assert.match(importSource, /id="batch-files"[^>]*accept="[^"]*\.txt[^"]*"/);
});
