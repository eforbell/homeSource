'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkPushSecret } = require('../lib/push-check');

const secret = 'hp_secret_value_1234';
const baseUrl = 'https://gateway.example.test/push/';
const ready = { ok: true, kind: 'person', active: 2, reachable: 1, devices: [] };
const response = (status, body = ready) => ({ status, json: async () => body });

test('silent verification accepts both device and person secrets, uses bearer GET only', async () => {
  for (const kind of ['device', 'person']) {
    for (const target of [secret, `${baseUrl}v1/${secret}`]) {
      let calls = 0;
      const r = await checkPushSecret(target, { baseUrl, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, `${baseUrl}v1/check`);
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.body, undefined);
        return response(200, { ...ready, kind });
      } });
      assert.equal(calls, 1);
      assert.equal(r.status, 'verified');
      assert.equal(r.reachable, 1);
      assert.match(r.message, /phone delivery is not tested/);
      assert.ok(!JSON.stringify(r).includes(secret));
    }
  }
});

test('default brrr remains usable but unverified, with no network call', async () => {
  for (const baseUrl of [undefined, '', 'https://api.brrr.now']) {
    const r = await checkPushSecret(secret, { baseUrl, fetchImpl: () => { throw new Error('must not call brrr'); } });
    assert.equal(r.status, 'unsupported');
  }
  assert.equal((await checkPushSecret(null)).status, 'unconfigured');
});

test('invalid bases, other-service URLs and ambiguous targets never leak credentials', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('unexpected'); };
  for (const baseUrl of [' ', 'nope', 'ftp://gateway.test', 'https://user:pass@gateway.test', 'https://gateway.test?', 'https://gateway.test#']) {
    assert.equal((await checkPushSecret(secret, { baseUrl, fetchImpl })).status, 'failed');
  }
  for (const target of ['https://api.brrr.now/v1/old_secret', 'https://gateway.example.test.evil/push/v1/secret', `${baseUrl}v1/${secret}?x=1`, `${baseUrl}v1/${secret}#`, 'bad secret', '../secret', 'check', 'send']) {
    assert.equal((await checkPushSecret(target, { baseUrl, fetchImpl })).status, 'failed');
  }
  assert.equal(calls, 0);
});

test('unsupported capability differs from rejected secret, device/key failures and gateway outages', async () => {
  for (const status of [404, 405, 501, 401, 403, 410, 429, 500, 502, 503, 302]) {
    const r = await checkPushSecret(secret, { baseUrl, fetchImpl: async () => response(status) });
    assert.equal(r.status, [404, 405, 501].includes(status) ? 'unsupported' : 'failed', `${status}`);
  }
});

test('only a valid homePush readiness response is verified', async () => {
  for (const body of [null, [], {}, { ok: true }, { ...ready, ok: false }, { ...ready, kind: 'unknown' },
    { ...ready, reachable: 0 }, { ...ready, reachable: '1' }, { ...ready, active: 0 }, { ...ready, active: 1.5 },
    { ...ready, reachable: 3 }]) {
    assert.equal((await checkPushSecret(secret, { baseUrl, fetchImpl: async () => response(200, body) })).status, 'failed');
  }
  const r = await checkPushSecret(secret, { baseUrl, fetchImpl: async () => ({ status: 200, json: async () => { throw new Error(secret); } }) });
  assert.equal(r.status, 'failed');
  assert.ok(!JSON.stringify(r).includes(secret));
});

test('network errors are sanitized and not misreported as unsupported', async () => {
  const r = await checkPushSecret(secret, { baseUrl, fetchImpl: async () => { throw new Error(`failed ${secret}`); } });
  assert.equal(r.status, 'failed');
  assert.ok(!JSON.stringify(r).includes(secret));
});

test('real HTTP redirect and timeout cannot send or leak a credential onward', async () => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push([req.method, req.url]);
    if (req.url.startsWith('/hang/')) return;
    res.writeHead(302, { Location: '/v1/send' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await checkPushSecret(secret, { baseUrl: base })).status, 'failed');
    assert.equal((await checkPushSecret(secret, { baseUrl: `${base}/hang`, timeoutMs: 25 })).status, 'failed');
    assert.deepEqual(paths, [['GET', '/v1/check'], ['GET', '/hang/v1/check']]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
