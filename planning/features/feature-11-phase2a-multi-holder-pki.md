# Feature #11 Phase 2A: Multi-Holder PKI (1-of-M, Same-Member-First)

Date: 2026-05-28
Status: Planned
Parent: Feature #11 PKI Document Vault
Depends on: Feature #11 Phase 1 (shipped), Feature Request #101 encrypt-existing-document
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

This phase exists to make PKI practical for real vault use before the added
complexity of Shamir threshold policies and estate ceremonies in Phase 2B/3.

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

---

## User stories

1. As a vault owner, I can encrypt a document to my primary and backup key so
   either key can unlock it.
2. As a vault owner, I can add a second registered key of my own without
   changing the document's organizational metadata.
3. As a vault owner, I can add a second household holder for alternate access
   when I deliberately want that.
4. As an authorized holder, I can unlock the document with any enrolled key I
   control.
5. As a user, I am clearly told that selected holders are **alternate unlock
   paths**, not a cooperative quorum.

---

## Non-goals

- Shamir Secret Sharing
- M-of-N quorum policies
- async ceremonies or staged share submission
- deadman's switch execution
- beneficiary notification workflows
- key rotation/re-wrapping automation across existing documents

---

## Scope boundaries

### In scope

- multi-holder PKI selection at encrypt time
- same-member multiple keys
- cross-member alternate holders
- document unlock by any matching enrolled holder key
- server validation of all holder bindings
- holder visibility in document details
- optional persistence to `key_holders` for future lifecycle work

### Out of scope

- requiring 2 or more holders to cooperate
- splitting DEKs into shares
- asynchronous collection or escrow of holder contributions
- automatic migration of all existing Phase 1 documents

---

## Current implementation constraints

Phase 1 currently assumes single-holder PKI in several places:

- `lib/pki.js::validatePkiUpload()` requires exactly one holder per file
- `public/pki-crypto.js::buildPkiEnvelope()` emits exactly one holder
- `public/document.html` unlock logic assumes `holders[0]`
- `documents.encryption_key_id` acts like a single active key pointer

Phase 2A must deliberately remove those assumptions without breaking Phase 1
single-holder documents.

---

## Envelope direction

## Recommendation: holder-local wrapped DEKs

Instead of one top-level `wrapped_dek` shared across all holders, each holder
entry should carry its own wrapped DEK payload. Each holder has a different
public key target, so this structure is easier to validate and easier to unlock.

Recommended conceptual shape:

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

Recommendation:
- keep the column for backward compatibility
- treat it as optional or as the document owner's preferred/primary key pointer
- do not rely on it as the sole source of holder truth in multi-holder mode

## `key_holders`

The repo already has a dormant `key_holders` table intended for day-2 work.
Phase 2A should begin using it for queryability and future migration leverage.

Recommended posture:
- canonical live unlock data remains in `documents.encryption_metadata`
- also persist one `key_holders` row per authorized holder
- `encrypted_key_share` may temporarily store holder-specific wrapped DEK JSON or
  remain a future-focused field if a cleaner migration path is preferred

The important outcome is that Phase 2A begins treating holder membership as a
first-class server-side concept rather than an opaque client-only array.

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
- offer an intentional "Add backup key" action

### Cross-member support

Allow adding a second member's key, but make it a separate step so it feels more
intentional than adding another one of your own keys.

## Guardrails

- warn when holder count exceeds a small number (for example >3)
- explain that each added holder is an alternate unlock path
- show holder names + key labels + protection tier so the operator understands
  exactly what is being authorized

---

## Unlock behavior

When a holder attempts to unlock:

1. load the document's PKI holder list
2. locate any holder entry whose `member_id` and `encryption_key_id` match a key
   the current user can access
3. fetch that holder's wrapped private key material
4. unwrap that holder's member private key locally
5. unwrap that holder's wrapped DEK locally
6. decrypt the document

Important: the document unlock flow should not assume the first holder is the
correct holder. It must search for a compatible holder path.

---

## Validation rules

Server must verify for every holder:
- `encryption_key_id` exists
- key is a `member` key
- key is not revoked
- key fingerprint matches server-stored fingerprint
- declared `member_id` matches the key's owner
- holder role is allowed for Phase 2A (`owner`, `backup`, `beneficiary`, or a
  similarly constrained list finalized at implementation time)

Additional policy checks:
- at least one holder is present
- all holder key ids are unique
- duplicate holder entries are rejected
- for same-member backup mode, multiple keys owned by the acting member are allowed
- for cross-member mode, only authorized document editors can grant access

---

## Delivery chunks

### Chunk 1: Envelope + validation foundation

- extend `public/pki-crypto.js` to build multi-holder envelopes
- extend `lib/encryption-mode.js` PKI validation for holder-local wrapped DEKs
- replace exact-one-holder validation in `lib/pki.js`
- maintain backward compatibility for existing Phase 1 envelopes

### Chunk 2: Unlock path generalization

- update `public/document.html` to search holder candidates instead of indexing
  `holders[0]`
- ensure unlock succeeds with either of two keys owned by the same member
- ensure unlock still works for legacy single-holder docs

### Chunk 3: Upload/encrypt UI

- allow multiple PKI holder selection in upload flow
- same-member-first UX for primary + backup keys
- explicit 1-of-M access model copy
- optional warning for large holder sets

### Chunk 4: Holder persistence / visibility

- decide how `key_holders` is populated in Phase 2A
- surface holder list in document details
- prepare audit events and lifecycle hooks for future revocation/re-wrap work

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
8. existing single-holder Phase 1 docs still unlock

Likely files:
- `test/pki-crypto.test.js`
- `test/encryption-mode.test.js`
- `test/pki.test.js`
- `test/documents-api.test.js`

### Manual

- encrypt with primary + backup key for same member
- unlock with primary key
- unlock with backup key
- encrypt with owner + second household member
- verify copy makes clear this is alternate access, not quorum

---

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Users confuse multi-holder with quorum | Wrong security expectation for critical docs | Make 1-of-M explicit everywhere Phase 2A is surfaced |
| `documents.encryption_key_id` semantics become muddy | Old single-key assumptions may leak into new code | Treat holder list as canonical for multi-holder mode |
| Too many holders added casually | Expands access more than intended | Same-member-first UX, warnings, and deliberate add-holder steps |
| Unlock code still assumes first holder | Real holder unlock failures | Refactor lookup to match by accessible key, not array position |

---

## Acceptance criteria

- A document can be encrypted to more than one PKI holder.
- The same member can enroll both a primary and backup key on one document.
- Any one enrolled holder key can unlock the document.
- The UI clearly states that selected holders are alternate unlock paths.
- Existing single-holder PKI documents continue to work unchanged.
- This phase does not claim or simulate quorum behavior.

---

## Relationship to later phases

### Phase 2A
- multi-holder PKI
- explicit 1-of-M
- redundancy and alternate access

### Phase 2B / 3
- Shamir-wrapped shares
- true M-of-N threshold policies
- coordinated unlock ceremonies
- estate/inheritance-specific workflows

This phase is intentionally the bridge between today's single-key PKI and the
future threshold-based estate model.
