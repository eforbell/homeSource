# Feature #11 PKI Hardening H3 Implementation Plan

Date: 2026-06-02
Status: Draft implementation plan
Parent: Feature #11 PKI Hardening Plan
Depends on: H1/H2 revoke hardening merged to `main`
Scope: Revoked-holder surfacing and document-level PKI health visibility only

---

## Goal

Make the PKI document detail screen and related key views explain revoked-holder
state clearly enough that users can understand:

1. which holders are still active
2. which holders are revoked historical paths
3. which holders are currently unlock-eligible for the signed-in member
4. whether the document is healthy, at risk, or stranded

This slice fixes the current confusing state where a revoked holder can still
appear in the document’s “authorized holders” list without a revoked badge,
while unlock actually fails because the server will not serve key material for
that key.

---

## What H3 does and does not do

### In scope

- revoked-holder badges on PKI document detail
- document-level PKI health summary
- clearer unlock copy when no eligible active holder remains
- API support to list revoked member keys where needed
- tests for revoked-holder visibility and unlock-selector filtering

### Out of scope

- holder replacement
- holder removal
- primary-pointer reassignment
- document envelope mutation
- new revoke guardrails (already handled in H1/H2)

---

## Current implementation anchor points

### Document detail / locked PKI state

In `public/document.html`:

- `getPkiHoldersFromDoc(doc, keyInfo)` merges envelope + resolved key metadata
- `getEligiblePkiHolders(doc, keyInfo)` filters:
  - current member only
  - `!holder.revoked_at`
- locked PKI render path lives in `renderEncryptedLockedState(doc)`

Important current behavior:
- revoked holders are already excluded from unlock eligibility
- but holder display does not visibly distinguish revoked vs active
- the “Authorized holders” list is flat text only

### Key info API

In `lib/pki.js` / `server.js`:

- `getDocumentKeyInfo(documentId)` returns `holders[]`
- each resolved holder already includes:
  - `label`
  - `protection_tier`
  - `verification_method`
  - `credential_verified`
  - `credential_id`
  - `revoked_at`

So H3 does **not** need a new document-key-info route shape to expose revoked
status — it is already present.

### Settings / member key listing

Current `listMemberKeys(memberId)` filters:
- `revoked_at IS NULL`

That means:
- Settings cannot currently show revoked keys
- H3 needs either:
  - `includeRevoked` support on the existing route
  - or a dedicated “historical keys” route

Recommendation: add `includeRevoked` support to the existing route.

Important current asymmetry:
- `getMemberKey(keyId, memberId)` already returns revoked keys and includes
  `revoked_at`
- `listMemberKeys(memberId)` currently does neither

This is helpful context for implementers because H1/H2 dependency analysis
already works for revoked keys via `getMemberKey()`, while Settings still
hides revoked keys because `listMemberKeys()` is the narrower query.

---

## Recommended implementation decisions

### Decision 1 — Extend `listMemberKeys()` with `includeRevoked`

Add optional support for:

- `GET /api/members/:id/keys?includeRevoked=1`

Why:
- smallest diff
- reuses existing Settings key list loading path
- keeps H3 lightweight

Default remains unchanged:
- no query param → active keys only

Implementation note:
- this is not just a `WHERE` clause change
- the current `SELECT` list in `listMemberKeys()` does not include
  `revoked_at`, so H3 must add that column to the returned row shape too

### Decision 2 — Keep revoked holders visible on the document page

Revoked holders should still appear in:
- “Authorized holders” / holder inventory

But with clear status:
- **Revoked**

Why:
- the envelope still contains them
- operator needs to understand historical vs active state
- this is the prerequisite to H4 repair flows

### Decision 3 — Continue filtering unlock selector to active eligible holders

Do not regress the current safety model.

Unlock selector should still show only:
- holders for current member
- with `!revoked_at`

H3 adds explanation, not broader unlock eligibility.

### Decision 4 — Add a first-class PKI health summary on the document page

Show a compact status block such as:

- `2 active holders · 1 revoked holder`
- `Healthy redundancy`
- `At risk: only one active unlock path remains`
- `Stranded: no active unlock paths remain`

This should be computed from the full holder set, not just current-member
eligibility.

### Decision 5 — Do not try to make revoked keys unlockable

H3 is explanatory only.

