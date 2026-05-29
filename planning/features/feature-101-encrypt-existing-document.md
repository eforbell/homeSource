# Feature Request #101: Encrypt an Existing Unencrypted Document Record

Date: 2026-05-28
Ticket: bugBase #101
Status: Planned
Depends on: Feature #5 encrypted document modes, Feature #11 Phase 1 PKI vault

## Executive summary

HomeSource already supports encrypting documents during upload, but many existing
vault records were created before encryption shipped or were intentionally added
in plaintext first. Feature request #101 adds an explicit **encrypt in place**
workflow so a user can convert an existing plaintext document into an encrypted
record without recreating the document manually.

This feature is both a user-facing value add and an architectural prerequisite
for later crypto work:

- plaintext → passphrase encryption
- plaintext → PKI encryption
- future passphrase → PKI migration
- future single-holder PKI → multi-holder/quorum re-wrapping

The implementation should therefore establish a durable **document re-encryption
mutation path**, not a one-off UI shortcut.

---

## Product goal

A parent viewing an existing plaintext document can choose **Encrypt Document**,
select either passphrase mode or PKI mode, and have the existing document record
converted to encrypted storage while preserving its identity and household
organization metadata.

The result should feel like "this document became encrypted," not like creating
an unrelated duplicate.

---

## User stories

1. As a parent, I can encrypt an existing plaintext document with a passphrase
   so I do not have to delete and re-upload it manually.
2. As a parent, I can encrypt an existing plaintext document to one of my
   registered PKI keys so legacy vault items can join the PKI workflow.
3. As a parent, I keep the same document id, title, owners, tags, and related
   organization after encryption.
4. As a parent, I am clearly told which features will stop working after the
   document becomes encrypted (server preview, MagicIndex, shares).
5. As a user, I cannot accidentally leave behind the old plaintext file bytes or
   thumbnails after conversion.

---

## Non-goals

- Decrypting an encrypted document back to plaintext in the UI
- Converting one encrypted mode directly into another encrypted mode in this
  first slice (for example passphrase → PKI)
- Batch conversion of many plaintext documents at once
- Encrypting already-encrypted documents again
- Multi-holder PKI selection (deferred to Feature 11 Phase 2A)

---

## Locked product decisions

### 1. Use a dedicated action, not the generic edit endpoint

`PUT /api/documents/:id` currently rejects encryption field mutation. That is
correct and should remain true. This feature should introduce a dedicated
conversion route such as:

`POST /api/documents/:id/encrypt`

This keeps encryption transitions explicit and auditable.

### 2. Preserve the document record identity

The existing `documents.id` remains the same. Do not create a second document
and ask the user to reconcile owners/tags/links manually.

Preserve:
- title
- description
- type
- owners
- tags
- related-document links
- audit continuity
- created_at history

Update:
- `is_encrypted`
- `encryption_mode`
- `encryption_metadata`
- `encryption_key_id` (PKI only)
- `updated_at`

### 3. Plaintext file artifacts must be removed atomically

After conversion completes successfully, the plaintext file blobs and plaintext
thumbnail/derivative artifacts must no longer remain attached to the document.

At minimum remove or replace:
- original plaintext file record
- processed derivative file record(s)
- thumbnail file record(s)

If conversion fails before commit, the original plaintext document must remain
intact.

### 4. Client-side encryption remains mandatory

The browser fetches the plaintext file, encrypts locally, and uploads ciphertext.
The server must never receive plaintext-encryption secrets or perform plaintext
crypto transforms on behalf of the user.

### 5. Feature restrictions must mirror new encrypted uploads

Once converted, the document behaves exactly like a freshly encrypted upload:
- no server-side preview of plaintext
- no MagicIndex
- no share creation
- no add-file path for encrypted documents
- no server-generated thumbnails

### 6. Parent-only mutation

This should follow the same mutation posture as other sensitive document actions:
parents can convert a document to encrypted storage; kids cannot use this route.

---

## UX direction

## Entry point

Add a document-level action on `public/document.html` for plaintext documents:

- **Encrypt Document**

Hide or disable it for already-encrypted documents.

## Modal contents

The modal should explain:

- this converts the current document in place
- file bytes will become encrypted
- server preview / shares / MagicIndex stop working after conversion
- this action should be intentional and may take time for large files

