# Home Source

Sovereign family document vault. Stores warranties, insurance docs, critical records (birth certificates, passports), manuals, receipts, and more. Supports phone camera scanning with client-side perspective correction, URL import, and file upload. Local-first storage with offline backup to USB/media. Part of the sovereign-home app suite.

The app is intentionally self-hosted and direct:
- Express server with static pages from `public/`
- PostgreSQL for all application state
- Local disk storage for document files
- Client-side document scanning via jscanify + OpenCV.js
- No cloud dependencies, no third-party storage

## Core Capabilities

- upload documents via file picker, camera scan, or URL import
- client-side document scanning with auto-edge detection and manual corner adjustment
- image-to-PDF conversion with thumbnail generation (sharp + pdf-lib)
- PDF first-page thumbnail rendering with poppler fallback (`pdftoppm`) when sharp cannot decode
- document metadata: type, dates, description, custom key-value fields
- joint ownership model (owner, joint, beneficiary, custodian)
- tagging system with color-coded tags
- full-text search with PostgreSQL tsvector
- share links with optional PIN protection and expiry
- backup export as tar.gz with manifest (optional Argon2id + AES-256-GCM encryption)
- backup posture dashboard (green/yellow/red based on configurable frequency)
- audit log for document access, shares, and backups
- parent/kid access control (parents have full CRUD; kids get read-only on own/shared docs)
- mobile-first responsive design, iOS WKWebView compatible
- MagicIndex for both Batch Import and single Add Document flows (upload/scan/url)
- MagicIndex extraction diagnostics and evidence (`input_file`/fallback path, text preview source, confidence by field)
- OCR-assisted metadata fallback for scan-heavy PDFs/images (`tesseract` when PDF text extraction is empty)

## Project Layout

- [server.js](server.js): Express server, all routes
- [lib/](lib/): Business logic modules (auth, documents, files, search, share, backup, import)
- [public/](public/): Frontend pages and browser JS
- [db/migrations/](db/migrations/): Numbered SQL migrations
- [db/schema.sql](db/schema.sql): Canonical schema snapshot
- [deploy/](deploy/): systemd unit and deploy script
- [test/](test/): node:test test files

## Local Development

### Prerequisites

- Node.js (18+)
- Docker with Docker Compose (for PostgreSQL)

### Start the database

```sh
docker-compose up -d
```

### Environment

```sh
cp .env.example .env
# Fill in DATABASE_URL and other values
```

### Run the app

```sh
npm install
node db/migrate.js
npm run dev
```

Default URL: `http://localhost:3008`

### Production

```sh
npm start
# or via systemd (see deploy/home-source.service)
```

## Authentication

Passphrase-based with scrypt hashing and session cookies (30-day TTL). Cookie name: `hs_session`.

- When no household exists, the app redirects to `/setup` for onboarding
- Parents have full CRUD on all documents and settings
- Kids get read-only access to their own and shared documents
- Share links use token + optional PIN, no session required

## PKI Document Encryption

Home Source supports end-to-end encryption of individual documents using a
per-member public key infrastructure. The server never holds plaintext private
keys or DEKs — all encryption and decryption happens client-side in the browser.

### Cryptographic foundation

- **Key agreement**: X25519 ECDH (via Web Crypto)
- **Key wrapping**: AES-KW (RFC 3394) — nonce-free with intrinsic integrity
- **Data encryption**: AES-256-GCM per file (random DEK per document)
- **Key protection**: WebAuthn PRF extension (hardware keys) or PBKDF2
  passphrase derivation (fallback)
- **Recovery**: BIP39 12-word mnemonic wraps the member private key for
  offline recovery

### Envelope model

Each encrypted document carries a self-describing envelope in
`documents.encryption_metadata`:

```
document
  └── files
       └── upload
            ├── iv, tag, ciphertext (AES-256-GCM)
            └── holders[]
                 ├── holder 0: owner (wrapped DEK → owner's public key)
                 ├── holder 1: backup (wrapped DEK → backup key)
                 └── holder 2: beneficiary (wrapped DEK → alternate member)
```

Any one holder can independently decrypt (1-of-M access model). No threshold
or quorum is required.

### Key lifecycle

1. **Registration** — WebAuthn ceremony with PRF extension generates a
   hardware-bound key. Passphrase-derived keys available as fallback.
