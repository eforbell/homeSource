# HomeSource — Estate-Planning Treatment

**Sovereign Home suite · per-app design treatment · v2 · July 2026**

> Design source of truth for the estate-continuity surfaces. Phase A shipped on
> 2026-07-14. The May rendered mockups are retained as iteration inputs but must be
> reconciled with this document before they are committed as current design artifacts.

---

## 0. The one idea

**A letter, not a vault.**

Vault interfaces sound like banks: *secure storage, access controls, decrypt now.*
Letter interfaces sound like home: *I want you to know, in case I can't tell you myself.*

Vault language is fine for everyday HomeSource (the filing cabinet). The estate-planning
surfaces touch a different emotion and need a different voice. Every user-facing string
passes one test: **would you say it on the back of a postcard you mailed to your daughter?**

This is not decoration. The voice decision drives concrete architecture choices below —
notably that the trigger email is *from the operator*, that the pre-authored message is a
*first-class document*, and that break-glass tooling stays deliberately separate from the
guided path.

---

## 1. Three kinds of people

Estate planning has three roles. Two are designed for; one is conditionally invited.
Role differences are mostly invisible until something happens — by design.

| Role | Who | Access while operator is well | On trigger |
|---|---|---|---|
| **Operator** (the vault) | You, while well | Full read/write, configures everything, holds master key | n/a — they're the one who didn't check in |
| **Beneficiary** (the heir) | Spouse, kids — **existing Sovereign Home users** | Normal suite access; their own personal docs; **no access to operator's designated docs** | Receives sealed access via one-time ceremony |
| **Trustee** (the witness) | Attorney, sibling, friend — **may be external** | Holds a key; **cannot log in to HomeSource**; never browses the vault | Notified *before* beneficiaries; can pause switch if operator is alive but unreachable |

### Decision 1 — Beneficiaries are `family_members`, not a separate table

The PKI planning doc (feature-11) proposed Option B: a separate `vault_trustees` table for
everyone outside `family_members`. **We diverge for beneficiaries only.**

- **Beneficiaries** are existing household members (kids use Dinner, spouse uses Pulse).
  They inherit their existing avatar, name, login, and keypair. No new identity.
- **Trustees** keep the separate `vault_trustees` table — they may be external, must hold a
  key without an account, and want the lightweight invite-and-ceremony flow.

**Shipped architecture:** the permission model references two identity sources
(`family_members.id` for beneficiaries, `vault_trustees.id` for trustees). The relational
`document_designations` projection uses two nullable foreign keys with a role/identity XOR
constraint. Envelope-v2 holder entries remain additive: member holders retain `member_id`;
trustee holders carry `trustee_id`. The envelope remains the authorization source of truth.

---

## 2. Sealed envelopes (the crypto, plainly)

Stated so design and engineering share vocabulary:

1. Each document has a random **document encryption key (DEK)**.
2. The DEK is **wrapped once per holder** to that holder's public key.
3. For inheritance docs, you wrap the DEK to each beneficiary's public key **while competent**.
   Those wrappings exist in the DB but the API **refuses to serve them** until the switch
   trips. These are **sealed envelopes**.
4. When the switch trips, the **application gate flips**. The same wrappings, unchanged,
   become servable. Recipients authenticate via one-time ceremony tokens and unwrap with
   their own keys.
5. For docs needing multiple consenting people (the bitcoin seed), **Shamir's Secret Sharing**
   splits the DEK into M-of-N shares, each wrapped to a different holder. No single person —
   including the operator — can unlock alone.

### Decision 2 — Sealing is a ceremony with the operator present; the trigger does no crypto

The trigger event changes **what the application is willing to do**, not the cryptography.
All wrapping happens up front, with the operator present and competent.

**Architecture implication:** the daily state-advance job and the trigger path never touch
private keys or perform encryption. They flip a gate and send notifications. This keeps the
unattended automation cryptographically inert — a major security simplification. The
sensitive operations (`wrap`, `split`, `re-wrap`) only ever run in an authenticated operator
session.

---

## 3. Five new surfaces

### 3.1 Beneficiary directory
Lists household members and external trustees, their registration/key status, and a
**designated-document count** computed from the `document_designations` projection — how many
documents *could become* readable after a later authorized delivery, not how many they can
read now. Adding a person does **not** grant access; it makes them addressable.

