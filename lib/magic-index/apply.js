'use strict';

const { pool } = require('../db');
const { updateDocument } = require('../documents');
const { setDocumentTags } = require('../tags');

async function applyMagicIndexToDocument({ documentId, result, threshold = 0.85, provider = 'unknown', model = null, force = false }) {
  const autoApplied = {};
  const data = {};
  const metadataPatch = {
    magicindex: {
      state: 'complete',
      provider,
      model,
      confidence: result.confidence,
      field_confidence: result.field_confidence || {},
      extraction_evidence: result.extraction_evidence || null,
      request_diagnostics: result.request_diagnostics || null,
      auto_apply_threshold: threshold,
      fields: {}
    }
  };

  maybeApplyField({ force, threshold, source: result.title, key: 'title', outputKey: 'title', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.document_type, key: 'document_type', outputKey: 'document_type', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.summary, key: 'summary', outputKey: 'description', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.issued_date, key: 'issued_date', outputKey: 'issued_date', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });
  maybeApplyField({ force, threshold, source: result.expiry_date, key: 'expiry_date', outputKey: 'expiry_date', target: data, autoApplied, metadataFields: metadataPatch.magicindex.fields, fieldConfidence: result.field_confidence });

  metadataPatch.magicindex.suggestions = result;
  data.metadata = await mergedMetadata(documentId, metadataPatch);
  await updateDocument(documentId, data);

  const tagThreshold = force ? 0 : confidenceForField(result.field_confidence, 'suggested_tags', threshold, result.confidence);
  const tagIds = await autoApplyTags(result.suggested_tags || [], tagThreshold);
  if (tagIds.length) {
    await setDocumentTags(documentId, tagIds);
    autoApplied.tags = tagIds;
  }

  const ownerThreshold = force ? 0 : confidenceForField(result.field_confidence, 'suggested_owners', threshold, result.confidence);
  await autoApplyOwners(documentId, result.suggested_owners || [], ownerThreshold);
  return autoApplied;
}

function maybeApplyField({ force, threshold, source, key, outputKey, target, autoApplied, metadataFields, fieldConfidence }) {
  if (!source) return;
  const allow = force || confidenceForField(fieldConfidence, key, threshold) >= Number(threshold || 0);
  if (!allow) return;
  target[outputKey] = source;
  autoApplied[outputKey] = source;
  metadataFields[outputKey] = 'auto_applied';
}

function confidenceForField(fieldConfidence, key, threshold, overall = 0) {
  const n = Number(fieldConfidence?.[key]);
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  const fallback = Number.isFinite(Number(overall)) ? Number(overall) : Number(threshold || 0);
  return Math.max(0, Math.min(1, fallback));
}

async function mergedMetadata(documentId, patch) {
  const { rows } = await pool.query('SELECT metadata FROM documents WHERE id = $1', [documentId]);
  return { ...(rows[0]?.metadata || {}), ...patch };
}

async function autoApplyTags(tags, threshold) {
  const ids = [];
  for (const tag of tags) {
    if (!tag.name || Number(tag.confidence) < threshold) continue;
    const { rows } = await pool.query(`
      INSERT INTO tags (name, color) VALUES ($1, '#6b7280')
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [tag.name.trim()]);
    ids.push(rows[0].id);
  }
  return ids;
}

async function autoApplyOwners(documentId, owners, threshold) {
  for (const owner of owners) {
    if (!owner.member_name || Number(owner.confidence) < threshold) continue;
    const { rows } = await pool.query('SELECT id FROM family_members WHERE lower(name) = lower($1) LIMIT 1', [owner.member_name.trim()]);
    if (!rows[0]) continue;
    await pool.query(`
      INSERT INTO document_owners (document_id, member_id, ownership_type)
      VALUES ($1, $2, $3)
      ON CONFLICT (document_id, member_id) DO UPDATE SET ownership_type = EXCLUDED.ownership_type
    `, [documentId, rows[0].id, owner.ownership_type || 'owner']);
  }
}

module.exports = { applyMagicIndexToDocument };
