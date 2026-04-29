'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedFetch } = require('./helpers');
const { processNextJob } = require('../bin/import-worker');

let parent, kid, parentCookie, kidCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('ImportParent', 'parent', 'pass123');
  kid = await createMember('ImportKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass123');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

function pdfFile(name = 'insurance-policy.pdf') {
  return {
    name,
    blob: new Blob([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF')], { type: 'application/pdf' })
  };
}

function tinyPng(name = 'page.png') {
  const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a3sAAAAASUVORK5CYII=', 'base64');
  return {
    name,
    blob: new Blob([onePixelPng], { type: 'image/png' })
  };
}

async function stageFile(batchId, cookie, file = pdfFile(), relativePath = file.name) {
  const form = new FormData();
  form.append('file', file.blob, file.name);
  form.append('relative_path', relativePath);
  return authedFetch(`api/import/batches/${batchId}/items`, cookie, { method: 'POST', body: form });
}

describe('MagicIndex config', () => {
  it('exposes privacy-aware defaults without secrets', async () => {
    const res = await authedGet('api/import/config', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.magicindex.default_enabled, false);
    assert.equal(data.magicindex.provider_private, false);
    assert.equal(data.magicindex.auto_apply_confidence, 0.85);
    assert.equal(Object.hasOwn(data.magicindex, 'api_key'), false);
  });
});

describe('import batches API', () => {
  let batchId;

  it('parent creates a batch with MagicIndex disabled by default', async () => {
    const res = await authedPost('api/import/batches', parentCookie, {
      name: 'Test family import',
      source_kind: 'browser_files',
      options: { magicindex_enabled: false }
    });
    assert.equal(res.status, 201);
    const batch = await res.json();
    assert.ok(batch.id);
    assert.equal(batch.name, 'Test family import');
    assert.equal(batch.options.magicindex_enabled, false);
    batchId = batch.id;
  });

  it('kid cannot create import batches', async () => {
    const res = await authedPost('api/import/batches', kidCookie, { name: 'Nope', source_kind: 'browser_files' });
    assert.equal(res.status, 403);
  });

  it('stages one file as one import item and queues a job', async () => {
    const res = await stageFile(batchId, parentCookie);
    assert.equal(res.status, 201);
    const item = await res.json();
    assert.equal(item.status, 'queued');
    assert.equal(item.relative_path, 'insurance-policy.pdf');

    const itemsRes = await authedGet(`api/import/batches/${batchId}/items`, parentCookie);
    const items = await itemsRes.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'queued');
  });

  it('worker imports the staged item into a document and thumbnail job completes non-blockingly', async () => {
    assert.equal(await processNextJob(), true, 'store_import_item job should run');
    assert.equal(await processNextJob(), true, 'thumbnail job should run');

    const itemsRes = await authedGet(`api/import/batches/${batchId}/items`, parentCookie);
    const [item] = await itemsRes.json();
    assert.ok(['imported', 'thumbnail_done'].includes(item.status));
    assert.ok(item.document_id);

    const docRes = await authedGet(`api/documents/${item.document_id}`, parentCookie);
    assert.equal(docRes.status, 200);
    const doc = await docRes.json();
    assert.equal(doc.title, 'insurance policy');
    assert.equal(doc.files.some(f => f.file_type === 'original' && f.sha256), true);
  });

  it('skips duplicate files by sha256', async () => {
    const batchRes = await authedPost('api/import/batches', parentCookie, { name: 'Duplicate import', source_kind: 'browser_files' });
    const batch = await batchRes.json();
    const stageRes = await stageFile(batch.id, parentCookie, pdfFile('copy.pdf'), 'copy.pdf');
    assert.equal(stageRes.status, 201);
    assert.equal(await processNextJob(), true);

    const items = await (await authedGet(`api/import/batches/${batch.id}/items`, parentCookie)).json();
    assert.equal(items[0].status, 'skipped_duplicate');
    assert.ok(items[0].document_id);
  });
});

describe('multi-page scan upload', () => {
  it('creates one PDF document from multiple scan pages', async () => {
    const form = new FormData();
    const page1 = tinyPng('scan-1.png');
    const page2 = tinyPng('scan-2.png');
    form.append('scan_pages', page1.blob, page1.name);
    form.append('scan_pages', page2.blob, page2.name);
    form.append('metadata', JSON.stringify({
      title: 'Kitchen notes',
      document_type: 'other',
      source_type: 'scan',
      magicindex_enabled: false
    }));
    const res = await authedFetch('api/documents/scan-multi', parentCookie, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    const created = await res.json();
    const detailRes = await authedGet(`api/documents/${created.id}`, parentCookie);
    assert.equal(detailRes.status, 200);
    const doc = await detailRes.json();
    assert.equal(doc.title, 'Kitchen notes');
    assert.equal(doc.source_type, 'scan');
    assert.equal(doc.metadata?.scan_page_count, 2);
    const originalPdf = (doc.files || []).find((f) => f.file_type === 'original' && f.mime_type === 'application/pdf');
    assert.ok(originalPdf);
  });
});
