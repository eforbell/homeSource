# Feature #11 PKI Hardening H4 Implementation Plan

Date: 2026-06-02
Status: Draft implementation plan
Parent: Feature #11 PKI Hardening Plan
Depends on: H1/H2 revoke hardening merged to `main`, H3 revoked-holder visibility merged to `main`
Scope: Supported PKI holder repair flows for existing documents

---

## Goal

Move PKI document maintenance from:

- add-only holder mutations

to:

- deliberate, supported holder repair operations

without changing ciphertext and without weakening the “prove access with an
already-authorized active holder” requirement.

H4 should make it possible to repair the kinds of document states H3 now makes
visible:

1. replace a stale/revoked holder with a new key
2. remove a stale/revoked holder once another active path exists
3. reassign the compatibility pointer when the old primary/preferred holder is
   no longer the right pointer

---

## What H4 does and does not do

### In scope

- replace an existing PKI holder on a document
- remove an existing PKI holder from a document
- preserve existing ciphertext bytes
- preserve unchanged holder integrity
- compatibility-pointer reassignment when the referenced primary holder changes
- UI actions for repairing revoked/stale holder state

### Out of scope

- threshold / quorum PKI
- async ceremonies
- batch repair of many documents at once
- automatic migration of all stale documents
- relational holder indexing / projection redesign

---

## Current implementation anchor points

### Existing add-holder mutation route

Current route:

- `POST /api/documents/:id/pki-holders/add`

Behavior today:
- requires parent mutation posture
- requires PKI document
- validates updated envelope via `validatePkiUpload(...)`
- explicitly forbids removal of existing holders
- preserves unchanged existing holder metadata and wrapped DEKs
- allows exactly one new holder to be added

This route is the best starting point for H4 because it already demonstrates
the intended safety pattern:

1. client proves access with an active holder
2. client unwraps current DEK
3. client re-wraps DEK for the new holder
4. server validates and persists the updated envelope

### Existing client-side proof / re-wrap helpers

In `public/document.html`:

- `getPkiHoldersFromDoc(doc, keyInfo)`
- `getEligiblePkiHolders(doc, keyInfo)`
- `buildNormalizedPkiEnvelope(doc, keyInfo)`
- `buildExtendedEnvelopeWithHolder(...)`
- `buildExtendedEnvelopeWithBackupKey(...)`

These helpers already cover:
- selecting an active current holder
- passphrase / WebAuthn proof
- private key unwrap
- DEK unwrap
- new wrapped DEK creation

H4 should extend this helper family instead of inventing a parallel repair
implementation path.

### Existing validation constraints

In `lib/pki.js`, `validatePkiUpload(...)` already:
- checks holder uniqueness
- checks key existence
- checks revoked/new holder constraints
- checks role constraints
- allows grandfathering of existing holder IDs for repair compatibility

H4 should reuse this validator, but pair it with mutation-specific route rules.

### Existing DB write path

`updatePkiDocumentAccess(...)` in `lib/documents.js` already:
- locks PKI document row
- runs route-level validation callback
- updates `encryption_metadata`
- updates `encryption_key_id`

This is the correct persistence primitive for H4 too.

---

## Recommended release order

### H4.1 — Replace Holder

Do this first.

Why:
- safest user mental model
- easiest to explain
- repairs revoked/stale holder state without reducing redundancy
- avoids “remove first, maybe add later” danger

### H4.2 — Remove Holder

Do this second.

Why:
- requires stronger invariants
- easier once replace flow already exists
- best used to clean up stale historical holders after successful replacement

### H4.3 — Primary/preferred pointer reassignment polish

Do this third, or fold minimal pointer reassignment into H4.1/H4.2 server logic.

Why:
- mostly compatibility / display hygiene
- should not block repair flows

---

## Recommended implementation decisions

### Decision 1 — Use dedicated routes, not a polymorphic “mutate holders” route

Add:

- `POST /api/documents/:id/pki-holders/replace`
- `POST /api/documents/:id/pki-holders/remove`

Do **not** introduce:
- a generic `PATCH /pki-holders`
- a free-form “replace/remove/add in one payload” mutation route

