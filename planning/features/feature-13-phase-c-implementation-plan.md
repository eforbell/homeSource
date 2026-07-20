# Feature #13 Phase C — Implementation Plan

Date: 2026-07-19
Status: C0.1–C2 implemented through automated verification; C3 scoped doorway next
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

#### C0.2b reminder fanout — implemented

- Generalize Phase B reminder attempts so email and enabled `brrr` deliver independently with
  durable dedupe, retry, and safe result state.
- Resolve the reusable write-only brrr target only while claiming an attempt; persist only its
  channel reference, configuration version, and fingerprint in the sibling outbox.
- Keep brrr payloads generic and token-free, and supersede queued attempts when either switch
  state or channel configuration changes.
- Include per-channel operations state and secret-free outbox history in app backups.

#### C0.2b trustee contact replacement — implemented

- Stage one pending replacement without revoking the currently verified trustee address.
- Deliver a seven-day, hashed, single-use proof link to the proposed address and atomically
  switch the verified contact only after sessionless confirmation.
- Preserve prior contact history, keep the trustee key identity unchanged, reject address
  collisions/cross-owner changes, and invalidate pending proof when a trustee is revoked.
- Include contact history and hashed proof state in repeatable-read app backups.

### C0.3 Immutable packet policy — implemented

- Add database-protected staged/active/superseded packet versions, explicit document scope,
  recipient roster, exact holder/designation coverage evidence, and independent switch-level
  witness trustees.
- Reject migration when any armed, paused, or delivery-pending legacy switch exists under the
  controlled-rollout contract.
- Derive deterministic per-recipient coverage from version 2 PKI envelopes and sealed
  designation projections; the Letter must cover every recipient and each additional selected
  document must cover at least one.
- Replace packet policy by creating a new version while preserving superseded rows and their
  encrypted Letter artifact; staging a newer Letter invalidates the prior staged packet.
- Activate the staged Letter and packet together through the reauthenticated commit only when
  current operator reachability, verified recipient contacts, active exact keys/wraps, and
  verified witness contacts all revalidate in the same transaction.
- Surface packet/document/witness selection and staged/active inspection through owner-only
  APIs and the continuity operator UI, without creating notification or grant behavior.

### C0.4 Continuity-aware authorization boundary — implemented

- Add one fail-closed resolver for Letter visibility, packet-bound administration,
  continuity-seal mutation, sealed-wrap projection, and the future exact-item grant extension.
- Hide staged Letters from generic document routes and active/historical Letters from every
  non-owner metadata, key-info, file, mutation, link, insight, posture, and aggregate surface.
- Preserve ordinary read/download access to packet-selected documents while redacting sealed
  holders and requiring document/packet ownership for continuity-holder or packet-bound
  mutations.
- Scope trustee and continuity-directory administration to the owning operator, redact hidden
  key dependencies without weakening revoke safeguards, and reserve continuity metadata from
  generic document updates.
- Exclude Letters from deterministic scanners and document the import/export/backup boundary:
  backup preserves ciphertext and durable policy but creates no application grant or restore
  authority.
- Record the complete enforced surface in
  `planning/features/feature-13-phase-c-authorization-matrix.md`.

## C1 — Trustee verification window — implemented

- Add one immutable-packet-bound, idempotent delivery run per switch/cycle with durable witness
  contact snapshots and fail-closed blocked/no-trustee transitions.
- Notify every designated trustee concurrently through the extended durable outbox and begin
  the shared 72-hour window only at the final required successful send; permanent failure
  blocks release while bounded owner retry preserves prior success history.
- Mint separate hashed trustee-action tokens only while claiming an attempt, replace ambiguous
  retry material, and expose one sessionless pause-only doorway with no document, recipient,
  envelope, key, or account authority.
- Fix the first valid trustee pause at one 30-day deadline under the delivery-run lock; later
  concurrent or replayed actions return that deadline without extending it.
- Permit owner recovery with same-request passphrase reauthentication only before the durable
  `first_grant_activated_at` boundary, superseding queued actions and starting a fresh
  daylight-saving-safe check-in cycle.
- Surface delivery-run/witness state, notification retry, and recovery in the operator API/UI,
  and preserve run history, witness snapshots, and token hashes in repeatable-read backups.

Stop condition met by automated verification: one run/window survives scheduler and outbox
replay, partial/permanent failure cannot consume the common clock, pause concurrency cannot
extend the deadline, no-witness runs release immediately to the still non-delivering C2 state,
and owner recovery fails closed once the modeled first-grant boundary is committed.

## C2 — Delivery manifests and grants — implemented

- Run envelope-canonical preflight under the delivery-run lock.
- Snapshot immutable per-recipient grants and generic-ordinal manifest items.
- Apply atomic delivery per recipient: one blocked item blocks that recipient, not healthy
  recipients.
- Commit grant, manifest, hashed usable token, and notification outbox atomically.

Stop condition met by automated verification: delivery-time posture is revalidated without
decrypting, each recipient receives one immutable complete manifest or one blocked grant,
healthy recipients activate independently, the first active grant fixes the owner-recovery
cutoff, scheduler replay creates no duplicate durable state, and repeatable-read backup retains
only hashed bearer material. Recipient outbox rows remain deliberately unclaimed until C3 adds
the exact-item doorway; C2 cannot accidentally send a check-in link in their place.

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
