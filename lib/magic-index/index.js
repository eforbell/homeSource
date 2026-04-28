'use strict';

const fs = require('fs');
const path = require('path');
const { getMagicIndexConfig } = require('./config');
const { assertMagicIndexResult } = require('./schema');
const { analyzeWithOpenAICompatible } = require('./providers/openai-compatible-chat');
const { analyzeWithOpenAIResponses } = require('./providers/openai-responses');

function filenameOnlyResult(filename) {
  const title = path.basename(filename || 'Document', path.extname(filename || '')).replace(/[-_]+/g, ' ').trim() || 'Document';
  return assertMagicIndexResult({
    title,
    document_type: 'other',
    summary: '',
    issued_date: null,
    expiry_date: null,
    suggested_tags: [],
    suggested_owners: [],
    key_facts: [],
    confidence: 0.25,
    needs_review_reasons: ['MagicIndex provider is off; filename-only metadata used']
  });
}

function readTextPreview(filePath, maxChars) {
  // MVP-safe fallback: avoid pretending binary PDF OCR exists. Future OCR/text extraction plugs in here.
  if (!filePath || !fs.existsSync(filePath)) return '';
  const ext = path.extname(filePath).toLowerCase();
  if (!['.txt', '.md', '.csv', '.json'].includes(ext)) return '';
  return fs.readFileSync(filePath, 'utf8').slice(0, maxChars);
}

async function analyzeDocument(input, overrideConfig = null) {
  const config = overrideConfig || getMagicIndexConfig();
  if (!input?.enabled || config.provider === 'off') {
    return { result: filenameOnlyResult(input?.filename), provider: 'off', model: null };
  }

  const enriched = {
    ...input,
    textPreview: input.textPreview || readTextPreview(input.filePath, config.max_chars)
  };

  if (config.provider === 'openai_compatible') {
    return {
      result: await analyzeWithOpenAICompatible(enriched, config),
      provider: 'openai_compatible',
      model: config.compatible.model
    };
  }
  if (config.provider === 'openai') {
    return {
      result: await analyzeWithOpenAIResponses(enriched, config),
      provider: 'openai',
      model: config.openai.model
    };
  }
  throw new Error(`Unsupported MagicIndex provider: ${config.provider}`);
}

module.exports = { analyzeDocument, filenameOnlyResult, readTextPreview };
