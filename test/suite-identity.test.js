'use strict';

// Suite identity (Home Base Feature-10) in tailnet mode: the gate, the request guard, the outsiders' token pages and
// member linking. A fake directory snapshot stands in for Home Base; requests carry the identity headers nginx would.
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
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

// Who nginx says is asking.
const as = (member) => ({ 'x-sovereign-user-id': member.userId, 'x-sovereign-login': member.login });
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
    assert.deepEqual(Object.keys(await setup.json()).sort(), ['app', 'bootstrap', 'status', 'version'], 'whether setup is needed, and no member count');
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
    assert.notEqual((await kid.json()).id, parentRow.id, 'a kid with a parent\'s cookie is not that parent');
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
});
