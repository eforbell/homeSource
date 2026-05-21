# Feature #5: Encrypted Document Modes (Passphrase First, Timelock Next)

Date: 2026-05-21
Tickets: #91 (foundation), #90 (extension)
Status: Revised after architecture review

## Executive summary

HomeSource will add opt-in encrypted documents with client-side encryption and server-side ciphertext storage.

Delivery order remains:

1. **#91 Passphrase mode** (foundation)
2. **#90 Timelock mode** (extension)

This revision reconciles with existing schema (`encryption_keys`, `key_holders`, `documents.encryption_key_id`) and locks unresolved design decisions.

## Architecture reconciliation with existing schema (locked)

HomeSource currently has envelope/key-holder tables designed for a broader PKI/multi-sig future.

### Decision for v1

- Keep `encryption_keys`, `key_holders`, and `documents.encryption_key_id` **as compatibility/future-use schema**.
- Do **not** drop or repurpose those tables in #91/#90.
- Introduce encrypted-document mode fields alongside existing schema:
  - `documents.encryption_mode` (`plaintext`, `passphrase`, `timelock`)
  - `documents.encryption_metadata` (JSONB)
- For v1 passphrase/timelock docs, `documents.encryption_key_id` remains `NULL`.
- Existing tables remain dormant until a future feature explicitly implements family key-holder workflows.

## Product decisions (locked)

1. **V1 metadata policy: Minimal plaintext**
   - Keep title/type/status/source/date metadata plaintext for list/search usability.
   - Encrypt file bytes and sensitive file-level attributes (original filename, mime details) in encrypted envelope metadata.

2. **V1 encrypted-doc feature policy: Disable + explain**
   - Block server-side plaintext-required features for encrypted docs with explicit UX reason.

3. **Share links policy (v1): Block creation for encrypted docs**
   - `POST /api/documents/:id/share` rejects encrypted docs with stable error shape.

4. **Backup policy: Keep existing backup encryption independent**
   - Encrypted docs remain ciphertext in exports.
   - Optional backup encryption still encrypts the archive as a whole (double encryption is intentional and acceptable).

5. **KDF choice for #91: Argon2id (explicit)**
   - Use Argon2id (WASM) as v1 passphrase KDF for stronger offline resistance.
   - Parameter set is fixed in envelope metadata (versioned), not left to implementation discretion.

6. **Recovery policy for #91: Optional one-time recovery code**
   - At encryption time, user may generate a one-time recovery code.
   - Client uses recovery-code-derived key to create an additional DEK wrap and stores that wrapped DEK in metadata.
   - Server stores only wrapped material; no passphrase/recovery secret storage.

7. **Family access scope for #91: single passphrase + optional recovery code only**
   - Multi-member wrapped-key/key-holder UX is **explicitly deferred**.
   - Existing key-holder schema is preserved for that future feature.

## File/document encryption model (locked)

### Per-file envelope

Encryption is **file-level**. Each persisted encrypted `document_files` row has its own envelope metadata (own IV/nonce; own wrapped content key material according to mode).

### Derivative handling in v1

For encrypted docs:

- No server-generated thumbnail
- No server image-to-PDF conversion
- No server-side processed derivative generation
- No MagicIndex plaintext processing

Result: encrypted docs store only encrypted file entries intended for direct client unlock/use.

## Encrypted envelope metadata schema (v1)

`documents.encryption_metadata` stores document-level mode contract and per-file envelopes.

```json
{
  "version": 1,
  "mode": "passphrase",
  "policy": {
    "plaintext_metadata": "minimal",
    "server_plaintext_processing": false
  },
  "files": {
    "<document_file_id_or_slot>": {
      "cipher": "aes-256-gcm",
      "iv_b64": "...",
      "tag_length_bits": 128,
      "wrapped_dek": {
        "kind": "passphrase_argon2id",
        "salt_b64": "...",
        "argon2id": {
          "memory_kib": 65536,
          "iterations": 3,
          "parallelism": 1,
          "hash_len": 32
        },
        "wrapped_dek_b64": "..."
      },
      "encrypted_file_meta": {
        "original_filename_b64": "...",
        "mime_type_b64": "..."
      },
      "recovery_wrap": {
        "enabled": true,
        "kdf": "argon2id",
        "salt_b64": "...",
        "wrapped_dek_b64": "..."
      }
    }
  }
}
```

For `timelock` mode, `wrapped_dek.kind` becomes `tlock_drand_quicknet` and includes round/network fields.

Schema versioning is mandatory; readers must reject unknown major versions.

## Goals

- Optional encrypted uploads with client-side keying.
- Server never receives passphrase/recovery secret/decrypted file content.
- Deterministic unlock UX for passphrase and timelock modes.
- Backward compatibility for plaintext docs.

## Non-goals (v1)

- Multi-member key-holder unlock UX.
- Server escrow or passphrase recovery service.
- Encrypted-doc share consumption workflow.
- Server-side post-unlock MagicIndex pipeline.

## Ticket #91 scope (foundation)

### Functional

- Add passphrase encryption mode on upload.
- Add optional one-time recovery code wrapping path.
- Persist mode + envelope metadata.
- Locked-state document UX and client-side unlock path.
- Enforce encrypted-doc capability restrictions.

### Cryptographic

- Content encryption: AES-256-GCM.
- KDF: Argon2id (WASM) with versioned parameters in metadata.
- No secret material persistence server-side.

## Ticket #90 scope (timelock extension)

### Functional

- Add `timelock` mode with future timestamp input.
- Map timestamp to drand round.
- Encrypt/wrap DEK via tlock-compatible format.
- Unlock via beacon retrieval after round availability.

### Risk and dependency contract

- Timelock docs are dependent on drand network availability at unlock time.
- Product copy must disclose availability/dependency risk at encryption time.
- If ecosystem viability changes, freeze rollout behind feature flag pending review.

Reference sources for integration validation:
- tlock-js: https://github.com/drand/tlock-js
- tlock (Go reference): https://github.com/drand/tlock
- drand org repositories: https://github.com/drand

## Share/import/backup behavior (v1)

- **Share links**: encrypted docs cannot create new share links.
- **Import batches**: encrypted-mode upload/import is supported only through explicit encrypted upload flow; generic batch import does not auto-encrypt existing plaintext inputs.
- **Backup export**: encrypted file blobs are exported as ciphertext; backup-level encryption remains optional and orthogonal.

## Acceptance criteria

- Encrypted uploads persist ciphertext and validated metadata schema.
- Correct key source unlocks client-side; incorrect/unavailable key source fails safely.
- Encrypted docs block share creation and plaintext-dependent server features.
- Plaintext document flows remain unchanged.
- Existing dormant key-holder schema remains intact and compatible for future extension.
