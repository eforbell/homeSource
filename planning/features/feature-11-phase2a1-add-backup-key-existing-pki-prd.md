# Feature #11 Phase 2A.1: Extend Existing PKI-Locked Documents with Additional Keys

Date: 2026-05-31
Status: Draft PRD
Parent: Feature #11 PKI Document Vault
Depends on: Feature #11 Phase 1 (shipped), Feature #11 Phase 2A multi-holder PKI (shipped)
Scope: Per-document DEK re-wrapping for already PKI-encrypted documents

## Executive summary

Feature #11 Phase 2A shipped multi-holder PKI for:
- new encrypted uploads
- plaintext -> PKI encrypt-existing conversion
- same-member primary + backup holder sets
- parent-authorized alternate household holders

A remaining practical gap is that an already PKI-encrypted document cannot yet be
extended in place with additional authorized keys.

Phase 2A.1 closes that gap safely by adding a **document-level re-wrap flow**:
- unlock the existing PKI document locally through an already authorized holder
- recover the current DEK locally
- wrap that same DEK to one or more additional holder public keys
- update `encryption_metadata.holders[]`
- preserve ciphertext file bytes unchanged

This is a **metadata + DEK wrap migration**, not a full file re-encryption.

---

## Product goal

A parent or authorized document operator can take an already PKI-encrypted
document and extend it with an additional authorized key without re-uploading or
re-encrypting the file contents from scratch.

Primary near-term example:
- "This document is already encrypted to my YubiKey. Add my backup passkey too."

Secondary future-safe example:
- "This document is already encrypted to me. Add my spouse as a trusted
  alternate holder."

---

## Delivery recommendation

Ship in narrow, high-confidence steps:

1. **Phase 2A.1A: Add my backup key to this document**
   - same-member only
   - highest value / lowest ambiguity
2. **Phase 2A.1B: Add trusted alternate household holder**
   - parent-only cross-member extension
3. **Later: Manage PKI holders**
   - remove holder
   - replace holder
   - reorder/retag primary pointer

This PRD defines the broad Phase 2A.1 direction, but recommends 2A.1A as the
first implementation slice if sequencing discipline is desired.

---

## Locked product decisions

### 1. Re-wrap the DEK; do not re-encrypt file contents

The feature should:
- reuse the existing ciphertext file bytes
- reuse the current DEK
- generate new holder-local wrapped DEKs for additional holders
- update `documents.encryption_metadata`

It should **not**:
- decrypt/re-encrypt the file contents with a new DEK unless a future feature
  explicitly asks for that

### 2. Live proof from an existing valid holder is mandatory

A user may extend an existing PKI document only if they can currently unlock it
with an already-authorized holder key. This is not optional UX friction; it is
both a security requirement and the cryptographic prerequisite for the feature.

To extend holder access, the client must locally:
1. prove possession of an already-authorized holder key
2. unwrap the current holder private key locally
3. unwrap the existing DEK locally
4. re-wrap that same DEK to the newly added holder key(s)

Without a valid existing holder path, the DEK is not available, so the document
cannot be safely extended with additional keys.

This prevents metadata-only holder extension without demonstrating current key
possession.

### 3. Keep Phase 2A canonical auth source unchanged

The canonical authorization source remains:
- `documents.encryption_metadata.files.*.holders[]`

`documents.encryption_key_id` remains a compatibility pointer only.

### 4. Normalize legacy single-holder docs on first mutation

If an older Phase 1 PKI document still uses the legacy top-level `wrapped_dek`
shape, the first successful holder-extension mutation should rewrite it into the
Phase 2A holder-local wrapped-DEK format.

### 5. Do not start with full holder management

Initial UX should focus on **add holder** only.

Do not start with:
- remove holder
- reorder holders
- retag every role
- arbitrary bulk edit UI

### 6. Parent-only cross-member extension

If/when cross-member holder addition is enabled in this phase, it should remain:
- **parent-only**
- explicitly intentional
- scoped to registered, non-revoked member keys

---

## User stories

### Phase 2A.1A (recommended first slice)

1. As a parent, I can open an already PKI-encrypted document and add one of my
   other registered keys as a backup unlock path.
2. As a parent, I prove possession of a currently authorized key before the
   document is extended.
3. As a user, the document keeps the same id, file bytes, owners, tags, and
   organizational metadata while gaining another authorized key.
4. As either of my enrolled keys, I can unlock the document after the change.

### Phase 2A.1B (optional same feature family)

5. As a parent, I can add another parent/household member as a trusted
   alternate holder for an already encrypted PKI document.
6. As that alternate holder, I can unlock the same ciphertext with my own key.

---

## Non-goals

- Shamir Secret Sharing
- quorum / M-of-N unlock
- full holder lifecycle editor
- remove/revoke/reorder holder UI in the first slice
- automatic migration of all PKI documents in batch
- `key_holders` relational redesign
- file-content re-encryption with a new DEK

---

## Scope boundaries

### In scope

- extend an already PKI-encrypted document with additional holder key(s)
- same-member backup key addition
- optional parent-only cross-member alternate holder addition
- mandatory local DEK unwrap + re-wrap flow via an already authorized holder path
- envelope normalization from legacy single-holder shape to holder-local shape
- audit trail for holder-extension mutations

