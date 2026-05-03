# Feature #4C: MagicLinks — Superseding-First Document Relationships

Date: 2026-05-03
Parent feature: `feature-4-magic-insight.md`
Depends on: Feature #4A MagicInsight Foundation, Feature #4B Quality + Amount Normalization
Status: Revised after 4B real-vault evals

## Executive direction

Do **not** start MagicLinks as a generic "ask the LLM which documents are related" feature.

Start with a **superseding-first** relationship engine:

1. extract or normalize stable facts once per document
2. compare documents with deterministic rules
3. create reviewable `magic_links` suggestions
4. let parents accept / dismiss / manually add links

The first goal is not an abstract graph. The first goal is:

> HomeSource can tell when a newer document likely replaces an older one, without deleting history.

Examples:

- new homeowner policy supersedes old policy
- current vehicle registration supersedes prior registration
- amended return supersedes original return
- revised estimate supersedes earlier estimate
- later statement supersedes prior statement period

This is the most explainable and lowest-risk first link type for the current local model and current data quality.

## Why superseding first

Compared with general relatedness, superseding has stronger signals:

- same stable identifier
- later effective / issue / statement period
- explicit words like `renewal`, `amended`, `revised`, `updated`, `replacement`, `reprint`
- same asset / same account / same filer / same policy

This means the final decision can be mostly deterministic even if some of the input facts were originally extracted with MagicIndex.

## Core principle

**MagicIndex extracts facts. Rules assert links.**

The model should not sit in the hot path of pairwise document comparison.

### Near-term evidence sources

Use:

- `documents.document_type`
- `documents.issued_date`
- `documents.expiry_date`
- `documents.metadata.magicindex.suggestions.key_facts`
- `documents.metadata.magicindex.suggestions.summary`
- `documents.metadata.magicindex.suggested_owners`
- normalized amount/provider data from 4B

### Near-term decision engine

Use deterministic rules such as:

- same policy number + later term
- same VIN + later registration dates
- same tax year + amended filing markers
- same account/provider + later statement period
- same project/order number + revised estimate language

### LLM later

Local model may later help:

- rank borderline candidates
- generate short reasoning text
- classify relation type among a small allowed set

It should **not** be required for the first slice.

## First implementation prerequisite

Before building the supersede scanner, normalize `key_facts` labels upstream in `lib/magic-index/schema.js`.

Why this matters:

- current real-vault outputs use mixed forms like `Order Number`, `order_number`, `Policy Number`, `Claim Number`, `VIN`, `vin_number`, `plate_number`
- deterministic link rules become brittle if every scanner has to rediscover label equivalence
- canonical machine keys make supersede logic testable and auditable

Recommended shape for each key fact:

```json
{
  "label": "Policy Number",
  "key": "policy_number",
  "value": "LH-FLHO30022815-03",
  "confidence": 0.95
}
```

Keep both:

- `label` for UI / human readability
- `key` for deterministic scanners

Initial canonical keys to prioritize for 4C:

- `policy_number`
- `claim_number`
- `account_number`
- `statement_date`
- `statement_period`
- `invoice_date`
- `order_date`
- `order_number`
- `project_number`
- `vin`
- `plate_number`
- `tax_year`
- `form_type`
- `effective_date`
- `renewal_term`
- `provider_name`
- `insured_name`
- `property_address`

This should be treated as the first real plumbing step of 4C, not an optional cleanup.

## Scope

### In

- `magic_links` table
- manual links
- deterministic superseding suggestions
- a general link/rule framework that can support other relation types later
- document detail **Related Documents** section
- accept / dismiss review flow
- optional archive suggestion for accepted superseding links

### Out for first slice

- vault-wide semantic link discovery by LLM
- graph visualization
- asset registry
- autonomous auto-archiving
- household-level relationship reasoning

## First relation types to support

The table should remain general, but the first shipped rules should prioritize these:

1. `supersedes`
2. `renews`
3. `same_asset`
4. `same_account`
5. `relates_to` (manual fallback)

`supersedes` and `renews` are the real first-class product use cases.

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
    'same_asset',
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

## Directionality

Directional links preserve meaning:

- `supersedes`
- `renews`
- `supplements`

Symmetric links should be canonicalized before insert:

- `relates_to`
- `same_asset`
- `same_provider`
- `same_account`

Canonical rule: smaller document id as source, larger as target.

## Evidence fields to rely on

The first implementation should explicitly look for these evidence categories.

### Insurance / renewal

- policy number
- insured name(s)
- insured address / property address
- renewal effective date
- policy period
- expiration date
- renewal / declarations wording

### Vehicle

