# HomeSource Feature #4: MagicInsight — Document Lifecycle Intelligence

Date: 2026-05-02
Scope: Home Source (`homeSource/`) — new feature layered on top of MagicIndex extraction data.
Primary outcome: turn the vault from a passive filing cabinet into an active family advisor that surfaces expiring documents, discovers cross-references between records, detects gaps in coverage, and delivers persisted, reviewable intelligence — not ephemeral LLM chat.

## Executive Decision

Build **MagicInsight** as the next major feature: a background intelligence layer that reasons over the full vault using the local private LLM, enriched by structured family profile data, and produces two new first-class data types — **MagicLinks** (document cross-references) and **MagicData** (persisted conclusions and alerts). Both are editable, dismissible, and integrated into the existing document UI.

## Delivery Decision

Do **not** ship this full plan as one PR. MagicInsight should be delivered as ordered, testable slices:

1. **4A — MagicInsight Foundation:** persisted `magic_data`, deterministic expiry scanner, staleness, review workflow, dashboard fix.
2. **4B — Quality + Amount Normalization:** bad metadata detection, amount/key-fact normalization, document_quality insights.
3. **4C — MagicLinks:** related-document graph, manual/deterministic links first, LLM links later.
4. **4D — Household Gap Detection + Life Events:** optional DOB/legal names, deterministic milestones, private-provider-gated LLM gap detection.

See `planning/features/feature-4-delivery-index.md` and the per-slice artifacts:

- `planning/features/feature-4a-insight-foundation.md`
- `planning/features/feature-4b-quality-amount-normalization.md`
- `planning/features/feature-4c-magic-links.md`
- `planning/features/feature-4d-household-gap-detection.md`

This feature leverages three assets that are already built and mostly idle:

1. **MagicIndex extraction results** — 140+ documents with persisted structured metadata (titles, types, dates, amounts, key_facts, summaries, owners).
2. **Local private LLM** — already configured and operational for MagicIndex, sitting idle between imports.
3. **Worker queue pattern** — `processing_jobs` table with `FOR UPDATE SKIP LOCKED` claiming, retry/backoff, and stale recovery.

## Current Codebase Facts

- MagicIndex results persist in `import_items.magicindex_result` (JSONB) and are applied to `documents.metadata.magicindex` including field_confidence, extraction_evidence, and the full `suggestions` object.
- Text extraction covers pages 1-5 via `pdftotext` and pages 1-3 via OCR fallback, truncated at `MAGICINDEX_MAX_CHARS` (default 12000).
- Documents carry `issued_date`, `expiry_date`, `document_type` (13 types), `metadata` JSONB, and full-text search via `tsvector`.
- Key_facts array in MagicIndex results captures structured details (e.g., policy numbers, account numbers, VINs, property addresses) with per-fact confidence.
- Family members have: `name` (TEXT), `role` (parent/kid), `avatar_emoji`, `color`, `passphrase_hash`. No DOB, no structured legal name, no relationship data.
- Worker (`bin/import-worker.js`) polls every 1500ms, handles job types `store_import_item`, `thumbnail`, `magicindex`.
- Processing_jobs table CHECK constraint currently limits `job_type` to those three values — migration will extend this.
- App config stored in `app_config` table (key/value pairs).
- All 140+ existing documents have MagicIndex data persisted and contributing to full-text search.

## RALPLAN-DR Summary

### Principles

1. **Persisted, reviewable intelligence**: Every insight the LLM produces becomes a `magic_data` or `magic_link` record the user can accept, edit, dismiss, or delete. Nothing lives only in LLM context.
2. **Deterministic first, LLM second**: Expiry alerts and life-event milestones are date math — they don't need an LLM. Cross-references and gap detection do. Separate the layers so the LLM-free insights are instant and reliable.
3. **Minimalist onboarding**: Ask only for what drives insights: DOB and legal name per family member. Don't build a census form.
4. **Background scanning with manual trigger**: The LLM runs on a schedule via the worker queue, but parents can trigger a scan anytime. New document imports should trigger incremental analysis.
5. **Privacy-preserving**: All reasoning runs on the already-configured local LLM. MagicData records are local. No cloud dependency.

