# Feature #11 Add-on: Deadman's Switch for Inheritance Planning

Date: 2026-05-25
Status: Concept capture (not yet planned)
Depends on: Phase 1 (member keys + single-owner PKI encryption), beneficiary key onboarding
Related: Feature #11 PKI Document Vault, inheritance use case

---

## Purpose

A recurring check-in mechanism maintained by the household patriarch. If check-ins
stop for a configured interval, the system executes a pre-defined notification
procedure to alert trustees and/or beneficiaries that the patriarch may be
incapacitated or deceased.

The goal is **not** to immediately grant access — it is to notify the right people
that it is time to begin the inheritance unlock process using their registered keys.

---

## Core concept

1. Patriarch configures a deadman's switch with:
   - Check-in interval (e.g., 90 days / quarterly)
   - Grace period after missed check-in before escalation
   - Escalation chain: who gets notified, in what order, with what message
   - A pre-authored encrypted instruction document (PKI-encrypted to
     beneficiary keys) containing the "what to do now" playbook

2. Patriarch periodically confirms liveness by completing the check-in action.

3. If check-in is missed:
   - System reminds the patriarch (multiple attempts, escalating urgency)
   - After grace period, trustees are notified
   - After final interval, beneficiaries receive a notification with a
     homeSource link to the encrypted instruction document and a reminder
     of which keys are needed to unlock it

---

## Escalation model (draft)

```
Day 0           Check-in due
                  │
Day 0-7         Remind patriarch: email + in-app notification
                  │
Day 7           Second reminder with urgency
                  │
Day 14          Grace period expires → notify trustees
                Trustees receive: "Check-in missed. Please verify status."
                  │
Day 30          Final escalation → notify beneficiaries
                Beneficiaries receive: pre-authored message with link to
                encrypted instruction document + key reminder
```

Intervals and escalation steps should be configurable by the patriarch.
The absolute last resort is triggering beneficiary notification — every
prior step is designed to give the patriarch a chance to refresh the switch.

---

## Check-in UX

The check-in must be trivially easy to complete. If it's burdensome, the
patriarch stops doing it out of convenience, triggering false alarms.

Options (in order of preference):
- **Email with one-click confirmation link** — authenticated, time-limited token
- **In-app button** — requires login to homeSource, click "I'm here"
- **Push notification action** — if mobile/notification support exists

The check-in should also notify the patriarch *that it's coming* before it's
due, so it's expected rather than surprising.

---

## Notification delivery

The notification to beneficiaries includes:
- A pre-authored message from the patriarch (written at configuration time)
- A link to a specific homeSource document ID (the instruction document)
- A reminder of which encryption keys are needed to unlock it
- The instruction document itself is PKI-encrypted to beneficiary keys,
  so the notification is safe to send over email — no secrets are exposed

Notification channels to consider:
- Email (primary — most reliable for "you haven't heard from me in months")
- SMS (secondary, if configured)
- In-app notification (only useful if beneficiaries are active users)

---

## Data model sketch

