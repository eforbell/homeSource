'use strict';

const { pool } = require('../db');
const { upsertInsight, markMissingScanInsightsStale } = require('../insights');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEAD_DAYS = {
  identification: 56,
  insurance: 30,
  warranty: 14,
  contract: 30,
  vehicle: 30,
  property: 30,
  default: 21
};

function toDateOnly(date) {
  if (!date) return null;
  if (date instanceof Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  if (typeof date === 'string') {
    return new Date(`${date}T00:00:00Z`);
  }
  return null;
}

function formatDateKey(date) {
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function daysUntil(date, now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((end - start) / DAY_MS);
}

function getExpiryConfidence(metadata) {
  return Number(metadata?.magicindex?.field_confidence?.expiry_date
    ?? metadata?.magicindex?.suggestions?.field_confidence?.expiry_date
    ?? metadata?.magicindex_confidence
    ?? 0);
}

function hasLowConfidenceOtherType(doc) {
  return doc.document_type === 'other' && getExpiryConfidence(doc.metadata) > 0 && getExpiryConfidence(doc.metadata) < 0.6;
}

function isHistoricalContract(doc, now = new Date()) {
  if (doc.document_type !== 'contract' || !doc.issued_date) return false;
  const issued = toDateOnly(doc.issued_date);
  return issued ? daysUntil(issued, now) < -365 : false;
}

function getLeadDays(documentType) {
  return DEFAULT_LEAD_DAYS[documentType] ?? DEFAULT_LEAD_DAYS.default;
}

function buildQualityInsight(doc, reason, title, scanId) {
  return {
    category: 'document_quality',
    severity: 'info',
    subject_type: 'document',
    subject_id: doc.id,
    dedupe_key: `document_quality:document:${doc.id}:expiry_review`,
    title,
    body: {
      document_id: doc.id,
      current_expiry_date: doc.expiry_date,
      document_type: doc.document_type,
      reason
    },
    confidence: 0.95,
    source_document_ids: [doc.id],
    reasoning: reason,
    status: 'new',
    action_url: `document.html?id=${doc.id}`,
    due_date: null,
    expires_at: null,
    scan_id: scanId
  };
}

function buildExpiryInsight(doc, severity, reason, scanId) {
  return {
    category: 'expiry_alert',
    severity,
    subject_type: 'document',
    subject_id: doc.id,
    dedupe_key: `expiry_alert:document:${doc.id}:${formatDateKey(toDateOnly(doc.expiry_date))}`,
    title: `${doc.title} expires ${severity === 'critical' ? 'very soon' : 'soon'}`,
    body: {
      document_id: doc.id,
      document_type: doc.document_type,
      expiry_date: doc.expiry_date,
      lead_days: getLeadDays(doc.document_type)
    },
    confidence: 1,
    source_document_ids: [doc.id],
    reasoning: reason,
    status: 'new',
    action_url: `document.html?id=${doc.id}`,
    due_date: doc.expiry_date,
    expires_at: null,
    scan_id: scanId
  };
}

async function runExpiryScan({ actorId = null, scanId }) {
  if (!scanId) throw new Error('scanId is required');

  const { rows: docs } = await pool.query(`
    SELECT id, title, document_type, issued_date, expiry_date, metadata
    FROM documents
    WHERE status = 'active'
      AND expiry_date IS NOT NULL
    ORDER BY expiry_date ASC, id ASC
  `);

  const now = new Date();
  const touched = [];
  let createdOrUpdated = 0;

  for (const doc of docs) {
    const expiry = toDateOnly(doc.expiry_date);
    if (!expiry) continue;

    const deltaDays = daysUntil(expiry, now);
    const leadDays = getLeadDays(doc.document_type);

    if (doc.document_type === 'tax') {
      const insight = buildQualityInsight(
        doc,
        'Tax documents often carry historical filing dates that should not trigger renewal alerts.',
        `Possible incorrect expiry date on ${doc.title}`,
        scanId
      );
      const row = await upsertInsight(insight);
      touched.push(row.id);
      createdOrUpdated++;
      continue;
    }

    if (hasLowConfidenceOtherType(doc)) {
      const insight = buildQualityInsight(
        doc,
        'Low-confidence expiry on an "other" document was ignored to avoid noisy renewal reminders.',
        `Review expiry date on ${doc.title}`,
        scanId
      );
      const row = await upsertInsight(insight);
      touched.push(row.id);
      createdOrUpdated++;
      continue;
    }

    if (isHistoricalContract(doc, now)) {
      const insight = buildQualityInsight(
        doc,
        'Older contract records often include historical dates that are no longer actionable.',
        `Review expiry date on ${doc.title}`,
        scanId
      );
      const row = await upsertInsight(insight);
      touched.push(row.id);
      createdOrUpdated++;
      continue;
    }

    if (deltaDays < -30) {
      const insight = buildQualityInsight(
        doc,
        'This expiry date is far in the past and was classified as metadata quality noise instead of an urgent alert.',
        `Possible stale expiry date on ${doc.title}`,
        scanId
      );
      const row = await upsertInsight(insight);
      touched.push(row.id);
      createdOrUpdated++;
      continue;
    }

    if (deltaDays > leadDays) continue;

    const severity = deltaDays <= 14 ? 'critical' : 'warning';
    const reason = deltaDays < 0
      ? 'This document appears to be past its expiry date and may need attention.'
      : `This document expires within ${leadDays} days and may need attention soon.`;
    const row = await upsertInsight(buildExpiryInsight(doc, severity, reason, scanId));
    touched.push(row.id);
    createdOrUpdated++;
  }

  const staleCount = await markMissingScanInsightsStale(scanId, ['expiry_alert', 'document_quality'], actorId);

  return {
    scan_id: scanId,
    created_or_updated: createdOrUpdated,
    stale_count: staleCount,
    touched_ids: touched
  };
}

module.exports = {
  DEFAULT_LEAD_DAYS,
  getLeadDays,
  runExpiryScan
};
