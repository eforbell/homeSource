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
      auto_apply_threshold: threshold,
      fields: {}
    }
  };

  const shouldApply = force || Number(result.confidence || 0) >= Number(threshold || 0);
  if (shouldApply) {
    if (result.title) { data.title = result.title; autoApplied.title = result.title; metadataPatch.magicindex.fields.title = 'auto_applied'; }
    if (result.document_type) { data.document_type = result.document_type; autoApplied.document_type = result.document_type; metadataPatch.magicindex.fields.document_type = 'auto_applied'; }
    if (result.summary) { data.description = result.summary; autoApplied.description = result.summary; metadataPatch.magicindex.fields.description = 'auto_applied'; }
    if (result.issued_date) { data.issued_date = result.issued_date; autoApplied.issued_date = result.issued_date; metadataPatch.magicindex.fields.issued_date = 'auto_applied'; }
    if (result.expiry_date) { data.expiry_date = result.expiry_date; autoApplied.expiry_date = result.expiry_date; metadataPatch.magicindex.fields.expiry_date = 'auto_applied'; }
  }

  metadataPatch.magicindex.suggestions = result;
  data.metadata = await mergedMetadata(documentId, metadataPatch);
  await updateDocument(documentId, data);

  const tagIds = await autoApplyTags(result.suggested_tags || [], shouldApply ? 0 : Number(threshold || 0));
  if (tagIds.length) {
    await setDocumentTags(documentId, tagIds);
    autoApplied.tags = tagIds;
  }

  await autoApplyOwners(documentId, result.suggested_owners || [], shouldApply ? 0 : Number(threshold || 0));
  return autoApplied;
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

