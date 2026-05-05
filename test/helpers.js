'use strict';

const { Pool } = require('pg');
const app = require('../server');

let server;
let baseUrl;
let pool;

async function startServer() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  server = app.listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stopServer() {
  if (server) server.close();
  if (pool) await pool.end();
  const dbPool = require('../lib/db').pool;
  await dbPool.end().catch(() => {});
}

function getPool() {
  return pool;
}

function url(path) {
  return `${baseUrl}/${path}`;
}

async function resetDatabase() {
  const tables = [
    'magic_links',
    'magic_data',
    'processing_jobs', 'import_items', 'import_batches',
    'audit_log', 'backup_log', 'key_holders', 'encryption_keys',
    'share_links', 'document_tags', 'tags', 'document_owners',
    'document_files', 'documents', 'sessions', 'app_config', 'family_members'
  ];
  for (const table of tables) {
    await pool.query(`DELETE FROM ${table}`);
  }
}

async function createMember(name, role, passphrase = null) {
  const { hashPassphrase } = require('../lib/auth');
  const hash = passphrase ? hashPassphrase(passphrase) : null;
  const avatars = role === 'parent' ? ['👨', '👩'] : ['👦', '👧'];
  const { rows } = await pool.query(
    'INSERT INTO family_members (name, role, avatar_emoji, passphrase_hash) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, role, avatars[0], hash]
  );
  return rows[0];
}

async function loginAs(member, passphrase) {
  const res = await fetch(url('api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: member.name, passphrase })
  });
  const cookies = res.headers.get('set-cookie') || '';
  const match = cookies.match(/hs_session=([^;]+)/);
  return match ? `hs_session=${match[1]}` : null;
}

async function authedFetch(path, cookie, options = {}) {
  const headers = { ...(options.headers || {}), Cookie: cookie };
  return fetch(url(path), { ...options, headers });
}

async function authedGet(path, cookie) {
  return authedFetch(path, cookie);
}

async function authedPost(path, cookie, body) {
  return authedFetch(path, cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function authedPut(path, cookie, body) {
  return authedFetch(path, cookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function authedDel(path, cookie) {
  return authedFetch(path, cookie, { method: 'DELETE' });
}

async function createTestDocument(memberId, overrides = {}) {
  const { createDocument } = require('../lib/documents');
  return createDocument({
    title: overrides.title || 'Test Document',
    document_type: overrides.document_type || 'other',
    source_type: overrides.source_type || 'upload',
    description: overrides.description || 'Test description',
    created_by: memberId,
    ...overrides
  }, overrides.owner_ids || [memberId]);
}

async function createTestTag(name, color) {
  const { createTag } = require('../lib/tags');
  return createTag(name || 'test-tag', color || '#d97706');
}

module.exports = {
  startServer,
  stopServer,
  getPool,
  url,
  resetDatabase,
  createMember,
  loginAs,
  authedFetch,
  authedGet,
  authedPost,
  authedPut,
  authedDel,
  createTestDocument,
  createTestTag
};
