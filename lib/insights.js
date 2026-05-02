'use strict';

const { pool } = require('./db');

const ALLOWED_UPDATE_FIELDS = new Set([
  'title',
  'body',
  'reasoning',
  'status',
  'severity',
  'due_date',
  'expires_at',
  'action_url'
]);

const ALLOWED_STATUSES = new Set(['new', 'accepted', 'dismissed', 'stale', 'resolved']);
const ALLOWED_SEVERITIES = new Set(['critical', 'warning', 'info']);
const ALLOWED_CATEGORIES = new Set(['expiry_alert', 'renewal_reminder', 'document_quality', 'household_insight']);

function createScanId(prefix = 'manual') {
  return `${prefix}:${Date.now()}`;
}

function normalizeStatus(status) {
  if (!status) return undefined;
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`Invalid insight status: ${status}`);
  return status;
}

function normalizeSeverity(severity) {
  if (!severity) return undefined;
  if (!ALLOWED_SEVERITIES.has(severity)) throw new Error(`Invalid insight severity: ${severity}`);
  return severity;
}

function normalizeCategory(category) {
  if (!category) return undefined;
  if (!ALLOWED_CATEGORIES.has(category)) throw new Error(`Invalid insight category: ${category}`);
  return category;
}

async function listInsights(filters = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  const status = normalizeStatus(filters.status);
  const severity = normalizeSeverity(filters.severity);
  const category = normalizeCategory(filters.category);

  if (status) {
    conditions.push(`md.status = $${idx++}`);
    params.push(status);
  } else if (!filters.include_all_statuses) {
    conditions.push(`md.status = ANY($${idx++}::text[])`);
    params.push(['new', 'accepted']);
  }

  if (severity) {
    conditions.push(`md.severity = $${idx++}`);
    params.push(severity);
  }
  if (category) {
    conditions.push(`md.category = $${idx++}`);
    params.push(category);
  }
  if (filters.subject_type) {
    conditions.push(`md.subject_type = $${idx++}`);
    params.push(filters.subject_type);
  }
  if (filters.subject_id) {
    conditions.push(`md.subject_id = $${idx++}`);
    params.push(Number(filters.subject_id));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(filters.limit) || 100, 500);

  const { rows } = await pool.query(`
    SELECT md.*,
      reviewer.name AS reviewed_by_name,
      COALESCE((
        SELECT json_agg(
          json_build_object(
            'id', d.id,
            'title', d.title,
            'document_type', d.document_type,
            'status', d.status
          )
          ORDER BY array_position(md.source_document_ids, d.id)
        )
        FROM documents d
        WHERE d.id = ANY(md.source_document_ids)
      ), '[]'::json) AS source_documents
    FROM magic_data md
    LEFT JOIN family_members reviewer ON reviewer.id = md.reviewed_by
    ${where}
    ORDER BY
      CASE md.status
        WHEN 'new' THEN 0
        WHEN 'accepted' THEN 1
        WHEN 'resolved' THEN 2
        WHEN 'dismissed' THEN 3
        ELSE 4
      END,
      CASE md.severity
        WHEN 'critical' THEN 0
        WHEN 'warning' THEN 1
        ELSE 2
      END,
      md.due_date ASC NULLS LAST,
      md.created_at DESC
    LIMIT $${idx}
  `, [...params, limit]);

  return rows;
}

async function getInsight(id) {
  const { rows: directRows } = await pool.query(`
    SELECT md.*,
      reviewer.name AS reviewed_by_name,
      COALESCE((
        SELECT json_agg(
          json_build_object(
            'id', d.id,
            'title', d.title,
            'document_type', d.document_type,
            'status', d.status
          )
          ORDER BY array_position(md.source_document_ids, d.id)
        )
        FROM documents d
        WHERE d.id = ANY(md.source_document_ids)
      ), '[]'::json) AS source_documents
    FROM magic_data md
    LEFT JOIN family_members reviewer ON reviewer.id = md.reviewed_by
    WHERE md.id = $1
  `, [Number(id)]);

  return directRows[0] || null;
}

