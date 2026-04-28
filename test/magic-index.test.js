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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildResponseBody, canSendPdfFile } = require('../lib/magic-index/providers/openai-responses');

describe('OpenAI PDF MagicIndex requests', () => {
  it('attaches PDF bytes as Responses input_file content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-pdf-'));
    const pdfPath = path.join(dir, 'sample.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n%%EOF'));
    const config = { openai: { model: 'gpt-5.4-nano', api_key: 'test', send_pdf_input: true } };
    const input = { filePath: pdfPath, filename: 'sample.pdf', mimeType: 'application/pdf' };

    assert.equal(canSendPdfFile(input, config), true);
    const body = buildResponseBody(input, config);
    const userContent = body.input[1].content;
    const filePart = userContent.find(part => part.type === 'input_file');
    assert.ok(filePart);
    assert.equal(filePart.filename, 'sample.pdf');
    assert.equal(filePart.file_data, Buffer.from('%PDF-1.4\n%%EOF').toString('base64'));
  });

  it('can disable direct PDF sending for cloud tests', () => {
    const config = { openai: { model: 'gpt-5.4-nano', api_key: 'test', send_pdf_input: false } };
    assert.equal(canSendPdfFile({ filePath: __filename, filename: 'x.pdf', mimeType: 'application/pdf' }, config), false);
  });
});
