# Feature #13 Phase B — The Letter and Check-in Switch

Date: 2026-07-15
Status: Implemented through automated verification; operator/browser/SMTP/systemd acceptance pending
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

## Implementation record — 2026-07-15

Implemented the Phase B domain, migration, encrypted authored-letter staging and atomic
commit/replacement, parent-only APIs, sessionless single-purpose check-in route, browser
setup/status UI, dashboard entry point, durable scheduler/outbox workers, systemd units,
backup snapshot coverage, operational status/retry surfaces, and runbook.

Automated evidence:

- Fresh database applied all 15 migrations and exposed the continuity switch/outbox tables.
- Targeted continuity suites passed 10 tests, including operation replay, single-use token,
  staged-letter replacement, envelope validation, lifecycle, catch-up, and backup assertions.
- Full offline regression suite passed 340 tests across 93 suites with zero failures.
- Both production worker entry points completed successful no-work runs against the test DB.
- Changed Node/browser scripts parsed, `git diff --check` passed, and worker executables have
  executable mode bits.

Remaining acceptance is operator/environment-only: exercise the real browser key ceremony,
deliver and consume a link through configured SMTP, install/verify the timers on the Linux
host, and inspect a real backup/restore artifact. Phase B remains pending those checks rather
than claiming the stop condition is fully satisfied.

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

The raw token is minted only when the outbox dispatcher claims a reminder attempt. In one
short transaction, the dispatcher invalidates the switch's prior usable token, stores the
new token hash, and records the claimed attempt; the raw token exists only in process memory
while that attempt's message is composed and sent. A retry mints a replacement token and
invalidates the prior link. Therefore an SMTP-accepted message followed by a dispatcher
crash can produce a second email, but only the newest delivered link remains usable. The
deterministic message ID includes the outbox row and attempt number so retry bodies with a
new link are not incorrectly collapsed as the same message.

### B13-8 — Reminder destination and mail readiness are explicit switch inputs

`family_members` has no email address, and the existing comma-separated `NOTIFICATION_TO`
setting is for generic household key-event transparency alerts. Do not infer a switch owner
from that setting. Store one normalized `reminder_email` on each switch, entered and
confirmed by the owning parent during setup. It is operator-only Phase B data and must never
be populated from a trustee or beneficiary record.

Arming requires a non-disabled mail transport, a valid `SMTP_FROM`, a valid reminder
address, and a canonical `APP_URL` that passes the existing HTTPS/localhost rules. SMTP
verification is shown as readiness evidence but a transient live `verify()` failure does
not by itself mutate an already armed switch. Console/file transports satisfy the gate only
in explicit local development or test mode. If transport becomes disabled after arming,
due state still advances, the outbox item becomes visibly `blocked_configuration`, and no
recipient fallback is attempted.

### B13-9 — Lifecycle transitions and schedule arithmetic are closed-set

The domain layer enforces this transition table under a switch row lock:

| Current | Action/event | Result | Required side effects |
|---|---|---|---|
| none | save draft | `draft` | Create one owner-bound draft switch |
| `draft` | arm | `armed` | Activate the staged letter, set first due timestamp, record event |
| `armed` | check in | `armed` | Consume/invalidate usable token, set last/next check-in, supersede stale reminder mail |
| `armed` | pause | `paused` | Invalidate usable token and suppress/cancel unsent reminder outbox rows |
| `paused` | resume | `armed` | Set next due from resume time and record a new schedule cycle |
| `armed` or `paused` | cancel | `cancelled` | Invalidate token and cancel unsent reminder mail; retain history and encrypted letters |
| `armed` | grace expires | `delivery_pending` | Set handoff timestamp and send only an operator boundary notice |

`delivery_pending` is terminal in Phase B: check-in, pause, resume, replacement, and token
issuance are rejected. Phase C must define an explicit handoff-resolution transition rather
than silently clearing it. `cancelled` is also terminal, but its partial unique-index
exclusion lets the same owner create a new draft switch.

