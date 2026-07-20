'use strict';

const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  authedGet, createMember, getPool, loginAs, resetDatabase, startServer, stopServer, url
} = require('./helpers');

let pool;
let parent;
let parentCookie;

describe('Phase C review regressions', () => {
  before(async () => { await startServer(); pool = getPool(); });
  after(async () => { await stopServer(); });
  beforeEach(async () => {
    await resetDatabase();
    parent = await createMember('Review Parent', 'parent', 'parent-pass');
    parentCookie = await loginAs(parent, 'parent-pass');
  });

  it('counts every visible insight instead of truncating the dashboard summary at 500', async () => {
    await pool.query(
      `INSERT INTO magic_data
         (category, severity, subject_type, dedupe_key, title, status)
       SELECT 'household_insight', 'critical', 'household',
              'review-summary-' || value, 'Review insight ' || value, 'new'
       FROM generate_series(1, 501) AS value`
    );
    const response = await authedGet('api/insights/summary', parentCookie);
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.action_required_count, 501);
    assert.equal(summary.new_critical_count, 501);
    assert.deepEqual(summary.by_category, [{ category: 'household_insight', count: 501 }]);
    assert.equal(summary.top_due.length, 3);
  });

  it('serves every sessionless trustee ceremony with no-store caching', async () => {
    for (const page of ['trustee-contact.html', 'trustee-action.html']) {
      const response = await fetch(url(page));
      assert.equal(response.status, 200, page);
      assert.equal(response.headers.get('cache-control'), 'no-store', page);
    }
  });
});
