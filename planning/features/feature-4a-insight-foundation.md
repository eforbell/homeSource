# Feature #4A: MagicInsight Foundation — Deterministic Insights + Dashboard Fix

Date: 2026-05-02
Parent feature: `feature-4-magic-insight.md`
Status: Ready for implementation planning

## Purpose

Ship the smallest useful MagicInsight slice: replace noisy dashboard expiry signals with persisted, reviewable, deterministic insights. This proves the `magic_data` model and review workflow without relying on LLM behavior.

## Product Promise

HomeSource stops acting like a passive file list and starts saying: "these are the document facts you need to act on soon." Every item is explainable, dismissible, and grounded in local database state.

## Scope

### In

- `magic_data` table
- insight CRUD library/API
- deterministic expiry scanner
- staleness sweeper
- dashboard Insights summary card replacing/augmenting noisy "Expiring Soon"
- parent-only accept/dismiss/edit workflow
- manual "Scan now" trigger for deterministic scan

### Out

- LLM cross-document reasoning
- MagicLinks
- household gap detection
- family DOB/profile fields
- financial summaries
- scheduled scans beyond a simple manual trigger

## Schema

```sql
CREATE TABLE magic_data (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'expiry_alert',
    'renewal_reminder',
    'document_quality',
    'household_insight'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'warning', 'info')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document', 'member', 'household')),
  subject_id INT,
  dedupe_key TEXT NOT NULL,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  UNIQUE (category, dedupe_key)
);

CREATE INDEX idx_magic_data_category ON magic_data (category);
CREATE INDEX idx_magic_data_status ON magic_data (status) WHERE status IN ('new', 'accepted');
CREATE INDEX idx_magic_data_subject ON magic_data (subject_type, subject_id);
CREATE INDEX idx_magic_data_due ON magic_data (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_magic_data_scan ON magic_data (scan_id);
```

### Dedupe key examples

- `expiry_alert:document:42:2027-03-15`
- `renewal_reminder:document:42:2027-01-18`
- `document_quality:document:55:bad_expiry_tax_return`

## Scanner Rules

### Expiry alert scanner

Input: active documents with `expiry_date`.

Rules:

1. Ignore null expiry dates.
2. Ignore document types that usually represent historical records unless explicitly configured:
   - `tax`
   - old employment `contract` records older than configurable grace window
   - generic `other` with low expiry confidence
3. Ignore dates more than 30 days in the past by default; these become `document_quality` candidates, not urgent expiry alerts.
4. Generate future alerts when `expiry_date <= now + lead_time`.
5. Severity:
   - `critical`: due date is today/past or expiry within 14 days
   - `warning`: action due within configured lead window
   - `info`: farther out but still relevant, if included by config

### Lead-time defaults

```json
{
  "identification": 56,
  "insurance": 30,
  "warranty": 14,
  "contract": 30,
  "vehicle": 30,
  "property": 30,
  "default": 21
}
```

### Bad expiry quality rule

If a document has an expiry date that is clearly historical/noisy (e.g. tax return with `expiry_date=2017-12-31`), create a `document_quality` insight:

- category: `document_quality`
- severity: `info`
- title: `Possible incorrect expiry date on 2017 Tax Return`
- body includes current expiry date and why it was ignored

## API

Parent-only.

| Method | Path | Purpose |
|---|---|---|
| GET | `api/insights` | List/filter MagicData |
| GET | `api/insights/summary` | Dashboard counts by severity/category |
| GET | `api/insights/:id` | Insight detail |
| PUT | `api/insights/:id` | Edit title/body/status |
| DELETE | `api/insights/:id` | Delete insight |
| POST | `api/insights/scan` | Manual deterministic scan |

## UI

### Dashboard

Replace the current naive "Expiring Soon" widget with an "Insights" card:

- `Action Required` count: new critical + warning
- top 3 due items sorted by `due_date`
- link to Insights page
- if no urgent items: reassuring empty state

### Insights page MVP

- list cards grouped by severity
- filters: category, severity, status
- Accept / Dismiss buttons
- Show reasoning/source docs

## Implementation Files

- `db/migrations/003-magic-insight-foundation.sql`
- `lib/insights.js`
- `lib/scanners/expiry.js`
- `lib/scanners/staleness.js`
- `server.js` route additions
- `public/insights.html`
- `public/dashboard.html` update
- tests in `test/insights.test.js`

## Acceptance Criteria

1. `magic_data` migration applies cleanly to existing DB.
2. Running deterministic scan creates expiry alerts only for future/actionable dates.
3. Historical tax-return "expiry" dates do not appear as urgent dashboard items.
4. Duplicate scan does not create duplicate insights.
5. Parent can accept/dismiss/edit an insight.
6. Dashboard displays new critical/warning count and top due insights.
7. Kid users cannot access insights APIs.
8. Tests pass.

## Risks

- Existing bad `expiry_date` values could create noise. Mitigation: conservative filtering and document_quality classification.
- Dashboard behavior changes. Mitigation: keep old document detail data untouched; only replace widget logic.
