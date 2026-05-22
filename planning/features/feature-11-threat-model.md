# Feature #11: PKI Document Vault — Threat Model

Date: 2026-05-22
Status: All decisions attested by EF 2026-05-22
Author: Claude (with Eric)

---

## 1. System description

homeSource is a self-hosted family document vault running on a private LAN server.
Documents are stored on local disk. The server is accessed via browser over the LAN
(and potentially via reverse proxy over the internet). Authentication is passphrase-based
with scrypt-hashed sessions.

The PKI feature adds:
- Per-member encryption keypairs (public/private)
- Document encryption with per-document DEKs wrapped to authorized members' public keys
- Quorum policies (M-of-N Shamir Secret Sharing) for high-value documents
- Hardware security key (FIDO2/YubiKey) integration for key protection

## 2. Assets to protect

| Asset | Sensitivity | Notes |
|---|---|---|
| Document plaintext (file bytes) | **Critical** | Financial records, estate plans, bitcoin custody details, identity documents |
| Document metadata (title, type, dates) | Moderate | Reveals document existence and nature; deliberately left plaintext for usability |
| Member private encryption keys | **Critical** | Compromise of a private key = access to all documents wrapped to that key |
| Wrapped DEK shares | High | Useless without corresponding private key, but theft + future key compromise = access |
| Quorum policy structure | Moderate | Reveals who has access and what threshold is required |
| Session tokens / auth state | Moderate | Grants server access but not encrypted document content |
| Server database | High | Contains wrapped key material, quorum policies, metadata |
| Backup archives | High | Contains all of the above in portable form |

---

## 3. Threat actors

### T1: Casual observer / household member without authorization
- **Capability**: Physical access to a device with an active session, or shoulder-surfing
- **Goal**: Read documents they shouldn't (nosy sibling, visitor)
- **Current mitigation**: Session auth, per-member permissions
- **PKI mitigation**: Encrypted documents unreadable without key material

### T2: Compromised server / storage
- **Capability**: Full read access to database and file storage (disk theft, backup leak, server compromise via software vulnerability)
- **Goal**: Extract document contents
- **Current mitigation (passphrase mode)**: Server stores only ciphertext + wrapped keys
- **PKI mitigation**: Same posture — server never sees DEKs or private keys

### T3: Network attacker (MITM)
- **Capability**: Intercept traffic between browser and server
- **Goal**: Steal credentials, session tokens, or document content in transit
- **Mitigation**: TLS (nginx reverse proxy), but LAN-only deployments may use HTTP
- **Note**: Client-side encryption means document plaintext never traverses the network even over HTTP

### T4: Sophisticated attacker targeting key material
- **Capability**: Targeted attack on a specific family member's devices, cloud accounts, or physical security
- **Goal**: Obtain enough key material to decrypt high-value documents
- **PKI mitigation**: Hardware-bound keys (YubiKey) resist remote extraction; quorum requires compromising multiple holders

### T5: Legal/institutional compulsion
- **Capability**: Court orders, subpoenas, government demands directed at cloud providers or family members
- **Goal**: Force disclosure of document contents
- **PKI mitigation**: Hardware keys cannot be remotely compelled (physical possession required); quorum means no single person can comply alone
- **Note**: Platform passkeys (iCloud/Google) are potentially compellable from the provider

### T6: Insider threat — authorized family member acting against policy
- **Capability**: Legitimate access to their own key share and the server
- **Goal**: Access documents beyond their authorization, or deny access to others
- **PKI mitigation**: Quorum prevents unilateral access to threshold-protected docs; audit logging tracks access attempts

### T7: Time-based threat — death or incapacitation of vault owner
- **Capability**: N/A (threat is *absence* of the owner)
- **Goal**: Beneficiaries need to access inheritance documents
- **PKI mitigation**: Quorum allows remaining holders to reconstruct DEK without the owner's participation (if policy allows)
- **Critical design factor**: This is the primary motivating threat

---

## 4. Trust boundaries

