# Feature #4C: MagicLinks — Related Documents Graph

Date: 2026-05-02
Parent feature: `feature-4-magic-insight.md`
Depends on: Feature #4A MagicInsight Foundation
Status: Ready after 4A; can run parallel to 4B after schema decisions

## Purpose

Make HomeSource feel like an organized family vault rather than a flat file list by connecting documents that belong together: vehicle title ↔ insurance ↔ registration, old policy ↔ renewal, contract ↔ addendum, invoice ↔ warranty.

## Scope

### In

- `magic_links` table
- manual links
- deterministic link suggestions from shared policy/account/VIN/provider facts
- document detail "Related Documents" section
- accept/dismiss review flow

### Out for first slice

- LLM cross-reference scanner
- global graph visualization
- asset registry

## Schema

```sql
CREATE TABLE magic_links (
  id SERIAL PRIMARY KEY,
  source_document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'relates_to',
    'supersedes',
    'renews',
    'supplements',
    'covers_same_asset',
    'same_provider',
    'same_account'
  )),
  reasoning TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent', 'user')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'accepted', 'dismissed')),
  reviewed_by INT REFERENCES family_members(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_document_id <> target_document_id),
  UNIQUE (source_document_id, target_document_id, link_type)
);
```

## Directionality Rule

Directional links keep source/target meaning:

- `supersedes`
- `renews`
- `supplements`

Symmetric links should be canonicalized in code before insert:

- `relates_to`
- `covers_same_asset`
- `same_provider`
- `same_account`

Canonical rule: smaller document id as source, larger as target.

## Deterministic Link Signals

From MagicIndex `key_facts`, title, summary, tags:

- VIN exact match → `covers_same_asset`, confidence 0.95
- policy/account/claim number exact match → `same_account`, confidence 0.95
- provider + owner + document_type family → `same_provider`, confidence 0.75
- title contains renewal/year sequence → `renews`, confidence 0.75
- same address/property APN/parcel → `covers_same_asset`, confidence 0.9

## API

Parent-only writes. Parent and permitted owners can read through document detail if existing doc ACL allows.

| Method | Path | Purpose |
|---|---|---|
| GET | `api/documents/:id/links` | Links both directions |
| POST | `api/documents/:id/links` | Manual link |
| PUT | `api/links/:id` | Accept/dismiss/edit reasoning/type |
| DELETE | `api/links/:id` | Delete link |
| POST | `api/links/scan` | Run deterministic link scan |

## UI

Document detail page section: **Related Documents**

Each row/card:

- thumbnail
- linked document title
- link type badge
- status badge if suggested
- confidence
- reasoning
- Accept / Dismiss for suggested
- Add Link button with document picker

## Implementation Files

- `db/migrations/004-magic-links.sql` or fold into 003 if still pre-merge
- `lib/magic-links.js`
- `lib/scanners/magic-links-deterministic.js`
- `server.js` routes
- `public/document.html` section
- tests in `test/magic-links.test.js`

## Acceptance Criteria

1. Parent can manually link two documents.
2. Document detail shows related documents in both directions.
3. Suggested links can be accepted/dismissed.
4. Exact VIN/account/policy matches create deterministic suggested links.
5. Symmetric links do not duplicate in reverse.
6. Directional links preserve source/target.
7. Tests pass.

## LLM Later

Once deterministic links are trusted, add LLM scanner:

- group documents by type/owner
- send compact summaries/key facts
- ask for relationship candidates only
- validate link_type/confidence/reasoning
- create suggested links only