Why:
- smaller validation surface
- easier review
- safer user-facing semantics

### Decision 2 — Keep all repair crypto client-side

Repair must continue to require:
- active eligible holder selection
- passphrase or WebAuthn proof
- client-side DEK unwrap
- client-side re-wrap where applicable

Server should remain:
- validation + persistence only

### Decision 3 — Replace flow should be additive-first, subtractive-second

For replacement:

1. unwrap DEK with current active holder
2. wrap DEK to replacement key
3. persist updated envelope that:
   - adds the replacement holder
   - removes the replaced holder
   - preserves all other holders unchanged

This should happen as a single document update, but conceptually it is:
- prove current access
- establish new access
- retire old access

### Decision 3.5 — First-pass replacement inherits the replaced holder’s role

For H4.1:
- the replacement holder should inherit the replaced holder’s role

Do **not** support role changes during replacement in the first pass.

Why:
- keeps repair separate from policy editing
- narrows server delta validation
- avoids a “replace holder” action also becoming a silent role-reassignment tool

If product later wants role changes, treat that as a separate explicit feature.

### Decision 4 — Remove flow should be blocked if it would leave zero active holders

Never allow:
- empty holder set
- all-revoked holder set
- document state with no active holders introduced by the mutation

### Decision 4.5 — Proof requirement for removal should be explicit

Replacement clearly requires crypto proof because the DEK is unwrapped and
re-wrapped.

Removal is trickier because it can be an envelope-only mutation.

Two viable policies:

#### Option A — Require active-holder proof for removal too

Pros:
- strongest consistency with add/replace posture
- only someone who can currently access the document may remove holders

Cons:
- more ceremony for a metadata-only cleanup action

#### Option B — Parent posture only, no crypto proof for removal

Pros:
- lighter cleanup UX
- no DEK operation required

Cons:
- weaker than the current proof-of-access mutation model
- allows holder subtraction without demonstrating live access

**Recommendation: Option A for the first pass.**

Keep the security rule simple:
- any PKI holder mutation requires proof from an active authorized holder

### Decision 5 — Reassign `documents.encryption_key_id` automatically when needed

If the old primary/preferred pointer is removed or replaced:
- server should choose a new pointer automatically from the resulting holder set

Do not make H4 depend on a separate pointer-only UI first.

Recommendation:
- choose the first resulting holder in canonical order
- prefer an active holder

---

## Exact server-side approach

### Chunk 1: Add helper(s) for mutation-specific envelope validation

Option A:
- keep validation logic inline in routes using `updatePkiDocumentAccess(..., { validate })`

Option B:
- extract narrow helpers in `lib/pki.js`

Recommendation:
- start with route-local validation callbacks, as in the current add-holder
  route, unless duplication becomes painful

Required route-level invariants:

#### Replace route invariants

- document exists and is PKI-encrypted
- resulting holder set includes all unchanged holders with exact integrity
- exactly one existing holder is removed
- exactly one new holder is added
- replacement holder is valid under current role rules
- resulting holder set has at least one active holder
- if replacing the compatibility pointer holder, `encryption_key_id` is updated

#### Remove route invariants

- document exists and is PKI-encrypted
- exactly one existing holder is removed
- no new holders are introduced
- unchanged holder integrity is preserved
- resulting holder set is non-empty
- resulting holder set contains at least one active holder
- if removing the compatibility pointer holder, `encryption_key_id` is updated

### Chunk 2: Add server route for replace

Recommended route:

- `POST /api/documents/:id/pki-holders/replace`

Recommended request body:

```json
{
  "primary_encryption_key_id": 42,
  "old_holder_key_id": 12,
  "new_holder_key_id": 77,
  "encryption_metadata": { "...updated envelope..." }
}
```

Meaning:
- `old_holder_key_id`: old holder to remove
- `new_holder_key_id`: new holder being added

The server should not blindly trust those IDs; it should confirm that the
delta between current envelope and submitted envelope matches them.

### Chunk 3: Add server route for remove

Recommended route:

- `POST /api/documents/:id/pki-holders/remove`

Recommended request body:

```json
{
  "primary_encryption_key_id": 42,
  "remove_encryption_key_id": 12,
  "encryption_metadata": { "...updated envelope..." }
}
```

