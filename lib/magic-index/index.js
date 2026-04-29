'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getMagicIndexConfig } = require('./config');
const { assertMagicIndexResult } = require('./schema');
const { analyzeWithOpenAICompatible } = require('./providers/openai-compatible-chat');
const { analyzeWithOpenAIResponses } = require('./providers/openai-responses');
const { analyzeWithOllamaChat } = require('./providers/ollama-chat');

function filenameOnlyResult(filename) {
  const title = path.basename(filename || 'Document', path.extname(filename || '')).replace(/[-_]+/g, ' ').trim() || 'Document';
  return assertMagicIndexResult({
    title,
    document_type: 'other',
    summary: '',
    issued_date: null,
    expiry_date: null,
    suggested_tags: [],
    suggested_owners: [],
    key_facts: [],
    confidence: 0.25,
    needs_review_reasons: ['MagicIndex provider is off; filename-only metadata used']
  });
}

function readTextPreview(filePath, maxChars) {
  if (!filePath || !fs.existsSync(filePath)) return { text: '', source: 'filename_only', extractor: 'none', error: null };
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return readPdfTextPreview(filePath, maxChars);
  if (['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'].includes(ext)) return readImageTextPreview(filePath, maxChars);
  if (!['.txt', '.md', '.csv', '.json'].includes(ext)) return { text: '', source: 'filename_only', extractor: 'none', error: null };
  return {
    text: fs.readFileSync(filePath, 'utf8').slice(0, maxChars),
    source: 'text_preview',
    extractor: 'native_text',
    error: null
  };
}

function readPdfTextPreview(filePath, maxChars) {
  // Prefer pdftotext first; fallback to OCR for scanned PDFs.
  try {
    const out = execFileSync('pdftotext', ['-q', '-enc', 'UTF-8', '-f', '1', '-l', '5', filePath, '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024
    });
    const text = String(out || '')
      .replace(/\u0000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);
    if (text) return { text, source: 'pdf_text_preview', extractor: 'pdftotext', error: null };
    const ocr = readPdfOcrPreview(filePath, maxChars);
    if (ocr.text) return ocr;
    return { text: '', source: 'filename_only', extractor: 'pdftotext+ocr', error: ocr.error || null };
  } catch (err) {
    const ocr = readPdfOcrPreview(filePath, maxChars);
    if (ocr.text) return ocr;
    return { text: '', source: 'filename_only', extractor: 'pdftotext+ocr', error: String(err?.message || 'pdftotext failed') };
  }
}

function readPdfOcrPreview(filePath, maxChars) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-magicindex-ocr-'));
  const prefix = path.join(tmpDir, 'page');
  try {
    execFileSync('pdftoppm', ['-q', '-f', '1', '-l', '3', '-r', '200', '-png', filePath, prefix], {
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    });
    const pageFiles = fs.readdirSync(tmpDir).filter((name) => /^page-\d+\.png$/i.test(name)).sort();
    let text = '';
    for (const pageFile of pageFiles) {
      const pagePath = path.join(tmpDir, pageFile);
      const out = execFileSync('tesseract', [pagePath, 'stdout', '-l', 'eng', '--psm', '6'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024
      });
      text += `\n${String(out || '')}`;
      if (text.length >= maxChars) break;
    }
    const cleaned = text.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (cleaned) return { text: cleaned, source: 'pdf_ocr_preview', extractor: 'tesseract', error: null };
    return { text: '', source: 'filename_only', extractor: 'tesseract', error: 'OCR produced no text' };
  } catch (err) {
    return { text: '', source: 'filename_only', extractor: 'tesseract', error: String(err?.message || 'OCR failed') };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function readImageTextPreview(filePath, maxChars) {
  try {
    const out = execFileSync('tesseract', [filePath, 'stdout', '-l', 'eng', '--psm', '6'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    });
    const text = String(out || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (text) return { text, source: 'image_ocr_preview', extractor: 'tesseract', error: null };
    return { text: '', source: 'filename_only', extractor: 'tesseract', error: 'OCR produced no text' };
  } catch (err) {
    return { text: '', source: 'filename_only', extractor: 'tesseract', error: String(err?.message || 'OCR failed') };
  }
}

async function analyzeDocument(input, overrideConfig = null) {
  const config = overrideConfig || getMagicIndexConfig();
  if (!input?.enabled || config.provider === 'off') {
    return { result: filenameOnlyResult(input?.filename), provider: 'off', model: null };
  }

  const preview = input.textPreview
    ? { text: input.textPreview, source: 'provided_text_preview', extractor: 'caller', error: null }
    : readTextPreview(input.filePath, config.max_chars);
  const enriched = {
    ...input,
    textPreview: preview.text || '',
    preprocess: preview
  };

  if (config.provider === 'openai_compatible') {
    const { result, diagnostics } = await analyzeWithOpenAICompatible(enriched, config);
    const extraction_evidence = deriveExtractionEvidence(enriched, diagnostics);
    return {
      result: { ...result, extraction_evidence, request_diagnostics: diagnostics || null },
      provider: 'openai_compatible',
      model: config.compatible.model
    };
  }
  if (config.provider === 'ollama') {
    const { result, diagnostics } = await analyzeWithOllamaChat(enriched, config);
    const extraction_evidence = deriveExtractionEvidence(enriched, diagnostics);
    return {
      result: { ...result, extraction_evidence, request_diagnostics: diagnostics || null },
      provider: 'ollama',
      model: config.ollama.model
    };
  }
  if (config.provider === 'openai') {
    const { result, diagnostics } = await analyzeWithOpenAIResponses(enriched, config);
    const extraction_evidence = deriveExtractionEvidence(enriched, diagnostics);
    return {
      result: { ...result, extraction_evidence, request_diagnostics: diagnostics || null },
      provider: 'openai',
      model: config.openai.model
    };
  }
  throw new Error(`Unsupported MagicIndex provider: ${config.provider}`);
}

function deriveExtractionEvidence(input, diagnostics = null) {
  const previewChars = Number(input?.textPreview?.length || 0);
  const usedInputFile = Boolean(diagnostics?.used_input_file);
  const usedInputImage = Boolean(diagnostics?.used_input_image);
  const fallback = Boolean(diagnostics?.used_fallback_without_file);
  let source = 'filename_only';
  if (usedInputFile && fallback) source = 'input_file_fallback_text';
  else if (usedInputFile) source = input?.mimeType === 'application/pdf' ? 'pdf_input_file' : 'file_input';
  else if (usedInputImage) source = 'image_input';
  else if (previewChars > 0) source = input?.preprocess?.source || (input?.mimeType === 'application/pdf' ? 'pdf_text_preview' : 'text_preview');
  return {
    source,
    extractor: input?.preprocess?.extractor || null,
    extraction_error: input?.preprocess?.error || null,
    text_preview_chars: previewChars,
    used_input_file: usedInputFile,
    used_input_image: usedInputImage,
    used_fallback_without_file: fallback
  };
}

module.exports = { analyzeDocument, filenameOnlyResult, readTextPreview, deriveExtractionEvidence };
