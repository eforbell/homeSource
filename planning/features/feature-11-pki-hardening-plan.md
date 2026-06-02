# Feature #11 PKI Hardening Plan: Revocation Safety, Dependency Visibility, and Holder Lifecycle

Date: 2026-06-02
Status: Draft hardening plan
Parent: Feature #11 PKI Document Vault
Depends on: Feature #11 Phase 1 (shipped), Feature #11 Phase 2A multi-holder PKI (shipped), Feature #11 Phase 2A.1 / 2A.1B holder extension (shipped)
Scope: Close the highest-risk operational gaps before adding new PKI features

---

## Use case context

PKI serves two distinct use cases with different timelines and different
architectural needs. This hardening plan addresses Use Case 1.

### Use Case 1: Operator protecting their own documents (shipping now)

The patriarch encrypts birth certificates, insurance docs, bitcoin custody
notes — for their own protection, with their own keys, while alive and
competent. 1-of-M holders means backup keys or a spouse can unlock if the
primary key is unavailable. This is the filing cabinet with a lock.

The canonical crypto state lives in per-document JSONB envelopes
(`documents.encryption_metadata.files.*.holders[]`). This is correct for
Use Case 1: the envelope is self-describing, travels with the document in
backups, and does not require a relational cross-document authorization model
to remain the source of truth.

### Use Case 2: Estate planning and inheritance (future, design guide vision)

A potentially different set of documents, pre-wrapped to beneficiary and
trustee keys, sealed until a deadman switch trips. Different roles, different
ceremony, different UX voice. Described in `homesource-treatment.md`.

Estate-planning surfaces (permission matrix, beneficiary directory, sealed
envelopes) will likely require a relational holder model or projection for
cross-document queries ("which docs has Eric designated for Daniel?"). The
existing `key_holders` table was placed as a day-2 placeholder for this —
intentionally unused by Phase 1/2A, but reserved for possible Use Case 2
evolution.

### Relationship between use cases

- The document sets may or may not overlap
- The crypto primitives are shared (X25519, AES-KW, envelope wrapping)
- The canonical source may diverge: JSONB envelopes for Use Case 1 crypto
  operations, a relational model as a projection/index for Use Case 2 UX
- Hardening work (this plan) strengthens Use Case 1 foundations that
  Use Case 2 will inherit

---

## Executive summary

Home Source PKI is mature in its core cryptographic path:
- member key registration works
- PKI document encryption works
- 1-of-M holder unlock works
- same-member backup-key extension works
- parent-only trusted alternate holder extension works

The main weakness is no longer "can PKI encrypt and unlock?" It is now:

> **Can operators safely understand and manage the consequences of key revocation and holder drift?**

Current posture is good for encryption and unlock, but under-hardened for:
- revoking keys that still encumber encrypted documents
- discovering which encrypted docs depend on which keys
- warning when a revoke would strand a document
- distinguishing between "revoked key still referenced in metadata" and
  "document still has healthy alternate unlock paths"
- removing or replacing holders after a document is already encrypted

This plan prioritizes operational safety and user visibility before any new PKI
feature expansion.

---

## Confirmed current-state findings

These findings are based on current implementation review:

1. **Revocation is logical disablement only**
   - Revoking a member key sets `encryption_keys.revoked_at`
   - It does not rewrite existing document envelopes
   - It does not remove holder references from existing PKI docs

2. **Per-document holder visibility exists**
   - Document detail can show authorized holders and 1-of-M posture
   - `GET /api/documents/:id/key-info` resolves holder/key/member information

3. **Reverse dependency visibility does not exist**
   - There is no key-centric view of "which documents depend on this key"
   - Settings revoke flow has no impact analysis

4. **Unsafe revoke is currently possible**
   - A user can revoke a sole usable key for a PKI document
   - The app does not currently warn or block this

