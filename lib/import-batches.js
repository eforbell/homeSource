'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, withTransaction } = require('./db');
const { STORAGE_PATH, ALLOWED_MIME, MAX_FILE_SIZE } = require('./files');

const SOURCE_KINDS = new Set(['browser_files', 'browser_directory', 'server_folder', 'url_list']);
const ITEM_STATUSES = new Set(['staged', 'queued', 'stored', 'thumbnail_pending', 'thumbnail_done', 'magicindex_pending', 'magicindex_done', 'review_ready', 'imported', 'skipped_duplicate', 'failed', 'cancelled']);
const JOB_TYPES = new Set(['store_import_item', 'thumbnail', 'magicindex']);
const TERMINAL_ITEM_STATUSES = new Set(['imported', 'review_ready', 'skipped_duplicate', 'failed', 'cancelled']);
const ALLOWED_ITEM_UPDATE_FIELDS = new Set(['document_id', 'sha256', 'error_message', 'magicindex_result', 'magicindex_confidence']);

function normalizeOptions(options = {}) {
  return {
    magicindex_enabled: Boolean(options.magicindex_enabled),
    magicindex_provider: options.magicindex_provider || process.env.MAGICINDEX_PROVIDER || 'off',
    auto_apply_confidence: clampConfidence(options.auto_apply_confidence || process.env.MAGICINDEX_AUTO_APPLY_CONFIDENCE || 0.85),
    default_owner_ids: Array.isArray(options.default_owner_ids) ? options.default_owner_ids.map(Number).filter(Boolean) : [],
    default_tag_ids: Array.isArray(options.default_tag_ids) ? options.default_tag_ids.map(Number).filter(Boolean) : []
  };
}

function importStagingDir(batchId) {
  return path.join(STORAGE_PATH, 'import-staging', String(batchId));
}

function inferMimeType(filename, providedType) {
  if (providedType && providedType !== 'application/octet-stream') return providedType;
  const ext = path.extname(filename || '').toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff'
  };
  return map[ext] || providedType || 'application/octet-stream';
}

function safeRelativePath(input) {
  if (!input) return null;
  const normalized = String(input).replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/');
  return normalized || null;
}

function isIgnoredImportPath(input) {
  const normalized = safeRelativePath(input);
  if (!normalized) return true;
  const parts = normalized.split('/');
  return parts.some(part => part.startsWith('.') || part === '__MACOSX') || /(^|\/)Thumbs\.db$/i.test(normalized);
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.85;
  return Math.max(0, Math.min(1, n));
}

async function createBatch({ name, source_kind = 'browser_files', source_label = null, options = {}, created_by }) {
  const cleanName = String(name || 'Document import').trim().slice(0, 160) || 'Document import';
  if (!SOURCE_KINDS.has(source_kind)) throw new Error(`Invalid import source kind: ${source_kind}`);
  const normalized = normalizeOptions(options);
  const { rows } = await pool.query(`
    INSERT INTO import_batches (name, source_kind, source_label, options, created_by)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [cleanName, source_kind, source_label || null, JSON.stringify(normalized), created_by || null]);
  fs.mkdirSync(importStagingDir(rows[0].id), { recursive: true });
  return rows[0];
}

async function listBatches(limit = 25) {
  const { rows } = await pool.query(`
    SELECT b.*, COALESCE(counts.counts, '{}'::jsonb) AS item_counts
    FROM import_batches b
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(status, count) AS counts
      FROM (SELECT status, COUNT(*)::int AS count FROM import_items WHERE batch_id = b.id GROUP BY status) s
    ) counts ON true
    ORDER BY b.created_at DESC
    LIMIT $1
  `, [Math.min(Number(limit) || 25, 100)]);
  return rows;
}

async function getBatch(id) {
  const { rows } = await pool.query(`
    SELECT b.*, COALESCE(counts.counts, '{}'::jsonb) AS item_counts,
      COALESCE(job_counts.counts, '{}'::jsonb) AS job_counts
    FROM import_batches b
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(status, count) AS counts
      FROM (SELECT status, COUNT(*)::int AS count FROM import_items WHERE batch_id = b.id GROUP BY status) s
    ) counts ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(status, count) AS counts
      FROM (SELECT pj.status, COUNT(*)::int AS count FROM processing_jobs pj JOIN import_items ii ON ii.id = pj.import_item_id WHERE ii.batch_id = b.id GROUP BY pj.status) s
    ) job_counts ON true
    WHERE b.id = $1
  `, [id]);
  return rows[0] || null;
}

async function listItems(batchId, filters = {}) {
  const conditions = ['batch_id = $1'];
  const params = [batchId];
  let idx = 2;
  if (filters.status) {
    if (!ITEM_STATUSES.has(filters.status)) throw new Error(`Invalid import item status: ${filters.status}`);
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }
  const limit = Math.min(Number(filters.limit) || 100, 500);
  const offset = Number(filters.offset) || 0;
  const { rows } = await pool.query(`
    SELECT ii.*, d.title AS document_title, d.document_type
    FROM import_items ii
    LEFT JOIN documents d ON d.id = ii.document_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ii.id ASC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, limit, offset]);
  return rows;
}

