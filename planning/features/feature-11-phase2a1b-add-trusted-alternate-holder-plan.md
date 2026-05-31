# Feature #11 Phase 2A.1B Implementation Plan: Add Trusted Alternate Holder to Existing PKI Documents

Date: 2026-05-31
Status: Draft implementation plan (post-merge of 2A.1A)
Parent: Feature #11 PKI Document Vault
Depends on: Feature #11 Phase 2A.1A same-member backup-key extension (PR #16)
Scope: Parent-only cross-member holder extension for existing PKI-encrypted documents

---

## Goal

Allow a parent to take an already PKI-encrypted document and add one trusted
alternate household member (e.g., spouse, kid) as an additional unlock path —
without re-encrypting the file contents.

Example: "This birth certificate is encrypted to my YubiKey. Add my spouse as a
trusted alternate holder so she can unlock it too."

---

## What exists after 2A.1A merges

### Infrastructure we inherit

1. **Route:** `POST /api/documents/:id/pki-holders/add` with full validation
   pipeline (auth, access, PKI mode check, envelope normalization, holder-set
   integrity, audit logging)
2. **Client helpers:** `buildNormalizedPkiEnvelope()`,
   `buildExtendedEnvelopeWithBackupKey()`, DEK unwrap + re-wrap flow
3. **Beneficiary role:** Already recognized in `validatePkiUpload` (lib/pki.js:298)
   with cross-member constraint enforced
4. **Cross-member UI:** Encrypt-existing modal already has member picker +
   key picker for beneficiary selection (document.html:890-923)
5. **Parent key listing:** Parents can already list any member's keys via
   `GET /api/members/:id/keys`
6. **Holder metadata resolution:** `getDocumentKeyInfo` already resolves holder
   labels, protection tiers, and member IDs across members

### Constraints from validatePkiUpload (lib/pki.js:259-319)

- `beneficiary` role requires `holder.member_id !== uploadingMemberId` (line 298)
- `backup` role requires `holder.member_id === uploadingMemberId` (line 295)
- Cross-member holders require `uploadingMemberRole === 'parent'` (line 317)
- Primary holder (index 0) must belong to the uploading/acting member (line 302)
- All holder key IDs must exist, be non-revoked, and have matching fingerprints

### Current 2A.1A route constraints (server.js:868-873)

Two guards we need to relax for 2A.1B:

```javascript
// Guard 1: exactly one new holder
if (addedHolders.length !== 1) { ... }

// Guard 2: same-member backup only
if (Number(addedHolder.member_id) !== Number(req.member.id) || addedHolder.role !== 'backup') { ... }
```

---

## Delivery approach

Two options for shipping 2A.1B:

### Option A: Extend the existing route

Relax the 2A.1A guards on `POST /api/documents/:id/pki-holders/add` to also
accept a single `beneficiary` holder belonging to a different member. This is
the simpler path — the validation pipeline, envelope handling, audit logging,
and DB update are already correct for the general case.

### Option B: New dedicated route

Add `POST /api/documents/:id/pki-holders/add-beneficiary` with separate
validation. This gives cleaner separation but duplicates most of the route logic.

**Recommendation: Option A.** The existing route already calls `validatePkiUpload`
which handles beneficiary role constraints. The only guards to change are the
two 2A.1A-specific checks. The route stays narrow (add exactly one holder) while
becoming role-flexible.

---

## Implementation chunks

### Chunk 1: Relax server route to accept beneficiary holders

**Goal:** Allow the add-holder route to accept one `beneficiary` holder from a
different household member.

#### 1a. Replace the 2A.1A-specific guard

In `server.js`, replace the current same-member-only check:

```javascript
// BEFORE (2A.1A)
if (Number(addedHolder.member_id) !== Number(req.member.id) || addedHolder.role !== 'backup') {
  return res.status(400).json({ error: 'This route currently supports adding one same-member backup holder only' });
}

// AFTER (2A.1B)
const allowedRoles = ['backup', 'beneficiary'];
if (!allowedRoles.includes(addedHolder.role)) {
  return res.status(400).json({ error: 'Added holder must have role backup or beneficiary' });
}
if (addedHolder.role === 'backup' && Number(addedHolder.member_id) !== Number(req.member.id)) {
  return res.status(400).json({ error: 'Backup holders must belong to the acting member' });
}
if (addedHolder.role === 'beneficiary' && Number(addedHolder.member_id) === Number(req.member.id)) {
  return res.status(400).json({ error: 'Beneficiary holders must belong to a different member' });
}
```

Note: `validatePkiUpload` already enforces the same constraints at lines 295-300,
so these are defense-in-depth checks before we reach the shared validation.

#### 1b. No changes needed to validatePkiUpload

The existing validation in `lib/pki.js` already handles:
- beneficiary must be different member (line 298)
- cross-member requires parent role (line 317)
- key must exist, be non-revoked, fingerprint must match (lines 267-290)

#### 1c. No changes needed to updatePkiDocumentAccess

The DB function is envelope-agnostic — it persists whatever validated metadata
the route provides.

#### 1d. Audit event

Use the same `document.pki_holder_added` event. The `role` field already
distinguishes backup from beneficiary. Consider adding `added_holder_member_name`
to the audit details for readability:

```javascript
await audit.log('document.pki_holder_added', 'document', doc.id, req.member.id, {
  added_holder_member_id: Number(addedHolder.member_id),
  added_holder_key_id: Number(addedHolder.encryption_key_id),
  role: addedHolder.role,
  holder_count_before: existingHolders.length,
  holder_count_after: updatedHolders.length,
  encryption_key_id: primaryKeyId
});
```

**Tests for Chunk 1:**
- parent can add a beneficiary holder belonging to a different member
- non-parent cannot add a beneficiary holder (403 from requireParent)
- beneficiary holder cannot belong to the acting member (400)
- backup holder still works as before (regression)
- adding a holder with role other than backup/beneficiary is rejected
- duplicate beneficiary key ID is rejected

---

### Chunk 2: Client-side UI for adding a trusted alternate holder

**Goal:** Add UI to the document detail page for extending PKI access to another
household member.

#### 2a. UI entry point

Two options:

1. **Extend the existing "Add Backup Key" button/modal** to include a beneficiary
   section (only visible for parents). This keeps one flow but makes the modal
   more complex.

2. **Separate "Add Trusted Holder" button** next to "Add Backup Key". This is
   cleaner UX — backup keys and alternate holders are different mental models.

**Recommendation: Separate button.** Keep the backup-key flow simple for
same-member cases. The new button label: **Add Trusted Holder**.

Show the button only when:
- document is PKI-encrypted
- current member is a parent
- at least one other household member has a registered, non-revoked key

#### 2b. New modal: Add Trusted Holder

```html
<div class="modal-backdrop hidden" id="add-trusted-holder-modal">
  <div class="modal">
    <div class="modal-title">Add Trusted Holder</div>
    <div class="text-dim text-sm mb-1">
      Access model: <strong>1-of-M</strong>. This does not re-encrypt the file.
      It proves access with your existing key, recovers the document key locally,
      and adds one alternate holder from your household.
    </div>
    <!-- Current authorized key selector (same as backup-key modal) -->
    <!-- Household member selector -->
    <!-- Member's key selector (populated on member change) -->
    <!-- Passphrase input for current holder proof -->
    <!-- Status display -->
    <!-- Cancel / Add Trusted Holder buttons -->
  </div>
</div>
```

#### 2c. Member picker

Reuse the existing `loadMemberKeysForMember(memberId)` and the member-listing
pattern from the encrypt-existing beneficiary UI (document.html:890-923).