Intervals are 30/90/180 calendar days. Grace is an integer of at least seven days and less
than the interval, defaulting to 14. Due timestamps preserve the operator's local wall-clock
time across calendar-day addition in `HOUSEHOLD_TIMEZONE`, then persist the resolved instant
as UTC. Resume starts a fresh interval from the resume instant; it does not immediately
replay time spent paused. UI tones are derived only for `armed`: `healthy`, `approaching`,
and `overdue`. `draft`, `paused`, `delivery_pending`, and `cancelled` render as explicit
lifecycle labels, not as one of those tones.

If downtime crosses multiple milestones, record each missing milestone event for an honest
timeline but enqueue only the newest applicable unsent owner reminder for that schedule
cycle. Earlier unsent reminder rows become `superseded`. Grace expiry always wins, moves the
switch to `delivery_pending`, and creates a content-minimal operator boundary notice without
a check-in link. When seven-days-overdue and grace expiry coincide, the boundary notice is
the only email.

### B13-10 — Authored letters use an encrypted staging slot

An incomplete ceremony uses `continuity_switches.staged_letter_document_id`; the active
`letter_document_id` remains unchanged until the ceremony commits. Staged documents use a
new `documents.status = 'staged'`, are excluded from ordinary lists, search, dashboard
counts, MagicIndex, sharing, and non-continuity routes, and are addressable only through
parent-only switch endpoints. Each switch has at most one staged letter. Mutation endpoints
accept a client operation key so retries return the existing staged result instead of
creating duplicate documents or files.

Every letter envelope must contain at least one active, unsealed holder belonging to the
owning parent plus one active, sealed holder for every selected beneficiary/trustee. The
owner holder is not duplicated in `continuity_recipients`. Household beneficiary recipients
must be kids; parents cannot be modeled as sealed beneficiaries because parents retain
household-wide access. Recipient additions/removals on an armed or paused switch are the
same explicit replacement/re-seal ceremony as editing the letter body: create a staged
encrypted replacement, validate the complete proposed recipient set, then atomically swap
the letter pointer and recipient rows. No in-place armed-envelope edits are allowed.

The browser never writes letter plaintext to `localStorage`, `sessionStorage`, IndexedDB,
URLs, analytics, logs, or server metadata. Leaving before encryption loses the unsaved text;
resuming after step 2 decrypts the staged encrypted document locally with the owner's key.
The commit transaction activates the staged document, swaps the switch pointer/recipients,
archives the previous letter when present, and records events/audit. Failed database work
removes newly staged filesystem artifacts; failed filesystem cleanup is surfaced as a
security-relevant recovery item without changing the armed switch.

### B13-11 — Sensitive actions use same-request re-authentication

There is no existing recent-auth grant primitive, and a normal HomeSource session lasts 30
days. Do not infer recent authentication from session age. Arming, letter/recipient
replacement, pause, and cancel require the owning parent to submit the current login
passphrase in the same HTTPS request as the action. The server verifies it and completes or
rejects the action immediately; no reusable action token, passphrase log, audit detail, or
persistent grant is created. A parent must establish a login passphrase before arming.

## Data model

Add migration `015-continuity-switch.sql` (confirmed as the next number against HEAD on
2026-07-15):

1. `continuity_switches`
   - `owner_id`, `reminder_email`, `letter_document_id`, `staged_letter_document_id`, `status`
   - `interval_days`, `grace_period_days`, monotonically increasing `schedule_cycle`
   - `last_checkin_at`, `next_checkin_due_at`, `delivery_pending_at`
   - `paused_at`, `cancelled_at`, `created_at`, `updated_at`
   - partial unique index: one non-cancelled switch per owner
2. `continuity_recipients`
   - switch FK; member/trustee nullable FKs with XOR + role CHECK
   - notification order/role only; never a crypto-authorization source
   - arming validation requires a matching sealed holder on the letter envelope
