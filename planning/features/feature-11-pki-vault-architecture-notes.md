# Feature #11: PKI Document Vault — Architecture Notes

Date: 2026-05-22
Status: Early planning — captured from initial design conversation
Parent: Feature #5 (Encrypted Document Modes)
Depends on: #91 (passphrase foundation, shipped), #90 (timelock, deferred)

## Context

homeSource has day-1 schema support for PKI envelope encryption (`encryption_keys`,
`key_holders`, `documents.encryption_key_id`) that was deliberately left dormant while
passphrase-based encryption shipped first. This document captures the initial architecture
discussion for activating that infrastructure to support multi-holder document encryption
with quorum policies — primarily for inheritance and family sovereignty use cases.

## Driving use case

A family vault owner wants to:
- Encrypt sensitive documents (financial accounts, bitcoin custody details, estate plans)
- Ensure those documents are accessible to designated beneficiaries after the owner is
  unavailable (death, incapacitation)
- Define quorum policies (e.g., 2-of-3 family members must cooperate to unlock)
- Use hardware security keys (YubiKey, FIDO2) as the primary key material — not passwords
- Maintain zero-knowledge server posture (server never sees plaintext or key material)

The vault owner is technically sophisticated (bitcoiner, FIDO2 user). The beneficiaries
may not be — the system must be usable for them with guided support, even if key
safeguarding remains their responsibility.

## Passkeys vs. FIDO2 hardware keys

Both use the WebAuthn API. The distinction matters for trust model:

| Property | Platform passkeys (iCloud/Google) | Hardware FIDO2 (YubiKey) |
|---|---|---|
| Private key location | Cloud HSM (Apple/Google) | Physical device |
| Synced/recoverable | Yes (vendor-managed) | No (device-bound) |
| Compellable by authority | Theoretically yes | No (physical possession required) |
| Loss recovery | Automatic via cloud | Manual (backup key or recovery code) |
| Sovereignty | Delegated | Full |

For high-value inheritance documents, hardware keys are preferred. Platform passkeys
are acceptable for lower-sensitivity documents or as a convenience layer. The system
should support both — the WebAuthn API is the same — but guide users toward hardware
keys for documents that matter most.

## The WebAuthn encryption gap

FIDO2/WebAuthn is an **authentication** protocol, not an **encryption** protocol.
Keys sign challenges; they cannot directly encrypt/decrypt arbitrary data.

### Bridge options evaluated

**Option A: PRF extension (`hmac-secret` / `prf`)**
- WebAuthn PRF extension derives a deterministic symmetric secret from credential + salt
- Supported: YubiKey 5+, Chrome 116+, Safari 18+
- Cleanest path for hardware-key-based encryption
- Limitation: not all passkey providers support PRF yet

**Option B: WebAuthn authenticates, server releases wrapped key share**
- User proves key possession via WebAuthn assertion
- Server releases that user's encrypted share
- Trade-off: server becomes gatekeeper (not purely client-side)

**Option C: Separate encryption keypair per member (recommended foundation)**
- Each member generates ECDH keypair via Web Crypto API
- Private key encrypted at rest with PRF-derived secret (preferred) or passphrase (fallback)
- Public key stored on server
- DEK wrapped to each authorized member's public key
- Quorum uses Shamir Secret Sharing
- Most general; maps directly to existing schema

### Recommended approach

Option C as the general framework, with Option A (PRF) as the preferred mechanism for
protecting each member's encryption private key. This gives:
- Hardware-key sovereignty for the vault owner
- Passphrase fallback for less-technical beneficiaries
- A general envelope model that supports any future key source

## Proposed layered architecture

### Layer 1: Member encryption identity

Each family member registers a **member encryption keypair** (ECDH P-256 or X25519).
The private key is encrypted at rest by one or more of:
- FIDO2-derived PRF secret (hardware-backed, preferred)
- Passphrase-derived key (Argon2id, fallback for non-hardware users)
- Recovery code (emergency, printed and stored physically — "bank lockbox" scenario)

Maps to: `encryption_keys` table (`key_type: 'member'`)

### Layer 2: Document encryption

Each encrypted document has a random **DEK** (AES-256-GCM). The DEK is wrapped
according to access policy:
- **Single owner**: DEK wrapped to owner's public key
- **Owner + beneficiaries (N-of-N)**: DEK wrapped to each authorized member's public key
- **Quorum (M-of-N)**: DEK split via Shamir's Secret Sharing; each share wrapped
  to a member's public key

Maps to: `key_holders` table (`role: 'owner' | 'cosigner' | 'recovery'`,
`encrypted_key_share` stores the wrapped share)

### Layer 3: Quorum policy

Stored in `encryption_metadata.policy`:
```json
{
  "quorum": { "threshold": 2, "total": 3 },
  "holders": [
    { "member_id": 1, "role": "owner", "wrapped_share_b64": "..." },
    { "member_id": 2, "role": "beneficiary", "wrapped_share_b64": "..." },
    { "member_id": 3, "role": "beneficiary", "wrapped_share_b64": "..." }
  ]
}
```

## Schema evolution needed

- Add `encryption_mode: 'pki'` to the documents CHECK constraint
- Use `encryption_keys` for member keypairs (`key_type: 'member'`)
- Use `key_holders` to record share assignments per document key
- Extend `encryption_metadata` envelope with `holders[]` for PKI mode
- Consider: member key registration table / key metadata

## Key lifecycle concerns

1. **Key registration ceremony**: Multi-step flow; must feel safe, not scary for
   non-technical family members
2. **Key revocation / member removal**: Requires re-wrapping all affected documents'
   DEKs to remaining holders (batch operation)
3. **Hardware failure recovery**: Backup YubiKey, recovery codes, or re-registration
   with quorum assistance
4. **Key rotation**: Should be possible but not mandatory; old wrapped shares must
   remain valid until explicitly rotated

## Shamir Secret Sharing considerations

- Client-side JS implementation needed
- `secrets.js` exists but unmaintained; GF(256) math is straightforward but subtle
- Need to evaluate: audited libraries vs. minimal vendored implementation
- Share reconstruction happens entirely client-side
- Shares are never combined on the server

## Backward compatibility

- Existing passphrase-encrypted documents continue to work unchanged
- PKI mode is additive — new `encryption_mode` value, new envelope structure
- Documents can potentially be "upgraded" from passphrase to PKI mode (re-wrap DEK
  after client-side passphrase unlock)

## Open questions for threat model

- What is the server trust boundary? (honest-but-curious? compromised?)
- Is time-delayed unlock (dead man's switch) in scope for v1 PKI?
- Should quorum reconstruction require all participants online simultaneously,
  or support asynchronous share submission?
- What browser/key support matrix is minimum viable?
- How does this interact with the deferred timelock feature (#90)?

## Next steps

1. Formal threat model with attestable decision points
2. PRF browser/key support matrix research
3. Shamir library evaluation
4. Phased delivery plan
