# Feature #11 Phase 2A: Multi-Holder PKI (1-of-M, Same-Member-First)

Date: 2026-05-29
Status: Revised for implementation review
Parent: Feature #11 PKI Document Vault
Depends on: Feature #11 Phase 1 (shipped), Feature Request #101 encrypt-existing-document (shipped / bugbase #101 verified 2026-05-29)
Scope: Multi-holder PKI wrapping without Shamir or quorum reconstruction

## Executive summary

Feature #11 Phase 1 proved the single-holder PKI path:
- member key registration
- PKI encryption on upload
- browser unlock by the enrolled holder
- offline recovery tooling

Phase 2A extends that foundation from **single-holder PKI** to
**multi-holder PKI with alternate unlock paths**.

The key policy of this phase is explicit and stable:

> **Any one selected holder key can unlock the document.**

This is **not quorum** and should never be described as quorum, multi-sig, or
threshold enforcement in the UI. It is a **1-of-M access model** intended first
for primary-key + backup-key redundancy, and secondarily for trusted alternate
household holders.

This revision hardens the plan into an implementation-oriented spec by locking:
- canonical data source rules
- legacy envelope compatibility behavior
- exact authorization rules
- exact unlock selection behavior
- exact Phase 2A posture for `key_holders`

---

## Product goal

A parent encrypting a document with PKI can authorize more than one registered
key to unlock it, starting with the same member's primary + backup keys as the
main use case.

Examples:
- Eric YubiKey + Eric backup passkey
- Eric primary hardware key + Eric emergency backup hardware key
- Eric + spouse
- Eric + beneficiary (trusted alternate access)

---

## Locked product decisions

### 1. Access model is explicit 1-of-M

If a document is encrypted to multiple holders in Phase 2A, **any one** selected
holder key can unlock it.

This should be surfaced in product copy, not hidden behind implementation detail.

Recommended UI language:
- **Access model: 1-of-M**
- "Any one selected key can unlock this document."

### 2. Do not offer a fake policy chooser yet

Phase 2A should **not** ask the user to choose between:
- any-one-can-unlock
- multiple-holders-must-cooperate

because only the first exists in this phase.

Instead:
- make 1-of-M explicit
- show quorum/cooperative unlock as a future capability

### 3. Same-member multi-key is the first-class UX

The first encryption UX should be optimized for:
- select your primary key
- add your backup key(s)

Cross-member holders are supported in the model, but same-member redundancy is
what unblocks immediate real-world operator confidence.

### 4. Keep holder sets intentionally small

Every additional holder becomes an alternate unlock path. The UX should nudge
small, deliberate holder sets.

Recommended product stance:
- optimize for 2–3 holders
- warn if the user adds many holders
- explain that each holder can unlock independently

### 5. Phase 2A is not threshold security

Do not describe this phase as:
- multi-sig
- quorum
- 2-of-3
- require both keys

Those belong to Phase 2B/3 when Shamir threshold wrapping and coordinated
reconstruction are implemented.

### 6. Phase 2A canonical source of truth

For Phase 2A, the canonical live authorization source is:

- **`documents.encryption_metadata.files.*.holders[]`**

Not:
- `documents.encryption_key_id` alone
- `key_holders`

This keeps the feature shippable without schema churn while the holder model is
still evolving toward later threshold work.

### 7. `documents.encryption_key_id` remains a compatibility pointer

For Phase 2A:
- keep `documents.encryption_key_id`
- continue populating it on PKI documents
- set it to the **primary/preferred holder key id**
- treat it as a convenience / compatibility field only
- do **not** treat it as the sole authorization source

Implementation rule:
- for same-member multi-key documents, use the first selected key as the primary
  pointer
- for cross-member documents, the acting member must still select a primary key
  owned by themselves as the first selected key
- holder array order is stable and significant in Phase 2A: **first holder =
  primary/preferred holder**

This preserves compatibility for existing API responses, exports, backup flows,
and UI surfaces that still expect one key id.

### 8. `key_holders` is explicitly deferred for live authorization

The existing `key_holders` table is **not sufficient** for Phase 2A live use
because it currently lacks:
- `document_id`
- Phase 2A role vocabulary (`backup`, `beneficiary`)
- a uniqueness model aligned to per-document holder sets