```sql
CREATE TABLE deadman_switches (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES family_members(id),
  instruction_document_id INT REFERENCES documents(id),
  interval_days INT NOT NULL DEFAULT 90,
  grace_period_days INT NOT NULL DEFAULT 14,
  escalation_config JSONB NOT NULL DEFAULT '{}',
  -- e.g., { steps: [{ days: 0, notify: "owner" }, { days: 14, notify: "trustees" }, ...] }
  last_checkin_at TIMESTAMPTZ,
  next_checkin_due TIMESTAMPTZ,
  escalation_state TEXT NOT NULL DEFAULT 'active'
    CHECK (escalation_state IN ('active', 'reminder_sent', 'grace_period',
                                 'trustees_notified', 'beneficiaries_notified', 'paused')),
  pre_authored_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE deadman_beneficiaries (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES deadman_switches(id) ON DELETE CASCADE,
  member_id INT REFERENCES family_members(id),
  role TEXT NOT NULL CHECK (role IN ('trustee', 'beneficiary')),
  notification_email TEXT,
  notification_phone TEXT,
  encryption_key_id INT REFERENCES encryption_keys(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE deadman_events (
  id SERIAL PRIMARY KEY,
  switch_id INT NOT NULL REFERENCES deadman_switches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'checkin', 'reminder_sent', 'grace_entered', 'trustee_notified',
    'beneficiary_notified', 'paused', 'resumed', 'configured'
  )),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Implementation considerations

### Timer architecture
The existing homeSource scheduled timers (cleanup intervals, expiry scans) run
in-process on short intervals. A deadman's switch needs:
- Long intervals (weeks/months between meaningful state transitions)
- Persistence across server restarts
- Reliability — a missed cron is not acceptable for this use case

Options:
- **DB-polled state machine**: a periodic job (e.g., daily) checks all active
  switches against `next_checkin_due` and current `escalation_state`, advances
  state as needed. Simple, reliable, no external dependencies.
- **System cron + CLI command**: `node bin/deadman-check.js` runs daily via
  system cron. Same logic, but decoupled from the web server process.
- Both can coexist: in-process polling for development, system cron for production.

### Security considerations
- The check-in confirmation token must be single-use, time-limited, and
  tied to the patriarch's session/identity
- Escalation state transitions must be audited
- Beneficiary notification emails must not contain any secrets — only a link
  and a reminder of which keys to use
- The instruction document is the single source of truth; the email is just
  a pointer to it
- Pausing the switch (e.g., planned extended travel) should require
  re-authentication and be audit-logged

### Relationship to PKI phases
- **Phase 1** (current): Single-owner encryption is sufficient for the
  instruction document if only one beneficiary needs it
- **Phase 2** (multi-holder): Instruction document can be encrypted to
  multiple beneficiary keys, which is the more realistic scenario
- **Shamir quorum** (Phase 3): Could require M-of-N beneficiaries to
  cooperate to unlock the instruction document, adding another safety layer

The deadman's switch notification mechanism is independent of the crypto
layer — it can ship as soon as email delivery is available and at least
one beneficiary has a registered key.

---

## Open questions

1. Should the patriarch be able to configure multiple independent switches
   (e.g., one for financial docs, one for digital assets)?
2. What happens if the patriarch loses access to their email? Is there a
   secondary check-in method?
3. Should trustees have the ability to "pause" the switch on behalf of a
   patriarch they know is alive but unreachable (e.g., hospitalized)?
4. Email delivery: does homeSource have or need an outbound email capability?
   (SMTP config, or integration with a transactional email service)
5. Should the system support a "test run" mode where the full escalation
   chain fires but with a [TEST] prefix and no real key access?
6. How should trustee identity and access work? (see analysis below)

---

## Trustee role and conditional access model

Date added: 2026-05-25
Status: Analysis / recommendation

### The problem

The current role model is binary: `parent` (full CRUD) and `kid` (read-only,
own/shared docs). Neither fits a trustee — someone who:

- Must be **known** to the system (for notification and pre-encrypted docs)
- Must have **registered encryption keys** (so the patriarch can pre-encrypt
  documents *to* them while still competent)
- Must have **zero document access** while the patriarch is alive and competent
- Must **gain bounded access** to specific designated documents upon deadman
  switch activation — and *only* those documents

This is fundamentally **event-gated conditional access**, not static RBAC.
The patriarch's incapacitation or death is a state transition that changes
what the trustee can reach.

### Why this is hard with client-side crypto

In the PKI model, the server never holds plaintext DEKs. You can't
retroactively wrap a DEK to a trustee's key without first unwrapping it
with the patriarch's key. This means:

- If the patriarch is incapacitated, nobody can create new key wrappings
  on their behalf (without Shamir reconstruction, Phase 3)
- Therefore, **any document the trustee should access post-trigger must be
  pre-wrapped to the trustee's key while the patriarch is still competent**
- The timing of key wrapping is the ceremony, not the trigger event

### Recommended approach: Sealed envelope model

#### Identity layer — three options with tradeoffs

**Option A: Trustee as a `family_members` role**

Add `'trustee'` to the role CHECK constraint. Trustee gets a login,
a session, can register keys, can verify their setup works.

```
Pros:  Reuses existing auth, session, and key infra. Trustee can
       self-service key registration and run test ceremonies.
Cons:  Trustee is a "user" of the system. Any auth/authz bug could
       leak document access. Increases attack surface. Conflates
       household membership with estate planning relationship.
```

**Option B: Separate `vault_trustees` table (external party)**

Trustees are not family members. New table with contact info, public
key references, and an invitation-based onboarding flow. No standard
login session — key registration happens via a one-time ceremony link.

```
Pros:  Clean separation. Trustee literally cannot log in to browse
       the vault. Zero attack surface from session/auth bugs.
       Correctly models the relationship: they're an external party,
       not a household member.
Cons:  New auth surface for the ceremony link. Can't reuse existing
       key management UI without adaptation. More schema + code.
```

**Option C: Hybrid — `family_members` with access-state column**

Add an `access_state` column to family_members (or a separate table
that governs effective permissions). Trustee authenticates normally
but their effective access is computed from `role + access_state +
deadman_switch_state`.

```
Pros:  Flexible. Same identity infra, but access is dynamic.
Cons:  Complex authorization logic. Every access check must consult
       the state machine. Easy to miss a check and leak access.
