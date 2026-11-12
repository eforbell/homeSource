'use strict';

// Suite identity (Home Base Feature-10) in tailnet mode: the gate, the request guard, the outsiders' token pages and
// member linking. A fake directory snapshot stands in for Home Base; requests carry the identity headers nginx would.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { signToken } = require('sovereign-auth');
const { startServer, stopServer, resetDatabase, createMember, createTestDocument, getPool } = require('./helpers');
const app = require('../server');
const { createSuiteIdentity, publicPath } = require('../lib/suite-identity');
const { createSuiteLinks } = require('../lib/suite-links');
const { createSession } = require('../lib/auth');
const { createShareLink } = require('../lib/share');

const SOCKET = 'unix:/run/sovereign-apps/home-source/app.sock';
const HOST = 'smith-source.example-tailnet.ts.net';
const ORIGIN = `https://${HOST}`;
const SIBLING = 'https://smith-home.example-tailnet.ts.net';
const TAILNET = { SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_LISTEN: SOCKET, SOVEREIGN_HOMEBASE_UID: '998', APP_PUBLIC_URL: `${ORIGIN}/source/` };
const noSnapshot = { current: () => ({ ok: false, reason: 'missing', message: 'no snapshot' }) };
const unlinked = { findLinked: async () => null };

// Home Base's signing key, which the snapshot publishes and passkey checks are signed with.
const SIGNING = crypto.generateKeyPairSync('ed25519');
const HOUSEHOLD = 'test-household';

// A directory snapshot as the library hands it over: members by stable user ID.
function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['home-source'], role: 'parent', ...member }));
  const snapshot = { household: HOUSEHOLD, globalEpoch: 1, keys: new Map([['test-key', SIGNING.publicKey]]), members: list, byUserId: new Map(list.map((member) => [member.userId, member])) };
  return { current: () => ({ ok: true, snapshot }) };
}
const PARENT = { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'Parent' };
const KID = { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: 'Kid', role: 'kid' };
const NEW_PARENT = { userId: 'u-new-parent', memberId: 'm_new_parent', login: 'new-parent@example.com', name: 'New Parent' };
const NEW_KID = { userId: 'u-new-kid', memberId: 'm_new_kid', login: 'new-kid@example.com', name: 'New Kid', role: 'kid' };
const NO_ACCESS = { userId: 'u-other', memberId: 'm_other', login: 'other@example.com', name: 'No Access', apps: ['family-plan'] };
const DIRECTORY = [PARENT, KID, NEW_PARENT, NEW_KID, NO_ACCESS];

// The cookie Home Base's passkey check sets on this hostname (wire contract, section 7), from a check `age` seconds ago.
function passkeyCookie(member, { age = 0, name = '__Host-sv_assurance', ...claims } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { typ: 'assurance', kid: 'test-key', household: HOUSEHOLD, aud: HOST, sub: member.userId, sid: 's1', cred: 'c1', kind: 'synced', epoch: 1, global_epoch: 1, auth_time: now - age, iat: now - age, exp: now - age + 31 * 86400, ...claims };
  return `${name}=${signToken(payload, SIGNING.privateKey)}`;
}
// Who nginx says is asking. A parent also carries a passkey check from just now, as they would in a browser: what
// happens without one is tested on its own below. Kids have no passkeys.
const as = (member, cookie = member.role === 'kid' ? null : passkeyCookie(member)) => ({ 'x-sovereign-user-id': member.userId, 'x-sovereign-login': member.login, ...(cookie ? { cookie } : {}) });
// What a browser sends for a page's own fetch, a link opened from an email or typed in, and a sibling hostname's fetch.
const OWN_PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const NAVIGATION = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const JSON_WRITE = { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'application/json' };

