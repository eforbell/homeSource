# Feature #11 Phase 1: Member Keys + Single-Owner PKI Encryption

Date: 2026-05-22
Status: Draft implementation plan
Depends on: Threat model (attested), crypto research (complete)
Scope: D8-B — member key registration, single-owner document wrapping

---

## Goal

A family member can register an encryption keypair protected by a hardware
security key (FIDO2 + PRF) or passphrase fallback. Documents can be encrypted
to a single owner's public key instead of a shared passphrase. The server never
sees plaintext, private keys, or key-derivation secrets.

This phase validates the key lifecycle and crypto pipeline before multi-holder
wrapping (Phase 2) and Shamir quorum (Phase 3) build on top.

---

## What ships

1. Member encryption key registration (FIDO2 PRF + passphrase fallback)
2. Key management UI in Settings (view, revoke, recovery code generation)
3. Document encryption mode `pki` on upload
4. Document unlock via member key on document view
5. Key fingerprint verification (D1-C integrity checks)
6. Audit logging for all key lifecycle events (D6-B)
7. Backward compatibility — existing passphrase-encrypted docs unchanged

## What does NOT ship (deferred to Phase 2/3)

- Multi-holder wrapping (wrapping DEK to multiple members' keys)
- Shamir secret sharing / quorum policies
- Beneficiary management for encrypted documents
- Async quorum ceremonies
- Key rotation / re-wrapping batch operations

---

## Delivery chunks

### Chunk 1: Schema + server foundation

**Goal**: Database ready, encryption-mode validation extended, API skeleton.

#### 1a. Schema migration

New migration `008-pki-encryption-mode.sql`:

```sql
-- Add 'pki' to encryption_mode
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_encryption_mode_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_encryption_mode_check CHECK (
    encryption_mode IN ('plaintext', 'passphrase', 'timelock', 'pki')
  );

-- Extend encryption_keys for WebAuthn credential tracking
ALTER TABLE encryption_keys
  ADD COLUMN IF NOT EXISTS member_id INT REFERENCES family_members(id),
  ADD COLUMN IF NOT EXISTS credential_id TEXT,
  ADD COLUMN IF NOT EXISTS prf_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS key_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS protection_tier TEXT NOT NULL DEFAULT 'passphrase'
    CHECK (protection_tier IN ('hardware', 'platform', 'passphrase')),
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
```

Schema notes:
- `member_id` on `encryption_keys` links member keypairs directly (avoids
  requiring a `key_holders` join for basic lookups; `key_holders` remains for
  Phase 2/3 document-level share mappings)
- `credential_id` stores the WebAuthn credential ID (base64url) for PRF
  retrieval during authentication
- `protection_tier` implements D7-B (distinguish hardware vs platform vs passphrase)
- `key_fingerprint` is SHA-256 of the public key, hex-encoded, for D1-C
  integrity verification
- `label` is user-friendly name ("Eric's YubiKey", "Backup iCloud Passkey")
- `last_used_at` updated on each successful unwrap operation

#### 1b. Server-side validation

Update `lib/encryption-mode.js`:
- Add `'pki'` to `ENCRYPTION_MODES` set
- Validate PKI envelope structure: `version: 1`, `mode: 'pki'`,
  `files.*.wrapped_dek.kind: 'pki_x25519'`, `holders[]` array present
- Validate `encryption_key_id` is set and references a valid, non-revoked key

New `lib/pki.js`:
- `listMemberKeys(memberId)` — returns registered keys with metadata
- `getMemberKey(keyId)` — single key lookup with member ownership check
- `registerMemberKey({ memberId, publicKey, encryptedPrivateKey, ... })` — persist keypair
- `revokeMemberKey(keyId, actorId)` — set `revoked_at`, audit log
- `getDocumentKeyInfo(documentId)` — returns key/holder info for PKI-encrypted doc

#### 1c. API routes

New routes in `server.js` (all require `requireAuth`):

```
POST   /api/members/:id/keys          — register new encryption keypair
GET    /api/members/:id/keys          — list member's registered keys
DELETE /api/members/:id/keys/:keyId   — revoke a key
POST   /api/members/:id/keys/:keyId/verify-fingerprint — verify key fingerprint (D1-C)
```

Permission model:
- Parents can manage their own keys and view kids' key status
- Kids can register/manage their own keys (with parent oversight via audit)
- Only parents can revoke another member's key

#### 1d. Audit events

New audit actions:
- `key.registered` — member registered an encryption keypair
- `key.revoked` — a key was revoked
- `key.used` — a key was used to unlock a document (client reports back)
- `document.encrypted.pki` — document encrypted with PKI mode

All logged with `entity_type: 'encryption_key'` and member details.

**Tests for Chunk 1:**
- `test/pki.test.js` — unit tests for key CRUD, validation, fingerprint generation
- `test/encryption-mode.test.js` — extend existing tests for `pki` mode validation

---

### Chunk 2: Client-side crypto module

**Goal**: Reusable browser-side crypto for key generation, wrapping, and ECDH.

#### 2a. New file: `public/pki-crypto.js`

Shared module imported by both upload and document pages. Contains:

```javascript
// ── Key generation ──
async function generateMemberKeypair()
  // crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  // Export public key as raw bytes
  // Export private key as PKCS8
  // Returns { publicKey: CryptoKey, privateKey: CryptoKey,
  //           publicKeyRaw: Uint8Array, privateKeyPkcs8: Uint8Array }

// ── Key fingerprint ──
async function computeKeyFingerprint(publicKeyRaw)
  // SHA-256 of raw public key bytes → hex string
  // Format: "a1b2:c3d4:e5f6:..." (colon-separated 4-char groups for display)

// ── PRF-based key protection ──
async function deriveKekFromPrf(prfOutput)
  // Import PRF output as HKDF key material
  // HKDF-SHA256(prfOutput, salt=zeros(32), info="homesource-member-kek-v1")
  // Derive AES-KW 256-bit key
  // Returns CryptoKey for wrapKey/unwrapKey

// ── Passphrase-based key protection (fallback) ──
async function deriveKekFromPassphrase(passphrase, salt)
  // Argon2id(passphrase, salt) → 256-bit key → import as AES-KW
  // Returns { kek: CryptoKey, salt: Uint8Array }

// ── Private key wrapping ──
async function wrapPrivateKey(privateKeyPkcs8, kek)
  // crypto.subtle.wrapKey('pkcs8', privateKey, kek, 'AES-KW')
  // Returns Uint8Array (wrapped private key)

async function unwrapPrivateKey(wrappedKey, kek)
  // crypto.subtle.unwrapKey('pkcs8', wrappedKey, kek, 'AES-KW',
  //   { name: 'X25519' }, false, ['deriveBits'])
  // Returns CryptoKey (usable for ECDH)

// ── Document DEK wrapping (single-owner) ──
async function wrapDekForOwner(dek, ownerPublicKey, ephemeralPrivateKey)
  // 1. ECDH: deriveBits(ephemeralPrivate, ownerPublic) → shared secret
  // 2. HKDF-SHA256(shared, salt, info="homesource-dek-wrap-v1") → wrapping key
  // 3. AES-KW: wrapKey(dek, wrappingKey) → wrapped DEK
  // 4. Return { wrappedDek, ephemeralPublicKey, salt }

async function unwrapDekAsOwner(wrappedDek, ephemeralPublicKey, salt, ownerPrivateKey)
  // 1. ECDH: deriveBits(ownerPrivate, ephemeralPublic) → shared secret
  // 2. HKDF-SHA256(shared, salt, info="homesource-dek-wrap-v1") → wrapping key
  // 3. AES-KW: unwrapKey(wrappedDek, wrappingKey) → DEK
  // Returns CryptoKey (AES-256-GCM DEK)

// ── Recovery code generation ──
async function generateRecoveryCode()
  // 20 random bytes → base32 encoding → formatted with dashes
  // "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789"
  // Returns { code: string, raw: Uint8Array }

async function deriveKekFromRecoveryCode(code)
  // Decode base32 → raw bytes → HKDF → AES-KW key
```

Design notes:
- Ephemeral keypair pattern for document wrapping: each encrypt generates a
  one-time X25519 keypair. The ephemeral public key is stored in the envelope
  metadata alongside the wrapped DEK. This avoids the need for ECDH between
  the owner and themselves (which is degenerate for X25519), and matches the
  ECIES pattern used in standards like HPKE.
- All functions are pure — no DOM interaction, no server calls. This makes
  them testable in Node.js with a Web Crypto polyfill.

#### 2b. PKI envelope metadata schema (v1)

```json
{
  "version": 1,
  "mode": "pki",
  "policy": {
    "plaintext_metadata": "minimal",
    "server_plaintext_processing": false
  },
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
          "key_fingerprint": "a1b2c3d4:e5f6...",
          "role": "owner"
        }
      ],
      "encrypted_file_meta": {
        "iv_b64": "...",
        "ciphertext_b64": "..."
      }
    }
  }
}
```

Phase 1 simplification: `holders[]` always has exactly one entry with
`role: "owner"`. The structure is ready for Phase 2 (multiple holders)
without schema versioning — just more entries in the array.

**Tests for Chunk 2:**
- `test/pki-crypto.test.js` — comprehensive tests using Node.js Web Crypto:
  - Keypair generation and export/import round-trip
  - Key fingerprint determinism
  - PRF-derived KEK wraps/unwraps private key correctly
  - Passphrase-derived KEK wraps/unwraps private key correctly
  - Document DEK wrap/unwrap round-trip via ECDH + AES-KW
  - Wrong KEK fails unwrap with OperationError
  - Wrong ephemeral key fails DEK unwrap
  - Recovery code generation, encoding, and KEK derivation round-trip
  - Cross-verify: wrap with PRF KEK, unwrap with same PRF output succeeds
  - Cross-verify: wrap with passphrase KEK, unwrap with wrong passphrase fails

---

### Chunk 3: Key registration ceremony UI

**Goal**: Family members can register encryption keypairs from the Settings page.

#### 3a. Settings page extension

Add new section to `public/settings.html` after "Household Members":

**"Encryption Keys"** card:
- Shows each member with their registered keys (if any)
- Each key shows: label, protection tier badge ("YubiKey" / "iCloud Passkey" /
  "Passphrase"), fingerprint (truncated), created date, last used
- "Register Key" button per member → opens registration wizard modal

#### 3b. Registration wizard modal

Step-by-step flow (not a form dump):

**Step 1: Choose protection method**
- "Hardware Security Key (recommended)" — brief explanation, shows YubiKey illustration
- "Passkey (iCloud / Google)" — brief explanation, notes cloud-synced
- "Passphrase" — brief explanation, notes weaker

**Step 2: Create credential** (hardware / passkey path)
- Calls `navigator.credentials.create()` with PRF extension
- Checks `getClientExtensionResults().prf.enabled`
- If PRF not enabled: warn and offer passphrase fallback
- Detects attestation for hardware-bound vs platform-synced (D7-B)
- Prompts: "Tap your security key" or "Authenticate with your device"

**Step 2 alt: Enter passphrase** (passphrase path)
- Passphrase input with strength meter (reuse from upload form)
- Confirm passphrase
- Argon2id derivation → KEK

**Step 3: Generate encryption keypair**
- Generate X25519 keypair (client-side)
- Derive KEK from PRF output (or passphrase)
- Wrap private key with AES-KW
- Display key fingerprint: "Your key fingerprint is `a1b2:c3d4:e5f6:...`"
- Prompt: "Write this down or screenshot it. You'll verify it later."

**Step 4: Save and verify**
- POST public key + wrapped private key + metadata to server
- Server stores in `encryption_keys` table, returns key ID
- Client verifies: GET key back from server, recompute fingerprint, compare
  (D1-C integrity check — catches server tampering)
- Show green checkmark: "Key registered and verified"

**Step 5: Recovery code (optional but encouraged)**
- "Generate a recovery code for this key?"
- Generate recovery code, derive KEK, create additional wrap of private key
- Display code once: "Write this down and store it somewhere safe (bank
  lockbox, fireproof safe). This code can unlock your key if your hardware
  key is lost."
