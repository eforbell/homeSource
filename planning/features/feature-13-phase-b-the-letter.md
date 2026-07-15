# Feature #13 Phase B — The Letter and Check-in Switch

Date: 2026-07-15
Status: Implementation-ready plan; design reconciliation complete, execution not started
Parent: `planning/features/feature-13-estate-continuity-phase-a.md`
Design source: `design/homesource-treatment.md`
Depends on: Feature #13 Phase 0/A (shipped and locally verified)

## Outcome

Ship a durable, operator-controlled continuity switch that lets a parent author a
first-class PKI-encrypted letter, save and arm one check-in schedule, check in from
the app or a single-purpose email link, and rely on a daily crash-recoverable job to
send owner reminders and advance overdue state.

Phase B ends at a durable `delivery_pending` handoff. It does **not** notify trustees
or beneficiaries, unseal envelope holders, issue recipient sessions, or serve sealed
key material. Those actions remain Phase C.

## Shipped baseline and constraints

- External trustees have no app sessions; invitation/key registration is token-scoped
  (`server.js:430-470`, `server.js:570-606`).
- Continuity authorization is envelope-canonical. `document_designations` is only a
  relational projection (`db/schema.sql:240-262`, `server.js:1275-1327`).
- Sealing accepts exactly one verified client-produced DEK wrap and preserves existing
  holders under a document lock (`server.js:1286-1320`).
- SMTP is env-configured and safely disabled when incomplete (`lib/mailer.js:36-92`).
- `text/plain` is already a permitted stored file type (`lib/files.js:15-24`), while
  `documents.source_type` needs an additive `authored` value (`db/schema.sql:160-184`).
- The import worker demonstrates process separation, DB-backed claiming, audit, and
  systemd deployment (`bin/import-worker.js:16-38`,
  `deploy/home-source-import-worker.service`).
- Backups explicitly enumerate continuity tables, so every new Phase B table must be
  added deliberately (`lib/backup.js:82-101`).

## Artifact review and commit disposition

| Artifact | Finding | Disposition |
|---|---|---|
| `planning/features/feature-13-estate-continuity-phase-a.md` | Accurate implementation record; status lagged completed manual verification | Keep and update status/Phase B pointer |
| `planning/current-feature.json` | Still described Phase 0 complete / Phase A ready | Update to Phase A complete / Phase B planned |
| `planning/README.md` | Pipeline and `document_designations` invariant were stale | Update before Phase B work |
| `design/homesource-treatment.md` | Strong product voice; May data-model and phase-boundary text was stale | Promote to v2 after reconciling shipped choices |
| `design/homesource.html`, `design/homesource-print.html`, `design/homesource-mockup.css` | Useful mockups, but stale terms/structures remain and local dependencies (`styles.css`, `mockup.css`, `assets/*`, `index.html`) are missing | Do not commit as current design yet; either make them self-contained and sync to v2, or archive them explicitly as May concept renders |

## Phase B decisions

### B13-1 — One active switch per operator

Use one active switch and one escalation chain per parent/operator for v1. Enforce
with a partial unique index over non-cancelled switches. Multiple independent switches
multiply missed-check-in and recipient-confusion risk before the single-chain ceremony
has operational history.

### B13-2 — Phase B cannot deliver

The daily job may send owner reminders and advance an overdue switch to
`delivery_pending`; it cannot notify external recipients or change any envelope holder's
`sealed` value. Phase C consumes the handoff only after hardening decisions #5/#6 and
trustee pause authority are settled.

### B13-3 — The letter is a real encrypted document

Add `authored` to `documents.source_type`. The browser creates a UTF-8 `text/plain`
letter, encrypts it through the existing PKI upload primitives, and seals it to every
selected recipient before the switch can arm. The switch stores `letter_document_id`.
No plaintext letter body is stored in switch tables, events, logs, email, or audit data.

### B13-4 — Replacing a letter is an explicit re-seal ceremony

Do not mutate an armed letter or silently reuse stale wraps. "Update the letter" creates
a replacement encrypted document, seals the current recipient set, and atomically swaps
`letter_document_id` only after every wrap succeeds. The prior letter is archived and the
replacement is audit-logged. A partial ceremony leaves the armed switch unchanged.

### B13-5 — Durable state, derived presentation

Persist only authority-bearing lifecycle states: `draft`, `armed`, `paused`,
`delivery_pending`, `cancelled`. Derive dashboard tones (`healthy`, `approaching`,
`overdue`) from timestamps so UI labels cannot drift from the schedule. Store all
timestamps in UTC; format operator copy with `HOUSEHOLD_TIMEZONE`.

### B13-6 — Idempotent scheduler and transactional outbox

