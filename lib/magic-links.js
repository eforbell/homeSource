'use strict';

const { pool } = require('./db');

const DIRECTIONAL_LINK_TYPES = new Set(['supersedes', 'renews', 'supplements']);
const SYMMETRIC_LINK_TYPES = new Set(['relates_to', 'same_asset', 'same_provider', 'same_account']);
const LINK_TYPES = new Set([...DIRECTIONAL_LINK_TYPES, ...SYMMETRIC_LINK_TYPES]);
const LINK_STATUSES = new Set(['suggested', 'accepted', 'dismissed']);

function normalizeDocumentId(documentId) {
  const id = Number(documentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Document id must be a positive integer');
  return id;
}

function normalizeLinkType(type) {
  const value = String(type || '').trim();
  if (!LINK_TYPES.has(value)) throw new Error(`Invalid link type: ${type}`);
  return value;
}

function normalizeStatus(status) {
  const value = String(status || '').trim();
  if (!LINK_STATUSES.has(value)) throw new Error(`Invalid link status: ${status}`);
  return value;
}

function normalizeLimit(limit, fallback = 50, max = 200) {
  if (limit === undefined || limit === null || limit === '') return fallback;
  const value = Number(limit);
  if (!Number.isInteger(value) || value <= 0) throw new Error('Limit must be a positive integer');
  return Math.min(value, max);
}

function canonicalizePair(sourceDocumentId, targetDocumentId, linkType) {
  const type = normalizeLinkType(linkType);
  const sourceId = normalizeDocumentId(sourceDocumentId);
  const targetId = normalizeDocumentId(targetDocumentId);
  if (sourceId === targetId) throw new Error('Cannot link document to itself');
  if (SYMMETRIC_LINK_TYPES.has(type) && sourceId > targetId) {
    return { sourceDocumentId: targetId, targetDocumentId: sourceId, linkType: type };
  }
  return { sourceDocumentId: sourceId, targetDocumentId: targetId, linkType: type };
}

async function listLinksForDocument(documentId) {
  const id = normalizeDocumentId(documentId);
  const { rows } = await pool.query(`
    SELECT ml.*,
      CASE
        WHEN ml.source_document_id = $1 THEN 'outgoing'
        ELSE 'incoming'
      END AS direction,
      CASE
        WHEN ml.source_document_id = $1 THEN ml.target_document_id
        ELSE ml.source_document_id
      END AS related_document_id,
      d.title AS related_document_title,
      d.document_type AS related_document_type,
      d.status AS related_document_status,
      CASE
        WHEN ml.status = 'accepted' AND ml.link_type IN ('supersedes', 'renews') AND ml.source_document_id = $1 THEN ml.target_document_id
        WHEN ml.status = 'accepted' AND ml.link_type IN ('supersedes', 'renews') AND ml.target_document_id = $1 THEN $1
        ELSE NULL
      END AS archive_candidate_document_id,
      CASE
        WHEN ml.status = 'accepted' AND ml.link_type IN ('supersedes', 'renews') AND ml.source_document_id = $1 THEN d.title
        WHEN ml.status = 'accepted' AND ml.link_type IN ('supersedes', 'renews') AND ml.target_document_id = $1 THEN current_doc.title
        ELSE NULL
      END AS archive_candidate_document_title,
      reviewer.name AS reviewed_by_name
    FROM magic_links ml
    JOIN documents current_doc ON current_doc.id = $1
    JOIN documents d
      ON d.id = CASE
        WHEN ml.source_document_id = $1 THEN ml.target_document_id
        ELSE ml.source_document_id
      END
    LEFT JOIN family_members reviewer ON reviewer.id = ml.reviewed_by
    WHERE ml.source_document_id = $1 OR ml.target_document_id = $1
    ORDER BY
      CASE ml.status
        WHEN 'suggested' THEN 0
        WHEN 'accepted' THEN 1
        ELSE 2
      END,
      ml.confidence DESC,
      ml.created_at DESC
  `, [id]);
  return rows;
}

async function listLinks(filters = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (filters.status) {
    conditions.push(`ml.status = $${idx++}`);
    params.push(normalizeStatus(filters.status));
  }
  if (filters.link_type) {
    conditions.push(`ml.link_type = $${idx++}`);
    params.push(normalizeLinkType(filters.link_type));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = normalizeLimit(filters.limit);
  const { rows } = await pool.query(`
    SELECT ml.*,
      s.title AS source_document_title,
      t.title AS target_document_title,
      reviewer.name AS reviewed_by_name
    FROM magic_links ml
    JOIN documents s ON s.id = ml.source_document_id
    JOIN documents t ON t.id = ml.target_document_id
    LEFT JOIN family_members reviewer ON reviewer.id = ml.reviewed_by
    ${where}
    ORDER BY
      CASE ml.status
        WHEN 'suggested' THEN 0
        WHEN 'accepted' THEN 1
        ELSE 2
      END,
      ml.confidence DESC,
      ml.created_at DESC
    LIMIT $${idx}
  `, [...params, limit]);
  return rows;
}

async function createManualLink({ sourceDocumentId, targetDocumentId, linkType, reasoning, actorId }) {
  const pair = canonicalizePair(sourceDocumentId, targetDocumentId, linkType);
  const { rows } = await pool.query(`
    INSERT INTO magic_links (
      source_document_id, target_document_id, link_type, reasoning,
      confidence, created_by, status, reviewed_by, reviewed_at
    )
    VALUES ($1, $2, $3, $4, 1.000, 'user', 'accepted', $5, NOW())
    ON CONFLICT (source_document_id, target_document_id, link_type)
    DO UPDATE SET
      reasoning = EXCLUDED.reasoning,
      created_by = 'user',
      status = 'accepted',
      confidence = 1.000,
      reviewed_by = EXCLUDED.reviewed_by,
      reviewed_at = EXCLUDED.reviewed_at
    RETURNING *
  `, [pair.sourceDocumentId, pair.targetDocumentId, pair.linkType, String(reasoning || '').trim(), actorId]);
  return rows[0];
}

async function upsertSuggestedLink({ sourceDocumentId, targetDocumentId, linkType, reasoning, confidence }) {
  const pair = canonicalizePair(sourceDocumentId, targetDocumentId, linkType);
  const { rows } = await pool.query(`
    INSERT INTO magic_links (
      source_document_id, target_document_id, link_type, reasoning,
      confidence, created_by, status
    )
    VALUES ($1, $2, $3, $4, $5, 'agent', 'suggested')
    ON CONFLICT (source_document_id, target_document_id, link_type)
    DO UPDATE SET
      reasoning = EXCLUDED.reasoning,
      confidence = EXCLUDED.confidence,
      status = CASE
        WHEN magic_links.created_by = 'user' THEN magic_links.status
        WHEN magic_links.status IN ('accepted', 'dismissed') THEN magic_links.status
        ELSE 'suggested'
      END
    RETURNING *
  `, [pair.sourceDocumentId, pair.targetDocumentId, pair.linkType, String(reasoning || '').trim(), Math.max(0, Math.min(1, Number(confidence) || 0))]);
  return rows[0];
}

async function updateLink(id, data, actorId) {
  const fields = [];
  const params = [];
  let idx = 1;
  if (data.reasoning !== undefined) {
    fields.push(`reasoning = $${idx++}`);
    params.push(String(data.reasoning || '').trim());
  }
  if (data.link_type !== undefined) {
    fields.push(`link_type = $${idx++}`);
    params.push(normalizeLinkType(data.link_type));
  }
  if (data.status !== undefined) {
    fields.push(`status = $${idx++}`);
    params.push(normalizeStatus(data.status));
    fields.push(`reviewed_by = $${idx++}`);
    params.push(actorId);
    fields.push(`reviewed_at = NOW()`);
  }
  if (data.confidence !== undefined) {
    fields.push(`confidence = $${idx++}`);
    params.push(Math.max(0, Math.min(1, Number(data.confidence) || 0)));
  }
  if (!fields.length) return getLink(id);
  params.push(Number(id));
  const { rows } = await pool.query(`UPDATE magic_links SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
  return rows[0] || null;
}

async function getLink(id) {
  const { rows } = await pool.query('SELECT * FROM magic_links WHERE id = $1', [Number(id)]);
  return rows[0] || null;
}

async function deleteLink(id) {
  const { rowCount } = await pool.query('DELETE FROM magic_links WHERE id = $1', [Number(id)]);
  return rowCount > 0;
}

module.exports = {
  DIRECTIONAL_LINK_TYPES,
  SYMMETRIC_LINK_TYPES,
  LINK_TYPES,
  LINK_STATUSES,
  canonicalizePair,
  listLinks,
  listLinksForDocument,
  createManualLink,
  upsertSuggestedLink,
  updateLink,
  getLink,
  deleteLink
};