Again, the server must confirm the actual envelope delta.

### Chunk 4: Add compatibility-pointer selection helper

Add a small helper either in route code or `lib/pki.js`:

```javascript
function choosePrimaryHolderKeyId(holders, previousPrimaryKeyId) { ... }
```

Recommended behavior:
- if previous primary still exists and is active, keep it
- otherwise choose first active holder in resulting holder order
- if no active holder exists, reject earlier and never call this helper

This keeps pointer reassignment deterministic.

Pointer invariant:
- if the previous primary/preferred holder remains active after repair, keep the
  pointer there
- only fall back to a new pointer when the old one is removed or no longer
  active

### Chunk 5: Audit logging

Add events:

- `document.pki_holder_replaced`
- `document.pki_holder_removed`

Suggested details:
- removed holder member id / key id / role
- replacement holder member id / key id / role (replace route only)
- holder_count_before
- holder_count_after
- old primary pointer
- new primary pointer

Important implementation note:
- these are new audit events; only `document.pki_holder_added` exists today

Durability note:
- current add-holder auditing happens after persistence, outside the DB
  transaction
- H4 replace/remove are more consequential mutations, so transaction-coupled
  audit writes are worth considering explicitly

Recommendation:
- if practical with the current audit utility shape, write repair audit entries
  inside the same transaction
- if not practical, keep the current post-commit audit pattern intentionally
  and call out that tradeoff in implementation review

---

## Exact client-side approach — document detail

### Chunk 6: Add “Replace revoked holder” UI

Show on PKI documents with at least one revoked holder and at least one active
eligible current holder:

- `Replace Revoked Holder`

Flow:
1. select an active current holder you control
2. select revoked holder to replace
3. select replacement key
4. prove access with active holder
5. locally unwrap DEK
6. locally wrap DEK for replacement key
7. submit updated envelope to `/replace`

Recommendation:
- scope the first UX to **same-member replacement first**
- optionally allow parent cross-member replacement later

### Chunk 7: Add “Remove revoked holder” UI

Show when:
- document has revoked holders
- at least one other active holder remains after removal

Flow:
1. choose revoked holder to remove
2. confirm
3. submit updated envelope to `/remove`

This route still requires current access, but the actual crypto operation may
be envelope-only if no new holder is added.

Per the recommendation above, first-pass H4 should still require active-holder
proof for this route even though the mutation itself may be envelope-only.

### Chunk 8: Extend client helper family

Recommended helpers in `public/document.html`:

```javascript
async function buildReplacementEnvelope({
  doc,
  keyInfo,
  currentHolder,
  replaceHolder,
  replacementKey,
  passphrase,
  statusEl
}) { ... }

function buildRemovalEnvelope({
  doc,
  keyInfo,
  removeHolderKeyId
}) { ... }
```

Implementation notes:
- replacement path reuses current DEK unwrap flow
- removal path should:
  - start from `buildNormalizedPkiEnvelope(...)`
  - remove one holder
  - preserve all unchanged holder metadata exactly
- client should not attempt to remove the last active holder; server remains
  final authority, but UI should preempt obvious invalid actions

### Chunk 9: Candidate filtering rules

For the first H4 pass:

#### Replace flow

- replacement candidates should exclude:
  - currently enrolled holder IDs
  - revoked keys

#### Remove flow

- only revoked holders should be removable in the first pass

That keeps H4 narrowly focused on cleanup/repair instead of opening broader
live-access surgery.

---

## Role / policy recommendations for first H4 pass

### Recommendation: same-member replacement first

Support first:
- replace revoked same-member key with new same-member key

Why:
- highest value
- lowest policy ambiguity
- fits the real-world stale-onboarding and re-enrollment cases already seen

### Optional extension: parent cross-member replacement

Only after same-member replacement is stable:
- replacing a beneficiary/trusted-holder path with another valid holder

That should be a separate explicit extension, not bundled into the first H4
implementation by default.

### Recommendation: remove only revoked holders in H4.1/H4.2

Do **not** initially support:
- removing active holders freely

Why:
- higher risk
- more policy-sensitive
- can accidentally turn a healthy document into an at-risk document

