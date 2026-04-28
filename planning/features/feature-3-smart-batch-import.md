# HomeSource Day-2 Feature Plan: Smart Batch Import + MagicIndex

Date: 2026-04-28  
Scope: Home Source (`homeSource/`) MVP feature plan grounded in Bugbase #54, #56, #57.  
Primary outcome: remove the founder's import bottleneck by turning a Dropbox/OneDrive/local-folder pile into a reviewable, queryable family vault without one-by-one data entry.

## Executive Decision

Build **Smart Batch Import** as the second-day feature: a durable import-batch pipeline with a separate worker process, PDF thumbnail support, opt-in MagicIndex metadata extraction, and a batch review UI. This deliberately combines:

- **#57 Batch uploads**: multi-file/directory import and progress tracking.
- **#54 MagicIndex**: reusable document-analysis service for upload and batch paths.
- **#56 PDF thumbnails**: first-page PDF thumbnails so large PDF imports feel real and reviewable today.

Do **not** build vector search, full backup redesign, or provider-specific Dropbox/OneDrive API integrations in this slice. The source systems can remain redundant file stores for now; the HomeSource value is organized, searchable, shareable, estate-plannable records.

## Current Codebase Facts

- The app is a single Express server (`homeSource/server.js`) with static pages from `public/`; uploads currently enter via one multipart file in `POST /api/documents` (`server.js:324-340`) or by adding one file to one existing document (`server.js:370-390`).
- The multipart parser buffers the full request in memory and caps size against one file (`server.js:101-157`), so a many-file HTTP request is the wrong primitive for family-scale import.
- Upload processing is centralized enough to reuse: `processUpload` stores the file, optionally converts image to PDF, generates a thumbnail, creates the document, and saves file records (`lib/import.js:20-59`).
- Files are UUID-named under `STORAGE_PATH/documents/{year}` and thumbnails under `STORAGE_PATH/thumbnails` (`lib/files.js`, `storeFile`, `generateThumbnail`).
- PDF thumbnails already attempt `sharp(fullPath, { page: 0, density: 150 })` and fall back to a placeholder (`lib/files.js`, `generateThumbnail`), matching #56's deployment/runtime concern.
- Core metadata exists on `documents`: `document_type`, `issued_date`, `expiry_date`, `metadata JSONB`, owners, tags, and PostgreSQL full-text search over title/description/metadata (`db/schema.sql:61-106`).
- Document listing already supports facets by type, owner, tag, search, and created date (`lib/documents.js:5-65`; `public/documents.html` filter controls).
- Tests now exist (`npm test`) with API and file utility coverage, but no worker/queue/import-batch coverage yet. Baseline verification during planning: 96 tests passing, 0 failing.

## RALPLAN-DR Summary

### Principles

1. **Local-first and private by default**: family documents are sensitive; cloud LLM processing must be explicit opt-in and replaceable with a local LAN OpenAI-compatible endpoint.
2. **Durable, resumable, idempotent imports**: closing the browser, restarting the server, or hitting one bad file must not lose batch progress.
3. **One import path, many entry points**: single upload, batch upload, local-folder scan, URL import, and future OCR/vector processing should share the same processing primitives.
4. **Progressive usefulness**: documents should appear quickly with safe fallback metadata, then improve as thumbnails/MagicIndex/embeddings finish.
5. **Review before trust**: AI-suggested metadata accelerates import but should be marked with confidence and easy to accept/edit in batch.

### Decision Drivers

1. **Unblock starting today**: the founder needs to import a large real family corpus now, especially PDFs.
2. **Avoid MVP fragility**: this launch has had many main-branch fixes; the next feature needs strong queue boundaries and tests.
3. **Preserve future leverage**: the same extraction artifacts should later feed vector search, OCR, estate planning workflows, and richer faceted browsing.

### Viable Options Considered

| Option | Summary | Pros | Cons | Decision |
|---|---|---|---|---|
| A. Multi-file HTTP upload only | Add `<input multiple>` and POST many files through the current server route. | Fastest UI demo. | Buffers too much memory, couples slow AI/PDF work to HTTP, weak resume/retry, poor for thousands of files. | Reject. |
| B. Durable DB-backed batch + sidecar worker | HTTP creates batches/items; worker processes files with row locks and retries. | Resumable, observable, testable, works for local and cloud-sync folders, clean future OCR/vector hook. | More schema/API work. | Choose. |
| C. Local CLI importer only | `bin/import-folder.js` scans local Dropbox/OneDrive paths and imports. | Great for founder/server-local source folders. | No nontechnical UI, weak ongoing product story alone. | Use as adjunct after B. |
| D. Build vector search first | Extract text/chunks/embeddings before batch UX. | Long-term “ask your vault” value. | Does not solve import motivation/time today; adds dependency/LLM complexity early. | Defer, design tables to not block it. |

