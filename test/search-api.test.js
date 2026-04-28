'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, createTestDocument } = require('./helpers');

let parent, parentCookie;

before(async () => {
  await startServer();
  await resetDatabase();
  parent = await createMember('SearchParent', 'parent', 'pass');
  parentCookie = await loginAs(parent, 'pass');

  await createTestDocument(parent.id, {
    title: 'Home Insurance Policy',
    document_type: 'insurance',
    description: 'Annual homeowners insurance policy from State Farm'
  });
  await createTestDocument(parent.id, {
    title: 'HVAC Warranty Card',
    document_type: 'warranty',
    description: 'Carrier furnace 10-year warranty registration'
  });
  await createTestDocument(parent.id, {
    title: 'Birth Certificate',
    document_type: 'certificate',
    description: 'Official birth certificate issued by county clerk'
  });
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('GET /api/search', () => {
  it('returns 401 without auth', async () => {
    const { url } = require('./helpers');
    const res = await fetch(url('api/search?q=insurance'));
    assert.equal(res.status, 401);
  });

  it('returns empty results for empty query', async () => {
    const res = await authedGet('api/search?q=', parentCookie);
    const data = await res.json();
    assert.equal(data.results.length, 0);
  });

  it('finds documents by title keyword', async () => {
    const res = await authedGet('api/search?q=insurance', parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.total >= 1);
    assert.ok(data.results.some(r => r.title.includes('Insurance')));
  });

  it('finds documents by description keyword', async () => {
    const res = await authedGet('api/search?q=furnace', parentCookie);
    const data = await res.json();
    assert.ok(data.total >= 1);
    assert.ok(data.results.some(r => r.title.includes('HVAC')));
  });

  it('filters by document_type', async () => {
    const res = await authedGet('api/search?q=certificate&type=certificate', parentCookie);
    const data = await res.json();
    assert.ok(data.total >= 1);
    assert.ok(data.results.every(r => r.document_type === 'certificate'));
  });

  it('returns no results for unmatched query', async () => {
    const res = await authedGet('api/search?q=xyznonexistent', parentCookie);
    const data = await res.json();
    assert.equal(data.total, 0);
  });

  it('includes headline with highlights', async () => {
    const res = await authedGet('api/search?q=insurance', parentCookie);
    const data = await res.json();
    assert.ok(data.results[0].headline);
    assert.ok(data.results[0].headline.includes('<mark>'));
  });
});