2. **Verification** — keys are marked verified after successful assertion.
3. **Recovery setup** — optional BIP39 mnemonic wraps the private key for
   offline recovery.
4. **Revocation** — logical disablement (`revoked_at` timestamp). Revoked
   keys are excluded from new encryptions and unlock eligibility. Note:
   revocation is currently irreversible — re-enrolling the same physical
   authenticator generates a new cryptographic identity.

### Multi-holder support

- **Backup keys** — same member registers a second key (e.g., YubiKey +
  1Password passkey). Existing encrypted documents can be extended with
  `POST /api/documents/:id/pki-holders/add`.
- **Trusted alternates** — parent can authorize another household member as
  a beneficiary holder on specific documents.
- **Holder roles**: `owner`, `backup`, `beneficiary`

### Current limitations

Key revocation does not rewrite existing document envelopes. Revoking the
sole active holder for a document renders it permanently unrecoverable.
Hardening work is planned to add dependency visibility, revoke guards, and
holder replacement flows — see
[planning/features/feature-11-pki-hardening-plan.md](planning/features/feature-11-pki-hardening-plan.md).

For the full security capabilities inventory, see
[docs/security-capabilities.md](docs/security-capabilities.md).

## Document Scanning

Client-side scanning via jscanify (vendored) + OpenCV.js (CDN):
- Live camera preview with auto-edge detection overlay
- Tap to capture, then adjust corners with draggable handles
- Multi-page capture flow: scan another page, reorder/remove pages, then save as one PDF
- Perspective correction applied client-side before upload
- Optional document filter (high contrast) and crop looseness control
- Client-side image compression (max 2400px, 85% JPEG quality)
- HEIC support for iPhone camera captures

## Backup System

Export format: `homesource-backup-{datetime}.tar.gz` containing:
- `manifest.json` with backup metadata and checksums
- `database.json` with full DB export
- `documents/` with all stored files
- `thumbnails/` (optional, can be regenerated)

Encrypted exports use Argon2id KDF + AES-256-GCM. Dashboard widget shows backup posture based on configurable expected frequency (default: 30 days).

For the full break-glass operator workflow, see:

- [docs/recovery-runbook.md](docs/recovery-runbook.md)

### Manual Decryption of Encrypted Document Files from Backup

If a document file was uploaded in encrypted mode, the backup preserves that ciphertext as-is.
You can decrypt an encrypted document locally using:

```sh
node bin/decrypt-backup-encrypted-doc.js \
  --database /path/to/extracted-backup/database.json \
  --backup-root /path/to/extracted-backup \
  --passphrase "your passphrase" \
  --doc-id 123
```

Or by exact title:

```sh
node bin/decrypt-backup-encrypted-doc.js \
  --database /path/to/extracted-backup/database.json \
  --backup-root /path/to/extracted-backup \
  --passphrase "your passphrase" \
  --title "Passport - Eric" \
  --out-dir /tmp/decrypted
```

Notes:
- This utility supports `passphrase` encrypted documents using both `passphrase_pbkdf2` and `passphrase_argon2id` wrapped-key schemes.
- It uses the document's stored `encryption_metadata` envelope and decrypts fully offline.
- For `passphrase_argon2id`, use a Node runtime that includes `crypto.argon2Sync` support.

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| DATABASE_URL | Yes | -- | PostgreSQL connection |
| PORT | No | 3008 | HTTP port |
| STORAGE_PATH | No | ./data | Document storage root |
| HOUSEHOLD_TIMEZONE | No | America/New_York | For display |
| MAX_FILE_SIZE_MB | No | 50 | Upload size limit |
| MAGICINDEX_PROVIDER | No | off | `off`, `openai`, `openai_compatible`, or `ollama` |
| MAGICINDEX_PROVIDER_PRIVATE | No | no | Set `yes` only for private/local providers; allows batch UI to default MagicIndex on |
| MAGICINDEX_PROVIDER_DEFAULT | No | openai_compatible | Provider preselected by the batch UI |
| MAGICINDEX_FETCH_TIMEOUT_MS | No | 90000 | Timeout (ms) for MagicIndex provider HTTP calls before worker marks attempt failed/retryable |
| MAGICINDEX_AUTO_APPLY_CONFIDENCE | No | 0.85 | Threshold for auto-applying safe MagicIndex fields |
| MAGICINDEX_COMPAT_BASE_URL | No | -- | OpenAI-compatible local endpoint, e.g. `http://lan-llm:8000/v1` |
| MAGICINDEX_COMPAT_MODEL | No | -- | Local model id, e.g. `qwen3:30b-a3b` |
| MAGICINDEX_COMPAT_API_KEY | No | -- | Optional local endpoint key; can be blank for LAN servers without auth |
| MAGICINDEX_OLLAMA_BASE_URL | No | -- | Ollama native base URL, e.g. `http://lan-llm:11434` (used when `MAGICINDEX_PROVIDER=ollama`) |
| MAGICINDEX_OLLAMA_MODEL | No | -- | Ollama model id, e.g. `qwen3-nothink` |
| MAGICINDEX_OLLAMA_API_KEY | No | -- | Optional bearer token if your Ollama proxy requires auth |
| MAGICINDEX_OPENAI_MODEL | No | gpt-5.4-nano | OpenAI cloud model when `MAGICINDEX_PROVIDER=openai` |
| MAGICINDEX_OPENAI_SEND_PDF | No | yes | Send PDFs directly as OpenAI Responses `input_file` content in cloud mode |
| OPENAI_API_KEY | No | -- | Required only for OpenAI cloud MagicIndex |