The app should not:
- serve revoked key material
- offer revoked keys in the unlock selector
- silently fallback to revoked historical paths

---

## Exact server-side approach

### Chunk 1: Add `includeRevoked` support to `listMemberKeys()`

Current:

```javascript
async function listMemberKeys(memberId) {
  ...
  WHERE member_id = $1 AND key_type = 'member' AND revoked_at IS NULL
}
```

Recommended shape:

```javascript
async function listMemberKeys(memberId, { includeRevoked = false } = {}) { ... }
```

Behavior:

- default: active keys only
- `includeRevoked: true`: include revoked rows too
- sort recommendation:
  - active keys first
  - then revoked keys
  - newest first within each group

Recommended returned fields for revoked keys:
- keep existing fields
- include `revoked_at`

### Chunk 2: Extend keys route in `server.js`

Current:

- `GET /api/members/:id/keys`

Add query support:

- `includeRevoked=1`

Auth posture:
- preserve current auth posture
- parents can review household keys, including revoked historical keys
- kids can only see their own

This should be treated as an intentional H3 product choice, not an incidental
side effect of the existing route guard. Household parent review of revoked
historical keys is useful for repair and estate-planning posture.

Implementation:

```javascript
const includeRevoked = req.query.includeRevoked === '1' || req.query.includeRevoked === 'true';
res.json(await pki.listMemberKeys(memberId, { includeRevoked }));
```

No new route needed.

---

## Implementation notes / gotchas

1. `listMemberKeys()` currently omits `revoked_at` from the `SELECT` list
   entirely, so simply loosening the `WHERE` clause is not enough.

2. `getMemberKey()` and `listMemberKeys()` are intentionally asymmetric today:
   - `getMemberKey()` already supports revoked-key visibility
   - `listMemberKeys()` does not

   H3 should preserve that difference only insofar as:
   - `getMemberKey()` remains the record-level lookup
   - `listMemberKeys(..., { includeRevoked: true })` becomes the list-level
     historical view for Settings

3. Parent visibility of revoked keys should be explicit in the plan and code
   review, since the existing keys route already allows parents to review
   household key posture.

---

## Exact client-side approach — document detail

### Chunk 3: Add holder-status helpers in `public/document.html`

Recommended new helpers:

```javascript
function countActivePkiHolders(holders) { ... }
function countRevokedPkiHolders(holders) { ... }
function classifyDocumentPkiHealth(holders) { ... }
function renderPkiHolderStatusBadges(holder, primaryKeyId) { ... }
```

Health classification recommendation:

- `healthy_redundancy`
  - active holder count >= 2
- `at_risk_single_active`
  - active holder count === 1
- `stranded_no_active`
  - active holder count === 0

### Chunk 4: Upgrade the holder list rendering

Current output is plain text:

`Name — Label (role · protection)`

Replace with richer line items that include:
- holder display name
- key label
- role badge
- protection tier badge
- `Active` / `Revoked` badge
- optional `Primary` badge if matches compatibility pointer

This can still be simple inline HTML; it does not need a new component system.

### Chunk 5: Add PKI health summary block to locked state

In `renderEncryptedLockedState(doc)` for PKI docs, add a short health section
near “Access model”.

Recommended display:

```text
PKI health: Healthy redundancy
2 active holders · 1 revoked holder
```

Alternative states:

- `At risk: only one active unlock path remains`
- `Stranded: no active unlock paths remain`

### Chunk 6: Improve the “no eligible holder” explanation

Current message:

- `None of your enrolled keys currently match this document.`

Replace with context-aware copy:

If signed-in member has holder entries but all are revoked:
- `Your historical holder entries on this document are revoked and can no longer unlock it.`

If signed-in member has no matching holders at all:
- keep the existing “none match” style

If no active holders exist on the whole doc:
- add stronger health text:
  - `This document currently has no active unlock paths in the app.`

This resolves the “button appears / then fails later” confusion by making the
document posture legible before unlock attempt.

---

## Exact client-side approach — Settings

### Chunk 7: Show revoked keys in Settings when requested

In `public/settings.js`:

- change `loadKeys()` to call:
  - `api/members/${member.id}/keys?includeRevoked=1`

Then split render behavior:

- active keys:
  - existing actions remain
- revoked keys:
  - no revoke button
  - no verify button
  - show revoked badge
  - show revoked date if available

