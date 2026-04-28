'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getMagicIndexConfig } = require('../lib/magic-index/config');
const { normalizeMagicIndexResult } = require('../lib/magic-index/schema');

describe('MagicIndex config', () => {
  it('defaults off unless provider is marked private', () => {
    const cfg = getMagicIndexConfig({ MAGICINDEX_PROVIDER: 'openai_compatible', MAGICINDEX_PROVIDER_PRIVATE: 'no' });
    assert.equal(cfg.default_enabled, false);
  });

  it('allows private local providers to default on', () => {
    const cfg = getMagicIndexConfig({ MAGICINDEX_PROVIDER: 'openai_compatible', MAGICINDEX_PROVIDER_PRIVATE: 'yes', MAGICINDEX_COMPAT_BASE_URL: 'http://localhost:8000/v1', MAGICINDEX_COMPAT_MODEL: 'qwen3:30b-a3b' });
    assert.equal(cfg.default_enabled, true);
    assert.equal(cfg.compatible.model, 'qwen3:30b-a3b');
  });
});

describe('MagicIndex schema normalization', () => {
  it('normalizes high-confidence document suggestions', () => {
    const result = normalizeMagicIndexResult({
      title: 'HVAC Invoice',
      document_type: 'receipt',
      summary: 'Invoice for HVAC repair',
      issued_date: '2026-04-01',
      expiry_date: 'not a date',
      suggested_tags: [{ name: 'HVAC', confidence: 0.9 }],
      confidence: 1.7
    });
    assert.equal(result.schema_version, 'magicindex.v1');
    assert.equal(result.document_type, 'receipt');
    assert.equal(result.expiry_date, null);
    assert.equal(result.confidence, 1);
    assert.equal(result.suggested_tags[0].name, 'HVAC');
  });
});

const { inferMimeType, clampConfidence } = require('../lib/import-batches');
const { stripJsonFence } = require('../lib/magic-index/providers/openai-compatible-chat');

describe('import hardening helpers', () => {
  it('infers MIME type from filename when browser omits it', () => {
    assert.equal(inferMimeType('folder/Policy.PDF', 'application/octet-stream'), 'application/pdf');
    assert.equal(inferMimeType('scan.jpeg', ''), 'image/jpeg');
  });

  it('clamps auto-apply confidence thresholds', () => {
    assert.equal(clampConfidence(2), 1);
    assert.equal(clampConfidence(-1), 0);
  });

  it('strips fenced JSON from local model output', () => {
    assert.equal(stripJsonFence('```json\n{"ok":true}\n```'), '{"ok":true}');
  });
});
