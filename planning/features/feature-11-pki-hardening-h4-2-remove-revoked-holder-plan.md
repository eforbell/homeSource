# Feature #11 PKI Hardening H4.2 Implementation Plan

Date: 2026-06-04
Status: Draft implementation plan
Parent: Feature #11 PKI Hardening Plan
Depends on: H1/H2 revoke hardening merged to `main`, H3 revoked-holder visibility merged to `main`, H4.1 same-member revoked-holder replacement merged to `main`
Scope: Safe standalone removal of already-revoked PKI holders

---

## Goal

Add a narrow cleanup flow that lets an operator remove a **revoked** PKI holder
from a document **without** replacing it, as long as the document still retains
at least one active unlock holder afterward.

This is intended for cleanup scenarios such as:

- an operator replaced a soft-key with a hardware key
- the old soft-key was revoked
- the document still has healthy active holders
- the operator wants to remove stale revoked holder clutter from the envelope

---

## What H4.2 does and does not do

### In scope

- remove a revoked PKI holder from an existing PKI document
- preserve ciphertext bytes
- preserve unchanged holder integrity
- reassign `documents.encryption_key_id` if the removed revoked holder was the
  compatibility pointer
- provide a document-detail UI path for cleanup

### Out of scope

- removing active holders
- removing the last active holder
- cross-member policy edits
- role editing
- batch cleanup of many documents
- generalized holder mutation UI

---

## Why this slice is valuable

H3 made revoked historical holders visible.
H4.1 made it possible to replace a revoked same-member holder with a new one.

But there is still a simpler, common operator case:

> the revoked holder is already obsolete, redundancy is healthy, and the
> operator just wants to remove the stale entry.

That should not require manufacturing a replacement holder if the document is
already in a healthy state.

---

## Recommended product rule

### Allow removal only when all of the following are true

1. the target holder is already **revoked**
2. the target holder currently exists on the document
3. the resulting holder set remains non-empty
4. the resulting holder set still contains at least **one active holder**

### Explicitly do not allow yet

1. removal of active holders
2. removal that leaves zero active holders
3. removal that leaves an empty holder set
4. policy-editing semantics disguised as cleanup

---

## Current implementation anchor points

### Existing add-holder route

- `POST /api/documents/:id/pki-holders/add`

Already shows:
- route-local validation
- exact unchanged-holder integrity checks
- use of `updatePkiDocumentAccess(...)`

### Existing replace-holder route

- `POST /api/documents/:id/pki-holders/replace`

Already shows:
- delta validation between current envelope and submitted envelope
- pointer reassignment
- audit logging for repair mutations

H4.2 should follow the same shape as replace, but with a smaller delta:

- **one revoked holder removed**
- **no new holder added**

### Existing persistence primitive

`updatePkiDocumentAccess(...)` already handles:
- `SELECT ... FOR UPDATE`
- validation callback
- metadata + compatibility pointer update

No new DB primitive is needed.

---

## Recommended implementation decisions

### Decision 1 — Use a dedicated remove route

Add:

- `POST /api/documents/:id/pki-holders/remove`

Do **not** try to reuse:
- add-holder route
- replace-holder route
- a generic patch/mutation route

Why:
- very narrow semantics
- easy to reason about
- easier to review

### Decision 2 — First-pass route only removes revoked holders

This should be a hard first-pass invariant:

- target holder must already be revoked

Why:
- low ambiguity
- operator cleanup intent is clear
- avoids accidentally weakening live access

### Decision 3 — Do not require crypto proof for revoked-holder removal

Unlike add/replace, revoked-holder removal is an envelope-only mutation:
- no DEK unwrap
- no DEK re-wrap
- no new wrapped_dek artifact that proves the client actually accessed the
  document key material

So a client-side “proof” step here would be largely ceremonial unless the
server gained a separate challenge/response mechanism for removal, which is
overkill for this cleanup flow.

For first-pass H4.2, rely on:
- authenticated session
- parent posture
- document access authorization
- revoked-holder-only restriction
- exact envelope-delta validation
- active-holder-remains invariant

This is intentionally different from add/replace because remove does not
perform a cryptographic mutation.

### Decision 4 — Preserve pointer when possible, reassign when necessary

If the removed revoked holder is not the current compatibility pointer:
- keep the pointer unchanged

If the removed revoked holder **is** the current compatibility pointer:
- reassign to the first active remaining holder

### Decision 5 — UI should present this as cleanup, not a cryptographic event

Suggested label:

- `Remove Revoked Holder`

Suggested description:

- “Remove a historical revoked holder from this document. Ciphertext bytes stay unchanged.”

This is cleaner than positioning it like a more dramatic crypto ceremony.

---

## Exact server-side approach

### Chunk 1: Add route

Recommended route:

- `POST /api/documents/:id/pki-holders/remove`

Recommended request body:

```json
{
  "remove_holder_key_id": 12,
  "encryption_metadata": { "...updated envelope..." }
}
```

Meaning:
- `remove_holder_key_id`: revoked existing holder being removed
- `encryption_metadata`: full updated envelope after removal

The server must not trust these fields blindly; it must validate the actual
delta.

### Chunk 2: Route invariants

Required invariants:

1. document exists and is PKI-encrypted
2. target key id exists in current holder set
3. target holder is revoked
4. submitted envelope removes exactly one holder
5. submitted envelope adds zero holders
6. all unchanged holders preserve:
   - member_id
   - role
   - key_fingerprint
   - wrapped_dek fields exactly
7. resulting holder set is non-empty
8. resulting holder set contains at least one active holder

### Chunk 3: Pointer reassignment helper

Reuse or extract a helper like:

```javascript
function choosePrimaryHolderKeyId(holders, previousPrimaryKeyId, keysById) { ... }
```

Recommended behavior:
- if previous primary still exists and is active, keep it
- otherwise choose first active remaining holder
- route should reject earlier if no active remaining holder exists

### Chunk 4: Audit event

Add:

- `document.pki_holder_removed`

Suggested details:
- removed holder member id
- removed holder key id
- removed holder role
- holder_count_before
- holder_count_after
- old primary pointer
- new primary pointer

If practical, this audit write should happen inside the same transaction as the
document mutation; if not, keep current post-commit pattern as an explicit
tradeoff.

---

## Exact client-side approach

### Chunk 5: Add document-detail action

Show:

- `Remove Revoked Holder`

Only when:
- document is PKI-encrypted
- signed-in user has at least one active eligible holder
- document contains at least one revoked holder

### Chunk 6: Modal flow

Modal fields:

1. revoked holder to remove

No replacement-key selector needed.

Suggested body copy:

> Remove a historical revoked holder from this document. Ciphertext bytes stay unchanged. At least one active holder must remain.

### Chunk 7: Client helper

Recommended helper:

```javascript
function buildRemovalEnvelope({
  doc,
  keyInfo,
  removeHolderKeyId
}) { ... }
```

Behavior:
- start from `buildNormalizedPkiEnvelope(...)`
- remove the target revoked holder from `holders[]`
- preserve all other holders exactly
- do not generate any new wrapped DEKs

### Chunk 8: Auth posture

For first pass:
- require authenticated session
- require parent posture
- require document access authorization

Do **not** require passphrase/WebAuthn proof for the remove-revoked flow.

The server-side protection comes from:
- revoked-only target enforcement
- unchanged-holder integrity validation
- active-holder-remains validation

---

## Candidate filtering rules

### Revoked holder candidates

For the remove modal:
- only revoked holders should appear

### Hide the action when it can’t succeed

As with the H4.1 replace-action visibility fix:
- do not show the action button if there are no revoked holders
- do not show the action button if removing the revoked holder would leave zero
  active holders

---

## Tests to add

### New focused API tests

Best home:
- extend `test/pki-holder-repair-api.test.js`

Add:

1. removes a revoked holder successfully when another active holder remains
2. preserves ciphertext bytes after removal
3. reassigns `encryption_key_id` if the removed revoked holder was the pointer
4. rejects removal if target holder is not revoked
5. rejects removal if submitted envelope removes more than one holder
6. rejects removal if submitted envelope adds a new holder
7. rejects removal if unchanged holder metadata is altered
8. rejects removal if it would leave zero active holders
9. rejects removal if it would leave an empty holder set

### Manual / UX checks

1. doc with one active + one revoked holder
   - remove revoked holder succeeds
   - healthy state updates correctly

2. doc where revoked holder was primary pointer
   - removal succeeds
   - pointer reassigns sensibly

3. doc with only revoked holders remaining after attempted removal
   - server rejects
   - UI shows useful error

4. action visibility
   - button hidden when no revoked holders
   - button hidden when removing a revoked holder would leave zero active holders

---

## Suggested file-level diff map

### Required

- `server.js`
  - add `/api/documents/:id/pki-holders/remove`

- `public/document.html`
  - add Remove Revoked Holder action
  - add modal
  - add `buildRemovalEnvelope(...)`
  - add submit flow

- tests
  - extend `test/pki-holder-repair-api.test.js`

### Optional

- extract pointer helper to `lib/pki.js` if duplication with replace route is
  becoming annoying

---

## Risks and how to contain them

### Risk 1 — Remove route drifts into active-holder policy editing

Mitigation:
- first pass only removes revoked holders

### Risk 2 — Cleanup route strands the doc

Mitigation:
- reject if resulting holder set has zero active holders
- reject empty holder sets

### Risk 3 — UI complexity continues to grow

Mitigation:
- keep modal minimal
- avoid adding replacement-style extra selectors
- consider a later consolidated encrypted-document UX pass

---

## Recommended execution order

1. implement remove route validation and tests
2. verify pointer reassignment / empty-holder rejection behavior
3. add UI action + modal
4. verify manual cleanup flow on a real doc

---

## Acceptance criteria

H4.2 is complete when:

1. revoked holders can be removed without re-encrypting the document
2. unchanged holders remain metadata-identical
3. ciphertext bytes stay unchanged
4. document always retains at least one active holder afterward
5. pointer reassigns sensibly if the removed revoked holder was primary
6. the cleanup action only appears when it is actually usable

---

## Recommendation

This is the next most sensible H4 follow-on after H4.1.

It directly addresses the operator cleanup case:
- soft-key replaced by hardware key
- soft-key revoked
- operator wants stale history removed

without widening into active-holder removal or broader policy editing.