You can widen removal semantics later if product decides it is needed.

---

## Tests to add

### `test/documents-api.test.js` or new `test/pki-holder-mutations.test.js`

Replace route tests:

1. same-member revoked holder replaced successfully
2. ciphertext bytes unchanged after replacement
3. old holder removed, new holder present
4. replacement holder can unlock
5. unchanged holders preserve integrity
6. replacing the compatibility-pointer holder updates `encryption_key_id`
7. reject replacement if new key is revoked
8. reject replacement if submitted envelope alters unchanged holder metadata

Testing note for #2:
- the API primarily mutates envelope metadata, not ciphertext blobs directly
- practical proof should combine:
  - unchanged file record / stored ciphertext path where feasible
  - successful unlock with the new holder
  - no re-encryption path triggered

Remove route tests:

1. revoked holder removed successfully when active holder remains
2. reject removal if it would leave zero active holders
3. reject removal if it would leave empty holder set
4. removing the compatibility-pointer holder updates `encryption_key_id`
5. reject if route removes more than one holder

### `test/pki.test.js`

If helper extraction happens, add:
- primary-pointer selection helper coverage
- replacement/removal classification helper coverage

### Manual / UX checks

1. doc with active + revoked stale holder
   - replace revoked holder with new same-member key
   - confirm old revoked holder gone
   - confirm new holder visible and active

2. doc with active + revoked stale holder
   - remove revoked holder
   - confirm document still unlocks with active holder

3. doc where revoked holder was the compatibility pointer
   - confirm resulting primary badge/pointer moves sensibly

4. invalid action attempts
   - remove only active remaining holder
   - replace with revoked key
   - tamper with existing holder metadata

---

## Suggested file-level diff map

### Required

- `server.js`
  - add `/api/documents/:id/pki-holders/replace`
  - add `/api/documents/:id/pki-holders/remove`

- `public/document.html`
  - add replace/remove UI actions
  - add replacement/removal envelope builders
  - add candidate filtering for repair

- `lib/documents.js`
  - likely reuse `updatePkiDocumentAccess(...)` unchanged
  - add helper only if pointer selection logic is better centralized

- `lib/pki.js`
  - possibly add small pointer/helper utilities
  - validator reuse only if it stays readable

- tests
  - route coverage
  - integrity regression coverage

### Optional in same pass

- `docs/security-capabilities.md`
  - update after merge to note shipped holder replacement/removal support

---

## Risks and how to contain them

### Risk 1 — Replacement route becomes an unrestricted holder editor

Mitigation:
- server validates exact delta:
  - one old holder removed
  - one new holder added
  - unchanged holders byte-for-byte equivalent in metadata

### Risk 2 — Remove route accidentally strands docs

Mitigation:
- require at least one active holder in resulting envelope
- reject empty holder sets
- reject all-revoked resulting sets

### Risk 3 — Pointer reassignment is inconsistent between routes

Mitigation:
- one helper / one deterministic rule

### Risk 4 — Scope explodes into full policy editing

Mitigation:
- first pass limited to:
  - replace revoked holder
  - remove revoked holder
  - same-member replacement first

---

## Recommended execution order

1. implement pointer-selection helper / route invariants
2. implement replace route + tests
3. implement client replace flow
4. verify replace route end-to-end
5. implement remove route + tests
6. implement client remove flow
7. verify remove route end-to-end

---

## Acceptance criteria

H4 is complete when:

1. revoked/stale holders can be replaced without changing ciphertext
2. revoked/stale holders can be removed when another active holder remains
3. unchanged holder metadata cannot be silently altered during repair
4. resulting document always retains at least one active unlock path
5. compatibility pointer is reassigned sensibly when needed
6. repaired documents remain unlockable with their intended active holders
7. if the previous primary/preferred holder remains active after repair, the
   compatibility pointer is preserved there

---

## Recommendation

Start H4 with **same-member replacement of revoked holders**.

That is the highest-value next step because:
- H3 now makes stale holder states visible
- H1/H2 made revocation safe
- same-member stale/re-enrolled key repair is the clearest operational need

Once that is stable, add revoked-holder removal as the cleanup follow-on.
