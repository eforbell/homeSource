'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool } = require('./lib/db');
const { hashPassphrase, verifyPassphrase, createSession, validateSession, destroySession, cleanExpiredSessions, authEnabled, parseCookie, requireAuth, requireParent } = require('./lib/auth');
const { listDocuments, getDocument, createDocument, updateDocument, archiveDocument, permanentDeleteDocument, addOwner, removeOwner, listMembers, getMember, memberCount } = require('./lib/documents');
const { storeFile, processImageToPdf, generateThumbnail, saveFileRecord, getFilePath, isImageMime, ensureDirs, ALLOWED_MIME, MAX_FILE_SIZE } = require('./lib/files');
const { fullTextSearch } = require('./lib/search');
const { listTags, createTag, updateTag, deleteTag, setDocumentTags, mergeTags } = require('./lib/tags');
const { createShareLink, getShareLink, validateSharePin, incrementUseCount, listShareLinks, revokeShareLink } = require('./lib/share');
const { createBackup, getBackupStatus, getBackupLog } = require('./lib/backup');
const { importFromUrl, processUpload, processMultiPageScanUpload, queueDocumentMagicIndexReanalysis, pickDocumentMagicIndexFile, normalizeUserHint } = require('./lib/import');
const importBatches = require('./lib/import-batches');
const { getMagicIndexConfig } = require('./lib/magic-index/config');
const { applyMagicIndexToDocument } = require('./lib/magic-index/apply');
const insights = require('./lib/insights');
const magicLinks = require('./lib/magic-links');
const { runExpiryScan } = require('./lib/scanners/expiry');
const { runDocumentQualityScan } = require('./lib/scanners/document-quality');
const { scanDeterministicLinks } = require('./lib/scanners/magic-links-deterministic');
const audit = require('./lib/audit');

const app = express();
const PORT = Number(process.env.PORT || '3008');

ensureDirs();