Use a systemd oneshot service + persistent daily timer rather than an in-process
`setInterval`. `bin/deadman-check.js` claims due switches with row locks, records state
events, and inserts uniquely keyed notification-outbox rows transactionally. Delivery
uses deterministic message IDs and retry metadata. This provides at-least-once delivery
with bounded duplicate risk and prevents a restart from skipping a due transition.

### B13-7 — Email check-in is single-purpose, not an app session

Store only SHA-256 token hashes. Email links open a minimal page; GET validates and
renders, POST consumes the token and records the check-in in one transaction. Tokens
expire after seven days, are replaced when a newer reminder is issued, and can only reset
their bound switch. They never create a HomeSource session or disclose schedule details.

## Data model

Add migration `015-continuity-switch.sql` (final number must be confirmed against HEAD):

1. `continuity_switches`
   - `owner_id`, `letter_document_id`, `status`
   - `interval_days`, `grace_period_days`
   - `last_checkin_at`, `next_checkin_due_at`, `delivery_pending_at`
   - `paused_at`, `cancelled_at`, `created_at`, `updated_at`
   - partial unique index: one non-cancelled switch per owner
2. `continuity_recipients`
   - switch FK; member/trustee nullable FKs with XOR + role CHECK
   - notification order/role only; never a crypto-authorization source
   - arming validation requires a matching sealed holder on the letter envelope
3. `continuity_checkin_tokens`
   - switch FK, unique token hash, expiry, consumed/replaced timestamps
   - partial index for the one current usable token
4. `continuity_events`
   - append-only event type, actor/member where applicable, privacy-safe details,
     occurrence timestamp, deterministic dedupe key
5. `continuity_notification_outbox`
   - switch/event FK, operator recipient, type, deterministic message ID, attempt count,
     next attempt, sent/failed timestamps, last error class
   - unique transition/cycle/recipient key

Do not copy `sealed` or access authority into switch/recipient tables. Before arming,
validate the letter envelope and rebuildable designation projection agree.

## Implementation slices

### B0 — Lock the design baseline

- Commit this plan, the v2 Markdown treatment, Phase A status, and planning pointers.
- Keep the three rendered May design files untracked until they are self-contained and
  synchronized, or commit them under an explicit `archive/` label in a separate commit.
- Record Phase A manual evidence: SMTP delivery, trustee registration, and sealing on the
  local test machine.

### B1 — Domain model and pure transition engine

- Add the five tables, constraints, indexes, schema baseline, cleanup fixtures, and backup
  export rows.
- Implement `lib/continuity.js` with clock injection and pure transition decisions.
- Validate interval choices 30/90/180 days for v1; grace defaults to 14 and must be shorter
  than the interval.
- Define reminder milestones: seven days before due, on due date, seven days overdue, and
  grace expiry. Repeated job runs must be no-ops after a milestone is recorded.

### B2 — Authored encrypted letter ceremony

- Add `authored` source type and a letter composer inside a four-step Continuity setup flow.
- Create the letter as a PKI-encrypted `text/plain` document using current browser crypto.
- Require at least one selected recipient with an active key and verify every selected
  recipient has a sealed envelope holder before arming.
- Add the explicit replacement/re-seal path from B13-4; never send letter content to server
  logs, event details, notification templates, or plaintext metadata.

### B3 — Setup wizard and status card

- Build resumable draft steps: recipients, write/review letter, cadence/grace, final review.
- Put switch state on the existing Continuity surface (`public/continuity.html:13-29`) and a
  compact dashboard card.
- Use the design tone table: describe dates and next actions; never speculate why a check-in
  was missed.
- Provide authenticated parent actions: arm, check in, pause/resume, cancel. Re-authenticate
  for pause/cancel if a reusable recent-auth primitive exists; otherwise make that primitive
  an explicit prerequisite rather than weakening the action.

### B4 — Sessionless owner check-in

- Add token issue/replace/validate/consume functions following the trustee invitation's
  hash/expiry/transaction patterns (`lib/trustees.js:22-94`).
- Add content-minimal check-in mail and a nav-free `check-in.html` landing page.
- A valid POST updates `last_checkin_at`, computes the next due timestamp from the check-in
  time, clears `delivery_pending_at` only when policy allows, consumes the token, and writes
  one event/audit record transactionally.
- An authenticated in-app check-in calls the same domain function.

### B5 — Scheduler, outbox, and deployment

- Add `bin/deadman-check.js --once` with an injected clock for tests.
- Add an outbox dispatcher using `lib/mailer.js`; classify permanent validation errors vs.
  transient SMTP failures and cap retries with visible failure state.
- Add `deploy/home-source-continuity-check.service` and `.timer` with `Persistent=true`,
  no overlapping runs, environment file reuse, and journal output.
