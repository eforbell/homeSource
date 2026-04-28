# Feature 1: Foundation

## Purpose

Stand up the complete document vault: database schema, auth system, document CRUD, file upload with image-to-PDF conversion and thumbnail generation, full-text search, tagging, ownership model, share links with PIN protection, backup export with optional encryption, and all frontend pages. This was the initial build-out — everything needed for a functional sovereign document vault.

## Scope

1. Node/Express scaffold with PostgreSQL, docker-compose dev environment
2. Full database schema (16 tables including day-2 encryption tables)
3. Passphrase auth with scrypt hashing, session cookies, parent/kid roles
4. Bootstrap/onboarding flow for first household setup
5. Document CRUD with 13 document types and flexible JSONB metadata
6. File upload + storage with UUID-based filenames organized by year
7. Image processing: sharp for thumbnails/resize, pdf-lib for image-to-PDF wrapping
8. HEIC support for iPhone camera captures
9. Client-side document scanning via jscanify + OpenCV.js
10. Joint document ownership model (owner, joint, beneficiary, custodian)
11. Color-coded tagging system
12. Full-text search with PostgreSQL tsvector + trigger-maintained search_vector
13. URL import (fetch remote document and store locally)
14. Share links with token auth, optional PIN (scrypt-hashed), expiry, usage limits
15. Backup export as tar.gz with manifest.json, optional Argon2id + AES-256-GCM encryption
16. Backup posture tracking with configurable frequency and dashboard widget
17. Audit log for all document access, shares, and backups
18. Frontend: 10 pages (dashboard, documents, document detail, upload/scan, search, backup, settings, setup, login, share view)
19. Dark theme, mobile-first responsive, nginx subpath compatible

## Key Decisions

- All tables created from day 1 including encryption_keys and key_holders (schema ready for envelope encryption later)
- jscanify vendored locally after CDN path was 404
- Backup encryption uses Argon2id KDF (not bcrypt/scrypt) for memory-hard protection
- No build step, no bundler — vanilla HTML/CSS/JS with CDN libs only on pages that need them

## Shipped

Commit `f9b270a` — "Initial implementation: sovereign family document vault (Phase 1 + 2)"