describe('Suite identity (tailnet mode)', () => {
  let server;
  let base;
  let pool;
  let parentRow;
  let kidRow;

  // Plain http, not fetch: fetch sets Sec-Fetch-Mode itself, and these tests are about exactly what a browser sends.
  const send = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([key, value]) => [key, String(value)])), text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  const get = (path, headers) => send('GET', path, headers);
  const code = async (answer) => (await answer.json()).code;
  const tailnet = (members = DIRECTORY) => app.setSuiteIdentityForTests(TAILNET, { reader: snapshotOf(members) });

  before(async () => {
    base = await startServer();
    pool = getPool();
    await resetDatabase();
    // A tailnet household needs no passphrases; this one keeps one, as a household that used local mode first would.
    parentRow = await createMember('Suite Parent', 'parent', 'parent-passphrase');
    kidRow = await createMember('Suite Kid', 'kid');
    await pool.query('UPDATE family_members SET suite_member_id = $1 WHERE id = $2', [PARENT.memberId, parentRow.id]);
    await pool.query('UPDATE family_members SET suite_member_id = $1 WHERE id = $2', [KID.memberId, kidRow.id]);
  });

  afterEach(() => app.setSuiteIdentityForTests({}));

  after(async () => {
    app.setSuiteIdentityForTests({});
    await resetDatabase();
    await stopServer();
  });

  it('no SOVEREIGN_AUTH_MODE means local: installs from before Home Base set one keep their own sign-in', () => {
    assert.equal(createSuiteIdentity({}).mode, 'local');
    assert.equal(createSuiteIdentity({ SOVEREIGN_AUTH_MODE: 'local' }).mode, 'local');
    assert.equal(createSuiteIdentity({}).tailnet, false);
  });

  it('a configuration the app cannot trust refuses to start', () => {
    for (const mode of ['', ' ', 'Tailnet', 'off', 'true']) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_AUTH_MODE: mode }, unlinked), /SOVEREIGN_AUTH_MODE/, `mode '${mode}'`);
    }
    // Identity headers are trusted only on the app's socket, which only nginx can reach.
    for (const listen of [undefined, '', '127.0.0.1:3008']) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_LISTEN: listen }, unlinked), /SOVEREIGN_LISTEN/);
    }
    for (const uid of [undefined, '', '0', '-1', '01', '1e3', '4294967295', '99999999999', 'homebase']) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_HOMEBASE_UID: uid }, unlinked), /SOVEREIGN_HOMEBASE_UID/, `uid '${uid}'`);
    }
    for (const url of [undefined, '', 'source', `http://${HOST}/source/`]) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, { ...unlinked, reader: noSnapshot }), /APP_PUBLIC_URL/, `url '${url}'`);
    }
    // Redirects are built on the path, so it must stay on this host.
    for (const url of [`${ORIGIN}//evil.example/`, `${ORIGIN}/source//x/`, `${ORIGIN}/sou%2Frce/`]) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, { ...unlinked, reader: noSnapshot }), /APP_PUBLIC_URL/, `url '${url}'`);
    }
    assert.equal(publicPath(`${ORIGIN}/source`), '/source/');
    assert.throws(() => createSuiteIdentity(TAILNET, { reader: noSnapshot }), /find linked members/);
    assert.equal(createSuiteIdentity(TAILNET, { ...unlinked, reader: noSnapshot }).mode, 'tailnet');
  });

  it('anyone the directory does not admit is refused, with a page saying who to ask', async () => {
    tailnet();
    const refusal = async (headers, status, expected) => {
      const api = await get('/api/documents', { ...headers, ...OWN_PAGE });
      assert.equal(api.status, status);
      assert.equal(api.headers.get('cache-control'), 'no-store');
      assert.equal(await code(api), expected);
      const page = await get('/documents.html', { ...headers, ...NAVIGATION });
      assert.equal(page.status, status);
      assert.match(page.headers.get('content-type'), /html/);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      return page.text();
    };
    await refusal({}, 403, 'not_member');
    await refusal(as({ userId: 'u-stranger', login: 'stranger@example.com' }), 403, 'not_member');
    await refusal(as(NO_ACCESS), 403, 'not_member');
    // A mismatched login: nginx names one member, the login another.
    await refusal({ 'x-sovereign-user-id': PARENT.userId, 'x-sovereign-login': KID.login }, 403, 'not_member');
    assert.match(await refusal(as(NEW_KID), 403, 'not_linked'), /Ask a parent to link you/);
    // A device with a tag has no identity, even listed in the directory.
    const tagged = { userId: 'u-tag', memberId: 'm_tag', login: 'tagged-devices', name: 'A Server' };
    tailnet([...DIRECTORY, tagged]);
    await refusal(as(tagged), 403, 'not_member');
    assert.ok(!createSuiteIdentity(TAILNET, { ...unlinked, reader: snapshotOf([...DIRECTORY, tagged]) }).directory().some((member) => member.memberId === 'm_tag'));
    // A member Home Base has disabled.
    tailnet([{ ...PARENT, status: 'disabled' }]);
    await refusal(as(PARENT), 403, 'not_member');
    const offered = createSuiteIdentity(TAILNET, { ...unlinked, reader: snapshotOf([{ ...PARENT, status: 'disabled' }, KID]) }).directory();
    assert.deepEqual(offered.map((member) => member.memberId), [KID.memberId], 'nor can they be linked');
    // No snapshot: can't tell, so nobody gets in.
    app.setSuiteIdentityForTests(TAILNET, { reader: noSnapshot });
    await refusal(as(PARENT), 503, 'directory');
  });

  it('a directory kid linked to a parent\'s row is refused: a kid\'s account never opens a parent\'s documents', async () => {
    tailnet([{ ...PARENT, role: 'kid' }]);
    for (const path of ['/api/documents', '/api/auth/me', '/api/stats', '/API/documents/']) {
      const answer = await get(path, { ...as(PARENT), ...OWN_PAGE });
      assert.equal(answer.status, 403, path);
      assert.equal(await code(answer), 'stale_link', path);
    }
    const page = await get('/documents.html', { ...as(PARENT), ...NAVIGATION });
    assert.equal(page.status, 403);
    assert.match(await page.text(), /Ask a parent to link you again/);
  });

  it('a parent nobody has linked is sent to the link page, and reaches nothing else', async () => {
    tailnet();
    const parent = { ...as(NEW_PARENT), ...OWN_PAGE };
    for (const path of ['/', '/documents.html', '/settings.html', '/link.html', '/setup/', '/LINK']) {
      const page = await get(path, { ...as(NEW_PARENT), ...NAVIGATION });
      assert.equal(page.status, 303, path);
      assert.equal(page.headers.get('location'), '/source/link', path);
    }
    for (const path of ['/api/documents', '/api/members', '/api/auth/me', '/api/stats', '/API/bootstrap', '/api/bootstrap/', '/api/suite/links/x']) {
      const answer = await get(path, parent);
      assert.equal(answer.status, 403, path);
      assert.equal(await code(answer), 'not_linked', path);
    }
    // Setup is theirs while there's no household; it refuses once there is one, and says nothing about its size.
    const setup = await get('/api/bootstrap', parent);
    assert.equal(setup.status, 200);
    assert.deepEqual(Object.keys(await setup.json()).sort(), ['app', 'bootstrap', 'status', 'tailnet', 'version'], 'whether setup is needed, and no member count');
    const household = await send('POST', '/api/bootstrap/household', { ...as(NEW_PARENT), ...JSON_WRITE }, JSON.stringify({ members: [{ name: 'x', role: 'parent' }] }));
    assert.equal(household.status, 409);
    const setupPage = await get('/setup', { ...as(NEW_PARENT), ...NAVIGATION });
    assert.equal(setupPage.status, 302, 'the setup page sends them on once a household exists');
    // A write that isn't setup or linking is refused before its route.
    const write = await send('POST', '/api/members', { ...as(NEW_PARENT), ...JSON_WRITE }, JSON.stringify({ name: 'x' }));
    assert.equal(write.status, 403);
    assert.equal(await code(write), 'not_linked');
  });

  it('local sessions mean nothing: a stored session opens nothing and lifts nobody', async () => {
    const { token } = await createSession(parentRow.id);
    const cookie = { cookie: `hs_session=${token}` };
    assert.equal((await get('/api/auth/me', { ...cookie, ...OWN_PAGE })).status, 200, 'local mode signs in with it');
    tailnet();
    const stranger = await get('/api/auth/me', { ...cookie, ...OWN_PAGE });
    assert.equal(stranger.status, 403);
    assert.equal(await code(stranger), 'not_member');
    const kid = await get('/api/auth/me', { ...as(KID), ...cookie, ...OWN_PAGE });
    assert.equal((await kid.json()).id, kidRow.id, 'a kid with a parent\'s cookie is still that kid');
    const { rows } = await pool.query('SELECT 1 FROM sessions WHERE token = $1', [token]);
    assert.equal(rows.length, 1, 'and the session is kept for a return to local mode');
  });

  describe('linking household members', () => {
    let spare;
    const putLink = (id, value, member = PARENT) => send('PUT', `/api/suite/links/${id}`, { ...as(member), ...JSON_WRITE }, JSON.stringify({ suite_member_id: value }));

    before(async () => {
      spare = await createMember('Spare Parent', 'parent');
    });
    afterEach(() => pool.query('UPDATE family_members SET suite_member_id = NULL WHERE id = $1', [spare.id]));

    it('a parent nobody has linked can link themselves, and then gets past the link page', async () => {
      tailnet();
      const parent = { ...as(NEW_PARENT), ...OWN_PAGE };
      const page = await get('/link', { ...as(NEW_PARENT), ...NAVIGATION });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(await page.text(), /Household Members/);
      const list = await (await get('/api/suite/links', parent)).json();
      assert.equal(list.you, NEW_PARENT.memberId);
      assert.ok(list.members.some((member) => member.id === spare.id));
      assert.ok(!list.directory.some((person) => person.memberId === NO_ACCESS.memberId), 'only people with access to Home Source');
      assert.equal((await get('/documents.html', { ...as(NEW_PARENT), ...NAVIGATION })).status, 303);
      const linked = await putLink(spare.id, NEW_PARENT.memberId, NEW_PARENT);
      assert.equal(linked.status, 200);
      assert.equal((await linked.json()).suite_member_id, NEW_PARENT.memberId);
      assert.notEqual((await get('/documents.html', { ...as(NEW_PARENT), ...NAVIGATION })).status, 303);
      const { rows: [entry] } = await pool.query("SELECT entity_id, actor_id, details FROM audit_log WHERE action = 'suite.link_changed' ORDER BY id DESC LIMIT 1");
      assert.deepEqual(entry, { entity_id: spare.id, actor_id: null, details: { by: NEW_PARENT.memberId, linked: true } }, 'logged by member ID, never a name');
    });

    it('a link can be cleared, which puts that parent back at the link page', async () => {
      tailnet();
      assert.equal((await putLink(spare.id, NEW_PARENT.memberId)).status, 200);
      assert.equal((await putLink(spare.id, null)).status, 200);
      assert.equal((await get('/documents.html', { ...as(NEW_PARENT), ...NAVIGATION })).status, 303);
    });

    it('only someone the directory admits can be linked, and only once', async () => {
      tailnet();
      assert.equal(await code(await putLink(spare.id, 'm_nobody')), 'unknown_member');
      assert.equal(await code(await putLink(spare.id, NO_ACCESS.memberId)), 'unknown_member');
      for (const value of [undefined, 7, {}, '']) assert.equal((await putLink(spare.id, value)).status, 400, JSON.stringify(value));
      const taken = await putLink(spare.id, PARENT.memberId);
      assert.equal(taken.status, 409);
      assert.equal(await code(taken), 'already_linked');
    });

    it('a kid\'s account never takes a parent\'s row, because a kid\'s pages show that row\'s documents', async () => {
      tailnet();
      const refused = await putLink(spare.id, NEW_KID.memberId);
      assert.equal(refused.status, 400);
      assert.equal(await code(refused), 'role_mismatch');
      const { rows: [row] } = await pool.query('SELECT suite_member_id FROM family_members WHERE id = $1', [spare.id]);
      assert.equal(row.suite_member_id, null);
    });

    it('an unknown member is a 404, even one too large for the column', async () => {
      tailnet();
      for (const id of ['2147483647', '2147483648', '999999999999999999']) {
        const answer = await putLink(id, PARENT.memberId);
        assert.equal(answer.status, 404, id);
        assert.equal(await code(answer), 'not_found', id);
      }
    });

    it('a kid can\'t see or change links, and a row saying parent doesn\'t help', async () => {
      tailnet();
      const kid = { ...as(KID), ...OWN_PAGE };
      assert.equal((await get('/api/suite/links', kid)).status, 403);
      assert.equal((await putLink(kidRow.id, null, KID)).status, 403);
      assert.notEqual((await get('/link', { ...as(KID), ...NAVIGATION })).status, 200);
      tailnet([{ ...PARENT, role: 'kid' }]);
      assert.equal((await get('/api/suite/links', { ...as(PARENT), ...OWN_PAGE })).status, 403, 'a directory kid linked to a parent row');
      const { rows: [row] } = await pool.query('SELECT suite_member_id FROM family_members WHERE id = $1', [kidRow.id]);
      assert.equal(row.suite_member_id, KID.memberId);
    });

    it('the routes check the directory\'s role themselves, behind the gate', async () => {
      const inner = express();
      inner.use((req, _res, next) => { req.suiteMember = { role: req.headers['x-role'] || 'kid', memberId: KID.memberId }; next(); });
      inner.use(express.json());
      inner.use(createSuiteLinks(() => ({ tailnet: true, directory: () => null })));
      const listener = inner.listen(0, '127.0.0.1');
      await new Promise((resolve) => listener.once('listening', resolve));
      try {
        const url = `http://127.0.0.1:${listener.address().port}`;
        assert.equal((await fetch(`${url}/link`)).status, 403);
        assert.equal((await fetch(`${url}/api/suite/links`)).status, 403);
        assert.equal((await fetch(`${url}/api/suite/links/${spare.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"suite_member_id":null}' })).status, 403);
        // And without a directory, a parent links nobody.
        assert.equal((await fetch(`${url}/api/suite/links`, { headers: { 'x-role': 'parent' } })).status, 503);
        const put = await fetch(`${url}/api/suite/links/${spare.id}`, { method: 'PUT', headers: { 'x-role': 'parent', 'content-type': 'application/json' }, body: JSON.stringify({ suite_member_id: PARENT.memberId }) });
        assert.equal(put.status, 503);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
    });

    it('none of it exists in local mode', async () => {
      assert.equal((await get('/link', NAVIGATION)).status, 404);
      assert.equal((await get('/api/suite/links', OWN_PAGE)).status, 404);
      assert.equal((await send('PUT', `/api/suite/links/${spare.id}`, { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ suite_member_id: PARENT.memberId }))).status, 404);
    });

    it('linking is refused from anywhere but the app\'s own page', async () => {
      tailnet();
      const body = JSON.stringify({ suite_member_id: NEW_PARENT.memberId });
      const sibling = await send('PUT', `/api/suite/links/${spare.id}`, { ...as(PARENT), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: SIBLING, 'content-type': 'application/json' }, body);
      assert.equal(sibling.status, 403);
      const form = await send('PUT', `/api/suite/links/${spare.id}`, { ...as(PARENT), ...OWN_PAGE, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body);
      assert.equal(form.status, 403);
      const { rows: [row] } = await pool.query('SELECT suite_member_id FROM family_members WHERE id = $1', [spare.id]);
      assert.equal(row.suite_member_id, null);
    });
  });

  it('writes are JSON from this origin only, and only the upload routes take a file', async () => {
    tailnet();
    const parent = as(PARENT);
    const refused = async (path, headers, reason) => {
      const answer = await send('POST', path, { ...parent, ...headers }, '{}');
      assert.equal(answer.status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.equal(answer.headers.get('cache-control'), 'no-store');
      assert.equal((await answer.json()).reason, reason, path);
    };
    await refused('/api/tags', { ...OWN_PAGE, 'content-type': 'application/json' }, 'origin_missing');
    await refused('/api/tags', { ...OWN_PAGE, origin: SIBLING, 'content-type': 'application/json' }, 'origin_mismatch');
    await refused('/api/tags', { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'content_type');
    await refused('/api/tags', { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'text/plain' }, 'content_type');
    await refused('/api/tags', { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }, 'content_type');
    await refused('/api/tags', { ...OWN_PAGE, origin: ORIGIN }, 'content_type');
    // A sibling hostname is the same site, and refused all the same.
    await refused('/api/tags', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: ORIGIN, 'content-type': 'application/json' }, 'not_same_origin');
    await refused('/api/tags', { 'content-type': 'application/json', origin: ORIGIN }, 'fetch_metadata_missing');
    // Each upload route takes a file from this origin, and still nothing from any other.
    const upload = { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' };
    for (const path of ['/api/documents', '/api/documents/scan-multi', '/api/documents/1/encrypt', '/api/documents/1/files', '/api/import/batches/1/items']) {
      const answer = await send('POST', path, { ...parent, ...upload }, '--x--\r\n');
      assert.ok(!(answer.status === 403 && (await answer.json()).error === 'request_refused'), `${path} takes an upload`);
      await refused(path, { ...upload, origin: SIBLING }, 'origin_mismatch');
      await refused(path, { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'text/plain' }, 'content_type');
    }
    // An allowlist that admits is exact: another spelling of an upload route takes JSON only.
    for (const path of ['/API/documents', '/api/documents/', '/api/documents/01/files', '/api/import/batches/1/items/']) {
      await refused(path, upload, 'content_type');
    }
  });

  it('other sites and sibling hostnames read nothing: only the app\'s own pages and top-level navigation get through', async () => {
    tailnet();
    const parent = as(PARENT);
    for (const site of ['same-site', 'cross-site']) {
      for (const headers of [{ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }]) {
        for (const path of ['/api/documents', '/api/thumbnails/x.jpg', '/api/share/abc', '/check-in']) {
          const answer = await get(path, { ...parent, 'sec-fetch-site': site, ...headers });
          assert.equal(answer.status, 403, `${site} ${JSON.stringify(headers)} ${path}`);
          assert.equal((await answer.json()).reason, 'not_same_origin');
          assert.match(answer.headers.get('vary'), /Sec-Fetch-Site/);
        }
      }
    }
    assert.equal((await get('/api/documents', parent)).status, 403, 'no fetch metadata');
    assert.equal((await get('/api/documents', { ...parent, 'sec-fetch-site': 'Same-Origin' })).status, 403, 'malformed fetch metadata');
    const linked = await get('/check-in', { ...parent, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    assert.equal(linked.status, 200, 'a link to a page still opens it');
  });

  it('a navigation can\'t reach the API: only a document\'s file, a backup and a shared file open that way', async () => {
    tailnet();
    for (const member of [PARENT, KID, null]) {
      for (const path of ['/api/documents', '/api/documents/1', '/api/stats', '/api/auth/me', '/api/share/abc', '/api/backup/status',
        '/API/documents', '/Api/stats/', '/api/documents/1/files/1/download/', '/API/documents/1/files/1/download', '/api/share/abc/files/1/download/x',
        '/api/backup/download/x/y', '/API/backup/download/x']) {
        const answer = await get(path, { ...(member ? as(member) : {}), ...NAVIGATION });
        assert.equal(answer.status, 403, path);
        assert.equal(answer.headers.get('cache-control'), 'no-store');
        assert.equal(await code(answer), 'not_a_page', path);
      }
    }
    for (const path of ['/api/documents/999999/files/1/download', '/api/backup/download/none.tar.gz', '/api/share/abc/files/1/download']) {
      const answer = await get(path, { ...as(PARENT), ...NAVIGATION });
      assert.notEqual(answer.headers.get('content-type')?.includes('json') && (await answer.json()).code, 'not_a_page', path);
    }
    // In an iframe on the app's own page, too.
    const framed = await get('/api/documents/999999/files/1/download', { ...as(PARENT), 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' });
    assert.notEqual(framed.status === 403 && (await framed.json()).code, 'not_a_page');
  });

  it('Home Base\'s probes and the page assets need no member and no fetch metadata; assets carry no data', async () => {
    tailnet();
    assert.equal((await get('/api/health')).status, 200);
    assert.equal((await get('/api/ready')).status, 200);
    for (const path of ['/style.css', '/api.js', '/favicon.svg', '/sovereign-fonts.css']) {
      assert.equal((await get(path, OWN_PAGE)).status, 200, path);
    }
    assert.equal((await get('/documents.html', OWN_PAGE)).status, 403, 'a page is not an asset');
    assert.equal((await get('/api/x.js', OWN_PAGE)).status, 403, 'nor is an API path that looks like one');
    assert.equal((await get('/vendor/jscanify.js', OWN_PAGE)).status, 403, 'only root-level assets are open');
    assert.equal((await get('/api/thumbnails/x.jpg', OWN_PAGE)).status, 403, 'thumbnails need a member');
    assert.equal((await send('POST', '/style.css', { ...JSON_WRITE }, '{}')).status, 403, 'and an asset is open to reads only');
  });

  describe('the directory\'s role', () => {
    let parentDoc;
    let kidDoc;
    let sharedDoc;
    let kidKey;

    before(async () => {
      parentDoc = await createTestDocument(parentRow.id, { title: 'Parent Only' });
      kidDoc = await createTestDocument(kidRow.id, { title: 'Kid Own' });
      sharedDoc = await createTestDocument(parentRow.id, { title: 'Shared With Kid', owner_ids: [parentRow.id, kidRow.id] });
      ({ rows: [kidKey] } = await pool.query(
        `INSERT INTO encryption_keys (key_type, member_id, public_key, encrypted_private_key, key_fingerprint, label)
         VALUES ('member', $1, 'pk', 'epk', 'fp-kid', 'Kid key') RETURNING id`, [kidRow.id]));
    });

    it('a kid reads their own and shared documents, each answer scoped to them', async () => {
      tailnet();
      const kid = { ...as(KID), ...OWN_PAGE };
      const me = await (await get('/api/auth/me', kid)).json();
      assert.deepEqual([me.id, me.role, me.tailnet], [kidRow.id, 'kid', true]);
      const { documents } = await (await get('/api/documents', kid)).json();
      assert.deepEqual(documents.map((doc) => doc.id).sort(), [kidDoc.id, sharedDoc.id].sort());
      for (const doc of [kidDoc, sharedDoc]) {
        for (const path of ['', '/magicindex-status', '/links']) assert.equal((await get(`/api/documents/${doc.id}${path}`, kid)).status, 200, `${doc.title}${path}`);
      }
      // Reachable, and the route itself answers for this kid only.
      assert.equal((await get(`/api/documents/${parentDoc.id}`, kid)).status, 403, 'a parent\'s document');
      assert.equal((await get(`/api/documents/${parentDoc.id}/files/1/download`, kid)).status, 403);
      assert.equal((await get(`/api/documents/${kidDoc.id}/files/999999/download`, kid)).status, 404);
      assert.equal((await get(`/api/documents/${kidDoc.id}/key-info`, kid)).status, 200);
      assert.equal((await get(`/api/documents/${parentDoc.id}/key-info`, kid)).status, 403);
      assert.equal((await get(`/api/members/${kidRow.id}/keys`, kid)).status, 200);
      assert.equal((await get(`/api/members/${parentRow.id}/keys`, kid)).status, 403, 'only their own keys');
      assert.equal((await get(`/api/members/${kidRow.id}/keys/${kidKey.id}/material`, kid)).status, 200);
      assert.equal((await get(`/api/members/${parentRow.id}/keys/${kidKey.id}/material`, kid)).status, 403);
      const unlock = await send('POST', `/api/members/${parentRow.id}/keys/webauthn/assertion-options`, { ...as(KID), ...JSON_WRITE }, '{}');
      assert.equal(unlock.status, 403, 'unlocking only their own key');
      assert.notEqual((await (await send('POST', `/api/members/${kidRow.id}/keys/webauthn/assertion-options`, { ...as(KID), ...JSON_WRITE }, '{}')).json()).code, 'parent_only');
    });

    it('a document a sealed designation hides stays hidden on every read a kid may use', async () => {
      tailnet();
      const sealed = await createTestDocument(parentRow.id, { title: 'Sealed For Later', owner_ids: [parentRow.id, kidRow.id] });
      await pool.query(`INSERT INTO document_designations (document_id, member_id, role, sealed) VALUES ($1, $2, 'beneficiary', TRUE)`, [sealed.id, kidRow.id]);
      const kid = { ...as(KID), ...OWN_PAGE };
      const list = await (await get('/api/documents', kid)).json();
      assert.ok(!list.documents.some((doc) => doc.id === sealed.id));
      assert.equal(list.total, 2, 'nor is it counted');
      assert.ok(!(await (await get('/api/documents?q=Sealed', kid)).json()).documents.length, 'nor found by the list\'s search');
      for (const path of ['', '/key-info', '/magicindex-status', '/links', '/files/1/download']) {
        assert.equal((await get(`/api/documents/${sealed.id}${path}`, kid)).status, 403, path || 'the document');
      }
      await pool.query('DELETE FROM documents WHERE id = $1', [sealed.id]);
    });

    it('everything else is refused to a kid, however it is spelled', async () => {
      tailnet();
      const kid = { ...as(KID), ...OWN_PAGE };
      // Search, the dashboard's counts and key posture count documents a sealed designation hides from the kid.
      const refusedReads = ['/api/stats', '/api/search', '/api/search?q=Kid', '/api/pki/posture', '/api/members', '/api/tags', `/api/documents/${kidDoc.id}/shares`, '/api/thumbnails/x.jpg', '/api/backup/status',
        '/api/audit', '/api/continuity/switch', '/api/trustees', '/api/insights', '/api/links', '/api/import/batches', '/api/bootstrap', '/api/suite/links',
        `/api/members/${kidRow.id}/keys/${kidKey.id}/dependencies`, '/API/documents', '/api/documents/', '/api/auth/me/', '/Api/Stats',
        `/api/documents/0${kidDoc.id}`, `/api/documents/${kidDoc.id}/`, `/API/members/${kidRow.id}/keys`];
      for (const path of refusedReads) {
        const answer = await get(path, kid);
        assert.equal(answer.status, 403, path);
        assert.equal(await code(answer), 'parent_only', path);
      }
      assert.equal((await send('HEAD', '/api/documents', kid)).status, 403, 'a HEAD is not the GET on the list');
      const writes = [
        ['POST', `/api/members/${kidRow.id}/keys`], ['POST', `/api/members/${kidRow.id}/keys/webauthn/options`],
        ['POST', `/api/members/${kidRow.id}/keys/webauthn/complete`], ['POST', `/api/members/${kidRow.id}/keys/webauthn/finalize`],
        ['POST', `/api/members/${kidRow.id}/keys/${kidKey.id}/recovery`], ['POST', `/api/members/${kidRow.id}/keys/${kidKey.id}/tested`],
        ['POST', `/api/members/${kidRow.id}/keys/${kidKey.id}/verify-fingerprint`], ['DELETE', `/api/members/${kidRow.id}/keys/${kidKey.id}`],
        ['POST', `/api/members/${kidRow.id}/keys/webauthn/assertion-options/`], ['POST', `/API/members/${kidRow.id}/keys/webauthn/assertion-options`],
        ['PUT', `/api/documents/${kidDoc.id}`], ['PUT', `/api/documents/${kidDoc.id}/tags`], ['DELETE', `/api/documents/${kidDoc.id}`],
        ['POST', `/api/documents/${kidDoc.id}/share`], ['POST', '/api/tags'], ['POST', '/api/members'], ['PUT', `/api/members/${kidRow.id}`],
      ];
      for (const [method, path] of writes) {
        const answer = await send(method, path, { ...as(KID), ...JSON_WRITE }, method === 'DELETE' ? undefined : '{}');
        assert.equal(answer.status, 403, `${method} ${path}`);
        assert.equal(await code(answer), 'parent_only', `${method} ${path}`);
      }
      const pageWrite = await send('POST', '/documents.html', { ...as(KID), ...JSON_WRITE }, '{}');
      assert.equal(await code(pageWrite), 'parent_only', 'a write to a page path is refused, not redirected');
      const upload = await send('POST', '/api/documents', { ...as(KID), ...OWN_PAGE, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }, '--x--\r\n');
      assert.equal(await code(upload), 'parent_only', 'a kid uploads nothing');
      const { rows: [key] } = await pool.query('SELECT revoked_at FROM encryption_keys WHERE id = $1', [kidKey.id]);
      assert.equal(key.revoked_at, null);
    });

    it('a kid\'s pages are the dashboard, their documents, search and settings; any other page sends them home', async () => {
      tailnet();
      const page = { ...as(KID), ...NAVIGATION };
      for (const path of ['/', '/index.html', '/documents.html', `/document.html`, '/search.html', '/settings.html']) {
        assert.equal((await get(path, page)).status, 200, path);
      }
      for (const path of ['/upload.html', '/backup.html', '/continuity.html', '/tags.html', '/import.html', '/insights.html', '/link', '/link.html',
        '/login', '/login.html', '/setup', '/setup.html', '/Documents.html', '/documents.html/', '/bip39-english.txt']) {
        const answer = await get(path, page);
        assert.equal(answer.status, 303, path);
        assert.equal(answer.headers.get('location'), '/source/', path);
      }
    });

    it('the directory decides the role, never the row', async () => {
      // The row says kid, the directory parent: a parent.
      tailnet([{ ...KID, role: 'parent' }]);
      assert.equal((await get('/api/auth/me', { ...as(KID), ...OWN_PAGE })).status, 401, 'a parent now, who opens Home Source with a passkey');
      const promoted = { ...as(KID, passkeyCookie(KID)), ...OWN_PAGE };
      assert.equal((await (await get('/api/auth/me', promoted)).json()).role, 'parent');
      assert.equal((await get('/api/members', promoted)).status, 200);
      assert.equal((await get('/api/audit', promoted)).status, 200, 'a route that checks the role itself sees the directory\'s');
      // The row says parent, the directory kid: refused outright (stale_link, above), never the parent's documents.
      tailnet([{ ...PARENT, role: 'kid' }]);
      assert.equal(await code(await get('/api/documents', { ...as(PARENT), ...OWN_PAGE })), 'stale_link');
    });

    it('a linked parent gets everything a parent does, with no passphrase, and the login page sends them to the app', async () => {
      tailnet();
      const parent = { ...as(PARENT), ...OWN_PAGE };
      const me = await (await get('/api/auth/me', parent)).json();
      assert.deepEqual([me.id, me.role, me.tailnet], [parentRow.id, 'parent', true], 'so pages drop sign-out and passphrases');
      for (const path of ['/api/members', '/api/tags', '/api/audit', '/api/backup/status', '/api/continuity/switch', `/api/documents/${parentDoc.id}`]) {
        assert.equal((await get(path, parent)).status, 200, path);
      }
      const { documents } = await (await get('/api/documents', parent)).json();
      assert.ok(documents.some((doc) => doc.id === parentDoc.id));
      for (const path of ['/documents.html', '/settings.html', '/backup.html', '/']) {
        assert.equal((await get(path, { ...as(PARENT), ...NAVIGATION })).status, 200, path);
      }
      for (const path of ['/login', '/login.html', '/LOGIN.HTML', '/login/']) {
        const login = await get(path, { ...as(PARENT), ...NAVIGATION });
        assert.equal(login.status, 303, path);
        assert.equal(login.headers.get('location'), '/source/', path);
      }
      const bootstrap = await (await get('/api/bootstrap', parent)).json();
      assert.equal(bootstrap.counts.family_members > 0, true, 'a linked parent still sees the counts');
    });

    it('local sign-in means nothing: login, passphrase changes and sign-out are refused, and nothing stored is deleted', async () => {
      const { token } = await createSession(parentRow.id);
      tailnet();
      const before = (await pool.query('SELECT passphrase_hash FROM family_members WHERE id = $1', [parentRow.id])).rows[0].passphrase_hash;
      for (const member of [PARENT, KID]) {
        for (const path of ['/api/auth/login', '/API/auth/login', '/api/AUTH/LOGIN', '/api/auth/login/', '/api/auth/passphrase', '/Api/Auth/Passphrase/',
          '/api/auth/logout', '/API/auth/logout/']) {
          const body = JSON.stringify({ name: 'Suite Parent', passphrase: 'parent-passphrase', current_passphrase: 'parent-passphrase', new_passphrase: 'a-new-passphrase' });
          const answer = await send('POST', path, { ...as(member), ...JSON_WRITE, cookie: `hs_session=${token}` }, body);
          assert.equal(answer.status, 409, `${member.name} ${path}`);
          assert.equal(await code(answer), 'tailnet_mode', path);
          assert.equal(answer.headers.get('set-cookie'), null, 'no session cookie set or cleared');
        }
      }
      const after = (await pool.query('SELECT passphrase_hash FROM family_members WHERE id = $1', [parentRow.id])).rows[0].passphrase_hash;
      assert.equal(after, before, 'the stored passphrase is kept');
      assert.equal((await pool.query('SELECT 1 FROM sessions WHERE token = $1', [token])).rows.length, 1, 'and so is the session');
    });

    it('members are added and edited without passphrases', async () => {
      tailnet();
      const write = (method, path, body) => send(method, path, { ...as(PARENT), ...JSON_WRITE }, JSON.stringify(body));
      const refused = await write('POST', '/api/members', { name: 'With Passphrase', role: 'kid', passphrase: 'a-passphrase' });
      assert.equal(refused.status, 409);
      assert.equal(await code(refused), 'tailnet_mode');
      assert.equal((await pool.query("SELECT 1 FROM family_members WHERE name = 'With Passphrase'")).rows.length, 0);
      const added = await write('POST', '/api/members', { name: 'Without Passphrase', role: 'kid' });
      assert.equal(added.status, 201);
      const { id } = await added.json();
      assert.equal((await write('PUT', `/api/members/${id}`, { passphrase: 'a-passphrase' })).status, 409);
      assert.equal((await write('PUT', `/api/members/${id}`, { name: 'Renamed Kid' })).status, 200);
      const { rows: [row] } = await pool.query('SELECT name, passphrase_hash FROM family_members WHERE id = $1', [id]);
      assert.deepEqual(row, { name: 'Renamed Kid', passphrase_hash: null });
      await pool.query('DELETE FROM family_members WHERE id = $1', [id]);
      // Local mode keeps its passphrases.
      app.setSuiteIdentityForTests({});
      const { token } = await createSession(parentRow.id);
      const local = await send('POST', '/api/members', { cookie: `hs_session=${token}`, 'content-type': 'application/json' }, JSON.stringify({ name: 'Local Kid', passphrase: 'a-passphrase' }));
      assert.equal(local.status, 201);
      const { rows: [saved] } = await pool.query("SELECT passphrase_hash FROM family_members WHERE name = 'Local Kid'");
      assert.ok(saved.passphrase_hash);
      await pool.query("DELETE FROM family_members WHERE name = 'Local Kid'");
    });
  });

  describe('passkeys', () => {
    const stepUp = async (answer, policy, label) => {
      assert.equal(answer.status, 401, label);
      assert.equal(answer.headers.get('cache-control'), 'no-store', label);
      assert.deepEqual(await answer.json(), { error: 'step_up_required', policy, level: policy === 'open-documents' ? 'session' : 'recent', kind: 'any' }, label);
    };
    const NAV = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

    it('a parent opens Home Source with a passkey check: a page asks for one, the API answers with the step-up', async () => {
      tailnet();
      for (const cookie of [null, '__Host-sv_assurance=x', passkeyCookie(PARENT, { name: 'sv_assurance' }), passkeyCookie(PARENT, { name: '__HOST-sv_assurance' })]) {
        const page = await get('/documents.html', { ...as(PARENT, cookie), ...NAV });
        assert.equal(page.status, 401, String(cookie));
        assert.equal(page.headers.get('cache-control'), 'no-store');
        const html = await page.text();
        assert.match(html, /<script src="\/source\/passkey\.js"><\/script>/, 'the check runs from the app\'s own address');
        assert.match(html, /data-step-up="\{&quot;error&quot;:&quot;step_up_required&quot;,&quot;policy&quot;:&quot;open-documents&quot;/);
        assert.doesNotMatch(html, /Suite Parent|Shared Document|Parent Only/, 'and shows no data');
        await stepUp(await get('/api/documents', { ...as(PARENT, cookie), ...OWN_PAGE }), 'open-documents', String(cookie));
      }
      // Every page, the link page included, and a HEAD as much as a GET.
      for (const path of ['/', '/settings.html', '/document.html', '/link', '/Documents.html']) {
        assert.equal((await get(path, { ...as(PARENT, null), ...NAV })).status, 401, path);
        const head = await send('HEAD', path, { ...as(PARENT, null), ...NAV });
        assert.equal(head.status, 401, `HEAD ${path}`);
        assert.match(head.headers.get('content-type'), /html/, `HEAD ${path} answers as the page would`);
      }
      // A parent nobody has linked yet needs one too, before the link page shows them the household.
      assert.equal((await get('/link', { ...as(NEW_PARENT, null), ...NAV })).status, 401);
      await stepUp(await get('/api/suite/links', { ...as(NEW_PARENT, null), ...OWN_PAGE }), 'open-documents', 'unlinked parent');
      await stepUp(await get('/api/bootstrap', { ...as(NEW_PARENT, null), ...OWN_PAGE }), 'open-documents', 'unlinked parent setup');
      await stepUp(await send('POST', '/api/tags', { ...as(PARENT, null), ...JSON_WRITE }, '{"name":"x"}'), 'open-documents', 'a write');
      await stepUp(await send('POST', '/api/documents', { ...as(PARENT, null), ...OWN_PAGE, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }, '--x--\r\n'), 'open-documents', 'an upload');
      assert.equal((await get('/documents.html', { ...as(PARENT), ...NAV })).status, 200, 'and with one, it opens');
    });

    it('a check counts for 30 days, for this member, on this hostname, until Home Base changes their access', async () => {
      tailnet();
      const day = 86400;
      assert.equal((await get('/api/documents', { ...as(PARENT, passkeyCookie(PARENT, { age: 29 * day })), ...OWN_PAGE })).status, 200);
      const refusals = {
        'older than 30 days': passkeyCookie(PARENT, { age: 30 * day + 60 }),
        'another member\'s': passkeyCookie(NEW_PARENT),
        'another hostname\'s': passkeyCookie(PARENT, { aud: 'smith-pulse.example-tailnet.ts.net' }),
        'another household\'s': passkeyCookie(PARENT, { household: 'elsewhere' }),
        'from before Home Base changed their access': passkeyCookie(PARENT, { epoch: 0 }),
        'from before Home Base revoked everything': passkeyCookie(PARENT, { global_epoch: 0 }),
        'two of them': `${passkeyCookie(PARENT)}; ${passkeyCookie(PARENT)}`,
        'not signed by Home Base': passkeyCookie(PARENT).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
      };
      for (const [label, cookie] of Object.entries(refusals)) await stepUp(await get('/api/documents', { ...as(PARENT, cookie), ...OWN_PAGE }), 'open-documents', label);
    });

    it('kids never meet a passkey check (D7), and outsiders\' token pages ask nobody', async () => {
      tailnet();
      assert.equal((await get('/api/auth/me', { ...as(KID, null), ...OWN_PAGE })).status, 200);
      assert.equal((await get('/api/documents', { ...as(KID, null), ...OWN_PAGE })).status, 200);
      assert.equal((await get('/documents.html', { ...as(KID, null), ...NAV })).status, 200);
      assert.equal((await get('/check-in', { ...as(PARENT, null), ...NAVIGATION })).status, 200);
      assert.equal((await get('/api/share/not-a-token', { ...as(PARENT, null), ...OWN_PAGE })).status, 404);
      assert.equal((await send('POST', '/api/continuity/check-in', { ...as(PARENT, null), ...JSON_WRITE }, '{}')).status, 404);
    });

    it('changes to who can reach the documents, deleting them, and changes to members need a check in the last five minutes', async () => {
      tailnet();
      const older = passkeyCookie(PARENT, { age: 6 * 60 });
      // As the pages send them: a DELETE has no body.
      const write = (method, path, headers = JSON_WRITE) => send(method, path, { ...as(PARENT, older), ...headers }, method === 'DELETE' ? undefined : '{}');
      assert.equal((await get('/api/documents', { ...as(PARENT, older), ...OWN_PAGE })).status, 200, 'it still opens Home Source');
      const m = parentRow.id;
      const recent = [
        ['POST', `/api/members/${m}/keys`, 'export-data'],
        ['POST', `/api/members/${m}/keys/webauthn/options`, 'export-data'],
        ['POST', `/api/members/${m}/keys/webauthn/complete`, 'export-data'],
        ['POST', `/api/members/${m}/keys/webauthn/finalize`, 'export-data'],
        ['POST', `/api/members/${m}/keys/1/recovery`, 'export-data'],
        ['DELETE', `/api/members/${m}/keys/1`, 'export-data'],
        ['DELETE', `/API/Members/${m}/Keys/1/`, 'export-data'],
        ['POST', `/api/members/${m}/keys/webauthn/assertion-options/x`, 'export-data'],
        ['POST', '/api/members', 'change-role'],
        ['PUT', `/api/members/${m}`, 'change-role'],
        ['PUT', `/Api/Members/${m}/`, 'change-role'],
        ['PUT', `/api/suite/links/${kidRow.id}`, 'change-role'],
        ['PUT', `/API/Suite/Links/${kidRow.id}/`, 'change-role'],
        ['POST', '/api/documents/1/pki-holders/add', 'export-data'],
        ['POST', '/api/documents/1/pki-holders/replace', 'export-data'],
        ['POST', '/api/documents/1/pki-holders/remove', 'export-data'],
        ['POST', '/api/documents/1/designations/seal', 'export-data'],
        ['POST', '/api/documents/1/designations/2/unseal', 'export-data'],
        ['POST', '/API/Documents/1/Designations/Seal/', 'export-data'],
        ['POST', '/api/documents/1/owners', 'export-data'],
        ['DELETE', '/api/documents/1/owners/2', 'export-data'],
        ['POST', '/api/documents/1/share', 'export-data'],
        ['DELETE', '/api/documents/1', 'export-data'],
        ['DELETE', '/api/documents/1?permanent=true', 'export-data'],
        ['DELETE', '/API/Documents/1/?permanent=true', 'export-data'],
        ['DELETE', '/api/documents/1/magicindex', 'export-data'],
        ['DELETE', '/Api/Documents/1/MagicIndex/', 'export-data'],
        ['POST', '/api/trustees', 'export-data'],
        ['POST', '/api/trustees/1/invitations/resend', 'export-data'],
        ['DELETE', '/api/trustees/1', 'export-data'],
        ['POST', '/api/trustees/1/contacts/email', 'export-data'],
        ['POST', '/api/trustees/1/contacts/2/resend', 'export-data'],
        ['DELETE', '/api/trustees/1/contacts/2', 'export-data'],
        ['POST', '/api/continuity/switch/draft', 'export-data'],
        ['POST', '/api/continuity/switch/1/letter/stage', 'export-data'],
        ['POST', '/api/continuity/switch/1/letter/commit', 'export-data'],
        ['POST', '/api/continuity/switch/1/packet/stage', 'export-data'],
        ['POST', '/api/continuity/switch/1/outbox/retry', 'export-data'],
        ['POST', '/api/continuity/switch/1/pause', 'export-data'],
        ['POST', '/api/continuity/switch/1/resume', 'export-data'],
        ['POST', '/api/continuity/switch/1/cancel', 'export-data'],
        ['POST', '/api/continuity/switch/1/recover', 'export-data'],
        ['POST', '/Api/Continuity/Switch/1/Cancel/', 'export-data'],
        ['POST', '/api/continuity/switch/1/contacts/members/2/email', 'export-data'],
        ['DELETE', '/api/continuity/switch/1/contacts/2', 'export-data'],
        ['PUT', '/api/continuity/notification-channels/brrr', 'export-data'],
        ['DELETE', '/api/continuity/notification-channels/brrr', 'export-data'],
        ['POST', '/api/backup/export', 'export-data'],
        ['POST', '/API/backup/export/', 'export-data'],
      ];
      for (const [method, path, policy] of recent) await stepUp(await write(method, path), policy, `${method} ${path}`);
      await stepUp(await write('POST', '/api/documents/1/encrypt', { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }), 'export-data', 'encrypt, an upload');
      await stepUp(await get('/api/backup/download/x.tar.gz', { ...as(PARENT, older), ...OWN_PAGE }), 'export-data', 'a backup download');
      // These only use or confirm what is already set, so the session is enough.
      const sessionOnly = [
        ['POST', `/api/members/${m}/keys/webauthn/assertion-options`], ['POST', `/api/members/${m}/keys/1/tested`],
        ['POST', `/api/members/${m}/keys/1/verify-fingerprint`],
        ['POST', '/api/continuity/switch/1/check-in'], ['POST', '/api/continuity/switch/1/readiness/email/challenge'],
        ['POST', '/api/continuity/switch/1/readiness/email/acknowledge'], ['POST', '/api/continuity/switch/1/contacts/2/resend'],
        ['POST', '/api/continuity/notification-channels/brrr/test'], ['POST', '/api/continuity/notification-channels/brrr/check'],
        ['PUT', '/api/backup/policy'],
        ['POST', '/api/tags'], ['PUT', '/api/documents/1'], ['DELETE', '/api/shares/1'],
      ];
      for (const [method, path] of sessionOnly) assert.notEqual((await write(method, path)).status, 401, `${method} ${path}`);
      for (const path of [`/api/members/${m}/keys`, '/api/continuity/switch', '/api/trustees', '/api/backup/status']) {
        assert.equal((await get(path, { ...as(PARENT, older), ...OWN_PAGE })).status, 200, `reading ${path}`);
      }
      // With a check just now, the change goes through to its route.
      assert.equal((await send('PUT', `/api/suite/links/${kidRow.id}`, { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ suite_member_id: KID.memberId }))).status, 200);
    });

    it('an edit that archives, hides, restores or strips a document needs a recent check; an ordinary edit doesn\'t', async () => {
      tailnet();
      const doc = await createTestDocument(parentRow.id, { title: 'Edited Doc' });
      const analysis = { state: 'done', summary: 'an analysis', fields: { a: 1, b: [1, 2] } };
      await pool.query('UPDATE documents SET metadata = $1 WHERE id = $2', [JSON.stringify({ magicindex: analysis, note: 'keep' }), doc.id]);
      const older = passkeyCookie(PARENT, { age: 6 * 60 });
      const edit = (body, cookie = older, path = `/api/documents/${doc.id}`) => send('PUT', path, { ...as(PARENT, cookie), ...JSON_WRITE }, JSON.stringify(body));
      const stored = async () => (await pool.query('SELECT title, status, metadata FROM documents WHERE id = $1', [doc.id])).rows[0];

      // Ordinary edits: other fields, the status it has now, the same metadata in another key order, or a new key.
      assert.equal((await edit({ title: 'Renamed Doc', description: 'x', expiry_date: null })).status, 200);
      assert.equal((await edit({ status: 'active' })).status, 200, 'the status it already has');
      assert.equal((await edit({ metadata: { note: 'keep', magicindex: { fields: { b: [1, 2], a: 1 }, summary: 'an analysis', state: 'done' } } })).status, 200);
      assert.equal((await edit({ metadata: { magicindex: analysis, note: 'keep', added: true } })).status, 200, 'adding a key');
      assert.equal((await stored()).title, 'Renamed Doc');

      // What the DELETE routes do, by another way: the library's 401, and nothing changed.
      const before = await stored();
      const removals = [
        [{ status: 'archived' }, `/api/documents/${doc.id}`],
        [{ status: 'staged' }, `/api/documents/${doc.id}`],
        [{ status: 'archived', title: 'x' }, `/API/Documents/${doc.id}/`],
        [{ status: 'archived' }, `/api/documents/0${doc.id}`],
        [{ metadata: { note: 'keep', added: true } }, `/api/documents/${doc.id}`],
        [{ metadata: { magicindex: { state: 'done' }, note: 'keep', added: true } }, `/api/documents/${doc.id}`],
        [{ metadata: {} }, `/Api/Documents/${doc.id}`],
        [{ metadata: null }, `/api/documents/${doc.id}`],
        [{ metadata: [] }, `/api/documents/${doc.id}`],
        [{ metadata: 'none' }, `/api/documents/${doc.id}`],
      ];
      for (const [body, path] of removals) await stepUp(await edit(body, older, path), 'export-data', `${path} ${JSON.stringify(body)}`);
      assert.deepEqual(await stored(), before, 'nothing changed');

      // With a check just now they go through, and restoring an archived document is the same kind of change.
      assert.equal((await edit({ metadata: { note: 'keep' } }, passkeyCookie(PARENT))).status, 200);
      assert.deepEqual((await stored()).metadata, { note: 'keep' });
      assert.equal((await edit({ status: 'archived' }, passkeyCookie(PARENT))).status, 200);
      await stepUp(await edit({ status: 'active' }), 'export-data', 'restoring');
      assert.equal((await edit({ status: 'active' }, passkeyCookie(PARENT))).status, 200);
      assert.equal((await stored()).status, 'active');
    });

    it('in local mode an edit asks for no check', async () => {
      const doc = await createTestDocument(parentRow.id, { title: 'Local Edit' });
      const { token } = await createSession(parentRow.id);
      const local = { cookie: `hs_session=${token}`, 'content-type': 'application/json' };
      assert.equal((await send('PUT', `/api/documents/${doc.id}`, local, JSON.stringify({ status: 'archived', metadata: {} }))).status, 200);
      assert.equal((await pool.query('SELECT status FROM documents WHERE id = $1', [doc.id])).rows[0].status, 'archived');
    });

    it('a download a page links to gets a page that runs the check, then the file', async () => {
      tailnet();
      const opened = await get('/api/backup/download/x.tar.gz', { ...as(PARENT, passkeyCookie(PARENT, { age: 6 * 60 })), ...NAV });
      assert.equal(opened.status, 401);
      assert.match(await opened.text(), /&quot;policy&quot;:&quot;export-data&quot;/);
      const file = await get('/api/documents/999999/files/1/download', { ...as(PARENT, null), ...NAV, 'sec-fetch-dest': 'iframe' });
      assert.equal(file.status, 401);
      assert.match(await file.text(), /passkey\.js/);
      assert.equal((await get('/api/backup/download/x.tar.gz', { ...as(PARENT), ...NAV })).status, 404, 'with a recent check it reaches the route');
    });

    it('local mode asks for no passkey', async () => {
      const { token } = await createSession(parentRow.id);
      assert.equal((await get('/api/members', { cookie: `hs_session=${token}`, ...OWN_PAGE })).status, 200);
      assert.equal((await send('POST', '/api/members', { cookie: `hs_session=${token}`, 'content-type': 'application/json' }, JSON.stringify({ name: 'Local Kid' }))).status, 201);
      await pool.query("DELETE FROM family_members WHERE name = 'Local Kid'");
    });
  });

  describe('outsiders\' token pages', () => {
    let shareToken;
    const OUTSIDER_PAGES = ['/share.html', '/trustee-invite.html', '/trustee-action', '/trustee-action.html', '/trustee-contact', '/trustee-contact.html',
      '/continuity-contact', '/continuity-contact.html', '/check-in', '/check-in.html', '/recipient-delivery', '/recipient-delivery.html'];

    before(async () => {
      const doc = await createTestDocument(parentRow.id, { title: 'Shared Document' });
      ({ token: shareToken } = await createShareLink(doc.id, parentRow.id, { access_level: 'view' }));
    });

    it('a link opened from an email reaches each page with no household member at all', async () => {
      tailnet();
      for (const path of [...OUTSIDER_PAGES, `/share/${shareToken}`]) {
        for (const headers of [NAVIGATION, { ...NAVIGATION, 'sec-fetch-site': 'cross-site' }, OWN_PAGE]) {
          const page = await get(path, headers);
          assert.equal(page.status, 200, `${path} ${headers['sec-fetch-site']}`);
          assert.match(page.headers.get('content-type'), /html/);
        }
      }
    });

    it('their API answers by the token alone, exactly as in local mode', async () => {
      tailnet();
      const shared = await get(`/api/share/${shareToken}`, OWN_PAGE);
      assert.equal(shared.status, 200);
      assert.equal((await shared.json()).document.title, 'Shared Document');
      assert.equal((await get('/api/share/not-a-token', OWN_PAGE)).status, 404);
      const write = (path, body = { token: 'not-a-token' }) => send('POST', path, JSON_WRITE, JSON.stringify(body));
      const answers = {
        '/api/share/not-a-token/verify': 401,
        '/api/continuity/check-in/validate': 404,
        '/api/continuity/check-in': 404,
        '/api/continuity/trustee-action/validate': 404,
        '/api/continuity/trustee-action/pause': 404,
        '/api/continuity/contact-verification/validate': 404,
        '/api/continuity/contact-verification/confirm': 404,
        '/api/continuity/trustee-contact-verification/validate': 404,
        '/api/continuity/trustee-contact-verification/confirm': 404,
        '/api/continuity/recipient/exchange': 404,
        '/api/continuity/recipient/reissue': 202,
        '/api/continuity/recipient/items/1/webauthn/assertion-options': 404,
        '/api/trustee-invitations/not-a-token/register': 404,
        '/api/trustee-invitations/not-a-token/webauthn/complete': 404,
        '/api/trustee-invitations/not-a-token/webauthn/finalize': 404,
      };
      for (const [path, status] of Object.entries(answers)) assert.equal((await write(path)).status, status, path);
      for (const path of ['/api/trustee-invitations/not-a-token/webauthn/options', '/api/trustee-invitations/not-a-token/webauthn/assertion-options']) {
        assert.ok([400, 404].includes((await write(path)).status), path);
      }
      for (const path of ['/api/trustee-invitations/not-a-token', '/api/continuity/recipient/manifest', '/api/continuity/recipient/items/1', '/api/continuity/recipient/items/1/ciphertext', `/api/share/${shareToken}/files/1/download`]) {
        assert.equal((await get(path, OWN_PAGE)).status, 404, path);
      }
    });

    it('any other spelling or method needs a member, like everything else', async () => {
      tailnet();
      const stranger = async (method, path, headers) => {
        const answer = await send(method, path, headers, method === 'GET' || method === 'HEAD' ? undefined : '{"token":"x"}');
        assert.equal(answer.status, 403, `${method} ${path}`);
        if (method === 'HEAD') return;
        if (path.toLowerCase().startsWith('/api/')) assert.equal(await code(answer), 'not_member', `${method} ${path}`);
        else assert.match(await answer.text(), /know you yet/, `${method} ${path}`);
      };
      for (const path of ['/Check-In', '/check-in/', '/check-in.HTML', '//check-in', '/share.html/', '/trustee-invite', '/Recipient-Delivery',
        `/share/${shareToken}/`, `/SHARE/${shareToken}`, '/share/%2e%2e', '/share/..%2Fsettings.html', '/share']) {
        await stranger('GET', path, NAVIGATION);
      }
      for (const path of [`/API/share/${shareToken}`, `/api/share/${shareToken}/`, '/api/share/%2e%2e', `/api/Share/${shareToken}/verify`,
        '/api/trustee-invitations/x/', '/api/continuity/recipient/items/01', '/api/continuity/recipient/items/1/', '/api/continuity/recipient/Manifest']) {
        await stranger('GET', path, OWN_PAGE);
      }
      for (const path of ['/API/continuity/check-in', '/api/continuity/check-in/', '/api/continuity/check-in/validate/', '/api/continuity/trustee-action/Pause',
        '/api/continuity/recipient/Exchange', '/api/trustee-invitations/x/webauthn/options/', '/api/continuity/switch/1/check-in', '/api/trustees']) {
        await stranger('POST', path, JSON_WRITE);
      }
      // A method the route isn't listed for: reading a share link by HEAD would count a use, and a POST is no read.
      await stranger('HEAD', `/api/share/${shareToken}`, OWN_PAGE);
      await stranger('POST', `/api/share/${shareToken}`, JSON_WRITE);
      await stranger('POST', '/check-in', JSON_WRITE);
      await stranger('GET', '/api/continuity/check-in', OWN_PAGE);
      const { rows: [link] } = await pool.query('SELECT use_count FROM share_links WHERE token = $1', [shareToken]);
      assert.equal(link.use_count, 1, 'only the one admitted read counted');
    });

    it('the guard still applies: their writes are JSON from this origin, and their reads come from its own pages', async () => {
      tailnet();
      const body = JSON.stringify({ token: 'not-a-token' });
      for (const headers of [
        { ...OWN_PAGE, origin: SIBLING, 'content-type': 'application/json' },
        { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'text/plain' },
        { ...OWN_PAGE, 'content-type': 'application/json' },
        { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', origin: SIBLING, 'content-type': 'application/x-www-form-urlencoded' },
      ]) {
        const answer = await send('POST', '/api/continuity/check-in', headers, body);
        assert.equal(answer.status, 403, JSON.stringify(headers));
        assert.equal((await answer.json()).error, 'request_refused');
      }
      // A navigation to their API is refused too, except the shared file a page links to.
      const navigated = await get(`/api/share/${shareToken}`, NAVIGATION);
      assert.equal(await code(navigated), 'not_a_page');
      assert.equal((await get(`/api/share/${shareToken}/files/1/download`, NAVIGATION)).status, 404, 'reaches its route, which finds no such file');
    });

    it('a household member on them gets what the token allows, and nothing more', async () => {
      tailnet();
      for (const member of [PARENT, KID, NEW_KID]) {
        assert.equal((await get('/api/share/not-a-token', { ...as(member), ...OWN_PAGE })).status, 404);
        assert.equal((await send('POST', '/api/continuity/check-in', { ...as(member), ...JSON_WRITE }, '{}')).status, 404);
      }
    });
  });

  // Last: it starts the household over.
  it('a parent nobody has linked sets up a new household, without passphrases, then links themselves', async () => {
    await resetDatabase();
    tailnet();
    const parent = { ...as(NEW_PARENT), ...OWN_PAGE };
    const state = await (await get('/api/bootstrap', parent)).json();
    assert.deepEqual([state.bootstrap.needs_household, state.tailnet], [true, true]);
    assert.equal((await get('/setup', { ...as(NEW_PARENT), ...NAVIGATION })).status, 200);
    const create = (members) => send('POST', '/api/bootstrap/household', { ...as(NEW_PARENT), ...JSON_WRITE }, JSON.stringify({ members }));
    const refused = await create([{ name: 'First Parent', role: 'parent', passphrase: 'a-passphrase' }]);
    assert.equal(refused.status, 409);
    assert.equal(await code(refused), 'tailnet_mode');
    assert.equal((await pool.query('SELECT 1 FROM family_members')).rows.length, 0);
    assert.equal((await create([{ name: 'First Parent', role: 'parent' }])).status, 201);
    const page = await get('/', { ...as(NEW_PARENT), ...NAVIGATION });
    assert.equal(page.headers.get('location'), '/source/link', 'and is sent to link themselves');
  });
});
