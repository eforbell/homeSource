# Feature #4.0: Local Model Readiness Gate for MagicInsight

Date: 2026-05-02
Parent feature: `feature-4-magic-insight.md`
Status: Required before LLM-backed MagicInsight slices

## Purpose

Before HomeSource trusts a private LAN model with household-level insight work, prove the currently available local model can perform the specific jobs MagicInsight will ask of it. This is not a benchmark contest; it is a product-readiness gate for a privacy-first home server.

Current target model:

```text
architecture: qwen3
parameters: 4.0B
context length: 262144
embedding length: 2560
quantization: Q4_K_M
provider: Ollama / LAN private provider
```

Assumption: a larger MoE model such as Qwen3.6-35B-A3B may be too heavy for the 16GB M1 Mac mini LAN host. The plan should prove what the 4B model can safely do first, then only upgrade if evidence says it is necessary.

## Positioning

This gate comes before Feature 4B/4D LLM use.

- Feature 4A remains deterministic and does not wait on this.
- Feature 4B can use this to validate amount/date/key-fact extraction support.
- Feature 4D must not ship household gap detection until this gate passes on private-provider output.

## Evaluation Principle

Use the same inputs HomeSource will actually provide:

1. MagicIndex JSON already stored on documents.
2. `pdftotext` / OCR text previews, capped to the production preview size.
3. Document titles, types, owners, dates, tags, and key facts.
4. Small document clusters, not the entire household vault at once.

Do **not** evaluate with generic trivia prompts. The question is whether the model can produce conservative, schema-valid, reviewable household-document suggestions.

## Test Corpus

Create a small private corpus from benign or already-tested household documents. Minimum suggested set:

| Case | Purpose |
|---|---|
| Hotel reservation / receipt | amount, issued date, travel tags |
| Vehicle registration/title/insurance | renewal and ownership facts |
| HVAC estimate/invoice | amount normalization and vendor/project facts |
| Tax return | avoid false expiry/action recommendations |
| Medical/dental claim | conservative document type and amount extraction |
| Warranty/spec sheet/manual | distinguish reference docs from actionable docs |
| Scanned form OCR output | tolerate OCR noise without overclaiming |
| Duplicate or related docs | identify same asset/event without inventing links |

## Required Tasks to Prove

### Task 1 — Strict JSON validity

Prompt the model with extracted document text and the production schema. It must return parseable JSON after HomeSource's existing think-block/noise stripping.

Pass criteria:

- 95%+ parse success on the corpus.
- No markdown fences required by the parser.
- No blank title/summary when text is provided.
- Confidence values normalize to numbers in `0..1`.

### Task 2 — Amount/date extraction sanity

The model must identify visible dates and money amounts, but leave fields null when absent.

Pass criteria:

- Finds obvious invoice/estimate totals from text or key facts.
- Does not turn tax-year / policy-period / random historical dates into urgent expiry dates.
- Uses ISO dates for `issued_date` / `expiry_date` when present.
- Emits uncertainty in `needs_review_reasons` rather than fabricating.

### Task 3 — Insight candidate generation

Given 3-10 documents for one asset/event, ask for candidate insights only.

Pass criteria:

- Returns `household_insight` suggestions with source document IDs.
- Uses cautious titles like `Possible missing renewal document`.
- Does not claim legal, financial, or medical conclusions.
- Can produce `no_insight` when nothing actionable is present.

### Task 4 — Link suggestion discipline

Given a cluster of nearby documents, ask for related-document suggestions.

Pass criteria:

- Links obvious pairs such as estimate -> invoice, registration -> title, policy -> claim.
- Provides relation type, direction where needed, confidence, and evidence.
- Does not over-link unrelated docs just because filenames share a year or owner.

### Task 5 — Latency envelope

Measure realistic response time from the HomeSource server to the LAN model.

Pass criteria:

- Single-document extraction: target < 20s; acceptable < 45s.
- Small cluster insight: target < 45s; acceptable < 90s.
- Timeouts are handled as `needs_review`, not failed document imports.

## Harness Shape

Add a developer-only script when implementation begins:

```bash
npm run magicinsight:eval -- --sample-dir ./private-eval-samples --provider ollama
```

Output JSONL plus a markdown summary:

```text
planning/evals/magicinsight-local-model-YYYYMMDD.jsonl
planning/evals/magicinsight-local-model-YYYYMMDD.md
```

Each record should include:

```json
{
  "case": "hvac_estimate",
  "model": "qwen3-4b-q4_k_m",
  "task": "amount_date_extraction",
  "parse_ok": true,
  "latency_ms": 8123,
  "field_results": {
    "title": "pass",
    "amount": "pass",
    "issued_date": "pass",
    "expiry_date": "pass_null"
  },
  "notes": []
}
```

## Product Decision Gate

### If the 4B model passes

Use it as the default private MagicInsight model for:

- amount normalization assistance
- quality insight explanations
- candidate MagicLinks after deterministic/manual links
- conservative household gap suggestions behind review

### If the 4B model partially passes

Use it only for bounded single-document enrichment and link suggestions. Keep household gap detection disabled or require a stronger model.

### If the 4B model fails

Keep Feature 4A deterministic, ship 4B deterministic normalization only, and mark 4D as blocked on model/provider readiness.

## What Not To Do

- Do not block deterministic MagicInsight 4A on local LLM readiness.
- Do not require a 35B-class model before collecting evidence from the 4B model.
- Do not run cloud household scans as the fallback without explicit user opt-in.
- Do not let the LLM directly create accepted insights; it creates reviewable candidates only.

## Acceptance Criteria for the Gate

1. Eval artifact exists with corpus cases and measured latency.
2. Parse success and schema normalization are reported.
3. At least one pass/fail example is recorded for amount extraction, date extraction, link suggestion, and no-insight behavior.
4. Decision is written into the Feature 4B/4D implementation notes: `private model ready`, `partial`, or `blocked`.
