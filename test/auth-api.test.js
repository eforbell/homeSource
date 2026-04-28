'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, url } = require('./helpers');

let parent, kid;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('AuthParent', 'parent', 'secret123');
  kid = await createMember('AuthKid', 'kid');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('POST /api/auth/login', () => {
  it('rejects missing credentials', async () => {
    const res = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  it('rejects wrong passphrase', async () => {
    const res = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuthParent', passphrase: 'wrong' })
    });
    assert.equal(res.status, 401);
  });

  it('rejects member without passphrase', async () => {
    const res = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuthKid', passphrase: 'anything' })
    });
    assert.equal(res.status, 401);
  });

  it('accepts correct credentials and sets session cookie', async () => {
    const res = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuthParent', passphrase: 'secret123' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.member.name, 'AuthParent');
    assert.equal(data.member.role, 'parent');

    const cookies = res.headers.get('set-cookie') || '';
    assert.ok(cookies.includes('hs_session='), 'should set hs_session cookie');
    assert.ok(cookies.includes('HttpOnly'), 'cookie should be HttpOnly');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without session', async () => {
    const res = await fetch(url('api/auth/me'));
    assert.equal(res.status, 401);
  });

  it('returns member info with valid session', async () => {
    const loginRes = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuthParent', passphrase: 'secret123' })
    });
    const cookies = loginRes.headers.get('set-cookie');
    const match = cookies.match(/hs_session=([^;]+)/);
    const cookie = `hs_session=${match[1]}`;

    const res = await fetch(url('api/auth/me'), {
      headers: { Cookie: cookie }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'AuthParent');
    assert.equal(data.role, 'parent');
  });
});

describe('POST /api/auth/logout', () => {
  it('clears session cookie', async () => {
    const loginRes = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuthParent', passphrase: 'secret123' })
    });
    const cookies = loginRes.headers.get('set-cookie');
    const match = cookies.match(/hs_session=([^;]+)/);
    const cookie = `hs_session=${match[1]}`;

    const logoutRes = await fetch(url('api/auth/logout'), {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(logoutRes.status, 200);

    const meRes = await fetch(url('api/auth/me'), {
      headers: { Cookie: cookie }
    });
    assert.equal(meRes.status, 401);
  });
});
