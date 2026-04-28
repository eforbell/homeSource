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
| 3 | PDF Thumbnails | planned |
| 4 | MagicIndex (LLM auto-metadata) | planned |
| 5 | Multi-page Document Scanning | planned |
| 6 | Batch Uploads | planned |
| 7 | Search + Tags Integration | planned |
| 8 | Expiry Tracking + Alerts | planned |
| 9 | OCR (tesseract.js) | planned |
| 10 | MCP Server | planned |
| 11 | Envelope Encryption (DEK/KEK) | planned |

## Open bugBase Tickets

Tracked in bugBase under `home-source`. Check with:
```
mcp bugBase list_bug_tickets --app_slug home-source
```

## Design Invariants

- **Local-first**: No cloud storage dependencies. All documents on local disk.
- **Nginx subpath compatible**: All fetch() calls use relative paths. Never absolute `/api/...`.
- **No build step**: Vanilla HTML/CSS/JS frontend. Libraries from CDN or vendored.
- **Encryption-ready**: Schema includes encryption_keys and key_holders tables from day 1.
- **Mobile-first**: All UI designed for touch and small screens first, desktop second.