Therefore Phase 2A will:
- **not** use `key_holders` as canonical auth state
- **not** block implementation on a `key_holders` migration
- optionally add a follow-up ticket for Phase 2A.1 / Phase 2B schema work

This means holder persistence/visibility for Phase 2A comes from document
metadata, not a new relational mapping table.

---

## User stories

1. As a vault owner, I can encrypt a document to my primary and backup key so
   either key can unlock it.
2. As a vault owner, I can select a second registered key of my own **during encryption or encrypt-existing conversion** without
   changing the document's organizational metadata.
3. As a vault owner, I can add a second household holder for alternate access
   when I deliberately want that.
4. As an authorized holder, I can unlock the document with any enrolled key I
   control.
5. As a user, I am clearly told that selected holders are **alternate unlock
   paths**, not a cooperative quorum.
6. As an encrypting user, I can choose multiple holders **at encrypt time**
   without changing the document's organizational metadata.

---

## Non-goals

- Shamir Secret Sharing
- M-of-N quorum policies
- async ceremonies or staged share submission
- deadman's switch execution
- beneficiary notification workflows
- key rotation/re-wrapping automation across existing documents
- relational holder persistence redesign in `key_holders`

---

## Scope boundaries

### In scope

- multi-holder PKI selection at encrypt time (new upload)
- same-member multiple keys
- cross-member alternate holders
- document unlock by any matching enrolled holder key
- server validation of all holder bindings
- multi-holder selection at initial encrypt time and encrypt-existing time
- holder visibility in document details from envelope metadata
- single-holder legacy compatibility
- compatibility handling for encrypt-existing flow introduced by Feature #101

### Out of scope

- requiring 2 or more holders to cooperate
- splitting DEKs into shares
- asynchronous collection or escrow of holder contributions
- automatic migration of all existing Phase 1 documents
- post-encryption add/remove-holder lifecycle flows for already-encrypted PKI documents
- redesigning `key_holders` for Phase 2A shipment

---

## Current implementation constraints

Phase 1 currently assumes single-holder PKI in several places:

- `lib/pki.js::validatePkiUpload()` requires exactly one holder per file
- `public/pki-crypto.js::buildPkiEnvelope()` emits exactly one holder
- `public/document.html` unlock logic assumes `holders[0]`
- `documents.encryption_key_id` acts like a single active key pointer
- `/api/documents/:id/key-info` currently returns one `key` object, not a holder-aware view

Phase 2A must deliberately remove those assumptions without breaking Phase 1
single-holder documents.

---

## Envelope direction

## Recommendation: holder-local wrapped DEKs

Instead of one top-level `wrapped_dek` shared across all holders, each holder
entry should carry its own wrapped DEK payload. Each holder has a different
public key target, so this structure is easier to validate and easier to unlock.

### Phase 2A envelope shape (new writes)

```json
{
  "version": 1,
  "mode": "pki",
  "policy": {
    "plaintext_metadata": "minimal",
    "server_plaintext_processing": false,
    "access_model": "any_one_holder",
    "threshold": 1
  },
  "files": {
    "upload": {
      "cipher": "aes-256-gcm",
      "iv_b64": "...",
      "tag_length_bits": 128,
      "holders": [
        {
          "member_id": 1,
          "encryption_key_id": 42,
          "key_fingerprint": "...",
          "role": "owner",
          "wrapped_dek": {
            "kind": "pki_x25519",
            "ephemeral_public_key_b64": "...",
            "hkdf_salt_b64": "...",
            "wrapped_dek_b64": "..."
          }
        },
        {
          "member_id": 1,
          "encryption_key_id": 57,
          "key_fingerprint": "...",
          "role": "backup",
          "wrapped_dek": {
            "kind": "pki_x25519",
            "ephemeral_public_key_b64": "...",
            "hkdf_salt_b64": "...",
            "wrapped_dek_b64": "..."
          }
        }
      ]
    }
  }
}
```

### Legacy compatibility rules

Phase 1 documents already stored in the current format remain valid.

#### Legacy Phase 1 read shape (must continue to unlock)