async function upsertInsight(data) {
  const normalizedCategory = normalizeCategory(data.category);
  const normalizedSeverity = normalizeSeverity(data.severity || 'info') || 'info';
  const normalizedStatus = normalizeStatus(data.status || 'new') || 'new';
  const sourceDocumentIds = Array.isArray(data.source_document_ids)
    ? [...new Set(data.source_document_ids.map(Number).filter(Boolean))]
    : [];

  const { rows } = await pool.query(`
    INSERT INTO magic_data (
      category, severity, subject_type, subject_id, dedupe_key, title, body,
      confidence, source_document_ids, reasoning, status, action_url,
      due_date, expires_at, scan_id, reviewed_by, reviewed_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb,
      $8, $9::int[], $10, $11, $12,
      $13, $14, $15, $16, $17
    )
    ON CONFLICT (category, dedupe_key)
    DO UPDATE SET
      severity = EXCLUDED.severity,
      subject_type = EXCLUDED.subject_type,
      subject_id = EXCLUDED.subject_id,
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      confidence = EXCLUDED.confidence,
      source_document_ids = EXCLUDED.source_document_ids,
      reasoning = EXCLUDED.reasoning,
      action_url = EXCLUDED.action_url,
      due_date = EXCLUDED.due_date,
      expires_at = EXCLUDED.expires_at,
      scan_id = EXCLUDED.scan_id,
      status = CASE
        WHEN magic_data.status = 'stale' THEN 'new'
        ELSE magic_data.status
      END
    RETURNING *
  `, [
    normalizedCategory,
    normalizedSeverity,
    data.subject_type,
    data.subject_id || null,
    data.dedupe_key,
    data.title,
    JSON.stringify(data.body || {}),
    data.confidence ?? null,
    sourceDocumentIds,
    data.reasoning || null,
    normalizedStatus,
    data.action_url || null,
    data.due_date || null,
    data.expires_at || null,
    data.scan_id || null,
    data.reviewed_by || null,
    data.reviewed_at || null
  ]);

  return rows[0];
}

async function updateInsight(id, data, actorId = null) {
  const fields = [];
  const params = [];
  let idx = 1;

  for (const [key, value] of Object.entries(data || {})) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    if (key === 'status') {
      normalizeStatus(value);
    }
    if (key === 'severity') {
      normalizeSeverity(value);
    }
    if (key === 'body') {
      fields.push(`body = $${idx++}::jsonb`);
      params.push(JSON.stringify(value || {}));
      continue;
    }
    fields.push(`${key} = $${idx++}`);
    params.push(value);
  }

  if (data && Object.prototype.hasOwnProperty.call(data, 'status')) {
    fields.push(`reviewed_by = $${idx++}`);
    params.push(actorId);
    fields.push(`reviewed_at = NOW()`);
  }

  if (!fields.length) return getInsight(id);

  params.push(Number(id));
  const { rows } = await pool.query(
    `UPDATE magic_data SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function deleteInsight(id) {
  const { rowCount } = await pool.query('DELETE FROM magic_data WHERE id = $1', [Number(id)]);
  return rowCount > 0;
}

async function markMissingScanInsightsStale(scanId, categories, actorId = null) {
  if (!scanId || !Array.isArray(categories) || !categories.length) return 0;
  const { rowCount } = await pool.query(`
    UPDATE magic_data
    SET status = 'stale',
        reviewed_by = COALESCE(reviewed_by, $2),
        reviewed_at = COALESCE(reviewed_at, NOW())
    WHERE category = ANY($1::text[])
      AND status IN ('new', 'accepted')
      AND (scan_id IS NULL OR scan_id <> $3)
  `, [categories, actorId, scanId]);
  return rowCount;
}

async function getInsightSummary() {
  const { rows: countRows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'new' AND severity IN ('critical', 'warning'))::int AS action_required_count,
      COUNT(*) FILTER (WHERE status = 'new' AND severity = 'critical')::int AS new_critical_count,
      COUNT(*) FILTER (WHERE status = 'new' AND severity = 'warning')::int AS new_warning_count,
      COUNT(*) FILTER (WHERE status = 'new' AND severity = 'info')::int AS new_info_count,
      COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted_count,
      COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed_count,
      COUNT(*) FILTER (WHERE status = 'stale')::int AS stale_count
    FROM magic_data
  `);

  const { rows: dueRows } = await pool.query(`
    SELECT id, category, severity, status, title, due_date, action_url
    FROM magic_data
    WHERE status = 'new'
      AND severity IN ('critical', 'warning')
      AND due_date IS NOT NULL
    ORDER BY due_date ASC, created_at DESC
    LIMIT 3
  `);

  const { rows: categoryRows } = await pool.query(`
    SELECT category, COUNT(*)::int AS count
    FROM magic_data
    WHERE status IN ('new', 'accepted')
    GROUP BY category
    ORDER BY count DESC, category ASC
  `);

  return {
    ...countRows[0],
    by_category: categoryRows,
    top_due: dueRows
  };
}

module.exports = {
  ALLOWED_CATEGORIES,
  ALLOWED_SEVERITIES,
  ALLOWED_STATUSES,
  createScanId,
  listInsights,
  getInsight,
  upsertInsight,
  updateInsight,
  deleteInsight,
  markMissingScanInsightsStale,
  getInsightSummary
};