### Mode choices

1. **Passphrase**
2. **Your Key (PKI)**

Use the same conceptual language as upload so the product does not introduce a
second crypto vocabulary.

### PKI scope for #101

For this feature, PKI selection remains **single-holder only**, matching current
Phase 1 behavior:
- one selected key
- one holder
- no multi-holder selection yet

### Suggested warning copy

"Encrypted documents are locked server-side. HomeSource will stop generating
previews, share links, and MagicIndex analysis for this document."

---

## Technical direction

## API shape

Recommended route:

`POST /api/documents/:id/encrypt`

Request body options:
- multipart/form-data with ciphertext file blob + metadata payload, or
- JSON metadata plus separate upload channel

Recommended high-level flow:

1. Load document and verify access
2. Reject if already encrypted
3. Verify acting member is a parent
4. Validate encryption metadata (`passphrase` or `pki`)
5. For PKI, reuse server-side key ownership validation
6. Store ciphertext file as the new canonical `original` file
7. Remove plaintext file/thumbnail/derivative rows and disk blobs
8. Update document encryption fields
9. Audit `document.encrypted.passphrase` or `document.encrypted.pki`
10. Return updated document

## Client flow

On `public/document.html`:

1. fetch current file bytes via existing authorized download route
2. encrypt in browser using existing helpers
3. submit encrypted replacement payload to the new route
4. reload the document detail into locked encrypted state

This will likely justify extracting or expanding shared browser crypto helpers so
upload and encrypt-existing paths do not drift.

---

## Data and file behavior

### Supported first slice

- Single-file documents with one canonical original file
- Existing plaintext uploads and scans where the active file can be identified

### Defer if needed

If legacy multi-file records exist, the first slice may reject them with a clear
message rather than partially encrypting one file and leaving the rest plaintext.

If that deferral is taken, it must be explicit in UI and API errors.

Recommended error shape:
- `409` or `400`
- message: "Encrypting multi-file document records is not supported yet"

---

## Validation and invariants

Server must verify:
- document exists
- actor may mutate the document
- document is not already encrypted
- source file exists
- PKI key belongs to acting member and is not revoked
- ciphertext replacement is stored before plaintext deletion

Client must verify:
- passphrase confirmation matches
- PKI unlock material can be obtained locally
- encryption mode-specific metadata is complete before submission

---

## Tests

### Automated

Add coverage to `test/documents-api.test.js` for:

1. plaintext document can be converted to passphrase mode
2. plaintext document can be converted to PKI mode
3. same document id is preserved
4. owners/tags/metadata remain intact
5. document now reports `is_encrypted = true`
6. share creation is blocked after conversion
7. MagicIndex re-analysis is blocked after conversion
8. kid cannot call encrypt-existing route
9. already-encrypted doc is rejected
10. plaintext file rows are replaced/removed as expected

### Browser/manual

Validate:
- passphrase conversion on an uploaded PDF/image
- PKI conversion using a registered member key
- converted doc reloads into encrypted locked state
- no stale thumbnail/preview remains visible

---

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Plaintext artifacts remain on disk | Silent confidentiality failure | Make file-row + filesystem cleanup part of the conversion transaction/commit discipline |
| Upload and convert crypto logic drift | Different envelopes/unlock behavior | Reuse shared helpers rather than duplicating page-local implementations |
| Multi-file legacy docs complicate conversion | Partial encryption is dangerous and confusing | Start with explicit single-file support and reject ambiguous cases |
| User misunderstands capability loss | Surprise after conversion | Put restrictions directly in modal before confirmation |

---

## Acceptance criteria

- A parent can encrypt an existing plaintext document in place using passphrase mode.
- A parent can encrypt an existing plaintext document in place using current
  single-holder PKI mode.
- The same document record is preserved after conversion.
- Plaintext file artifacts are removed or replaced; encrypted artifacts become
  the only attached file representation.
- Converted docs obey the same restrictions as encrypted uploads.
- Existing encrypted docs and existing plaintext upload flows continue to work
  unchanged.

---

## Why this should ship before Feature 11 Phase 2A

This feature creates the mutation primitive that later crypto features will
reuse for more complex policy changes. It is the smallest realistic way to prove
that HomeSource can safely transition a live record between plaintext and
encrypted storage without breaking the document model.