```json
{
  "version": 1,
  "mode": "pki",
  "files": {
    "upload": {
      "cipher": "aes-256-gcm",
      "iv_b64": "...",
      "tag_length_bits": 128,
      "wrapped_dek": {
        "kind": "pki_x25519",
        "ephemeral_public_key_b64": "...",
        "hkdf_salt_b64": "...",
        "wrapped_dek_b64": "..."
      },
      "holders": [
        {
          "member_id": 1,
          "encryption_key_id": 42,
          "key_fingerprint": "...",
          "role": "owner"
        }
      ]
    }
  }
}
```

#### Compatibility contract

- **New Phase 2A writes** use holder-local `holder.wrapped_dek`
- **Legacy reads** must continue accepting top-level `entry.wrapped_dek`
- If `holder.wrapped_dek` is present, treat the entry as **new Phase 2A format**
- If `holder.wrapped_dek` is absent and `entry.wrapped_dek` is present, treat
  the entry as **legacy Phase 1 format**
- If a file entry has more than one holder, **each holder must carry its own**
  `wrapped_dek`
- If a file entry has exactly one holder, server/client may accept either shape
  for backward compatibility
- Missing `policy.access_model` on a legacy envelope is implicitly treated as
  `any_one_holder`
- Client unlock code should normalize both formats into a holder-local internal
  shape before attempting match/unlock

### Why this direction

- unlock logic can find the matching holder and unwrap directly
- validation can reason about each holder independently
- future Phase 2B can introduce share-specific payloads without overloading a
  single top-level wrap stanza
- same-member and cross-member cases use the same structure

---

## Data model direction

## `documents.encryption_key_id`

In Phase 1 this field identifies the single active PKI key. In Phase 2A it can
no longer be the canonical authorization source.

Locked rule:
- keep the column for backward compatibility
- populate it with the primary/preferred holder key id
- continue returning it in APIs
- never use it to infer the complete holder set

## `key_holders`

The repo already has a dormant `key_holders` table intended for day-2 work.
That table is **not implementation-ready** for Phase 2A live use.

Locked rule for this phase:
- canonical live unlock data remains in `documents.encryption_metadata`
- document details derive holder display from envelope metadata
- any relational persistence redesign is deferred

Follow-up note:
- open a later planning item to redesign `key_holders` with `document_id` or a
  document-key join model before Phase 2B/3

---

## Authorization rules

### Encryption / re-encryption authorization

#### Same-member multi-key

An acting member may add multiple keys owned by themselves when encrypting a
PKI document.

Allowed:
- parent adds 2+ of their own keys
- kid adds 2+ of their own keys **only if** the base route already permits that
  action for the document flow in question

#### Cross-member holders

For Phase 2A, adding another member as an alternate holder is **parent-only**.

Locked server rule:
- only a **parent** may submit a PKI envelope that includes holders owned by a
  different member than the acting member

Why:
- matches existing sensitive-mutation posture
- avoids unclear household delegation semantics
- keeps review simple for a security-sensitive first slice

### Document creation vs encrypt-existing

- upload/create path follows existing route auth rules plus Phase 2A holder validation
- encrypt-existing path inherits Feature #101 posture: **parent-only** mutation

---

## UX direction

## Entry point

On upload and on any future encrypt-existing flow, PKI mode should allow adding
multiple holder keys.

## Primary copy

Section title:
- **Who can unlock this document?**

Helper copy:
- "Any one selected key can unlock this document. Use this for primary + backup
  keys or trusted alternate holders."

Badge/callout:
- **Access model: 1-of-M**

## Holder selection flow

### Same-member-first

When the current member has more than one registered key:
- present their keys first
- clearly label primary/preferred key
- preselect one primary key
- offer an intentional "Add backup key" action

### Cross-member support

Allow adding a second member's key, but make it a separate step so it feels more
intentional than adding another one of your own keys.

For this phase, cross-member add affordances should be visible only to parents.

## Guardrails

- warn when holder count exceeds a small number (for example >3)
- explain that each added holder is an alternate unlock path
- show holder names + key labels + protection tier so the operator understands
  exactly what is being authorized

---

## Unlock behavior

### Locked unlock algorithm

When a holder attempts to unlock:

