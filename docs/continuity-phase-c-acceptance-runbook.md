# Feature 13 Phase C — Homebase operator acceptance runbook

Use this runbook to exercise the shipped Feature 13 continuity system (Phase 0/A/B/C through
C4) on a **new, isolated Homebase-managed test machine**. It is an operator acceptance drill,
not a production-arming procedure. Use only invented documents, test accounts, a disposable
PostgreSQL database, and mailboxes controlled by the test operator.

> **Do not use a production database, production storage directory, family documents, family
> mailboxes, or production SMTP credentials.** The test run intentionally sends one-time links,
> advances delivery state, creates grants, and can invalidate recipient access.

## 1. Scope and exit criteria

This drill validates the live integration of:

- Homebase installation, publishing, environment preservation, and generated systemd units;
- SMTP delivery to controlled test mailboxes;
- parent, beneficiary, trustee-recipient, and witness-trustee ceremonies;
- sealed packet creation, owner reachability acknowledgement, arming, check-in, delivery,
  trustee pause, exact recipient delivery, reissue, session revocation, and one-year expiry;
- state/outbox restart behavior and a backup/recovery inspection.

A passing drill means every selected scenario succeeds, all unexpected delivery paths fail
closed, and the evidence bundle in [§14](#14-evidence-and-sign-off) is complete. It does **not**
arm a production household. Production arming remains separately gated.

## 2. Required test identities and mailboxes

Create separate accounts before installing Home Source. Do not reuse one mailbox for two roles.

| Role | Suggested account | Required exercise |
| --- | --- | --- |
| Operator parent | `hs-owner-test@…` | Bootstrap, key setup, arm/recover, receive check-in and boundary mail. |
| Beneficiary child | `hs-kid-test@…` | Verify contact, receive recipient delivery, unlock with a passphrase-protected key. |
| Trustee recipient | `hs-trustee-recipient@…` | Register a PRF-capable passkey/security key, receive recipient delivery, unlock locally. |
| Witness trustee | `hs-witness-test@…` | Register, receive pause link, exercise pause and no-pause branches. |
| SMTP observer | optional separate mailbox | Retain original messages and headers for evidence. |

Use a private test mail domain or aliases whose relay policy cannot forward to real recipients.
Use distinct browser profiles/devices for operator, beneficiary, trustee-recipient, and witness.
A passkey/hardware-key test needs a browser and authenticator that support the WebAuthn PRF
extension; retain the passphrase path as the fallback test.

## 3. Homebase catalog verification

The Homebase catalog already contains all required continuity units for `home-source`:

| Unit | Command | Schedule |
| --- | --- | --- |
| `home-source` | `node server.js` | long-running app service |
| `home-source-continuity-check.service` | `node bin/deadman-check.js --once` | timer daily at 09:00, persistent, randomized by up to 5 minutes |
| `home-source-continuity-outbox.service` | `node bin/continuity-outbox.js --once` | starts 5 minutes after boot, then every 15 minutes |

Evidence: `homeBase/src/catalog.js` defines both timer entries, and Homebase's install planner
tests assert that it generates/enables these exact units. The repository's `deploy/` unit files
are useful reference material, but **Homebase should own the installed unit files and the app's
`.env`**. Do not install a second copy from `homeSource/deploy/` on a Homebase-managed machine.

## 4. Install a disposable Homebase instance

1. In Homebase, install **Home Source** from `main` into a fresh app/database/storage instance.
   Homebase's catalog expects:
   - mount path `/source/`;
   - upstream `127.0.0.1:3008`;
   - database `homesource` owned by `homesource`;
   - storage `/var/lib/sovereign-home/home-source/data`.
2. Publish only on the private tailnet. Use a stable HTTPS test URL, for example
   `https://<test-host>.<tailnet>/source/`.
3. In the Homebase-managed Home Source `.env`, set at minimum:

   ```env
   APP_URL=https://<test-host>.<tailnet>/source/
   HOUSEHOLD_TIMEZONE=America/New_York
   MAIL_TRANSPORT=smtp
   SMTP_HOST=<your-test-relay>
   SMTP_PORT=587
   SMTP_SECURE=no
   SMTP_REQUIRE_TLS=yes
   SMTP_USER=<test-relay-user>       # omit both user and pass only when relay auth is disabled
   SMTP_PASS=<test-relay-password>
   SMTP_FROM=Home Source Test <hs-test@<test-domain>>
   SMTP_REJECT_UNAUTHORIZED=yes
   NOTIFICATION_TO=hs-owner-test@<test-domain>
   ```

   `APP_URL` must be the externally reachable Homebase URL, including `/source/`. Do not use
   `MAIL_TRANSPORT=console` or `file`, and do not set `CONTINUITY_ALLOW_INSPECTION_MAIL=yes` for
   this SMTP acceptance drill.
4. Confirm Homebase has created the storage root and that its service user can write it.
5. From a second tailnet device, verify the published URL and the two health endpoints:

   ```sh
   curl -fsS https://<test-host>.<tailnet>/source/api/health
   curl -fsS https://<test-host>.<tailnet>/source/api/ready
   curl -fsS https://<test-host>.<tailnet>/source/api/bootstrap
   ```

   Before onboarding, `/api/bootstrap` should report that a household is needed. After
   onboarding, `/api/ready` must remain successful.

## 5. Verify Homebase-managed services and timers

Run these commands on the test host after Homebase finishes installation:

```sh
sudo systemctl status home-source --no-pager
sudo systemctl status home-source-continuity-check.timer --no-pager
sudo systemctl status home-source-continuity-outbox.timer --no-pager
sudo systemctl list-timers 'home-source-continuity-*'
sudo systemctl cat home-source-continuity-check.service
sudo systemctl cat home-source-continuity-outbox.service
```

Expected facts:

- the check service invokes `node bin/deadman-check.js --once`;
- the outbox service invokes `node bin/continuity-outbox.js --once`;
- both use the same Homebase-managed app checkout and environment;
- both timers are enabled and waiting for their next run.

Run one no-work smoke execution of each unit and retain the journal output:

```sh
sudo systemctl start home-source-continuity-check.service
sudo systemctl start home-source-continuity-outbox.service
journalctl -u home-source-continuity-check.service -n 100 --no-pager
journalctl -u home-source-continuity-outbox.service -n 100 --no-pager
```

Do not manually edit continuity state in the database for ordinary retry or recovery. The
Continuity page and workers are the normal operational surface.

## 6. Onboard the test household and keys

1. Open `https://<test-host>.<tailnet>/source/setup` in the operator profile and bootstrap a
   household with the operator parent and beneficiary child. Set known **test-only** login
   passphrases.
2. Sign in as the operator and register an owner PKI key. Confirm local unlock works.
3. Sign in as the beneficiary child in its own browser profile and register a
   passphrase-protected PKI key. Confirm local unlock works.
4. In **Continuity → Trustees**, invite the witness trustee and trustee-recipient to their
   separate test mailboxes. Each opens the one-time invitation and registers a key:
   - witness: passphrase or passkey is acceptable;
   - trustee-recipient: use a PRF-capable passkey/security key for the delivery-unlock test.
5. Confirm both trustees show `registered` with one active key. Do not treat a sent email as
   success until the recipient completed the ceremony.
6. In the Continuity directory, send and complete beneficiary email verification for the child.
   Confirm the child has exactly one verified contact. Trustee registration supplies a verified
   trustee contact; confirm both trustee addresses are shown as verified.

Failure checks: a used invitation, revoked invitation, wrong mailbox recipient, or an unverified
beneficiary contact must not advance to delivery authority.

## 7. Build a sealed test packet and arm safely

1. Create one or two invented PKI-encrypted documents (for example, `TEST — Will` and
   `TEST — Account instructions`). Put obvious non-sensitive marker text inside each.
2. From **Continuity → Designated documents**, use **Seal** to create sealed designations for:
   - the beneficiary child;
   - the trustee-recipient.
3. In the Continuity setup form, choose both as **Sealed recipients**, select one additional
   packet document, and choose the witness trustee under **Witness trustees**.
4. Set the minimum cadence: **30 days** and **7 days** grace. Write a test-only letter, save the
   encrypted letter, then arm it with the operator's current login passphrase.
5. Complete the **Phase C reachability preparation** email challenge using the operator mailbox.
   The card must show the email channel as transport-accepted and receipt-acknowledged before
   treating the drill as ready.
6. Record the switch ID, packet version, next check-in due time, and all involved mailbox
   addresses in your evidence log. The Continuity page must show one active packet and no failed
   outbox rows.

At this point test the normal operator-control branch once: select **I'm here** and confirm the
switch starts a fresh cycle. Then cancel that test switch or restore a clean test snapshot before
continuing with the no-check-in delivery branch below.

## 8. Accelerated simulation driver (test machine only)

The shipped timers intentionally use wall-clock time. To test a 30-day cadence, seven-day grace,
72-hour witness window, 30-day pause, and one-year grant lifetime in one session, run the same
domain functions with a supplied timestamp **only against this isolated test database**.

From the Home Source checkout, run the following for each simulated instant. It does not patch
rows or bypass authorization; it invokes the state advance and durable outbox dispatcher with the
chosen clock. Never run it against a production database.

```sh
SIMULATED_AT='2026-08-01T12:00:00Z' node <<'NODE'
require('dotenv').config();
const { advanceDueSwitches, dispatchOutbox } = require('./lib/continuity');
const { pool } = require('./lib/db');
const at = new Date(process.env.SIMULATED_AT);
if (!Number.isFinite(at.getTime())) throw new Error('SIMULATED_AT must be an ISO-8601 timestamp');
(async () => {
  try {
    console.log(JSON.stringify({ at: at.toISOString(), state: await advanceDueSwitches({ now: at }) }));
    console.log(JSON.stringify({ at: at.toISOString(), outbox: await dispatchOutbox({ now: at }) }));
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
NODE
```

Read the actual times; do not guess them. For example:

```sh
psql "$DATABASE_URL" -x -c "
  SELECT id, status, next_checkin_due_at, delivery_pending_at
  FROM continuity_switches ORDER BY id DESC LIMIT 1;"
psql "$DATABASE_URL" -x -c "
  SELECT id, status, trustee_action_deadline_at, pause_deadline_at, released_at
  FROM continuity_delivery_runs ORDER BY id DESC LIMIT 1;"
```

Use the output timestamps as the next `SIMULATED_AT` values. This exercise validates
state/outbox behavior, but the normal timer smoke in [§5](#5-verify-homebase-managed-services-and-timers)
remains the evidence that Homebase/systemd launches the real workers.

## 9. Scenario A — reminder and check-in

1. Run the accelerated driver at `next_checkin_due_at - 7 days`.
2. Confirm the operator mailbox receives the generic approaching reminder and that it contains a
   one-time check-in link, no document or recipient details, and the correct Homebase `/source/`
   URL.
3. Open the link in a logged-out browser and complete check-in. Confirm it does not create a
   Home Source session and that the operator's switch returns to a healthy, future cycle.
4. Reopen the same link: it must be unavailable. Repeat this scenario after a clean reset/snapshot
   rather than trying to force the same switch into delivery.

## 10. Scenario B — witness window, pause, and delivery

Start from a freshly armed test switch and **do not check in**.

1. Run the accelerated driver at `next_checkin_due_at + grace_period_days`.
2. Confirm the operator receives the boundary notice, the run enters
   `trustee_notification_pending`, and no recipient has received a document link yet.
3. Confirm the witness receives a sessionless pause link. It must not reveal letter, document,
   holder, key, or account data.
4. After the successful witness delivery, inspect the Continuity page/run status. It should enter
   `trustee_window` and show a 72-hour action deadline.
5. Exercise the **pause branch** once: use the witness link. Confirm the run shows
   `trustee_paused`, the other witness tokens are invalidated, and the owner can use **I'm here —
   stop delivery**. For the independent release branch, restore the pre-pause snapshot or create a
   new test switch.
6. For the **no-pause branch**, run the accelerated driver just after
   `trustee_action_deadline_at`. Confirm the run/switch enter recipient delivery, recipient grants
   are created only for the packet's sealed recipients, and the dispatcher sends one fresh link per
   recipient mailbox.

If testing a pause expiry instead, run just after `pause_deadline_at`; it must release to recipient
delivery once, not extend the pause.

## 11. Scenario C — recipient doorway and local unlock

For each recipient mailbox, use a separate logged-out browser profile.

1. Open the delivery link. Confirm the page has no Home Source navigation and shows only
   `Private document N` before unlock.
2. Refresh while the 60-minute recipient session is live. The page must resume the session without
   re-consuming the link.
3. Beneficiary child: select an item and unlock with the child key passphrase. Verify the browser
   decrypts locally and the downloaded marker text is correct.
4. Trustee-recipient: select an item and use the passkey/security-key button. Verify the WebAuthn
   PRF ceremony completes and the item decrypts locally. A normal Home Source login must not
   substitute for the recipient session.
5. Reopen the already consumed email link. It must not exchange again. Use **Send a replacement
   link**, confirm the prior live recipient session is revoked, run the normal outbox worker (or
   wait for its timer), and confirm a replacement arrives **only** at that grant's immutable
   verified mailbox.
6. Refresh after a session has expired with no raw token in the URL. The page must tell the user to
   reopen the original email link; it must not promise a resend it cannot queue.
7. Open an old/replaced link, a recipient link from another mailbox, and a normal app session
   against recipient endpoints. Each must fail without revealing document metadata.

## 12. Scenario D — one-year grant expiry and recovery controls

1. With a recipient session active, read the grant `expires_at` from the test database or owner
   timeline, then run the accelerated driver just after that timestamp.
2. Confirm every grant is `expired`, any recipient session is revoked, unused/replaced links no
   longer work, pending recipient mail is superseded, and the run becomes `delivery_complete` when
   no active grants remain.
3. Confirm the parent-authorized timeline records lifecycle events without raw tokens, document
   titles, filenames, private keys, DEKs, or plaintext.
4. Test a controlled SMTP failure: temporarily deny the test relay, run the outbox worker, confirm
   the failure is visible, restore relay access, use the parent **Retry notifications** control, and
   rerun the outbox worker. Do not alter outbox rows directly.

## 13. Backup and restore drill

1. Before expiry and again after expiry, create a backup from Home Source's **Backup** page or the
   Homebase backup action. Retain the archive and its manifest as test evidence.
2. Confirm the archive contains the continuity tables and encrypted stored artifacts. It may contain
   hashes of tokens/session bearers; it must not contain raw emailed links, private keys, DEKs, or
   plaintext letters.
3. Use the Homebase restore workflow only against a **separate disposable restore target**. Never
   overwrite the active test instance until this rehearsal is proven.
4. Follow [docs/recovery-runbook.md](recovery-runbook.md) to decrypt/extract the archive and
   recover one invented encrypted document using only the test recovery material. Open the result
   and verify the marker text.
5. On the restored target, inspect the continuity run/grant/outbox records and referenced document
   files. The expected state must match the source snapshot.

## 14. Evidence and sign-off

Record the following without copying raw bearer tokens, private keys, passphrases, recovery words,
or document plaintext into tickets or shared logs:

- Homebase install/update plan, app URL, Homebase revision, and Home Source commit;
- `systemctl` status/cat output for the app and both continuity timers;
- health/ready/bootstrap response status;
- the four role mailboxes used and delivery timestamps (redact message URLs);
- screenshots of reachability acknowledgement, armed packet, trustee window/pause, recipient
  minimal-metadata page, local unlock success, reissue, and terminal expiry;
- worker journal excerpts and JSON results for state/outbox runs;
- backup manifest name/checksum, restore target identity, and recovered invented-document proof;
- all deviations, retries, expected failures, and final result.

Mark the drill **passed** only if the selected positive paths complete and all attempted negative
paths fail closed. Keep production arming disabled until this evidence is reviewed and accepted.

## References

- [Continuity operations](continuity-runbook.md)
- [Trustee invitation ceremony](trustee-invitation-runbook.md)
- [Backup/recovery drill](recovery-runbook.md)
- `planning/features/feature-13-phase-c-conditional-delivery.md`
- Homebase `src/catalog.js` entry `home-source`