- Store recovery-wrapped private key alongside PRF-wrapped version
- Checkbox: "I have written down my recovery code"

**Step 6: Label your key**
- "Give this key a name (e.g., 'Blue YubiKey', 'Backup iCloud')"
- Save label

#### 3c. Key management actions

In the key list for each registered key:
- **"Verify Fingerprint"** — recompute and compare with server-stored value
- **"Revoke Key"** — confirmation modal with warning about affected documents
  (Phase 1: no documents are affected since single-owner, but the flow must
  exist for Phase 2+ where revocation triggers re-wrapping)
- **"Generate Recovery Code"** — if none exists yet, same flow as Step 5

#### 3d. Proactive notifications (D6-B)

When a key is registered or revoked:
- Toast notification for the acting user
- Dashboard card for other parent-role members: "Eric registered a new
  hardware key on May 22, 2026"
- Logged in audit trail with full details

**Tests for Chunk 3:**
- Manual browser testing — ceremony flow, error states, edge cases
- Verify fingerprint check catches server-altered public key
- Verify PRF fallback to passphrase when authenticator lacks support

---

### Chunk 4: PKI document encryption on upload

**Goal**: Upload form offers PKI encryption using the member's registered key.

#### 4a. Upload form changes

Extend the encryption section in `public/upload.html`:

When encryption is enabled, show mode selector:
- **"Passphrase"** — existing flow (unchanged)
- **"Your Key"** — PKI mode (requires registered key)

When "Your Key" is selected:
- Show which key will be used (label + fingerprint truncated)
- If member has no registered key: "You need to register an encryption key
  first. Go to Settings → Encryption Keys."
- If member has multiple keys: use the most recently used non-revoked key
  (or let them pick)
- No passphrase input needed — authentication happens via FIDO2 tap or
  stored credential

#### 4b. PKI encryption flow (client-side)

When submitting with PKI mode:

```
1. Authenticate with FIDO2 key → get PRF output
   (or: use passphrase-derived KEK if passphrase-tier key)
2. Derive member KEK from PRF output (HKDF)
3. Unwrap member's private key (AES-KW)
4. Generate random DEK (AES-256-GCM)
5. Encrypt document with DEK
6. Generate ephemeral X25519 keypair
7. ECDH(ephemeral_private, owner_public) → shared secret
8. HKDF(shared_secret) → wrapping key
9. AES-KW: wrap DEK with wrapping key
10. Build PKI envelope metadata (see Chunk 2 schema)
11. Upload ciphertext + envelope to server
```

#### 4c. Server-side handling

Upload handler in `server.js`:
- Accept `encryption_mode: 'pki'` with `encryption_metadata` envelope
- Validate envelope structure via updated `encryption-mode.js`
- Set `encryption_key_id` to the member's key ID (from `holders[0]`)
- Persist document with ciphertext file and metadata
- Same feature restrictions as passphrase mode: no MagicIndex, no shares,
  no thumbnails