5. **Revocation is irreversible — re-enrollment does not restore access**
   - Each key registration generates a fresh X25519 keypair client-side
     (`pki-crypto.js:60-70`), regardless of the physical authenticator
   - Re-enrolling the same YubiKey or 1Password passkey produces a new
     public key, new fingerprint, and new `encryption_keys.id`
   - Old document envelopes still reference the old key ID in their
     `holders[]` array — no reconnection mechanism exists
   - This means revocation of a sole active holder is **permanent data
     loss**, not a recoverable inconvenience
   - The revoke confirmation copy in `settings.js:290` is dangerously
     misleading — it says "Any future PKI uploads tied to it will be
     blocked" but does not mention that existing encrypted documents
     become unrecoverable

6. **Revoked holders are filtered from unlock eligibility**
   - Client-side: `getEligiblePkiHolders()` in `document.html:553-564`
     filters out holders where `revoked_at` is set
   - Server-side: `getMemberKeyMaterial()` in `lib/pki.js:45-59` filters
     `WHERE revoked_at IS NULL`, so the server refuses to serve key material
     for revoked keys
   - Belt-and-suspenders: `deriveMemberKekForUnlock()` throws on revoked
     material at the client
   - Note: unlock/decrypt is entirely client-side crypto — there is no
     server "decrypt" endpoint to guard. Enforcement relies on the server
     refusing to serve key material.

7. **Phase 2A canonical state is still document-envelope metadata**
   - `documents.encryption_metadata.files.*.holders[]` is the live auth source
   - `documents.encryption_key_id` is only a compatibility pointer
   - existing `key_holders` schema is not the live source of truth
   - this is correct for Use Case 1 (see "Use case context" above)

8. **`listMemberKeys` excludes revoked keys entirely**
   - `pki.listMemberKeys()` at `lib/pki.js:13-27` filters
     `WHERE revoked_at IS NULL`
   - The settings page cannot currently display revoked keys at all
   - This blocks Phase H3 (revoked-holder surfacing) — the API must
     support an `includeRevoked` parameter before revoked keys can be
     shown in any UI

9. **Recovery key material is inaccessible after revocation through the app**
   - `getMemberKeyMaterial()` filters `revoked_at IS NULL`
   - `saveRecoveryWrap()` also requires non-revoked status
   - If a key is revoked, the recovery-wrapped private key becomes
     unreachable through the API — mnemonic-based recovery cannot restore it
     through the normal application runtime
   - Combined with finding #5 (re-enrollment doesn't reconnect), this
     means revocation severs both the primary and recovery decryption
     paths inside the app
   - Note: this is distinct from offline break-glass recovery using exported
     backup material and recovery words; that path may still exist if the
     operator retained the necessary artifacts

10. **`key_holders` table is unused but architecturally reserved**
    - Zero application reads in shipped code
    - Role enum (`owner, cosigner, recovery`) does not match shipped PKI
      roles (`owner, backup, beneficiary`)
    - Exported in backups (`lib/backup.js:85`) despite being empty, which
      creates false confidence on restore
    - However, the table is a forward placeholder for possible Use Case 2
      (estate-planning relational model) — see "Use case context" and
      "Data model stance" sections. Do not drop casually.

---

## Product goal

Before adding more PKI capabilities, harden the product so that:

1. operators can see key-to-document dependency clearly
2. revoke actions are impact-aware and safe by default
3. users are warned before creating stranded encrypted documents
4. document holder posture is legible at both the key and document level
5. the app has a clean supported path for holder removal/replacement after
   multi-holder adoption

---

## Hardening principles

### 1. Never surprise users with destructive PKI state transitions

Revoking a key may be operationally equivalent to removing an unlock path.
That must be explicit before the mutation is allowed to complete.

### 2. Keep the envelope as the Phase 2A/2A.1 canonical source

Do not block hardening on a relational redesign. Ship safety on top of the
current canonical source first.

### 3. Prefer impact analysis before mutation

The system should know whether a revoke is:
- harmless
- risky but survivable
- document-stranding

before asking the user to confirm.

### 4. Add visibility before automation

The first hardening step is not automatic repair. It is accurate surfacing of:
- active holders
- revoked holders
- sole-holder risk
- affected document counts

