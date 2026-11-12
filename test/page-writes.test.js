'use strict';

// Suite identity (Home Base Feature-10): in tailnet mode every write must say it is JSON, even with no body, and only
// uploads may send a form. A page that forgets works in local mode and is refused only on a tailnet household, so
// this reads the pages' own source: every fetch that writes either names the JSON content type or sends a FormData.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const sources = fs.readdirSync(PUBLIC).filter((name) => /\.(?:js|html)$/.test(name));
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

// Each fetch(...) call that names a writing method, with its whole argument list (they span lines).
function writes(source) {
  const found = [];
  for (const match of source.matchAll(/\bfetch\(/g)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')' && --depth === 0) break;
    }
    const call = source.slice(match.index, end + 1);
    if (/method:\s*'(?:POST|PUT|PATCH|DELETE)'/.test(call)) found.push(call);
  }
  return found;
}

test('every write a page sends says it is JSON, or is an upload', () => {
  let json = 0;
  let uploads = 0;
  for (const name of sources) {
    for (const call of writes(read(name))) {
      if (/body:\s*form\b/.test(call)) { uploads += 1; continue; }
      assert.match(call, /'Content-Type':\s*'application\/json'/, `${name}: ${call}`);
      json += 1;
    }
  }
  // The shared helper (post, put, del), the three upload helpers, and the pages' own direct writes.
  assert.ok(json >= 11, `found ${json} JSON writes`);
  assert.equal(uploads, 3, 'only the upload helpers in api.js send a form');
});

test('a request helper that takes its method from the caller is only ever called with JSON writes', () => {
  // trustee-invite.html, continuity-contact.html and friends pass an options object to a local request() helper.
  let calls = 0;
  for (const name of sources) {
    const source = read(name);
    for (const [call] of source.matchAll(/\b(?:request|api)\([^;]*?method:\s*'(?:POST|PUT|PATCH|DELETE)'[^;]*;/gs)) {
      assert.match(call, /'Content-Type':\s*'application\/json'/, `${name}: ${call.slice(0, 160)}`);
      calls += 1;
    }
  }
  assert.ok(calls >= 6, `found ${calls} helper writes`);
});

test('no page posts a form natively', () => {
  for (const name of sources.filter((file) => file.endsWith('.html'))) {
    assert.doesNotMatch(read(name), /<form[^>]*\b(?:action|method)=/i, name);
  }
});