### 3.2 Permission matrix
Operator-side, desktop-optimized. Documents (rows) × recipients (columns). Phase A shows
already-designated documents and the states none / sealed / unsealed. Eligible empty cells
launch a local unwrap/re-wrap ceremony that adds exactly one envelope-canonical sealed holder
and its relational projection. Quorum cells and holder detail remain Phase D.

### 3.3 Trustee registration ceremony
"Add a trustee" → name, relationship, email. Generates a **one-time link, 7-day expiry**,
stored only as a hash and audit-logged. The trustee receives a content-free invitation from
the operator and lands on a sessionless ceremony page. The shipped ceremony supports a
passphrase-wrapped key, a security key, or a platform passkey; it creates no HomeSource app
session and grants no document access. Document designation is a separate operator ceremony.

### 3.4 Dead-man switch setup — "composing the letter"
A four-step guided ceremony, not a settings page:

1. **"Who is this for?"** — designate beneficiaries + trustees; confirm keys registered.
2. **"Write the letter."** — pre-authored message; soft prompt *"What would you want them to
   know first?"*
3. **"How often will you check in?"** — interval (30 / 90 / 180), grace period (default 14d),
   check-in channel (email / in-app / both).
4. **"Who hears first?"** — escalation chain: trustees → grace expires → beneficiaries.

### Decision 3 — The pre-authored message is a first-class document ("the letter")

Not just a column in `deadman_switches`. The letter is created **as a vault document** at
step 2 — PKI-encrypted to all designated recipient keys, with its own thumbnail. The operator
can re-read it any time; recipients see it as the **first document** when access opens; other
designated docs are reached *through* it.

**Architecture implication:** the wizard's step 2 writes a real document row + envelope, not a
text blob on the switch record. Editing the letter later is editing a document. The switch
record holds a `letter_document_id` FK.

### 3.5 Multisig assembly ceremony
"Three keys can open this. You have one. So does Alex." **Asynchronous by default** — each
holder taps in via their own link when able; the document opens when threshold is reached. No
one needs to be in the same room or the same day.

### Decision 4 — Async share aggregation, server-coordinated, client-reconstructed

Each holder lands on the same shared-unlock screen via their own link. Contributing a share
wraps it (encrypted-to-aggregator) and stores it server-side. When threshold is met, the
**most-recently-arrived holder (the aggregator) reconstructs the DEK client-side**. Server
never sees plaintext shares or the DEK.

**Architecture implication:** v1 can **poll** server state every ~10s for waiting→received
transitions. Real-time (SSE) is nice-to-have, not required — the ceremony is hours/days, not
seconds. Needs a short-lived `share_contributions` table keyed by unlock-session.

---

## 4. Living with the switch — three dashboard states

Single component, three tones. Lives on the HomeSource dashboard.

| State | Trigger | Tone | Copy example |
|---|---|---|---|
| **Healthy** | 47+ days out | Quiet, ok-tint | "You're set. Next check-in in 47 days." |
| **Approaching** | ≤7 days | Promotes check-in button | "A quick check-in this week." |
| **Overdue / grace** | Past due, inside grace | Warm-amber, says *what & when* | "You're 4 days past your check-in. Daniel will hear about this in 10 days." |

### Decision 5 — The system never theorizes about why

Never "you may be incapacitated." The operator might be sick, busy, on a boat. State changes
are **described, never alarmed**. The check-in is one action ("I'm here · all good"),
identical shape/color/copy at every state so muscle memory is constant. Two paths (in-app tap,
email single-use token link) reset the same `last_checkin_at`.

---

## 5. When the system itself is gone — break-glass recovery

**Added after offline backup + recovery landed (May 26).** The guided path assumes a running
server. There is now a tested offline path: full vault snapshot + per-document recovery words,
decrypted via `bin/decrypt-backup-encrypted-doc.js` (passphrase and PKI modes both verified
round-tripping real documents).

### Decision 6 — Break-glass stays break-glass; no GUI on top

The CLI is *for breaking glass only*. We deliberately **do not** wrap it in a UI — a GUI would
invite routine use and erode the security model. Instead:

- **A printable one-page recovery card** ("fire-extinguisher card") stored *with* the backup
  drive. Plain steps: plug in the drive, open Terminal, paste the command, substitute the
  recovery words from the sealed envelope. Designed once, printed when the operator configures
  the backup, kept on paper with the recovery words.
- **The operator's letter references it**: "...and if HomeSource itself isn't reachable, follow
  `RECOVERY.md` on the backup drive."

### Decision 7 — Primary audience for break-glass is the operator, not the heir

