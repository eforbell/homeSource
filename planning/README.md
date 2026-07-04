# Home Source -- Planning

Feature-driven development tracking for Home Source, the sovereign family document vault.

## Structure

- `current-feature.json` -- Active feature context and shipping history
- `progress.txt` -- Chronological development log
- `features/` -- Per-feature PRD (JSON) and summary (MD) pairs
- `camera-scanning-gotchas.md` -- Hard-won lessons from iOS/WKWebView camera scanning

## Feature Pipeline

| # | Feature | Status |
|---|---------|--------|
| 1 | Foundation (Schema + Auth + CRUD + Upload + Search + Backup + Sharing) | shipped |
| 2 | MVP Hardening (iOS fixes, scanner overhaul, mobile polish) | shipped |
| 3 | PDF Thumbnails | shipped |
| 4 | MagicIndex foundation + LLM extraction | shipped |
| 5 | Encrypted Document Modes (passphrase + PKI foundation) | shipped |
| 5A | Multi-page Document Scanning | shipped |
| 6 | Batch Uploads | shipped |
| 7 | Search + Tags Integration | future / partly shipped via browse/search work |
| 8 | Expiry Tracking + Alerts | future |
| 9 | OCR (tesseract.js) | future |
| 10 | MCP Server | future |
| 11 | PKI vaulted document access (single-holder, 1-of-M, lifecycle hardening H1-H4.2) | shipped foundation; future threshold/estate phases |
| 12 | PKI Key Posture and Readiness | planned |

## Open bugBase Tickets

Tracked in bugBase under `home-source`. Check with:
```
mcp bugBase list_bug_tickets --app_slug home-source
```

## Design Invariants

- **Local-first**: No cloud storage dependencies. All documents on local disk.
- **Nginx subpath compatible**: All fetch() calls use relative paths. Never absolute `/api/...`.
- **No build step**: Vanilla HTML/CSS/JS frontend. Libraries from CDN or vendored.
- **PKI envelope-canonical**: shipped PKI authorization lives in `documents.encryption_metadata`; `key_holders` remains reserved for estate-planning projection work.
- **Mobile-first**: All UI designed for touch and small screens first, desktop second.