## Requirements Summary

### User-facing Requirements

1. Parent can create an import batch from multi-file selection and, where browser-supported, directory selection preserving relative paths.
2. Parent can optionally enable MagicIndex per batch with clear privacy copy and a provider picker:
   - Off / filename-only import.
   - Local OpenAI-compatible LLM endpoint if configured, including Qwen-style LAN servers.
   - OpenAI cloud analysis only if explicitly enabled.
   - If `.env` declares `MAGICINDEX_PROVIDER_PRIVATE=yes`, the UI may default MagicIndex on for new batches; otherwise MagicIndex defaults off.
3. Parent sees batch progress: discovered/staged, imported, thumbnailing, MagicIndex pending/running, review-ready, failed, skipped duplicate.
4. Each successfully stored document appears in normal document views quickly, even before MagicIndex finishes.
5. Batch review page shows a table of imported files with thumbnail, original filename/path, suggested title/type/dates/owners/tags/summary, confidence, error state, and direct document link.
6. High-confidence MagicIndex suggestions auto-apply according to conservative thresholds; parent can review/edit applied metadata, retry failed items, and skip/delete unwanted imports.
7. PDFs get meaningful first-page thumbnails when runtime support exists; if not, thumbnail generation fails gracefully with a visible worker warning, not an import blocker.
8. Duplicate files from Dropbox/OneDrive/local machines are detected by SHA-256 and surfaced as skipped/linked duplicates.

### Technical Requirements

1. Move long-running import work out of the HTTP serving process into `bin/import-worker.js` or equivalent.
2. Add durable DB state for import batches/items/jobs and file hashes.
3. Factor `lib/import.js` so single upload and batch worker call the same storage/document-creation path.
4. Add `lib/magic-index.js` as a provider-neutral interface returning validated structured metadata.
5. Add provider adapters behind one MagicIndex interface: OpenAI Responses API + Structured Outputs for cloud mode, and OpenAI-compatible HTTP endpoint support for LAN/local models such as Qwen3 30B A3B. The app must read provider/base URL/model/API key from `.env` and must not assume OpenAI.
6. Make MagicIndex schema strict, versioned, and stored with raw suggestions and accepted/rejected review state.
7. Keep document file storage local and deterministic; never mutate original files in Dropbox/OneDrive/local source folders.
8. Keep all API paths relative for nginx subpath compatibility, matching existing frontend guidance.

## Non-goals for This Slice

- Dropbox/OneDrive OAuth or remote file-provider APIs.
- Full vector search UI or pgvector migration.
- Full OCR for scanned images beyond minimal text extraction hooks.
- Backup redesign. Current source redundancy remains the practical backup during MVP import.
- Automatic deletion or reorganization of source files.
- Kids initiating imports; parent-only for now.

## Proposed Architecture

### 1. Database Migration

Add `002-import-batches.sql` with:

```sql
CREATE TABLE import_batches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('browser_files','browser_directory','server_folder','url_list')),
  source_label TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','completed','completed_with_errors','failed','cancelled')),
  options JSONB NOT NULL DEFAULT '{}',
  created_by INT REFERENCES family_members(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE import_items (
  id SERIAL PRIMARY KEY,
  batch_id INT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  document_id INT REFERENCES documents(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  relative_path TEXT,
  source_uri TEXT,
  mime_type TEXT,
  file_size_bytes BIGINT,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN (
    'staged','stored','thumbnail_pending','thumbnail_done','magicindex_pending',
    'magicindex_done','review_ready','imported','skipped_duplicate','failed','cancelled'
  )),
  error_message TEXT,
  magicindex_result JSONB,
  magicindex_confidence NUMERIC(4,3),
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, relative_path, original_filename)
);

ALTER TABLE document_files ADD COLUMN IF NOT EXISTS sha256 TEXT;
CREATE INDEX idx_document_files_sha256 ON document_files (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_import_items_batch_status ON import_items (batch_id, status);
CREATE INDEX idx_import_items_sha256 ON import_items (sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE processing_jobs (
  id SERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('store_import_item','thumbnail','magicindex')),
  import_item_id INT REFERENCES import_items(id) ON DELETE CASCADE,
  document_id INT REFERENCES documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  payload JSONB NOT NULL DEFAULT '{}',
  attempts INT NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_processing_jobs_pickup ON processing_jobs (status, run_after, id);
```

