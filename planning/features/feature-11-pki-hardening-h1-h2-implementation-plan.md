# Feature #11 PKI Hardening H1/H2 Implementation Plan

Date: 2026-06-02
Status: Draft implementation plan
Parent: Feature #11 PKI Hardening Plan
Depends on: `feature-11-pki-hardening-plan.md`
Scope: First shipping hardening slice only — dependency visibility, revoke preflight, and server-side revoke guardrails

---

## Goal

Implement the smallest high-value PKI hardening release that prevents
accidental revocation of the sole active unlock key for a PKI-encrypted
document.

This slice covers:

1. key → document dependency visibility
2. revoke preflight in Settings
3. server-side revoke blocking when a revoke would strand documents

This slice does **not** cover:
- revoked-holder badges on document detail
- holder replacement/removal flows
- relational indexing / projections

---

## Current implementation anchor points

### Server

- `GET /api/members/:id/keys` → `pki.listMemberKeys(memberId)` in `server.js:422-430`
- `DELETE /api/members/:id/keys/:keyId` → `pki.revokeMemberKey(...)` in `server.js:587-597`
- `GET /api/documents/:id/key-info` → `pki.getDocumentKeyInfo(doc.id)` in `server.js:650-660`

### PKI module

- `listMemberKeys()` in `lib/pki.js:13-27`
- `getMemberKey()` in `lib/pki.js:29-43`
- `getMemberKeyMaterial()` in `lib/pki.js:45-59`
- `revokeMemberKey()` in `lib/pki.js:115-131`
- `getDocumentKeyInfo()` in `lib/pki.js:140-221`

### Settings UI

- key list loads from `loadKeys()` in `public/settings.js`
- revoke button wiring in `public/settings.js:227-228`
- current revoke confirm flow in `public/settings.js:287-300`

### Current limitations visible in code

1. `listMemberKeys()` excludes revoked keys entirely
2. `revokeMemberKey()` is a blind mutation — no dependency analysis
3. Settings revoke copy only warns about future uploads
4. There is no key-centric dependency route or helper

---

## Recommended implementation decisions

### Decision 1 — Add a dedicated dependency endpoint, not a separate revoke-preflight route

Implement:

- `GET /api/members/:id/keys/:keyId/dependencies`

Do **not** add a second `revoke-preflight` route in this first slice.

Why:
- one reusable source of truth
- useful for future key posture UI, not just revoke modal
- simpler tests and less duplicated server logic

Settings can call this route before showing the confirm dialog.

### Decision 2 — Keep dependency analysis in `lib/pki.js` for H1/H2

Add:

- `getKeyDependencySummary(keyId, memberId)`

Do not split into a separate module yet. The logic is tightly coupled to:
- encryption key rows
- document envelope holder structure
- holder revocation semantics

### Decision 3 — Scan PKI documents directly from JSONB source of truth

For this slice, dependency analysis should scan:
- `documents`
- `documents.encryption_mode = 'pki'`
- `documents.is_encrypted = TRUE`

Then evaluate `encryption_metadata.files.*.holders[]` in application code.

Do **not** introduce a relational projection yet.

### Decision 4 — Block unsafe revoke server-side with `409`

If any affected PKI document would have zero active holders after revoking the
target key, reject the revoke:

- HTTP `409 Conflict`
- stable error code: `PKI_KEY_SOLE_ACTIVE_HOLDER`

### Decision 5 — Do not change `listMemberKeys()` shape yet

H3 will likely need `includeRevoked`, but H1/H2 does not.
For this first slice:
- leave `listMemberKeys()` behavior alone
- fetch dependency summary only for currently listed active keys

This keeps the diff smaller and avoids mixing H3 concerns into H1/H2.

---

## Exact server-side approach

### Chunk 1: Add key dependency summary helper in `lib/pki.js`

Add:

```javascript
async function getKeyDependencySummary(keyId, memberId) { ... }
```

Recommended algorithm:

1. Load target key using `getMemberKey(keyId, memberId)`
   - if no key, return `null`

2. Query all PKI documents:

```sql
SELECT id, title, encryption_metadata, encryption_key_id
FROM documents
WHERE is_encrypted = TRUE AND encryption_mode = 'pki'
ORDER BY id
```

Note:
- this intentionally scans all PKI documents, not just documents "owned" by
  the member — a key may appear as a backup or beneficiary holder on documents
  owned by another household member

3. For each document:
   - inspect `Object.values(encryption_metadata.files || {})`
   - collect every holder entry across file entries
   - find whether `keyId` appears in any holder set
   - if not, skip document

4. For matching documents:
   - normalize holder set for the primary file entry using current
     `getDocumentKeyInfo()` semantics
   - collect all distinct referenced `encryption_key_id` values across the
     full matching document set
   - resolve those `encryption_keys` rows in a single batch query
   - map the resolved key rows back per document
   - classify active vs revoked holders

5. Compute per-document status:
   - `alternate_holders_available`
   - `sole_active_holder`
   - `all_holders_revoked`
   - `holder_metadata_inconsistent`

6. Return summary counts plus document detail rows

Recommended return shape:

```json
{
  "key": {
    "id": 42,
    "member_id": 1,
    "label": "YubiKey",
    "key_fingerprint": "abcd:..."
  },
  "document_count": 3,
  "summary": {
    "safe_docs": 2,
    "at_risk_docs": 1,
    "already_stranded_docs": 0
  },
  "documents": [
    {
      "document_id": 88,
      "title": "Birth Certificate",
      "holder_count": 2,
      "active_holder_count": 1,
      "revoked_holder_count": 1,
      "target_key_role": "owner",
      "is_primary_pointer": true,
      "status": "sole_active_holder"
    }
  ]
}
```

Implementation note:
- the helper should use `getMemberKey()` not `getMemberKeyMaterial()`
- future consideration: H3 revoked-key visibility will likely require this
  helper or `getMemberKey()` to support an `includeRevoked` option; not
  required for this slice because Settings only exposes active keys

### Chunk 2: Add dependency route in `server.js`

Add:

```javascript
app.get('/api/members/:id/keys/:keyId/dependencies', requireAuth, async (req, res) => {
  ...
});
```

Auth posture for first slice:
- only the key owner may inspect dependencies for their own key

Reason:
- smallest safe rule
- avoids making a broader product decision about parent household oversight yet

Recommended responses:
- `403` if caller is not the owner
- `404` if key not found
- `200` with dependency summary if found

### Chunk 3: Add revoke guard in `DELETE /api/members/:id/keys/:keyId`

Before calling `revokeMemberKey(...)`:

1. call `getKeyDependencySummary(keyId, memberId)`
2. if helper returns `null` → 404
3. if `summary.at_risk_docs > 0` → reject with `409`
4. if any document is classified `holder_metadata_inconsistent` → reject with
   `409` and fail safe

Recommended response:

```json
{
  "error": "Key cannot be revoked because it is the sole active holder for encrypted documents",
  "code": "PKI_KEY_SOLE_ACTIVE_HOLDER",
  "affected_documents": [
    { "document_id": 88, "title": "Birth Certificate" }
  ]
}
```

Also log:

```javascript
await audit.log('key.revoke_blocked', 'encryption_key', keyId, req.member.id, {
  member_id: memberId,
  affected_document_count: summary.document_count,
  sole_active_holder_document_count: summary.summary.at_risk_docs
});
```

If no at-risk documents:
- proceed with existing revoke behavior unchanged

---

## Exact client-side approach

### Chunk 4: Add dependency fetch in Settings revoke flow

In `public/settings.js`, add:

```javascript
async function getKeyDependencies(memberId, keyId) {
  return API.get(`api/members/${memberId}/keys/${keyId}/dependencies`);
}
```

### Chunk 5: Replace the static revoke confirm message

Current:

```javascript
Revoke "X"? Any future PKI uploads tied to it will be blocked.
```

New flow:

1. fetch dependency summary
2. branch on result

#### No dependency

Confirm modal:

`Revoke "X"? It is not currently referenced by any PKI-encrypted documents.`

#### Safe dependency