3. `continuity_checkin_tokens`
   - switch FK, schedule cycle, unique token hash, expiry, consumed/replaced timestamps
   - partial index for the one current usable token
4. `continuity_events`
   - append-only event type, actor/member where applicable, privacy-safe details,
     occurrence timestamp, deterministic dedupe key; client operation keys are persisted
     here for mutation replay protection
5. `continuity_notification_outbox`
   - switch/event FK, operator recipient, type, deterministic message ID, attempt count,
     next attempt, claim owner/expiry, sent/failed/blocked/superseded timestamps, last safe
     error class
   - unique switch/schedule-cycle/type/recipient key
6. `continuity_scheduler_runs`
   - job type (`state_advance` or `outbox_dispatch`), start/completion timestamps, status,
     claimed/transition/sent/failed counters, and safe error class
   - records successful no-work runs so the application can distinguish healthy idleness
     from a scheduler that stopped running

Do not copy `sealed` or access authority into switch/recipient tables. Before arming,
validate the letter envelope and rebuildable designation projection agree.

The schema also adds `staged` to `documents.status`. Staged continuity documents must be
excluded by default from every generic read surface, not merely hidden in the browser.

## Implementation slices

### B0 — Lock the design baseline

- Commit this plan, the v2 Markdown treatment, Phase A status, and planning pointers.
- Keep the three rendered May design files untracked until they are self-contained and
  synchronized, or commit them under an explicit `archive/` label in a separate commit.
- Record Phase A manual evidence: SMTP delivery, trustee registration, and sealing on the
  local test machine.

### B1 — Domain model and pure transition engine

- Add the six tables, constraints, indexes, schema baseline, cleanup fixtures, and backup
  export rows.
- Implement `lib/continuity.js` with clock injection and pure transition decisions.
- Implement the B13-9 transition table and timezone-aware calendar arithmetic.
- Validate interval choices 30/90/180 days for v1; grace defaults to 14, is at least seven,
  and must be shorter than the interval.
- Define reminder milestones: seven days before due, on due date, seven days overdue, and
  grace expiry. Repeated job runs must be no-ops after a milestone is recorded; catch-up
  coalesces email as defined in B13-9.

### B2 — Authored encrypted letter ceremony

- Add `authored` source type and a letter composer inside a four-step Continuity setup flow.
- Create the letter as a PKI-encrypted `text/plain` document using current browser crypto.
- Add the staged-document slot, operation-key idempotency, generic-route exclusion, and
  compensating filesystem cleanup from B13-10.
- Require an active unsealed owning-parent holder, at least one selected recipient with an
  active key, and a matching sealed envelope holder for every selected recipient before
  arming.
- Add the explicit replacement/re-seal path from B13-4; never send letter content to server
  logs, event details, notification templates, or plaintext metadata.

### B3 — Setup wizard and status card

- Build resumable draft steps: recipients, write/review letter, cadence/grace, final review.
- Put switch state on the existing Continuity surface (`public/continuity.html:13-29`) and a
  compact dashboard card.
- Use the B13-9 state/tone mapping: describe dates and next actions; never speculate why a
  check-in was missed.
- Provide authenticated parent actions: arm, check in, pause/resume, cancel. Re-authenticate
  in the same request for arm, replacement, pause, and cancel as defined in B13-11.
- Capture and confirm the switch-specific reminder address, then block arming until the
  B13-8 configuration gate passes.

### B4 — Sessionless owner check-in

- Add token issue/replace/validate/consume functions following the trustee invitation's
  hash/expiry/transaction patterns (`lib/trustees.js:22-94`).
- Add content-minimal check-in mail and a nav-free `check-in.html` landing page.
- Mint raw tokens only inside a claimed dispatch attempt as defined in B13-7.
- A valid POST on an `armed` switch updates `last_checkin_at`, computes the next due timestamp
  from the check-in time, consumes the token, supersedes stale reminder mail, and writes one
  event/audit record transactionally. Phase B never clears `delivery_pending_at`.