Also update `db/schema.sql` after migration is proven.

Why this shape:

- `import_batches` is the user-facing aggregate.
- `import_items` is the stable audit/review row for each source file.
- `processing_jobs` is generic enough for thumbnail/MagicIndex today and OCR/vector later.
- File `sha256` supports dedupe across Dropbox/OneDrive/local-machine duplicates.

### 2. Server/API Surface

Add parent-only endpoints:

- `POST api/import/batches` — create batch with `{ name, source_kind, options }`.
- `GET api/import/batches` — list recent batches with rollups.
- `GET api/import/batches/:id` — status and counts.
- `GET api/import/batches/:id/items?status=&limit=&offset=` — review table data.
- `POST api/import/batches/:id/items` — upload/stage **one file per request** with optional `relative_path`; creates import item + job.
- `POST api/import/batches/:id/start` — marks queued/running and wakes worker semantics.
- `POST api/import/items/:id/retry` — retry failed item.
- `POST api/import/items/:id/accept-magicindex` — apply suggestions to document metadata/tags/owners.
- `POST api/import/batches/:id/accept-high-confidence` — bulk accept suggestions above threshold.
- `POST api/import/batches/:id/cancel` — cancel queued work, do not delete already-created documents unless explicit future action is added.

Keep current `POST api/documents` route, but refactor it to call the same lower-level import primitives used by worker jobs.

### 3. Worker Process

Create `bin/import-worker.js` and package scripts:

```json
"worker:import": "node bin/import-worker.js",
"worker:import:once": "node bin/import-worker.js --once"
```

Worker loop:

1. Claim a queued job with `SELECT ... FOR UPDATE SKIP LOCKED`.
2. Mark `running`, increment attempts, set `locked_by`.
3. For `store_import_item`:
   - validate file still exists in staging,
   - hash file,
   - dedupe against `document_files.sha256`,
   - create document with safe fallback metadata (`title` from filename, `document_type='other'`, source upload),
   - save original file record with hash,
   - enqueue thumbnail and optional MagicIndex jobs.
4. For `thumbnail`:
   - call robust PDF/image thumbnail generation,
   - save thumbnail record or write structured failure to job/item without failing import.
5. For `magicindex`:
   - extract bounded text/first-page context,
   - call configured provider,
   - validate schema,
   - store suggestions on `import_items.magicindex_result`,
   - auto-apply only safe/high-confidence fields when MagicIndex is enabled, then set `review_ready` for human review/edit of applied and suggested fields.
6. Mark job succeeded/failed with retry backoff.
7. Update batch rollups/status.

Critical implementation rule: worker must be safe to kill and restart at any point.

### 4. File Staging and Memory Safety

Do not send a thousand files in one multipart body. Browser directory/multi-file upload should:

- create a batch,
- iterate selected files client-side,
- upload one file per request to `api/import/batches/:id/items`,
- show staging progress separately from processing progress,
- preserve `webkitRelativePath` when available.

For server-local Dropbox/OneDrive folders, add a later/adjunct CLI:

```sh
node bin/import-folder.js --path "$HOME/Dropbox/Family Docs" --batch "Dropbox April import" --member-id 1
```

If exposed in UI, restrict to allowlisted roots from env (`IMPORT_ALLOWED_ROOTS`) and never accept arbitrary paths from the browser.

### 5. MagicIndex Service Design (#54)

Add `lib/magic-index/`:

- `index.js`: `analyzeDocument({ filePath, mimeType, filename, textPreview, imagePreview, provider, model })`.
- `schema.js`: strict JSON schema and local validator.
- `providers/openai-responses.js`: OpenAI cloud adapter.
- `providers/openai-compatible-chat.js`: local/LAN adapter for Qwen-style servers.
- `extract.js`: bounded extraction helpers for PDFs/images.

Return schema version `magicindex.v1`:

```json
{
  "schema_version": "magicindex.v1",
  "title": "string",
  "document_type": "warranty|insurance|certificate|manual|receipt|contract|medical|legal|tax|identification|property|vehicle|other",
  "summary": "string",
  "issued_date": "YYYY-MM-DD|null",
  "expiry_date": "YYYY-MM-DD|null",
  "amount": { "value": 0, "currency": "USD", "confidence": 0 },
  "suggested_tags": [{ "name": "string", "confidence": 0 }],
  "suggested_owners": [{ "member_name": "string", "ownership_type": "owner|joint|beneficiary|custodian", "confidence": 0 }],
  "key_facts": [{ "label": "string", "value": "string", "confidence": 0 }],
  "confidence": 0,
  "needs_review_reasons": ["string"]
}
```

