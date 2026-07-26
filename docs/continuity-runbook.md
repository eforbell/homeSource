# Continuity switch operations

Phase B reminders target only the switch owner. Phase C1 may contact designated witness
trustees after escalation. Phase C2 creates immutable recipient grants and durable recipient
outbox rows in the explicit `deferred` state. C3 is the only dispatcher path allowed to claim
those rows: it replaces the staged hash with a fresh seven-day recipient link while claiming
and sends the live scoped doorway. Owner-check-in and trustee dispatchers never claim a
recipient-delivery row.

## Recipient link replacement and expiry

A recipient who still possesses a previous link may request a replacement from the private
doorway. The request is deliberately enumeration-safe and is delivered only to the immutable,
verified email stored with that exact grant; it never accepts a replacement address or extends
the original one-year grant deadline. The daily state job terminally expires due grants,
revokes recipient sessions, invalidates remaining links, supersedes unsent recipient mail, and
records a token-free event visible to the owning parent through the continuity timeline API.

## Required configuration

- `APP_URL`: browser-reachable HTTPS Home Source URL (`localhost` HTTP is development-only)
- SMTP configuration and `SMTP_FROM` as documented in the main README
- `HOUSEHOLD_TIMEZONE`: timezone used for calendar-day cadence arithmetic

The application blocks arming while mail is disabled. Existing armed schedules continue to
advance if mail later becomes unavailable; their outbox rows become visibly configuration
blocked instead of being discarded.

## Services

```sh
systemctl status home-source-continuity-check.timer
systemctl status home-source-continuity-outbox.timer
systemctl list-timers 'home-source-continuity-*'
```

The state timer runs daily and catches up missed milestones. The outbox timer runs every 15
minutes. PostgreSQL advisory locks and row claims prevent overlapping work.

Run either job manually:

```sh
sudo systemctl start home-source-continuity-check.service
sudo systemctl start home-source-continuity-outbox.service
journalctl -u home-source-continuity-check.service -n 100 --no-pager
journalctl -u home-source-continuity-outbox.service -n 100 --no-pager
```

The Continuity page shows each job's last successful/no-work completion and pending, failed,
or configuration-blocked outbox counts. Repair SMTP or `APP_URL`, then manually start the
outbox service; state transitions must never be edited by hand merely to retry mail.

## Safety checks

Before and after deployment:

```sh
npm run test:schema-parity
node db/migrate.js
node bin/deadman-check.js --once
node bin/continuity-outbox.js --once
systemd-analyze verify deploy/home-source-continuity-*.service deploy/home-source-continuity-*.timer
```

Backups export continuity tables from one repeatable-read database snapshot and fail when a
referenced stored file is missing. Check-in, trustee-action, and recipient-access token hashes
may appear in the database export, along with encrypted holder-local grant material; raw bearer
tokens, private keys, DEKs, and letter plaintext must not.

Stored document paths are write-once through HomeSource. Recipient preflight streams and hashes
each distinct artifact immediately before grant activation without holding PostgreSQL locks; the
activation transaction then locks and revalidates the exact `document_files` row. PostgreSQL
cannot lock filesystem bytes, so out-of-band mutation between those steps is an explicit host
integrity boundary rather than a database guarantee. Operators must restrict storage writes to
the HomeSource service account and treat direct filesystem modification as unsupported.