- An authenticated in-app check-in calls the same domain function.
- Set `Cache-Control: no-store` on the landing page and token APIs; use no-referrer policy,
  uniform invalid/expired/used responses, bounded per-IP failure throttling, and token-free
  logs. GET may validate and render but never consumes; only POST consumes.

### B5 — Scheduler, outbox, and deployment

- Add `bin/deadman-check.js --once` with an injected clock for tests.
- Add an outbox dispatcher using `lib/mailer.js`; extend the mailer result contract to expose
  a bounded safe error class and retryability without persisting SMTP response text.
- Run state advancement with a persistent daily timer and outbox dispatch with a separate
  persistent 15-minute timer. Both use a process-wide PostgreSQL advisory lock plus row-level
  `SKIP LOCKED` claims; a crashed claim lease becomes eligible after 15 minutes.
- Retry transient failures with exponential backoff at 15 minutes, one hour, six hours, then
  24 hours, capped at six attempts. Permanent address/validation failures become `failed`;
  disabled/missing transport becomes `blocked_configuration` without consuming retry budget.
  Parent UI exposes a manual retry after configuration repair.
- Add `deploy/home-source-continuity-check.service` and `.timer` with `Persistent=true`,
  plus matching `home-source-continuity-outbox.service` and `.timer`, with no overlapping
  runs, environment file reuse, and journal output.
- Extend `deploy/deploy.sh` and README/runbook instructions to install, enable, manually run,
  and inspect both timers.

### B6 — Operations and observability

- Show last successful scheduler run, next expected run, pending/failed outbox counts, and
  current mail transport readiness to parents without exposing recipient tokens.
- Audit configuration, arming, check-ins, pause/resume/cancel, transition to
  `delivery_pending`, and notification outcomes.
- Add a documented operator recovery path for a missed timer run and failed SMTP delivery.
- Export the Phase B relational state from one read-only `REPEATABLE READ` transaction so a
  backup cannot mix switch, recipient, event, outbox, document, envelope, or file-record
  versions from different moments. Include token hashes and encrypted staged artifacts when
  present, but never a raw token, action passphrase, SMTP credential, or transient in-memory
  mail body. Verify every referenced stored file is present in the archive manifest.

## Acceptance criteria

1. A parent can save a draft, leave, return, and finish the four-step setup without creating
   duplicate switches or letters, and no plaintext draft is persisted in browser or server
   storage.
2. Arming fails unless the letter is PKI-encrypted, the owning parent has an active unsealed
   holder, and every selected recipient has a matching active sealed envelope holder;
   relational rows alone cannot satisfy this check.
3. The database, backup export, logs, audits, and emails contain no plaintext letter body and
   no raw check-in token.
4. In-app and email check-ins call the same transaction and produce the same next-due result.
5. A check-in token is hashed at rest, expires after seven days, is single-use, creates no app
   session, cannot affect another switch, and exists raw only in dispatcher/request memory.
6. Running the daily job repeatedly at every milestone produces one event and one outbox row;
   restarting after a missed schedule catches up because the systemd timer is persistent,
   while multiple crossed milestones produce one newest-applicable email.
7. Before grace expiry, only the operator can receive Phase B reminder email. At grace expiry,
   state becomes `delivery_pending`; trustees/beneficiaries receive nothing and all envelope
   holders remain sealed.
8. SMTP failure leaves a visible retryable outbox record and does not lose or duplicate the
   underlying state transition.
9. Letter replacement is atomic from the switch's perspective: failure during any wrap keeps
   the prior armed letter and recipient set unchanged; the same rule covers recipient edits.
10. Backup extraction preserves the switch, recipients, events, outbox state, and encrypted
    letter/envelope from one consistent database snapshot while containing no usable check-in
    token.
