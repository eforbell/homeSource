'use strict';

const DOCUMENT_TYPES = new Set([
  'warranty', 'insurance', 'certificate', 'manual', 'receipt', 'contract', 'medical', 'legal', 'tax', 'identification', 'property', 'vehicle', 'other'
]);
const OWNERSHIP_TYPES = new Set(['owner', 'joint', 'beneficiary', 'custodian']);

function confidence(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function dateOrNull(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function text(value, max = 500) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function normalizeMagicIndexResult(raw = {}) {
  const type = DOCUMENT_TYPES.has(raw.document_type) ? raw.document_type : 'other';
  return {
    schema_version: 'magicindex.v1',
    title: text(raw.title, 180),
    document_type: type,
    summary: text(raw.summary, 1200),
    issued_date: dateOrNull(raw.issued_date),
    expiry_date: dateOrNull(raw.expiry_date),
    amount: raw.amount && typeof raw.amount === 'object' ? {
      value: Number.isFinite(Number(raw.amount.value)) ? Number(raw.amount.value) : null,
      currency: text(raw.amount.currency || 'USD', 3).toUpperCase() || 'USD',
      confidence: confidence(raw.amount.confidence)
    } : null,
    suggested_tags: Array.isArray(raw.suggested_tags) ? raw.suggested_tags.slice(0, 12).map(t => ({
      name: text(t.name, 60),
      confidence: confidence(t.confidence)
    })).filter(t => t.name) : [],
    suggested_owners: Array.isArray(raw.suggested_owners) ? raw.suggested_owners.slice(0, 8).map(o => ({
      member_name: text(o.member_name, 120),
      ownership_type: OWNERSHIP_TYPES.has(o.ownership_type) ? o.ownership_type : 'owner',
      confidence: confidence(o.confidence)
    })).filter(o => o.member_name) : [],
    key_facts: Array.isArray(raw.key_facts) ? raw.key_facts.slice(0, 20).map(f => ({
      label: text(f.label, 80),
      value: text(f.value, 240),
      confidence: confidence(f.confidence)
    })).filter(f => f.label && f.value) : [],
    confidence: confidence(raw.confidence),
    needs_review_reasons: Array.isArray(raw.needs_review_reasons) ? raw.needs_review_reasons.map(r => text(r, 160)).filter(Boolean).slice(0, 10) : []
  };
}

function assertMagicIndexResult(raw) {
  const normalized = normalizeMagicIndexResult(raw);
  if (!normalized.title && !normalized.summary && !normalized.key_facts.length) {
    normalized.needs_review_reasons.push('MagicIndex returned little usable metadata');
  }
  return normalized;
}

function responseJsonSchema() {
  const confidenceSchema = { type: 'number' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'document_type', 'summary', 'issued_date', 'expiry_date', 'amount', 'suggested_tags', 'suggested_owners', 'key_facts', 'confidence', 'needs_review_reasons'],
    properties: {
      title: { type: 'string' },
      document_type: { type: 'string', enum: [...DOCUMENT_TYPES] },
      summary: { type: 'string' },
      issued_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      expiry_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      amount: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['value', 'currency', 'confidence'],
            properties: {
              value: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              currency: { type: 'string' },
              confidence: confidenceSchema
            }
          },
          { type: 'null' }
        ]
      },
      suggested_tags: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'confidence'],
          properties: { name: { type: 'string' }, confidence: confidenceSchema }
        }
      },
      suggested_owners: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['member_name', 'ownership_type', 'confidence'],
          properties: {
            member_name: { type: 'string' },
            ownership_type: { type: 'string', enum: [...OWNERSHIP_TYPES] },
            confidence: confidenceSchema
          }
        }
      },
      key_facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'value', 'confidence'],
          properties: { label: { type: 'string' }, value: { type: 'string' }, confidence: confidenceSchema }
        }
      },
      confidence: confidenceSchema,
      needs_review_reasons: { type: 'array', items: { type: 'string' } }
    }
  };
}

module.exports = { DOCUMENT_TYPES, normalizeMagicIndexResult, assertMagicIndexResult, responseJsonSchema };