```
┌─────────────────────────────────────┐
│         BROWSER (trusted)           │
│  • Key generation                   │
│  • Key unwrapping (PRF/passphrase)  │
│  • DEK unwrapping                   │
│  • Shamir reconstruction            │
│  • Document decrypt/encrypt         │
│  • All plaintext processing         │
├─────────────────────────────────────┤
│         NETWORK (untrusted)         │
│  • Only ciphertext + wrapped keys   │
│  • Session tokens (auth, not crypto)│
├─────────────────────────────────────┤
│         SERVER (semi-trusted)       │
│  • Stores ciphertext                │
│  • Stores wrapped keys/shares       │
│  • Enforces access control (auth)   │
│  • Cannot read document contents    │
│  • Cannot reconstruct DEKs          │
├─────────────────────────────────────┤
│         STORAGE (untrusted at rest) │
│  • Database: metadata + wrapped     │
│  • Files: ciphertext blobs          │
│  • Backups: encrypted archives      │
└─────────────────────────────────────┘
```

---

## 5. Decision points requiring attestation

Each decision below has options with different security/usability trade-offs. These
need explicit owner sign-off before implementation proceeds.

---

### D1: Server trust model

What do we assume about the server?

**Option A: Honest-but-curious**
The server faithfully executes the protocol but may try to read data it stores.
A compromised server can see wrapped keys and metadata but cannot forge client
actions. This is the standard model for client-side encryption apps.

**Option B: Fully compromised server**
The server may be actively malicious — serving tampered JavaScript, lying about
quorum policies, or presenting fake public keys. Defense requires out-of-band
verification of all cryptographic material (key fingerprints verified in person,
code signing, reproducible builds).