app.use((req, res, next) => {
  if (req.headers['content-type']?.startsWith('multipart/')) return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// ── Session middleware ──────────────────────────────────────────────────────

app.use(async (req, res, next) => {
  try {
    const token = parseCookie(req.headers.cookie, 'hs_session');
    if (token) {
      const session = await validateSession(token);
      if (session) {
        req.member = { id: session.id, name: session.name, role: session.role, avatar_emoji: session.avatar_emoji };
      }
    }
  } catch (err) {
    console.error('Session validation error:', err.message);
  }
  next();
});

// ── Bootstrap state ─────────────────────────────────────────────────────────

const PARENT_AVATARS = ['👨', '👩', '🧑', '👴', '👵'];
const KID_AVATARS = ['👦', '👧', '🧒', '👶'];
const PARENT_COLORS = ['#3b82f6', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316'];
const KID_COLORS = ['#f59e0b', '#22c55e', '#f97316', '#a855f7'];

async function bootstrapState() {
  const count = await memberCount();
  return {
    status: count === 0 ? 'needs_setup' : 'ready',
    app: 'home-source',
    version: '1.0.0',
    bootstrap: { needs_household: count === 0, ready: count > 0 },
    counts: { family_members: count }
  };
}

// ── Auth-gated pages ───────────────────────────────────────────���────────────

const HTML_PAGES = new Set([
  '/', '/index.html', '/documents.html', '/document.html', '/upload.html',
  '/import.html', '/search.html', '/backup.html', '/settings.html', '/insights.html'
]);
const PARENT_ONLY_PAGES = new Set(['/settings.html', '/backup.html', '/import.html', '/insights.html']);

app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  const urlPath = req.path;

  if (urlPath === '/setup' || urlPath === '/setup.html' || urlPath === '/login' || urlPath === '/login.html') return next();
  if (urlPath.startsWith('/share/') || urlPath === '/share.html') return next();
  if (!HTML_PAGES.has(urlPath)) return next();

  try {
    const state = await bootstrapState();
    if (state.bootstrap.needs_household) return res.redirect('./setup');

    const isAuthOn = await authEnabled();
    if (isAuthOn && !req.member) return res.redirect('./login');

    if (PARENT_ONLY_PAGES.has(urlPath) && req.member && req.member.role !== 'parent') {
      return res.redirect('./');
    }
  } catch (err) {
    console.error('Auth gate error:', err.message);
  }
  next();
});

// ── Static files ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ── Multipart parser ────────────────────────────────────────────────────────

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!match) return reject(new Error('No multipart boundary'));
    const boundary = match[1] || match[2];

    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_FILE_SIZE + 1024 * 100) {
        req.destroy();
        return reject(new Error(`Upload too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const parts = {};
      const separator = Buffer.from(`--${boundary}`);
      let cursor = 0;

      while (cursor < buf.length) {
        const start = buf.indexOf(separator, cursor);
        if (start === -1) break;
        const nextStart = buf.indexOf(separator, start + separator.length + 2);
        if (nextStart === -1) break;

        const partBuf = buf.slice(start + separator.length + 2, nextStart);
        const headerEnd = partBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) { cursor = nextStart; continue; }

        const headers = partBuf.slice(0, headerEnd).toString('utf8');
        const body = partBuf.slice(headerEnd + 4, partBuf.length - 2);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const typeMatch = headers.match(/Content-Type:\s*(\S+)/i);

        if (nameMatch) {
          if (filenameMatch) {
            const value = {
              filename: filenameMatch[1],
              type: typeMatch?.[1] || 'application/octet-stream',
              data: body
            };
            if (parts[nameMatch[1]] === undefined) parts[nameMatch[1]] = value;
            else if (Array.isArray(parts[nameMatch[1]])) parts[nameMatch[1]].push(value);
            else parts[nameMatch[1]] = [parts[nameMatch[1]], value];
          } else {
            const value = body.toString('utf8');
            if (parts[nameMatch[1]] === undefined) parts[nameMatch[1]] = value;
            else if (Array.isArray(parts[nameMatch[1]])) parts[nameMatch[1]].push(value);
            else parts[nameMatch[1]] = [parts[nameMatch[1]], value];
          }
        }
        cursor = nextStart;
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

// ── Health / Bootstrap ──────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: 'home-source', timestamp: new Date().toISOString() });
});

app.get('/api/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', app: 'home-source', checks: { db: 'ok' } });
  } catch (err) {
    res.status(500).json({ status: 'error', checks: { db: 'error' }, error: err.message });
  }
});

app.get('/api/bootstrap', async (_req, res) => {
  try {
    res.json(await bootstrapState());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bootstrap/household', async (req, res) => {
  try {
    const state = await bootstrapState();
    if (!state.bootstrap.needs_household) {
      return res.status(409).json({ error: 'Household already initialized' });
    }

    const { members } = req.body;
    if (!Array.isArray(members) || !members.length) {
      return res.status(400).json({ error: 'At least one member required' });
    }

    const { withTransaction } = require('./lib/db');
    const created = await withTransaction(async (client) => {
      const results = [];
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m.name?.trim()) continue;
        const role = m.role || (i === 0 ? 'parent' : 'kid');
        const avatar = m.avatar_emoji || (role === 'parent' ? PARENT_AVATARS[i % PARENT_AVATARS.length] : KID_AVATARS[i % KID_AVATARS.length]);
        const color = m.color || (role === 'parent' ? PARENT_COLORS[i % PARENT_COLORS.length] : KID_COLORS[i % KID_COLORS.length]);
        const passHash = m.passphrase ? hashPassphrase(m.passphrase) : null;

        const { rows } = await client.query(
          'INSERT INTO family_members (name, role, avatar_emoji, color, passphrase_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, role, avatar_emoji, color',
          [m.name.trim(), role, avatar, color, passHash]
        );
        results.push(rows[0]);
      }
      return results;
    });

    if (!created.length) return res.status(400).json({ error: 'No valid members provided' });

    res.status(201).json({ ok: true, created_members: created, bootstrap: (await bootstrapState()).bootstrap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auth routes ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { name, passphrase } = req.body;
    if (!name || !passphrase) return res.status(400).json({ error: 'Name and passphrase required' });

    const { rows } = await pool.query('SELECT * FROM family_members WHERE name = $1', [name]);
    const member = rows[0];
    if (!member || !member.passphrase_hash) return res.status(401).json({ error: 'Invalid credentials' });
    if (!verifyPassphrase(passphrase, member.passphrase_hash)) return res.status(401).json({ error: 'Invalid credentials' });

    const session = await createSession(member.id);
    res.setHeader('Set-Cookie', `hs_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);
    res.json({ ok: true, member: { id: member.id, name: member.name, role: member.role, avatar_emoji: member.avatar_emoji } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookie(req.headers.cookie, 'hs_session');
  await destroySession(token);
  res.setHeader('Set-Cookie', 'hs_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.member) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.member);
});

// ── Members ─────────────────────────────────────────────────────────────────

app.get('/api/members', async (_req, res) => {
  try { res.json(await listMembers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/members', requireAuth, requireParent, async (req, res) => {
  try {
    const { name, role, avatar_emoji, color, passphrase } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const passHash = passphrase ? hashPassphrase(passphrase) : null;
    const { rows } = await pool.query(
      'INSERT INTO family_members (name, role, avatar_emoji, color, passphrase_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, role, avatar_emoji, color',
      [name.trim(), role || 'kid', avatar_emoji || '👤', color || null, passHash]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/members/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const { name, role, avatar_emoji, color, passphrase } = req.body;
    const fields = [];
    const params = [];
    let idx = 1;

    if (name) { fields.push(`name = $${idx++}`); params.push(name.trim()); }
    if (role) { fields.push(`role = $${idx++}`); params.push(role); }
    if (avatar_emoji) { fields.push(`avatar_emoji = $${idx++}`); params.push(avatar_emoji); }
    if (color) { fields.push(`color = $${idx++}`); params.push(color); }
    if (passphrase) { fields.push(`passphrase_hash = $${idx++}`); params.push(hashPassphrase(passphrase)); }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE family_members SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, role, avatar_emoji, color`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Documents CRUD ──────────────────────────────────────────────────────────

app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const filters = {
      document_type: req.query.type,
      owner_id: req.query.owner,
      tag_id: req.query.tag,
      search: req.query.q,
      status: req.query.status || 'active',
      from_date: req.query.from,
      to_date: req.query.to,
      limit: req.query.limit,
      offset: req.query.offset
    };
    if (req.member.role === 'kid') {
      filters.owner_id = req.member.id;
    }
    res.json(await listDocuments(filters));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await audit.log('document.viewed', 'document', doc.id, req.member.id);
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/documents/:id/magicindex-status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, description, metadata,
         COALESCE(
           (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
            FROM document_tags dt JOIN tags t ON dt.tag_id = t.id
            WHERE dt.document_id = d.id), '[]'
         ) AS tags
       FROM documents d WHERE d.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];
    const mi = doc.metadata?.magicindex || null;
    res.json({
      state: mi?.state || null,
      title: doc.title,
      description: doc.description,
      tags: doc.tags,
      magicindex: mi
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/documents', requireAuth, async (req, res) => {
  try {
    const parts = await parseMultipart(req);
    const file = parts.file;
    if (!file || !file.data?.length) return res.status(400).json({ error: 'No file provided' });

    const metadata = parts.metadata ? JSON.parse(parts.metadata) : {};

    const doc = await processUpload(
      file.data, file.filename, file.type,
      { ...metadata, source_type: metadata.source_type || 'upload' },
      req.member.id
    );

    res.status(201).json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/documents/scan-multi', requireAuth, async (req, res) => {
  try {
    const parts = await parseMultipart(req);
    const pages = Array.isArray(parts.scan_pages) ? parts.scan_pages : (parts.scan_pages ? [parts.scan_pages] : []);
    if (!pages.length) return res.status(400).json({ error: 'No scan pages provided' });
    const metadata = parts.metadata ? JSON.parse(Array.isArray(parts.metadata) ? parts.metadata[0] : parts.metadata) : {};
    const doc = await processMultiPageScanUpload(pages.map((p) => p.data), metadata, req.member.id);
    res.status(201).json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    if (req.member.role === 'kid') return res.status(403).json({ error: 'Parent access required' });
    const doc = await updateDocument(req.params.id, req.body);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await audit.log('document.updated', 'document', doc.id, req.member.id, { fields: Object.keys(req.body) });
    res.json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/documents/:id/magicindex/reanalyze', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.metadata?.magicindex?.state === 'pending') {
      return res.status(409).json({ error: 'MagicIndex re-analysis already pending for this document' });
    }
    const file = pickDocumentMagicIndexFile(doc);
    if (!file) return res.status(400).json({ error: 'No document file available for MagicIndex re-analysis' });
    const userHint = normalizeUserHint(req.body?.user_hint || '');
    await queueDocumentMagicIndexReanalysis({
      documentId: doc.id,
      fileRecord: file,
      sourceType: doc.source_type,
      memberId: req.member.id,
      userHint
    });
    res.status(202).json({ ok: true, queued: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/documents/:id', requireAuth, requireParent, async (req, res) => {
  try {
    if (req.query.permanent === 'true') {
      const doc = await getDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      await audit.log('document.deleted', 'document', doc.id, req.member.id, { title: doc.title });
      await permanentDeleteDocument(req.params.id);
      return res.json({ ok: true, deleted: true });
    }
    const doc = await archiveDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await audit.log('document.archived', 'document', doc.id, req.member.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Document files ──────────────────────────────────────────────────────────

app.post('/api/documents/:id/files', requireAuth, async (req, res) => {
  try {
    if (req.member.role === 'kid') return res.status(403).json({ error: 'Parent access required' });
    const parts = await parseMultipart(req);
    const file = parts.file;
    if (!file || !file.data?.length) return res.status(400).json({ error: 'No file provided' });

    const stored = await storeFile(file.data, file.filename, file.type);
    const record = await saveFileRecord(req.params.id, stored);

    if (isImageMime(file.type)) {
      const processed = await processImageToPdf(file.data, file.filename);
      await saveFileRecord(req.params.id, processed);
    }

    const thumb = await generateThumbnail(stored.stored_filename, stored.mime_type);
    if (thumb) await saveFileRecord(req.params.id, thumb);

    res.status(201).json(record);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/documents/:id/files/:fileId/download', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT df.* FROM document_files df WHERE df.id = $1 AND df.document_id = $2',
      [req.params.fileId, req.params.id]
    );
    const file = rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = getFilePath(file.stored_filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    await audit.log('document.downloaded', 'document', Number(req.params.id), req.member.id, { file_id: file.id });
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${file.original_filename}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Thumbnails (public-ish, served from data dir) ───────────────────────────

app.get('/api/thumbnails/:filename', async (req, res) => {
  const filePath = getFilePath(`thumbnails/${req.params.filename}`);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

// ── Owners ──────────────────────────────────────────────────────────────────

app.post('/api/documents/:id/owners', requireAuth, requireParent, async (req, res) => {
  try {
    const { member_id, ownership_type } = req.body;
    if (!member_id) return res.status(400).json({ error: 'member_id required' });
    const owner = await addOwner(req.params.id, member_id, ownership_type || 'owner');
    res.status(201).json(owner);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/documents/:id/owners/:memberId', requireAuth, requireParent, async (req, res) => {
  try {
    const removed = await removeOwner(req.params.id, req.params.memberId);
    if (!removed) return res.status(404).json({ error: 'Owner not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tags ────────────────────────────────────────────────────────────────────

app.get('/api/tags', requireAuth, async (_req, res) => {
  try { res.json(await listTags()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tags', requireAuth, requireParent, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Tag name required' });
    res.status(201).json(await createTag(name, color));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/tags/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const tag = await updateTag(req.params.id, req.body);
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    res.json(tag);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/tags/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const deleted = await deleteTag(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Tag not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tags/:id/merge', requireAuth, requireParent, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const sourceId = Number(req.body.source_id);
    if (!sourceId || !targetId || sourceId === targetId) {
      return res.status(400).json({ error: 'Valid distinct source_id and target tag required' });
    }
    const result = await mergeTags(sourceId, targetId);
    if (!result) return res.status(404).json({ error: 'Target tag not found' });
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/documents/:id/tags', requireAuth, async (req, res) => {
  try {
    if (req.member.role === 'kid') return res.status(403).json({ error: 'Parent access required' });
    const { tag_ids } = req.body;
    if (!Array.isArray(tag_ids)) return res.status(400).json({ error: 'tag_ids array required' });
    await setDocumentTags(req.params.id, tag_ids);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Search ──────────────────────────────────────────────────────────────────

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const filters = {
      document_type: req.query.type,
      owner_id: req.member.role === 'kid' ? req.member.id : req.query.owner,
      tag_id: req.query.tag,
      from_date: req.query.from,
      to_date: req.query.to,
      limit: req.query.limit,
      offset: req.query.offset
    };
    res.json(await fullTextSearch(req.query.q, filters));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Share links ─────────────────────────────────────────────────────────────

app.post('/api/documents/:id/share', requireAuth, requireParent, async (req, res) => {
  try {
    const link = await createShareLink(req.params.id, req.member.id, req.body);
    await audit.log('share.created', 'share_link', link.id, req.member.id, { document_id: Number(req.params.id) });
    res.status(201).json(link);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/documents/:id/shares', requireAuth, async (req, res) => {
  try { res.json(await listShareLinks(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/shares/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const revoked = await revokeShareLink(req.params.id, req.member.id);
    if (!revoked) return res.status(404).json({ error: 'Share link not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/share/:token', async (req, res) => {
  try {
    const link = await getShareLink(req.params.token);
    if (!link) return res.status(404).json({ error: 'Share link not found or expired' });

    const needsPin = !!link.pin_hash;
    if (needsPin) {
      return res.json({ needs_pin: true, document_title: link.document_title, access_level: link.access_level });
    }

    await incrementUseCount(req.params.token);
    const doc = await getDocument(link.document_id);
    res.json({ document: doc, access_level: link.access_level });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/share/:token/verify', async (req, res) => {
  try {
    const { pin } = req.body;
    const valid = await validateSharePin(req.params.token, pin);
    if (!valid) return res.status(401).json({ error: 'Invalid PIN' });

    await incrementUseCount(req.params.token);
    const link = await getShareLink(req.params.token);
    if (!link) return res.status(404).json({ error: 'Share link not found or expired' });

    const doc = await getDocument(link.document_id);
    res.json({ document: doc, access_level: link.access_level });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Shared file download (no auth, by share token) ──────────────────────────

app.get('/api/share/:token/files/:fileId/download', async (req, res) => {
  try {
    const link = await getShareLink(req.params.token);
    if (!link) return res.status(404).json({ error: 'Share link not found or expired' });

    const { rows } = await pool.query(
      'SELECT * FROM document_files WHERE id = $1 AND document_id = $2',
      [req.params.fileId, link.document_id]
    );
    const file = rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = getFilePath(file.stored_filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Type', file.mime_type);
    if (link.access_level === 'download') {
      res.setHeader('Content-Disposition', `attachment; filename="${file.original_filename}"`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }
    fs.createReadStream(filePath).pipe(res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Import ──────────────────────────────────────────────────────────────────

app.get('/api/import/config', requireAuth, requireParent, async (_req, res) => {
  const cfg = getMagicIndexConfig();
  res.json({
    magicindex: {
      provider: cfg.provider,
      provider_default: cfg.provider_default,
      provider_private: cfg.provider_private,
      default_enabled: cfg.default_enabled,
      auto_apply_confidence: cfg.auto_apply_confidence,
      compatible_configured: !!(cfg.compatible.base_url && cfg.compatible.model),
      openai_configured: !!cfg.openai.api_key
    }
  });
});

app.get('/api/import/batches', requireAuth, requireParent, async (req, res) => {
  try { res.json(await importBatches.listBatches(req.query.limit)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/import/batches', requireAuth, requireParent, async (req, res) => {
  try {
    const batch = await importBatches.createBatch({ ...req.body, created_by: req.member.id });
    await audit.log('import.batch_created', 'import_batch', batch.id, req.member.id, { name: batch.name, source_kind: batch.source_kind });
    res.status(201).json(batch);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/import/batches/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const batch = await importBatches.getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Import batch not found' });
    res.json(batch);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/import/batches/:id/items', requireAuth, requireParent, async (req, res) => {
  try { res.json(await importBatches.listItems(req.params.id, req.query)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/import/batches/:id/items', requireAuth, requireParent, async (req, res) => {
  try {
    const parts = await parseMultipart(req);
    const item = await importBatches.stageImportItem(req.params.id, parts.file, { relative_path: parts.relative_path });
    res.status(201).json(item);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/import/batches/:id/start', requireAuth, requireParent, async (req, res) => {
  try { res.json(await importBatches.startBatch(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/import/batches/:id/cancel', requireAuth, requireParent, async (req, res) => {
  try { res.json(await importBatches.cancelBatch(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/import/items/:id/retry', requireAuth, requireParent, async (req, res) => {
  try {
    const item = await importBatches.retryItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Retryable import item not found' });
    res.json(item);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/import/items/:id/apply-magicindex', requireAuth, requireParent, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ii.*, b.options AS batch_options, b.created_by AS batch_created_by
      FROM import_items ii
      JOIN import_batches b ON b.id = ii.batch_id
      WHERE ii.id = $1
    `, [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Import item not found' });
    if (!item.document_id) return res.status(400).json({ error: 'Import item has no document' });
    if (!item.magicindex_result || typeof item.magicindex_result !== 'object') {
      return res.status(400).json({ error: 'No MagicIndex result available to apply' });
    }

    const threshold = Number(req.body?.threshold ?? item.batch_options?.auto_apply_confidence ?? process.env.MAGICINDEX_AUTO_APPLY_CONFIDENCE ?? 0.85);
    const autoApplied = await applyMagicIndexToDocument({
      documentId: item.document_id,
      result: item.magicindex_result.suggestions || item.magicindex_result,
      threshold,
      provider: item.magicindex_result.provider || item.batch_options?.magicindex_provider || 'openai',
      model: item.magicindex_result.model || null,
      force: true
    });

    const nextResult = { ...item.magicindex_result, auto_applied: autoApplied, applied_by_user: true, applied_at: new Date().toISOString() };
    const updated = await importBatches.updateItemStatus(item.id, 'review_ready', { magicindex_result: nextResult });
    await audit.log('magicindex.applied', 'document', item.document_id, req.member.id, { import_item_id: item.id, fields: Object.keys(autoApplied) });
    res.json({ ok: true, item: updated, auto_applied: autoApplied });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/import/url', requireAuth, requireParent, async (req, res) => {
  try {
    const { url, ...metadata } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const doc = await importFromUrl(url, metadata, req.member.id);
    res.status(201).json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Backup ──────────────────────────────────────────────────────────────────

app.get('/api/backup/status', requireAuth, requireParent, async (_req, res) => {
  try { res.json(await getBackupStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backup/log', requireAuth, requireParent, async (_req, res) => {
  try { res.json(await getBackupLog()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backup/export', requireAuth, requireParent, async (req, res) => {
  try {
    const { encrypted, passphrase } = req.body || {};
    const result = await createBackup({ encrypted: !!encrypted, passphrase });
    await audit.log('backup.completed', 'backup', result.id, req.member.id, { encrypted: !!encrypted });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backup/download/:filename', requireAuth, requireParent, (req, res) => {
  const filePath = getFilePath(`exports/${req.params.filename}`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup file not found' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── Backup policy ─────────────────────────────────────���─────────────────────

app.put('/api/backup/policy', requireAuth, requireParent, async (req, res) => {
  try {
    const policy = req.body;
    await pool.query(
      "INSERT INTO app_config (key, value) VALUES ('backup_policy', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [JSON.stringify(policy)]
    );
    res.json({ ok: true, policy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Audit log ───────────────────────────────────────────────────────────────

app.get('/api/audit', requireAuth, requireParent, async (req, res) => {
  try { res.json(await audit.getLog(req.query)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/insights', requireAuth, requireParent, async (req, res) => {
  try {
    res.json(await insights.listInsights(req.query));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/insights/summary', requireAuth, requireParent, async (_req, res) => {
  try {
    res.json(await insights.getInsightSummary());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/insights/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const insight = await insights.getInsight(req.params.id);
    if (!insight) return res.status(404).json({ error: 'Insight not found' });
    res.json(insight);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/insights/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const updated = await insights.updateInsight(req.params.id, req.body, req.member.id);
    if (!updated) return res.status(404).json({ error: 'Insight not found' });
    await audit.log('insight.updated', 'magic_data', updated.id, req.member.id, {
      status: updated.status,
      severity: updated.severity,
      title: updated.title
    });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/insights/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const existing = await insights.getInsight(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Insight not found' });
    const ok = await insights.deleteInsight(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Insight not found' });
    await audit.log('insight.deleted', 'magic_data', Number(req.params.id), req.member.id, {
      category: existing.category,
      title: existing.title
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/insights/scan', requireAuth, requireParent, async (req, res) => {
  try {
    const scanId = insights.createScanId('manual');
    const [expiryResult, qualityResult] = await Promise.all([
      runExpiryScan({ actorId: req.member.id, scanId }),
      runDocumentQualityScan({ actorId: req.member.id, scanId })
    ]);
    const result = {
      scan_id: scanId,
      created_or_updated: expiryResult.created_or_updated + qualityResult.created_or_updated,
      stale_count: expiryResult.stale_count + qualityResult.stale_count,
      touched_ids: [...expiryResult.touched_ids, ...qualityResult.touched_ids]
    };
    await audit.log('insight.scan', 'magic_data', null, req.member.id, { expiryResult, qualityResult, ...result });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/documents/:id/links', requireAuth, async (req, res) => {
  try {
    res.json(await magicLinks.listLinksForDocument(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/links', requireAuth, requireParent, async (req, res) => {
  try {
    res.json(await magicLinks.listLinks(req.query));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/documents/:id/links', requireAuth, requireParent, async (req, res) => {
  try {
    const link = await magicLinks.createManualLink({
      sourceDocumentId: Number(req.params.id),
      targetDocumentId: Number(req.body.target_document_id),
      linkType: req.body.link_type,
      reasoning: req.body.reasoning || '',
      actorId: req.member.id
    });
    await audit.log('link.created', 'magic_link', link.id, req.member.id, {
      source_document_id: link.source_document_id,
      target_document_id: link.target_document_id,
      link_type: link.link_type
    });
    res.status(201).json(link);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/links/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const link = await magicLinks.updateLink(req.params.id, req.body, req.member.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    await audit.log('link.updated', 'magic_link', link.id, req.member.id, {
      status: link.status,
      link_type: link.link_type
    });
    res.json(link);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/links/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const ok = await magicLinks.deleteLink(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Link not found' });
    await audit.log('link.deleted', 'magic_link', Number(req.params.id), req.member.id, {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/links/scan', requireAuth, requireParent, async (req, res) => {
  try {
    const result = await scanDeterministicLinks();
    await audit.log('link.scan', 'magic_link', null, req.member.id, result);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─�� Dashboard stats ─────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const tasks = [
      pool.query("SELECT COUNT(*)::int AS total FROM documents WHERE status = 'active'"),
      pool.query("SELECT document_type, COUNT(*)::int AS count FROM documents WHERE status = 'active' GROUP BY document_type ORDER BY count DESC"),
      pool.query("SELECT d.id, d.title, d.document_type, d.created_at FROM documents d WHERE d.status = 'active' ORDER BY d.created_at DESC LIMIT 5"),
      pool.query("SELECT d.id, d.title, d.document_type, d.expiry_date FROM documents d WHERE d.status = 'active' AND d.expiry_date IS NOT NULL AND d.expiry_date <= NOW() + INTERVAL '90 days' ORDER BY d.expiry_date ASC LIMIT 10"),
      getBackupStatus()
    ];
    if (req.member?.role === 'parent') tasks.push(insights.getInsightSummary());
    const [docs, types, recent, expiring, backup, insightSummary = null] = await Promise.all(tasks);

    res.json({
      total_documents: docs.rows[0].total,
      by_type: types.rows,
      recent: recent.rows,
      expiring_soon: expiring.rows,
      backup,
      insights: insightSummary
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Page routes ─────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  try {
    const state = await bootstrapState();
    if (state.bootstrap.needs_household) return res.redirect('./setup');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/setup', async (req, res) => {
  try {
    const state = await bootstrapState();
    if (!state.bootstrap.needs_household) return res.redirect('./');
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/share/:token', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'share.html')));
app.get('/insights.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'insights.html')));

// ── Periodic cleanup ────────────────────────────────────────────────────────

const _cleanupInterval = setInterval(() => cleanExpiredSessions().catch(() => {}), 60 * 60 * 1000);
if (process.env.NODE_ENV === 'test') _cleanupInterval.unref();

// ── Start ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Home Source listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