async function stageImportItem(batchId, file, metadata = {}) {
  if (!file || !file.data?.length) throw new Error('No file provided');
  if (file.data.length > MAX_FILE_SIZE) throw new Error(`File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  const mimeType = inferMimeType(file.filename, file.type);
  if (!ALLOWED_MIME.has(mimeType)) throw new Error(`File type ${mimeType} not allowed`);
  const batch = await getBatch(batchId);
  if (!batch) throw new Error('Import batch not found');
  if (['cancelled', 'completed'].includes(batch.status)) throw new Error(`Cannot stage files into ${batch.status} batch`);
  const relativePath = safeRelativePath(metadata.relative_path || file.filename);
  if (isIgnoredImportPath(relativePath || file.filename)) throw new Error('Ignored hidden/system file');
  const dir = importStagingDir(batchId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file.filename || '') || '.bin';
  const stagedName = `${crypto.randomUUID()}${ext}`;
  const stagedPath = path.join(dir, stagedName);
  fs.writeFileSync(stagedPath, file.data);

  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO import_items (batch_id, original_filename, relative_path, source_uri, mime_type, file_size_bytes, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'queued')
      ON CONFLICT (batch_id, relative_path, original_filename) DO UPDATE SET
        source_uri = EXCLUDED.source_uri,
        mime_type = EXCLUDED.mime_type,
        file_size_bytes = EXCLUDED.file_size_bytes,
        status = 'queued',
        error_message = NULL,
        retry_count = import_items.retry_count + 1
      RETURNING *
    `, [batchId, file.filename || path.basename(relativePath || stagedName), relativePath, stagedPath, mimeType, file.data.length]);
    await enqueueJobWithClient(client, 'store_import_item', { import_item_id: rows[0].id, payload: {} });
    await client.query("UPDATE import_batches SET status = CASE WHEN status = 'queued' THEN 'queued' ELSE status END WHERE id = $1", [batchId]);
    return rows[0];
  });
}

async function startBatch(id) {
  const { rows } = await pool.query(`
    UPDATE import_batches
    SET status = 'running', started_at = COALESCE(started_at, NOW())
    WHERE id = $1 AND status IN ('queued','paused','completed_with_errors','failed')
    RETURNING *
  `, [id]);
  return rows[0] || getBatch(id);
}

async function cancelBatch(id) {
  return withTransaction(async (client) => {
    await client.query("UPDATE processing_jobs SET status = 'cancelled' WHERE status IN ('queued','running') AND import_item_id IN (SELECT id FROM import_items WHERE batch_id = $1)", [id]);
    await client.query("UPDATE import_items SET status = 'cancelled' WHERE batch_id = $1 AND status NOT IN ('imported','review_ready','skipped_duplicate','failed')", [id]);
    const { rows } = await client.query("UPDATE import_batches SET status = 'cancelled', completed_at = NOW() WHERE id = $1 RETURNING *", [id]);
    return rows[0] || null;
  });
}

async function retryItem(id) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      UPDATE import_items
      SET status = 'queued', error_message = NULL, retry_count = retry_count + 1
      WHERE id = $1 AND status IN ('failed','skipped_duplicate','cancelled')
      RETURNING *
    `, [id]);
    if (!rows[0]) return null;
    await enqueueJobWithClient(client, 'store_import_item', { import_item_id: id, payload: {} });
    return rows[0];
  });
}

async function enqueueJob(job_type, { import_item_id = null, document_id = null, payload = {}, run_after = new Date() }) {
  if (!JOB_TYPES.has(job_type)) throw new Error(`Invalid processing job type: ${job_type}`);
  const { rows } = await pool.query(`
    INSERT INTO processing_jobs (job_type, import_item_id, document_id, payload, run_after)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [job_type, import_item_id, document_id, JSON.stringify(payload || {}), run_after]);
  return rows[0];
}

