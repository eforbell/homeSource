'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedPut, authedDel, createTestDocument, getPool } = require('./helpers');
const { saveFileRecord } = require('../lib/files');

let parent, kid, parentCookie, kidCookie;
let pool;

before(async () => {
  await startServer();
  await resetDatabase();
  pool = getPool();
  parent = await createMember('DocParent', 'parent', 'pass123');
  kid = await createMember('DocKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass123');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('GET /api/documents', () => {
  it('returns 401 without auth', async () => {
    const { url } = require('./helpers');
    const res = await fetch(url('api/documents'));
    assert.equal(res.status, 401);
  });

  it('returns empty list initially', async () => {
    const res = await authedGet('api/documents', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.documents.length, 0);
    assert.equal(data.total, 0);
  });
});

describe('document CRUD', () => {
  let docId;

  it('creates a document (via DB)', async () => {
    const doc = await createTestDocument(parent.id, {
      title: 'Test Warranty',
      document_type: 'warranty',
      description: 'HVAC system warranty document'
    });
    assert.ok(doc.id);
    assert.equal(doc.title, 'Test Warranty');
    assert.equal(doc.document_type, 'warranty');
    docId = doc.id;
  });

  it('lists the created document', async () => {
    const res = await authedGet('api/documents', parentCookie);
    const data = await res.json();
    assert.equal(data.total, 1);
    assert.equal(data.documents[0].title, 'Test Warranty');
  });

  it('gets document detail', async () => {
    const res = await authedGet(`api/documents/${docId}`, parentCookie);
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.id, docId);
    assert.equal(doc.title, 'Test Warranty');
    assert.ok(Array.isArray(doc.owners));
    assert.ok(Array.isArray(doc.tags));
    assert.ok(Array.isArray(doc.files));
  });

  it('updates document metadata', async () => {
    const res = await authedPut(`api/documents/${docId}`, parentCookie, {
      title: 'Updated Warranty',
      description: 'Updated description'
    });
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.title, 'Updated Warranty');
    assert.equal(doc.description, 'Updated description');
  });

  it('returns 404 for non-existent document', async () => {
    const res = await authedGet('api/documents/99999', parentCookie);
    assert.equal(res.status, 404);
  });

  it('filters by document_type', async () => {
    await createTestDocument(parent.id, { title: 'Tax Doc', document_type: 'tax' });

    const res = await authedGet('api/documents?type=warranty', parentCookie);
    const data = await res.json();
    assert.equal(data.total, 1);
    assert.equal(data.documents[0].document_type, 'warranty');
  });

  it('archives a document', async () => {
    const res = await authedDel(`api/documents/${docId}`, parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    const listRes = await authedGet('api/documents', parentCookie);
    const listData = await listRes.json();
    const found = listData.documents.find(d => d.id === docId);
    assert.equal(found, undefined, 'archived doc should not appear in active list');
  });
});

describe('kid access control', () => {
  let parentDoc, kidDoc;

  before(async () => {
    parentDoc = await createTestDocument(parent.id, { title: 'Parent Only Doc' });
    kidDoc = await createTestDocument(kid.id, {
      title: 'Kid Doc',
      owner_ids: [kid.id]
    });
  });

  it('kid can list own documents', async () => {
    const res = await authedGet('api/documents', kidCookie);
    const data = await res.json();
    const titles = data.documents.map(d => d.title);
    assert.ok(titles.includes('Kid Doc'));
  });

  it('kid cannot update documents', async () => {
    const res = await authedPut(`api/documents/${kidDoc.id}`, kidCookie, { title: 'Hacked' });
    assert.equal(res.status, 403);
  });

  it('kid cannot delete documents', async () => {
    const res = await authedDel(`api/documents/${kidDoc.id}`, kidCookie);
    assert.equal(res.status, 403);
  });
});

describe('document owners', () => {
  let doc;

  before(async () => {
    doc = await createTestDocument(parent.id, { title: 'Owner Test Doc' });
  });

  it('adds an owner', async () => {
    const res = await authedPost(`api/documents/${doc.id}/owners`, parentCookie, {
      member_id: kid.id,
      ownership_type: 'joint'
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.member_id, kid.id);
    assert.equal(data.ownership_type, 'joint');
  });

  it('removes an owner', async () => {
    const res = await authedDel(`api/documents/${doc.id}/owners/${kid.id}`, parentCookie);
    assert.equal(res.status, 200);
  });

  it('kid cannot add owners', async () => {
    const res = await authedPost(`api/documents/${doc.id}/owners`, kidCookie, {
      member_id: parent.id
    });
    assert.equal(res.status, 403);
  });
});

describe('MagicIndex re-analysis', () => {
  let doc;

  before(async () => {
    doc = await createTestDocument(parent.id, {
      title: 'Reanalyze Me',
      metadata: { magicindex: { state: 'complete' } }
    });
    await saveFileRecord(doc.id, {
      file_type: 'original',
      stored_filename: 'test-reanalyze.pdf',
      original_filename: 'test-reanalyze.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: 128
    });
  });

  it('queues a parent-triggered re-analysis with user hint', async () => {
    const res = await authedPost(`api/documents/${doc.id}/magicindex/reanalyze`, parentCookie, {
      user_hint: 'This is a vehicle registration. Ignore cover page dates.'
    });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.ok, true);

    const detailRes = await authedGet(`api/documents/${doc.id}`, parentCookie);
    const detail = await detailRes.json();
    assert.equal(detail.metadata.magicindex.state, 'pending');
    assert.equal(detail.metadata.magicindex.user_hint, 'This is a vehicle registration. Ignore cover page dates.');

    const { rows } = await pool.query(
      `SELECT job_type, payload FROM processing_jobs WHERE document_id = $1 AND job_type = 'magicindex' ORDER BY id DESC LIMIT 1`,
      [doc.id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].job_type, 'magicindex');
    assert.equal(rows[0].payload.user_hint, 'This is a vehicle registration. Ignore cover page dates.');
  });

  it('blocks kid-triggered re-analysis', async () => {
    const res = await authedPost(`api/documents/${doc.id}/magicindex/reanalyze`, kidCookie, {
      user_hint: 'Nope'
    });
    assert.equal(res.status, 403);
  });
});