1. load the document's PKI holder list
2. build a set of candidate holders matching keys the current member can access
3. if there are no matches, fail with an authorization message
4. if there is one match, use it automatically
5. if there are multiple matches for the same member, try the primary/preferred
   match first
6. if the chosen path fails due to unavailable local unlock material, allow the
   user to try another eligible holder key they control
7. unwrap that holder's member private key locally
8. unwrap that holder's wrapped DEK locally
9. decrypt the document

### UI behavior for unlock

Phase 2A should support either of these UI patterns, in this order of preference:

1. **Auto-select eligible holder path** and show which key is being attempted
2. If multiple eligible keys exist and the first attempt fails, offer a small
   chooser of the user's other eligible keys

Do **not** require the user to manually inspect raw holder arrays.

### Key info API direction

The document key-info surface should evolve from "single key" to a holder-aware
response.

Recommended response shape:

```json
{
  "document_id": 123,
  "encryption_mode": "pki",
  "encryption_key_id": 42,
  "encryption_metadata": { "...": "..." },
  "primary_key": { "id": 42, "label": "Eric YubiKey", "member_id": 1 },
  "holders": [
    {
      "member_id": 1,
      "encryption_key_id": 42,
      "role": "owner",
      "key_fingerprint": "...",
      "label": "Eric YubiKey",
      "protection_tier": "hardware",
      "revoked_at": null,
      "is_current_member_eligible": true
    },
    {
      "member_id": 1,
      "encryption_key_id": 57,
      "role": "backup",
      "key_fingerprint": "...",
      "label": "Eric backup passkey",
      "protection_tier": "platform",
      "revoked_at": null,
      "is_current_member_eligible": true
    }
  ]
}
```

Important:
- preserve `encryption_key_id` for compatibility
- do not rely on a single top-level `key` object as the only source

---

## Validation rules

Server must verify for every holder:
- `encryption_key_id` exists
- key is a `member` key
- key is not revoked
- key fingerprint matches server-stored fingerprint
- declared `member_id` matches the key's owner
- role is allowed for Phase 2A

### Locked Phase 2A role vocabulary

Allowed roles for this phase:
- `owner`
- `backup`
- `beneficiary`

Role semantics in Phase 2A do **not** change the 1-of-M security model, but the
server should enforce basic role-context alignment to keep holder data clean:
- `owner` = primary/preferred acting member holder
- `backup` = same-member alternate holder only
- `beneficiary` = cross-member alternate holder only

This is a data-shape constraint, not threshold enforcement.

### Additional policy checks

- at least one holder is present
- all holder key ids are unique
- duplicate holder entries are rejected
- first selected holder key becomes `documents.encryption_key_id`
- same-member multiple keys are allowed
- cross-member holders require acting member role `parent`
- `backup` must be same-member; `beneficiary` must be cross-member
- multi-holder documents must use holder-local `wrapped_dek` for each holder
- single-holder legacy envelopes remain accepted

### Exact validation contract for uploads/imports/re-encrypt

`lib/pki.js::validatePkiUpload()` should evolve to:
- return the primary/preferred key id (first holder key id)
- validate all holders, not just one
- reject envelopes with mixed legacy/new shapes when holder count > 1 and a
  holder-local wrapped DEK is missing

---

## Delivery chunks

### Chunk 1: Envelope + validation foundation

- extend `public/pki-crypto.js` to build multi-holder envelopes
- add a new builder shape that accepts `holders[]`
- keep backward compatibility for current single-holder callers
- extend `lib/encryption-mode.js` PKI validation for holder-local wrapped DEKs
- replace exact-one-holder validation in `lib/pki.js`
- keep legacy Phase 1 envelopes readable

### Chunk 2: Key-info + unlock path generalization

- update `lib/pki.js::getDocumentKeyInfo()` to return holder-aware data
- update `public/document.html` to search holder candidates instead of indexing
  `holders[0]`
- auto-select an eligible holder path for the current member
- ensure unlock succeeds with either of two keys owned by the same member
- ensure unlock still works for legacy single-holder docs

### Chunk 3: Upload/encrypt UI

- allow multiple PKI holder selection in upload flow
- reuse the same holder-selection model in encrypt-existing flow
- same-member-first UX for primary + backup keys
- explicit 1-of-M access model copy
- optional warning for large holder sets
- restrict cross-member add flow to parents

