'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { pool } = require('./db');

const STORAGE_PATH = process.env.STORAGE_PATH || './data';
const MAX_FILE_SIZE = (Number(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024;
const THUMB_WIDTH = 300;

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/octet-stream',
  'image/jpeg', 'image/jpg', 'image/pjpeg',
  'image/png', 'image/webp', 'image/heic', 'image/heif',
  'image/tiff'
]);

function ensureDirs() {
  const year = new Date().getFullYear().toString();
  const docsDir = path.join(STORAGE_PATH, 'documents', year);
  const thumbDir = path.join(STORAGE_PATH, 'thumbnails');
  const exportsDir = path.join(STORAGE_PATH, 'exports');
  const importStagingDir = path.join(STORAGE_PATH, 'import-staging');
  try {
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(thumbDir, { recursive: true });
    fs.mkdirSync(exportsDir, { recursive: true });
    fs.mkdirSync(importStagingDir, { recursive: true });
  } catch (err) {
    if (err.code === 'EACCES') {
      console.error(`Cannot create storage directories at ${STORAGE_PATH} (permission denied). Ensure the directory exists and is writable by the app user.`);
      process.exit(1);
    }
    throw err;
  }
  return { docsDir, thumbDir, exportsDir, importStagingDir };
}

async function storeFile(fileBuffer, originalFilename, mimeType) {
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error(`File type ${mimeType} not allowed`);
  }

  const { docsDir, thumbDir } = ensureDirs();
  const ext = path.extname(originalFilename).toLowerCase() || mimeExtension(mimeType);
  const storedName = `${crypto.randomUUID()}${ext}`;
  const storedPath = path.join(docsDir, storedName);
  const sha256 = calculateSha256(fileBuffer);

  fs.writeFileSync(storedPath, fileBuffer);

  const result = {
    stored_filename: `documents/${new Date().getFullYear()}/${storedName}`,
    original_filename: originalFilename,
    mime_type: mimeType,
    file_size_bytes: fileBuffer.length,
    sha256,
    file_type: 'original'
  };

  return result;
}

async function processImageToPdf(fileBufferOrBuffers, originalFilename) {
  const buffers = Array.isArray(fileBufferOrBuffers) ? fileBufferOrBuffers.filter(Boolean) : [fileBufferOrBuffers];
  if (!buffers.length) throw new Error('No image data provided');
  const pdfDoc = await PDFDocument.create();

  for (const fileBuffer of buffers) {
    const image = sharp(fileBuffer);
    const optimized = await image
      .resize({ width: 2480, height: 3508, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const optimizedMeta = await sharp(optimized).metadata();
    const page = pdfDoc.addPage([optimizedMeta.width, optimizedMeta.height]);
    const img = await pdfDoc.embedJpg(optimized);
    page.drawImage(img, { x: 0, y: 0, width: optimizedMeta.width, height: optimizedMeta.height });
  }

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  const baseName = path.basename(originalFilename, path.extname(originalFilename));
  const pdfFilename = `${baseName}.pdf`;
  const stored = await storeFile(pdfBuffer, pdfFilename, 'application/pdf');
  stored.file_type = 'processed';
  stored.page_count = buffers.length;
  return stored;
}

async function generateThumbnail(storedFilePath, mimeType) {
  const { thumbDir } = ensureDirs();
  const thumbName = `${crypto.randomUUID()}_thumb.jpg`;
  const thumbPath = path.join(thumbDir, thumbName);
  const fullPath = path.join(STORAGE_PATH, storedFilePath);

  try {
    if (mimeType === 'application/pdf') {
      try {
        await sharp(fullPath, { page: 0, density: 150 })
          .resize(THUMB_WIDTH)
          .jpeg({ quality: 80 })
          .toFile(thumbPath);
      } catch {
        const rendered = await generatePdfThumbnailWithPoppler(fullPath, thumbPath);
        if (!rendered) await generatePlaceholderThumb(thumbPath);
      }
    } else {
      await sharp(path.resolve(fullPath))
        .resize(THUMB_WIDTH)
        .jpeg({ quality: 80 })
        .toFile(thumbPath);
    }

    return {
      stored_filename: `thumbnails/${thumbName}`,
      original_filename: 'thumbnail.jpg',
      mime_type: 'image/jpeg',
      file_size_bytes: fs.statSync(thumbPath).size,
      file_type: 'thumbnail'
    };
  } catch (err) {
    console.error('Thumbnail generation failed:', err.message);
    return null;
  }
}

async function generatePdfThumbnailWithPoppler(pdfPath, thumbPath) {
  const tmpPrefix = `${thumbPath}-${crypto.randomUUID()}-pdfthumb`;
  const tmpJpg = `${tmpPrefix}.jpg`;
  try {
    execFileSync('pdftoppm', ['-q', '-f', '1', '-l', '1', '-singlefile', '-jpeg', '-r', '150', pdfPath, tmpPrefix], {
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    });
    if (!fs.existsSync(tmpJpg)) return false;
    await sharp(tmpJpg).resize(THUMB_WIDTH).jpeg({ quality: 80 }).toFile(thumbPath);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmpJpg); } catch {}
  }
}

async function generatePlaceholderThumb(outputPath) {
  const svg = `<svg width="300" height="400" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="400" fill="#1e293b"/>
    <text x="150" y="200" font-family="sans-serif" font-size="48" fill="#d97706" text-anchor="middle">PDF</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(outputPath);
}

async function saveFileRecord(documentId, fileInfo) {
  const { rows } = await pool.query(`
    INSERT INTO document_files (document_id, file_type, stored_filename, original_filename, mime_type, file_size_bytes, page_count, version, sha256)
    VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT MAX(version) FROM document_files WHERE document_id = $1 AND file_type = $2), 0) + 1, $8)
    RETURNING *
  `, [documentId, fileInfo.file_type, fileInfo.stored_filename, fileInfo.original_filename, fileInfo.mime_type, fileInfo.file_size_bytes, fileInfo.page_count || null, fileInfo.sha256 || null]);
  return rows[0];
}

function getFilePath(storedFilename) {
  return path.join(STORAGE_PATH, storedFilename);
}

function calculateSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mimeExtension(mime) {
  const map = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/pjpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/tiff': '.tiff'
  };
  return map[mime] || '.bin';
}

function isImageMime(mime) {
  return mime.startsWith('image/');
}

module.exports = {
  storeFile,
  processImageToPdf,
  generateThumbnail,
  saveFileRecord,
  getFilePath,
  calculateSha256,
  isImageMime,
  ensureDirs,
  ALLOWED_MIME,
  MAX_FILE_SIZE,
  STORAGE_PATH
};
