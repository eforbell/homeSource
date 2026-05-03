'use strict';

const { pool } = require('../db');
const { upsertInsight, markMissingScanInsightsStale } = require('../insights');

function includesContentUnavailableReason(reasons = []) {
  return reasons.some((reason) => /content unavailable|filename alone|no text preview|not provided\/readable|not available from filename/i.test(String(reason || '')));
}

function hasMoneyLookingKeyFact(keyFacts = []) {
  return keyFacts.some((fact) => /\$|\bUSD\b|\btotal\b|\bbalance\b|\bpremium\b|\bamount\b|\bcost\b/i.test(String(fact?.value || '')) || /\btotal|balance|premium|amount|cost|discount|invoice\b/i.test(String(fact?.label || '')));
}

function buildInsight(doc, issue, description, suggestion, scanId, extra = {}) {
  return {
    category: 'document_quality',
    severity: extra.severity || 'info',
    subject_type: 'document',
    subject_id: doc.id,
    dedupe_key: `document_quality:document:${doc.id}:${issue}`,
    title: extra.title || qualityTitle(issue, doc.title),
    body: {
      document_id: doc.id,
      document_title: doc.title,
      issue,
      description,
      suggestion,
      ...extra.body
    },
    confidence: extra.confidence ?? 0.9,
    source_document_ids: [doc.id],
    reasoning: description,
    status: 'new',
    action_url: `document.html?id=${doc.id}`,
    due_date: null,
    expires_at: null,
    scan_id: scanId
  };
}

function qualityTitle(issue, title) {
  switch (issue) {
    case 'filename_only':
      return `Review extraction quality on ${title}`;
    case 'low_text_preview':
      return `Low extracted text on ${title}`;
    case 'content_unavailable_reason':
      return `MagicIndex could not read ${title} clearly`;
    case 'missing_amount':
      return `Missing amount on ${title}`;
    case 'tax_expiry_date':
      return `Possible incorrect expiry date on ${title}`;
    default:
      return `Review quality on ${title}`;
  }
}

async function runDocumentQualityScan({ actorId = null, scanId }) {
  if (!scanId) throw new Error('scanId is required');

  const { rows: docs } = await pool.query(`
    SELECT
      d.id,
      d.title,
      d.document_type,
      d.expiry_date,
      d.metadata,
      COALESCE((
        SELECT MAX(df.file_size_bytes)
        FROM document_files df
        WHERE df.document_id = d.id
          AND df.file_type = 'original'
      ), 0) AS file_size_bytes,
      COALESCE((
        SELECT MAX(df.mime_type)
        FROM document_files df
        WHERE df.document_id = d.id
          AND df.file_type = 'original'
      ), '') AS original_mime_type
    FROM documents d
    WHERE d.status = 'active'
      AND (d.metadata ? 'magicindex')
  `);

  const touched = [];
  let createdOrUpdated = 0;

  for (const doc of docs) {
    const magicindex = doc.metadata?.magicindex || {};
    const suggestions = magicindex.suggestions || {};
    const evidence = suggestions.extraction_evidence || magicindex.extraction_evidence || {};
    const reasons = suggestions.needs_review_reasons || [];
    const keyFacts = suggestions.key_facts || [];
    const amount = suggestions.amount || null;
    const textPreviewChars = Number(evidence.text_preview_chars || 0);

    const candidates = [];

    if (evidence.source === 'filename_only') {
      candidates.push(buildInsight(
        doc,
        'filename_only',
        'MagicIndex relied only on the filename because document content could not be extracted.',
        'Consider rerunning with richer text extraction or OCR.',
        scanId,
        { body: { evidence_source: evidence.source, extraction_chars: textPreviewChars } }
      ));
    }

    if (String(doc.original_mime_type) === 'application/pdf' && Number(doc.file_size_bytes || 0) > 100_000 && textPreviewChars > 0 && textPreviewChars < 500) {
      candidates.push(buildInsight(
        doc,
        'low_text_preview',
        `Only ${textPreviewChars} characters were extracted from a ${Math.round(Number(doc.file_size_bytes || 0) / 1024)}KB PDF.`,
        'Consider deeper OCR or extended page analysis.',
        scanId,
        { body: { extraction_chars: textPreviewChars, file_size_bytes: Number(doc.file_size_bytes || 0), evidence_source: evidence.source } }
      ));
    }

    if (includesContentUnavailableReason(reasons)) {
      candidates.push(buildInsight(
        doc,
        'content_unavailable_reason',
        'MagicIndex flagged that the content was unavailable or unreadable during extraction.',
        'Review the document and consider rerunning analysis after improving text extraction.',
        scanId,
        { body: { reasons, evidence_source: evidence.source } }
      ));
    }

    if (doc.document_type === 'tax' && doc.expiry_date) {
      candidates.push(buildInsight(
        doc,
        'tax_expiry_date',
        'Tax documents should usually not carry actionable expiry dates.',
        'Clear or review the expiry date if it reflects historical filing metadata instead of a renewal deadline.',
        scanId,
        { body: { expiry_date: doc.expiry_date }, title: `Possible incorrect expiry date on ${doc.title}` }
      ));
    }

    if (doc.document_type === 'receipt' && !amount?.value && hasMoneyLookingKeyFact(keyFacts)) {
      candidates.push(buildInsight(
        doc,
        'missing_amount',
        'The document includes money-like key facts but no normalized amount was captured.',
        'Review the amount extraction or rerun with richer text.',
        scanId,
        { body: { key_facts: keyFacts.slice(0, 5) }, severity: 'warning' }
      ));
    }

    for (const insight of candidates) {
      const row = await upsertInsight(insight);
      touched.push(row.id);
      createdOrUpdated++;
    }
  }

  const staleCount = await markMissingScanInsightsStale(scanId, ['document_quality'], actorId);
  return { scan_id: scanId, created_or_updated: createdOrUpdated, stale_count: staleCount, touched_ids: touched };
}

module.exports = {
  runDocumentQualityScan,
  includesContentUnavailableReason,
  hasMoneyLookingKeyFact
};