Most likely break-glass scenario: **operator is alive and well**, recovering from a drive
failure, bad migration, or hardware loss. This is lower emotional load than the inheritance
case and tonally more like a fire-extinguisher card than a letter. The dual-failure case
(operator gone *and* server gone) is much rarer and inherits the same tooling. **Design the
card for the calm-operator-on-a-bad-Tuesday first.**

> Open question for consultation: should the recovery card itself be a generated, versioned
> artifact inside HomeSource (so it stays in sync with backup format changes), or a static
> document maintained by hand? Leaning generated-and-versioned, printed on backup config.

---

## 6. Tone reference (the hardest part)

| Moment | Vault language ✕ | Letter language ✓ |
|---|---|---|
| Setup CTA | Configure Dead Man's Switch | Set up the letter |
| Confirm interval | Check-in cadence (days): 90 | How often do you want to check in? |
| Healthy status | System active · 47 days until expiration | You're set. Next check-in in 47 days. |
| Approaching | Action required: check-in due in 7 days | A quick check-in this week. |
| Overdue | You may be incapacitated. Confirm liveness. | You're 4 days past your check-in. Daniel will hear in 10 days. |
| Check-in button | Confirm liveness · Cancel escalation | I'm here · all good |
| Trustee notice | Patriarch check-in lapsed. Verify status. | Eric hasn't been around in 14 days. Could you check on him? |
| Beneficiary trigger | Inheritance Protocol Initiated | If you're reading this, I haven't checked in for a while. |
| Unlock CTA | Decrypt Sealed Envelope | Open what Eric left for you |
| Multisig waiting | Awaiting threshold · 1/2 shares | 1 of 2 keys received. One more and we're in. |
| Sender | no-reply@homesource.local | Eric Forbell (sent via HomeSource on his behalf) |

**Avoid:** dead man's switch · incapacitated · inheritance protocol · liveness · patriarch ·
vault access granted · sealed envelope · decrypt · threshold · initiate · trigger

**Use:** check in · the letter · left for you · open with your key · heads-up · you're set ·
I'm here · ceremony · recipient · designated · key arrived/received/waiting · if I'm ever not around

---

## 7. Build sequence

Each phase delivers something real on its own. Ordered to surface warm, low-risk work first;
quorum/Shamir (highest risk) lands last.

### Phase A · People & permissions — shipped 2026-07-14
- Beneficiary/trustee directory with active-key and designation counts
- Trustee table + sessionless invitation/key-registration flow
- Designation matrix + local sealed-holder wrapping ceremony
- Envelope-v2 backup coverage and operator runbook

### Phase B · The letter
- Four-step setup wizard (saves draft between visits; letter created as a document at step 2)
- Status card · three states
- Check-in mechanism · in-app + email (single-use token)
- Crash-safe daily state-advance job (`bin/deadman-check.js`; crypto-inert)
- **Phase boundary:** owner reminders and check-ins only. At grace expiry the switch enters
  `delivery_pending`; it does not notify trustees/beneficiaries or serve sealed material.

### Phase C · Delivery
- Trustee notification + 30-day pause capability
- Beneficiary trigger + single-doc landing page (no sidebar, no nav — a doorway)
- Single-key unlock for recipients (PRF / passphrase / passkey unwrap; scoped session)

### Phase D · Quorum (highest risk — don't pull forward)
- Shamir share split + wrap on designation
- Shared-unlock ceremony screen (async aggregation)
- **Re-wrapping on member change** (death, divorce, departure) — likely the trickiest task;
  design before building.

### Phase E · Break-glass docs (parallel, low-risk)
- Generated, versioned recovery card; printed on backup config
- Letter references `RECOVERY.md`; recovery card kept on paper with the words

---

## 8. Open questions for consultation

1. **Resolved in Phase A:** two nullable relational FKs plus additive member/trustee envelope
   identities; see Feature #13 decisions D13-1/D13-2.
2. **Recovery card: generated vs. static** (see Decision 7). Leaning generated-and-versioned.
3. **Phase B recommendation:** one active switch and one escalation chain per operator for v1.
4. **Phase B recommendation:** replacing an armed letter is an explicit re-seal ceremony;
   never silently mutate recipient wraps.
5. **Phase C recommendation:** one registered trustee may pause but not cancel; only an
   authenticated operator cancels. This authority is not implemented in Phase B.

---

*Built with care · Florida · Forbell.com · No tracking. No analytics. Self-hosted on the LAN.*
