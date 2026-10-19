# Continuity acceptance drill (automated)

Runs [docs/continuity-phase-c-acceptance-runbook.md](../../docs/continuity-phase-c-acceptance-runbook.md)
§4–§14 against a disposable Homebase test host, except the tailnet publishing checks.

## What it builds

- **hs-host**: a privileged systemd Ubuntu 24.04 container. Homebase is installed by its own
  `install.sh`. Home Source is installed by the Homebase executor from a bare clone of this
  repository, so the real units, timers, `.env`, and nginx gateway are under test.
  The gateway is published on `https://localhost/` (127.0.0.1:443).
- **hs-mailpit**: the SMTP relay (STARTTLS required) and the test inboxes, at http://127.0.0.1:8025.

## What it drives

- **Household:** a household of two parents and one kid. Each member registers a login and
  a passphrase-protected PKI key; one parent also sets up recovery words.
- **Documents:** eight invented documents. Three are PKI-encrypted.
- **Trustees:** three trustees invited by email. Two witnesses use passphrases. The
  trustee-recipient uses a CTAP2 security key with PRF (Chromium virtual authenticator).
- **Packet and arming:** sealed designations, then the Continuity page flow: stage the
  letter, verify the beneficiary contact, acknowledge reachability, arm, and press **I'm here**.
- **Scenarios A–D:** check-in by email, witness pause and owner recovery, window release,
  the recipient doorway with local unlock (passphrase and PRF), reissue, the SMTP-failure
  retry, and one-year expiry.
- **Backups:** backups before and after expiry with a secret scan, the Homebase backup action,
  and recovery-CLI decryption from recovery words.
- **Pause expiry:** a pause-expiry branch on the second parent's switch.

Each person acts in their own browser profile, on the sessionless pages from their email. The
operator works the Continuity page in the browser. Key setup, uploads, and seals call the same
APIs as their pages, with the shipped `public/pki-crypto.js`. Time-based milestones use the
runbook's §8 simulation driver, unchanged. Real timers, and real worker runs started with
`systemctl start`, are exercised where the runbook asks for them.

## Usage

```sh
e2e/continuity/harness.sh all          # containers, Homebase, Home Source main, .env (≈3 min)
node e2e/continuity/acceptance.mjs     # the drill (≈2 min); evidence under e2e/continuity/evidence/
e2e/continuity/harness.sh reset        # empty DB/storage/inboxes between attempts
e2e/continuity/harness.sh down         # remove containers and network

# Test another build: Homebase installs it (pinned to its commit) over the existing host.
HS_E2E_SOURCE=/path/to/checkout HS_E2E_REF=my-branch e2e/continuity/harness.sh app
HS_E2E_EXPECT_COMMIT=$(git -C /path/to/checkout rev-parse my-branch) node e2e/continuity/acceptance.mjs
```

Options: `--until <phase>` and `--skip <phase,...>`. Requirements: Docker, Node 22+, and
`playwright-core` with Chromium, resolvable from this repo or its parent directory
(or set `PLAYWRIGHT_CORE_PATH`).

## Deliberate deviations from the runbook

- No tailnet. `APP_URL` is `https://localhost/source/`, and Chromium trusts exactly the
  gateway's key (`--ignore-certificate-errors-spki-list`), because WebAuthn refuses origins
  with certificate errors.
- `SMTP_REJECT_UNAUTHORIZED=no`, because Mailpit's certificate is self-signed. STARTTLS and
  authentication are still required.
- Each branch (check-in, pause, release) runs on a successive cycle of one switch, or on the
  second parent's switch. It does not restore database snapshots.

Evidence files are redacted: every token, bearer, passphrase, key, and DEK the drill sees is
replaced before it is written.
