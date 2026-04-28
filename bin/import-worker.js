#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../lib/db');
const { createDocument } = require('../lib/documents');
const { storeFile, saveFileRecord, generateThumbnail, calculateSha256 } = require('../lib/files');
const batches = require('../lib/import-batches');
const { analyzeDocument } = require('../lib/magic-index');
const { getMagicIndexConfig } = require('../lib/magic-index/config');
const { applyMagicIndexToDocument } = require('../lib/magic-index/apply');
const audit = require('../lib/audit');

const workerId = `${process.pid}-${Math.random().toString(36).slice(2)}`;

async function processNextJob() {
  const job = await batches.claimNextJob(workerId);
  if (!job) return false;
  try {
    if (job.job_type === 'store_import_item') await processStoreImportItem(job);
    else if (job.job_type === 'thumbnail') await processThumbnail(job);
    else if (job.job_type === 'magicindex') await processMagicIndex(job);
    else throw new Error(`Unknown job type: ${job.job_type}`);
    await batches.completeJob(job.id);
    if (job.import_item_id) await maybeFinishItemAndBatch(job.import_item_id);
  } catch (err) {
    const retry = await batches.failJob(job.id, err);
    if (!retry && job.import_item_id) {
      await batches.markItemFailed(job.import_item_id, err);
      const item = await getItem(job.import_item_id);
      if (item) await batches.maybeCompleteBatch(item.batch_id);
    }
    console.error(`[import-worker] job ${job.id} ${job.job_type} failed:`, err.message);
  }
  return true;
}

async function getItem(id) {
  const { rows } = await pool.query('SELECT ii.*, b.options AS batch_options, b.created_by AS batch_created_by FROM import_items ii JOIN import_batches b ON b.id = ii.batch_id WHERE ii.id = $1', [id]);
  return rows[0] || null;
}

async function processStoreImportItem(job) {
  const item = await getItem(job.import_item_id);
  if (!item) throw new Error('Import item not found');
  if (!item.source_uri || !fs.existsSync(item.source_uri)) throw new Error('Staged source file is missing');
  if (item.document_id && ['stored', 'thumbnail_pending', 'thumbnail_done', 'magicindex_pending', 'magicindex_done', 'review_ready', 'imported'].includes(item.status)) return;

  const buffer = fs.readFileSync(item.source_uri);
  const sha256 = calculateSha256(buffer);
  const duplicate = await findDuplicate(sha256);
  if (duplicate) {
    await batches.updateItemStatus(item.id, 'skipped_duplicate', {
      document_id: duplicate.document_id,
      sha256,
      error_message: 'Duplicate file already exists in HomeSource'
    });
    await audit.log('import.item_skipped_duplicate', 'import_item', item.id, item.batch_created_by, { document_id: duplicate.document_id, sha256 });
    return;
  }

  const stored = await storeFile(buffer, item.original_filename, item.mime_type);

  const options = item.batch_options || {};
  const ownerIds = options.default_owner_ids?.length ? options.default_owner_ids : [item.batch_created_by].filter(Boolean);
  const doc = await createDocument({
    title: filenameTitle(item.original_filename),
    document_type: 'other',
    source_type: 'upload',
    description: null,
    metadata: {
      import_batch_id: item.batch_id,
      import_item_id: item.id,
      original_relative_path: item.relative_path || null,
      magicindex: { state: options.magicindex_enabled ? 'pending' : 'disabled' }
    },
    created_by: item.batch_created_by
  }, ownerIds.map(id => ({ id: Number(id), type: 'owner' })));

  await saveFileRecord(doc.id, stored);
  await batches.updateItemStatus(item.id, 'stored', { document_id: doc.id, sha256: stored.sha256, error_message: null });
  await audit.log('import.item_imported', 'import_item', item.id, item.batch_created_by, { document_id: doc.id, batch_id: item.batch_id });

  await batches.enqueueJob('thumbnail', { import_item_id: item.id, document_id: doc.id, payload: { stored_filename: stored.stored_filename, mime_type: stored.mime_type } });
  if (options.magicindex_enabled) {
    await batches.enqueueJob('magicindex', { import_item_id: item.id, document_id: doc.id, payload: { file_path: item.source_uri, filename: item.original_filename, mime_type: item.mime_type } });
    await batches.updateItemStatus(item.id, 'magicindex_pending');
  } else {
    await batches.updateItemStatus(item.id, 'thumbnail_pending');
  }
}

