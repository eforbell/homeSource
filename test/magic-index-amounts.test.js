'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMoney } = require('../lib/magic-index/amounts');
const { normalizeMagicIndexResult } = require('../lib/magic-index/schema');

describe('MagicIndex amount normalization', () => {
  it('normalizes direct amount objects', () => {
    const normalized = normalizeMoney({ value: '13110', currency: 'usd', confidence: 0.9 }, [], '');
    assert.deepEqual(normalized, {
      value: 13110,
      currency: 'USD',
      confidence: 0.9,
      source: 'amount',
      raw_value: '13110',
      raw_label: null
    });
  });

  it('prefers total_cost key facts over discounts', () => {
    const normalized = normalizeMoney(null, [
      { label: 'discount', value: '$500.00', confidence: 0.94 },
      { label: 'total_cost', value: '$13,110.00', confidence: 0.97 }
    ], '');
    assert.equal(normalized.value, 13110);
    assert.equal(normalized.source, 'key_fact');
    assert.equal(normalized.raw_label, 'total_cost');
  });

  it('falls back from key facts during schema normalization', () => {
    const result = normalizeMagicIndexResult({
      title: 'TRANE estimate',
      document_type: 'contract',
      summary: 'Estimate for HVAC replacement',
      amount: null,
      confidence: 0.7,
      key_facts: [
        { label: 'discount', value: '$500.00', confidence: 0.8 },
        { label: 'total_cost', value: '$13,110.00', confidence: 0.97 }
      ],
      field_confidence: { amount: 0.1 }
    });
    assert.equal(result.amount.value, 13110);
    assert.equal(result.amount.currency, 'USD');
    assert.equal(result.amount.source, 'key_fact');
    assert.equal(result.field_confidence.amount, 0.922);
  });

  it('suppresses expiry dates on tax documents and dampens confidence', () => {
    const result = normalizeMagicIndexResult({
      title: '2017 Tax Return',
      document_type: 'tax',
      summary: 'Form 1040 return for 2017',
      expiry_date: '2023-01-01',
      confidence: 0.95,
      field_confidence: { expiry_date: 0.95 }
    });
    assert.equal(result.expiry_date, null);
    assert.equal(result.field_confidence.expiry_date, 0.02);
    assert.ok(result.confidence < 0.95);
    assert.match(result.needs_review_reasons.join(' '), /Suppressed expiry date/i);
  });

  it('dampens suspicious invoice-vs-insurance classifications', () => {
    const result = normalizeMagicIndexResult({
      title: 'Invoice',
      document_type: 'insurance',
      summary: 'Invoice for MacBook Pro purchased by Eric Forbell',
      confidence: 0.92,
      field_confidence: { document_type: 0.85 }
    });
    assert.equal(result.document_type, 'insurance');
    assert.ok(result.field_confidence.document_type < 0.85);
    assert.ok(result.confidence < 0.92);
    assert.match(result.needs_review_reasons.join(' '), /invoice\/statement/i);
  });
});
