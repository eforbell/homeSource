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

## Document Scanning

Client-side scanning via jscanify (vendored) + OpenCV.js (CDN):
- Live camera preview with auto-edge detection overlay
- Tap to capture, then adjust corners with draggable handles
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

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| DATABASE_URL | Yes | -- | PostgreSQL connection |
| PORT | No | 3008 | HTTP port |
| STORAGE_PATH | No | ./data | Document storage root |
| HOUSEHOLD_TIMEZONE | No | America/New_York | For display |
| MAX_FILE_SIZE_MB | No | 50 | Upload size limit |

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