async function processThumbnail(job) {
  const payload = job.payload || {};
  const item = await getItem(job.import_item_id);
  if (!item?.document_id) throw new Error('Thumbnail job missing document');
  const thumb = await generateThumbnail(payload.stored_filename, payload.mime_type);
  if (thumb) await saveFileRecord(item.document_id, thumb);
  if (item.status === 'thumbnail_pending') await batches.updateItemStatus(item.id, 'imported');
  else if (item.status === 'stored') await batches.updateItemStatus(item.id, 'thumbnail_done');
}

async function processMagicIndex(job) {
  const item = await getItem(job.import_item_id);
  if (!item?.document_id) throw new Error('MagicIndex job missing document');
  const payload = job.payload || {};
  const config = getMagicIndexConfig();
  try {
    const { result, provider, model } = await analyzeDocument({
      enabled: true,
      filePath: payload.file_path,
      filename: payload.filename || item.original_filename,
      mimeType: payload.mime_type || item.mime_type
    }, config);
    const autoApplied = await applyMagicIndexToDocument({
      documentId: item.document_id,
      result,
      threshold: config.auto_apply_confidence,
      provider,
      model,
      force: false
    });
    await batches.updateItemStatus(item.id, 'review_ready', {
      magicindex_result: { ...result, provider, model, auto_applied: autoApplied },
      magicindex_confidence: result.confidence
    });
    await audit.log('magicindex.auto_applied', 'document', item.document_id, item.batch_created_by, {
      import_item_id: item.id,
      provider,
      model,
      fields: Object.keys(autoApplied)
    });
  } catch (err) {
    await markMagicIndexWarning(item, err, config);
  }
}

async function markMagicIndexWarning(item, err, config) {
  const metadata = await mergedMetadata(item.document_id, {
    magicindex: {
      state: 'failed',
      provider: config.provider,
      model: config.provider === 'openai_compatible' ? config.compatible.model : config.openai.model,
      error: err.message,
      failed_at: new Date().toISOString()
    }
  });
  await updateDocument(item.document_id, { metadata });
  await batches.updateItemStatus(item.id, 'review_ready', {
    magicindex_result: {
      schema_version: 'magicindex.v1',
      provider: config.provider,
      model: config.provider === 'openai_compatible' ? config.compatible.model : config.openai.model,
      confidence: 0,
      auto_applied: {},
      error: err.message,
      needs_review_reasons: ['MagicIndex failed; document imported with filename metadata']
    },
    magicindex_confidence: 0,
    error_message: `MagicIndex failed: ${err.message}`
  });
  await audit.log('magicindex.failed', 'document', item.document_id, item.batch_created_by, { import_item_id: item.id, error: err.message });
}

async function findDuplicate(sha256) {
  if (!sha256) return null;
  const { rows } = await pool.query(`
    SELECT document_id, id AS file_id FROM document_files
    WHERE sha256 = $1 AND file_type = 'original'
    ORDER BY id ASC LIMIT 1
  `, [sha256]);
  return rows[0] || null;
}

async function maybeFinishItemAndBatch(itemId) {
  const item = await getItem(itemId);
  if (!item) return;
  const { rows: pending } = await pool.query("SELECT COUNT(*)::int AS count FROM processing_jobs WHERE import_item_id = $1 AND status IN ('queued','running')", [itemId]);
  if (pending[0].count === 0 && item.status === 'thumbnail_done') {
    await batches.updateItemStatus(itemId, 'imported');
  }
  await batches.maybeCompleteBatch(item.batch_id);
}

function filenameTitle(filename) {
  return path.basename(filename || 'Document', path.extname(filename || '')).replace(/[-_]+/g, ' ').trim() || 'Document';
}

async function runLoop({ once = false, idleMs = 1500 } = {}) {
  do {
    const processed = await processNextJob();
    if (once) break;
    if (!processed) await new Promise(resolve => setTimeout(resolve, idleMs));
  } while (true);
}

if (require.main === module) {
  runLoop({ once: process.argv.includes('--once') })
    .then(() => pool.end())
    .catch(async (err) => {
      console.error('[import-worker] fatal:', err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { processNextJob, runLoop, filenameTitle };