### 5. Separate "revoke key" from "repair document access"

Revocation and holder repair are related but not identical actions.
The UX should support safe sequencing:

1. inspect impact
2. add/replace healthy alternate holder if needed
3. revoke
4. optionally clean up stale holder metadata later

---

## Non-goals

- threshold / quorum PKI
- Shamir share reconstruction
- automatic mass DEK re-wrap across all affected docs in a first pass
- replacing the current envelope model with a new relational auth system
- offloading PKI state to background jobs before safety UX exists

---

## Recommended release order

1. **Phase H1: Dependency visibility + revoke preflight**
2. **Phase H2: Safe revoke UX + server-side revoke guardrails**
3. **Phase H3: Revoked-holder surfacing on documents**
4. **Phase H4: Supported holder removal / replacement flows**
5. **Phase H5: Optional indexing / caching layer for PKI dependency queries**

If schedule is tight, H1 + H2 are the mandatory gate before new PKI features.

---

## Phase H1: Dependency visibility + revoke preflight

### Goal

Make it possible to answer, quickly and correctly:

- which docs reference this key?
- among those docs, which still have at least one other active holder?
- which docs would become stranded if this key were revoked now?

### Product outcomes

1. Settings page can show key usage posture:
   - not used by PKI docs
   - used by N PKI docs
   - sole active holder for X docs
   - one of multiple active holders for Y docs

2. Revoke flow can fetch a preflight impact summary before confirmation

3. Parent/operator can inspect a key before deciding whether to repair docs

### Implementation approach

#### H1a. Add reverse-dependency analysis helper

Add a helper in `lib/pki.js` or adjacent module:

- `getKeyDependencySummary(keyId, memberId, actorId?)`

Responsibilities:
- locate PKI documents whose envelope holder arrays reference `keyId`
- inspect each doc's holder set
- resolve which holders are currently active vs revoked
- classify document impact:
  - `unused`
  - `alternate_holders_available`
  - `sole_active_holder`
  - `all_holders_revoked`
  - `holder_metadata_inconsistent`

Recommended return shape:

```json
{
  "key_id": 42,
  "document_count": 7,
  "summary": {
    "safe_docs": 4,
    "at_risk_docs": 2,
    "already_stranded_docs": 1
  },
  "documents": [
    {
      "document_id": 88,
      "title": "Birth Certificate",
      "holder_count": 2,
      "active_holder_count": 1,
      "key_role": "owner",
      "status": "sole_active_holder"
    }
  ]
}
```

#### H1b. Add API route for key dependency inspection

Recommended route:

- `GET /api/members/:id/keys/:keyId/dependencies`

Auth posture:
- key owner can inspect their own key dependencies
- parents may inspect household key dependencies if product wants household
  safety oversight
- kids should not inspect other members' key posture

#### H1c. Build document-envelope scanning on current source of truth

Because live authorization is stored in document metadata, first-pass
dependency analysis can scan PKI docs and inspect `holders[]`.

This is acceptable for current scale and safer than blocking on schema churn.

#### H1d. Add document-level health classification helper

For each PKI document, compute:
- total holders
- active holders
- revoked holders
- whether the target key is primary/preferred
- whether revoking the target key would strand the doc

### Tests for H1

- key with no referencing docs returns empty summary
- key referenced by one doc with alternate active holder returns safe summary
- key referenced by one doc as sole active holder returns at-risk summary
- doc with mixed active + revoked holders is classified correctly
- dependency route respects auth boundaries

---

## Phase H2: Safe revoke UX + server-side revoke guardrails

### Goal

Make key revocation safe by default, not just technically possible.

### Product outcomes

1. Revoke modal becomes impact-aware
2. User is warned if revoke affects existing PKI docs
3. User is strongly warned or blocked if revoke would strand documents
4. Server does not rely on UI honesty alone

### Recommended product decision

For first hardening pass:

- **allow revoke** when all affected docs still have another active holder
- **block revoke by default** when the key is the sole active holder for one or
  more docs
- provide explicit copy directing the user to add/replace another holder first

