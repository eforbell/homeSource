'use strict';

const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const brrr = require('../lib/brrr');

const ORIGINAL = process.env.PUSH_BASE_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUSH_BASE_URL;
  else process.env.PUSH_BASE_URL = ORIGINAL;
});

const BRRR_TARGET = 'https://api.brrr.now/v1/secret-value-1234';

test('unset, targets are exactly what they were', () => {
  delete process.env.PUSH_BASE_URL;
  assert.equal(brrr.normalizeBrrrTarget('secret-value-1234'), BRRR_TARGET);
  assert.equal(brrr.normalizeBrrrTarget(BRRR_TARGET), BRRR_TARGET);
  assert.throws(() => brrr.normalizeBrrrTarget('http://api.brrr.now/v1/secret-value-1234'), TypeError);
  assert.throws(() => brrr.normalizeBrrrTarget('https://evil.example.test/v1/secret-value-1234'), TypeError);
  assert.throws(() => brrr.normalizeBrrrTarget('https://api.brrr.now/v1/short'), /invalid/);
});

test('a configured service is used, including a path prefix', () => {
  process.env.PUSH_BASE_URL = 'https://gateway.example.test/push/';
  const target = 'https://gateway.example.test/push/v1/hp_secret-value-1234';
  assert.equal(brrr.normalizeBrrrTarget('hp_secret-value-1234'), target);
  assert.equal(brrr.normalizeBrrrTarget(target), target);
  assert.throws(() => brrr.normalizeBrrrTarget('https://gateway.example.test/push/v1/short'), /invalid/);
});

test('after a switchover, a target saved for the old service is refused but still displays', () => {
  process.env.PUSH_BASE_URL = 'http://127.0.0.1:3014';
  assert.throws(() => brrr.normalizeBrrrTarget(BRRR_TARGET), (err) => err instanceof TypeError && /different push service/.test(err.message) && !err.message.includes('secret-value'));
  assert.equal(brrr.isCurrentTarget(BRRR_TARGET), false);
  assert.equal(brrr.isCurrentTarget('http://127.0.0.1:3014/v1/hp_secret-value-1234'), true);
  assert.equal(brrr.maskSecret(BRRR_TARGET), '••••1234');
});

test('a malformed PUSH_BASE_URL fails the send and never falls back to brrr', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200 }; };
  for (const bad of ['not a url', 'ftp://gateway.example.test', 'https://user:pass@gateway.example.test']) {
    process.env.PUSH_BASE_URL = bad;
    await assert.rejects(brrr.sendBrrrNotification('hp_secret-value-1234', { title: 't', message: 'm' }, { fetchImpl }), /PUSH_BASE_URL/, bad);
    assert.equal(brrr.isCurrentTarget(BRRR_TARGET), false);
  }
  assert.equal(called, false);
});

test('a blank or delimiter-ended PUSH_BASE_URL is malformed too, but an empty one means unset', () => {
  for (const bad of ['   ', 'https://gateway.example.test/#', 'https://gateway.example.test/?']) {
    process.env.PUSH_BASE_URL = bad;
    assert.throws(() => brrr.normalizeBrrrTarget('hp_secret-value-1234'), /PUSH_BASE_URL/, JSON.stringify(bad));
  }
  process.env.PUSH_BASE_URL = '';
  assert.equal(brrr.normalizeBrrrTarget('secret-value-1234'), BRRR_TARGET);
});

test('a value that is neither a secret nor a clean URL is refused without being echoed', () => {
  delete process.env.PUSH_BASE_URL;
  for (const target of ['https:\n//old.example.test/v1/oldsecret123456', 'old secret123456', '../oldsecret123456']) {
    assert.throws(() => brrr.normalizeBrrrTarget(target), (err) => err instanceof TypeError && !err.message.includes('oldsecret'), JSON.stringify(target));
  }
});
