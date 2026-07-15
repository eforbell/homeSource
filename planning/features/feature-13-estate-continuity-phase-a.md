# Feature #13: Continuity & Inheritance — Program Charter + Phase A Plan

Date: 2026-07-07
Status: Phase A implementation in progress — A1 data-model foundation complete
Parent: Use Case 2 (estate planning / inheritance) — see design guide
Depends on: Feature #11 PKI foundation + hardening H1-H4.2 (shipped), Feature #12 posture/readiness (shipped)
Design guide: `design/homesource-treatment.md` ("a letter, not a vault", Phases A-E)
Concept origin: `planning/features/feature-11-deadman-switch.md` (2026-05-25 concept capture)
Scope of this doc: program-level charter, survey of what exists today, decision points, and the Phase A implementation plan

---

## Why Feature #13 (a note on numbering)

Feature #11 accumulated ten planning documents across phases 1/2A/2A.1/2A.1B and
hardening H1-H4.2 — the numbering got wonky, but the work shipped and shipped
well. Feature #13 is a deliberate clean slate for **Use Case 2**: continuity and
inheritance planning. It reuses the Feature #11 crypto foundation without
disturbing it, and it follows the phase lettering (A-E) from the design
treatment rather than spawning more #11 suffixes.

Feature #13 = the whole continuity/inheritance program. This document carries
the program charter and the **Phase A** plan. Later phases (B-E) get their own
`feature-13-phase-X` docs when planning begins for each.

---

## Executive summary

The design treatment describes five phases: **A** People & permissions, **B**
The letter (deadman switch), **C** Delivery, **D** Quorum (Shamir), **E**
Break-glass docs. A 2026-07-07 repo survey (below) found the program is much
closer to startable than the May design conversation assumed:

- The **"pre-wrap while competent" ceremony already ships** — the parent-only
  `beneficiary` holder flow wraps a document DEK to another member's key with
  live proof. Sealed envelopes need only a flag and an API gate on top of it.
- The **trigger path needs zero new cryptography** (design Decision 2 is
  already true of the shipped code).
- Phase E is ~80% shipped (offline break-glass CLI verified round-tripping).
- Phase D (Shamir) has a completed library evaluation but zero implementation —
  correctly last per attested threat-model decision D8.
- The genuinely missing pieces are crypto-inert: outbound email, a trustee
  identity surface, the sealed gate, and a reliable long-interval job.

Two decisions in the design treatment conflict with attested threat-model
decisions and need explicit re-attestation before implementation (D13-1,
D13-4 below). Nothing else blocks Phase A beyond ordinary build work.

---

## Survey: what exists TODAY (2026-07-07)

This section is the persistent log of the survey. Each claim carries a source
so future sessions can re-verify instead of re-deriving. Items marked
**needs deeper look** were confirmed to exist but not fully traced.

### Shipped crypto + lifecycle foundation (Use Case 1, complete)

| Capability | Evidence |
|---|---|
| X25519 ECDH + HKDF + AES-KW wrapping, AES-256-GCM DEKs, PRF/passphrase/mnemonic KEKs | `docs/security-capabilities.md` §2.1, `public/pki-crypto.js`, `lib/pki.js` |
| Envelope-canonical authorization: `documents.encryption_metadata.files.*.holders[]`, versioned (`version: 1`), with `policy: { access_model: "any_one_holder", threshold: 1 }` | `docs/security-capabilities.md` §2.2 |
| 1-of-M multi-holder with roles `owner` / `backup` / `beneficiary` | `lib/pki.js:580`, `docs/security-capabilities.md` §4.2 |
| **Cross-member beneficiary holder add — the sealing ceremony's crypto already ships**: parent-only, requires live DEK unwrap + re-wrap to the new holder's public key | `POST /api/documents/:id/pki-holders/add`, validation at `server.js:1009-1016`, `lib/pki.js:620-621` |
| Replace/remove revoked holders without touching ciphertext | `docs/security-capabilities.md` §4.3 |
| Revoke guardrails: dependency preflight, 409 sole-active-holder block, `key.revoke_blocked` audit | H1-H4.2, `server.js:588-636` |
| Key posture/readiness surface: `GET /api/pki/posture`, Settings readiness panel, Test Unlock ceremony updating `last_used_at` | Feature #12, `test/pki-posture-api.test.js` |
| Offline break-glass recovery, verified round-tripping real docs (passphrase + PKI modes) | `bin/decrypt-backup-encrypted-doc.js`, `docs/recovery-runbook.md`, design treatment §5 |
| Full test suite green (299 tests as of 2026-07-04) | `planning/progress.txt` |