Provider decision:

- For OpenAI cloud mode, use the **Responses API** and Structured Outputs. OpenAI docs currently describe Responses as the recommended API for new text-generation projects and Structured Outputs as the way to enforce JSON Schema adherence.
- Keep the app-facing interface provider-neutral because local OpenAI-compatible servers frequently support Chat Completions before Responses. For local Qwen, use an OpenAI-compatible Chat Completions adapter with JSON schema when supported and JSON-mode+validation+retry fallback otherwise.
- Default env value may follow Bugbase #54 (`MAGICINDEX_OPENAI_MODEL=gpt-5.4-nano`), but put it behind env config and do not hardcode model assumptions throughout the app.

Privacy controls:

- `MAGICINDEX_PROVIDER=off|openai|openai_compatible` default `off`.
- `MAGICINDEX_PROVIDER_PRIVATE=yes|no` default `no`; when `yes`, HomeSource can treat the configured provider as private/local enough to default MagicIndex on for new batches. When `no`, MagicIndex stays off by default even if a provider is configured.
- `MAGICINDEX_PROVIDER_DEFAULT=openai_compatible` may preselect local mode in the UI; it only auto-enables MagicIndex when `MAGICINDEX_PROVIDER_PRIVATE=yes`.
- `MAGICINDEX_AUTO_APPLY_CONFIDENCE=0.85` default threshold for applying safe fields automatically.
- `MAGICINDEX_OPENAI_MODEL=gpt-5.4-nano` for explicit OpenAI cloud mode.
- `MAGICINDEX_COMPAT_BASE_URL=http://lan-llm:8000/v1` for local OpenAI-compatible servers.
- `MAGICINDEX_COMPAT_MODEL=qwen3:30b-a3b` or the exact model identifier exposed by the local server.
- `MAGICINDEX_COMPAT_API_KEY=` optional; allow blank/local dummy keys for LAN servers that do not enforce auth.
- `MAGICINDEX_MAX_PAGES=2` and `MAGICINDEX_MAX_CHARS=12000` for cost/privacy.
- UI copy: cloud analysis sends document text/previews to OpenAI; local analysis stays on configured LAN endpoint; filename-only import sends no document content to an LLM.

### 6. PDF Thumbnails (#56)

Make PDF thumbnails a worker job, not a blocking upload step.

Implementation details:

- Keep current Sharp PDF first-page strategy, but add capability detection and observability:
  - on boot/worker start, attempt a tiny fixture PDF render or inspect Sharp/libvips capabilities;
  - expose thumbnail capability in `GET api/import/batches/:id` warnings;
  - log `thumbnail.pdf_renderer_unavailable` once, not per file spam.
- If Sharp lacks PDF/Poppler support, generate the placeholder but mark item warning so the deployment fix is clear.
- Add tests for:
  - PDF thumbnail job returns a thumbnail record when renderer is mocked available;
  - fallback placeholder is produced when renderer fails;
  - thumbnail failure never marks import item failed.

### 7. Frontend UX

Add `public/import.html` or extend `upload.html` with a new “Batch Import” tab. Prefer a dedicated page once routes grow.

UI sections:

1. **Create batch**: name, source type, MagicIndex mode, owner defaults, tag defaults.
2. **Choose files/folder**: `<input type="file" multiple webkitdirectory>` plus drag/drop multi-file.
3. **Staging progress**: local count/bytes uploaded to HomeSource.
4. **Processing progress**: poll `api/import/batches/:id` every 1-2s while active.
5. **Review table**:
   - thumbnail,
   - source path,
   - status/error,
   - current document title/type,
   - AI suggestions/confidence,
   - accept/edit/open document actions.
6. **Done state**: “Imported N, skipped duplicates M, needs review K, failed F.”

Use existing `public/api.js` patterns, but add an upload helper that accepts extra form fields (`relative_path`) and progress callbacks if needed.

### 8. Refactor Plan

Refactor toward reusable stages without rewriting the whole app:

- Extract from `lib/import.js`:
  - `storeOriginalFileAndRecord(...)`
  - `createDocumentForImport(...)`
  - `enqueueThumbnailJob(...)`
  - `enqueueMagicIndexJob(...)`