Do not implement a dangerous override in the first pass unless there is a
strong operator-only requirement.

### Implementation approach

#### H2a. Add revoke preflight route or fold into dependency route

Either:
- use `GET /dependencies` directly before showing confirm

or add:
- `POST /api/members/:id/keys/:keyId/revoke-preflight`

Return:
- affected doc count
- sole-active-holder doc count
- already-stranded doc count
- doc titles / ids for operator clarity

#### H2b. Harden settings revoke modal

Current copy is too weak because it only mentions future uploads.

Replace it with conditional copy:

**No dependency**
- "Revoke this key? It is not currently referenced by any PKI-encrypted documents."

**Has safe dependencies**
- "Revoke this key? It is referenced by 4 PKI-encrypted documents, but each still has another active unlock key."

**Has unsafe dependencies**
- "You cannot revoke this key yet. It is the sole active unlock key for 2 PKI-encrypted documents. Add or replace another holder before revoking."

#### H2c. Add server-side guard

Before completing revoke in `DELETE /api/members/:id/keys/:keyId`:
- compute dependency summary
- reject with `409` if any affected doc would become stranded

Recommended error payload:

```json
{
  "error": "Key cannot be revoked because it is the sole active holder for encrypted documents",
  "code": "PKI_KEY_SOLE_ACTIVE_HOLDER",
  "affected_documents": [
    { "document_id": 88, "title": "Birth Certificate" }
  ]
}
```

#### H2d. Audit revoke denials

Add an audit event for blocked revocation attempts:
- `key.revoke_blocked`

Include:
- key id
- actor id
- affected doc count
- sole-active-holder doc count

### Tests for H2

- revoke succeeds for unused key
- revoke succeeds for key where alternate active holders exist on all affected docs
- revoke fails with 409 when key is sole active holder for one doc
- revoke failure payload contains affected document metadata
- settings UI renders strong warning / block messaging from preflight

---

## Phase H3: Revoked-holder surfacing on documents

### Goal

Make document-level PKI posture legible after revocation events.

### Product outcomes

1. Document detail distinguishes:
   - active holders
   - revoked holders
   - current unlock-eligible holders

2. User understands why a key no longer appears in unlock options

3. Parent/operator can identify stale holder metadata that still needs repair

### Implementation approach

#### H3a. Extend document holder display

In `public/document.html`, enrich the authorized holder list with badges:
- Active
- Revoked
- Owner / Backup / Beneficiary
- Preferred / Primary pointer (optional)

#### H3b. Add document PKI health summary

Example:
- `2 active holders · 1 revoked holder`
- `Healthy redundancy`
- `At risk: only one active unlock path remains`
- `Stranded: no active holders remain`

#### H3c. Keep unlock selection filtered to active eligible holders

Do not regress current safety behavior. Revoked holders should remain visible
for explanation but not selectable for unlock.

### Tests for H3

- revoked holder appears in document detail as revoked
- revoked holder is not offered in unlock selector
- document health copy reflects active-holder count accurately

---

## Phase H4: Supported holder removal / replacement flows

### Goal

Move from "add only" lifecycle support to actual PKI maintenance support.

### Why this matters

Once revoke safety exists, operators still need a supported document repair path:
- remove stale revoked holder metadata
- replace an old key with a new key
- preserve ciphertext while updating unlock paths

### Recommended release sequence

1. **Replace Holder**
   - safest mental model
   - prove existing holder
   - unwrap DEK
   - wrap to new key
   - persist updated envelope
   - optionally remove old holder in same transaction

2. **Remove Holder**
   - only when at least one other active holder remains

3. **Primary/Preferred Pointer Reassignment**
   - tidy compatibility field/UI, not security-critical

### Implementation approach

#### H4a. Add dedicated holder mutation route(s)

Current route supports add-only and explicitly forbids removal.

Recommended additions:
- `POST /api/documents/:id/pki-holders/replace`
- `POST /api/documents/:id/pki-holders/remove`

Both should:
- require local proof from an active authorized holder
- preserve unchanged ciphertext
- validate resulting holder set
- refuse to save an envelope with zero active holders