Recommended revoked-row messaging:

- badge: `Revoked`
- helper text:
  - `Historical key — no longer usable for unlock or new PKI encryption`

### Chunk 8: Keep key summary readable

Current `summarizeKeys(keys)` counts all keys in one summary string.

With revoked keys included, change summary to something like:

- `3 active · 1 revoked · 2 verified · 2 with recovery`

This makes revoked-key presence visible at household posture level.

---

## API / data contract notes

### No schema changes required

H3 should ship without DB migrations.

Existing data already supports this:
- `encryption_keys.revoked_at`
- `getDocumentKeyInfo().holders[].revoked_at`

### No new dependency helper required

Do not reuse H1/H2 dependency summary on the document page.

For H3, document health should be derived from the document’s own holder set
already returned by `key-info`.

---

## Tests to add

### `test/pki.test.js`

Add `listMemberKeys(..., { includeRevoked: true })` coverage:

1. default excludes revoked keys
2. `includeRevoked: true` returns active + revoked keys
3. revoked row includes `revoked_at`

### API coverage

Add route tests for:

1. `GET /api/members/:id/keys?includeRevoked=1` returns revoked keys for owner
2. parent household review still works
3. kid still cannot inspect another member’s keys

Best home:
- extend existing API coverage file for key routes
- or add a focused `test/keys-api.test.js`

### Document UI/manual checks

Manual H3 checks should verify:

1. PKI doc with active + revoked holders
   - revoked holder visibly marked revoked
   - unlock selector excludes revoked holder
   - health summary says healthy / at-risk correctly

2. PKI doc where signed-in user only has revoked holder paths
   - no unlock selector option
   - explanatory text says their holder path is revoked

3. PKI doc with zero active holders
   - health summary says stranded
   - unlock button disabled or absent

### Optional browser automation later

If desired later, Playwright could validate:
- holder badges
- absence of revoked options in selector
- health summary text

Not required for the first H3 implementation pass.

---

## Suggested file-level diff map

### Required

- `lib/pki.js`
  - extend `listMemberKeys(memberId, { includeRevoked })`

- `server.js`
  - parse `includeRevoked` on `GET /api/members/:id/keys`

- `public/document.html`
  - add holder status helpers
  - add PKI health summary
  - enrich holder rendering
  - improve no-eligible-holder copy

- `public/settings.js`
  - request revoked keys
  - render revoked key rows distinctly
  - update key summaries

- tests
  - `test/pki.test.js`
  - key-route/API tests

### Optional in same pass

- `docs/security-capabilities.md`
  - update shipped status after merge:
    - revoked holders visible on document detail
    - revoked keys visible in settings/history

---

## Risks and how to contain them

### Risk 1 — Too much visual density on the locked document card

Mitigation:
- keep health summary to 1–2 lines
- keep holder lines compact
- use small badges, not paragraphs

### Risk 2 — Settings key list becomes noisy once revoked keys are shown

Mitigation:
- visually separate revoked keys
- no action buttons on revoked rows
- keep revoked rows lower emphasis than active rows

### Risk 3 — Users confuse “authorized historically” with “unlockable now”

Mitigation:
- badge revoked holders explicitly
- preserve unlock selector filtering
- add explicit explanatory copy

### Risk 4 — Scope creep into holder repair flows

Mitigation:
- no new mutation buttons in H3
- no replace/remove actions yet
- H3 is visibility only

---

## Recommended execution order

1. extend `listMemberKeys()` with `includeRevoked`
2. add API tests for revoked-key listing
3. update Settings to render revoked keys
4. enrich `public/document.html` holder rendering
5. add PKI health summary and no-eligible-holder copy
6. run focused tests + manual visual review

---

## Acceptance criteria

H3 is complete when:

1. revoked keys can be retrieved intentionally via `includeRevoked`
2. Settings shows revoked keys distinctly from active keys
3. PKI document detail visibly marks revoked holders
4. revoked holders are not selectable for unlock
5. document health summarizes active vs revoked holder posture
6. users can understand why a historical holder no longer unlocks a document

---

## Recommendation

Build H3 as the next branch-sized slice after H1/H2.

It is the right follow-on because H1/H2 made revoke **safe**, while H3 makes
revoke fallout **legible** — which is exactly the gap you observed in the doc
48 test flow.