- Keep `processUpload(...)` as the single-upload facade.
- Batch worker calls the extracted primitives.
- Avoid adding a heavy queue dependency; PostgreSQL row locking is enough for MVP.

### 9. Acceptance Criteria

1. A parent can create a batch, select at least 25 mixed PDF/image files, leave the page, return to the batch page, and see progress/results.
2. The HTTP server remains responsive while a batch is processing; slow LLM/PDF work runs in the worker process.
3. Each successfully processed file creates a document visible in `documents.html` with owner defaults and a link back to the batch/item in metadata.
4. Duplicate files with the same SHA-256 are skipped or linked without creating duplicate documents by default.
5. PDF uploads produce first-page thumbnails when runtime supports it; otherwise placeholder thumbnails appear and the batch reports a non-blocking renderer warning.
6. MagicIndex can be disabled; when disabled, batch import still works with filename-derived metadata.
7. MagicIndex cloud mode is opt-in and stores provider/model/schema version with every result.
8. MagicIndex local OpenAI-compatible mode can be configured without changing worker/import business logic.
9. Batch review shows which high-confidence suggestions were auto-applied, supports editing/reverting them, and supports manually applying suggestions that did not meet the threshold.
10. Failed items can be retried without duplicating already-created files/documents.
11. `npm test` passes, including new DB/API/worker tests.

## Implementation Steps

### Phase 0 — Baseline and Guardrails

1. Run current `npm test` and record baseline.
2. Add tests around current `processUpload` behavior before refactor if missing.
3. Add a tiny PDF/image fixture strategy for thumbnail tests.

### Phase 1 — Schema + Data Access

1. Add `002-import-batches.sql` migration and update `db/schema.sql`.
2. Add `lib/import-batches.js` for CRUD, item status transitions, rollups, and job enqueue/claim helpers.
3. Add tests for migration-backed batch/item/job operations.

### Phase 2 — Worker Skeleton

1. Add `bin/import-worker.js` with `--once` mode for tests.
2. Implement PG job claiming with `FOR UPDATE SKIP LOCKED`.
3. Implement idempotent status transitions and retry/backoff.
4. Add tests that two workers cannot process the same job.

### Phase 3 — Refactor Existing Upload Pipeline

1. Split reusable primitives out of `lib/import.js` without changing `POST api/documents` behavior.
2. Add SHA-256 calculation in `storeFile`/file record path.
3. Make single-upload route keep existing response shape.
4. Run existing upload/search/document tests.

### Phase 4 — Batch API and Browser Staging

1. Add batch endpoints to `server.js` or route module if the file is becoming too large.
2. Add one-file-per-request staging endpoint with `relative_path` metadata.
3. Add `public/import.html` and navigation entry.
4. Implement polling progress and review table read-only state.

### Phase 5 — PDF Thumbnail Job

1. Move thumbnail generation into worker job for batch items.
2. Add PDF renderer capability detection and structured warnings.
3. Preserve current placeholder fallback.
4. Add tests for success, fallback, and non-blocking failures.

### Phase 6 — MagicIndex Provider Interface

1. Add `lib/magic-index/schema.js` and validation tests.
2. Add provider-neutral `analyzeDocument` interface.
3. Implement OpenAI Responses adapter using strict structured output.
4. Implement OpenAI-compatible Chat Completions adapter with validation/retry fallback.
5. Add env config and privacy-safe defaults (`off`).
6. Add unit tests with mocked providers; no live API calls in normal test suite.

### Phase 7 — Batch Review + Apply Suggestions

1. Store MagicIndex result on `import_items`.
2. Add auto-apply for safe high-confidence suggestions during MagicIndex completion, plus accept-one/reapply APIs for review workflows.
3. Apply title/type/dates/description/summary/metadata and create/find suggested tags when confidence passes `MAGICINDEX_AUTO_APPLY_CONFIDENCE`.
4. Keep owners conservative: auto-apply owners only on exact family member match and high confidence; otherwise leave as suggestions.
5. Record whether each field was `auto_applied`, `suggested_only`, `edited`, or `rejected` in item/document metadata for auditability.
6. Add audit events: `import.batch_created`, `import.item_imported`, `magicindex.auto_applied`, `magicindex.applied`, `import.item_failed`.

### Phase 8 — Founder-scale Smoke Test

