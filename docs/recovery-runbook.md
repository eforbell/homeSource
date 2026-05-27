# Home Source Recovery Runbook

This runbook covers the **break-glass** recovery path for Home Source when the
live server or database is unavailable.

Preferred estate handoff uses the live Home Source application with existing
accounts and onboarded PKI keys. This runbook is for:

- failed or lost host
- damaged database
- bad deploy / rollback scenario
- backup validation drills

## What you need

At minimum:

- a Home Source backup archive
- the backup archive passphrase if the archive was exported encrypted
- one of:
  - the document passphrase (for passphrase-encrypted documents), or
  - the recovery words for the PKI key that encrypted the document, or
  - a raw PKCS#8 private key export for that PKI key

## Recommended recovery order

1. **Start with an unencrypted backup drill** if you are validating the process
   for the first time. This removes the outer archive encryption layer and lets
   you focus on the actual document recovery path.
2. **Validate an encrypted backup drill** once the unencrypted flow works.
3. Store a printed/exported copy of this runbook with the family’s recovery
   materials.

## Backup contents

Home Source backups include:

- `manifest.json`
- `database.json`
- `documents/`
- PKI key tables needed for offline recovery:
  - `encryption_keys`
  - `key_holders`
  - `webauthn_credentials`

## 1. Decrypt the outer backup archive (encrypted backups only)

If the backup file ends with `.tar.gz.enc`, decrypt it first:

```sh
./bin/decrypt-backup-archive.js \
  --input /path/to/homesource-backup-2026-05-26T19-09-14.tar.gz.enc \
  --output /tmp/homesource-backup.tar.gz \
  --passphrase "your backup archive passphrase"
```

If the backup is already a plain `.tar.gz`, skip this step.

## 2. Extract the archive

```sh
mkdir -p /tmp/homesource-backup
tar -xzf /tmp/homesource-backup.tar.gz -C /tmp/homesource-backup
```

Expected extracted structure:

```text
/tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS/
  manifest.json
  database.json
  documents/
```

In the examples below, this extracted folder is referred to as:

```text
/tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS
```

## 3. Inspect documents in the backup

You can inspect the exported documents with `jq`:

```sh
jq '.documents[] | {id,title,encryption_mode,is_encrypted,encryption_key_id}' \
  /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS/database.json
```

Use either:

- `--doc-id <id>`
- or `--title "<exact title>"`

for recovery.

## 4. Recover a passphrase-encrypted document

```sh
./bin/decrypt-backup-encrypted-doc.js \
  --database /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS/database.json \
  --backup-root /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS \
  --passphrase "document passphrase" \
  --doc-id 123 \
  --out-dir /tmp/recovered
```

Or by title:

```sh
./bin/decrypt-backup-encrypted-doc.js \
  --database /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS/database.json \
  --backup-root /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS \
  --passphrase "document passphrase" \
  --title "Passport - Eric" \
  --out-dir /tmp/recovered
```

## 5. Recover a PKI-encrypted document with recovery words

This is the most important family-usable recovery path for passkeys and
hardware-backed keys, since raw private-key export is often unavailable or
intentionally resisted.

```sh
./bin/decrypt-backup-encrypted-doc.js \
  --database /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS/database.json \
  --backup-root /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS \
  --mode pki \
  --recovery-code "twelve recovery words go here" \
  --doc-id 456 \
  --out-dir /tmp/recovered
```

## 6. Recover a PKI-encrypted document with a raw private key

If you have a raw PKCS#8 private key export:

```sh
./bin/decrypt-backup-encrypted-doc.js \
  --database /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS/database.json \
  --backup-root /tmp/homesource-backup/homesource-backup-YYYY-MM-DDTHH-MM-SS \
  --mode pki \
  --private-key /path/to/member-key.pk8 \
  --doc-id 456 \
  --out-dir /tmp/recovered
```

## 7. Confirm success

Successful recovery prints output like:

```text
✅ Decrypted document id=60
   title: secret - hero seedling
   mode: pki
   input: /path/to/documents/...enc
   output: /tmp/recovered/hero-seedling.png
```

Open the recovered output file and confirm it renders correctly.

## Notes and caveats

- The **backup archive passphrase** only decrypts the outer archive.
- The **document passphrase** or **PKI recovery material** decrypts the inner
  document.
- For PKI documents, the recovery words must match the **specific member key**
  that encrypted that document.
- If a document was encrypted to a key that has no recovery wrap and no private
  key export is available, that document may be unrecoverable offline.

## Operational recommendation

For important estate-grade materials:

- verify that the member key used for encryption has recovery words on file
- rehearse this recovery process periodically
- keep backups and recovery words in separate secure locations

## Tested recovery scenarios

This runbook has been validated against real Home Source backup fixtures for:

- passphrase-encrypted document recovery
- PKI-encrypted document recovery using recovery words
- PKI-encrypted document recovery using a raw private key
- encrypted outer archive decrypt + extract + document recovery
