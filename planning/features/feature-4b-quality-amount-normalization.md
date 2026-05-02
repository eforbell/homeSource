# Feature #4B: MagicInsight Quality + Amount Normalization

Date: 2026-05-02
Parent feature: `feature-4-magic-insight.md`
Depends on: Feature #4A MagicInsight Foundation
Status: Ready after 4A

## Purpose

Improve trust in MagicIndex and enable useful financial summaries by normalizing messy extracted values and surfacing documents whose extraction quality is suspect.

## Scope

### In

- amount normalizer for MagicIndex output
- fallback extraction of amounts from key facts
- document quality scanner for weak extraction evidence
- document quality insights for filename-only, low-text, coversheet-like, or inconsistent fields
- optional one-click navigation to document detail/edit

### Out

- Deep Read full-document re-extraction
- changing original document files
- LLM-dependent quality assessment, except optional future hook

## Amount Normalization

MagicIndex currently may place money in:

1. `suggestions.amount.value`
2. `key_facts[]` with labels like `total_cost`, `amount`, `invoice total`, `premium`, `balance`, `discount`
3. summary text

Add a normalizer:

```js
normalizeMoney(input) => {
  value: number | null,
  currency: 'USD',
  confidence: number,
  source: 'amount' | 'key_fact' | 'summary'
}
```

Rules:

- Parse `$13,110.00`, `13,110 USD`, `USD 13110`.
- Prefer explicit total/invoice/final amount over discount/subtotal.
- Ignore discounts unless no total exists.
- Preserve extracted raw value in metadata for auditability.

## Document Quality Signals

Create `document_quality` MagicData when:

1. `extraction_evidence.source = filename_only`
2. `text_preview_chars < 500` for PDF larger than 100KB
3. `needs_review_reasons` includes content-unavailable statements
4. document type/date assignments are inconsistent:
   - `tax` with `expiry_date`
   - receipt/invoice with no amount despite money key facts
   - high confidence field but empty value
5. possible coversheet patterns:
   - `fax cover`, `transmittal`, `cover sheet`, `please deliver to`

## Data Shape

Use existing `magic_data` from 4A.

Dedupe keys:

- `document_quality:document:55:filename_only`
- `document_quality:document:55:low_text_preview`
- `document_quality:document:55:bad_expiry_tax`
- `document_quality:document:55:amount_not_normalized`

Body example:

```json
{
  "document_id": 55,
  "document_title": "Mortgage Agreement",
  "issue": "low_text_preview",
  "description": "Only 340 characters were extracted from a 2.1MB PDF.",
  "suggestion": "Consider Deep Read or re-analysis with extended pages.",
  "extraction_chars": 340,
  "file_size_bytes": 2100000,
  "evidence_source": "pdf_text_preview"
}
```

## Implementation Files

- `lib/magic-index/amounts.js`
- `lib/scanners/document-quality.js`
- `lib/scanners/financial.js` (minimal aggregator can start here)
- tests in `test/magic-index-amounts.test.js` and `test/insights-quality.test.js`

## Acceptance Criteria

1. TRANE-style estimate with `total_cost: "$13,110.00"` normalizes to amount value `13110` USD.
2. Discounts are not mistaken for totals when a total exists.
3. Filename-only MagicIndex runs produce document_quality insights.
4. Historical tax expiry dates produce quality insights instead of dashboard urgent alerts.
5. Re-running scanner is idempotent.
6. Tests pass.

## Follow-up Hook

This feature creates the candidates for future `Deep Read`:

- low extraction quality
- possible coversheet
- amount/date contradictions