Flow:
1. Fetch household members via `GET /api/members`
2. Filter to members who are NOT the current member
3. Filter to members who have at least one non-revoked registered key
4. Populate member dropdown
5. On member selection, fetch that member's keys via `GET /api/members/:id/keys`
6. Filter out any keys already enrolled as holders on this document
7. Populate key dropdown

#### 2d. DEK re-wrap for beneficiary

The crypto flow is identical to the backup-key flow:
1. Prove current holder possession (passphrase / WebAuthn)
2. Unwrap member private key with KEK
3. Unwrap DEK with member private key (extractable=true)
4. Import beneficiary's public key
5. Wrap DEK to beneficiary's public key
6. Build updated envelope with new beneficiary holder entry

The only difference from `buildExtendedEnvelopeWithBackupKey` is:
- `member_id` is the OTHER member's ID (not currentMember.id)
- `role` is `'beneficiary'` instead of `'backup'`

**Recommendation:** Extract a shared helper from `buildExtendedEnvelopeWithBackupKey`:

```javascript
async function buildExtendedEnvelopeWithHolder(doc, keyInfo, currentHolder, newKey, opts) {
  // opts: { memberId, role, passphrase, statusEl }
  // ... same DEK unwrap + re-wrap flow
  // ... push holder with opts.memberId and opts.role
}
```

Then:
- `buildExtendedEnvelopeWithBackupKey` calls it with
  `{ memberId: currentMember.id, role: 'backup' }`
- new `buildExtendedEnvelopeWithBeneficiary` calls it with
  `{ memberId: selectedMemberId, role: 'beneficiary' }`

#### 2e. Submit flow

```javascript
async function submitAddTrustedHolder() {
  // 1. Get selected current holder, target member, target key
  // 2. Prove current holder access
  // 3. Build extended envelope with beneficiary
  // 4. POST /api/documents/:id/pki-holders/add
  // 5. Close modal, toast, reload document
}
```

**Tests / manual checks for Chunk 2:**
- modal shows member picker with other household members
- member picker excludes current member
- key picker shows only non-enrolled, non-revoked keys for selected member
- submit succeeds and document shows new holder in key-info
- beneficiary can unlock the document with their key
- original holder(s) can still unlock

---

### Chunk 3: Holder display improvements

**Goal:** Make cross-member holders visible and understandable on the document
detail page.

#### 3a. Holder list rendering

The existing holder display (in the locked-state and key-info views) shows
holder label and role. For beneficiary holders, also show the member name:

```
YubiKey Pro (owner) — Eric
Backup Passkey (backup) — Eric
Hardware Key (beneficiary) — Sarah
```

#### 3b. Member name resolution

The `getDocumentKeyInfo` response already includes `member_id` per holder.
The client needs a way to resolve member names. Options:
- Add `member_name` to the key-info response (preferred — single fetch)
- Fetch `GET /api/members/:id` for each unique member_id

**Recommendation:** Extend `getDocumentKeyInfo` in `lib/pki.js` to join against
`family_members` and include `member_name` in each holder object. This avoids
N+1 queries and is a small schema addition.

**Tests for Chunk 3:**
- holder list shows member name for cross-member holders
- holder list still works for same-member-only documents

---

## What NOT to build in 2A.1B

- Remove holder
- Replace holder
- Reorder holders
- Batch holder extension across documents
- Kid-initiated holder extension (parent-only)
- Multiple beneficiaries in a single request (one at a time)
- Beneficiary-to-owner promotion

---

## API contract

### Request (unchanged shape from 2A.1A)

`POST /api/documents/:id/pki-holders/add`

```json
{
  "primary_encryption_key_id": 42,
  "encryption_metadata": {
    "version": 1,
    "mode": "pki",
    "policy": { "access_model": "any_one_holder", "threshold": 1 },
    "files": {
      "upload": {
        "cipher": "aes-256-gcm",
        "iv_b64": "...",
        "tag_length_bits": 128,
        "holders": [
          { "member_id": 1, "encryption_key_id": 101, "role": "owner", "wrapped_dek": { ... } },
          { "member_id": 1, "encryption_key_id": 102, "role": "backup", "wrapped_dek": { ... } },
          { "member_id": 2, "encryption_key_id": 201, "role": "beneficiary", "wrapped_dek": { ... } }
        ]
      }
    }
  }
}
```

