# Feature #11 Phase 2A.1 Implementation Plan: Extend Existing PKI-Locked Documents

Date: 2026-05-31
Status: Draft implementation plan
Parent: Feature #11 PKI Document Vault
Depends on: Feature #11 Phase 2A multi-holder PKI (shipped)
Recommended first slice: 2A.1A same-member backup-key extension

---

## Goal

Allow an already PKI-encrypted document to gain additional authorized holder
keys by re-wrapping the existing DEK, without re-encrypting the file contents.

Important invariant:
- the feature is only possible after the client proves possession of an already
  authorized holder key and locally unwraps the existing DEK
- this is a hard requirement, not a nice-to-have

Recommended release order:
1. same-member backup-key extension
2. parent-only cross-member alternate holder extension
3. later holder removal/replacement flows

---

## What ships in 2A.1A

1. Document action for already PKI-encrypted docs: **Add Backup Key**
2. Mandatory live local proof of an already authorized holder key
3. Mandatory client-side DEK unwrap from current PKI envelope
4. Client-side DEK re-wrap to another same-member registered public key
5. Dedicated API route to persist updated PKI envelope
6. Legacy single-holder envelope normalization on first mutation
7. Audit trail for holder extension

## Deferred from 2A.1A

- parent-only cross-member alternate holder add flow
- remove holder
- replace holder
- primary-pointer reassignment UI
- batch migration tooling

---

## Delivery chunks

### Chunk 1: Server route + validation contract

**Goal:** Add a dedicated mutation route for existing PKI docs.

#### 1a. New route

In `server.js`:

`POST /api/documents/:id/pki-holders/add`

Auth posture:
- require auth
- require parent mutation posture if that matches current sensitive document
  actions for the route family
- at minimum, require same mutation capability as encrypt-existing

#### 1b. Validation pipeline

Add server-side helpers in `lib/pki.js` (or adjacent file):
- `validatePkiHolderMutation(documentId, actorId, envelope, primaryKeyId)`
- `normalizeLegacyPkiEnvelopeForMutation(envelope)`
- `persistUpdatedPkiEnvelope(documentId, envelope, primaryKeyId)`

Validation responsibilities:
- existing document is PKI-encrypted
- updated holder set is valid Phase 2A holder metadata
- no duplicate holder key ids
- holder keys exist and are non-revoked
- role constraints hold (`owner`, `backup`, later `beneficiary`)
- primary holder still belongs to the actor for the 2A.1A slice
- `documents.encryption_key_id` is updated to primary/preferred pointer

#### 1c. Audit event

Log:
- `document.pki_holder_added`

Include:
- document id
- actor id
- added holder member id
- added holder key id
- role

**Tests for Chunk 1:**
- route rejects non-PKI docs
- route rejects malformed envelope
- route rejects duplicate holder ids
- route persists updated `encryption_key_id`

---

### Chunk 2: Client-side DEK re-wrap helper

**Goal:** Reuse the existing browser PKI primitives to extend an existing doc.

#### 2a. New browser helper direction

Either in `public/pki-crypto.js` or page-level helper code:
- prove the current holder path is valid by successfully unwrapping it
- unwrap existing DEK from current holder path
- wrap same DEK to new holder public key(s)
- construct updated holder-local envelope

Recommended helper shape:

```javascript
async function extendPkiEnvelopeWithHolders({
  existingEnvelope,
  currentHolder,
  currentHolderPrivateKey,
  additionalHolderPublicKeys
})
```

Responsibilities:
- normalize legacy envelope if necessary
- unwrap DEK from current holder path
- generate new holder-local wrapped DEK entries
- merge into updated holders array
- preserve IV / encrypted file metadata / ciphertext assumptions

#### 2b. Legacy normalization

If current envelope is Phase 1 legacy shape:
- map top-level `wrapped_dek` into `holders[0].wrapped_dek`
- preserve current holder metadata
- save back Phase 2A canonical holder-local shape

**Tests for Chunk 2:**
- legacy single-holder envelope normalizes correctly
- DEK unwrap + new holder wrap succeeds
- resulting envelope preserves existing file-level metadata

---

### Chunk 3: UI for same-member backup-key extension

**Goal:** Add a simple, safe UI path on existing PKI docs.

#### 3a. New action in `public/document.html`

Show action for PKI docs:
- **Add Backup Key**

Only when:
- document is PKI-encrypted
- current member has at least one additional registered key not already present

#### 3b. Modal behavior

Modal should:
- explain 1-of-M model
- explain that file bytes stay unchanged
- ask user to choose one additional same-member key
- require passphrase / WebAuthn ceremony for the currently authorized holder key
- confirm before submit

#### 3c. Submit flow

1. load `key-info`
2. select currently authorized holder path
3. locally prove access with an already authorized holder and unwrap current DEK
4. re-wrap DEK to selected backup key
5. submit updated envelope to `/api/documents/:id/pki-holders/add`
6. reload document detail and show expanded holder list

**Tests / manual checks for Chunk 3:**
- holder list shows both keys after mutation
- unlock works with original key
- unlock works with added backup key
- doc id and file list remain unchanged

