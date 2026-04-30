'use strict';

const DOCUMENT_TYPES = new Set([
  'warranty', 'insurance', 'certificate', 'manual', 'receipt', 'contract', 'medical', 'legal', 'tax', 'identification', 'property', 'vehicle', 'other'
]);
const OWNERSHIP_TYPES = new Set(['owner', 'joint', 'beneficiary', 'custodian']);
const FIELD_CONFIDENCE_KEYS = ['title', 'document_type', 'summary', 'issued_date', 'expiry_date', 'amount', 'suggested_tags', 'suggested_owners'];

function confidence(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function dateOrNull(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;

  const us = raw.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (us) {
    const m = String(Math.max(1, Math.min(12, Number(us[1])))).padStart(2, '0');
    const d = String(Math.max(1, Math.min(31, Number(us[2])))).padStart(2, '0');
    return `${us[3]}-${m}-${d}`;
  }

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function text(value, max = 500) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function normalizeTitle(value) {
  const raw = text(value, 180);
  if (!raw) return '';
  const cleaned = raw
    .replace(/\b(?:img|scan|document)[-_]?\d*\b/ig, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const acronyms = new Set(['ac', 'hvac', 'ssa', 'irs', 'pdf', 'usa', 'llc', 'inc', 'w2', '1099', 'trane']);
  return cleaned
    .split(' ')
    .map((word) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function normalizeMagicIndexResult(raw = {}) {
  const type = DOCUMENT_TYPES.has(raw.document_type) ? raw.document_type : 'other';
  const normalizedFieldConfidence = normalizeFieldConfidence(raw.field_confidence, raw.confidence);
  const normalizedKeyFacts = Array.isArray(raw.key_facts) ? raw.key_facts.slice(0, 20).map(f => ({
    label: text(f.label, 80),
    value: text(f.value, 240),
    confidence: confidence(f.confidence)
  })).filter(f => f.label && f.value) : [];
  const inferredIssued = inferIssuedDateFromFacts(normalizedKeyFacts);
  const issuedDate = dateOrNull(raw.issued_date) || inferredIssued || null;
  return {
    schema_version: 'magicindex.v1',
    title: normalizeTitle(raw.title),
    document_type: type,
    summary: text(raw.summary, 1200),
    issued_date: issuedDate,
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
    key_facts: normalizedKeyFacts,
    confidence: confidence(raw.confidence),
    field_confidence: normalizedFieldConfidence,
    extraction_evidence: normalizeExtractionEvidence(raw.extraction_evidence),
    request_diagnostics: normalizeRequestDiagnostics(raw.request_diagnostics),
    needs_review_reasons: Array.isArray(raw.needs_review_reasons) ? raw.needs_review_reasons.map(r => text(r, 160)).filter(Boolean).slice(0, 10) : []
  };
}

function inferIssuedDateFromFacts(keyFacts) {
  for (const fact of keyFacts || []) {
    const label = String(fact.label || '').toLowerCase();
    if (!/(invoice date|statement date|document date|issued|booking date|reservation date|date)/.test(label)) continue;
    const parsed = dateOrNull(fact.value);
    if (parsed) return parsed;
  }
  return null;
}

function normalizeFieldConfidence(input, fallback) {
  const base = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const key of FIELD_CONFIDENCE_KEYS) {
    base[key] = confidence(src[key], confidence(fallback));
  }
  return base;
}

function normalizeExtractionEvidence(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    source: text(input.source, 80),
    text_preview_chars: Number.isFinite(Number(input.text_preview_chars)) ? Math.max(0, Number(input.text_preview_chars)) : 0,
    used_input_file: Boolean(input.used_input_file),
    used_input_image: Boolean(input.used_input_image),
    used_fallback_without_file: Boolean(input.used_fallback_without_file)
  };
}

function normalizeRequestDiagnostics(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    path: text(input.path, 80),
    attempted_input_file: Boolean(input.attempted_input_file),
    used_input_file: Boolean(input.used_input_file),
    used_input_image: Boolean(input.used_input_image),
    used_fallback_without_file: Boolean(input.used_fallback_without_file),
    text_preview_chars: Number.isFinite(Number(input.text_preview_chars)) ? Math.max(0, Number(input.text_preview_chars)) : 0
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
    required: ['title', 'document_type', 'summary', 'issued_date', 'expiry_date', 'amount', 'suggested_tags', 'suggested_owners', 'key_facts', 'confidence', 'field_confidence', 'needs_review_reasons'],
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
      field_confidence: {
        type: 'object',
        additionalProperties: false,
        required: FIELD_CONFIDENCE_KEYS,
        properties: Object.fromEntries(FIELD_CONFIDENCE_KEYS.map((key) => [key, confidenceSchema]))
      },
      needs_review_reasons: { type: 'array', items: { type: 'string' } }
    }
  };
}

module.exports = { DOCUMENT_TYPES, normalizeMagicIndexResult, assertMagicIndexResult, responseJsonSchema, normalizeTitle };
