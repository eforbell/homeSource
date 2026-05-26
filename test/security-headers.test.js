'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, url } = require('./helpers');

describe('security headers', () => {
  before(async () => {
    await startServer();
  });

  after(async () => {
    await stopServer();
  });

  it('sets baseline security headers on unauthenticated HTML pages', async () => {
    const res = await fetch(url('login.html'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy') || '', /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https:\/\/cdn\.jsdelivr\.net/);
    assert.match(res.headers.get('permissions-policy') || '', /publickey-credentials-create=\(self\)/);
  });
});