#### H4b. Holder removal invariants

- never allow empty holder set
- never allow save if all resulting holders are revoked
- preserve role/fingerprint consistency for unchanged holders
- reassign `documents.encryption_key_id` if the current pointer is removed

#### H4c. Document repair UX

On PKI docs with revoked holders, show:
- `Replace revoked holder`
- `Remove revoked holder`

Only when the current actor can prove access with a healthy authorized key.

### Tests for H4

- replace-holder preserves ciphertext and allows unlock with new key
- remove-holder succeeds when another active holder remains
- remove-holder fails if it would leave zero active holders
- compatibility pointer is updated if removed/replaced holder was primary

---

## Phase H5: Optional dependency indexing / caching

### Goal

Improve scalability and observability if document count grows enough that
document-envelope scanning becomes expensive.

### Options

#### Option A: Stay with envelope scanning for now

Best if household vault sizes stay modest.

#### Option B: Add derived/indexed holder mapping

Create a derived table specifically for dependency queries, for example:
- `document_pki_holders`

This should be treated as:
- a projection / index
- rebuildable from document metadata
- never the canonical live auth source in the same release

### Recommendation

Do **not** start here. Only do this after H1-H4 if performance or reporting
needs justify it.

---

## UX recommendations

### Settings / Keys screen

Each key card should eventually show:
- label
- protection tier
- verified / recovery posture
- last used
- **used by N encrypted docs**
- **sole active holder for X docs** when applicable

### Document screen

Each PKI doc should show:
- access model: 1-of-M
- authorized holders
- revoked holders
- active-holder count
- health posture

### Revoke modal

The revoke modal should stop speaking only about future uploads and instead
speak about current encrypted-doc impact.

---

## Data model stance

### Canonical source for hardening work (Use Case 1)

Continue to treat:

- `documents.encryption_metadata.files.*.holders[]`

as the authoritative source for live PKI authorization in this hardening cycle.

This is the correct canonical source for Use Case 1 (operator protecting
their own documents). The envelope is self-describing, travels with the
document in backups, and supports all shipped crypto operations.

### Compatibility field

Continue to keep:

- `documents.encryption_key_id`

as a compatibility/preferred-pointer field only.

### `key_holders` table posture

Do not rely on the existing `key_holders` table for this hardening pass.
Its current shape does not match shipped Phase 2A semantics.

**Do not drop or deprecate the table.** It is a forward placeholder for
Use Case 2 (estate-planning relational model). The design guide treatment
(`homesource-treatment.md`) describes surfaces that require relational
holder tracking:
- Permission matrix: documents × recipients grid, cells create key-holder rows
- Beneficiary directory: designated-document counts computed from key-holder rows
- Sealed envelopes: holder entries with `sealed: true`, `sealed_until` state
- Polymorphic holders: `holder_type` + `holder_id` referencing both
  `family_members` and `vault_trustees`

The table will need evolution (different roles, polymorphic holder references,
sealed state, per-document DEK wrapping) but the concept of a relational
holder table is architecturally load-bearing for that future.

**Concrete cleanup for this hardening pass:**
- Remove `key_holders` from backup export (`lib/backup.js:85`) — exporting
  an empty table creates false confidence on restore
- Add a schema comment marking it as reserved for estate-planning phases

### Future canonical source migration (Use Case 2)

When estate-planning surfaces begin, the relational model becomes a
**projection alongside** the JSONB envelope — not a replacement. The
envelope stays canonical for crypto operations (it's what the client
decrypts). The relational model enables cross-document queries and UX.
They sync, not compete.

H4 (holder replacement) and H5 (dependency indexing) are natural inflection
points for evaluating whether to begin this dual-source model.

---

## Acceptance criteria for the hardening gate

Before new PKI features proceed, the following should be true:

1. A key owner can inspect which PKI docs reference a key
2. The app can identify docs for which a key is the sole active holder
3. Revoke flow warns about affected PKI docs
4. Revoke is blocked server-side when it would strand encrypted docs
5. Revoke confirmation copy accurately describes consequences (not just
   "future uploads" — must mention existing encrypted documents and the
   irreversibility of re-enrollment)