**Tests for Chunk 4:**
- End-to-end: register key → encrypt doc → verify stored ciphertext
- Verify server rejects malformed PKI envelope
- Verify MagicIndex/share/thumbnail restrictions apply to PKI-encrypted docs

---

### Chunk 5: PKI document unlock on view

**Goal**: Document view page detects PKI-encrypted docs and presents key-based
unlock flow.

#### 5a. Document view changes

Update `public/document.html`:

When loading a PKI-encrypted document:
- Show locked state (similar to passphrase mode)
- Instead of passphrase input, show: "Unlock with your key"
- Display which key is needed (from `holders[0].key_fingerprint`)
- "Unlock" button triggers FIDO2 authentication (or passphrase prompt
  for passphrase-tier keys)

#### 5b. PKI unlock flow (client-side)

```
1. Read encryption_metadata from document API response
2. Identify holder: holders[0] (single-owner in Phase 1)
3. Verify current user is the holder (member_id match)
4. Authenticate with FIDO2 key → get PRF output
   (or: prompt for passphrase if passphrase-tier key)
5. Derive member KEK from PRF output (HKDF)
6. Fetch member's wrapped private key from server
7. AES-KW: unwrap private key with member KEK
8. Read ephemeral_public_key from envelope
9. ECDH(owner_private, ephemeral_public) → shared secret
10. HKDF(shared_secret, salt) → wrapping key
11. AES-KW: unwrap DEK
12. AES-256-GCM: decrypt document
13. Render decrypted document in browser
14. POST audit event: key.used
```

#### 5c. Error states

- **Wrong key**: AES-KW unwrap throws `OperationError` → "This key cannot
  unlock this document. Check that you're using the correct key."
- **Revoked key**: Server returns revocation status → "This key has been
  revoked. Contact the vault administrator."