### Out of scope

- passphrase-encrypted document -> PKI extension
- removing existing holders in the first slice
- rotating the DEK
- multi-file/complex rewrite semantics beyond current PKI document assumptions
- batch holder-extension workflow across many documents

---

## UX direction

## Entry point

On an already PKI-encrypted document, add a document action such as:
- **Extend PKI Access**
- or **Add Backup Key** (for the narrow first slice)

Recommended label for 2A.1A first slice:
- **Add Backup Key**

If 2A.1B is included from the start, the broader label is better:
- **Extend PKI Access**

## Modal contents

The modal should explain:
- the file itself will remain encrypted as-is
- the app will verify that you can unlock the existing document first
- the system will add another unlock path by wrapping the same document key to
  another registered public key
- this is still **1-of-M alternate access**, not quorum

## Suggested copy

- **Access model: 1-of-M**
- "Any one selected key can unlock this document."
- "This action does not re-upload the file. It adds another authorized key by
  re-wrapping the existing document key locally."

## Suggested first-slice UI

### 2A.1A
- current primary/authorized key display
- select one additional same-member key
- show warning if chosen key is already present
- require current unlock proof before submit

### 2A.1B
- separate section: **Trusted Alternate Holder**
- member picker (parent-only)
- member-key picker after member selection

---

## Technical direction

## High-level flow

1. load PKI doc and holder metadata
2. user proves possession of an already authorized holder key (mandatory)
3. client unwraps the member private key locally
4. client unwraps the existing DEK locally (mandatory prerequisite for any holder extension)
5. client imports the additional holder public key(s)
6. client creates new holder-local wrapped DEK entries
7. client submits updated envelope metadata to dedicated mutation route
8. server validates resulting holder set and persists metadata atomically

## Crucial technical distinction

This is **DEK re-wrapping**, not file re-encryption.

The encrypted `document_files` rows should remain unchanged unless some future
feature explicitly rotates the DEK.

---

## API shape

Do not overload generic `PUT /api/documents/:id`.

Recommended dedicated route:

`POST /api/documents/:id/pki-holders/add`

Possible future siblings:
- `POST /api/documents/:id/pki-holders/remove`
- `POST /api/documents/:id/pki-holders/replace`

### Request shape (recommended)

```json
{
  "encryption_metadata": { "...updated envelope..." },
  "primary_encryption_key_id": 42
}
```

Alternative delta-style requests are possible, but full-envelope submission is
simpler to validate against existing Phase 2A contracts.

## Server validation contract

The route must verify:
- document exists
- document is currently PKI-encrypted
- actor may mutate the document
- actor has parent privileges if cross-member holders are added
- updated envelope is structurally valid
- all holder key ids exist and are non-revoked
- all holder fingerprints match
- same-member/cross-member role constraints still hold
- the resulting document still has at least one valid primary holder
- `documents.encryption_key_id` remains aligned to the primary/preferred holder

---

## Data behavior

### Preserve
- document id
- ciphertext file bytes
- file ids / file records where possible
- owners
- tags
- related document relationships
- audit continuity

### Update
- `documents.encryption_metadata`
- `documents.encryption_key_id` if the primary pointer changes
- `updated_at`

### Legacy normalization rule

If existing metadata uses:
- top-level `entry.wrapped_dek`
- single `holders[0]`

then the first successful extension should save back:
- holder-local `holder.wrapped_dek`
- explicit holder-local Phase 2A format

---

## Audit events

Recommended new audit events:
- `document.pki_holder_added`
- `document.pki_access_extended`
- later: `document.pki_holder_removed`

Audit details should include:
- document id
- acting member id
- added holder member id
- added holder key id
- role (`backup` or `beneficiary`)

No secret material, no DEK, no private key, no wrapped key bytes in audit logs.

---

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Metadata update accidentally locks the document | Critical data access risk | Require live unlock proof; validate full resulting envelope client + server |
| Legacy normalization breaks old docs | Phase 1 compatibility regression | Add explicit mutation-path tests for legacy docs |
| Cross-member path introduces auth ambiguity | Security boundary regression | Parent-only rule stays explicit |
| Users expect "full sharing" rather than alternate unlock | Wrong mental model | Keep 1-of-M copy explicit |
| Route mutates metadata without proof of possession | Weakens security posture | Require local unwrap before submit |

---

## Acceptance criteria

### For 2A.1A first slice

- An already PKI-encrypted document can be extended with another same-member
  registered key.
- The operator must prove current access with an already authorized key.
- The file ciphertext remains unchanged.
- The document can be unlocked by either the original key or the newly added
  same-member key.
- Existing single-holder legacy PKI docs can be upgraded successfully.

### If 2A.1B is included

- A parent can add a trusted alternate member key to an already PKI-encrypted
  document.
- That alternate holder can unlock the existing ciphertext independently.
- Non-parent actors cannot add cross-member holders.

---

## Recommendation

Proceed first with:
- **Feature 11 Phase 2A.1A: Add backup key to existing PKI document**

Then layer on:
- **Feature 11 Phase 2A.1B: Add trusted alternate holder to existing PKI document**

This sequencing keeps the immediate PKI value-add realistic, safe, and aligned
with the goal of practical incremental PKI rather than estate-planning
complexity.