1. Run worker against a synthetic folder of 100 files (mixed PDFs/images/duplicates).
2. Verify memory remains stable and server remains responsive.
3. Verify failed/retry behavior by injecting one corrupt PDF and one unsupported file.
4. Verify batch review is usable on mobile and desktop.

## Test Plan

### Unit

- MagicIndex schema validation rejects invalid document types/dates/confidence ranges.
- Provider adapters normalize results into `magicindex.v1`.
- Hash/dedupe helpers produce stable hashes.
- Thumbnail fallback returns placeholder record and warning.

### Integration/API

- Parent-only batch create/list/detail/items endpoints.
- Kid cannot create/start/cancel/import batch.
- One-file staging creates import item and job.
- Worker `--once` processes staged item into document + file record.
- Duplicate file import marks item skipped without duplicate document.
- Retry failed item does not duplicate document/files.
- Accept MagicIndex updates document metadata and tags.

### End-to-end/manual

- Import 25+ files via browser multi-select.
- Import a browser directory preserving relative paths.
- Process with MagicIndex off.
- Process with mocked/local OpenAI-compatible endpoint.
- Verify PDF thumbnails on deployment target; if unavailable, warning points to libvips/poppler deployment fix.

### Observability

- Batch counts by status.
- Worker logs include job id/type/item id/document id/attempt.
- Batch detail includes warnings for PDF thumbnail capability and MagicIndex provider state.
- Audit log captures batch and MagicIndex actions.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Multipart parser buffers too much memory | Upload one file per request; do not batch files into one multipart body. |
| Worker creates duplicates after crash | Use SHA-256 dedupe and idempotent item/document state checks before creating records. |
| Local LLM produces malformed JSON | Strict schema validation, retry with repair prompt, store failure for review; never silently apply invalid suggestions. |
| Cloud LLM privacy concern | MagicIndex default off; explicit provider choice; bounded text/page extraction; store provider/model on result. |
| PDF thumbnails depend on native libvips/poppler | Capability check, placeholder fallback, deployment warning, worker job isolation. |
| Scope creep into vector search | Store extraction artifacts and summaries now; defer embeddings/pgvector/UI. |
| Single `server.js` grows too large | If adding routes makes it unwieldy, introduce route modules in small reversible steps. |

## ADR

### Decision

Implement Smart Batch Import as a DB-backed batch/item/job pipeline with a separate import worker, PDF thumbnail jobs, and opt-in provider-neutral MagicIndex analysis.

### Drivers

- The founder’s blocker is import scale and motivation, not storage availability.
- Slow PDF/LLM work must not run in the HTTP request path.
- HomeSource needs to become an organized, queryable, shareable vault, not just another folder browser.

### Alternatives Considered

- Multi-file HTTP upload only: rejected because it is memory-heavy and non-resumable.
- CLI-only local import: useful adjunct but not sufficient product UX.
- Vector search first: compelling future value but does not unblock import today.
- Cloud-only OpenAI MagicIndex: too risky for family-private documents and conflicts with local-sovereign positioning.

### Why Chosen

This architecture converts import from a fragile synchronous action into a durable product capability. It is the smallest design that solves “bring in the whole family archive” while creating clean seams for future OCR, vector retrieval, estate planning, local LLMs, and richer metadata browsing.

### Consequences

- Adds schema and operational complexity earlier than a simple multi-file upload.
- Requires a worker process in development/deployment.
- Creates a durable review surface that future features can reuse.
- Makes privacy/provider decisions explicit instead of buried inside upload code.

### Follow-ups

1. After this slice, add OCR/text extraction persistence and improve full-text search over document contents.
2. Add vector embeddings only after import/MagicIndex review is stable.
3. Add Dropbox/OneDrive provider APIs only if browser directory/local synced-folder workflows are insufficient.
4. Revisit backup posture after the founder’s corpus is actually in HomeSource.

## Suggested Execution Staffing

Solo `$ralph` path:

- One executor owns schema/API/worker in sequence.
- One verifier/code-review pass after implementation.
- Best when minimizing coordination overhead on a still-small MVP.

`$team` path:

- Executor 1: DB migration + `lib/import-batches.js`.
- Executor 2: worker + upload pipeline refactor.
- Executor 3: frontend batch import/review UI.
- Test engineer: integration tests and worker idempotency tests.
- Verifier: final API/manual smoke verification.

Team verification path before shutdown:

1. `npm test` passes.
2. Worker `--once` processes staged fixtures.
3. Browser batch import smoke test documented with screenshots/logs if available.
4. No source-path deletion/mutation occurs.