---

### Chunk 4: Optional cross-member extension (2A.1B)

**Goal:** Extend same mechanism to one trusted alternate holder.

Only do this in the same pass if 2A.1A is already stable.

#### 4a. UI extension

Within the same modal or a separate action:
- **Add Trusted Alternate Holder**

Flow:
- parent selects household member
- parent selects one of that member's registered keys
- app re-wraps same DEK to that public key
- envelope adds `beneficiary` holder entry

#### 4b. Validation extension

Server must verify:
- actor is parent
- added member key belongs to declared member
- resulting role is `beneficiary`

**Tests for Chunk 4:**
- parent can add alternate holder
- non-parent cannot
- alternate holder can unlock existing ciphertext

---

## API contract recommendation

### Request

`POST /api/documents/:id/pki-holders/add`

```json
{
  "primary_encryption_key_id": 42,
  "encryption_metadata": { "...updated envelope..." }
}
```

### Response

Return updated document summary plus holder-aware key info, or keep the route
small and let the client refetch `/api/documents/:id` and `/api/documents/:id/key-info`.

Recommended simpler posture:
- route returns `{ ok: true }` or updated doc
- client refetches canonical read endpoints

---

## Data migration behavior

### Must remain unchanged
- ciphertext file rows
- ciphertext bytes on disk
- encrypted file metadata payload
- tags / owners / related links

### May change
- `documents.encryption_metadata`
- `documents.encryption_key_id`
- `updated_at`

### Must not happen silently
- DEK rotation
- content re-encryption
- holder removal

---

## Test plan

### Automated

Add/expand tests for:

1. existing legacy single-holder PKI doc can be normalized and extended
2. existing Phase 2A holder-local doc can add another same-member key
3. resulting ciphertext bytes remain unchanged
4. resulting envelope contains both old and new holder entries
5. original holder still unlocks
6. newly added backup holder unlocks
7. duplicate add is rejected
8. non-PKI document rejects route
9. non-parent cross-member add rejects route (if 2A.1B included)
10. parent cross-member add succeeds and alternate holder unlocks (if included)

Likely files:
- `test/pki-crypto.test.js`
- `test/pki.test.js`
- `test/documents-api.test.js`

### Manual

#### 2A.1A
- take an old single-holder PKI doc
- add backup key
- unlock with original key
- unlock with backup key
- verify file content remains intact

#### 2A.1B (if included)
- take existing PKI doc
- add trusted alternate parent/member
- unlock as alternate holder
- verify owner/member names render correctly in locked state

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Lockout from bad metadata mutation | Local proof + full server validation + tests for original/new holder unlock |
| Legacy normalization regressions | Explicit tests for Phase 1 envelope upgrade path |
| Users misunderstand this as sharing/quorum | Keep 1-of-M copy explicit in modal |
| Scope creep into full lifecycle management | Ship add-holder only first |

---

## Stop condition for 2A.1A

The first slice is complete when:
- same-member backup-key extension works on already PKI-encrypted docs
- legacy single-holder docs can be upgraded safely
- ciphertext bytes remain unchanged
- both original and added keys unlock successfully
- DB-backed tests are green for new mutation path

---

## Recommendation

Start implementation with 2A.1A only.

Only include 2A.1B in the same branch if:
- same-member extension is already stable
- tests are green
- manual UX remains simple and understandable

That keeps PKI development focused on realistic, safe, incremental value-adds
rather than prematurely expanding into estate-planning complexity.

## Actionable implementation checklist (2A.1A)

Implement in this order:

1. **Server route skeleton**
   - add `POST /api/documents/:id/pki-holders/add`
   - reject non-PKI documents
   - reject non-parent / unauthorized mutation if route posture requires it

2. **Envelope mutation helpers**
   - add legacy-envelope normalization helper
   - add holder-set validation helper
   - preserve `documents.encryption_key_id` as primary pointer

3. **Client DEK re-wrap helper**
   - unwrap current holder private key
   - unwrap current DEK
   - wrap DEK to new same-member key
   - emit updated holder-local envelope

4. **Document UI action**
   - add `Add Backup Key` action for PKI docs
   - show only when another same-member key exists and is not already enrolled

5. **Mutation submit path**
   - call key-info
   - prove current holder possession
   - build updated envelope
   - submit route
   - reload document/key-info views

6. **Automated tests**
   - legacy single-holder -> backup key added
   - phase2a holder-local -> backup key added
   - original holder still unlocks
   - new backup holder unlocks
   - ciphertext bytes unchanged

7. **Manual verification**
   - test old Phase 1 PKI doc
   - test current Phase 2A PKI doc
   - verify locked-state holder list updates
   - verify unlock with both keys

## Stop condition for implementation readiness

2A.1A is ready to build when the implementer agrees to all of the following:
- holder extension requires current valid holder proof
- DEK re-wrap is the mechanism, not file re-encryption
- legacy envelopes normalize on first mutation
- same-member backup-key extension is the only required first slice
- cross-member extension remains optional follow-on work
