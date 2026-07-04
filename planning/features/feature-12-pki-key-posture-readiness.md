# Feature #12: PKI Key Posture and Readiness

Date: 2026-07-04
Status: Complete for current scope; optional document-list posture deferred
Parent: Feature #11 PKI Document Vault
Depends on: Feature #11 PKI hardening H1-H4.2 shipped on `main`
Scope: Operator-visible key/document posture before destructive key lifecycle actions

---

## Executive summary

Feature #11 H1-H4.2 made PKI revocation safe at mutation time: when an
operator attempts to revoke a key, Home Source can inspect dependent documents,
show affected titles, and block revocation if it would strand a document.

Feature #12 should make the same kind of information visible **before** the
operator reaches a destructive lifecycle action.

The feature goal is not more cryptography. It is a readiness layer that answers:

- Which keys protect which vaulted documents?
- Which documents have only one active unlock path?
- Which backup keys have never been exercised?
- Which keys lack recovery material?
- Which revoked holders remain as stale document metadata?
- What should the operator do next to reduce key-loss risk?

This is a deliberate bridge before Use Case 2 estate/quorum work. The current
operator-owned 1-of-M model needs observable key readiness and rehearsal before
more complex threshold or deadman flows are added.

---

## Context and shipped foundation

### Current shipped behavior

- Settings key cards already show protection tier, active/revoked status,
  verified ceremony, recovery posture, created date, and `last_used_at` when set
  (`public/settings.js:232-283`).
- The app can fetch per-key dependency summaries through
  `GET /api/members/:id/keys/:keyId/dependencies` (`server.js:588-599`).
- The revoke flow already uses that dependency summary before mutation and shows
  affected document counts/titles when revoke is safe (`public/settings.js:337-410`).
- The server blocks normal-route revocation when a key is a sole active holder
  for any PKI document or when holder metadata is inconsistent
  (`server.js:601-636`).
- `lib/pki.getKeyDependencySummary(...)` already classifies referenced documents
  as `alternate_holders_available`, `sole_active_holder`,
  `all_holders_revoked`, or `holder_metadata_inconsistent`
  (`lib/pki.js:228-368`).
- `encryption_keys.last_used_at` exists and `pki.updateKeyLastUsed(...)` can
  update it (`lib/pki.js:13-31`, `lib/pki.js:137-142`).
- Document detail already computes document-level PKI health for individual docs
  (`public/document.html:633-655`) and conditionally exposes repair actions
  (`public/document.html:1717-1739`).

### Gap

The dependency and health data exists mostly as **revoke-time preflight** or
**single-document detail**. It is not yet an operator posture surface.

An operator can discover risk when trying to revoke a key, but cannot easily
review key readiness in advance, rehearse backup keys, or prioritize which
single-holder documents need backup access.

---

## Product goal

Give the operator a PKI readiness view that makes key-loss risk observable and
actionable before any destructive key lifecycle operation.

A parent/operator should be able to open Settings and answer:

1. Which of my keys are actually protecting PKI documents?
2. Which keys are sole active holders for any documents?
3. Which PKI documents have weak redundancy?
4. Which backup keys have never been tested or used recently?
5. Which keys lack recovery material?
6. What is the safest next action: add backup key, test unlock, replace revoked
   holder, remove revoked holder, or postpone revoke?

---

## Non-goals

- Threshold / quorum PKI
- Shamir share reconstruction
- Deadman switch or estate workflow execution
- Changing the 1-of-M access model
- General active-holder removal or policy editing
- Recovery-mode access to revoked key material
- Replacing JSONB envelope canonical state with a relational source of truth
- Adding a background dependency index unless scale requires it

---

## Design principles

1. **Readiness before mutation**
   - Do not make revoke the first time an operator sees key/document impact.

2. **Observation without new crypto authority**
   - This feature should summarize existing envelope/key state. It should not
     grant access, unwrap DEKs, or change holder policy by itself.

3. **Rehearsal is distinct from revocation**
   - Testing a key should be framed as confidence-building, not as a lifecycle
     mutation.

4. **Use the envelope as source of truth**
   - For the current scale and Use Case 1, derive posture from
     `documents.encryption_metadata.files.*.holders[]` and `encryption_keys`.

5. **Prefer actionable counts over noisy tables**
   - Surface the few states that demand operator attention: sole-holder docs,
     never-tested keys, missing recovery, revoked holder clutter, inconsistent
     metadata.

---

## Recommended UX

### 1. Settings key card posture summary

Extend each key card with a compact posture block:

- `Protects 7 PKI docs`
- `Sole active holder for 0 docs`
- `At-risk docs: 0`
- `Last tested: Jun 4, 2026` or `Never tested`
- `Recovery set` / `No recovery`

Recommended actions:

- `View Protected Documents`
- `Test Unlock`
- existing `Verify`
- existing `Revoke` only after posture is visible

The existing key row already has badges and `last_used_at` display
(`public/settings.js:232-283`), so this should extend rather than replace that
card.

### 2. Protected-documents modal per key

A `View Protected Documents` action should show a modal/table derived from the
existing dependency summary:

| Document | Role | Holder posture | Key status | Next action |
|---|---|---|---|---|
| Passport | owner | sole active holder | active | Add backup key |
| Will | backup | alternate holders available | active | Healthy |
| Account fingerprints | owner | alternate holders available | revoked | Remove revoked holder |

Minimum fields:

- title + link to document detail
- target key role
- active holder count
- revoked holder count
- status classification
- whether the key is the primary/preferred pointer

### 3. PKI readiness panel

Add a Settings-level panel above the key list:

- `PKI docs: N`
- `Healthy redundancy: N`
- `At risk: N with only one active unlock path`
- `Stranded: N with no active unlock paths`
- `Inconsistent metadata: N`
- `Keys never tested: N`
- `Keys without recovery: N`

This is the surface that separates operator awareness from mutation-time revoke
preflight.

### 4. Test unlock ceremony

Add a non-destructive `Test Unlock` flow for an active key.

First-pass behavior:

- The user proves possession of the key using the same local key-unlock ceremony
  used for document unlock.
- The app successfully unwraps that member private key locally.
- The server records `last_used_at` for the key through a small authenticated
  endpoint.
- No document DEK needs to be unwrapped in v1.

Optional stronger v1.1 behavior:

- If the key protects at least one PKI document available to the current member,
  allow a user-selected test document and unwrap its DEK locally without
  rendering/downloading plaintext.
- This is a stronger readiness proof but requires more UI ceremony and should be
  separate from the first-pass key-possession test.

Suggested copy:

> “Test this key to confirm you can still use it. This does not open documents,
> change access, or revoke anything.”

---

## API / data model approach

### Option A — Reuse per-key dependency route and aggregate client-side

Use existing:

- `GET /api/members/:id/keys`
- `GET /api/members/:id/keys/:keyId/dependencies`

Pros:

- Smallest server change
- Builds directly on shipped H1/H2 dependency semantics
- Good enough for household-scale key counts

Cons:

- Settings may issue one dependency request per visible key
- Harder to compute global doc-level posture without duplicate work

### Option B — Add a posture summary route

Add:

- `GET /api/pki/posture`

Recommended response shape:

```json
{
  "summary": {
    "pki_document_count": 12,
    "healthy_document_count": 9,
    "at_risk_document_count": 2,
    "stranded_document_count": 0,
    "inconsistent_document_count": 1,
    "active_key_count": 4,
    "untested_active_key_count": 1,
    "keys_without_recovery_count": 2
  },
  "keys": [
    {
      "id": 42,
      "member_id": 1,
      "label": "Yubikey (backup)",
      "revoked_at": null,
      "last_used_at": null,
      "recovery_enabled": true,
      "document_count": 7,
      "safe_docs": 7,
      "at_risk_docs": 0,
      "already_stranded_docs": 0,
      "inconsistent_docs": 0
    }
  ],
  "documents": [
    {
      "document_id": 88,
      "title": "Will",
      "active_holder_count": 2,
      "revoked_holder_count": 0,
      "status": "healthy_redundancy"
    }
  ]
}
```

Pros:

- One route supports the key cards, readiness panel, and future document-list
  badges.
- Server can share helper logic with `getKeyDependencySummary(...)`.
- Easier to test one canonical posture computation.

Cons:

- Slightly larger first implementation.
- Requires careful auth posture if showing household-wide parent data.

### Recommendation

Implement Option B as the primary route, but reuse/refactor the existing
`getKeyDependencySummary(...)` logic rather than introducing a new canonical
model.

Reasoning: Feature #12 is specifically about cross-key/cross-document posture.
A dedicated posture route avoids turning the Settings page into a fan-out of
per-key preflight calls and gives future dashboard/list indicators a stable
source.

---

## Authorization posture

First pass:

- Parent members can view household PKI posture.
- Kid members can view only their own key posture and documents they can access.
- Key material remains self-only; posture does not expose private key material.
- `Test Unlock` is self-only because it requires proving possession of the key.

This mirrors existing boundaries:

- kids cannot inspect another member's key dependency route (`server.js:588-599`)
- key material route is self-only (`server.js:575-586`)
- settings already allows parents to review household key status without allowing
  cross-member key registration/revocation.

---

## Implementation plan

### Slice 1 — Server posture helper and route

Files:

- `lib/pki.js`
- `server.js`
- `test/pki-api.test.js` or new `test/pki-posture-api.test.js`

