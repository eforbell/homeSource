'use strict';

const path = require('path');
const { storeFile, processImageToPdf, generateThumbnail, saveFileRecord, isImageMime } = require('./files');
const { createDocument } = require('./documents');
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

  const primaryFile = processedFile || originalFile;
  const thumbnail = await generateThumbnail(primaryFile.stored_filename, primaryFile.mime_type);

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

  await audit.log('document.created', 'document', doc.id, memberId, {
    title: doc.title,
    source_type: doc.source_type,
    file_count: processedFile ? 2 : 1
  });

  return doc;
}

module.exports = { importFromUrl, processUpload };