- VIN
- plate number
- registration expiry
- registration issue date
- vehicle model / year
- recall number for related non-superseding notice links

### Tax

- tax year
- filer names
- form type
- `amended` / `1040-X` / corrected wording

### Billing / statements

- account number
- provider name
- statement date
- statement period
- due date

### Estimates / invoices / work docs

- project number
- order number
- job address
- vendor / contractor
- `revised`, `updated`, `change order`, `replacement`, `reprint`

## Deterministic superseding rules

The following are the first rules worth implementing.

### Rule group 1 — insurance renewal / replacement

Candidate when:

- same policy number
- same insured or same property address
- later policy term / later effective date / later expiry

Output:

- `renews` if renewal wording is explicit
- `supersedes` if replacement is obvious but renewal wording is absent

Confidence:

- 0.95 exact policy number + later term
- 0.85 same insured/address + explicit renewal wording

### Rule group 2 — vehicle registration supersedes prior registration

Candidate when:

- same VIN or same plate
- later expiry or later issued date

Output:

- `supersedes`

Confidence:

- 0.95 same VIN + later registration
- 0.9 same plate + later registration

### Rule group 3 — amended return supersedes original return

Candidate when:

- same tax year
- same filer(s)
- one document shows `amended`, `1040-X`, `corrected`, or similar

Output:

- `supersedes`

Confidence:

- 0.95 explicit amended form + same year + same filers

### Rule group 4 — newer statement supersedes prior statement

Candidate when:

- same provider / same account number
- later statement date or later statement period

Output:

- `supersedes`

Confidence:

- 0.9 exact account + later period
- 0.75 same provider + owner + strong statement wording

### Rule group 5 — revised estimate / invoice supersedes prior version

Candidate when:

- same project number / order number / vendor + owner
- explicit wording such as `revised`, `updated`, `change order`, `replacement`, `reprint`
- later issue date

Output:

- `supersedes`

Confidence:

- 0.9 explicit same project + revision wording
- 0.75 same vendor + same owner + close dates + strong revision wording

## Non-superseding deterministic links

After superseding works, reuse the same evidence engine for:

- `same_asset`
  - same VIN
  - same property address
  - same parcel / loan / mortgagee
- `same_account`
  - same policy / claim / account number
- `same_provider`
  - same insurer / bank / practice / contractor

These should be secondary to superseding in priority and UI emphasis.

## Review UX

Document detail page gets a **Related Documents** section.

Each row/card shows:

- linked document title
- link type badge
- confidence
- reasoning
- status badge if suggested
- Accept / Dismiss for suggested links
- Add Link button with document picker

### Special handling for superseding

When a parent accepts a `supersedes` or `renews` suggestion:

- show a suggested next action:
  - `Archive older document`
  - `Keep both active`

Do **not** auto-archive on first slice.

The archive suggestion is important, but automatic archive is too risky for the first version.

## API

Parent-only writes. Read follows existing document ACL patterns.

| Method | Path | Purpose |
|---|---|---|
| GET | `api/documents/:id/links` | Links both directions |
| POST | `api/documents/:id/links` | Manual link |
| PUT | `api/links/:id` | Accept/dismiss/edit reasoning/type |
| DELETE | `api/links/:id` | Delete link |
| POST | `api/links/scan` | Run deterministic link scan |

## Implementation files

- `db/migrations/005-magic-links.sql`
- `lib/magic-links.js`
- `lib/scanners/magic-links-deterministic.js`
- `server.js` routes
- `public/document.html` section
- tests in `test/magic-links.test.js`

## Acceptance criteria

1. Parent can manually link two documents.
2. Document detail shows related documents in both directions.
3. Suggested links can be accepted/dismissed.
4. Deterministic rules create `supersedes` / `renews` suggestions for obvious same-identifier newer docs.
5. Symmetric links do not duplicate in reverse.
6. Directional links preserve source/target meaning.
7. Accepting a superseding link can suggest archiving the older doc.
8. Tests pass.

## What this plan deliberately does not assume

- It does **not** assume the local model should compare all document pairs.
- It does **not** assume freeform LLM linking is safe enough yet.
- It does **not** require a graph DB.

## Later LLM role

Once deterministic links are trusted, the local model may help with:

- ranking borderline candidates
- producing compact human-readable reasoning
- classifying candidate links among a small allowed set

But only after deterministic candidate generation narrows the field.

## Practical product outcome

If this works, HomeSource stops being just a pile of records and starts understanding document history:

- which registration is current
- which policy replaced the old one
- which estimate version is the latest
- which amended return supersedes the original

That is high-value household organization without asking the model to do mystical graph thinking.
