# Feature #11: PKI Vault — Cryptographic Research

Date: 2026-05-22
Status: Research complete — recommendations ready for decision

---

## 1. Curve Choice: X25519 vs P-256

### Recommendation: X25519 (native Web Crypto)

X25519 is available natively in all evergreen browsers as of February 2025:

| Browser | Version | Date shipped |
|---|---|---|
| Firefox | 130 | September 2024 |
| Safari / WebKit | All ports | December 2024 |
| Chrome / Edge / Brave | M133 | February 2025 |

The API is `crypto.subtle.generateKey({ name: "X25519" }, ...)` and `crypto.subtle.deriveBits()` — no polyfill needed for any browser released in the last 18 months.

### Why X25519 over P-256

**Design-level advantages (not just preference):**

1. **No point validation required.** P-256 ECDH requires validating that the peer's public key is a valid curve point before use — omitting this enables invalid-curve attacks that leak private key bits. X25519 accepts any 32-byte input safely; the Montgomery form and scalar clamping eliminate this attack class by construction.

2. **Constant-time by structure.** X25519's Montgomery ladder processes every bit of the scalar uniformly — no data-dependent branches, no data-dependent memory access. P-256's Weierstrass form requires point addition/doubling formulas that historically introduced timing side-channels in implementations (CVE-2024-23342: Minerva timing attack against P-256 in python-ecdsa, enabling private key recovery).

3. **Transparent parameter derivation.** Curve25519's parameters are derived from the prime 2^255 - 19 — fully verifiable. P-256's seed values were provided by NSA with no public documentation of how the seed was chosen. The Dual_EC_DRBG backdoor (confirmed via Snowden documents) established precedent that NSA-chosen parameters may retain exploitable structure. No P-256 backdoor has been proven, but the parameters are non-rigid.

4. **Simpler implementation surface.** Fewer error conditions, shorter code, easier to audit. This matters when the consequence of a bug is permanent document loss.

**P-256 is not broken** — and when used via browser-native Web Crypto, the OS-level implementation handles timing correctly. But X25519 offers the same functionality with a strictly smaller "things that can go wrong" surface.

### Fallback library (if ever needed)

`@noble/curves` by Paul Miller — MIT license, zero dependencies (only `@noble/hashes`):
- **3 independent professional audits**: Trail of Bits (Feb 2023), Kudelski Security (Sep 2023), Cure53 (Sep 2024)
- 380,000+ dependent repositories (MetaMask, ethers.js, Solana, Polkadot)
- Full RFC 7748 X25519 support
- Caveat: no JS library can guarantee CPU-level constant-time due to JIT compilation — but this is true universally, not specific to noble

**libsodium-wrappers** is the alternative but brings ~290KB gzipped WASM bundle — overkill when native Web Crypto covers X25519 directly.

### Protocol: ECDH → HKDF → AES-KW

The key agreement protocol is identical in structure for both curves:

```
1. Member A generates X25519 keypair (or imports existing)
2. ECDH: deriveBits(A.private, B.public) → 256-bit shared secret
3. HKDF-SHA256(shared_secret, salt, info="vault-dek-wrap-v1") → 256-bit KEK
4. AES-KW: wrapKey(DEK, KEK) → wrapped DEK (40 bytes for 256-bit DEK)
```

The HKDF step is **mandatory** — raw ECDH output is not uniformly random and must never be used directly as a key.

---

## 2. Key Wrapping: AES-KW

### Recommendation: AES-KW (RFC 3394) — confirmed

AES-KW is natively supported in Web Crypto via `crypto.subtle.wrapKey()` / `unwrapKey()` with algorithm name `"AES-KW"`. Baseline browser support since January 2020.

### Why AES-KW over AES-GCM for wrapping

| Property | AES-KW (RFC 3394) | AES-GCM |
|---|---|---|
| Nonce/IV required | **No** | Yes (12 bytes) |
| Nonce reuse consequence | N/A — stateless | **Catastrophic**: full key recovery |
| Integrity check | Built-in 64-bit ICV (Feistel) | GHASH tag (16 bytes) |
| Ciphertext expansion | 8 bytes | 28 bytes (IV + tag) |
| Standards endorsement | NIST SP 800-38F, RFC 3394, JWE | Not recommended for key wrapping |

