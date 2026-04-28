'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedPut, url } = require('./helpers');

let parent, kid, parentCookie, kidCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('MemberParent', 'parent', 'pass');
  kid = await createMember('MemberKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('GET /api/members', () => {
  it('lists household members (no auth required)', async () => {
    const res = await fetch(url('api/members'));
    assert.equal(res.status, 200);
    const members = await res.json();
    assert.ok(members.length >= 2);
    assert.ok(members.some(m => m.name === 'MemberParent'));
    assert.ok(members.some(m => m.name === 'MemberKid'));
  });

  it('does not expose passphrase hashes', async () => {
    const res = await fetch(url('api/members'));
    const members = await res.json();
    for (const m of members) {
      assert.equal(m.passphrase_hash, undefined);
      assert.ok('has_passphrase' in m);
    }
  });
});

describe('POST /api/members', () => {
  it('parent can add a new member', async () => {
    const res = await authedPost('api/members', parentCookie, {
      name: 'NewKid',
      role: 'kid',
      avatar_emoji: '🧒'
    });
    assert.equal(res.status, 201);
    const member = await res.json();
    assert.equal(member.name, 'NewKid');
    assert.equal(member.role, 'kid');
  });

  it('kid cannot add members', async () => {
    const res = await authedPost('api/members', kidCookie, {
      name: 'Unauthorized',
      role: 'kid'
    });
    assert.equal(res.status, 403);
  });

  it('rejects empty name', async () => {
    const res = await authedPost('api/members', parentCookie, {
      name: '  ',
      role: 'kid'
    });
    assert.equal(res.status, 400);
  });
});

describe('PUT /api/members/:id', () => {
  it('parent can update a member', async () => {
    const res = await authedPut(`api/members/${kid.id}`, parentCookie, {
      avatar_emoji: '👧',
      color: '#f59e0b'
    });
    assert.equal(res.status, 200);
    const member = await res.json();
    assert.equal(member.avatar_emoji, '👧');
    assert.equal(member.color, '#f59e0b');
  });

  it('kid cannot update members', async () => {
    const res = await authedPut(`api/members/${kid.id}`, kidCookie, {
      name: 'Hacked'
    });
    assert.equal(res.status, 403);
  });
});
