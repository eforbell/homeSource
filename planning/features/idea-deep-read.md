# Feature Idea: Deep Read — On-Demand Full Document Analysis

Date: 2026-05-02
Status: Idea (not scheduled)
Related: Feature #4 MagicInsight (document_quality scanner flags candidates), Coversheet Detection

## Problem

MagicIndex extracts pages 1-5 (pdftotext) or 1-3 (OCR) with a 12,000-char cap. This is a deliberate trade-off for batch speed and LLM cost. But for legal documents, insurance policies, mortgage agreements, and contracts, the critical details — obligations, deadlines, penalties, exclusions, coverage limits, termination clauses — often live deep in the document, far past page 5.

The current shallow extraction captures titles and top-level metadata well, but for documents where the details matter to the family (what exactly does the insurance cover? what are the mortgage prepayment penalties? what are the custody agreement terms?), a 12,000-char preview is not enough.

## Proposed Solution

### Deep Read: On-Demand Full Extraction

A parent can trigger a "Deep Read" on any document. This:

1. **Extracts the full document text** — all pages via pdftotext + OCR fallback, no page or char limit (or a much higher limit, e.g., 100K chars).
2. **Persists the full extracted text** — stored in a new column or table, available for full-text search.
3. **Runs a specialized LLM summarization pass** with document-type-specific instructions:
   - **Legal/Contract**: Extract all parties, obligations, deadlines, penalties, termination clauses, governing law, dispute resolution.
   - **Insurance**: Extract coverage limits, deductibles, exclusions, covered perils, claim procedures, policy period.
   - **Medical**: Extract diagnoses, procedures, medications, provider info, follow-up dates, costs.
   - **Property/Mortgage**: Extract loan terms, interest rate, prepayment penalties, escrow requirements, property description.
   - **Tax**: Extract filing status, AGI, total tax, refund/owed, major deductions.
4. **Produces a structured Deep Read summary** stored as a new MagicIndex-style JSONB record — richer than the standard magicindex.v1 schema, with document-type-specific fields.
5. **Updates full-text search** — the deep-read text feeds into the document's search_vector, dramatically improving search recall.

### Data Model

```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS full_text TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deep_read_result JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deep_read_at TIMESTAMPTZ;
```

Or a separate table if full_text is large:

```sql
CREATE TABLE document_full_text (
  document_id INT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  full_text TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  page_count INT,
  char_count INT,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The deep_read_result JSONB would be document-type-specific but share a common envelope:

```json
{
  "schema_version": "deepread.v1",
  "document_type": "contract",
  "full_summary": "...",
  "key_dates": [{"label": "Effective", "date": "2024-01-15"}, ...],
  "key_amounts": [{"label": "Monthly payment", "value": 2450, "currency": "USD"}, ...],
  "key_parties": [{"role": "Borrower", "name": "John Smith"}, ...],
  "obligations": ["...", "..."],
  "exclusions": ["...", "..."],
  "type_specific": { ... }
}
```

### UX

- "Deep Read" button on document detail page (parent-only)
- Runs as a processing_job (job_type: 'deep_read')
- Progress indicator while running
- Result displayed as an expandable "Full Analysis" section on document detail
- Full text becomes searchable immediately

### Why This Matters

Legal documents are the ones families most need to understand and least want to read. A 30-page mortgage, a 15-page custody agreement, a 20-page insurance policy — these contain obligations and deadlines that affect the family daily, but they're impenetrable. Deep Read turns them into structured, searchable, actionable intelligence.

This also feeds MagicInsight: deep-read documents produce much richer MagicData (more accurate expiry dates, more cross-reference opportunities, better gap detection).

### Prerequisites

- Feature #4 MagicInsight (for document_quality scanner to flag candidates)
- Extended processing_jobs job_type to include 'deep_read'
- LLM context window consideration — a 100K-char document needs a model that can handle it, or chunked summarization
