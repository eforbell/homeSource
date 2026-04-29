'use strict';

const { pool } = require('./db');

async function fullTextSearch(query, filters = {}) {
  const hasQuery = query && query.trim();
  const conditions = ["d.status = 'active'"];
  const params = [];
  let idx = 1;

  if (hasQuery) {
    conditions.push(`d.search_vector @@ plainto_tsquery('english', $${idx++})`);
    params.push(query.trim());
  }
  if (filters.document_type) {
    conditions.push(`d.document_type = $${idx++}`);
    params.push(filters.document_type);
  }
  if (filters.owner_id) {
    conditions.push(`EXISTS (SELECT 1 FROM document_owners do2 WHERE do2.document_id = d.id AND do2.member_id = $${idx++})`);
    params.push(Number(filters.owner_id));
  }
  if (filters.tag_id) {
    conditions.push(`EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.tag_id = $${idx++})`);
    params.push(Number(filters.tag_id));
  }
  if (filters.from_date) {
    conditions.push(`d.created_at >= $${idx++}`);
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`d.created_at <= $${idx++}`);
    params.push(filters.to_date);
  }

  if (conditions.length === 1 && !hasQuery) {
    return { results: [], total: 0 };
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(Number(filters.limit) || 50, 200);
  const offset = Number(filters.offset) || 0;

  const rankExpr = hasQuery
    ? `ts_rank(d.search_vector, plainto_tsquery('english', $1))`
    : '1';
  const headlineExpr = hasQuery
    ? `ts_headline('english', COALESCE(d.title, '') || ' ' || COALESCE(d.description, ''), plainto_tsquery('english', $1),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=10')`
    : `COALESCE(LEFT(d.description, 120), d.title)`;

  const { rows } = await pool.query(`
    SELECT d.id, d.title, d.description, d.document_type, d.issued_date, d.expiry_date, d.created_at,
      ${rankExpr} AS rank,
      ${headlineExpr} AS headline,
      COALESCE(
        (SELECT json_agg(json_build_object('id', do2.member_id, 'name', m.name, 'avatar_emoji', m.avatar_emoji))
         FROM document_owners do2 JOIN family_members m ON do2.member_id = m.id
         WHERE do2.document_id = d.id), '[]'
      ) AS owners,
      COALESCE(
        (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
         FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
         WHERE dt.document_id = d.id), '[]'
      ) AS tags
    FROM documents d
    WHERE ${where}
    ORDER BY rank DESC, d.created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, limit, offset]);

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM documents d WHERE ${where}`, params
  );

  return { results: rows, total: countRows[0].total, query };
}

module.exports = { fullTextSearch };