### Decision Drivers

1. The vault has 140+ well-indexed documents — the extraction data is there but produces no proactive value today.
2. A private LLM is configured, idle, and paid for. Using it for background intelligence is near-zero marginal cost.
3. The worker queue pattern is proven and extensible.
4. The family profile is too thin to ground the LLM's reasoning about who owns what and what's missing.

### Viable Options Considered

| Option | Summary | Pros | Cons | Decision |
|---|---|---|---|---|
| A. Dashboard alerts only | Simple expiry/date alerting on document list | Fast to build, no LLM needed | Misses cross-references, gap detection, and the deep value | Build as Phase 1 but not the whole feature |
| B. Chat-with-your-docs | RAG/conversational interface over documents | Flashy demo, familiar UX | Ephemeral answers, no persistence, requires vector search, hard to act on | Reject for now |
| C. MagicInsight (persisted intelligence) | Background agent produces reviewable MagicData + MagicLinks | Durable value, editable, composable with future features, uses existing infrastructure | More schema, new UX patterns for review workflow | Choose |
| D. Full knowledge graph | Neo4j-style entity/relationship extraction | Deepest possible intelligence | Massive scope, over-engineered for 140 docs, needs a graph DB | Defer |

## Data Model

### Family Profile Extension

```sql
-- Migration 003-magic-insight.sql

ALTER TABLE family_members ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS legal_first_name TEXT;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS legal_middle_name TEXT;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS legal_last_name TEXT;
```

Why these fields: DOB drives life-event detection (turning 18, turning 26 for insurance, turning 65 for Medicare). Legal names enable the LLM to match document references like "JOHN M SMITH" to family member "John Smith". No SSN, no address — those live in the documents themselves.

### MagicLinks Table

```sql
CREATE TABLE magic_links (
  id SERIAL PRIMARY KEY,
  source_document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'relates_to',        -- general relationship
    'supersedes',        -- newer version of same document
    'renews',            -- renewal of prior policy/contract
    'supplements',       -- addendum, rider, or supporting document
    'covers_same_asset', -- same house, car, person
    'same_provider',     -- same insurance company, bank, issuer
    'same_account'       -- same account/policy number
  )),
  reasoning TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent', 'user')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted', 'dismissed')),
  reviewed_by INT REFERENCES family_members(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_document_id, target_document_id, link_type)
);

CREATE INDEX idx_magic_links_source ON magic_links (source_document_id);
CREATE INDEX idx_magic_links_target ON magic_links (target_document_id);
CREATE INDEX idx_magic_links_status ON magic_links (status);
```

Why this shape: Links are bidirectional in display but stored with source/target for directional types (supersedes, renews, supplements). The reasoning field is critical — the user needs to understand WHY the agent thinks these documents are related. Confidence lets the UI sort suggested links by strength.

### MagicData Table

```sql
CREATE TABLE magic_data (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'expiry_alert',        -- document expiring soon
    'missing_document',    -- expected document not found
    'coverage_gap',        -- insurance/warranty gap detected
    'renewal_reminder',    -- time to renew with lead time
    'life_event',          -- age milestone with document implications
    'financial_summary',   -- aggregated cost/value insight
    'document_quality',    -- extraction issue, coversheet, incomplete metadata
    'household_insight'    -- general observation about the vault
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'warning', 'info')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document', 'member', 'household')),
  subject_id INT,
  title TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}',
  confidence NUMERIC(4,3),
  source_document_ids INT[] NOT NULL DEFAULT '{}',
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'dismissed', 'stale', 'resolved')),
  action_url TEXT,
  due_date DATE,
  expires_at TIMESTAMPTZ,
  scan_id TEXT,
  reviewed_by INT REFERENCES family_members(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_magic_data_category ON magic_data (category);
CREATE INDEX idx_magic_data_status ON magic_data (status) WHERE status IN ('new', 'accepted');
CREATE INDEX idx_magic_data_subject ON magic_data (subject_type, subject_id);
CREATE INDEX idx_magic_data_due ON magic_data (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_magic_data_scan ON magic_data (scan_id);
```