- Extend `deploy/deploy.sh` and README/runbook instructions to install, enable, manually run,
  and inspect the timer.

### B6 — Operations and observability

- Show last successful scheduler run, next expected run, pending/failed outbox counts, and
  current mail transport readiness to parents without exposing recipient tokens.
- Audit configuration, arming, check-ins, pause/resume/cancel, transition to
  `delivery_pending`, and notification outcomes.
- Add a documented operator recovery path for a missed timer run and failed SMTP delivery.
- Include all Phase B tables in backups and verify extraction contains the complete switch
  state without raw tokens or plaintext letter content.

## Acceptance criteria

1. A parent can save a draft, leave, return, and finish the four-step setup without creating
   duplicate switches or letters.
2. Arming fails unless the letter is PKI-encrypted and every selected recipient has a matching
   active sealed envelope holder; relational rows alone cannot satisfy this check.
3. The database, backup export, logs, audits, and emails contain no plaintext letter body and
   no raw check-in token.
4. In-app and email check-ins call the same transaction and produce the same next-due result.
5. A check-in token is hashed at rest, expires after seven days, is single-use, creates no app
   session, and cannot affect another switch.
6. Running the daily job repeatedly at every milestone produces one event and one outbox row;
   restarting after a missed schedule catches up because the systemd timer is persistent.
7. Before grace expiry, only the operator can receive Phase B reminder email. At grace expiry,
   state becomes `delivery_pending`; trustees/beneficiaries receive nothing and all envelope
   holders remain sealed.
8. SMTP failure leaves a visible retryable outbox record and does not lose or duplicate the
   underlying state transition.
9. Letter replacement is atomic from the switch's perspective: failure during any wrap keeps
   the prior armed letter and recipient set unchanged.
10. Backup extraction preserves the switch, recipients, events, outbox state, and encrypted
    letter/envelope while containing no usable check-in token.
11. Existing Phase A trustee, sealed-designation, PKI posture, recovery, and backup tests remain
    green with envelope-v1 behavior unchanged.

## Verification plan

### Unit

- Clock-injected transition boundary tests, DST/date formatting tests, interval/grace validation
- Token hashing/expiry/replacement/consumption and cross-switch rejection
- Outbox dedupe, retry classification, deterministic message IDs

### Integration/API

- Parent-only draft/config/action routes; kid and unauthenticated rejection
- Envelope-canonical arming validation and stale-projection rejection/rebuild
- Atomic check-in and letter replacement race tests with row locks
- Backup export/extraction of every Phase B table and encrypted letter artifact

### End-to-end

- Local browser: compose, encrypt, seal, arm, check in, replace letter, pause/resume/cancel
- File transport: inspect every scheduled email without network
- Local SMTP test: confirm an owner check-in email arrives and its token works exactly once
- Time-travel harness: advance through approaching, due, overdue, and `delivery_pending`
- Assert a registered trustee and beneficiary receive zero Phase B escalation mail

### Static/operational

- `node --check` for changed browser/server scripts; `npm test` with
  `MAIL_TRANSPORT=disabled` and empty notification recipients
- `git diff --check`; migration against a fresh DB and an upgraded Phase A DB
- `systemd-analyze verify` for the new service/timer when available
- Manual backup extraction inspection; no production restore command is introduced

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| False escalation from missed/duplicate scheduler work | Persistent systemd timer, DB locks, dedupe keys, operator-visible last run |
| Duplicate mail after crash between SMTP acceptance and DB update | Deterministic Message-ID, at-least-once contract, bounded retries, outcome audit |
| Phase B accidentally becomes a delivery path | Explicit `delivery_pending` boundary; tests assert recipients receive nothing and holders stay sealed |
| Plaintext letter leaks through metadata/logging | Browser-side encryption; content-free tables/events/messages; backup/log scans |
| Recipient/key posture changes after arming | Revalidate active key + envelope holder on arm and replacement; Phase C preflight before delivery |
| Multiple parents arm conflicting plans | One active switch per owner plus clear operator identity; household-level arbitration deferred until demonstrated necessary |

## Deferred to Phase C+

- Trustee notification and pause tokens/authority
- Beneficiary notification, recipient ceremony tokens, scoped sessions, and document serving
- Resolution/implementation of revoked-key and stranded-document delivery policy
- Multiple switches or per-document escalation chains
- SMS/push channels
- Shamir/quorum and membership-change re-wrap
- Generated recovery card

## Stop condition

Phase B is complete only when the operator can run the full letter/check-in lifecycle, the
daily scheduler survives restart and deduplicates transitions, local SMTP check-in succeeds,
the backup carries all durable state, the full regression suite is green offline, and an
automated assertion proves no trustee/beneficiary delivery or unsealing occurred.