**The decisive factor**: AES-GCM nonce reuse is catastrophic and silent. A repeated (KEK, nonce) pair leaks the DEK via ciphertext XOR. In a key vault with re-wrapping operations (key rotation, beneficiary changes), the nonce management burden is a liability. AES-KW eliminates this class of bug entirely — it has no nonce.

`crypto.subtle.unwrapKey()` with AES-KW throws `OperationError` on integrity failure — bad wrapping key or corrupted ciphertext is detected automatically.

### AES-KW-PAD (RFC 5649)

Not available in Web Crypto. Not needed — all standard AES key sizes (128/192/256-bit) are multiples of 64 bits, which is AES-KW's input requirement.

---

## 3. Shamir Secret Sharing Library

### Recommendation: `shamir-secret-sharing` by Privy (with caveats)

### Library landscape

| Library | Audit | Maintained | Field | Verdict |
|---|---|---|---|---|
| `shamir-secret-sharing` (privy-io) | **Cure53 + Zellic (2023)** | Last release Aug 2023 | GF(2^8) | **Best available** |
| `secrets.js-grempe` | Cure53 2019 | Abandoned ~7 years | GF(2^bits) | Do not use |
| `secrets.js` (amper5and) | None | Explicitly abandoned | GF(2^bits) | Do not use |
| `@noble/shares` | — | **Does not exist** | — | N/A |
| `shamirs-secret-sharing` (jwerle) | None | Minimal | GF(2^8) | Do not use |
| DIY implementation | — | — | — | **Do not do this** |

### Privy `shamir-secret-sharing` details

- **GitHub**: github.com/privy-io/shamir-secret-sharing
- **License**: Apache-2.0
- **Language**: TypeScript, zero external dependencies
- **Field**: GF(2^8), byte-oriented (one polynomial per byte of secret)
- **Two professional audits**:
  - Cure53 (February 2023): Found one medium-severity issue — zero leading coefficient bug (PVY-01-002) causing effective threshold reduction for ~11% of 256-bit secrets.
  - Zellic (January 2024): Independent audit, report published.
