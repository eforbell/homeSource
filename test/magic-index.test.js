'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getMagicIndexConfig } = require('../lib/magic-index/config');
const { normalizeMagicIndexResult, normalizeTitle, normalizeKeyFactKey } = require('../lib/magic-index/schema');

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

  it('fills field-level confidence and diagnostics defaults', () => {
    const result = normalizeMagicIndexResult({
      title: 'Receipt',
      confidence: 0.6
    });
    assert.equal(result.field_confidence.title, 0.6);
    assert.equal(result.field_confidence.issued_date, 0.6);
    assert.equal(result.extraction_evidence, null);
    assert.equal(result.request_diagnostics, null);
  });

  it('infers issued_date from key facts when direct issued_date is missing', () => {
    const result = normalizeMagicIndexResult({
      title: 'Insurance Statement',
      issued_date: null,
      key_facts: [{ label: 'Statement Date', value: '12/1/2023', confidence: 0.9 }],
      confidence: 0.8
    });
    assert.equal(result.issued_date, '2023-12-01');
    assert.equal(result.key_facts[0].key, 'statement_date');
  });

  it('prefers invoice date over order date when both are present', () => {
    const result = normalizeMagicIndexResult({
      title: 'Invoice',
      issued_date: null,
      key_facts: [
        { label: 'Order Date', value: '09/06/17', confidence: 0.95 },
        { label: 'Invoice Date', value: '09/07/17', confidence: 0.95 }
      ],
      confidence: 0.8
    });
    assert.equal(result.issued_date, '2017-09-07');
  });

  it('humanizes slug-like titles while preserving acronyms', () => {
    assert.equal(normalizeTitle('2.5t-trane-single_stage_airhandler'), '2.5t TRANE Single Stage Airhandler');
    assert.equal(normalizeTitle('hvac_invoice_pdf'), 'HVAC Invoice PDF');
  });

  it('canonicalizes common key fact labels', () => {
    assert.equal(normalizeKeyFactKey('Policy Number'), 'policy_number');
    assert.equal(normalizeKeyFactKey('VIN Number'), 'vin');
    assert.equal(normalizeKeyFactKey('order_number'), 'order_number');
    assert.equal(normalizeKeyFactKey('Project'), 'project_number');
    assert.equal(normalizeKeyFactKey('Property Address'), 'property_address');
  });
});

const { inferMimeType, clampConfidence, isIgnoredImportPath, ALLOWED_ITEM_UPDATE_FIELDS } = require('../lib/import-batches');
const { stripJsonFence } = require('../lib/magic-index/providers/openai-compatible-chat');
const { buildMagicIndexRules } = require('../lib/magic-index/prompt');

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

  it('identifies hidden/system files that should not be imported', () => {
    assert.equal(isIgnoredImportPath('Family Docs/.DS_Store'), true);
    assert.equal(isIgnoredImportPath('__MACOSX/file.pdf'), true);
    assert.equal(isIgnoredImportPath('Family Docs/policy.pdf'), false);
  });

  it('allowlists import item update fields for SQL safety', () => {
    assert.equal(ALLOWED_ITEM_UPDATE_FIELDS.has('magicindex_result'), true);
    assert.equal(ALLOWED_ITEM_UPDATE_FIELDS.has('document_id'), true);
    assert.equal(ALLOWED_ITEM_UPDATE_FIELDS.has('status'), false);
    assert.equal(ALLOWED_ITEM_UPDATE_FIELDS.has('foo, status = failed --'), false);
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildResponseBody, buildUserContent, canSendPdfFile } = require('../lib/magic-index/providers/openai-responses');
const { parseOllamaJsonContent } = require('../lib/magic-index/providers/ollama-chat');

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

  it('attaches image input payload for native images', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-img-'));
    const imagePath = path.join(dir, 'sample.jpg');
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const config = { openai: { model: 'gpt-5.4-nano', api_key: 'test', send_pdf_input: true } };
    const content = buildUserContent({ filePath: imagePath, filename: 'sample.jpg', mimeType: 'image/jpeg', textPreview: '' }, config);
    const imagePart = content.find((part) => part.type === 'input_image');
    assert.ok(imagePart);
    assert.equal(imagePart.detail, 'high');
    assert.match(imagePart.image_url, /^data:image\/jpeg;base64,/);
  });
});

describe('Ollama JSON parsing hardening', () => {
  it('extracts final JSON when think blocks and duplicate payloads leak', () => {
    const content = `"title":"bad"}\n</think>\n\n{"title":"Good","document_type":"other","summary":"ok","issued_date":null,"expiry_date":null,"amount":null,"suggested_tags":[],"suggested_owners":[],"key_facts":[],"confidence":0.5,"field_confidence":{},"needs_review_reasons":[]}`;
    const parsed = parseOllamaJsonContent(content);
    assert.equal(parsed.title, 'Good');
  });

  it('parses clean JSON directly', () => {
    const parsed = parseOllamaJsonContent('{"title":"A","document_type":"other","summary":"B"}');
    assert.equal(parsed.title, 'A');
  });
});

describe('MagicIndex prompt guidance', () => {
  it('injects conservative extraction rules and optional user hints', () => {
    const prompt = buildMagicIndexRules({ userHint: 'This is a vehicle registration. Ignore old notice dates.' });
    assert.match(prompt, /Tax documents usually do not have actionable expiry dates/i);
    assert.match(prompt, /prefer final total/i);
    assert.match(prompt, /User hint: This is a vehicle registration/i);
  });
});