- **Not a holder**: member_id mismatch → "You are not authorized to unlock
  this document."
- **FIDO2 cancelled**: User cancelled the browser credential prompt →
  "Authentication was cancelled. Try again when ready."

**Tests for Chunk 5:**
- Encrypt with PKI → unlock with same key → verify plaintext
- Encrypt with PKI → attempt unlock with wrong member → verify rejection
- Encrypt with PKI → revoke key → verify revocation message
- Verify passphrase-mode docs still unlock with passphrase (regression)

---

### Chunk 6: Backup compatibility + recovery tool

**Goal**: PKI-encrypted documents work correctly in backup/restore and can
be decrypted offline with the recovery tool.

#### 6a. Backup export

PKI-encrypted documents export as ciphertext (same as passphrase mode).
The `encryption_metadata` envelope travels with the document in the backup
manifest. No changes to backup format needed — the metadata is already
JSONB and self-describing.

#### 6b. Recovery tool extension

Update `bin/decrypt-backup-encrypted-doc.js`:
- Accept `--mode pki` flag
- Accept `--private-key <path>` (PEM or raw) for offline decryption
- Accept `--recovery-code <code>` to unwrap private key from recovery wrap
- Read `wrapped_dek.kind: 'pki_x25519'` envelope and perform ECDH + AES-KW
  unwrap → AES-GCM decrypt

This ensures documents are recoverable even if the homeSource server is
permanently lost — the only requirements are the backup archive and either
the private key or a recovery code.

**Tests for Chunk 6:**
- Create backup with PKI-encrypted doc → decrypt with recovery tool
- Verify mixed backup (plaintext + passphrase + PKI docs) exports correctly

---

## Delivery order and dependencies

```
Chunk 1 (Schema + server)
  ↓
Chunk 2 (Crypto module)         ← can develop in parallel with Chunk 1
  ↓
Chunk 3 (Key registration UI)   ← needs Chunks 1 + 2
  ↓
Chunk 4 (PKI encrypt on upload) ← needs Chunks 1 + 2 + 3
  ↓
Chunk 5 (PKI unlock on view)    ← needs Chunks 1 + 2 + 4
  ↓
Chunk 6 (Backup + recovery)     ← needs Chunks 1 + 2, can parallel with 4/5
```

Chunks 1 and 2 can develop simultaneously since one is server/DB and
the other is client-side crypto with no shared code.

---

## Crypto pipeline summary (Phase 1)

```
                    ┌──────────────────────────────────────┐
                    │        KEY REGISTRATION               │
                    │                                      │
  FIDO2 tap ───► PRF output (32 bytes)                    │
                    │                                      │
                    ▼                                      │
              HKDF-SHA256                                  │
              info: "homesource-member-kek-v1"             │
                    │                                      │
                    ▼                                      │
              Member KEK (AES-256)                         │
                    │                                      │
                    ▼                                      │
        ┌─── AES-KW wrap ◄── X25519 private key           │
        │                    (generated client-side)       │
        │                                                  │
        ▼                    X25519 public key ────────────┘
  Wrapped private key            │
  (stored on server)             │
                                 ▼
                          Key fingerprint
                          SHA-256(public key) → hex
                          (stored + displayed for verification)
```

```
                    ┌──────────────────────────────────────┐
                    │        DOCUMENT ENCRYPTION            │
                    │                                      │
  Random DEK ──► AES-256-GCM encrypt(document) ──► ciphertext
  (256-bit)         │
                    │  Ephemeral X25519 keypair (one-time)
                    │       │
                    │       ▼
                    │  ECDH(ephemeral_priv, owner_pub) → shared secret
                    │       │
                    │       ▼
                    │  HKDF-SHA256(shared, salt,
                    │    info: "homesource-dek-wrap-v1")
                    │       │
                    │       ▼
                    │  AES-KW wrap(DEK) ──► wrapped DEK
                    │
                    ▼
              Envelope metadata:
                wrapped_dek_b64
                ephemeral_public_key_b64
                hkdf_salt_b64
                holders: [{ member_id, key_fingerprint, role: "owner" }]
```