Key design choices:

- **`body` JSONB**: Category-specific structured data. Examples below.
- **`source_document_ids` INT[]**: Which documents produced this insight — enables "show me why" and staleness detection.
- **`scan_id`**: Groups insights from the same scan run for batch staleness/replacement.
- **`due_date`**: When the user should act (e.g., 8 weeks before passport expiry). Enables calendar-ordered views.
- **`expires_at`**: When this insight becomes stale and should be auto-marked `stale` (e.g., annual summaries expire after their year).
- **`severity`**: Drives dashboard prioritization. Critical = requires action soon. Warning = worth reviewing. Info = useful awareness.

### MagicData Body Schemas (by category)

**expiry_alert:**
```json
{
  "document_id": 42,
  "document_title": "US Passport — John Smith",
  "document_type": "identification",
  "expiry_date": "2027-03-15",
  "lead_time_days": 56,
  "recommended_action": "Begin passport renewal — processing takes 6-8 weeks",
  "days_until_expiry": 317,
  "owner_names": ["John Smith"]
}
```

**missing_document:**
```json
{
  "expected_type": "insurance",
  "expected_description": "Auto insurance policy for 2024 Toyota RAV4",
  "evidence": "Vehicle title (doc #38) references a 2024 Toyota RAV4 but no auto insurance document mentions this vehicle",
  "related_document_ids": [38],
  "member_names": ["Eric F."]
}
```

**life_event:**
```json
{
  "member_name": "Sarah F.",
  "event": "turning_18",
  "event_date": "2026-09-01",
  "affected_documents": [
    {"document_id": 15, "title": "Health Insurance Policy", "action": "Review dependent status"},
    {"document_id": 22, "title": "Custodial Bank Account", "action": "Convert to individual account"},
    {"document_id": 8, "title": "Passport", "action": "May need to renew as adult passport"}
  ],
  "additional_actions": [
    "Register to vote",
    "Consider opening individual bank account",
    "Review power of attorney / medical proxy"
  ]
}
```

**coverage_gap:**
```json
{
  "gap_type": "insurance_lapse",
  "description": "Homeowner's insurance policy expires 2026-06-01; no renewal document on file",
  "current_policy_id": 31,
  "current_policy_title": "State Farm Homeowner's Policy 2025-2026",
  "gap_starts": "2026-06-01",
  "estimated_risk": "Property uninsured if not renewed"
}
```

**financial_summary:**
```json
{
  "period": "2025",
  "period_type": "tax_year",
  "category": "deductible_receipts",
  "count": 14,
  "total_amount": 4217.50,
  "currency": "USD",
  "document_ids": [101, 102, 103, ...],
  "breakdown": [
    {"label": "Medical", "amount": 1850.00, "count": 5},
    {"label": "Charitable", "amount": 2367.50, "count": 9}
  ]
}
```

**document_quality:**
```json
{
  "document_id": 55,
  "document_title": "Mortgage Agreement",
  "issue": "coversheet_detected",
  "description": "First page appears to be a cover/transmittal sheet — key terms may be on subsequent pages",
  "suggestion": "Re-run MagicIndex with extended page range or manually verify metadata",
  "extraction_chars": 340,
  "expected_min_chars": 2000
}
```

### Processing Jobs Extension

```sql
ALTER TABLE processing_jobs DROP CONSTRAINT IF EXISTS processing_jobs_job_type_check;
ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_job_type_check
  CHECK (job_type IN ('store_import_item', 'thumbnail', 'magicindex', 'insight_scan'));
```

### Insight Scan Config

```sql
INSERT INTO app_config (key, value) VALUES
  ('insight_scan_frequency_hours', '168'),
  ('insight_scan_last_run', NULL),
  ('insight_expiry_lead_days', '{"identification": 56, "insurance": 30, "warranty": 14, "contract": 30, "default": 21}')
ON CONFLICT (key) DO NOTHING;
```