**Option C: Honest-but-curious with integrity checks**
Same as A, but with client-side verification of critical server responses (e.g.,
verify public key fingerprints are what was registered, verify quorum policy
hasn't been tampered with). Pragmatic middle ground.

> **Recommendation**: Option C. Full compromise defense (B) is aspirational but
> impractical for a family app — it requires security practices most families
> won't sustain. Option A is too permissive for inheritance-grade security.
> Option C adds lightweight integrity checks that catch server-side tampering
> without requiring a reproducible-build pipeline.

**Attest**: OPTION C - EF 5/22/2026

---

### D2: Member key protection — minimum acceptable tier

What is the minimum way a member can protect their encryption private key?

**Option A: FIDO2 hardware key required (PRF extension)**
Every member must register a hardware security key. Maximum security, but
creates a hard barrier for non-technical family members and requires purchasing
hardware for each participant.

**Option B: Hardware key preferred, passphrase fallback allowed**
Members choose: hardware key (via PRF) or passphrase (via Argon2id). The system
warns that passphrase-protected keys are weaker but allows it. This means a
quorum could include members with passphrase-only key protection.

**Option C: Tiered policy — quorum owner sets minimum for their documents**
The document owner can require hardware keys for specific documents or quorum
groups. A "family secrets" document could require all holders use hardware keys,
while a "home maintenance records" document accepts passphrase-only members.

> **Recommendation**: Option B as the system default, with Option C available
> as a policy lever for the vault owner. This lets less-technical family members
> participate while allowing the owner to enforce hardware keys where stakes are
> highest. The UI should clearly surface which protection tier each member uses.

**Attest**: Agree with recommendations Option B as system default, with Option C available - EF 5/22/2026

---

### D3: Quorum reconstruction model

When a quorum-protected document is unlocked, how do the required members
participate?

**Option A: Synchronous — all required members online simultaneously**
Members gather (physically or via video call), each unlocks their share in the
browser, shares are combined client-side in a single session. Simple to reason
about. Requires coordination.

**Option B: Asynchronous — share submission over time**
Each member unlocks their share independently and submits it to the server
(encrypted to a session-specific ephemeral key). When enough shares arrive,
reconstruction proceeds. More convenient but shares are temporarily held
server-side (encrypted).

**Option C: Hybrid — synchronous default, async ceremony for inheritance**
Normal quorum ops are synchronous (family meeting to unlock a document). A
special "inheritance ceremony" mode allows async share collection over a
defined window (e.g., 72 hours) with audit trail and notifications.

> **Recommendation**: Option A for v1. Synchronous reconstruction is simpler,
> avoids the complexity of server-held ephemeral shares, and is appropriate
> for the "gathered family" inheritance scenario. Option C is a strong v2
> addition once the synchronous foundation is proven. The inheritance use case
> (kids accessing after parent death) likely involves the family being together
> anyway.

**Attest**: Option A is reasonable MVP given it does allow each member of quorum to unlock and view/download/export client-side - EF 5/22/2026

---

### D4: Recovery when a hardware key is lost or destroyed

A family member's YubiKey breaks, is lost, or stolen. What recovery path exists?

**Option A: Backup hardware key (registered at setup)**
Each member registers two hardware keys. If one is lost, the other still works.
The lost key is revoked. Requires purchasing and safely storing a second key.

**Option B: Recovery code (printed, physically stored)**
At key registration, a high-entropy recovery code is generated, used to create
an additional wrap of the member's private key, and displayed once for the user
to write down / print. This is the "bank lockbox" scenario.

**Option C: Quorum-assisted re-registration**
If a member loses their key, a quorum of other members can authorize the
issuance of a new keypair for that member. The system re-wraps all affected
DEK shares to the new public key. This is a key rotation ceremony.

**Option D: All of the above (layered recovery)**
Support backup keys, recovery codes, AND quorum-assisted re-registration.
Each is a separate recovery path. The user chooses which to set up.

> **Recommendation**: Option D. These are complementary, not competing.
> Backup YubiKey is the fast path ("I have my spare in the safe").
> Recovery code is the solo path ("I'm alone and my key broke").
> Quorum-assisted re-registration is the last resort ("I lost everything
> but my family can vouch for me"). For inheritance specifically, the vault
> owner should be strongly encouraged to set up all three.

**Attest**: Option D - EF 5/22/2026

---

### D5: Metadata exposure for PKI-encrypted documents

What metadata remains plaintext (searchable/browsable) for PKI-encrypted documents?

**Option A: Same as passphrase mode — title, type, dates, tags plaintext**
Consistent with current behavior. Users can browse and find encrypted docs,
but document existence and nature are visible to anyone with server access.

**Option B: Minimal plaintext — only document ID and encryption status**
Everything else (title, type, description, dates) encrypted in the envelope.
Maximum privacy but documents become opaque entries in the list until unlocked.

**Option C: Owner-configurable per document**
Let the owner choose: "visible metadata" vs. "sealed metadata" per document.
Inheritance documents might be fully sealed; routine encrypted docs keep
searchable metadata.

> **Recommendation**: Option A for v1, with Option C as a future enhancement.
> The passphrase mode already establishes the "minimal plaintext" pattern.
> Fully sealed metadata (B) makes the vault nearly unusable for browsing —
> beneficiaries wouldn't know which document to unlock. For inheritance, the
> document titles ("Bitcoin Custody Instructions", "Estate Plan 2026") being
> visible is actually *helpful* — beneficiaries need to find the right docs.

**Attest**: Option A - EF 5/22/2026

---

### D6: Audit and transparency

What audit trail should exist for PKI key operations?

**Option A: Minimal — standard audit_log entries for key events**
Key registration, revocation, document encrypt/decrypt attempts logged to
the existing audit_log table. Queryable but not proactively surfaced.

**Option B: Proactive notifications — key events trigger alerts**
Key operations (new key registered, key revoked, quorum policy changed,
document unlocked) generate notifications to all quorum members. Makes
tampering visible even if audit logs are altered.

**Option C: Cryptographic audit trail — signed event log**
Each key event is signed by the acting member's key, creating a tamper-evident
chain. Members can independently verify the log hasn't been altered.

> **Recommendation**: Option B for v1. Proactive notifications are the
> practical sweet spot — they catch the "compromised server quietly changes
> quorum policy" attack without requiring members to verify a crypto chain.
> Option C is appealing but adds significant complexity and only matters if
> the server itself is compromised (which Option C in D1 partially addresses).

**Attest**: Option B - EF 5/22/2026

---

### D7: Platform passkey posture

How does the system treat platform passkeys (iCloud/Google synced) vs.
hardware-bound FIDO2 credentials?

**Option A: Treat identically — no distinction in the UI**
The WebAuthn API is the same. Let users choose their authenticator.
Don't lecture about sovereignty.

**Option B: Distinguish and label — surface the trust difference**
Detect whether the credential is hardware-bound (via attestation) or
platform-synced. Label it in the UI. Allow quorum policies to require
hardware-bound credentials for specific roles.

**Option C: Hardware-only — reject platform passkeys entirely**
Enforce that only hardware-bound credentials are accepted for encryption
key registration. Strongest posture but excludes members without hardware keys.

> **Recommendation**: Option B. Transparency without gatekeeping. The vault
> owner sees "YubiKey (hardware-bound)" vs. "iCloud Passkey (cloud-synced)"
> next to each member's key. Quorum policies can optionally require
> hardware-bound keys (ties into D2 Option C). This respects the owner's
> sovereignty ethos without forcing it on every family member.

**Attest**: Option B - EF 5/22/2026

---

### D8: Scope of v1 PKI delivery

How much of the full PKI vision ships in the first deliverable?

**Option A: Full quorum — member keys, document wrapping, Shamir, quorum UI**
Ship the complete system. Longer timeline, higher risk of design errors that
are hard to unwind once documents are encrypted under the scheme.

**Option B: Member keys + single-owner wrapping only (no quorum)**
Ship key registration (FIDO2 + passphrase), member keypair generation,
and document encryption wrapped to a single owner's public key. Validates
the key lifecycle and crypto pipeline. Quorum/Shamir ships as a follow-up.

**Option C: Member keys + N-of-N wrapping (no Shamir yet)**
Same as B, but support wrapping DEK to multiple members where ALL must
participate (N-of-N). Simpler than Shamir but validates multi-holder
wrapping and the UI for managing beneficiaries.

> **Recommendation**: Option B first, then C, then Shamir quorum. Each phase
> validates a layer before the next depends on it. A bug in Shamir
> implementation could make documents permanently inaccessible — that code
> deserves the most review time and should not be rushed. Member key
> registration and single-owner wrapping is already high-value: it upgrades
> from passphrase-only to hardware-key-backed encryption.

**Attest**: Agree walk first then start jogging - Option B, then C follow-up - EF 5/22/2026

---

## 6. Attack scenarios and mitigations

### S1: Server database stolen (disk theft, backup leak)
- **Impact without PKI**: Metadata visible; passphrase-encrypted docs require offline brute-force of passphrase
- **Impact with PKI**: Metadata visible; documents require member private keys (hardware-bound = infeasible; passphrase-protected = offline brute-force of member passphrase)
- **Mitigation**: Hardware keys make this a non-issue for key extraction. Passphrase-protected member keys should use Argon2id with strong parameters.

### S2: Vault owner dies unexpectedly
- **Without quorum**: Beneficiaries need the owner's passphrase (may be unknown) or recovery code (may not exist)
- **With quorum (2-of-3)**: Two of three beneficiaries can reconstruct without the owner. Owner's share is not needed.
- **Key requirement**: Quorum must be configured *before* incapacitation. The system should actively prompt for this during PKI setup.

### S3: Single beneficiary attempts unauthorized solo access
- **Mitigation**: Quorum threshold prevents unilateral decryption. Audit notifications alert other members of the attempt.

### S4: Attacker compromises one family member's device
- **Impact**: Access to that member's key share (if unlocked in memory) or wrapped private key
- **With hardware key**: Private key never leaves the YubiKey; compromise of the device alone is insufficient
- **With passphrase-protected key**: Attacker gets wrapped private key, must brute-force passphrase
- **Quorum mitigation**: One share is insufficient to reconstruct the DEK

### S5: Server serves malicious JavaScript
- **Impact**: Could steal plaintext during decrypt, exfiltrate key material from memory, present fake public keys during key registration
- **Mitigation (D1 Option C)**: Client-side key fingerprint verification during registration ceremony (verify out-of-band that the public key the server returns matches what was generated). SRI hashes for external crypto dependencies. CSP headers.
- **Residual risk**: A fully compromised server can always serve arbitrary JS. Defense-in-depth reduces the window but cannot eliminate this for a web app. Native/electron wrapper or browser extension could close this gap in a future version.

### S6: YubiKey stolen from bank lockbox
- **Impact**: Attacker has physical key but may not know which server/account it belongs to
- **Mitigation**: FIDO2 credentials are origin-bound (useless on a different domain). PRF secrets are salt-bound. Key alone without the homeSource server URL and a valid session is inert.
- **If attacker also compromises server**: They have one share. Quorum prevents access unless threshold is met.

### S7: All hardware keys for a member are lost (fire, disaster)
- **Recovery paths (per D4)**: Recovery code (printed, stored elsewhere) → quorum-assisted re-registration (other members authorize new keypair) → if no recovery path exists, that member's share is permanently lost
- **Quorum resilience**: As long as threshold-many other members retain their keys, documents remain accessible. Lost member's share can be re-issued after re-registration.

---

## 7. Cryptographic choices (preliminary)

| Component | Choice | Rationale |
|---|---|---|
| Document content encryption | AES-256-GCM | Established in v1 passphrase mode; no reason to change |
| Member keypair type | ECDH P-256 (Web Crypto native) | Broad browser support; key agreement for wrapping |
| Key agreement for DEK wrapping | ECDH + HKDF-SHA256 → AES-KW | Standard NIST curve key agreement; AES Key Wrap for DEK |
| Secret sharing | Shamir over GF(256) | Standard threshold scheme; well-understood math |
| Member private key protection (hardware) | WebAuthn PRF extension | Derives symmetric key from hardware credential |
| Member private key protection (passphrase) | Argon2id → AES-256-GCM | Consistent with existing passphrase mode |
| Key fingerprinting | SHA-256 of public key, displayed as hex | For out-of-band verification (D1 Option C) |

### Open crypto questions

- **ECDH P-256 vs. X25519**: P-256 has native Web Crypto support. X25519 is preferred
  in modern cryptography but requires a polyfill (libsodium.js) for Web Crypto.
  P-256 is pragmatic; X25519 is ideologically preferable. Decision needed.
- **Shamir library**: Vendor a minimal audited implementation, or use `@noble/secp256k1`
  ecosystem tooling? The `@noble` family (by Paul Miller) is well-audited and
  bitcoiner-adjacent. Worth evaluating `@noble/shares` or similar.
- **AES-KW vs. AES-GCM for key wrapping**: AES-KW (RFC 3394) is purpose-built for
  key wrapping and is available in Web Crypto. AES-GCM works but is not semantically
  correct for key wrapping. Preference: AES-KW.

---

## 8. Usability considerations for non-technical beneficiaries

The vault owner (Eric) is a bitcoiner comfortable with hardware keys and PKI concepts.
The beneficiaries (kids, potentially spouse) may not be. Design must account for:

1. **Guided key registration ceremony** — step-by-step wizard, not a settings page.
   "Plug in your YubiKey and tap it when the light flashes" level of guidance.

2. **Clear mental model** — beneficiaries need to understand: "Your key is like a
   physical house key. You need it to open certain documents. If you lose it, your
   family can help you get a new one — but you can't open anything alone."

3. **Quorum unlock as a family ritual** — frame it as "the family gathers to open the
   vault," not as a crypto ceremony. The UI should walk participants through their
   role step by step.

4. **Failure states must be humane** — "Wrong key" or "Not enough participants" should
   explain clearly what to do next, not show crypto error codes.

5. **Practice mode** — let the family do a dry run with a test document before relying
   on quorum for real inheritance documents. This builds confidence and catches
   setup errors.

---

## 9. Next steps

1. **Eric attests to D1-D8 decisions** (this document)
2. Finalize cryptographic choices (P-256 vs. X25519, Shamir library)
3. PRF browser/key support matrix research
4. Phased delivery plan based on D8 attestation
5. Detailed UX wireframes for key registration ceremony
6. Security review of Shamir implementation before any quorum code ships

---

## Attestation log

| Decision | Option chosen | Date | Notes |
|---|---|---|---|
| D1: Server trust model | C: Honest-but-curious with integrity checks | 2026-05-22 | EF attested |
| D2: Key protection minimum | B+C: Passphrase fallback default, owner-configurable hardware requirement | 2026-05-22 | EF attested |
| D3: Quorum reconstruction | A: Synchronous for v1 | 2026-05-22 | Each member unlocks and can view/download/export client-side |
| D4: Key loss recovery | D: All layered recovery paths | 2026-05-22 | EF attested |
| D5: Metadata exposure | A: Same as passphrase mode (plaintext metadata) | 2026-05-22 | EF attested |
| D6: Audit & transparency | B: Proactive notifications | 2026-05-22 | EF attested |
| D7: Platform passkey posture | B: Distinguish and label | 2026-05-22 | EF attested |
| D8: v1 PKI scope | B then C: Member keys + single-owner first, multi-holder follow-up | 2026-05-22 | "Walk first then start jogging" |