### Placeholders intentionally reserved for this program

| Placeholder | State | Notes |
|---|---|---|
| `key_holders` placeholder | **Retired 2026-07-14** | Migration `012-retire-key-holders.sql` drops it only when empty; it had zero application reads and its roles (`owner, cosigner, recovery`) did **not** match shipped PKI roles. Backups no longer export it. Phase A will add the purpose-built `document_designations` projection from D13-3. |
| `timelock` encryption mode | Reserved in CHECK constraint, unimplemented | `lib/encryption-mode.js:3` |
| `document_owners` ownership types `beneficiary`, `custodian` | In schema since migration 001 | `db/schema.sql:193` — ownership-layer (not crypto-layer) designation; relationship to sealed designations **needs deeper look** during Phase A build |
| `policy.threshold` field in envelope | Present, always `1` | Ready to carry M-of-N values in Phase D |

### Decisions already made and attested

| Artifact | Status |
|---|---|
| Threat model D1-D8, all attested by EF 2026-05-22 | `planning/features/feature-11-threat-model.md` — server trust (C: honest-but-curious + integrity checks), key tiers (B+C), quorum sync-first (A — see conflict D13-4), layered recovery (D), plaintext metadata (A), proactive notifications (B — **not yet built**), passkey labeling (B), walk-then-jog scope (B→C) |
| Crypto research complete | `planning/features/feature-11-crypto-research.md` — X25519 (shipped), AES-KW (shipped), **Shamir library selected: Privy `shamir-secret-sharing` with mandatory AES-GCM integrity wrapper** (§3, not yet vendored), WebAuthn PRF matrix (§4) |
| Design treatment v1 with 7 decisions + 5 open questions | `design/homesource-treatment.md` — voice ("letter, not vault"), role model, sealed envelopes, phases A-E, tone table |
| Deadman switch concept + trustee analysis | `planning/features/feature-11-deadman-switch.md` — escalation model, data model sketch, sealed-envelope insight, trustee Option A/B/C analysis |

### Useful infrastructure precedents

- **Long-running worker pattern**: `bin/import-worker.js` + systemd unit
  `deploy/home-source-import-worker.service` — exact precedent for the Phase B
  `bin/deadman-check.js` daily job. The in-process `setInterval` cleanup
  (`server.js:1969`) is *not* adequate for month-scale escalation state.
- **One-time token auth pattern**: share links (`lib/share.js`) — token
  generation, expiry, PIN, use-count. Model for trustee ceremony links.
- **Audit plumbing**: `lib/audit.js` — seal/unseal/ceremony events extend it.
- **BIP39 wordlist already vendored**: `public/bip39-english.txt`.

### Verified gaps (what does NOT exist)

| Gap | Evidence | Blocks |
|---|---|---|
| **No outbound email of any kind** — no SMTP/nodemailer/mail dependency in `package.json`, `lib/`, or env examples | grep survey 2026-07-07 | Phase B escalation, trustee invitations, attested D6-B notifications |
| No notification infrastructure (D6-B attested but unbuilt) | threat model attestation log vs. shipped code | Phase B; partially Phase A (invitations) |
| No trustee identity: `family_members.role` is strictly `parent`/`kid`; no `vault_trustees` table | `db/schema.sql:8` | Phase A |
| No sealed state anywhere — every holder wrapping is servable to its holder today | `lib/pki.js` key-material path; envelope schema §2.2 | Phase A/C |
| No ceremony-token auth surface (one-time registration links, post-trigger access tokens) | — | Phase A (registration), Phase C (delivery) |
| No Shamir implementation (library chosen, nothing vendored) | crypto research §3 | Phase D only |
| No permission-matrix or beneficiary-directory UI | `public/` survey | Phase A |

