# Security Policy

## Scope and security objective

Home Source is a local-first family document vault and continuity system. It may store passports, birth certificates, insurance and estate records, receipts, recovery documents, and other critical files. It also manages encrypted document keys, recovery/holder material, backups, capability links, notifications, and optional AI indexing.

Home Source has the highest confidentiality and recovery requirements in this suite. The security objective is to keep plaintext and keys private, preserve client-side cryptographic boundaries, prevent unauthorized capability use, and ensure that encrypted data remains recoverable by authorized holders.

This root policy summarizes the detailed guidance in:

- `docs/security-capabilities.md` (canonical source for shipped controls)
- `docs/recovery-runbook.md`
- `docs/continuity-runbook.md`
- `docs/trustee-invitation-runbook.md`
- `planning/features/feature-11-threat-model.md` (historical/planning context only)

Those documents remain required reading for deployment, recovery, and continuity changes. Where the historical threat model differs from shipped documentation, the shipped capabilities document controls. The current holder model is 1-of-M; no threshold or quorum protection is implemented.

## Trust model

- The browser is trusted for document encryption/decryption and private-key operations.
- The network is untrusted; use HTTPS and a private network/access layer.
- The server is semi-trusted: it coordinates storage and ciphertext but must not receive plaintext private keys or document encryption keys.
- Host storage and backups are untrusted at rest unless protected by document encryption, archive encryption, OS permissions, and disk encryption.

Client-side key operations are a security boundary. Do not move private-key or DEK handling to the server for convenience.

## Critical material

Never commit, log, email in plaintext, or place in issues/PRs:

- document plaintext or production metadata/fixtures;
- private keys, DEKs, recovery words, raw key exports, document passphrases, or backup passphrases;
- share, continuity, trustee, or session bearer tokens;
- SMTP/OpenAI credentials, database URLs, backups, dumps, or storage directories.

The server must never store plaintext private keys or DEKs. Continuity exports must not contain raw bearer tokens, private keys, DEKs, or letter plaintext.

## Authentication, capability links, and network exposure

1. Keep Home Source on localhost or a trusted Tailnet behind an HTTPS reverse proxy.
2. Configure strong user passphrases and session secrets; preserve parent/admin authorization server-side.
3. Treat share, trustee, recovery, and continuity URLs as bearer capabilities. Use short lifetimes, single-use behavior where supported, optional PINs, and minimal disclosure.
4. Do not place capability URLs in logs, analytics, referrers, screenshots, or model prompts.
5. Configure `APP_URL`, SMTP TLS, sender identity, and recipients correctly before arming notifications or continuity workflows.

## Encryption and recovery invariants

- Document-level PKI encryption and backup-archive encryption are separate layers.
- A backup passphrase opens only the outer archive; decrypting an encrypted document still requires the document passphrase or matching PKI recovery material.
- Recovery words/private-key exports must match the specific member key. Without a valid wrap or recovery key, some documents may be permanently unrecoverable.
- Store backup media separately from recovery words/private keys. Protect both against loss, theft, and single-site disaster.
- Re-wrap documents to active holders before removing/rotating the only usable key.
- Do not claim a backup is usable until both archive restoration and representative document decryption have been tested.

## Filesystem, uploads, and document processing

Restrict document and backup directories to the Home Source service account. Reject path traversal and symlink escapes, use server-controlled names, bound file sizes and processing time, and remove temporary plaintext after success or failure. Host filesystem write access is an integrity boundary; no other service should mutate vault storage.

Document scanners, PDF/image libraries, OCR tools, and batch workers process untrusted files. Run them with least privilege and bounded resources, and review dependency/native-tool upgrades.

## AI and external services

MagicIndex may use a local provider, an OpenAI-compatible private endpoint, Ollama, or cloud OpenAI. Cloud mode may send document text, images, or PDFs outside the household boundary. Keep cloud processing opt-in, disclose the exact data flow, minimize content, and prefer local processing for critical documents.

Never send keys, passphrases, bearer URLs, database dumps, or unnecessary identity data to an AI provider. Preserve secret guards and make provider changes security-sensitive.

## Backups and continuity

Backups must include PostgreSQL state and app-owned document storage in the closest practical window, but they are not atomically locked together. Consistency depends on restricting storage writes to the Home Source service account, preserving/verifying file hashes, and running restore drills. Encrypt off-host archives, verify retention and permissions, and test continuity timers/grants without leaking live tokens or triggering unintended release.

Before removing a member/key or arming continuity, verify alternate holders, recovery wraps, notification delivery, and a documented break-glass path.

## Incident response

1. Remove unintended network or capability-link access and revoke affected sessions/tokens.
2. Rotate database, SMTP, AI, and session credentials as applicable.
3. Preserve redacted audit/notification evidence and identify affected documents/backups/recipients.
4. If key material is exposed, re-wrap affected documents to a new trusted key and retire the compromised holder/key.
5. If recovery material is lost, inventory affected documents and all alternate holders, wraps, words, raw exports, and backups before making changes.
6. Restore from known-good backups only after verifying archive and document-level decryption.
7. Clean source/history after containment; never repeat secrets in the incident record.

## Required verification

Run schema parity, auth/authorization, crypto/PKI, share-token, upload/path, backup/restore, recovery, SMTP, and continuity tests after relevant changes. Security reviews must distinguish implemented controls from planned controls and must not weaken fail-closed behavior to make tests pass.

## Reporting a vulnerability

Do not open a public issue containing document names/content, identity data, keys, recovery material, capability URLs, backups, or logs. Report privately through a GitHub Security Advisory when available, or contact the repository owner privately. Use synthetic/redacted evidence and include affected paths, reproduction steps, and impact.

There is no bug bounty program or guaranteed response SLA.
