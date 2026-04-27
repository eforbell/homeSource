'use strict';

const { pool } = require('./db');

async function listTags() {
  const { rows } = await pool.query(
    'SELECT t.*, (SELECT COUNT(*)::int FROM document_tags dt WHERE dt.tag_id = t.id) AS document_count FROM tags t ORDER BY t.name'
  );
  return rows;
}

async function createTag(name, color) {
  const { rows } = await pool.query(
    'INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING *',
    [name.trim(), color || '#6b7280']
  );
  return rows[0];
}

async function updateTag(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;

  if (data.name !== undefined) { fields.push(`name = $${idx++}`); params.push(data.name.trim()); }
  if (data.color !== undefined) { fields.push(`color = $${idx++}`); params.push(data.color); }
  if (!fields.length) return null;

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE tags SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params
  );
  return rows[0] || null;
}

async function deleteTag(id) {
  const { rowCount } = await pool.query('DELETE FROM tags WHERE id = $1', [id]);
  return rowCount > 0;
}

async function setDocumentTags(documentId, tagIds) {
  await pool.query('DELETE FROM document_tags WHERE document_id = $1', [documentId]);
  for (const tagId of tagIds) {
    await pool.query(
      'INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [documentId, tagId]
    );
  }
}

module.exports = { listTags, createTag, updateTag, deleteTag, setDocumentTags };