Work:

1. Extract shared document-holder classification helpers from
   `getKeyDependencySummary(...)`.
2. Add `getPkiPostureSummary(actorMember)` or equivalent.
3. Compute:
   - per-key dependency counts
   - per-document active/revoked/inconsistent state
   - global readiness counts
   - untested active keys (`last_used_at IS NULL`)
   - keys without recovery (`recovery_enabled = false`)
4. Add `GET /api/pki/posture`.
5. Preserve auth boundaries for parent vs kid actors.

Acceptance criteria:

- Parent response includes household keys and PKI docs.
- Kid response excludes other members' key posture and inaccessible docs.
- A key protecting seven docs reports `document_count: 7` before any revoke
  attempt.
- A sole-active-holder document increments both document at-risk count and the
  responsible key's at-risk count.
- Inconsistent holder metadata appears in summary and does not crash the route.

### Slice 2 — Settings readiness panel and key-card summaries

Files:

- `public/settings.js`
- `public/settings.html` if structure changes are needed
- `test/pki-api.test.js` plus lightweight UI/static tests if practical

Work:

1. Fetch posture after loading members/keys.
2. Render a compact `PKI Readiness` panel above key cards.
3. Add per-key posture lines to each key card.
4. Add `View Protected Documents` action that opens a modal/table using posture
   data.
5. Keep the existing revoke dialog behavior unchanged, but its preflight should
   feel like confirmation of already-visible posture rather than first discovery.

Acceptance criteria:

- Settings shows key usage counts without pressing `Revoke`.
- A key with no dependent documents says `Protects 0 PKI docs`.
- A key with sole-holder documents clearly labels that risk.
- The protected-documents modal links to document detail pages.
- Revoked keys are shown as historical and not offered `Test Unlock` or `Revoke`.

### Slice 3 — Test Unlock ceremony updates `last_used_at`

Files:

- `server.js`
- `lib/pki.js`
- `public/settings.js`
- `test/pki-api.test.js`
- `test/webauthn-api.test.js` if WebAuthn ceremony options are reused

Work:

1. Add a narrow endpoint, for example:
   - `POST /api/members/:id/keys/:keyId/tested`
2. Self-only route; reject revoked keys.
3. Client only calls the endpoint after local key unwrap succeeds.
4. Reuse existing passphrase/WebAuthn PRF key-unlock helper logic where possible.
5. Update key-card `last_used_at` / `Last tested` display after success.

Acceptance criteria:

- A passphrase-protected key can be tested and updates `last_used_at`.
- A WebAuthn-backed key can be tested after assertion/PRF success.
- The endpoint rejects cross-member attempts.
- The endpoint rejects revoked keys.
- Failed local proof does not update `last_used_at`.

### Slice 4 — Optional document-list posture indicators

Files:

- `lib/documents.js`
- `server.js`
- `public/documents.html`
- `test/documents-api.test.js`

Work:

1. Decide whether to include PKI health in `GET /api/documents` or fetch it from
   `GET /api/pki/posture` and join client-side.
2. Add small badges on document browse cards:
   - `PKI healthy`
   - `PKI at risk`
   - `PKI stranded`
   - `Revoked holder cleanup`
3. Keep this optional if Slice 1-3 already deliver sufficient operator value.

Acceptance criteria:

- Operator can identify at-risk PKI docs without opening each detail page.
- Kid access does not leak parent document titles or posture.
- Browse performance remains acceptable for household-scale vaults.

---

## Test plan

### Unit / helper tests

- Posture helper classifies healthy, at-risk, stranded, and inconsistent docs.
- Posture helper counts active/revoked holders correctly.
- Untested key count excludes revoked keys unless explicitly included in a
  historical section.
- Keys without recovery count is based on `recovery_wrapped_private_key IS NULL`.

### API tests

- `GET /api/pki/posture` requires auth.
- Parent sees household posture.
- Kid sees only own/accessible posture.
- Route handles malformed holder metadata without 500.
- Route counts a key's dependent docs before any revoke attempt.
- `POST /api/members/:id/keys/:keyId/tested` updates `last_used_at` only for the
  key owner and only for active keys.

### UI / integration tests

- Settings renders readiness panel counts.
- Key cards render `Protects N PKI docs` and `Sole active holder for N docs`.
- Protected-documents modal lists affected documents with status labels.
- Test Unlock success updates the displayed last-tested state.
- Existing revoke confirmation and revoke-block behavior remains unchanged.

### Regression tests