## Dashboard Problem This Solves

The current dashboard "Expiring Soon" widget (as of 2026-05-02) demonstrates exactly why naive expiry display is counterproductive:

- Shows **offer letters from 2006** and **tax returns from 2016-2017** as "expiring soon" — they expired a decade ago.
- Tax returns don't meaningfully "expire" — MagicIndex saw a year-end date and classified it as expiry_date.
- The "10 Expiring Soon" stat in the dashboard header is misleading noise.

MagicInsight's expiry scanner replaces this with intelligence:

1. **Only future expiries** (or recently-expired within a configurable grace window, e.g., 30 days).
2. **Document-type awareness**: tax returns, old employment contracts, and historical records get filtered out or classified as `document_quality` issues (bad expiry_date assignment) rather than expiry alerts.
3. **Severity + lead time**: "Passport expires in 10 weeks — renewal processing takes 6-8 weeks" vs. just showing a date.
4. **Due date ordering**: sorted by when the user needs to act, not when the document expires.

When MagicInsight ships, the dashboard "Expiring Soon" section should be replaced by an "Insights" summary card pulling from MagicData with category=expiry_alert and status=new, severity=critical|warning.

## Architecture

### Scanner Design

The insight scanner runs as `insight_scan` jobs in the existing worker process. Two tiers:

**Tier 1 — Deterministic (no LLM):**
Runs on every scan. Pure SQL + date math.

1. **Expiry Scanner**: Query all active documents with `expiry_date` within configured lead window. Generate `expiry_alert` and `renewal_reminder` MagicData. No LLM needed.
2. **Life Event Scanner**: For each family member with `date_of_birth`, compute upcoming milestones (18, 21, 26, 65) within the next 12 months. Cross-reference owned documents by type. Generate `life_event` MagicData. No LLM needed.
3. **Financial Aggregator**: Group documents with `metadata.magicindex.suggestions.amount` by period and type. Generate `financial_summary` MagicData. No LLM needed.
4. **Staleness Sweeper**: Mark existing MagicData as `stale` when `expires_at` has passed or when source documents have been updated since the insight was created.

**Tier 2 — LLM-Powered:**
Runs on schedule or on-demand. Uses the configured local LLM.

5. **Cross-Reference Scanner**: For each document, assemble a context of its MagicIndex key_facts + summary + type + owners. Ask the LLM to compare against summaries of other documents and identify relationships. Generate `magic_link` records. Batch documents by type to limit LLM calls.
6. **Gap Detection Scanner**: Send the LLM a structured summary of: all family members (with DOB, legal names), all document types present with counts and owners, and ask it to identify expected-but-missing documents. Generate `missing_document` and `coverage_gap` MagicData.
7. **Document Quality Scanner**: For each document where `extraction_evidence.text_preview_chars` is suspiciously low relative to `file_size_bytes`, or where `needs_review_reasons` is non-empty, ask the LLM to assess whether the extraction was likely hamstrung by a coversheet or poor first-page content. Generate `document_quality` MagicData.

### Scanner Execution Model

```
insight_scan job payload:
{
  "scan_type": "full" | "incremental" | "single_document",
  "document_id": null | INT,       // for single_document scans
  "tiers": ["deterministic", "llm"] | ["deterministic"],
  "scan_id": "scan-20260502-abc"   // groups all insights from this run
}
```

**Full scan**: Runs both tiers across all documents. Triggered on schedule or manually.
**Incremental scan**: Runs both tiers only for documents created/updated since last scan. Triggered after batch import completes.
**Single document scan**: Runs cross-reference + quality for one document. Triggered when a document is manually updated.

### LLM Prompt Strategy for Cross-References

Rather than comparing every document pair (O(n^2)), the scanner:

1. Groups documents by type (all insurance together, all vehicle docs together, etc.)
2. Groups documents by owner
3. For each group, sends a batch prompt with document summaries asking for intra-group relationships
4. Then sends a cross-group prompt for high-value cross-type links (e.g., vehicle title ↔ auto insurance)

