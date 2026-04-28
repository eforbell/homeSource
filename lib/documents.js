'use strict';

const { pool, withTransaction } = require('./db');

async function listDocuments(filters = {}) {
  const conditions = ['d.status = $1'];
  const params = [filters.status || 'active'];
  let idx = 2;

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
  if (filters.search) {
    conditions.push(`d.search_vector @@ plainto_tsquery('english', $${idx++})`);
    params.push(filters.search);
  }
  if (filters.from_date) {
    conditions.push(`d.created_at >= $${idx++}`);
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`d.created_at <= $${idx++}`);
    params.push(filters.to_date);
  }

  const where = conditions.join(' AND ');
  const limit = Math.min(Number(filters.limit) || 50, 200);
  const offset = Number(filters.offset) || 0;

  const { rows } = await pool.query(`
    SELECT d.*,
      COALESCE(
        (SELECT json_agg(json_build_object('id', do2.member_id, 'name', m.name, 'avatar_emoji', m.avatar_emoji, 'ownership_type', do2.ownership_type))
         FROM document_owners do2 JOIN family_members m ON do2.member_id = m.id
         WHERE do2.document_id = d.id), '[]'
      ) AS owners,
      COALESCE(
        (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
         FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
         WHERE dt.document_id = d.id), '[]'
      ) AS tags,
      (SELECT json_build_object('stored_filename', df.stored_filename, 'mime_type', df.mime_type)
       FROM document_files df WHERE df.document_id = d.id AND df.file_type = 'thumbnail' LIMIT 1
      ) AS thumbnail
    FROM documents d
    WHERE ${where}
    ORDER BY d.created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, limit, offset]);

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM documents d WHERE ${where}`, params
  );

  return { documents: rows, total: countRows[0].total };
}

async function getDocument(id) {
  const { rows } = await pool.query(`
    SELECT d.*,
      COALESCE(
        (SELECT json_agg(json_build_object('id', do2.member_id, 'name', m.name, 'avatar_emoji', m.avatar_emoji, 'ownership_type', do2.ownership_type) ORDER BY do2.ownership_type)
         FROM document_owners do2 JOIN family_members m ON do2.member_id = m.id
         WHERE do2.document_id = d.id), '[]'
      ) AS owners,
      COALESCE(
        (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
         FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
         WHERE dt.document_id = d.id), '[]'
      ) AS tags,
      COALESCE(
        (SELECT json_agg(json_build_object('id', df.id, 'file_type', df.file_type, 'stored_filename', df.stored_filename, 'original_filename', df.original_filename, 'mime_type', df.mime_type, 'file_size_bytes', df.file_size_bytes, 'sha256', df.sha256, 'page_count', df.page_count, 'version', df.version, 'created_at', df.created_at) ORDER BY df.version DESC, df.created_at DESC)
         FROM document_files df WHERE df.document_id = d.id), '[]'
      ) AS files
    FROM documents d
    WHERE d.id = $1
  `, [id]);
  return rows[0] || null;
}

async function createDocument(data, ownerIds = []) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO documents (title, description, document_type, source_type, source_url, issued_date, expiry_date, metadata, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      data.title, data.description || null, data.document_type, data.source_type,
      data.source_url || null, data.issued_date || null, data.expiry_date || null,
      JSON.stringify(data.metadata || {}), data.created_by || null
    ]);
    const doc = rows[0];

    for (const ownerId of ownerIds) {
      await client.query(
        'INSERT INTO document_owners (document_id, member_id, ownership_type) VALUES ($1, $2, $3)',
        [doc.id, ownerId.id || ownerId, ownerId.type || 'owner']
      );
    }

    return doc;
  });
}

async function updateDocument(id, data) {
  const fields = [];
  const params = [];
  let idx = 1;

  for (const key of ['title', 'description', 'document_type', 'issued_date', 'expiry_date', 'status']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      params.push(data[key]);
    }
  }
  if (data.metadata !== undefined) {
    fields.push(`metadata = $${idx++}`);
    params.push(JSON.stringify(data.metadata));
  }

  if (!fields.length) return null;

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE documents SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function archiveDocument(id) {
  const { rows } = await pool.query(
    "UPDATE documents SET status = 'archived' WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0] || null;
}

async function permanentDeleteDocument(id) {
  const { getFilePath } = require('./files');
  const fs = require('fs');

  const { rows: files } = await pool.query(
    'SELECT stored_filename FROM document_files WHERE document_id = $1', [id]
  );

  for (const f of files) {
    try { fs.unlinkSync(getFilePath(f.stored_filename)); } catch {}
  }

  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  return true;
}

async function addOwner(documentId, memberId, ownershipType = 'owner') {
  const { rows } = await pool.query(
    'INSERT INTO document_owners (document_id, member_id, ownership_type) VALUES ($1, $2, $3) ON CONFLICT (document_id, member_id) DO UPDATE SET ownership_type = $3 RETURNING *',
    [documentId, memberId, ownershipType]
  );
  return rows[0];
}

async function removeOwner(documentId, memberId) {
  const { rowCount } = await pool.query(
    'DELETE FROM document_owners WHERE document_id = $1 AND member_id = $2',
    [documentId, memberId]
  );
  return rowCount > 0;
}

async function listMembers() {
  const { rows } = await pool.query(
    'SELECT id, name, role, avatar_emoji, color, passphrase_hash IS NOT NULL AS has_passphrase, created_at FROM family_members ORDER BY role, name'
  );
  return rows;
}

async function getMember(id) {
  const { rows } = await pool.query(
    'SELECT id, name, role, avatar_emoji, color, passphrase_hash IS NOT NULL AS has_passphrase, created_at FROM family_members WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function memberCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM family_members');
  return rows[0].count;
}

module.exports = {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  archiveDocument,
  permanentDeleteDocument,
  addOwner,
  removeOwner,
  listMembers,
  getMember,
  memberCount
};
