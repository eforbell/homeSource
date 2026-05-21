'use strict';

const path = require('path');
const { pool } = require('./db');
const { storeFile, processImageToPdf, generateThumbnail, saveFileRecord, isImageMime, getFilePath } = require('./files');
const { createDocument } = require('./documents');
const audit = require('./audit');
const { normalizeEncryptionInput } = require('./encryption-mode');

async function importFromUrl(url, metadata, memberId) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch URL: ${resp.status} ${resp.statusText}`);

  const contentType = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/pdf';
  const buffer = Buffer.from(await resp.arrayBuffer());

  const urlPath = new URL(url).pathname;
  const filename = path.basename(urlPath) || 'imported-document';

  return processUpload(buffer, filename, contentType, {
    ...metadata,
    source_type: 'url_import',
    source_url: url
  }, memberId);
}

async function processUpload(fileBuffer, originalFilename, mimeType, metadata, memberId) {
  const encryption = normalizeEncryptionInput(metadata || {});
  const originalFile = await storeFile(fileBuffer, originalFilename, mimeType);

  let processedFile = null;
  if (!encryption.is_encrypted && isImageMime(mimeType)) {
    processedFile = await processImageToPdf(fileBuffer, originalFilename);
  }

  const thumbSource = isImageMime(mimeType) ? originalFile : (processedFile || originalFile);
  const thumbnail = encryption.is_encrypted ? null : await generateThumbnail(thumbSource.stored_filename, thumbSource.mime_type);

  const ownerIds = metadata.owner_ids || [memberId];
  const magicindexEnabled = !encryption.is_encrypted && metadata.magicindex_enabled === true;
  const baseMetadata = {
    ...(metadata.extra_metadata || {}),
    magicindex: {
      state: magicindexEnabled ? 'pending' : 'disabled',
      queued_at: magicindexEnabled ? new Date().toISOString() : undefined
    }
  };
  const doc = await createDocument({
    title: metadata.title || path.basename(originalFilename, path.extname(originalFilename)),
    description: metadata.description || null,
    document_type: metadata.document_type || 'other',
    source_type: metadata.source_type || (isImageMime(mimeType) ? 'scan' : 'upload'),
    source_url: metadata.source_url || null,
    issued_date: metadata.issued_date || null,
    expiry_date: metadata.expiry_date || null,
    metadata: baseMetadata,
    is_encrypted: encryption.is_encrypted,
    encryption_mode: encryption.encryption_mode,
    encryption_metadata: encryption.encryption_metadata,
    created_by: memberId
  }, ownerIds.map(id => ({ id: Number(id), type: 'owner' })));

  await saveFileRecord(doc.id, originalFile);
  if (processedFile) await saveFileRecord(doc.id, processedFile);
  if (thumbnail) await saveFileRecord(doc.id, thumbnail);

  if (magicindexEnabled) await queueSingleUploadMagicIndex(doc.id, originalFile, metadata.source_type || 'upload', memberId);

  await audit.log('document.created', 'document', doc.id, memberId, {
    title: doc.title,
    source_type: doc.source_type,
    file_count: processedFile ? 2 : 1
  });

  return doc;
}

async function processMultiPageScanUpload(pageBuffers, metadata, memberId) {
  const encryption = normalizeEncryptionInput(metadata || {});
  const pages = Array.isArray(pageBuffers) ? pageBuffers.filter((b) => b?.length) : [];
  if (!pages.length) throw new Error('No scan pages provided');
  if (encryption.is_encrypted) throw new Error('Encrypted mode is not supported for multi-page scan uploads yet');
  const processedPdf = await processImageToPdf(pages, 'scanned-document.jpg');
  processedPdf.file_type = 'original';
  const thumbnail = await generateThumbnail(processedPdf.stored_filename, processedPdf.mime_type);
  const ownerIds = metadata.owner_ids || [memberId];
  const magicindexEnabled = metadata.magicindex_enabled === true;
  const baseMetadata = {
    ...(metadata.extra_metadata || {}),
    scan_page_count: pages.length,
    magicindex: {
      state: magicindexEnabled ? 'pending' : 'disabled',
      queued_at: magicindexEnabled ? new Date().toISOString() : undefined
    }
  };
  const doc = await createDocument({
    title: metadata.title || `Scanned Document (${pages.length} pages)`,
    description: metadata.description || null,
    document_type: metadata.document_type || 'other',
    source_type: 'scan',
    source_url: null,
    issued_date: metadata.issued_date || null,
    expiry_date: metadata.expiry_date || null,
    metadata: baseMetadata,
    created_by: memberId
  }, ownerIds.map(id => ({ id: Number(id), type: 'owner' })));
  await saveFileRecord(doc.id, processedPdf);
  if (thumbnail) await saveFileRecord(doc.id, thumbnail);
  if (magicindexEnabled) await queueSingleUploadMagicIndex(doc.id, processedPdf, 'scan', memberId);
  await audit.log('document.created', 'document', doc.id, memberId, {
    title: doc.title,
    source_type: doc.source_type,
    file_count: thumbnail ? 2 : 1
  });
  return doc;
}

async function queueSingleUploadMagicIndex(documentId, fileRecord, sourceType, memberId) {
  return queueDocumentMagicIndexReanalysis({
    documentId,
    fileRecord,
    sourceType,
    memberId
  });
}

function normalizeUserHint(userHint) {
  const cleaned = String(userHint || '').trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, 500) : '';
}

async function queueDocumentMagicIndexReanalysis({ documentId, fileRecord, sourceType, memberId, userHint = '' }) {
  const normalizedHint = normalizeUserHint(userHint);
  await pool.query(`
    INSERT INTO processing_jobs (job_type, import_item_id, document_id, payload, run_after)
    VALUES ('magicindex', NULL, $1, $2, NOW())
  `, [documentId, JSON.stringify({
    file_path: getFilePath(fileRecord.stored_filename),
    filename: fileRecord.original_filename,
    mime_type: fileRecord.mime_type,
    source_type: sourceType,
    single_upload: true,
    user_hint: normalizedHint || null
  })]);
  const { rows } = await pool.query('SELECT metadata FROM documents WHERE id = $1', [documentId]);
  const metadata = {
    ...(rows[0]?.metadata || {}),
    magicindex: {
      ...((rows[0]?.metadata || {}).magicindex || {}),
      state: 'pending',
      queued_at: new Date().toISOString(),
      user_hint: normalizedHint || undefined
    }
  };
  await pool.query('UPDATE documents SET metadata = $2 WHERE id = $1', [documentId, JSON.stringify(metadata)]);
  await audit.log('magicindex.single_upload_queued', 'document', documentId, memberId, {
    source_type: sourceType,
    user_hint: normalizedHint || null
  });
}

function pickDocumentMagicIndexFile(doc) {
  const files = Array.isArray(doc?.files) ? doc.files : [];
  if (doc?.source_type === 'scan') {
    return files.find((f) => f.file_type === 'processed' && f.mime_type === 'application/pdf')
      || files.find((f) => f.file_type === 'original' && f.mime_type === 'application/pdf')
      || files.find((f) => f.file_type === 'original');
  }
  return files.find((f) => f.file_type === 'original')
    || files.find((f) => f.file_type === 'processed')
    || null;
}

module.exports = { importFromUrl, processUpload, processMultiPageScanUpload, queueDocumentMagicIndexReanalysis, pickDocumentMagicIndexFile, normalizeUserHint };