Target: ~10-15 LLM calls for a 140-document vault, not 140^2.

### LLM Prompt Strategy for Gap Detection

One call with a structured household summary:

```
Family Members:
- Eric F. (parent, DOB 1985-03-12)
- Jane F. (parent, DOB 1987-07-20)
- Sarah F. (kid, DOB 2008-09-01)

Documents on File (by type):
- identification: 4 (Passport x2, Driver License x2)
- insurance: 3 (Home, Auto, Health)
- vehicle: 2 (2024 RAV4 Title, 2020 Civic Title)
- property: 1 (Deed)
- ...

Given this household profile and document inventory, identify:
1. Documents that a typical household SHOULD have but are missing
2. Coverage gaps (e.g., vehicle with title but no insurance)
3. Documents that may need updating based on family member ages
```

Response is validated against the MagicData body schema for `missing_document` and `coverage_gap`.

## Server API Surface

### Insights API (parent-only)

| Method | Path | Description |
|---|---|---|
| GET | `api/insights` | List MagicData records, filterable by category, status, severity, subject |
| GET | `api/insights/:id` | Single MagicData record with source documents |
| PUT | `api/insights/:id` | Update status (accept/dismiss), edit title/body |
| DELETE | `api/insights/:id` | Permanently delete insight |
| GET | `api/insights/summary` | Dashboard counts by category and severity |
| POST | `api/insights/scan` | Trigger manual scan (full or incremental) |
| GET | `api/insights/scan/status` | Current scan progress |

### MagicLinks API (parent-only)

| Method | Path | Description |
|---|---|---|
| GET | `api/documents/:id/links` | List MagicLinks for a document (both directions) |
| POST | `api/documents/:id/links` | Create manual MagicLink |
| PUT | `api/links/:id` | Update link status (accept/dismiss) |
| DELETE | `api/links/:id` | Delete link |

### Family Profile API (extends existing)

| Method | Path | Description |
|---|---|---|
| PUT | `api/members/:id/profile` | Update DOB, legal name fields |
| GET | `api/members/:id/profile` | Get extended profile |

## Frontend UX

### Insights Dashboard (`public/insights.html`)

Primary view for MagicInsight. Sections:

1. **Action Required** — Critical and warning severity, status=new, sorted by due_date.
2. **Recent Insights** — Latest scan results, chronological.
3. **By Category** — Tabbed or filtered view: Expiring, Missing, Coverage, Life Events, Financial, Quality.
4. **Scan Controls** — Last scan time, next scheduled scan, "Scan Now" button.

Each insight card shows:
- Severity indicator (red/amber/blue)
- Title and category badge
- Source document thumbnails (clickable)
- Accept / Dismiss / Edit actions
- "Show reasoning" expandable

### Document Detail Enhancement

Add a "Related Documents" section to existing document detail page:
- Shows all MagicLinks (accepted + suggested) for this document
- Each link shows: linked document thumbnail, link type badge, reasoning, confidence
- Accept / Dismiss actions on suggested links
- "Add Link" button for manual cross-references

### Family Profile Settings

Extend existing member management UI:
- Add DOB date picker
- Add legal name fields (first, middle, last)
- Privacy note: "This data stays on your server and helps the vault identify your documents"

### Navigation

Add "Insights" to main navigation bar, with a badge showing count of new critical/warning items.

## Implementation Steps

### Phase 1 — Schema + Family Profile (Stories 1.1–1.3)

**Story 1.1: Database migration**
- Create `003-magic-insight.sql`
- Extend `family_members` with DOB and legal name columns
- Create `magic_links` table with indexes
- Create `magic_data` table with indexes
- Extend `processing_jobs` job_type CHECK constraint
- Add default `app_config` entries for scan settings
- Update `db/schema.sql`
- Add migration tests

**Story 1.2: Family profile API + UI**
- Add `PUT api/members/:id/profile` and `GET api/members/:id/profile`
- Extend member management page with DOB and legal name fields
- Privacy copy on the form
- Test: profile update persists and returns correctly