### Response (unchanged)

```json
{ "ok": true, "document": { ... } }
```

---

## Data behavior

### Unchanged from 2A.1A
- ciphertext file bytes preserved
- document ID preserved
- tags, owners, related links preserved
- DEK NOT rotated
- file records NOT modified

### Updated
- `documents.encryption_metadata` — new beneficiary holder entry added
- `documents.encryption_key_id` — unchanged (primary holder stays the same)
- `documents.updated_at` — timestamp updated

---

## Security considerations

### Authorization boundary

- Route requires `requireAuth` + `requireParent`
- `validatePkiUpload` enforces cross-member holders require parent role
- Kids cannot call this route at all
- A parent can only add keys belonging to members who exist in the household

### What the server cannot verify

- That the client actually proved possession of the current holder key
  (proof-of-possession is client-side only — inherent to the architecture)
- That the wrapped DEK for the beneficiary actually contains the correct DEK
  (the server never sees the plaintext DEK)

These are the same limitations that exist for 2A.1A and the original encrypt
flow. They are architectural constraints of client-side encryption.

### What the server CAN and DOES verify

- Key exists and is non-revoked
- Key belongs to the declared member
- Key fingerprint matches
- Role constraints (beneficiary ≠ same member, backup = same member)
- Only parents can add cross-member holders
- Existing holders are not modified or removed (2A.1A integrity check)
- Exactly one holder is added per request

---

## Test plan

### Automated

Add to `test/documents-api.test.js`:

1. parent adds beneficiary holder from a different member — succeeds, returns
   updated document with 2+ holders
2. non-parent (kid) cannot add beneficiary holder — 403
3. beneficiary member_id cannot equal acting member — 400
4. beneficiary key must exist and be non-revoked — 400
5. beneficiary key fingerprint must match — 400
6. existing holders preserved in resulting envelope
7. ciphertext bytes unchanged after beneficiary addition
8. backup key addition still works (2A.1A regression)

### Manual

1. Parent opens PKI doc → clicks "Add Trusted Holder"
2. Parent selects household member from dropdown
3. Key dropdown populates with that member's keys
4. Parent enters passphrase for their current holder key
5. Submit succeeds → toast → holder list shows new beneficiary
6. Log out → log in as beneficiary member → navigate to shared doc
7. Beneficiary unlocks doc with their key — file content intact
8. Log back in as parent → original key still unlocks
9. Add Trusted Holder button hidden for kid accounts

---

## Estimated scope

| Chunk | Estimated effort | Risk |
|---|---|---|
| 1. Server route relaxation | Small — ~20 lines changed, no new helpers | Low |
| 2. Client UI + crypto | Medium — new modal, member picker, shared helper extraction | Moderate |
| 3. Holder display | Small — member name in key-info, display tweak | Low |

Total: roughly half the effort of 2A.1A, since the route, DB function, crypto
helpers, and validation pipeline are already in place.

---

## Implementation order

1. Server route changes (Chunk 1) — get the API accepting beneficiary holders
2. Automated tests for server route — verify before touching client
3. Client modal + member picker + crypto flow (Chunk 2)
4. Holder display improvements (Chunk 3)
5. Manual verification on test server
6. PR

---

## Stop condition

2A.1B is complete when:
- a parent can add a trusted alternate holder to an already PKI-encrypted document
- the beneficiary can unlock the document with their own key
- existing holders can still unlock
- ciphertext bytes are unchanged
- kids cannot perform this operation
- DB-backed tests are green for beneficiary holder addition
- manual testing confirms the full flow on the test server
