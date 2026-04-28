'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedPut, authedDel, createTestDocument } = require('./helpers');

let parent, kid, parentCookie, kidCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('TagParent', 'parent', 'pass');
  kid = await createMember('TagKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('tag CRUD', () => {
  let tagId;

  it('lists tags (initially empty)', async () => {
    const res = await authedGet('api/tags', parentCookie);
    assert.equal(res.status, 200);
    const tags = await res.json();
    assert.equal(tags.length, 0);
  });

  it('creates a tag', async () => {
    const res = await authedPost('api/tags', parentCookie, { name: 'Important', color: '#ef4444' });
    assert.equal(res.status, 201);
    const tag = await res.json();
    assert.equal(tag.name, 'Important');
    assert.equal(tag.color, '#ef4444');
    assert.ok(tag.id);
    tagId = tag.id;
  });

  it('rejects duplicate tag name', async () => {
    const res = await authedPost('api/tags', parentCookie, { name: 'Important' });
    assert.equal(res.status, 400);
  });

  it('rejects empty tag name', async () => {
    const res = await authedPost('api/tags', parentCookie, { name: '  ' });
    assert.equal(res.status, 400);
  });

  it('updates a tag', async () => {
    const res = await authedPut(`api/tags/${tagId}`, parentCookie, { name: 'Critical', color: '#dc2626' });
    assert.equal(res.status, 200);
    const tag = await res.json();
    assert.equal(tag.name, 'Critical');
    assert.equal(tag.color, '#dc2626');
  });

  it('kid cannot create tags', async () => {
    const res = await authedPost('api/tags', kidCookie, { name: 'KidTag' });
    assert.equal(res.status, 403);
  });

  it('kid can read tags', async () => {
    const res = await authedGet('api/tags', kidCookie);
    assert.equal(res.status, 200);
    const tags = await res.json();
    assert.ok(tags.length > 0);
  });

  it('deletes a tag', async () => {
    const res = await authedDel(`api/tags/${tagId}`, parentCookie);
    assert.equal(res.status, 200);
  });

  it('returns 404 for deleted tag', async () => {
    const res = await authedDel(`api/tags/${tagId}`, parentCookie);
    assert.equal(res.status, 404);
  });
});

describe('document tag assignment', () => {
  let doc, tag1, tag2;

  before(async () => {
    doc = await createTestDocument(parent.id, { title: 'Tagged Doc' });
    const r1 = await authedPost('api/tags', parentCookie, { name: 'Urgent' });
    tag1 = await r1.json();
    const r2 = await authedPost('api/tags', parentCookie, { name: 'Archive' });
    tag2 = await r2.json();
  });

  it('assigns tags to a document', async () => {
    const res = await authedPut(`api/documents/${doc.id}/tags`, parentCookie, {
      tag_ids: [tag1.id, tag2.id]
    });
    assert.equal(res.status, 200);
  });

  it('document detail includes assigned tags', async () => {
    const res = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const data = await res.json();
    const tagNames = data.tags.map(t => t.name);
    assert.ok(tagNames.includes('Urgent'));
    assert.ok(tagNames.includes('Archive'));
  });

  it('replaces tags (removes old, adds new)', async () => {
    const res = await authedPut(`api/documents/${doc.id}/tags`, parentCookie, {
      tag_ids: [tag2.id]
    });
    assert.equal(res.status, 200);

    const docRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const data = await docRes.json();
    assert.equal(data.tags.length, 1);
    assert.equal(data.tags[0].name, 'Archive');
  });

  it('clears all tags with empty array', async () => {
    const res = await authedPut(`api/documents/${doc.id}/tags`, parentCookie, {
      tag_ids: []
    });
    assert.equal(res.status, 200);

    const docRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const data = await docRes.json();
    assert.equal(data.tags.length, 0);
  });

  it('kid cannot assign tags', async () => {
    const res = await authedPut(`api/documents/${doc.id}/tags`, kidCookie, {
      tag_ids: [tag1.id]
    });
    assert.equal(res.status, 403);
  });

  it('rejects non-array tag_ids', async () => {
    const res = await authedPut(`api/documents/${doc.id}/tags`, parentCookie, {
      tag_ids: 'not-an-array'
    });
    assert.equal(res.status, 400);
  });
});
