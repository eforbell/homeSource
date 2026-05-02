'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, resetDatabase, createMember, loginAs, authedPost, authedGet, createTestDocument, getPool } = require('./helpers');
const { updateDocument } = require('../lib/documents');

let parent;
let parentCookie;
let pool;

before(async () => {
  await startServer();
  await resetDatabase();
  pool = getPool();
  parent = await createMember('QualityParent', 'parent', 'pass123');
  parentCookie = await loginAs(parent, 'pass123');
});

after(async () => {
  await resetDatabase();
  await stopServer();
});

describe('document quality scan', () => {
  let filenameOnlyDoc;
  let lowTextDoc;
  let receiptDoc;

  before(async () => {
    filenameOnlyDoc = await createTestDocument(parent.id, {
      title: 'Spec Sheet',
      document_type: 'other',
      metadata: {
        magicindex: {
          extraction_evidence: { source: 'filename_only', text_preview_chars: 0 },
          suggestions: {
            extraction_evidence: { source: 'filename_only', text_preview_chars: 0 },
            needs_review_reasons: ['Content not available from filename alone.'],
            key_facts: [],
            amount: null
          }
        }
      }
    });

    lowTextDoc = await createTestDocument(parent.id, {
      title: 'Large Sparse PDF',
      document_type: 'other',
      metadata: {
        magicindex: {
          extraction_evidence: { source: 'pdf_text_preview', text_preview_chars: 340 },
          suggestions: {
            extraction_evidence: { source: 'pdf_text_preview', text_preview_chars: 340 },
            needs_review_reasons: [],
            key_facts: [],
            amount: null
          }
        }
      }
    });

    receiptDoc = await createTestDocument(parent.id, {
      title: 'Invoice without amount',
      document_type: 'receipt',
      metadata: {
        magicindex: {
          extraction_evidence: { source: 'pdf_text_preview', text_preview_chars: 1500 },
          suggestions: {
            extraction_evidence: { source: 'pdf_text_preview', text_preview_chars: 1500 },
            needs_review_reasons: [],
            key_facts: [{ label: 'total_cost', value: '$13,110.00', confidence: 0.97 }],
            amount: null
          }
        }
      }
    });

    await pool.query(
      `INSERT INTO document_files (document_id, file_type, stored_filename, original_filename, mime_type, file_size_bytes)
       VALUES ($1, 'original', 'f1.pdf', 'f1.pdf', 'application/pdf', 120000),
              ($2, 'original', 'f2.pdf', 'f2.pdf', 'application/pdf', 2100000),
              ($3, 'original', 'f3.pdf', 'f3.pdf', 'application/pdf', 350000)`,
      [filenameOnlyDoc.id, lowTextDoc.id, receiptDoc.id]
    );
  });

  it('creates filename-only, low-text, and missing-amount quality insights', async () => {
    const res = await authedPost('api/insights/scan', parentCookie, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    const insightsRes = await authedGet('api/insights?category=document_quality', parentCookie);
    const insights = await insightsRes.json();

    assert.ok(insights.some((item) => item.subject_id === filenameOnlyDoc.id && item.body.issue === 'filename_only'));
    assert.ok(insights.some((item) => item.subject_id === lowTextDoc.id && item.body.issue === 'low_text_preview'));
    assert.ok(insights.some((item) => item.subject_id === receiptDoc.id && item.body.issue === 'missing_amount'));
  });

  it('is idempotent when rerun', async () => {
    await authedPost('api/insights/scan', parentCookie, {});
    const { rows } = await pool.query(`
      SELECT subject_id, body->>'issue' AS issue, COUNT(*)::int AS count
      FROM magic_data
      WHERE category = 'document_quality'
      GROUP BY subject_id, body->>'issue'
    `);
    for (const row of rows) {
      assert.equal(row.count, 1);
    }
  });

  it('stales quality insights when source issue disappears on rerun', async () => {
    const { rows: qualityRows } = await pool.query(
      `SELECT id FROM magic_data WHERE category = 'document_quality' AND subject_id = $1 AND body->>'issue' = 'filename_only'`,
      [filenameOnlyDoc.id]
    );
    assert.equal(qualityRows.length, 1);

    await updateDocument(filenameOnlyDoc.id, {
      metadata: {
        magicindex: {
          extraction_evidence: { source: 'pdf_text_preview', text_preview_chars: 900 },
          suggestions: {
            extraction_evidence: { source: 'pdf_text_preview', text_preview_chars: 900 },
            needs_review_reasons: [],
            key_facts: [],
            amount: null
          }
        }
      }
    });

    await authedPost('api/insights/scan', parentCookie, {});
    const staleRes = await authedGet('api/insights?status=stale', parentCookie);
    const staleInsights = await staleRes.json();
    assert.ok(staleInsights.some((item) => item.subject_id === filenameOnlyDoc.id && item.body.issue === 'filename_only'));
  });
});