Confirm modal:

`Revoke "X"? It is referenced by N PKI-encrypted document(s), but each still has another active holder who can open it.`

#### Unsafe dependency

Do **not** show the normal confirm.
Show error/alert text:

`You cannot revoke "X" yet. It is the sole active unlock key for N PKI-encrypted document(s). Add or replace another holder first.`

Optionally include first 3 document titles in the message if the existing modal
format tolerates it. If not, counts only are fine for the first slice.

### Chunk 6: Preserve server as final authority

Even if UI preflight says safe:
- still handle `409` from the DELETE request
- show returned server error text

This protects against:
- race conditions
- stale client state
- future alternate clients

---

## Tests to add

### `test/pki.test.js`

Add unit/integration coverage for `getKeyDependencySummary()`:

1. key with no PKI docs → zero counts
2. key referenced by doc with alternate active holder → `alternate_holders_available`
3. key referenced by doc as sole active holder → `sole_active_holder`
4. doc where all holders are revoked → `all_holders_revoked`
5. doc with malformed/missing holder metadata → `holder_metadata_inconsistent`

### `test/webauthn-api.test.js`

Extend revoke route tests:

1. owner can revoke unused key
2. owner cannot revoke key if it is sole active holder for a PKI doc
3. `409` payload includes code + affected documents
4. owner cannot revoke key if dependency analysis finds
   `holder_metadata_inconsistent`

### New API coverage in `test/documents-api.test.js` or a new `test/pki-api.test.js`

Add:

1. `GET /api/members/:id/keys/:keyId/dependencies` returns summary for owner
2. other member cannot inspect dependencies

### UI/manual checks

1. revoke unused key → confirm + success
2. revoke safe key → stronger confirm + success
3. revoke sole-holder key → blocked before confirm/delete
4. race case simulated by server `409` still shows correct error
5. malformed/inconsistent holder metadata → revoke blocked fail-safe

---

## Suggested file-level diff map

### Required

- `lib/pki.js`
  - add `getKeyDependencySummary`
  - export it

- `server.js`
  - add `GET /api/members/:id/keys/:keyId/dependencies`
  - harden `DELETE /api/members/:id/keys/:keyId`

- `public/settings.js`
  - add dependency preflight fetch
  - replace revoke copy / branch behavior
  - handle `409 PKI_KEY_SOLE_ACTIVE_HOLDER`

- `test/pki.test.js`
  - dependency-summary coverage

- `test/webauthn-api.test.js`
  - revoke blocking coverage

### Optional in same pass

- `docs/security-capabilities.md`
  - add note after implementation that revoke now blocks sole-holder cases

---

## Risks and how to contain them

### Risk 1 — Dependency scan overcounts when multiple file entries exist

Mitigation:
- for first slice, classify based on the primary upload entry only, matching
  current shipped PKI assumptions
- if multi-file PKI becomes real later, revisit the helper

### Risk 2 — False-negative dependency analysis due to malformed metadata

Mitigation:
- classify malformed cases as `holder_metadata_inconsistent`
- fail safe in revoke path if target key appears but healthy holder state
  cannot be computed confidently

### Risk 3 — Scope creep into H3/H4

Mitigation:
- do not add revoked-key listing changes
- do not implement holder replace/remove now
- keep this slice limited to active-key revoke safety

---

## Recommended first execution order

1. implement `getKeyDependencySummary()` in `lib/pki.js`
2. add tests for summary helper
3. add dependency route
4. harden DELETE revoke route with `409` guard + audit event
5. add settings preflight UX
6. run focused tests

---

## Acceptance criteria

This slice is complete when:

1. the key owner can inspect dependency summary for an active key
2. revoke is blocked server-side if the key is the sole active holder for any PKI doc
3. settings warns accurately before safe revokes
4. settings blocks unsafe revokes with clear next-step guidance
5. tests cover both helper logic and revoke-route conflict behavior

---

## Recommendation

Build this as a single branch-sized slice.

It is small enough to ship together and large enough to materially reduce the
highest current PKI operational risk without dragging H3/H4 complexity into the
same review.
