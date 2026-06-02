# Home Source — Security & Vaulting Capabilities

Last updated: 2026-06-02
Status: Living document — reflects shipped implementation, not planned work

This document inventories the security, encryption, and access control
capabilities currently shipped in Home Source. For planned hardening work,
see [feature-11-pki-hardening-plan.md](../planning/features/feature-11-pki-hardening-plan.md).

---

## 1. Authentication

| Aspect | Implementation |
|---|---|
| Passphrase hashing | scrypt (16-byte salt, 64-byte key) |
| Comparison | crypto.timingSafeEqual |
| Session tokens | UUID, HttpOnly cookie (`hs_session`), 30-day TTL |
| Role model | `parent` (full CRUD) / `kid` (read-only own/shared docs) |
| Onboarding | First-run redirects to `/setup`; no default credentials |

**Source**: `lib/auth.js`, `server.js` session middleware

---

## 2. PKI Document Encryption

### 2.1 Algorithms

| Purpose | Algorithm | Notes |
|---|---|---|
| Key agreement | X25519 ECDH | Web Crypto native |
| Key wrapping | AES-KW (RFC 3394) | Nonce-free, intrinsic integrity check |
| Data encryption | AES-256-GCM | Random DEK per document, random IV per file |
| KEK derivation (hardware) | WebAuthn PRF extension | Deterministic 32-byte output from FIDO2 credential + salt |
| KEK derivation (passphrase) | PBKDF2-SHA256 (600k iterations) | Web Crypto native; Argon2id preferred long-term |
| Recovery key derivation | BIP39 mnemonic → PBKDF2 KEK | 12-word mnemonic, SHA-256 checksum validated |
| Fingerprinting | SHA-256 of public key | Colon-delimited hex (e.g., `1a2b:3c4d:...`) |

**Source**: `public/pki-crypto.js`, `lib/pki.js:7-11`

### 2.2 Envelope structure

The canonical source of PKI authorization is the per-document JSONB envelope
stored in `documents.encryption_metadata`. Each encrypted document carries:

```
encryption_metadata
  version: 1
  mode: "pki"
  policy:
    access_model: "any_one_holder"
    threshold: 1
  files:
    upload:
      iv_b64: <base64>
      tag_length_bits: 128
      holders:
        - encryption_key_id: 42
          member_id: 1
          role: "owner"
          key_fingerprint: "1a2b:3c4d:..."
          wrapped_dek:
            kind: "pki_x25519"
            ephemeral_public_key_b64: <base64>
            hkdf_salt_b64: <base64>
            wrapped_dek_b64: <base64>
        - encryption_key_id: 55
          member_id: 1
          role: "backup"
          ...
```

The `documents.encryption_key_id` column is a compatibility pointer only.
The `key_holders` table exists in schema but is unused by shipped PKI code —
it is reserved as a forward placeholder for estate-planning relational model.

**Source**: `public/pki-crypto.js:296-344`, `lib/documents.js:226-248`

### 2.3 Encryption modes

| Mode | Description |
|---|---|
| `plaintext` | No encryption (default) |
| `passphrase` | Passphrase-derived KEK wraps DEK (PBKDF2 or Argon2id) |
| `pki` | Member key(s) wrap DEK via X25519 ECIES |
| `timelock` | Reserved in schema, not implemented |

**Source**: `lib/encryption-mode.js:3`

### 2.4 Per-file wrapping flow (PKI mode)

1. Client generates a random 256-bit DEK
2. Client encrypts file bytes with AES-256-GCM using the DEK
3. For each designated holder:
   a. Client generates an ephemeral X25519 keypair
   b. ECDH shared secret derived from ephemeral private key + holder's public key
   c. HKDF derives a wrapping key from the shared secret
   d. AES-KW wraps the DEK with the wrapping key
   e. Ephemeral public key + wrapped DEK stored in the holder entry
4. Envelope (holders + IV + tag) stored in `documents.encryption_metadata`
5. Encrypted file bytes written to disk; server never sees the DEK

**Source**: `public/pki-crypto.js:125-147` (wrapping), `public/pki-crypto.js:296-344` (envelope)

---

## 3. Key Lifecycle

### 3.1 Registration ceremony

Key registration is a multi-step WebAuthn ceremony:

1. Server generates registration options with PRF salt (`lib/webauthn.js:81-134`)
2. Client completes WebAuthn registration with the authenticator
3. Server verifies credential and issues assertion challenge (`lib/webauthn.js:161-252`)
4. Client completes assertion (proves possession of private credential)
5. Client generates X25519 keypair (`public/pki-crypto.js:60-70`)
6. Client wraps private key with PRF-derived or passphrase-derived KEK
7. Server stores public key + encrypted private key + credential metadata (`lib/pki.js:61-112`)

Each registration generates a **new X25519 keypair** regardless of the
physical authenticator. The same YubiKey registered twice produces two
independent cryptographic identities.

### 3.2 Key protection tiers