## Host Runtime Dependencies (Production)

For robust PDF/image processing in production, install:

- `poppler-utils` (provides `pdftotext` and `pdftoppm`)
- `tesseract-ocr`

These are now expected by Home Source hardening paths for:
- PDF text extraction fallback
- PDF thumbnail rendering fallback
- OCR fallback when documents are scanned/image-heavy


## Batch Import Worker

Smart Batch Import stages files through the web app and processes them in a separate worker so slow PDF thumbnailing or MagicIndex calls do not block HTTP requests.

Development:

```sh
npm run worker:import       # long-running worker
npm run worker:import:once  # process one queued job, useful for tests/debugging
```

Production should run both services:

- `deploy/home-source.service` for the web app
- `deploy/home-source-import-worker.service` for batch processing

For a local/private Qwen-style endpoint, use an OpenAI-compatible server and configure, for example:

```env
MAGICINDEX_PROVIDER=openai_compatible
MAGICINDEX_PROVIDER_PRIVATE=yes
MAGICINDEX_COMPAT_BASE_URL=http://lan-llm:8000/v1
MAGICINDEX_COMPAT_MODEL=qwen3:30b-a3b
MAGICINDEX_COMPAT_API_KEY=
```

With `MAGICINDEX_PROVIDER_PRIVATE=yes`, the batch UI may default MagicIndex on. For cloud providers or any endpoint that sends data outside the private home/LAN boundary, keep `MAGICINDEX_PROVIDER_PRIVATE=no` so MagicIndex defaults off.

OpenAI cloud mode uses the modern Responses API and sends PDF files directly as `input_file` content when `MAGICINDEX_OPENAI_SEND_PDF=yes`. This lets OpenAI handle born-digital PDFs and many scanned/mixed PDFs using its PDF text + page-image processing. Local OpenAI-compatible/Qwen mode does not receive raw PDFs; it uses extracted text previews and OCR fallback for scan-heavy documents.

Ollama-native mode (`MAGICINDEX_PROVIDER=ollama`) uses `/api/chat` with schema-constrained output (`format: <json schema>`), which is often more reliable than OpenAI-compat shims for strict local JSON extraction.

### Batch UX notes

- Batch page auto-refreshes while batches are `queued`/`running`.
- Failed item statuses and error messages surface in the batch item table.
- MagicIndex confidence view includes extraction source (for example `pdf_text_preview`, `pdf_ocr_preview`, `filename_only`).

## Single Add + MagicIndex

The Add Document page now includes a MagicIndex toggle (same provider/privacy defaults as batch config).  
When enabled, single upload/scan/url flows run MagicIndex immediately after document creation and auto-apply fields/tags/owners that pass confidence thresholds.

## Deployment

Designed for nginx subpath mounting at `/source/`. All fetch calls use relative paths.

```
Port: 3008
Mount path: /source/
Accent color: amber #d97706
```

See [deploy/](deploy/) for systemd unit and deploy script.

## Testing

```sh
npm test    # node --test (all test/*.test.js)
```
