# Feature #5 Test Spec: Encrypted Document Modes (#91 -> #90)

Date: 2026-05-21
Status: Revised after architecture review

## Test strategy summary

- API/integration tests for persistence, permissions, feature gating, and compatibility.
- Client crypto tests for encrypt/decrypt correctness and deterministic failure modes.
- Regression matrix for plaintext paths.

Execution order: #91 suite first, #90 additive suite second.

---

## #91 Passphrase mode test cases

### A. Data model + schema compatibility

1. **New mode fields persisted correctly**
   - Encrypted upload sets `is_encrypted=true`, `encryption_mode='passphrase'`, valid `encryption_metadata.version`.

2. **Legacy encryption schema preserved**
   - `encryption_keys`/`key_holders` tables remain present and unmodified by #91 migration.
   - `documents.encryption_key_id` remains `NULL` for #91-created encrypted docs.

### B. Ciphertext and per-file envelope behavior

3. **Ciphertext-at-rest per encrypted file**
   - For each encrypted stored file row, bytes differ from known plaintext and metadata includes per-file envelope.

4. **No plaintext derivatives for encrypted docs**
   - Encrypted upload does not create thumbnail/processed plaintext derivatives.

5. **Plaintext upload unchanged**
   - Non-encrypted uploads preserve current original/processed/thumbnail behaviors.

### C. Unlock/decrypt behavior

6. **Correct passphrase unlock succeeds**
   - Roundtrip decrypt equals original bytes.

7. **Wrong passphrase fails deterministically**
   - Decrypt fails with stable auth error; no output leak.

8. **Corrupt envelope fails safely**
   - Tampered metadata/ciphertext is rejected.

9. **Recovery code path (when enabled)**
   - Recovery code-generated wrap can decrypt successfully.
   - Invalid recovery code fails deterministically.

### D. Capability policy + integrations

10. **Share link creation blocked for encrypted docs**
   - `POST /api/documents/:id/share` returns expected rejection contract.

11. **MagicIndex blocked for encrypted docs**
   - Reanalyze and ingest paths reject encrypted docs with stable error.

12. **Post-unlock server reprocess remains blocked in v1**
   - No client "unlock and upload plaintext for MagicIndex" side path exists.

13. **Batch import behavior explicit**
   - Standard batch import remains plaintext path; no silent encrypted-mode mutation.

### E. Backup behavior

14. **Backup includes ciphertext-as-is for encrypted docs**
   - Exported encrypted document payload remains ciphertext.

15. **Backup encryption remains orthogonal**
   - Encrypted-backup option wraps archive regardless of document mode (double encryption accepted).

### F. Security and audit hygiene

16. **No secret persistence/logging**
   - Passphrase/recovery secret/decrypted bytes absent from DB and logs.

17. **Audit presence without sensitive payload**
   - Events capture action + identifiers only.

---

## #90 Timelock mode test cases

### A. Timelock persistence + mapping

1. **Timestamp -> round mapping is deterministic**
2. **Timelock upload sets `encryption_mode='timelock'` with required round/network metadata**

### B. Unlock behavior

3. **Pre-unlock attempt fails with not-ready state**
4. **Post-round unlock succeeds with mocked beacon material**
5. **drand unavailable is retryable failure (no corruption/false success)**

### C. Compatibility and policy

6. **Passphrase mode unaffected by timelock rollout**
7. **Plaintext mode unaffected**
8. **Share links remain blocked for all encrypted modes**
9. **MagicIndex remains blocked for encrypted modes in v1**

---

## Regression matrix (must pass before release)

- Existing document CRUD, tags, owners, archive/delete
- Existing plaintext preview/download/share behavior
- Existing import flows for plaintext docs
- Existing MagicIndex paths for plaintext docs
- Existing backup flows

---

## Acceptance gates

### #91 release gate

- All #91 tests pass.
- No regressions in existing document/import/share/backup suites.
- Migration verified safe with existing encryption tables intact.

### #90 release gate

- All #90 tests pass.
- #91 suite remains green.
- User-visible messaging for drand dependency and unlock-availability risk is present.
