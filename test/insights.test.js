'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedGet, authedPost, authedPut, authedDel, createTestDocument, getPool } = require('./helpers');

let parent, kid, parentCookie, kidCookie, pool;

before(async () => {
  await startServer();
  await resetDatabase();
  pool = getPool();
  parent = await createMember('InsightParent', 'parent', 'pass123');
  kid = await createMember('InsightKid', 'kid', 'kidpass');
  parentCookie = await loginAs(parent, 'pass123');
  kidCookie = await loginAs(kid, 'kidpass');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('MagicInsight deterministic scan', () => {
  let actionableDoc;
  let noisyTaxDoc;

  before(async () => {
    const now = new Date();
    const inTenDays = new Date(now.getTime() + (10 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    const oldTaxExpiry = '2017-12-31';

    actionableDoc = await createTestDocument(parent.id, {
      title: 'Passport Card',
      document_type: 'identification',
      expiry_date: inTenDays
    });

    noisyTaxDoc = await createTestDocument(parent.id, {
      title: '2017 Tax Return',
      document_type: 'tax',
      expiry_date: oldTaxExpiry
    });

    await createTestDocument(parent.id, {
      title: 'Future Warranty',
      document_type: 'warranty',
      expiry_date: '2030-01-01'
    });
  });

  it('creates actionable expiry alerts and quality insights from one scan', async () => {
    const res = await authedPost('api/insights/scan', parentCookie, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.created_or_updated >= 2);

    const listRes = await authedGet('api/insights', parentCookie);
    assert.equal(listRes.status, 200);
    const insights = await listRes.json();

    const expiry = insights.find((item) => item.category === 'expiry_alert' && item.subject_id === actionableDoc.id);
    assert.ok(expiry);
    assert.equal(expiry.severity, 'critical');

    const quality = insights.find((item) => item.category === 'document_quality' && item.subject_id === noisyTaxDoc.id);
    assert.ok(quality);
    assert.match(quality.title, /expiry date/i);

    const farFuture = insights.find((item) => item.title === 'Future Warranty expires soon');
    assert.equal(farFuture, undefined);
  });

  it('is idempotent across repeated scans', async () => {
    await authedPost('api/insights/scan', parentCookie, {});
    const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM magic_data');
    assert.equal(rows[0].total, 2);
  });

  it('returns summary counts for parent dashboard stats', async () => {
    const res = await authedGet('api/stats', parentCookie);
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.ok(stats.insights);
    assert.equal(stats.insights.action_required_count, 1);
    assert.equal(stats.insights.new_critical_count, 1);
  });

  it('does not expose insight summary to kid dashboard stats', async () => {
    const res = await authedGet('api/stats', kidCookie);
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(stats.insights, null);
  });
});

describe('MagicInsight parent workflow and access control', () => {
  let insightId;

  it('blocks kid access to insights endpoints', async () => {
    const res = await authedGet('api/insights', kidCookie);
    assert.equal(res.status, 403);
  });

  it('allows parent to accept and edit an insight', async () => {
    const listRes = await authedGet('api/insights', parentCookie);
    const insights = await listRes.json();
    insightId = insights[0].id;

    const acceptRes = await authedPut(`api/insights/${insightId}`, parentCookie, {
      status: 'accepted',
      title: 'Passport renewal review',
      reasoning: 'Reviewed by parent'
    });
    assert.equal(acceptRes.status, 200);
    const updated = await acceptRes.json();
    assert.equal(updated.status, 'accepted');
    assert.equal(updated.title, 'Passport renewal review');
    assert.equal(updated.reasoning, 'Reviewed by parent');
    assert.equal(updated.reviewed_by, parent.id);
  });

  it('allows parent to delete an insight', async () => {
    const res = await authedDel(`api/insights/${insightId}`, parentCookie);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    const detailRes = await authedGet(`api/insights/${insightId}`, parentCookie);
    assert.equal(detailRes.status, 404);
  });
});
