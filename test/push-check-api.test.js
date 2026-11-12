'use strict';

// Exercise the actual registered handlers in isolation: no real household DB, no secrets,
// no push sends. Existing auth/suite integration tests cover the surrounding middleware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { checkPushSecret } = require('../lib/push-check');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const prefix = '/api/continuity/notification-channels/brrr';
const secret = 'hp_saved_secret_1234';

function harness(method, outcome = 'verified', savedSecret = secret) {
  const calls = [], queries = [], guards = [];
  const guard = name => { const fn = () => {}; fn.guardName = name; return fn; };
  let handler;
  const register = (_path, ...handlers) => {
    guards.push(...handlers.slice(0, -1).map(fn => fn.guardName));
    handler = handlers.at(-1);
  };
  const query = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: savedSecret ? [{ member_id: 7, label: '', enabled: false, target_secret: savedSecret }] : [] };
  };
  const check = target => {
    calls.push(target);
    return checkPushSecret(target, { baseUrl: 'https://gateway.test', fetchImpl: async () => ({
      status: outcome === 'verified' ? 200 : 401,
      json: async () => ({ ok: true, kind: 'person', active: 2, reachable: 2 }),
    }) });
  };
  const safeChannel = row => ({ member_id: row.member_id, enabled: row.enabled, has_secret: !!row.target_secret });
  const context = {
    app: { [method]: register }, router: { [method]: register },
    requireAuth: guard('requireAuth'), requireSettingsAuth: guard('requireSettingsAuth'), requireParent: guard('requireParent'),
    pool: { query }, db: { query }, query, checkPushSecret: check,
    memberById: async () => ({ id: 7, name: 'Operator', role: 'parent' }),
    getMember: async () => ({ id: 7, name: 'Operator', role: 'parent' }),
    maskSecret: () => '••••1234', maskChannel: safeChannel,
    continuityReadiness: {
      getBrrrChannel: async id => { queries.push({ owner: id }); return savedSecret ? { target_secret: savedSecret } : null; },
      saveBrrrChannel: async options => { queries.push({ write: options }); return { id: 1, enabled: true, has_secret: true }; },
    },
    audit: { log: async () => {} },
  };
  const route = `${method === 'post' ? prefix + '/check' : prefix}`;
  const owner = source.includes(`router.${method}('${route}'`) ? 'router' : 'app';
  const start = source.indexOf(`${owner}.${method}('${route}'`);
  assert.ok(start >= 0, `registered ${route}`);
  const end = source.indexOf('\n});', start);
  vm.runInNewContext(source.slice(start, end + 4), context);
  assert.deepEqual(guards, ['requireAuth', 'requireParent']);
  const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, set(k, v) { this.headers[k] = v; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
  const req = { params: { id: '7', memberId: '7' }, member: { id: 7 }, body: { enabled: true, secret, target_secret: secret } };
  return { run: () => handler(req, res), req, res, calls, queries };
}

test('recheck reads saved target, ignores submitted target, does not write or send', async () => {
  const h = harness('post');
  h.req.body = { secret: 'attacker', target_secret: 'https://other.test/v1/nope' };
  await h.run();
  assert.equal(h.res.statusCode, 200);
  assert.equal(h.res.body.status, 'verified');
  assert.equal(h.res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(h.calls, [secret]);
  assert.ok(h.queries.every(q => q.owner === 7 || /^SELECT/.test(q.sql)));
  assert.ok(!JSON.stringify(h.res.body).includes(secret));
});

test('recheck failures are not successful registrations; missing secrets remain unconfigured', async () => {
  const h = harness('post', 'failed');
  await h.run();
  assert.equal(h.res.body.status, 'failed');
  const empty = harness('post', 'verified', null);
  await empty.run();
  assert.equal(empty.res.body.status, 'unconfigured');
});

test('saving returns verification without losing a saved secret when check fails', async () => {
  for (const outcome of ['verified', 'failed']) {
    const h = harness('put', outcome);
    await h.run();
    assert.equal(h.res.statusCode, 200);
    assert.equal(h.res.body.verification?.status, outcome);
    assert.deepEqual(h.calls, [secret]);
    assert.ok(h.queries.some(q => q.write || /INSERT INTO member_notification_channels/.test(q.sql)));
    assert.ok(!JSON.stringify(h.res.body).includes(secret));
  }
});