### Chunk 4: Tests + compatibility hardening

- add regression coverage for legacy Phase 1 envelopes
- add regression coverage for Feature #101 encrypt-existing path using Phase 2A
  multi-holder metadata if that path is included in the same implementation pass
- confirm backup/export surfaces still tolerate `documents.encryption_key_id`
  as a compatibility pointer

### Deferred chunk (not required for Phase 2A shipment)

- redesign `key_holders` for per-document holder persistence
- add document-key relational mapping for revocation/re-wrap lifecycle work

---

## Tests

### Automated

Add or expand tests for:

1. envelope validation accepts multiple holders with distinct key ids
2. duplicate holder ids are rejected
3. revoked holder key is rejected
4. same-member two-key PKI encrypt succeeds
5. same-member doc unlock succeeds with either enrolled key
6. cross-member holder can unlock when enrolled
7. unauthorized member cannot unlock without a matching enrolled key
8. parent may assign cross-member holder, non-parent may not
9. existing single-holder Phase 1 docs still unlock
10. key-info API exposes holder-aware response while preserving compatibility fields
11. encrypt-existing PKI path still works with a primary/preferred holder pointer
12. encrypt-existing plaintext document can be converted to 2-holder PKI and
    unlocked independently by each holder

Likely files:
- `test/pki-crypto.test.js`
- `test/encryption-mode.test.js`
- `test/pki.test.js`
- `test/documents-api.test.js`
- `test/backup-api.test.js`

### Manual

- encrypt with primary + backup key for same member
- unlock with primary key
- unlock with backup key
- encrypt with owner + second household member
- unlock as second household member
- verify copy makes clear this is alternate access, not quorum
- verify a legacy Phase 1 single-holder document still unlocks unchanged

---

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Users confuse multi-holder with quorum | Wrong security expectation for critical docs | Make 1-of-M explicit everywhere Phase 2A is surfaced |
| `documents.encryption_key_id` semantics become muddy | Old single-key assumptions may leak into new code | Treat holder list as canonical; use `encryption_key_id` as compatibility pointer only |
| Too many holders added casually | Expands access more than intended | Same-member-first UX, warnings, and deliberate add-holder steps |
| Unlock code still assumes first holder | Real holder unlock failures | Refactor lookup to match by accessible key, not array position |
| `key_holders` appears available but is structurally insufficient | Team may start persisting misleading partial state | Explicitly defer relational holder persistence for this phase |
| Mixed legacy/new envelope handling introduces regressions | Old docs may stop unlocking | Add explicit compatibility tests for both envelope shapes |

---

## Acceptance criteria

- A document can be encrypted to more than one PKI holder.
- The same member can enroll both a primary and backup key on one document.
- Any one enrolled holder key can unlock the document.
- The UI clearly states that selected holders are alternate unlock paths.
- Existing single-holder PKI documents continue to work unchanged.
- Cross-member alternate holders are parent-authorized only.
- `documents.encryption_key_id` remains populated for compatibility but is not
  treated as canonical authorization state.
- This phase does not claim or simulate quorum behavior.
- Phase 2A shipment does not depend on redesigning `key_holders`.

---

## Go / no-go checklist for implementation review

Implementation is ready to start when reviewers agree that:

- `encryption_metadata.holders[]` is the canonical Phase 2A auth source
- `documents.encryption_key_id` is a compatibility pointer only
- `key_holders` redesign is deferred, not hidden inside this scope
- legacy + new envelope compatibility rules are acceptable
- parent-only cross-member authorization is acceptable
- holder-aware key-info + unlock behavior is acceptable

If those are accepted, the plan is fit for implementation.

---

## Relationship to later phases

### Phase 2A
- multi-holder PKI
- explicit 1-of-M
- redundancy and alternate access
- metadata-canonical holder model

### Phase 2B / 3
- Shamir-wrapped shares
- true M-of-N threshold policies
- coordinated unlock ceremonies
- estate/inheritance-specific workflows
- redesigned relational holder persistence / lifecycle tooling

This phase is intentionally the bridge between today's single-key PKI and the
future threshold-based estate model.