| Tier | Authenticator | PRF | KEK source |
|---|---|---|---|
| `hardware` | Security key (YubiKey, etc.) | Yes (if supported) | PRF output |
| `platform` | Passkey (1Password, iCloud, etc.) | Varies | PRF or passphrase |
| `passphrase` | None (software-only) | No | PBKDF2 from passphrase |

Protection tier and backed-up status are derived from WebAuthn credential
metadata at registration time.

**Source**: `lib/webauthn.js:73-78, 194-199`

### 3.3 Verification

Keys are marked verified (`credential_verified = true`) after successful
WebAuthn assertion. Verification method tracked: `webauthn`, `passphrase`,
or `manual`.

**Source**: `lib/pki.js` registration return fields, `lib/webauthn.js` finalize flow

### 3.4 Recovery

Optional BIP39 mnemonic (12-word) wraps the member private key into a
`recovery_wrapped_private_key` blob stored alongside the key. Recovery type
is tracked as `mnemonic_bip39`.

Recovery enables offline decryption via `bin/decrypt-backup-encrypted-doc.js`
using the mnemonic words and a backup archive — no running server required.

**Source**: `lib/pki.js:224-238`, `public/pki-crypto.js:233-292`

### 3.5 Revocation

Logical disablement only — sets `encryption_keys.revoked_at` timestamp.

Effects:
- Revoked keys are excluded from new PKI uploads (`lib/pki.js:296-298`)
- Server refuses to serve key material for revoked keys (`lib/pki.js:45-59`)
- Client-side unlock filters out revoked holders (`public/document.html:553-564`)

Does **not**:
- Rewrite existing document envelopes
- Remove holder references from documents
- Check whether affected documents would become stranded
- Allow recovery of the revoked key's material through the normal app/API path

**Known limitation**: Revocation of a sole active holder strands any encrypted
documents referencing that key in the normal application flow. Re-enrolling the
same physical authenticator does not restore access because a new keypair is
generated. Offline break-glass recovery may still be possible if exported key
material and recovery words were retained. Hardening work (H1/H2) will add
dependency analysis and revoke guards.

**Source**: `lib/pki.js:115-131`, `server.js:587-598`

---

## 4. Multi-Holder PKI

### 4.1 Access model

1-of-M: any single holder with an active (non-revoked) key can decrypt
independently. No threshold or quorum required in the current implementation.

### 4.2 Holder roles

| Role | Scope | Authorization |
|---|---|---|
| `owner` | Primary holder, same member as uploader | Automatic on PKI upload |
| `backup` | Same member, different key | Self-service via add-holder flow |
| `beneficiary` | Different member | Parent-only authorization required |

### 4.3 Supported mutations

| Operation | Route | Status |
|---|---|---|
| Add holder (backup or beneficiary) | `POST /api/documents/:id/pki-holders/add` | Shipped |
| Remove holder | — | Not implemented |
| Replace holder | — | Not implemented |

Add-holder requires live proof: the acting holder must unwrap the existing
DEK with their active key, then re-wrap to the new holder's public key.
Legacy Phase 1 envelopes (top-level `wrapped_dek`) are normalized to
Phase 2A holder-local format on first mutation.

### 4.4 Validation rules

- No duplicate key IDs per file
- Multi-holder uploads require holder-local wrapped DEK (`kind: "pki_x25519"`)
- Cross-member backup holders forbidden (backup must be same member)
- Beneficiary holders must reference a different member than the owner
- Cross-member holders require parent authorization

**Source**: `lib/pki.js:271-335`, `server.js:849-950`

---

## 5. Backup & Recovery

### 5.1 Backup encryption

Backup archives are optionally encrypted using a separate mechanism from PKI:

| Aspect | Implementation |
|---|---|
| KDF | scrypt (N=2^16, r=8, p=1, maxmem 128 MiB) |
| Cipher | AES-256-GCM |
| Format | Version 1 header + salt(32) + iv(12) + tag(16) + ciphertext |

Backup encryption is independent of document-level PKI encryption. An
encrypted backup may contain both plaintext and PKI-encrypted documents.
PKI-encrypted document files are stored as ciphertext in the backup.

**Source**: `lib/backup.js:104-119`

### 5.2 Backup contents

- `manifest.json` — metadata, checksums, backup timestamp
- `database.json` — full table export (documents, encryption_keys, audit_log, etc.)
- `documents/` — stored files (plaintext or ciphertext as uploaded)
- `thumbnails/` — optional, regenerable

### 5.3 Offline document recovery

`bin/decrypt-backup-encrypted-doc.js` decrypts individual PKI-encrypted
documents from a backup archive using the member's passphrase or recovery
mnemonic. Supports both `passphrase_pbkdf2` and `passphrase_argon2id`
wrapped-key schemes. Operates fully offline.

**Source**: `bin/decrypt-backup-encrypted-doc.js`

### 5.4 Backup posture

Configurable expected frequency (default 30 days). Dashboard shows
green/yellow/red status. All backup attempts logged in `backup_log` table
with status, file size, and error message.

**Source**: `lib/backup.js:121-152`

---

## 6. Access Control

### 6.1 Document ownership

Joint ownership model via `document_owners` table:

| Ownership type | Description |
|---|---|
| `owner` | Primary owner, full control |
| `joint` | Shared ownership |
| `beneficiary` | Designated recipient |
| `custodian` | Holds on behalf of another |

### 6.2 Share links

Token-based document sharing for non-authenticated access:

- 24-byte random token (base64url)
- Optional PIN (hashed with scrypt)
- Configurable expiry and max use count
- Access level: `view` or `download`
- Encrypted documents are excluded from sharing

**Source**: `lib/share.js:8-42`

### 6.3 Parent-only routes

The following **page surfaces** are restricted to parent role by the HTML page
gate:
`/backup.html`, `/import.html`, `/insights.html`

Additional mutation endpoints elsewhere in the app also enforce parent-only or
equivalent elevated access, but they are not represented by the single
`PARENT_ONLY_PAGES` constant.

**Source**: `server.js:146`

---

## 7. Audit Logging

All security-relevant actions are logged to the `audit_log` table with
action, entity type/ID, actor ID, JSONB details, and timestamp.

### Logged events

| Category | Events |
|---|---|
| Auth | `auth.passphrase_changed` |
| Keys | `key.registered`, `key.revoked`, `key.recovery_enabled` |
| Documents | `document.viewed`, `document.updated`, `document.deleted`, `document.archived`, `document.encrypted`, `document.pki_holder_added` |
| Sharing | `share.created` |
| WebAuthn | `webauthn.credential_registered` |

### Not currently logged

- Key material retrieval (`GET /api/members/:id/keys/:keyId/material`)
- Revoke denial attempts (planned for hardening H2)
- Document unlock/decryption attempts (client-side, not observable by server)

**Source**: `lib/audit.js:12-47`, various `server.js` routes

---

## 8. WebAuthn

Full FIDO2/WebAuthn implementation for key registration and assertion:

| Aspect | Implementation |
|---|---|
| Registration | `createMemberKeyRegistrationOptions` → `completeMemberKeyRegistration` |
| Assertion | `createMemberKeyAssertionOptions` → `finalizeMemberKeyRegistration` |
| PRF extension | Salt generated at registration, replayed at assertion |
| Origin validation | Configurable via `WEBAUTHN_ALLOWED_ORIGINS`, `WEBAUTHN_RP_ID` |
| Secure context | HTTPS or localhost only |
| Challenge TTL | 10 minutes, expired challenges auto-cleaned |
| Protection tier | Derived from credential type + backed-up status |

**Source**: `lib/webauthn.js`

---

## 9. Known Limitations & Planned Hardening

These are documented limitations in the current implementation. See
[feature-11-pki-hardening-plan.md](../planning/features/feature-11-pki-hardening-plan.md)
for the remediation plan.

| Limitation | Risk | Planned fix |
|---|---|---|
| No revoke guard — sole active holder can be revoked | Permanent data loss | H2: server-side 409 block |
| No key-to-document dependency visibility | Operator cannot assess revoke impact | H1: dependency summary API |
| Revocation is irreversible (re-enrollment creates new identity) | No undo path | H2: revoke copy fix; open decision on recovery-mode key material access |
| `listMemberKeys` excludes revoked keys | Cannot display revoked keys in UI | H1 prerequisite: `includeRevoked` parameter |
| Recovery wrap inaccessible after revocation | Mnemonic recovery blocked for revoked keys | Open product decision (#5 in hardening plan) |
| No holder removal or replacement | Add-only lifecycle | H4: replace-holder and remove-holder flows |
| Revoke confirmation copy misleading | User not informed of document impact | Immediate: fix `settings.js:290` copy |
| No audit on key material retrieval | Forensic gap | H2: add audit event |
| `key_holders` table exported in backups despite being empty | Restoration confusion | Cleanup: remove from backup export |
| Unlock/decrypt is entirely client-side | Server cannot enforce access denial beyond refusing key material | Architectural — by design for zero-knowledge model |

---

## 10. Architectural Notes

### Server trust model

Honest-but-curious with integrity checks (attested in threat model, decision
D1-C). The server stores encrypted private keys and wrapped DEKs but never
holds plaintext key material or DEKs. All sensitive crypto operations happen
client-side in the browser.

### Envelope-canonical design

The JSONB envelope in `documents.encryption_metadata` is the single source
of truth for PKI authorization. This design:
- Keeps crypto state self-describing and portable (travels with backups)
- Avoids relational sync issues between tables and envelope content
- Is correct for the current use case (operator protecting own documents)

A relational holder model (evolving `key_holders` or a new table) will be
needed for estate-planning surfaces (permission matrix, beneficiary
directory, sealed envelopes) that require cross-document queries. The JSONB
envelope will remain canonical for crypto operations; the relational model
will serve as a projection/index for UX. See the use case context section
in the hardening plan.

### Forward-reserved schema

The `key_holders` table exists in schema with roles `owner, cosigner,
recovery` and an `encrypted_key_share` column. It is intentionally unused
by Phase 1/2A PKI code and reserved for estate-planning phases where
relational holder tracking, polymorphic holder references, sealed state,
and Shamir share storage will be needed.