11. Existing Phase A trustee, sealed-designation, PKI posture, recovery, and backup tests remain
    green with envelope-v1 behavior unchanged.
12. Pause, resume, cancel, and `delivery_pending` obey the closed transition table; pausing or
    cancelling invalidates tokens and suppresses unsent reminder mail, and Phase B cannot
    reverse `delivery_pending`.
13. Arming, replacement, pause, and cancel fail without same-request owner passphrase
    verification; passphrases and reusable action grants are never stored.
14. The parent can see fresh successful/no-work timestamps for both scheduler jobs, and a
    stopped timer or configuration-blocked outbox is distinguishable from healthy idleness.

## Verification plan

### Unit

- Clock-injected transition boundary tests, DST/date formatting tests, interval/grace validation
- Token hashing/expiry/replacement/consumption and cross-switch rejection
- Outbox dedupe, retry classification, deterministic message IDs
- Full state/action matrix, catch-up coalescing, pause/resume schedule reset, terminal-state rejection
- Same-request passphrase verification and proof that passphrases never reach audit/event details

### Integration/API

- Parent-only draft/config/action routes; kid and unauthenticated rejection
- Envelope-canonical arming validation and stale-projection rejection/rebuild
- Atomic check-in and letter replacement race tests with row locks
- Operation-key replay, staged-document visibility exclusion, recipient-edit/replacement races,
  and filesystem cleanup failure handling
- Backup export/extraction of every Phase B table and encrypted letter artifact from a
  concurrent-mutation `REPEATABLE READ` snapshot

### End-to-end

- Local browser: compose, encrypt, seal, arm, check in, replace letter, pause/resume/cancel
- File transport: inspect every scheduled email without network
- Local SMTP test: confirm an owner check-in email arrives and its token works exactly once
- Retry-after-acceptance simulation: the prior link becomes unusable and the newest retry works
- Time-travel harness: advance through approaching, due, overdue, and `delivery_pending`
- Assert a registered trustee and beneficiary receive zero Phase B escalation mail

### Static/operational

- `node --check` for changed browser/server scripts; `npm test` with
  `MAIL_TRANSPORT=disabled` and empty notification recipients
- `git diff --check`; migration against a fresh DB and an upgraded Phase A DB
- `systemd-analyze verify` for both services/timers when available; prove successful no-work
  run heartbeats and expired-lease recovery
- Manual backup extraction and plaintext/raw-token scans; no production restore command is
  introduced

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| False escalation from missed/duplicate scheduler work | Persistent systemd timer, DB locks, dedupe keys, operator-visible last run |
| Duplicate mail after crash between SMTP acceptance and DB update | Deterministic Message-ID, at-least-once contract, bounded retries, outcome audit |
| Hashed-only token cannot be placed in deferred email | Mint raw token only in claimed dispatch attempt; persist hash only; replace link on retry |
| Phase B accidentally becomes a delivery path | Explicit `delivery_pending` boundary; tests assert recipients receive nothing and holders stay sealed |
| Plaintext letter leaks through metadata/logging | Browser-side encryption; content-free tables/events/messages; backup/log scans |
| Incomplete or retried ceremony exposes duplicate letters | One hidden staged slot per switch, operation-key idempotency, compensating file cleanup |
| Recipient/key posture changes after arming | Revalidate active key + envelope holder on arm and replacement; Phase C preflight before delivery |
| Multiple parents arm conflicting plans | One active switch per owner plus clear operator identity; household-level arbitration deferred until demonstrated necessary |
| Backup captures an internally inconsistent multi-table state | Read-only `REPEATABLE READ` export and referenced-file manifest verification |

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
daily scheduler and outbox dispatcher survive restart and deduplicate work, local SMTP
check-in succeeds, the backup carries all durable state from one consistent snapshot, all
acceptance criteria pass, the full regression suite is green offline, and an automated
assertion proves no trustee/beneficiary delivery or unsealing occurred.
