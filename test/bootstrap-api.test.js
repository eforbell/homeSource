'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, url } = require('./helpers');

before(async () => {
  await startServer();
  await resetDatabase();
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const res = await fetch(url('api/health'));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.app, 'home-source');
  });
});

describe('GET /api/ready', () => {
  it('returns ok when database is reachable', async () => {
    const res = await fetch(url('api/ready'));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.checks.db, 'ok');
  });
});

describe('GET /api/bootstrap', () => {
  it('reports needs_household when no members exist', async () => {
    const res = await fetch(url('api/bootstrap'));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'needs_setup');
    assert.equal(data.bootstrap.needs_household, true);
  });
});

describe('POST /api/bootstrap/household', () => {
  it('rejects missing members array', async () => {
    const res = await fetch(url('api/bootstrap/household'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  it('creates household with members', async () => {
    const res = await fetch(url('api/bootstrap/household'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        members: [
          { name: 'TestParent', role: 'parent', passphrase: 'test123' },
          { name: 'TestKid', role: 'kid' }
        ]
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.created_members.length, 2);
    assert.equal(data.created_members[0].name, 'TestParent');
    assert.equal(data.created_members[0].role, 'parent');
    assert.equal(data.created_members[1].role, 'kid');
  });

  it('rejects second household creation', async () => {
    const res = await fetch(url('api/bootstrap/household'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        members: [{ name: 'Another', role: 'parent' }]
      })
    });
    assert.equal(res.status, 409);
  });

  it('bootstrap now reports ready', async () => {
    const res = await fetch(url('api/bootstrap'));
    const data = await res.json();
    assert.equal(data.status, 'ready');
    assert.equal(data.bootstrap.ready, true);
  });
});
