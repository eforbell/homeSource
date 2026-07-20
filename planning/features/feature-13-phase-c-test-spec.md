# Feature #13 Phase C — Test Specification

Date: 2026-07-19
Status: Active; C0.1–C0.4 automated gates satisfied
PRD: `planning/features/feature-13-phase-c-conditional-delivery.md`

## Invariants exercised in every slice

1. Envelope-v2 holder data remains the canonical cryptographic authorization source.
2. A relational continuity row alone never grants document or wrapped-key access.
3. Raw tokens, private keys, DEKs, and plaintext document content do not enter database rows,
   responses, logs, audits, outbox payloads, or backup artifacts.
4. Sessionless ceremonies never create a normal Home Source session.
5. Replays, cross-identity use, expired material, and concurrent operations fail closed.
6. Existing Phase A/B behavior remains green and stops at `delivery_pending` until its Phase C
   transition is explicitly enabled.

## C0.1 verified beneficiary contact cases

### Schema and domain

- A kid may have one current non-revoked email contact; parents cannot be beneficiary contact
  subjects in Phase C.
- Addresses are trimmed and normalized to lowercase; malformed addresses are rejected.
- Starting verification persists a 64-character SHA-256 hash and returns the raw token only to
  the caller responsible for immediate delivery.
- Replacing an address revokes the prior contact and replaces every prior usable token.
- Resending verification replaces the prior usable token without changing the address.
- Verification is single-use, contact-bound, expires after seven days, and marks exactly one
  contact verified.

### API and authorization

- Only an authenticated parent may list, start, resend, or revoke member contacts.
- A parent cannot create a contact for another parent, a missing member, or an unsupported
  channel.
- Public token inspection and consumption disclose only recipient name, masked destination,
  status, and expiry.
- Successful verification returns no session cookie and cannot access authenticated routes.
- API responses and audit details never contain a raw token.

### Backup and regression

- Backup export includes contact state and hashed verification records.
- The extracted backup contains no raw verification token.
- Trustee invitation, continuity switch, PKI, backup, and authorization suites remain green.

## C0.2–C0.4 gates

- Trustee contact seeding/replacement preserves verified-control history.
- A proposed trustee replacement leaves the prior address verified until one current,
  single-use proof token confirms the normalized new address; replay, expiry, replacement,
  collision, cross-owner use, and kid use fail closed.
- Confirming a trustee address changes no key or designation, while trustee revocation revokes
  all current contact rows and invalidates outstanding proof tokens.
- Operator transport tests cannot satisfy reachability acknowledgement.
- Acknowledgements are owner/switch/channel/config-version bound and cannot check in or arm on
  their own.
- Each reminder milestone creates independently claimable email and enabled-brrr attempts;
  one channel's blocked or failed result cannot suppress the other.
- Brrr outbox rows contain no reusable target, raw token, recipient data, schedule date, or
  switch state, and outbound payloads remain generic and token-free.
- Repeated scheduling deduplicates attempts, configuration changes supersede queued brrr work,
  and owner retry resets failed channels independently.
- Packet staging creates immutable versioned roster, scope, and full recipient/document matrix
  rows; replacement supersedes rather than edits history, and a newer Letter invalidates a
  packet bound to the prior staged artifact.
- Packet activation fails without current operator reachability, one verified contact per
  recipient, current exact holder/key/designation evidence, and reachable witness trustees.
- The owner-reauthenticated commit activates the Letter and packet pointers atomically; it
  creates no recipient notification, grant, token, session, or unseal behavior.
- Packet activation is all-or-nothing and permanently binds delivery runs to one version.
- The complete route matrix denies non-owner continuity administration and prevents sealed-wrap
  leakage through generic parent routes.
- Staged Letters remain absent from generic routes even for the owner; active/historical Letter
  metadata, files, posture, links, insights, and dependencies remain owner-scoped.
- Ordinary packet-document read/download behavior remains available under normal vault policy,
  but generic responses redact sealed holders and packet-bound mutation requires packet-owner
  authority.
- Backup retains encrypted continuity state without creating a grant, session, unseal action, or
  application restore bypass; no application restore endpoint exists in C0.4.

## C1 gates

- Concurrent trustee notifications produce one action window whose deadline begins after the
  final required successful send.
- Permanent failure blocks release; bounded retry can resume the run without changing history.
- The first valid pause wins and fixes one 30-day deadline; replay/concurrency cannot extend it.
- Owner recovery loses the race after the atomic first-grant activation boundary.

## C2/C3 gates

- Preflight classifies missing, revoked, mismatched, stranded, and healthy items without
  decrypting anything.
- A blocked item blocks its recipient's complete packet while healthy recipient grants proceed.
- Tokens are purpose-bound, replaceable, and cross-grant/cross-recipient use fails uniformly.
- Recipient APIs expose only generic ordinals before local unlock and serve exact grant items.
- Link, session, and grant deadlines are seven days, 60 minutes, and one year respectively;
  replacement never extends the grant deadline.

## C4 completion matrix

- Scheduler and outbox restarts do not duplicate runs, windows, grants, or usable links.
- Backup/restore preserves all durable state from a consistent snapshot.
- Rate-limit and enumeration scenarios return uniform safe responses.
- Full automated suite, browser ceremonies, SMTP delivery, systemd timers, and a
  production-like backup/restore inspection complete without plaintext or token leakage.