### Inherited open policy decisions (from hardening plan)

These predate Feature #13 but become **more consequential** once
trustees/beneficiaries hold keys (a beneficiary who revokes their only key
after the operator is gone is the stranding scenario with no living repair
path):

- Hardening open decision #5: recovery-mode access to revoked key material
- Hardening open decision #6: stranded-document recovery policy

Deadline: settle both **before Phase C** (delivery). Not blockers for Phase A.
Source: `planning/features/feature-11-pki-hardening-plan.md` "Open product decisions."

---

## Decision points requiring attestation

Same convention as the threat model: options, recommendation, explicit
sign-off line. D13-1 and D13-4 resolve conflicts between the design treatment
and previously attested decisions; the rest are new.

---

### D13-1: Beneficiary identity model

The feature-11 deadman doc recommended a separate table for **all** external
parties (its Option B). The design treatment (Decision 1) deliberately
diverges: beneficiaries stay `family_members` (they already have suite logins,
avatars, and keypairs); only trustees get the separate `vault_trustees` table.

**Option A: Design treatment position** — beneficiaries are `family_members`,
trustees are `vault_trustees`. Two identity sources; polymorphic holder
references required (D13-2).

**Option B: Original deadman-doc position** — one `vault_trustees`-style table
for every non-operator estate party, including household beneficiaries.
Single external identity source, but duplicates identity for people who
already have accounts and keys.

> **Recommendation**: Option A. The household beneficiaries are already real
> users with registered keys — re-onboarding them into a parallel identity
> table adds surface without adding safety. The trustee stays architecturally
> outside the app (cannot log in), which preserves the least-privilege
> property the original analysis wanted.

**Attest**: Option A.  Eric M Forbell 7/14/2026

---

### D13-2: Polymorphic holder reference shape

With two identity sources, sealed designations must reference either a
`family_members` row or a `vault_trustees` row. Affects the envelope holder
entries, the relational projection (D13-3), and every designation query.
(Design treatment open question #1.)

**Option A: `holder_type` + `holder_id` discriminated pair** — one pattern in
both the envelope and the projection table. No FK integrity on the polymorphic
pair (enforced in application code + CHECK constraint on `holder_type`).

**Option B: Two nullable FKs (`member_id`, `trustee_id`) + XOR CHECK** — real
FK integrity, slightly clumsier queries, existing envelope entries keep
`member_id` untouched.

> **Recommendation**: Option B for the relational projection (FK integrity is
> worth it in Postgres) and **additive** fields in the envelope: existing
> `member_id` stays for member holders; trustee holders carry `trustee_id`
> instead. Envelope `version` bumps to 2 when the first sealed/trustee entry
> is written to a document; version-1 envelopes remain valid forever.

**Attest**: Option B.  Eric M Forbell 7/14/2026

---

### D13-3: Fate of the reserved `key_holders` table

The reserved table's shape (roles `owner/cosigner/recovery`, FK to
`encryption_keys` not documents, no sealed state, no polymorphism) matches
neither shipped PKI nor the Phase A design. The *concept* of a relational
holder projection is load-bearing; the specific table is not.

**Option A: Evolve `key_holders` in place** — migrations rewrite roles, add
polymorphic columns, add sealed state. Preserves the day-1 name; carries dead
weight and a misleading migration history.

**Option B: New purpose-built projection table (e.g. `document_designations`),
drop `key_holders`** — clean shape: document FK, polymorphic holder (per
D13-2), role, `sealed` state, `sealed_until`, timestamps. Explicitly a
rebuildable projection of the envelope, never the crypto source of truth.