6. Document detail surfaces revoked holders distinctly from active holders
7. Operators have a clear next step when a revoke is blocked
8. `listMemberKeys` API supports returning revoked keys (prerequisite for
   criteria 6)

Recommended stronger gate:

9. Replace-holder flow exists before encouraging aggressive key rotation
10. Recovery key material remains accessible for revoked keys in a
    controlled recovery context (prevents permanent stranding)

---

## Suggested backlog slicing

### Immediate (can ship before full hardening)

0. Fix revoke confirmation copy in `settings.js:290`

### Mandatory before new PKI feature work

1. H1 dependency summary helper + API
2. H1 prerequisite: `listMemberKeys` must support `includeRevoked` parameter
3. H2 revoke preflight UI
4. H2 server-side revoke block for sole-active-holder cases
5. H3 revoked-holder document surfacing

### Next after mandatory gate

6. H4 replace-holder flow
7. H4 remove-holder flow
8. H4 primary-pointer reassignment UX
9. Product decision on revoked-key recovery path (open decision #5)

### Optional later

10. H5 derived dependency index/projection
11. Document list PKI health indicators
12. Reporting/dashboard posture views
13. Batch repair tooling
14. Remove `key_holders` from backup export (`lib/backup.js:85`)
15. Add schema comment on `key_holders` marking it as reserved for
    estate-planning phases

---

## Recommended first implementation slice

If we want the smallest high-value hardening release:

### Slice H1/H2A

Ship:
- `GET /api/members/:id/keys/:keyId/dependencies`
- settings revoke preflight
- 409 block on sole-active-holder revoke
- fix revoke confirmation copy to state that existing encrypted documents
  may become permanently unrecoverable (not just "future uploads blocked")

This single slice closes the most dangerous current gap:

> accidental revocation of the only usable unlock key for an encrypted document

Even before the full dependency analysis ships, fixing the confirmation copy
in `settings.js:290` is a zero-effort safety improvement that should ship
immediately.

---

## Open product decisions

1. Should parents be allowed to inspect dependency summaries for other members'
   keys, or only the key owner?
2. Should unsafe revoke be fully blocked, or allowed only behind a stronger
   operator-only override?
3. Should document titles be shown directly in revoke warnings, or just counts
   until the user expands details?
4. Do we want a dedicated "PKI Health" panel in document detail, or should
   holder health stay inline with the authorized-holder list?
5. **Should revoked key material be retrievable for recovery/repair purposes?**
   Currently `getMemberKeyMaterial()` filters `revoked_at IS NULL`, making
   recovery-wrapped private keys permanently unreachable through the API after
   revocation. Combined with the fact that re-enrollment generates a new keypair
   (finding #5), this means revocation severs both primary and recovery
   decryption paths. Options:
   - Allow recovery-mode access to revoked key material (controlled endpoint,
     audit-logged, requires mnemonic proof)
   - Accept permanent loss and rely entirely on the revoke guard to prevent it
   - Provide a pre-revoke "export recovery bundle" step
6. **What is the stranded-document recovery path when all holders are revoked?**
   If the revoke guard (H2) had not yet shipped and a sole-holder key was
   revoked, is the document permanently lost? Manual DB intervention?
   Recovery code ceremony that bypasses the `revoked_at` filter?
7. **Should the document list API surface PKI health posture for triage?**
   Currently only document detail shows holder information. For an operator
   managing dozens of PKI docs, a list-level "3 docs at risk" indicator or
   filter would improve triage — but adds query cost.

---

## Recommendation

Treat this hardening plan as a gate, not a nice-to-have.

The next meaningful PKI maturity step is not "more crypto features." It is:

> **safe lifecycle management of the crypto features already shipped**

That means the next development focus should be:
- dependency visibility
- safe revocation
- revoked-holder clarity
- holder repair

before pushing deeper into new PKI capability branches.
