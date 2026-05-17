'use strict';

const { normalizeMoney } = require('./amounts');

const DOCUMENT_TYPES = new Set([
  'warranty', 'insurance', 'certificate', 'manual', 'receipt', 'contract', 'medical', 'legal', 'tax', 'identification', 'property', 'vehicle', 'notice', 'other'
]);
const OWNERSHIP_TYPES = new Set(['owner', 'joint', 'beneficiary', 'custodian']);
const FIELD_CONFIDENCE_KEYS = ['title', 'document_type', 'summary', 'issued_date', 'expiry_date', 'amount', 'suggested_tags', 'suggested_owners'];
const TITLE_HINTS = {
  invoice: /\binvoice\b/i,
  statement: /\bstatement\b/i,
  receipt: /\breceipt\b/i,
  claim: /\bclaim\b/i,
  policy: /\bpolicy|coverage\b/i
};
const NOTICE_REMEDIATION_HINT = /\b(recall|safety recall|safety notice|owner notification|defect|remedy|repair available|service campaign|corrective action|nhtsa|data incident|data breach|breach notice|incident notice|advisory|privacy notice|notification)\b/i;
const VEHICLE_HINT = /\b(vin|vehicle identification number|vehicle|plate|license plate|motor vehicle|dealer|rear view camera)\b/i;
const TRANSACTION_HINT = /\b(invoice|receipt|subtotal|grand total|amount due|balance due|premium due|total order|bill to|payment type|payment due)\b/i;
const KEY_FACT_RULES = [
  [/^(policy number|policy no|policy #)$/i, 'policy_number'],
  [/^(claim number|claim no|claim #)$/i, 'claim_number'],
  [/^(account number|account no|account #|acct #|acct number)$/i, 'account_number'],
  [/^(statement date)$/i, 'statement_date'],
  [/^(statement period|policy period|renewal term)$/i, 'statement_period'],
  [/^(invoice date)$/i, 'invoice_date'],
  [/^(order date)$/i, 'order_date'],
  [/^(document date|date issued|issued date|issue date)$/i, 'issued_date'],
  [/^(booking date|reservation date)$/i, 'booking_date'],
  [/^(effective date|renewal effective date)$/i, 'effective_date'],
  [/^(expiration date|expiry date|expires on|expiration)$/i, 'expiry_date'],
  [/^(order number|order no|order #)$/i, 'order_number'],
  [/^(purchase order number|purchase order no)$/i, 'purchase_order_number'],
  [/^(project|project number|project no)$/i, 'project_number'],
  [/^(statement id)$/i, 'statement_id'],
  [/^(policy term|renewal term)$/i, 'renewal_term'],
  [/^(vehicle identification number|vin|vin number|vin #)$/i, 'vin'],
  [/^(plate|plate number|license plate|plate #)$/i, 'plate_number'],
  [/^(tax year)$/i, 'tax_year'],
  [/^(form type)$/i, 'form_type'],
  [/^(provider|provider name)$/i, 'provider_name'],
  [/^(insured|insured name|insureds|insured\(s\))$/i, 'insured_name'],
  [/^(property address|insured location|residence premises|job address)$/i, 'property_address'],
  [/^(customer name|patient name|member name)$/i, 'person_name'],
  [/^(total premium)$/i, 'total_premium'],
  [/^(total amount|amount due|total due|balance due)$/i, 'total_amount'],
  [/^(total cost|grand total)$/i, 'total_cost'],
  [/^(total fee)$/i, 'total_fee'],
  [/^(patient payment)$/i, 'patient_payment'],
  [/^(insurance coverage)$/i, 'insurance_coverage'],
  [/^(patient responsibility)$/i, 'patient_responsibility']
];

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

function normalizeKeyFactKey(label) {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[#:/]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  for (const [pattern, key] of KEY_FACT_RULES) {
    if (pattern.test(normalized)) return key;
  }
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeMagicIndexResult(raw = {}) {
  const type = DOCUMENT_TYPES.has(raw.document_type) ? raw.document_type : 'other';
  const normalizedFieldConfidence = normalizeFieldConfidence(raw.field_confidence, raw.confidence);
  const normalizedKeyFacts = Array.isArray(raw.key_facts) ? raw.key_facts.slice(0, 20).map(f => ({
    label: text(f.label, 80),
    key: normalizeKeyFactKey(text(f.label, 80)),
    value: text(f.value, 240),
    confidence: confidence(f.confidence)
  })).filter(f => f.label && f.key && f.value) : [];
  const inferredIssued = inferIssuedDateFromFacts(normalizedKeyFacts);
  const issuedDate = dateOrNull(raw.issued_date) || inferredIssued || null;
  const normalizedSummary = text(raw.summary, 1200);
  const normalizedAmount = normalizeMoney(raw.amount, normalizedKeyFacts, normalizedSummary);
  if (!raw.amount && normalizedAmount?.source === 'key_fact') {
    normalizedFieldConfidence.amount = Math.max(normalizedFieldConfidence.amount, confidence(normalizedAmount.confidence, 0));
  }
  const normalized = {
    schema_version: 'magicindex.v1',
    title: normalizeTitle(raw.title),
    document_type: type,
    summary: normalizedSummary,
    issued_date: issuedDate,
    expiry_date: dateOrNull(raw.expiry_date),
    amount: normalizedAmount ? {
      value: normalizedAmount.value,
      currency: normalizedAmount.currency,
      confidence: confidence(normalizedAmount.confidence),
      source: normalizedAmount.source,
      raw_value: normalizedAmount.raw_value,
      raw_label: normalizedAmount.raw_label
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
    raw_confidence: confidence(raw.confidence),
    field_confidence: normalizedFieldConfidence,
    raw_field_confidence: { ...normalizedFieldConfidence },
    extraction_evidence: normalizeExtractionEvidence(raw.extraction_evidence),
    request_diagnostics: normalizeRequestDiagnostics(raw.request_diagnostics),
    needs_review_reasons: Array.isArray(raw.needs_review_reasons) ? raw.needs_review_reasons.map(r => text(r, 160)).filter(Boolean).slice(0, 10) : []
  };
  calibrateMagicIndexResult(normalized);
  return normalized;
}

function inferIssuedDateFromFacts(keyFacts) {
  const keysInPriorityOrder = [
    'invoice_date',
    'statement_date',
    'issued_date',
    'effective_date',
    'booking_date',
    'reservation_date',
    'document_date',
    'order_date'
  ];
  const facts = Array.isArray(keyFacts) ? keyFacts : [];
  for (const key of keysInPriorityOrder) {
    const fact = facts.find((candidate) => candidate.key === key);
    if (!fact) continue;
    const parsed = dateOrNull(fact.value);
    if (parsed) return parsed;
  }
  for (const fact of facts) {
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

function calibrateMagicIndexResult(result) {
  const adjustments = [];
  const evidence = result.extraction_evidence || {};
  const source = String(evidence.source || '');
  const previewChars = Number(evidence.text_preview_chars || 0);
  const titleAndSummary = `${result.title || ''} ${result.summary || ''}`;
  const factText = (result.key_facts || []).map((fact) => `${fact.label || ''} ${fact.value || ''}`).join(' ');
  const corpusText = `${titleAndSummary} ${factText} ${(result.needs_review_reasons || []).join(' ')}`;

  if (source === 'filename_only') {
    applyOverallAdjustment(result, adjustments, 0.25, 'filename_only_source');
    applyFieldAdjustment(result, 'title', 0.5, adjustments, 'filename_only_source');
    applyFieldAdjustment(result, 'document_type', 0.35, adjustments, 'filename_only_source');
    applyFieldAdjustment(result, 'issued_date', 0.2, adjustments, 'filename_only_source');
    applyFieldAdjustment(result, 'expiry_date', 0.2, adjustments, 'filename_only_source');
    applyFieldAdjustment(result, 'amount', 0.2, adjustments, 'filename_only_source');
  }

  if (source === 'pdf_ocr_preview' || source === 'image_ocr_preview') {
    applyOverallAdjustment(result, adjustments, 0.85, 'ocr_source');
  }

  if (previewChars > 0 && previewChars < 500) {
    applyOverallAdjustment(result, adjustments, 0.75, 'low_text_preview');
    applyFieldAdjustment(result, 'summary', 0.8, adjustments, 'low_text_preview');
    applyFieldAdjustment(result, 'document_type', 0.85, adjustments, 'low_text_preview');
  }

  if (result.document_type === 'tax' && result.expiry_date) {
    result.expiry_date = null;
    applyFieldSet(result, 'expiry_date', 0.02, adjustments, 'tax_documents_should_not_expire');
    result.needs_review_reasons.push('Suppressed expiry date because tax documents usually do not have actionable expiry dates.');
    applyOverallAdjustment(result, adjustments, 0.85, 'tax_expiry_guard');
  }

  const looksLikeInvoice = TITLE_HINTS.invoice.test(titleAndSummary) || TITLE_HINTS.statement.test(titleAndSummary) || TITLE_HINTS.receipt.test(titleAndSummary);
  const looksLikeInsurance = TITLE_HINTS.claim.test(titleAndSummary) || TITLE_HINTS.policy.test(titleAndSummary) || /\bclaim|policy|coverage\b/i.test(factText);
  if (result.document_type === 'insurance' && looksLikeInvoice && !looksLikeInsurance) {
    applyFieldAdjustment(result, 'document_type', 0.35, adjustments, 'invoice_vs_insurance_conflict');
    applyOverallAdjustment(result, adjustments, 0.8, 'invoice_vs_insurance_conflict');
    result.needs_review_reasons.push('Document looks more like an invoice/statement than an insurance policy or claim.');
  }

  const looksLikeNotice = NOTICE_REMEDIATION_HINT.test(corpusText);
  const looksLikeVehicle = VEHICLE_HINT.test(corpusText);
  const looksTransactional = TRANSACTION_HINT.test(corpusText);
  if (looksLikeNotice && !looksTransactional) {
    if (['receipt', 'insurance', 'contract', 'other'].includes(result.document_type)) {
      result.document_type = 'notice';
      applyFieldSet(result, 'document_type', 0.9, adjustments, 'notice_type_coercion');
      applyOverallAdjustment(result, adjustments, 0.85, 'notice_type_coercion');
      result.needs_review_reasons.push(
        looksLikeVehicle
          ? 'Document reads like a safety/recall notice rather than a transactional document type.'
          : 'Document reads like an advisory/incident notice rather than a transactional document type.'
      );
    }
  }

  if (result.amount?.source === 'summary') {
    applyFieldAdjustment(result, 'amount', 0.7, adjustments, 'summary_amount_fallback');
    applyOverallAdjustment(result, adjustments, 0.9, 'summary_amount_fallback');
  }

  if (result.amount?.source === 'key_fact') {
    applyFieldAdjustment(result, 'amount', 0.95, adjustments, 'key_fact_amount_fallback');
  }

  if (result.amount && !amountLooksMonetary(result.amount, corpusText)) {
    result.amount = null;
    applyFieldSet(result, 'amount', 0.02, adjustments, 'non_monetary_amount_suppressed');
    applyOverallAdjustment(result, adjustments, 0.8, 'non_monetary_amount_suppressed');
    result.needs_review_reasons.push('Suppressed amount because the extracted value did not have strong monetary context.');
  }

  result.confidence = roundedConfidence(result.confidence);
  for (const key of FIELD_CONFIDENCE_KEYS) {
    result.field_confidence[key] = roundedConfidence(result.field_confidence[key]);
  }
  result.confidence_adjustments = adjustments;
  return result;
}

function amountLooksMonetary(amount, corpusText) {
  if (!amount) return false;
  const rawValue = String(amount.raw_value || '');
  const rawLabel = String(amount.raw_label || '');
  if (/\$|\bUSD\b|\bUS dollars?\b/i.test(rawValue)) return true;
  if (/\b(total|premium|balance|amount|payment|fee|charge|refund|deductible|cost)\b/i.test(rawLabel)) return true;
  if (/\b(total|premium|balance|amount due|payment due|grand total|refund|deductible|fee)\b/i.test(corpusText)) return true;
  if (amount.source === 'amount' && /\d+\.\d{2}/.test(rawValue)) return true;
  return false;
}

function applyOverallAdjustment(result, adjustments, factor, reason) {
  result.confidence = confidence(result.confidence * factor);
  adjustments.push({ scope: 'overall', factor, reason });
}

function applyFieldAdjustment(result, field, factor, adjustments, reason) {
  result.field_confidence[field] = confidence(result.field_confidence[field] * factor);
  adjustments.push({ scope: field, factor, reason });
}

function applyFieldSet(result, field, nextValue, adjustments, reason) {
  result.field_confidence[field] = confidence(nextValue);
  adjustments.push({ scope: field, factor: null, reason });
}

function roundedConfidence(value) {
  const n = confidence(value);
  return Math.round(n * 1000) / 1000;
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

module.exports = { DOCUMENT_TYPES, normalizeMagicIndexResult, assertMagicIndexResult, responseJsonSchema, normalizeTitle, normalizeKeyFactKey };