> **Recommendation**: Option B. The hardening plan's warning was against
> *casually* dropping the placeholder — replacing it deliberately with the
> table it was reserved *for* honors the intent. The same migration removes
> `key_holders` from backup export (closing hardening backlog #15/#16).

**Attest**: Option B.  Eric M Forbell 7/14/2026

---

### D13-4: Quorum reconstruction — re-attestation of threat model D3

Threat model D3 was attested 2026-05-22 as Option A (synchronous, v1). The
design treatment Decision 4 specifies **asynchronous** server-coordinated share
aggregation (each holder contributes via their own link over hours/days; the
last-arriving holder reconstructs client-side; server never sees plaintext
shares). The threat model itself anticipated async as its "Option C
inheritance ceremony — strong v2." Since no quorum code has shipped, this is a
paper conflict, but an attested security decision should not be silently
superseded.

**Option A: Re-attest async as the Phase D ceremony model** (design Decision 4
becomes controlling; D3's sync attestation is recorded as superseded).

**Option B: Keep D3 sync for Phase D v1** — ship synchronous gathered-family
reconstruction first; async ceremony later. Slower path to the realistic
inheritance scenario (participants rarely co-located).

> **Recommendation**: Option A. The inheritance ceremony is the entire point
> of Phase D, and the design's aggregator model keeps the server
> crypto-inert. Record the supersession in the threat model's attestation log
> when attested here.

**Attest**: Option A.  Eric M Forbell 7/14/2026

---

### D13-5: Outbound email transport

First mail capability in the app. Serves trustee invitations (Phase A),
check-in reminders + escalation (Phase B), and D6-B proactive notifications.

**Option A: Env-configured SMTP relay** (`SMTP_HOST/PORT/USER/PASS/FROM` +
nodemailer or similar) — operator points it at any relay they trust (self-hosted,
Fastmail, SES SMTP). Sovereign, provider-agnostic, offline-testable with a
console/file transport in dev and tests.

**Option B: Transactional email API integration** (Postmark/SES API) — better
deliverability analytics, but couples a sovereignty-focused app to a vendor
API and an API key with broader blast radius.

> **Recommendation**: Option A, wrapped in a small `lib/mailer.js` with a
> null/log transport when unconfigured — pages must degrade gracefully (the
> deadman doc's open question #4 becomes: configured SMTP is a precondition
> shown in the Phase B setup wizard, not an assumption).

**Attest**: Option A.  Eric M Forbell 7/14/2026

Eric's note - our family runs a mail server for all parties involved. So we can have relatively assured privacy using our postfix/dovecot family mail server.

---

### D13-6: Where sealed state lives

**Option A: Envelope-canonical** — `sealed: true` + `sealed_until` on the
holder entry inside `encryption_metadata`; the projection table mirrors it.
Consistent with the repo's envelope-canonical invariant (`planning/README.md`
design invariants); sealed state travels with backups; the key-material and
document-serving gates read the envelope.

**Option B: Relational-only** — sealed state lives only in the projection
table. Simpler queries, but the envelope no longer fully describes who can be
served what, and a projection rebuild could silently unseal.

> **Recommendation**: Option A. The failure mode of B (rebuild-induced
> unseal) is exactly the class of bug the envelope-canonical rule exists to
> prevent.

**Attest**: Option A.  Eric M Forbell 7/14/2026

---

## Phase 0: enablers (small, before or alongside Phase A)

1. `lib/mailer.js` + env config + dev/test transport (per D13-5)
2. Minimal notification dispatch on key events (registration, revocation,
   holder add) — **complete 2026-07-14**; retires the attested-but-unbuilt D6-B
   at basic level
3. `key_holders` disposition migration (per D13-3) including backup-export
   cleanup — **complete 2026-07-14**; closes hardening backlog #15/#16
4. Attest D13-1 through D13-6; record D13-4 supersession in the threat model
   attestation log

Each is independently shippable and none touches shipped crypto behavior.

---

## Phase A: People & permissions — implementation plan

Design treatment §7 Phase A, adapted to the survey findings. **Ships on its
own**: households see designated-document counts and registered
trustee/beneficiary keys before any switch exists.

### A1. Data model

New (names final after D13-2/D13-3 attestation):

```sql
CREATE TABLE vault_trustees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  relationship TEXT,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'registered', 'revoked')),
  created_by INT NOT NULL REFERENCES family_members(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE trustee_invitations (
  id SERIAL PRIMARY KEY,
  trustee_id INT NOT NULL REFERENCES vault_trustees(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,          -- share-link pattern: store hash, not token
  expires_at TIMESTAMPTZ NOT NULL,   -- 7 days per design §3.3
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE document_designations (  -- projection; envelope stays canonical
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  member_id INT REFERENCES family_members(id),
  trustee_id INT REFERENCES vault_trustees(id),
  role TEXT NOT NULL CHECK (role IN ('beneficiary', 'trustee')),
  sealed BOOLEAN NOT NULL DEFAULT TRUE,
  sealed_until TEXT NOT NULL DEFAULT 'deadman_trigger',
  encryption_key_id INT REFERENCES encryption_keys(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((member_id IS NULL) <> (trustee_id IS NULL)),
  UNIQUE (document_id, encryption_key_id)
);
```

Trustee keys: reuse `encryption_keys` with nullable `trustee_id` column added
(same registration crypto as members; `member_id` becomes nullable with an
XOR CHECK). **Needs deeper look**: every `encryption_keys` query in `lib/pki.js`
assumes `member_id` — audit before writing the migration.

### A2. Envelope additions (version 2, additive)

Holder entries gain optional `trustee_id` (instead of `member_id`),
`sealed: true`, `sealed_until: "deadman_trigger"`. Gates to add:

- `getMemberKeyMaterial` equivalent for trustees is **ceremony-token scoped
  only** — no standing route
- Document serving + key-info routes exclude sealed holders from
  unlock-eligible sets (they may appear, labeled, in the operator's view)
- Sealing/unsealing writes audit events (`designation.sealed`,
  `designation.unsealed`, `trustee.invited`, `trustee.registered`)

The sealing ceremony itself is the **existing** add-holder flow (live DEK
proof, re-wrap) with `sealed: true` on the new entry — parent-only, per
shipped authorization rules.

### A3. Trustee registration ceremony

Invitation (operator side) → one-time emailed link (Phase 0 mailer; letter
voice per design §3.3 — from the operator's name, never revealing vault
contents) → ceremony landing page (no nav, no app session) → WebAuthn/passphrase
key registration reusing `public/pki-crypto.js` → confirmation to operator.
Token semantics follow `lib/share.js` patterns (hashed at rest, single-use,
7-day expiry).

### A4. Beneficiary directory (mobile-responsive)

`family_members` + key posture (reuse Feature #12 posture data) + designated
count per person computed from `document_designations`. Registered trustees
listed in a separate section with status. Adding a person here grants
nothing — it makes them addressable (design §3.1).

### A5. Permission matrix (desktop-only by design)

Documents × recipients grid; tapping a cell runs the sealing ceremony (A2)
and writes both the envelope holder entry and the projection row. Cell
states: none / sealed-designated / (Phase D: quorum participant). Quorum
cells render but stay disabled until Phase D.

### A6. Tests

- Trustee invite/registration: token single-use, expiry, revoked-trustee
  rejection, no session issued
- Sealed holder: excluded from unlock eligibility and key-material serving;
  visible-labeled to parent; envelope v2 round-trips through backup/restore
- Designation projection: consistent with envelope after seal, rebuildable,
  count queries correct
- Regression: all Feature #11/#12 PKI suites stay green (envelope v1 docs
  untouched)

### Acceptance criteria

1. Operator can invite a trustee, who registers a key via one-time ceremony
   without ever holding an app session
2. Operator can seal a document to a beneficiary or trustee; the recipient
   cannot access it through any route
3. Beneficiary directory shows accurate designated counts and key posture
4. All seal/invite/register events are audit-logged
5. Existing PKI behavior is unchanged (full suite green)

### Non-goals for Phase A

Deadman switch and check-ins (Phase B) · letter wizard (Phase B) · trigger,
delivery, ceremony access tokens for *unlocking* (Phase C) · Shamir/quorum
(Phase D) · recovery card generation (Phase E) · resolution of hardening open
decisions #5/#6 (required before Phase C, tracked above).

---

## Phase map (program view)

| Phase | Content | Readiness after this survey |
|---|---|---|
| 0 | Mailer, notifications, `key_holders` disposition, attestations | All small; no crypto |
| A | Trustees, directory, matrix, sealed designations | **This doc**; closest to startable |
| B | Letter wizard, check-in, status card, `bin/deadman-check.js` | Unblocked once Phase 0 email lands; worker precedent exists |
| C | Trustee notify + pause, beneficiary trigger, scoped single-doc delivery | Needs A + B; settle hardening #5/#6 first |
| D | Shamir quorum, async ceremony (per D13-4), re-wrap on member change | Library chosen; highest risk; keep last |
| E | Generated recovery card | ~80% shipped already |

---

## Open questions carried forward

From the design treatment (§8): escalation-chain depth (recommend one chain
per switch for v1), letter re-seal UX (recommend explicit re-seal step),
trustee pause authority (recommend single trustee pauses, only operator
cancels), recovery card generated-vs-static (leaning generated). These bind in
Phase B/C planning, not Phase A.

---

## Next steps

1. **Complete (2026-07-14):** Eric attested D13-1 through D13-6 (this document).
2. **Complete (2026-07-14):** Phase 0 SMTP mailer — `lib/mailer.js`, env-configured SMTP with TLS required by default, disabled fallback, and explicit console/file inspection transports.
3. **Complete (2026-07-14):** Phase 0 basic notification dispatch (registration, revocation, holder add).
4. **Complete (2026-07-14):** Phase 0 `key_holders` disposition migration and backup-export cleanup.
5. **Complete (2026-07-14):** `encryption_keys` member-assumption audit and
   A1 data-model foundation (trustees, invitations, trustee key ownership, and
   sealed designation projection).
6. Continue Phase A implementation per plan: invitation ceremony, sealed
   envelope v2, directory, and permission matrix.

### Implementation record — 2026-07-14: Phase A A1 data-model foundation

- Audited every current `encryption_keys.member_id` use. The established PKI
  registration, key-material, WebAuthn, and holder-management paths are
  intentionally household-member scoped; this work leaves them unchanged.
  Trustee-specific ceremony and key-serving paths will be additive and scoped
  to a one-time invitation token rather than weakening those routes.
- Added migration `013-phase-a-trustee-designations.sql`: external
  `vault_trustees`, hashed-token `trustee_invitations`, trustee-owned
  `encryption_keys`, and envelope-projection `document_designations` with real
  foreign keys and principal/role XOR constraints.
- `document_designations` defaults to `sealed = true` and
  `sealed_until = deadman_trigger`; it remains a rebuildable projection, not
  the source of cryptographic authorization. Envelope v2 writing is deferred
  to A2 so existing version-1 PKI behavior remains untouched.
- Added a small trustee repository and regression coverage for external
  principals, trustee key ownership, sealed beneficiary projection, and
  invalid mixed-principal rows. The full suite passed (319 tests).

### Implementation record — 2026-07-14: Phase A trustee invitation ceremony

- Added parent-only trustee creation, listing, and revocation APIs. Inviting a
  trustee creates a random 256-bit token, stores only its SHA-256 hash, and
  expires it after seven days. The email link is built from the required
  canonical `APP_URL`; the response never exposes the raw token.
- Added an intentionally sessionless `trustee-invite.html` landing page. It
  generates an X25519 keypair and passphrase-wraps the private key locally,
  then uses the one-time invitation only to register the public key and wrapped
  private material. No app session or document access is granted.
- Registration locks and consumes the token in the same transaction that
  creates the trustee-owned key and changes trustee status to `registered`.
  Expired, used, and revoked invitations are uniformly rejected. Invite,
  registration, and revocation events are audit-logged.
- The invitation email is deliberately content-free: it says only that the
  operator asked the recipient to prepare a continuity key. SMTP remains
  best-effort per Phase 0; its delivery result is captured in the invite audit
  record.

### Implementation record — 2026-07-14: Phase A sealed designations + directory

- Added additive envelope v2 support for sealed holder entries. A dedicated
  parent-only seal route accepts exactly one new holder, verifies its identity,
  active key, fingerprint, and client-produced DEK wrap, then writes the
  envelope and relational designation projection in the same transaction.
- Sealed holders remain visible to parents as labeled key-info entries but are
  marked `unlock_eligible: false`. Sealed household beneficiaries are excluded
  from document lists and all document-serving routes, even if they previously
  had ownership metadata. An explicit parent unseal route reverses that gate
  and records `designation.unsealed`.
- Added the Continuity page: a responsive people directory with current key and
  designation counts, plus a document × recipient matrix showing sealed state.
  The live wrapping ceremony remains on the encrypted-document surface; Phase
  C is the first phase that can turn a sealed cell into delivery authority.
- **Threat boundary:** sealing is an application access-control gate, not a
  new encryption primitive. The recipient's DEK wrap is stored now so no
  post-trigger re-wrap is needed; therefore a database backup plus that
  recipient's private key can decrypt it outside Home Source. Phase A protects
  normal product routes, while Phase C defines delivery authority. Because
  parents intentionally retain household-wide app access, Phase A only permits
  sealed beneficiary designations to household kids; a parent beneficiary
  would otherwise be falsely shown as gated.

### Implementation record — 2026-07-14: Phase 0 SMTP mailer

- Added `lib/mailer.js` using Nodemailer SMTP, with relay settings read only
  from `SMTP_*` environment variables. It makes no network connection unless
  both `SMTP_HOST` and `SMTP_FROM` are configured.
- TLS is required by default; SMTP authentication is optional but its username
  and password must be configured as a pair. The transport disables URL and
  filesystem content access.
- Added explicit `MAIL_TRANSPORT=console` and `MAIL_TRANSPORT=file` transports
  for offline development/test inspection. File messages are written as
  owner-only `.eml` files under `MAIL_OUTPUT_DIR` (default `data/mail`).
- Added regression tests for disabled fallback, SMTP configuration/delivery,
  partial-credential rejection, safe file output, and header-injection input
  rejection. The full suite passed (307 tests).

### Implementation record — 2026-07-14: Phase 0 key-holder placeholder retirement

- Added migration `012-retire-key-holders.sql`. It drops the unused placeholder
  only when it is empty, failing closed if a deployment has unexpected data
  requiring a deliberate migration.
- Removed the table from the current schema baseline, test cleanup, and backup
  export. Existing PKI authorization remains envelope-canonical and unchanged.
- Added regression coverage that verifies the table is absent and backup
  archives omit it.

### Implementation record — 2026-07-14: Phase 0 key-event notifications

- Added `lib/notifications.js`, which sends generic key-event transparency
  notices to the trusted, comma-separated `NOTIFICATION_TO` recipients through
  the Phase 0 mailer. Notices never include document contents.
- Wired direct key registration, WebAuthn key finalization, revocation, and
  holder addition. Every attempt is audit-logged; absent recipients or SMTP
  configuration safely records a non-delivery result without interrupting the
  underlying key operation.
- This satisfies D6-B at the Phase 0 basic level. Phase A/C will add trustee
  and recipient-specific invitations/delivery messages.
