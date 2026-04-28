'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassphrase, verifyPassphrase, parseCookie, requireAuth, requireParent } = require('../lib/auth');

describe('hashPassphrase', () => {
  it('produces a salt:hash string', () => {
    const hashed = hashPassphrase('test-phrase');
    assert.ok(hashed.includes(':'));
    const [salt, hash] = hashed.split(':');
    assert.equal(salt.length, 32, 'salt = 16 bytes hex');
    assert.equal(hash.length, 128, 'hash = 64 bytes hex');
  });

  it('produces unique hashes for same input (random salt)', () => {
    const h1 = hashPassphrase('same');
    const h2 = hashPassphrase('same');
    assert.notEqual(h1, h2);
  });
});

describe('verifyPassphrase', () => {
  it('accepts correct passphrase', () => {
    const hashed = hashPassphrase('secret');
    assert.ok(verifyPassphrase('secret', hashed));
  });

  it('rejects wrong passphrase', () => {
    const hashed = hashPassphrase('correct');
    assert.ok(!verifyPassphrase('wrong', hashed));
  });

  it('rejects null/empty stored hash', () => {
    assert.ok(!verifyPassphrase('anything', null));
    assert.ok(!verifyPassphrase('anything', ''));
    assert.ok(!verifyPassphrase('anything', 'no-colon'));
  });
});

describe('parseCookie', () => {
  it('extracts a named cookie', () => {
    assert.equal(parseCookie('hs_session=abc123; other=xyz', 'hs_session'), 'abc123');
  });

  it('returns null for missing cookie', () => {
    assert.equal(parseCookie('other=xyz', 'hs_session'), null);
  });

  it('handles null header', () => {
    assert.equal(parseCookie(null, 'hs_session'), null);
  });

  it('handles whitespace around values', () => {
    assert.equal(parseCookie('a=1; hs_session=token123; b=2', 'hs_session'), 'token123');
  });
});

describe('requireAuth', () => {
  it('returns 401 when req.member is missing', () => {
    let statusCode, body;
    const req = {};
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; }
    };
    requireAuth(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.ok(body.error.includes('Authentication'));
  });

  it('calls next when req.member is set', () => {
    let called = false;
    const req = { member: { id: 1, role: 'parent' } };
    requireAuth(req, {}, () => { called = true; });
    assert.ok(called);
  });
});

describe('requireParent', () => {
  it('returns 403 for kid role', () => {
    let statusCode, body;
    const req = { member: { id: 1, role: 'kid' } };
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; }
    };
    requireParent(req, res, () => {});
    assert.equal(statusCode, 403);
    assert.ok(body.error.includes('Parent'));
  });

  it('passes for parent role', () => {
    let called = false;
    const req = { member: { id: 1, role: 'parent' } };
    requireParent(req, {}, () => { called = true; });
    assert.ok(called);
  });

  it('returns 401 when no member at all', () => {
    let statusCode;
    const req = {};
    const res = {
      status(code) { statusCode = code; return this; },
      json() {}
    };
    requireParent(req, res, () => {});
    assert.equal(statusCode, 401);
  });
});
