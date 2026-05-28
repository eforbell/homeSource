'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, url } = require('./helpers');

let parent, kid;

async function loginCookie(name, passphrase) {
  const loginRes = await fetch(url('api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, passphrase })
  });
  const cookies = loginRes.headers.get('set-cookie') || '';
  const match = cookies.match(/hs_session=([^;]+)/);
  return match ? `hs_session=${match[1]}` : null;
}

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
    const cookie = await loginCookie('AuthParent', 'secret123');

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
    const cookie = await loginCookie('AuthParent', 'secret123');

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

describe('POST /api/auth/passphrase', () => {
  it('requires authentication', async () => {
    const res = await fetch(url('api/auth/passphrase'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_passphrase: 'secret123', new_passphrase: 'new-secret-123' })
    });
    assert.equal(res.status, 401);
  });

  it('updates own passphrase and invalidates old login credentials', async () => {
    const cookie = await loginCookie('AuthParent', 'secret123');
    const changeRes = await fetch(url('api/auth/passphrase'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_passphrase: 'secret123', new_passphrase: 'new-secret-123' })
    });
    assert.equal(changeRes.status, 200);
    const changed = await changeRes.json();
    assert.equal(changed.ok, true);

    const oldLogin = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuthParent', passphrase: 'secret123' })
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await fetch(url('api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AuthParent', passphrase: 'new-secret-123' })
    });
    assert.equal(newLogin.status, 200);
  });

  it('rejects incorrect current passphrase', async () => {
    const cookie = await loginCookie('AuthParent', 'new-secret-123');
    const res = await fetch(url('api/auth/passphrase'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_passphrase: 'wrong-passphrase', new_passphrase: 'another-secret-123' })
    });
    assert.equal(res.status, 401);
  });
});