- Existing H1/H2 revoke guard tests keep passing.
- Existing H4 repair tests keep passing.
- Existing kid metadata-leak tests keep passing.

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Posture panel duplicates revoke-preflight logic and drifts | Misleading safety data | Reuse/refactor `getKeyDependencySummary(...)` classification helpers |
| Parent posture view leaks sensitive document titles to kids | Access control regression | Explicit parent/kid test cases and reuse document access checks |
| Settings becomes noisy | Operators ignore warnings | Prioritize counts and action labels; put full document lists behind modal |
| `last_used_at` becomes overclaimed as “document successfully decrypted” | False confidence | Label first-pass action as key test, not document recovery rehearsal |
| Dependency scanning becomes slow | Settings latency grows with vault size | Household-scale scan first; defer H5 projection/index until measured need |
| Test Unlock endpoint trusts client too much | Malicious client could mark key tested | Treat `last_used_at` as advisory readiness metadata, not security proof; if stronger proof is needed, add server challenge later |

---

## Open decisions

1. Should `last_used_at` be renamed in UI to `Last tested` for PKI keys to avoid
   implying document plaintext was opened?
2. Should `Test Unlock` first-pass only prove member private-key unwrap, or should
   it require selecting a protected document and unwrapping a DEK locally?
3. Should parent posture include all household keys by default, or should other
   members' posture be summarized without document titles?
4. Should `GET /api/pki/posture` include document-level posture for all docs, or
   only key-level summaries plus per-key detail on demand?
5. Should keys without recovery be treated as warning-level risk even if they are
   backup keys?

---

## Recommended first implementation slice

Ship Slices 1-2 first:

- `GET /api/pki/posture`
- Settings PKI Readiness panel
- Per-key posture counts
- Protected-documents modal

Then ship Slice 3 as a separate readiness rehearsal pass:

- Test Unlock ceremony
- `last_used_at` update after successful local proof

Why this order:

- The operator-awareness gap is the highest-value concern.
- It avoids conflating posture visibility with new unlock ceremony design.
- It gives a concrete foundation for deciding whether document-level rehearsal is
  worth the added ceremony.

---

## Implementation readiness artifacts

Prepared 2026-07-04:

- `.omx/plans/prd-feature-12-pki-key-posture-readiness.md`
- `.omx/plans/test-spec-feature-12-pki-key-posture-readiness.md`

Locked first-pass decisions:

- Implement `GET /api/pki/posture` as the canonical posture source.
- Refactor `lib/pki.getKeyDependencySummary(...)` classification into shared
  helpers so revoke-time guardrails and pre-mutation posture cannot drift.
- Ship Settings readiness panel, per-key posture counts, and a protected-docs
  modal before implementing Test Unlock.
- Keep Test Unlock as a separate Slice 3 because it changes ceremony behavior
  and `last_used_at` semantics.
- Treat active keys without recovery as warning-level posture.
- Kid posture must be scoped to own keys and document-owner access; parent
  posture can include household keys and document titles.

Implemented 2026-07-04:

- Shared PKI posture classification helpers in `lib/pki.js`.
- `GET /api/pki/posture` route.
- API regression coverage in `test/pki-posture-api.test.js`.
- Settings PKI Readiness panel, per-key posture counts, and protected-documents
  modal.
- Self-only `POST /api/members/:id/keys/:keyId/tested` route.
- Settings Test Unlock ceremony for active self-owned keys. The ceremony unwraps
  the member private key locally before recording `last_used_at`.

Verification:

- `npm run test:prepare` passed on local Postgres test DB.
- Slices 1-2 targeted PKI tests passed: 15 tests, 0 failures.
- Slice 3 targeted PKI/WebAuthn tests passed: 29 tests, 0 failures.
- Full suite passed after Slices 1-2: 297 tests, 0 failures.
- Full suite passed after Slice 3: 299 tests, 0 failures.
- Slice 1-2 operator smoke passed.
- Slice 3 operator/browser smoke passed.
- Protected-documents modal prioritization smoke passed.

Deferred:

- Slice 4 document-list posture indicators are intentionally deferred. Settings
  now provides global PKI readiness, per-key risk counts, Test Unlock readiness,
  and an attention-first protected-documents modal. Adding PKI posture directly
  to `GET /api/documents` would increase list/API surface area before there is
  evidence that browse-page badges are needed.

## Acceptance criteria summary

Feature #12 is ready when:

1. A parent can see PKI key/document posture in Settings before choosing revoke.
2. Each active key shows how many PKI documents it protects.
3. Each active key shows how many documents would be at risk if that key were
   lost or revoked.
4. The operator can open a protected-documents list for a key without initiating
   revoke.
5. The app surfaces keys that have never been tested and keys without recovery.
6. The app preserves existing revoke preflight and server-side revoke guardrails.
7. Kid users cannot learn parent document titles or key posture.
8. Optional Test Unlock updates readiness metadata only after successful local
   proof.
9. Full test suite passes with existing PKI hardening tests intact.