```
                    ┌──────────────────────────────────────┐
                    │        DOCUMENT DECRYPTION            │
                    │                                      │
  FIDO2 tap ───► PRF ───► HKDF ───► Member KEK            │
                                        │                  │
                                        ▼                  │
                              AES-KW unwrap               │
                              (wrapped private key)        │
                                        │                  │
                                        ▼                  │
                              Owner private key            │
                                        │                  │
                    ephemeral_pub ──►  ECDH                │
                                        │                  │
                                        ▼                  │
                              HKDF ───► wrapping key       │
                                        │                  │
                                        ▼                  │
                              AES-KW unwrap(wrapped DEK)   │
                                        │                  │
                                        ▼                  │
                              DEK ───► AES-GCM decrypt     │
                                        │                  │
                                        ▼                  │
                                    Plaintext              │
                    └──────────────────────────────────────┘
```

---

## Risk register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Browser drops X25519 support | Cannot generate/use keys | Very low (shipping in all browsers since Feb 2025) | `@noble/curves` fallback; detect at runtime |
| PRF not available on member's device | Cannot register hardware-backed key | Medium (older Windows, Firefox Android) | Passphrase fallback always available; detect `enabled` at create-time |
| Member loses hardware key + recovery code | Cannot decrypt their documents | Medium | D4-D: backup key, recovery code, quorum re-registration (Phase 3). Phase 1: strongly encourage recovery code during registration |
| Bug in ECDH/HKDF/AES-KW pipeline | Documents permanently locked | Low (using native Web Crypto for all ops) | Exhaustive crypto round-trip tests; test with known vectors; verify decrypt immediately after encrypt before discarding plaintext |
| Envelope metadata schema needs v2 for Phase 2 | Migration complexity | Low (schema is extensible) | `holders[]` array is already designed for multiple entries; `version: 1` stays |
| User encrypts doc with PKI, then revokes their only key | Document inaccessible | Medium | Warn at revocation time; block revocation if documents would become inaccessible; recovery code as last resort |

---

## Testing strategy

### Unit tests (Node.js, `node:test`)
- `test/pki-crypto.test.js` — all crypto operations round-trip
- `test/pki.test.js` — key CRUD, validation, fingerprint
- `test/encryption-mode.test.js` — extend for `pki` mode

### Integration tests (require database)
- Key registration API → DB persistence → retrieval
- Document upload with PKI encryption → stored ciphertext → metadata shape
- PKI-encrypted doc blocks share/MagicIndex/file-add (same as passphrase)

### Browser tests (manual, documented checklist)
- [ ] Register hardware key (YubiKey) — full ceremony
- [ ] Register iCloud passkey — verify tier label shows "cloud-synced"
- [ ] Register passphrase-protected key — verify strength meter appears
- [ ] Fingerprint verification — server returns correct fingerprint
- [ ] Upload document with PKI encryption — verify ciphertext stored
- [ ] Unlock PKI document — tap key, verify plaintext renders
- [ ] Attempt unlock with wrong member session — verify rejection
- [ ] Revoke key — verify audit log entry
- [ ] Recovery code — generate, use to unwrap private key
- [ ] Passphrase-encrypted doc still works — regression check
- [ ] Plaintext doc still works — regression check
- [ ] Backup export with PKI doc — verify in archive
- [ ] Recovery tool decrypts PKI doc from backup

---

## Open items before implementation starts

1. **WebAuthn server library**: Need a lightweight library for WebAuthn
   registration/authentication verification on the server side. Options:
   - `@simplewebauthn/server` (npm) — well-maintained, TypeScript,
     handles attestation parsing and assertion verification
   - `fido2-lib` — lower-level, more control
   - Evaluate and decide before Chunk 1 begins

2. **X25519 in Node.js for tests**: Node.js 20+ supports X25519 via
   `crypto.subtle` (Web Crypto) and `crypto.generateKeyPairSync('x25519')`.
   Verify test compatibility with the homeSource Node version.

3. **Ephemeral keypair vs self-ECDH**: The plan uses an ephemeral keypair
   pattern (ECIES-like) for document wrapping. This avoids the degenerate
   `ECDH(owner_priv, owner_pub)` case and matches standard practice.
   Confirm this is the right approach before Chunk 2 implementation.

4. **Recovery code format**: Base32 with dashes (Crockford encoding?
   BIP39 wordlist? Raw hex?). Decide UX before Chunk 3.