**Story 1.3: MagicData + MagicLinks CRUD APIs**
- Add `lib/insights.js` — CRUD for magic_data, filtering, summary counts
- Add `lib/magic-links.js` — CRUD for magic_links, bidirectional queries
- Add API routes to server.js
- Add tests for create/read/update/filter operations

### Phase 2 — Deterministic Scanners (Stories 2.1–2.4)

**Story 2.1: Expiry scanner**
- `lib/scanners/expiry.js` — queries documents with expiry_date, computes lead times from `app_config.insight_expiry_lead_days`, generates MagicData records
- Idempotent: updates existing alerts for same document rather than duplicating
- Test: given 3 documents with varying expiry dates and configured lead times, produces correct alerts with correct severity

**Story 2.2: Life event scanner**
- `lib/scanners/life-events.js` — for each member with DOB, computes upcoming milestones (18, 21, 26, 65) within configurable horizon (default 12 months)
- Cross-references owned documents to build affected_documents list
- Test: given a member turning 18 in 4 months with owned passport and health insurance, produces correct life_event MagicData

**Story 2.3: Financial aggregator**
- `lib/scanners/financial.js` — queries documents with amount data in metadata.magicindex, groups by tax year and document_type
- Generates financial_summary MagicData with breakdown
- Test: given 5 receipts across 2 categories, produces correct summary with totals

**Story 2.4: Staleness sweeper**
- `lib/scanners/staleness.js` — marks MagicData as 'stale' when expires_at passed or source documents updated
- Runs as first step of every scan
- Test: insight with expired expires_at gets marked stale; insight whose source doc was updated gets marked stale

### Phase 3 — LLM-Powered Scanners (Stories 3.1–3.4)

**Story 3.1: Scanner orchestrator + insight_scan job type**
- Extend `bin/import-worker.js` to handle `insight_scan` job type
- `lib/scanners/orchestrator.js` — runs configured scanner sequence, generates scan_id, tracks progress
- Manual trigger via `POST api/insights/scan` enqueues an `insight_scan` job
- Scheduled trigger via `app_config.insight_scan_frequency_hours`
- Test: enqueueing and claiming an insight_scan job works end-to-end

**Story 3.2: Cross-reference scanner**
- `lib/scanners/cross-references.js` — loads document summaries from metadata.magicindex
- Groups by type and owner for batched LLM calls
- Prompt asks LLM to identify relationships and classify by link_type
- Validates response, creates magic_link records with status='suggested'
- Idempotent: skips links that already exist
- Test (mocked LLM): given 3 vehicle docs (title, insurance, registration), produces correct magic_links

**Story 3.3: Gap detection scanner**
- `lib/scanners/gap-detection.js` — assembles household summary (members + document type inventory)
- Single LLM call with structured prompt
- Validates response, creates missing_document and coverage_gap MagicData
- Test (mocked LLM): given a household with vehicle title but no auto insurance, produces missing_document insight

**Story 3.4: Document quality scanner**
- `lib/scanners/document-quality.js` — identifies documents with low extraction_evidence.text_preview_chars relative to file_size_bytes
- Optional LLM call to assess if extraction was hamstrung
- Creates document_quality MagicData with suggestions
- Test: document with 200 chars extracted from a 2MB PDF gets flagged

### Phase 4 — Insights UI (Stories 4.1–4.4)

**Story 4.1: Insights dashboard page**
- `public/insights.html` — Action Required section, Recent Insights, category filters
- Polling for scan progress when scan is running
- Severity indicators, source document thumbnails, accept/dismiss/edit actions
- Mobile-first layout matching existing app patterns

**Story 4.2: Document detail — Related Documents section**
- Add MagicLinks display to existing document detail page
- Show both accepted and suggested links
- Accept/dismiss actions
- "Add Link" button for manual cross-references with document picker

**Story 4.3: Review workflow**
- Accept: marks status='accepted', records reviewed_by and reviewed_at
- Dismiss: marks status='dismissed' with same audit
- Edit: inline edit of title and body fields
- Bulk actions: accept/dismiss all in a category or from a scan