- **Actively maintained**: Most recent commit April 2, 2026 (security considerations update, PR #34). v0.0.4 released January 2025. Active contributors include Andrew Mohawk, Aaron Feickert, sternhenri. Note: PR #22 reverted the original PVY-01-002 fix — the "biased shuffle" documentation (PR #20) suggests the mitigation approach evolved; verify current handling before relying on threshold guarantees.
- **Inspired by**: HashiCorp Vault's Go implementation
- **Browser + Node.js**: Both supported

### Known limitations (documented by Privy)

1. **No guaranteed constant-time in JS.** JIT compilation can reintroduce timing leaks. True of all JS crypto — not specific to this library.

2. **Silent reconstruction failure.** Wrong shares produce garbage bytes, not an error. This is inherent to textbook Shamir SSS — the mitigation is architectural (see below).

3. **Input must be high-entropy.** Raw passphrases should not be split directly. Always split a random key, not user-chosen secrets.

4. **PVY-01-002 resolution (reviewed).** The original Cure53-recommended fix (reject zero coefficients) was reverted in PR #22 because it violated the uniform random sampling requirement of Shamir's scheme — excluding zero from [0,255] leaks information under repeated observation of splits. Privy's blog (privy.io/blog/zero-leading-coefficients-cryptography) details the trade-off: a zero leading coefficient (probability 1/256 per byte, ~11% chance for any byte in a 32-byte secret) reduces effective threshold for that single byte, but full secret degradation requires all 32 bytes to have zero coefficients simultaneously (probability ~2^-256). The revert restores perfect secrecy. For homeSource this is unambiguously correct: we split random AES-256 DEKs (no structure to exploit), AES-GCM tag verification catches any reconstruction error, and DEKs are split once (no repeated observation). PR #20 ("biased shuffle") is unrelated — it documents that share ordering uses a naive Fisher-Yates variant, which is harmless since share order has no security significance in SSS.

### Critical architectural mitigation: AES-GCM integrity wrapper

Since Shamir reconstruction with wrong shares silently produces garbage:

```
1. Generate random 256-bit DEK
2. Encrypt document with AES-256-GCM using DEK (authenticated)
3. Split DEK into shares via Shamir SSS
4. On reconstruction: recombine shares → candidate DEK
5. Attempt AES-GCM decryption — authentication tag failure = wrong shares
```

The GCM authentication tag provides the integrity check that Shamir lacks. Corrupt or incorrect shares produce a DEK candidate that fails GCM tag verification — a detectable error, not silent data corruption.

### Why not DIY

Two production implementations by professional teams shipped security-relevant bugs:
- **HashiCorp Vault (Go)**: CVE-2023-25000 — timing side-channel via data-dependent GF(256) table lookups. Patched in Vault 1.13.1.
- **Privy (TypeScript)**: PVY-01-002 — zero leading coefficient reducing effective threshold. Found by Cure53 audit.

The math is ~150 lines. The correctness surface is much larger. Do not vendor a custom implementation for a use case where bugs mean permanent document loss.

### Cross-validation reference implementations

For test vector generation and correctness verification:

| Implementation | Language | Notes |
|---|---|---|
| `hashicorp/vault` shamir package | Go | Production-hardened; Privy used as reference |
| `codahale/sss` | Go | Archived 2017 but clean/readable |
| `dsprenkels/sss` | C | Side-channel resistant design |
| `gf256` crate | Rust | Full GF(256) with Lagrange interpolation |

Generate (secret, shares, threshold, n) test corpus in Go, verify JS library reproduces identical results for same x-coordinates and polynomial coefficients.

### Maintenance and vendoring posture

The project is actively maintained (last commit April 2026, v0.0.4 released January 2025). Pin the exact version. The code is ~300 lines of TypeScript with zero dependencies — fully auditable in-house and vendorable if needed. The two audit reports provide a correctness baseline. Since homeSource builds by hand, building from source against main (rather than relying solely on npm published tags) is a viable option.

---

## 4. WebAuthn PRF Extension

### Recommendation: Use PRF as preferred path, with passphrase-derived fallback

### Spec status

PRF is defined in **WebAuthn Level 3 Candidate Recommendation** (January 13, 2026). Not yet a full W3C Recommendation but normatively stable with multiple shipping implementations. Maps to CTAP2 `hmac-secret` extension at the authenticator protocol layer.

### Browser support matrix (Q1-Q2 2026)

| Platform | Browser | PRF at `get()` | PRF at `create()` | Notes |
|---|---|---|---|---|
| **macOS 15+** | Chrome 132+ | Yes | Yes | Platform + hardware keys |
| | Firefox 139+ | Yes | Yes | Platform + hardware keys |
| | Safari 18+ | Yes | Yes | Platform auth only; WebKit bugs affect CTAP2 hardware keys |
| **Windows 11 25H2** | Chrome 147+ | Yes | Yes | Requires Feb 2026 KB5077181 for Windows Hello |
| | Firefox 148+ | Yes | Yes | First to fully support PRF-on-create with Windows Hello |
| | Edge 147+ | Yes | Yes | Chromium-based, same as Chrome |
| **iOS/iPadOS 18.4+** | Safari/Chrome | Yes | Yes | iCloud Keychain only; **no PRF with hardware keys** |
| **Android** | Chrome/Edge | Yes | Yes | Google Password Manager passkeys |
| | Firefox | **No** | **No** | PRF not yet supported |

### Hardware key support

| Key | PRF/hmac-secret | Notes |
|---|---|---|
| YubiKey 5 Series | **Yes** | All FIDO2 models; secure element never exposes root key |
| YubiKey Security Key | **Yes** | FIDO2 variants |
| SoloKeys Solo 1/2 | **Yes** | Open-source CTAP2; hmac-secret added via firmware |
| Google Titan | **Uncertain** | CTAP2 but hmac-secret not publicly confirmed for all generations |

### Platform authenticator support

| Authenticator | PRF | Notes |
|---|---|---|
| iCloud Keychain (macOS 15+) | **Yes** | 100% PRF-on-create success in Q1 2026 field testing |
| iCloud Keychain (iOS 18.4+) | **Yes** | Earlier 18.0–18.3 had data-loss bugs; 18.4 fixed |
| Google Password Manager | **Yes** | All passkeys include PRF unconditionally |
| Windows Hello (Feb 2026+) | **Yes** | Requires KB5077181; older builds: no PRF |

### iOS hardware key gap — accepted

Safari on iOS/iPadOS does not pass PRF extension data to/from CTAP2 roaming authenticators. PRF with a YubiKey works in Chrome/Firefox on macOS but **not** in Safari on any Apple mobile platform.

**Owner decision (EF 2026-05-22):** This gap is accepted and considered appropriate for the use case. Unlocking inheritance-grade documents is a deliberate, computer-based activity — not a mobile/on-the-go operation. The design intention aligns with D3-A (synchronous quorum): beneficiaries sit down at a real computer for the vault ceremony.

iCloud Keychain PRF support on iOS is a useful secondary benefit: family members can register a backup passkey credential from their iPhone without purchasing a hardware key. The system detects the protection tier via `enabled` at `create()` time (D7-B) and labels it accordingly — "YubiKey (hardware-bound)" vs. "iCloud Passkey (cloud-synced)". Hardware key on the Mac for the real ceremony, iCloud passkey as a convenient backup registration path.

### Graceful detection

PRF availability is detectable at registration time:

```javascript
const credential = await navigator.credentials.create({
  publicKey: {
    // ... standard options
    extensions: {
      prf: { eval: { first: salt } }  // or just prf: {}
    }
  }
});

const result = credential.getClientExtensionResults();
if (result.prf?.enabled) {
  // PRF supported — enroll hardware-backed key protection
} else {
  // PRF not available — fall back to passphrase-based key protection
}
```

Store the PRF capability flag with the credential record. At authentication time, check for `results.first` presence before attempting derivation.

### Security properties

- **Deterministic**: Same (credential, salt) pair always produces same 32-byte output
- **Salt controlled by relying party**: RP specifies salt as ArrayBuffer; two salts supported simultaneously (`first` + `second`) for atomic rotation
- **Output**: 32 bytes (256 bits) — HMAC-SHA-256 keyed with credential's internal secret
- **Must use HKDF**: Yubico explicitly recommends running PRF output through HKDF-SHA256 with domain-specific `info` before using as KEK

```javascript
const prfOutput = authResult.getClientExtensionResults().prf.results.first;
const hkdfKey = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
const kek = await crypto.subtle.deriveKey(
  {
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: new TextEncoder().encode("homesource-member-kek-v1")
  },
  hkdfKey,
  { name: "AES-KW", length: 256 },
  false,
  ["wrapKey", "unwrapKey"]
);
```

---

## 5. Decision Summary

| Component | Choice | Rationale |
|---|---|---|
| **Curve** | X25519 (native Web Crypto) | Universal browser support since Feb 2025. No point validation needed, constant-time by design, transparent parameters. No polyfill required. |
| **Key wrapping** | AES-KW (RFC 3394, native Web Crypto) | Nonce-free, intrinsic integrity check, NIST-endorsed for key wrapping. Eliminates catastrophic nonce-reuse failure class. |
| **HKDF** | HKDF-SHA256 (native Web Crypto) | Mandatory step between ECDH output and KEK. Domain separation via `info` parameter. |
| **Secret sharing** | `shamir-secret-sharing` (privy-io) | Only doubly-audited JS SSS library (Cure53 + Zellic). GF(2^8), zero dependencies, Apache-2.0. Pin version, vendor if needed. |
| **Member key protection (hardware)** | WebAuthn PRF extension | Deterministic 32-byte secret derived from FIDO2 credential. Check `enabled` at create-time; fallback to passphrase when unavailable. |
| **Member key protection (passphrase)** | Argon2id → AES-256-GCM | Consistent with existing passphrase encryption mode. Fallback for members without PRF-capable authenticators. |
| **Document content encryption** | AES-256-GCM | Unchanged from v1. Authentication tag serves as Shamir reconstruction integrity check. |
| **Fallback crypto library** | `@noble/curves` (if needed) | 3 professional audits, MIT, minimal deps. Only needed if native Web Crypto is insufficient for a specific operation. |

### Full crypto pipeline (single-owner, Phase 1)

```
Registration:
  1. Member generates X25519 keypair (Web Crypto)
  2. Member authenticates with FIDO2 key → PRF output (32 bytes)
  3. HKDF(PRF output, info="homesource-member-kek-v1") → member KEK
  4. AES-KW: wrap(member_private_key, member_kek) → stored encrypted
  5. Public key stored on server

Encrypt document:
  1. Generate random 256-bit DEK
  2. AES-256-GCM: encrypt(document, DEK) → ciphertext
  3. ECDH(owner_private, owner_public) → shared secret (self-wrapping case)
     OR: derive KEK from member keypair directly for single-owner
  4. AES-KW: wrap(DEK, derived_KEK) → wrapped DEK
  5. Store: ciphertext + wrapped DEK + public key fingerprint

Decrypt document:
  1. Member authenticates with FIDO2 key → PRF output
  2. HKDF(PRF output) → member KEK
  3. AES-KW: unwrap(member_encrypted_private_key, member_KEK) → private key
  4. Derive document KEK from member keypair
  5. AES-KW: unwrap(wrapped_DEK, document_KEK) → DEK
  6. AES-256-GCM: decrypt(ciphertext, DEK) → plaintext
```

### Full crypto pipeline (quorum, Phase 3)

```
Encrypt with quorum (2-of-3):
  1. Generate random 256-bit DEK
  2. AES-256-GCM: encrypt(document, DEK)
  3. Shamir split(DEK, threshold=2, shares=3) → [share1, share2, share3]
  4. For each holder: AES-KW wrap(share_i, holder_i_public_key_derived_KEK)
  5. Store: ciphertext + wrapped shares + quorum policy

Decrypt with quorum:
  1. Gather 2 of 3 holders (synchronous, per D3-A)
  2. Each holder: authenticate → unwrap their private key → unwrap their share
  3. Shamir combine([share_a, share_b]) → candidate DEK
  4. AES-256-GCM: decrypt(ciphertext, candidate_DEK) → plaintext
     (GCM tag failure = wrong shares or corruption — detectable)
```

---

## Sources

### Curve / Web Crypto
- Igalia: "Can I use Secure Curves in the Web Platform?" (Feb 2025)
- W3C Web Cryptography API Level 2 FPWD (April 2025)
- WICG Secure Curves Draft (January 2026)
- Daniel J. Bernstein & Tanja Lange: "Failures in NIST's ECC Standards" (2016)
- CVE-2024-23342: Minerva timing attack on P-256 in python-ecdsa
- paulmillr.com/noble/ — audit reports (Trail of Bits, Kudelski, Cure53)

### Key Wrapping
- RFC 3394: AES Key Wrap Algorithm
- RFC 5649: AES Key Wrap with Padding
- NIST SP 800-38F: Key Wrapping
- USENIX WOOT 2016: "Nonce-Disrespecting Adversaries" (AES-GCM nonce reuse)
- MDN: SubtleCrypto wrapKey() / unwrapKey()

### Shamir SSS
- Cure53 Audit Report — Privy SSS (Feb 2023): cure53.de/audit-report_privy-sss-library.pdf
- Zellic Audit Report — Privy SSS: github.com/Zellic/publications
- CVE-2023-25000: HashiCorp Vault Shamir timing side-channel
- Privy Blog: "Shamir Secret Sharing Deep Dive" + "Zero Leading Coefficients"
- github.com/privy-io/shamir-secret-sharing

### WebAuthn PRF
- W3C WebAuthn Level 3 CR (January 2026)
- Yubico: PRF Developer Guide + CTAP2 HMAC-Secret Deep Dive
- Corbado: "Passkeys and WebAuthn PRF for E2E Encryption" (Q1 2026)
- MDN: WebAuthn extensions (prf)