```

**Recommendation: Option B (separate table)** for these reasons:

1. **Principle of least privilege by architecture** — if a trustee
   can't authenticate to the main app, an entire class of bugs
   (session fixation, IDOR, role confusion) cannot grant them access.

2. **Correct domain model** — a trustee is not a family member.
   They may be an attorney, executor, or trusted friend. Forcing
   them into `family_members` misrepresents the relationship.

3. **Ceremony-based interaction** — the trustee's entire interaction
   with the system is: (a) one-time key registration ceremony with
   patriarch present, (b) periodic "your setup is still valid" health
   check (optional), (c) post-trigger document access. None of these
   require a persistent session or general app access.

4. **The patriarch controls the blast radius** — only documents
   explicitly pre-wrapped to the trustee's key are accessible.
   There's no code path where a role check failure could expose
   unrelated documents.

#### Crypto layer — sealed envelopes

When the patriarch configures the deadman switch and designates a trustee
for specific documents:

```
1. Patriarch authenticates, unwraps their own private key
2. For each designated document:
   a. Patriarch unwraps the document DEK using their key
   b. System wraps the DEK to the trustee's public key (ECIES,
      same pattern as owner wrapping)
   c. Wrapped DEK is stored as a "sealed" holder entry:
      holders[]: { member_id: trustee_id, role: "trustee",
                   sealed: true, sealed_until: "deadman_trigger" }
3. Sealed holder entries exist in the DB but the API refuses to
   serve them until the deadman switch reaches activation state
```

This is the critical insight: **the crypto wrapping happens while the
patriarch is competent, but the access gate is application-layer**.

Security properties:
- The sealed wrapped DEK is useless without the trustee's private key
  (so a DB breach alone doesn't help)
- The trustee's private key is useless without a served sealed envelope
  (so a trustee key compromise alone doesn't help)
- Both together are needed — and the application gate controls timing
- A compromised server *could* serve sealed envelopes early — this is
  the residual risk. Mitigations: audit logging, multi-party seal
  (Phase 3 Shamir), and the patriarch can monitor sealed envelope
  access in the audit log while alive.

#### Access flow — pre-trigger vs post-trigger

**Pre-trigger (patriarch alive/competent):**
```
Trustee's capabilities:
  ✓ Verify their key registration is intact (health check endpoint)
  ✓ Receive test notifications (if test mode is enabled)
  ✗ Authenticate to the main app
  ✗ See any document list, metadata, or content
  ✗ Access any sealed envelopes
```

**Post-trigger (deadman switch activated):**
```
Trustee's capabilities:
  ✓ Receive notification with link to designated documents
  ✓ Authenticate via ceremony token (time-limited, single-purpose)
  ✓ Access sealed envelopes for designated documents ONLY
  ✓ Decrypt using their registered key
  ✗ Browse other vault documents
  ✗ Modify anything in the vault
  ✗ Access documents not designated by the patriarch
```

#### The "instruction document" pattern

The simplest and most robust first implementation:

Rather than sealing arbitrary vault documents to trustees, the
patriarch authors a single **instruction document** — the "what to
do now" playbook — and encrypts it to the trustee's key at
configuration time.

This document lives in the vault as a normal PKI-encrypted document,
but with the trustee as an additional holder (sealed). Upon trigger,
the trustee is pointed to this one document.

The instruction document can reference other vault documents by name
and explain the process for unlocking them (e.g., "Contact [beneficiary]
and [co-trustee] to begin the Shamir quorum ceremony for the main vault").

This avoids the complexity of sealing many individual documents and
keeps the first implementation narrow:
- One sealed holder entry per trustee (on the instruction doc)
- One document to access post-trigger
- The instruction doc is the trust boundary, not the whole vault

Full vault handoff (multiple documents sealed to trustees/beneficiaries)
can build on this in Phase 2/3 when multi-holder wrapping and Shamir
are available.

### Role taxonomy — forward-looking

Current and proposed roles across the system lifecycle:

```
Role          Auth?   Vault access         Trigger behavior
─────────────────────────────────────────────────────────────
parent        Yes     Full CRUD            N/A (patriarch is a parent)
kid           Yes     Own/shared docs      N/A
trustee       No*     None (pre-trigger)   Gains access to sealed docs
beneficiary   No*     None (pre-trigger)   Gains access to sealed docs

* Trustees/beneficiaries authenticate only via ceremony tokens
  (key registration) or post-trigger access tokens — never via
  standard app login.
```

Distinction between trustee and beneficiary:
- **Trustee**: Notified first (grace period). Expected to verify
  patriarch's status. May have authority to pause the switch.
  Typically: executor, attorney, trusted advisor.
- **Beneficiary**: Notified after trustee escalation. Ultimate
  recipient of vault contents. Typically: spouse, children, heirs.

Both have the same crypto model (sealed envelopes) but different
positions in the escalation chain and different expected actions.

### Implementation phasing

**Can build now (or alongside Phase 1 Chunks 3-6):**
- `vault_trustees` table schema design
- Trustee invitation and key registration ceremony flow
- Sealed holder entry storage model
- Audit logging for seal/unseal events

**Requires Phase 1 complete:**
- Instruction document pre-wrapping ceremony (patriarch unwraps
  own DEK, re-wraps to trustee — needs working PKI encrypt/decrypt)

**Requires Phase 2 (multi-holder):**
- Sealing multiple vault documents to trustees
- Multi-holder envelopes with mixed roles (owner + sealed trustee)

**Requires Phase 3 (Shamir):**
- Quorum-gated vault handoff (M-of-N trustees/beneficiaries must
  cooperate to unlock the full vault)
- Trustee-initiated emergency unseal with quorum threshold
