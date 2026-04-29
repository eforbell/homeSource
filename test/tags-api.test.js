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

describe('tag merge', () => {
  let doc, srcTag, dstTag;

  before(async () => {
    await resetDatabase();
    const p = await createMember('MergeParent', 'parent', 'pass');
    const k = await createMember('MergeKid', 'kid', 'kidpass');
    parentCookie = await loginAs(p, 'pass');
    kidCookie = await loginAs(k, 'kidpass');
    doc = await createTestDocument(p.id);
  });

  it('merges source tag into target', async () => {
    const src = await (await authedPost('api/tags', parentCookie, { name: 'old-label', color: '#ff0000' })).json();
    const dst = await (await authedPost('api/tags', parentCookie, { name: 'preferred', color: '#00ff00' })).json();
    srcTag = src; dstTag = dst;
    await authedPut(`api/documents/${doc.id}/tags`, parentCookie, { tag_ids: [src.id] });

    const res = await authedPost(`api/tags/${dst.id}/merge`, parentCookie, { source_id: src.id });
    assert.equal(res.status, 200);
    const merged = await res.json();
    assert.equal(merged.id, dst.id);
    assert.equal(merged.document_count, 1);

    const tagsRes = await authedGet('api/tags', parentCookie);
    const tags = await tagsRes.json();
    assert.ok(!tags.find(t => t.id === src.id), 'source tag should be deleted');
  });

  it('handles docs already tagged with target', async () => {
    const a = await (await authedPost('api/tags', parentCookie, { name: 'dup-a', color: '#111111' })).json();
    const b = await (await authedPost('api/tags', parentCookie, { name: 'dup-b', color: '#222222' })).json();
    await authedPut(`api/documents/${doc.id}/tags`, parentCookie, { tag_ids: [a.id, b.id] });

    const res = await authedPost(`api/tags/${b.id}/merge`, parentCookie, { source_id: a.id });
    assert.equal(res.status, 200);
    const merged = await res.json();
    assert.equal(merged.document_count, 1);
  });

  it('rejects merging a tag into itself', async () => {
    const t = await (await authedPost('api/tags', parentCookie, { name: 'self-merge', color: '#333333' })).json();
    const res = await authedPost(`api/tags/${t.id}/merge`, parentCookie, { source_id: t.id });
    assert.equal(res.status, 400);
  });

  it('kid cannot merge tags', async () => {
    const a = await (await authedPost('api/tags', parentCookie, { name: 'kid-src', color: '#444444' })).json();
    const b = await (await authedPost('api/tags', parentCookie, { name: 'kid-dst', color: '#555555' })).json();
    const res = await authedPost(`api/tags/${b.id}/merge`, kidCookie, { source_id: a.id });
    assert.equal(res.status, 403);
  });
});
