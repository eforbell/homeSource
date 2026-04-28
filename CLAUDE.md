# CLAUDE.md

## What This Is

Sovereign family document vault. Part of the sovereign-home app suite. Stores warranties,
insurance docs, critical records (birth certificates, passports), manuals, and more. Supports
phone camera scanning with client-side perspective correction, URL import, and file upload.
Local-first storage with offline backup to USB/media.

## Dev Commands

```bash
npm install            # first time
npm run dev            # node --watch (Node 18+)
npm start              # production

# Database (Docker)
docker-compose up -d   # start PostgreSQL
node db/migrate.js     # apply migrations (idempotent)

# Tests
npm test               # node --test (all test/*.test.js)
```

Copy `.env.example` to `.env` and fill in values.

## Architecture

Single-process Node.js/Express. No build step. Vanilla HTML/CSS/JS frontend.

```
server.js              # Express — all routes
lib/
  db.js                # Pool wrapper
  auth.js              # Passphrase hashing, sessions, middleware
  documents.js         # Document CRUD operations
  files.js             # File storage, thumbnails, image→PDF
  search.js            # Full-text search queries
  share.js             # Share link management
  backup.js            # Export/backup logic
  import.js            # URL import, scan processing
db/
  migrations/          # Numbered SQL migrations
  migrate.js           # Migration runner
  schema.sql           # Canonical schema snapshot
deploy/
  home-source.service  # systemd unit
  deploy.sh            # Deploy script
public/                # Static frontend
data/                  # Document storage (gitignored)
test/                  # node:test test files
```

## Key Design Decisions

### Auth
Passphrase-based with scrypt hashing and session cookies (30-day TTL).
Cookie name: `hs_session`. Parents have full CRUD; kids get read-only on own/shared docs.

### File Storage
Local disk at `STORAGE_PATH` (default `./data`). Files stored with UUID names organized
by year. Thumbnails generated via sharp. HEIC supported for iPhone captures.

### Document Scanning
Client-side via jscanify + OpenCV.js. Auto-detects document boundaries, perspective
correction, then uploads processed image. Libraries loaded from CDN only on upload page.

### Backup Posture
Configurable expected frequency (default 30 days). Dashboard shows green/yellow/red status.
Exports as tar.gz with manifest.json. Optional Argon2id + AES-256-GCM encryption.

### Nginx subpath compatible
All fetch() calls use relative paths. App runs on port 3008; nginx maps `/source/`.

### Encryption (Day 2)
Schema present from day 1. Envelope encryption model: documents encrypted with DEK,
DEKs encrypted per-holder with their KEK. Multi-sig covenants for inheritance.

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| DATABASE_URL | Yes | — | PostgreSQL connection |
| PORT | No | 3008 | HTTP port |
| STORAGE_PATH | No | ./data | Document storage root |
| HOUSEHOLD_TIMEZONE | No | America/New_York | For display |
| MAX_FILE_SIZE_MB | No | 50 | Upload size limit |

## Data Model

Core tables: family_members, sessions, app_config, documents, document_files,
document_owners, tags, document_tags, share_links, backup_log, audit_log,
encryption_keys, key_holders.

Accent color: amber #d97706.
