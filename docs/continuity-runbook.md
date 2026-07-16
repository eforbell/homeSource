# Continuity switch operations

Phase B sends reminders only to the switch owner's confirmed reminder address. It never
contacts trustees or beneficiaries and never changes sealed envelope holders.

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
node db/migrate.js
node bin/deadman-check.js --once
node bin/continuity-outbox.js --once
systemd-analyze verify deploy/home-source-continuity-*.service deploy/home-source-continuity-*.timer
```

Backups export continuity tables from one repeatable-read database snapshot and fail when a
referenced stored file is missing. Check-in token hashes may appear in the database export;
raw check-in tokens and letter plaintext must not.
