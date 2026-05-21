'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedDel, createTestDocument, url } = require('./helpers');

let parent, kid, parentCookie, kidCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('ShareParent', 'parent', 'pass');
  kid = await createMember('ShareKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('share link lifecycle', () => {
  let doc, shareToken, shareId;

  before(async () => {
    doc = await createTestDocument(parent.id, { title: 'Shareable Doc' });
  });

  it('creates a view-only share link', async () => {
    const res = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'view'
    });
    assert.equal(res.status, 201);
    const link = await res.json();
    assert.ok(link.token);
    assert.equal(link.access_level, 'view');
    assert.equal(link.pin_hash, null);
    shareToken = link.token;
    shareId = link.id;
  });

  it('accesses share link without auth', async () => {
    const res = await fetch(url(`api/share/${shareToken}`));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.document.title, 'Shareable Doc');
    assert.equal(data.access_level, 'view');
  });

  it('lists share links for document', async () => {
    const res = await authedGet(`api/documents/${doc.id}/shares`, parentCookie);
    assert.equal(res.status, 200);
    const shares = await res.json();
    assert.ok(shares.length >= 1);
    assert.equal(shares[0].token, shareToken);
  });

  it('revokes share link', async () => {
    const res = await authedDel(`api/shares/${shareId}`, parentCookie);
    assert.equal(res.status, 200);

    const accessRes = await fetch(url(`api/share/${shareToken}`));
    assert.equal(accessRes.status, 404);
  });

  it('kid cannot create share links', async () => {
    const res = await authedPost(`api/documents/${doc.id}/share`, kidCookie, {
      access_level: 'view'
    });
    assert.equal(res.status, 403);
  });
});

describe('PIN-protected share links', () => {
  let doc, shareToken;

  before(async () => {
    doc = await createTestDocument(parent.id, { title: 'PIN Protected Doc' });
    const res = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'download',
      pin: '1234'
    });
    const link = await res.json();
    shareToken = link.token;
  });

  it('returns needs_pin without revealing document', async () => {
    const res = await fetch(url(`api/share/${shareToken}`));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.needs_pin, true);
    assert.ok(data.document_title);
    assert.equal(data.document, undefined, 'should not expose document data');
  });

  it('rejects wrong PIN', async () => {
    const res = await fetch(url(`api/share/${shareToken}/verify`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '9999' })
    });
    assert.equal(res.status, 401);
  });

  it('accepts correct PIN', async () => {
    const res = await fetch(url(`api/share/${shareToken}/verify`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.document.title, 'PIN Protected Doc');
    assert.equal(data.access_level, 'download');
  });
});

describe('share link edge cases', () => {
  it('returns 404 for invalid token', async () => {
    const res = await fetch(url('api/share/nonexistent-token'));
    assert.equal(res.status, 404);
  });

  it('returns 404 for archived document share link', async () => {
    const doc = await createTestDocument(parent.id, { title: 'Will Archive' });
    const createRes = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'view'
    });
    const link = await createRes.json();

    await authedDel(`api/documents/${doc.id}`, parentCookie);

    const accessRes = await fetch(url(`api/share/${link.token}`));
    assert.equal(accessRes.status, 404);
  });

  it('blocks share link creation for encrypted docs', async () => {
    const doc = await createTestDocument(parent.id, {
      title: 'Encrypted Doc',
      is_encrypted: true,
      encryption_mode: 'passphrase',
      encryption_metadata: { version: 1, mode: 'passphrase' }
    });

    const res = await authedPost(`api/documents/${doc.id}/share`, parentCookie, {
      access_level: 'view'
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /unavailable for encrypted documents/i);
  });
});