**Story 4.4: Navigation + dashboard integration**
- Add "Insights" link to main nav with badge count (new critical + warning items)
- Add insights summary card to main dashboard page
- Family profile link in settings/member management

### Phase 5 — Automation + Polish (Stories 5.1–5.3)

**Story 5.1: Scheduled scanning**
- Worker checks `app_config.insight_scan_frequency_hours` and `insight_scan_last_run`
- Auto-enqueues full scan when interval has elapsed
- Configurable in settings UI

**Story 5.2: Import-triggered incremental scan**
- After batch import completes (all items reach terminal status), auto-enqueue incremental scan for new documents
- After single document upload, enqueue single_document scan

**Story 5.3: Scan configuration UI**
- Settings page section for MagicInsight configuration
- Scan frequency, expiry lead times per document type, LLM tier toggle
- Last scan results summary

## Acceptance Criteria

1. A parent can add DOB and legal name for each family member in settings, and this data persists correctly.
2. Expiry alerts appear automatically for documents with expiry_date within the configured lead window, with correct severity and recommended action timing.
3. Life event insights appear for family members approaching milestone ages, with correct affected document lists.
4. Cross-reference scanner produces MagicLinks between related documents (e.g., vehicle title ↔ auto insurance) with human-readable reasoning.
5. Gap detection identifies at least one expected-but-missing document for a household with obvious gaps (e.g., vehicle with no insurance on file).
6. All MagicData records are reviewable: accept, dismiss, edit title/body, view reasoning, view source documents.
7. All MagicLinks are reviewable: accept, dismiss, view reasoning.
8. Insights dashboard shows action-required items sorted by due_date, with severity indicators and category filters.
9. Document detail pages show related documents via MagicLinks.
10. Deterministic scanners (expiry, life events, financial) run without LLM and produce correct results.
11. LLM scanners work with the existing local MagicIndex provider configuration.
12. Scan can be triggered manually; scheduled scanning enqueues jobs automatically.
13. `npm test` passes, including new scanner/API/CRUD tests.
14. Duplicate insights are not created on re-scan — scanners are idempotent.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| LLM hallucinations in gap detection | Confidence scoring + all insights are suggestions until accepted. Reasoning is visible. |
| Cross-reference scanner is O(n^2) | Batch by type/owner groups, not pairwise. ~10-15 LLM calls for 140 docs. |
| Scan takes too long with local LLM | Tier 1 (deterministic) runs instantly. Tier 2 (LLM) runs in background worker. Progress is visible. User doesn't wait. |
| Stale insights after document updates | Staleness sweeper marks insights stale when source docs change. Re-scan refreshes. |
| Family profile feels invasive | Only ask for DOB + legal name. Clear privacy copy. Data stays local. Fields are optional. |
| MagicIndex extraction was too shallow for some docs | Document quality scanner flags these. Coversheet detection is a natural output. Future: re-extraction with more pages. |
| Schema migration on existing 140-doc DB | All new tables, only ALTER adds nullable columns to family_members. Zero risk to existing data. |

## Non-Goals for This Slice

- Vector search / semantic similarity (defer to future feature)
- Calendar integration / push notifications (defer — dashboard-only for MVP)
- Automated document renewal workflows (defer — insights suggest, user acts)
- Multi-page re-extraction for flagged documents (defer — flag now, fix later)
- MCP server integration (defer to Feature #10)
- Kid-visible insights (parent-only for MVP)

## Follow-ups

1. **Coversheet detection + re-extraction**: When document_quality scanner flags a coversheet, offer one-click re-extraction with extended page range. See `planning/features/idea-coversheet-detection.md`.
2. **Calendar export**: Export due_date items as .ics for calendar integration.
3. **Insight notifications**: Surface critical insights via homeBase webhook or similar.
4. **Trend tracking**: Compare financial_summary across years to show trends.
5. **Asset registry**: Extract a first-class asset model (vehicles, properties, accounts) from MagicLinks + MagicData, enabling "show me everything related to the house."
