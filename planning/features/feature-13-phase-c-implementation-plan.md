# Feature #13 Phase C — Implementation Plan

Date: 2026-07-19
Status: C0.1 and C0.2a implemented through automated verification; C0.2b next
PRD: `planning/features/feature-13-phase-c-conditional-delivery.md`
Test specification: `planning/features/feature-13-phase-c-test-spec.md`

## Delivery strategy

Phase C will land as independently reviewable, fail-closed increments. No increment may
notify a trustee or recipient about an escalation, create a delivery grant, or serve a sealed
wrap until the preceding authorization and lifecycle contracts are implemented and tested.
Production arming remains disabled until deployment acceptance confirms there are no
armed-or-later legacy switches and the complete Phase C readiness ceremony is available.

## C0 — Contact and policy foundation

### C0.1 Verified beneficiary email contacts — implemented

- Add purpose-built member contact and verification-token tables.
- Restrict contacts to household kids and parent-authenticated administration.
- Normalize email addresses before persistence.
- Store only SHA-256 token hashes; replacement invalidates earlier usable tokens.
- Provide a content-minimal, sessionless verification route that grants no vault access.
- Include contact rows and hashed token records in repeatable-read backups.
- Surface verified contact status to the owning operator without treating it as delivery
  eligibility by itself.

Stop condition: contact control can be proven once, replay/cross-contact use fails, no app
session is issued, no raw token is returned or persisted, and the full existing suite remains
green.

### C0.2 Trustee contacts and operator reachability

#### C0.2a — implemented

- Add reusable trustee contact rows and seed a verified row from successful trustee
  registration.
- Add operator notification-channel configuration with write-only, masked, versioned `brrr`
  targets and secret-redacted app backups.
- Separate transport tests from owner reachability challenges and bind hashed challenge
  evidence to switch, owner, channel, target fingerprint, and configuration version.
- Provide operator UI for save/test/challenge/acknowledge while ensuring codes cannot check in,
  arm, or grant access.

#### C0.2b — next

- Add trustee contact replacement verification.
- Generalize Phase B reminder attempts so email and enabled `brrr` deliver independently with
  durable dedupe, retry, and safe result state.
- Make current reachability acknowledgements part of the later complete Phase C arming
  transaction alongside packet/readiness activation; do not add a partial UI-only gate.

### C0.3 Immutable packet policy

- Add staged/active/superseded packet versions, document scope, recipient roster, coverage
  matrix, and independent switch-trustee witness designations.
- Migrate only unarmed drafts under the controlled-rollout rule.
- Activate a complete version through one owner-reauthenticated transaction.

### C0.4 Continuity-aware authorization boundary

- Introduce one shared resolver for Letter administration, continuity seal mutation, and
  future exact-item grant serving.
- Inventory and regression-test list/detail/search, key-info/envelope, file download,
  archive/delete/replace, share, import/export, and backup/restore surfaces.
- Preserve ordinary vault access independently granted to ordinary documents while never
  exposing continuity-specific sealed wraps through ambient parent authority.

## C1 — Trustee verification window

- Add one idempotent delivery run per switch/cycle.
- Notify every designated trustee and begin the shared 72-hour window only after every
  required trustee has at least one successful send.
- Add separate hashed trustee-action tokens and the first-action, one-time 30-day pause.
- Permit owner recovery with same-request reauthentication only before the first recipient
  grant activation commit.

## C2 — Delivery manifests and grants

- Run envelope-canonical preflight under the delivery-run lock.
- Snapshot immutable per-recipient grants and generic-ordinal manifest items.
- Apply atomic delivery per recipient: one blocked item blocks that recipient, not healthy
  recipients.
- Commit grant, manifest, hashed usable token, and notification outbox atomically.

## C3 — Scoped recipient doorway

- Exchange a seven-day link for a hashed 60-minute recipient-scoped session.
- Serve only the exact encrypted artifact and holder-local wrapped DEK named by an active
  grant item.
- Show only `Private document N` before local unlock.
- Reuse existing passphrase/WebAuthn client primitives; the server never receives plaintext
  private keys, DEKs, or documents.

## C4 — Operations and completion

- Add retry, replacement-link, one-year grant expiry, audit timeline, and safe blocked-state
  recovery.
- Extend scheduler/outbox crash recovery, backup/restore, rate limits, and enumeration tests.
- Run full regression, hostile API/browser scenarios, real SMTP, browser key ceremonies,
  Linux systemd verification, and production-like backup/restore inspection.

## Commit boundaries

Each numbered increment should be a separate reviewable commit with its own migration,
tests, backup changes, and Lore trailers. Schema changes remain additive. No new dependency
is planned.