async function enqueueJobWithClient(client, job_type, { import_item_id = null, document_id = null, payload = {}, run_after = new Date() }) {
  if (!JOB_TYPES.has(job_type)) throw new Error(`Invalid processing job type: ${job_type}`);
  const { rows } = await client.query(`
    INSERT INTO processing_jobs (job_type, import_item_id, document_id, payload, run_after)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [job_type, import_item_id, document_id, JSON.stringify(payload || {}), run_after]);
  return rows[0];
}

async function claimNextJob(workerId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      SELECT * FROM processing_jobs
      WHERE status = 'queued' AND run_after <= NOW()
      ORDER BY id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    if (!rows[0]) return null;
    const job = rows[0];
    const { rows: updated } = await client.query(`
      UPDATE processing_jobs
      SET status = 'running', attempts = attempts + 1, locked_at = NOW(), locked_by = $2
      WHERE id = $1
      RETURNING *
    `, [job.id, workerId]);
    return updated[0];
  });
}

async function completeJob(id) {
  await pool.query("UPDATE processing_jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL WHERE id = $1", [id]);
}

async function failJob(id, err, maxAttempts = 3) {
  const message = err?.message || String(err);
  const { rows } = await pool.query('SELECT attempts FROM processing_jobs WHERE id = $1', [id]);
  const attempts = rows[0]?.attempts || 1;
  const retry = attempts < maxAttempts;
  await pool.query(`
    UPDATE processing_jobs
    SET status = $2, last_error = $3, locked_at = NULL, locked_by = NULL,
      run_after = CASE WHEN $2 = 'queued' THEN NOW() + (($4 || ' seconds')::interval) ELSE run_after END
    WHERE id = $1
  `, [id, retry ? 'queued' : 'failed', message, Math.min(60, attempts * 5)]);
  return retry;
}

async function markItemFailed(id, err) {
  await pool.query('UPDATE import_items SET status = $2, error_message = $3 WHERE id = $1', [id, 'failed', err?.message || String(err)]);
}

async function recoverStaleRunningJobs({ staleMinutes = 10, maxAttempts = 3 } = {}) {
  const { rows } = await pool.query(`
    SELECT id, import_item_id, attempts
    FROM processing_jobs
    WHERE status = 'running' AND locked_at < NOW() - (($1 || ' minutes')::interval)
    ORDER BY locked_at ASC
  `, [Math.max(1, Number(staleMinutes) || 10)]);

  if (!rows.length) return { requeued: 0, failed: 0 };

  let requeued = 0;
  let failed = 0;
  for (const job of rows) {
    const shouldRetry = Number(job.attempts || 0) < Number(maxAttempts || 3);
    if (shouldRetry) {
      await pool.query(`
        UPDATE processing_jobs
        SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = NOW(),
            last_error = COALESCE(last_error, '') || CASE WHEN last_error IS NULL OR last_error = '' THEN '' ELSE ' | ' END || 'Recovered stale running job'
        WHERE id = $1
      `, [job.id]);
      requeued++;
      continue;
    }
    await pool.query(`
      UPDATE processing_jobs
      SET status = 'failed', locked_at = NULL, locked_by = NULL,
          last_error = COALESCE(last_error, '') || CASE WHEN last_error IS NULL OR last_error = '' THEN '' ELSE ' | ' END || 'Marked failed after stale timeout'
      WHERE id = $1
    `, [job.id]);
    if (job.import_item_id) {
      await markItemFailed(job.import_item_id, new Error('Import job timed out and exceeded retry attempts'));
      const { rows: itemRows } = await pool.query('SELECT batch_id FROM import_items WHERE id = $1', [job.import_item_id]);
      if (itemRows[0]?.batch_id) await maybeCompleteBatch(itemRows[0].batch_id);
    }
    failed++;
  }
  return { requeued, failed };
}

async function maybeCompleteBatch(batchId) {
  const batch = await getBatch(batchId);
  if (!batch) return null;
  const jobCounts = batch.job_counts || {};
  const pendingJobs = Number(jobCounts.queued || 0) + Number(jobCounts.running || 0);
  if (pendingJobs > 0) return batch;
  const counts = batch.item_counts || {};
  const total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
  if (!total) return batch;
  const terminal = Object.entries(counts).reduce((sum, [status, count]) => sum + (TERMINAL_ITEM_STATUSES.has(status) ? Number(count) : 0), 0);
  if (terminal !== total) return batch;
  const hasErrors = Number(counts.failed || 0) > 0;
  const status = hasErrors ? 'completed_with_errors' : 'completed';
  const { rows } = await pool.query('UPDATE import_batches SET status = $2, completed_at = COALESCE(completed_at, NOW()) WHERE id = $1 RETURNING *', [batchId, status]);
  return rows[0];
}

async function updateItemStatus(id, status, fields = {}) {
  if (!ITEM_STATUSES.has(status)) throw new Error(`Invalid import item status: ${status}`);
  const assignments = ['status = $2'];
  const params = [id, status];
  let idx = 3;
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_ITEM_UPDATE_FIELDS.has(key)) throw new Error(`Invalid import item update field: ${key}`);
    assignments.push(`${key} = $${idx++}`);
    params.push(key === 'magicindex_result' ? JSON.stringify(value) : value);
  }
  const { rows } = await pool.query(`UPDATE import_items SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0] || null;
}

module.exports = {
  createBatch,
  listBatches,
  getBatch,
  listItems,
  stageImportItem,
  startBatch,
  cancelBatch,
  retryItem,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  markItemFailed,
  recoverStaleRunningJobs,
  maybeCompleteBatch,
  updateItemStatus,
  normalizeOptions,
  importStagingDir,
  safeRelativePath,
  isIgnoredImportPath,
  clampConfidence,
  inferMimeType,
  ALLOWED_ITEM_UPDATE_FIELDS
};
