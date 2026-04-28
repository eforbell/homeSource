'use strict';

const path = require('path');
const { storeFile, processImageToPdf, generateThumbnail, saveFileRecord, isImageMime, getFilePath } = require('./files');
const { createDocument } = require('./documents');
const { analyzeDocument } = require('./magic-index');
const { getMagicIndexConfig } = require('./magic-index/config');
const { applyMagicIndexToDocument } = require('./magic-index/apply');
const audit = require('./audit');

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
  const originalFile = await storeFile(fileBuffer, originalFilename, mimeType);

  let processedFile = null;
  if (isImageMime(mimeType)) {
    processedFile = await processImageToPdf(fileBuffer, originalFilename);
  }

  const thumbSource = isImageMime(mimeType) ? originalFile : (processedFile || originalFile);
  const thumbnail = await generateThumbnail(thumbSource.stored_filename, thumbSource.mime_type);

  const ownerIds = metadata.owner_ids || [memberId];
  const doc = await createDocument({
    title: metadata.title || path.basename(originalFilename, path.extname(originalFilename)),
    description: metadata.description || null,
    document_type: metadata.document_type || 'other',
    source_type: metadata.source_type || (isImageMime(mimeType) ? 'scan' : 'upload'),
    source_url: metadata.source_url || null,
    issued_date: metadata.issued_date || null,
    expiry_date: metadata.expiry_date || null,
    metadata: metadata.extra_metadata || {},
    created_by: memberId
  }, ownerIds.map(id => ({ id: Number(id), type: 'owner' })));

  await saveFileRecord(doc.id, originalFile);
  if (processedFile) await saveFileRecord(doc.id, processedFile);
  if (thumbnail) await saveFileRecord(doc.id, thumbnail);

  if (metadata.magicindex_enabled === true) {
    try {
      const cfg = getMagicIndexConfig();
      const { result, provider, model } = await analyzeDocument({
        enabled: true,
        filePath: getFilePath(originalFile.stored_filename),
        filename: originalFile.original_filename,
        mimeType: originalFile.mime_type
      }, cfg);
      const autoApplied = await applyMagicIndexToDocument({
        documentId: doc.id,
        result,
        threshold: cfg.auto_apply_confidence,
        provider,
        model
      });
      await audit.log('magicindex.single_upload', 'document', doc.id, memberId, {
        source_type: metadata.source_type || 'upload',
        provider,
        model,
        confidence: result.confidence,
        fields: Object.keys(autoApplied)
      });
    } catch (err) {
      await audit.log('magicindex.single_upload_failed', 'document', doc.id, memberId, {
        source_type: metadata.source_type || 'upload',
        error: err.message
      });
    }
  }

  await audit.log('document.created', 'document', doc.id, memberId, {
    title: doc.title,
    source_type: doc.source_type,
    file_count: processedFile ? 2 : 1
  });

  return doc;
}

module.exports = { importFromUrl, processUpload };
