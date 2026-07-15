'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool } = require('./lib/db');
const { hashPassphrase, verifyPassphrase, createSession, validateSession, destroySession, cleanExpiredSessions, authEnabled, parseCookie, requireAuth, requireParent } = require('./lib/auth');
const { listDocuments, getDocument, createDocument, encryptDocumentInPlace, updatePkiDocumentAccess, updateDocument, archiveDocument, permanentDeleteDocument, addOwner, removeOwner, listMembers, getMember, memberCount, canMemberAccessDocument } = require('./lib/documents');
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
const { isEncryptedDocument, normalizeEncryptionInput } = require('./lib/encryption-mode');
const audit = require('./lib/audit');
const pki = require('./lib/pki');
const webauthn = require('./lib/webauthn');
const { notifyKeyEvent } = require('./lib/notifications');
const { createKeyNotificationDispatcher } = require('./lib/key-notification-dispatcher');
const { sendMail } = require('./lib/mailer');
const trustees = require('./lib/trustees');

const app = express();
const PORT = Number(process.env.PORT || '3008');
const DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL = 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap';
const DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap';

const keyNotificationDispatcher = createKeyNotificationDispatcher({ notifyKeyEvent, audit });

app.disable('x-powered-by');
app.set('trust proxy', 1);

function isHttpsRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwardedProto) return forwardedProto === 'https';
  return req.secure === true;
}

function allowSelfFraming(res) {
  const existing = String(res.getHeader('Content-Security-Policy') || '');
  if (!existing) return;
  const updated = existing.replace(/frame-ancestors\s+'none'/, "frame-ancestors 'self'");
  res.setHeader('Content-Security-Policy', updated);
}

function buildSovereignFontsCss() {
  const source = String(process.env.SOVEREIGN_FONT_SOURCE || 'google').trim().toLowerCase();
  if (source === 'off') return '/* Sovereign fonts disabled via SOVEREIGN_FONT_SOURCE=off */\n';

  const isLocal = source === 'local';
  const sansUrl = (isLocal ? process.env.SOVEREIGN_FONT_SANS_CSS_URL_LOCAL : process.env.SOVEREIGN_FONT_SANS_CSS_URL)
    || DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL;
  const monoUrl = (isLocal ? process.env.SOVEREIGN_FONT_MONO_CSS_URL_LOCAL : process.env.SOVEREIGN_FONT_MONO_CSS_URL)
    || DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL;

  return [
    '/* Generated from environment: /sovereign-fonts.css */',
    `@import url('${sansUrl}');`,
    `@import url('${monoUrl}');`,
    '',
  ].join('\n');
}


ensureDirs();

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', [
    'camera=(self)',
    'microphone=()',
    'geolocation=()',
    'publickey-credentials-create=(self)',
    'publickey-credentials-get=(self)'
  ].join(', '));
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://docs.opencv.org",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "media-src 'self' blob:"
  ].join('; '));
  next();
});

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
const PARENT_ONLY_PAGES = new Set(['/backup.html', '/import.html', '/insights.html']);

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

app.get('/sovereign-fonts.css', (_req, res) => {
  res.set('content-type', 'text/css; charset=utf-8');
  res.set('cache-control', 'public, max-age=300');
  res.send(buildSovereignFontsCss());
});

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
    const secureCookie = isHttpsRequest(req);
    res.setHeader('Set-Cookie', `hs_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secureCookie ? '; Secure' : ''}`);
    res.json({ ok: true, member: { id: member.id, name: member.name, role: member.role, avatar_emoji: member.avatar_emoji } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookie(req.headers.cookie, 'hs_session');
  await destroySession(token);
  const secureCookie = isHttpsRequest(req);
  res.setHeader('Set-Cookie', `hs_session=; Path=/; HttpOnly; Max-Age=0${secureCookie ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.member) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.member);
});

app.post('/api/auth/passphrase', requireAuth, async (req, res) => {
  try {
    const currentPassphrase = String(req.body?.current_passphrase || '');
    const nextPassphrase = String(req.body?.new_passphrase || '');
    if (!nextPassphrase || nextPassphrase.length < 8) {
      return res.status(400).json({ error: 'New passphrase must be at least 8 characters' });
    }

    const { rows } = await pool.query(
      'SELECT id, passphrase_hash FROM family_members WHERE id = $1',
      [req.member.id]
    );
    const member = rows[0];
    if (!member) return res.status(404).json({ error: 'Member not found' });

    if (member.passphrase_hash) {
      if (!currentPassphrase) return res.status(400).json({ error: 'Current passphrase required' });
      if (!verifyPassphrase(currentPassphrase, member.passphrase_hash)) {
        return res.status(401).json({ error: 'Current passphrase is incorrect' });
      }
      if (verifyPassphrase(nextPassphrase, member.passphrase_hash)) {
        return res.status(400).json({ error: 'New passphrase must be different from current passphrase' });
      }
    }

    await pool.query(
      'UPDATE family_members SET passphrase_hash = $1 WHERE id = $2',
      [hashPassphrase(nextPassphrase), req.member.id]
    );
    await audit.log('auth.passphrase_changed', 'family_member', req.member.id, req.member.id, { self_service: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── Continuity trustees ──────────────────────────────────────────────────────

function trusteeInvitationUrl(token) {
  const configuredBaseUrl = String(process.env.APP_URL || '').trim();
  if (!configuredBaseUrl) throw new Error('APP_URL is required for trustee invitations');
  let invitationUrl;
  try {
    invitationUrl = new URL('/trustee-invite.html', configuredBaseUrl);
  } catch {
    throw new Error('APP_URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(invitationUrl.protocol)) {
    throw new Error('APP_URL must be an absolute http(s) URL');
  }
  invitationUrl.searchParams.set('token', token);
  return invitationUrl.toString();
}

function trusteeInvitationMessage({ trustee, operatorName, invitationUrl, expiresAt }) {
  const expiry = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long', timeStyle: 'short', timeZone: process.env.HOUSEHOLD_TIMEZONE || 'America/New_York'
  }).format(new Date(expiresAt));
  return {
    to: trustee.email,
    subject: 'A private Home Source continuity invitation',
    text: `${operatorName} has asked you to prepare a private continuity key with Home Source. This invitation does not give access to any documents.\n\nOpen this one-time link to create your key:\n${invitationUrl}\n\nThis link expires ${expiry}. If you were not expecting this invitation, you can ignore this email.`
  };
}

app.get('/api/trustees', requireAuth, requireParent, async (_req, res) => {
  try {
    res.json(await trustees.listTrustees());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/continuity/directory', requireAuth, requireParent, async (_req, res) => {
  try {
    const { rows: members } = await pool.query(
      `SELECT m.id, m.name, m.role, m.avatar_emoji,
              COUNT(DISTINCT dd.id)::int AS designation_count,
              COUNT(DISTINCT ek.id) FILTER (WHERE ek.revoked_at IS NULL)::int AS active_key_count
       FROM family_members m
       LEFT JOIN document_designations dd ON dd.member_id = m.id
       LEFT JOIN encryption_keys ek ON ek.member_id = m.id AND ek.key_type = 'member'
       GROUP BY m.id ORDER BY m.role, m.name`
    );
    const trusteeRows = await trustees.listTrustees();
    const { rows: documents } = await pool.query(
      `SELECT d.id, d.title, d.status,
              COALESCE(json_agg(json_build_object(
                'encryption_key_id', dd.encryption_key_id, 'member_id', dd.member_id,
                'trustee_id', dd.trustee_id, 'role', dd.role, 'sealed', dd.sealed
              ) ORDER BY dd.id) FILTER (WHERE dd.id IS NOT NULL), '[]') AS designations
       FROM documents d
       JOIN document_designations dd ON dd.document_id = d.id
       WHERE d.status = 'active'
       GROUP BY d.id ORDER BY d.title`
    );
    res.json({ members, trustees: trusteeRows, documents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/trustees', requireAuth, requireParent, async (req, res) => {
  try {
    const { name, relationship, email } = req.body || {};
    // Validate the deployment URL before persisting a token that cannot be delivered.
    trusteeInvitationUrl('placeholder');
    const trustee = await trustees.createTrustee({
      name,
      relationship,
      email,
      createdBy: req.member.id
    });
    const invitation = await trustees.createTrusteeInvitation({ trusteeId: trustee.id });
    const invitationUrl = trusteeInvitationUrl(invitation.token);
    const delivery = await sendMail(trusteeInvitationMessage({
      trustee,
      operatorName: req.member.name,
      invitationUrl,
      expiresAt: invitation.expires_at
    }));
    await audit.log('trustee.invited', 'vault_trustee', trustee.id, req.member.id, {
      invitation_id: invitation.id,
      expires_at: invitation.expires_at,
      email_delivery: {
        delivered: delivery.delivered === true,
        transport: delivery.transport || null,
        reason: delivery.reason || null
      }
    });
    res.status(201).json({
      trustee,
      invitation: {
        expires_at: invitation.expires_at,
        delivered: delivery.delivered === true
      }
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/trustees/:id', requireAuth, requireParent, async (req, res) => {
  try {
    const trustee = await trustees.revokeTrustee(req.params.id);
    if (!trustee) return res.status(404).json({ error: 'Trustee not found or already revoked' });
    await audit.log('trustee.revoked', 'vault_trustee', trustee.id, req.member.id);
    res.json({ ok: true, trustee });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trustee-invitations/:token', async (req, res) => {
  try {
    const invitation = await trustees.getValidTrusteeInvitation(req.params.token);
    if (!invitation) return res.status(404).json({ error: 'Invitation not found or expired' });
    res.json({
      trustee: { name: invitation.name, relationship: invitation.relationship },
      invited_by: invitation.created_by_name,
      expires_at: invitation.expires_at
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/trustee-invitations/:token/register', async (req, res) => {
  try {
    const body = req.body || {};
    const registered = await trustees.registerTrusteeFromInvitation({
      token: req.params.token,
      publicKey: body.public_key,
      encryptedPrivateKey: body.encrypted_private_key,
      algorithm: body.algorithm || 'x25519',
      protectionTier: body.protection_tier || 'passphrase',
      label: body.label || null
    });
    if (!registered) return res.status(404).json({ error: 'Invitation not found or expired' });
    await audit.log('trustee.registered', 'vault_trustee', registered.trustee.id, null, {
      invitation_id: registered.invitation.id,
      encryption_key_id: registered.key.id,
      protection_tier: registered.key.protection_tier
    });
    res.status(201).json({ trustee: registered.trustee, key: registered.key });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── PKI Key Management ─────────────────────────────────────────────────────

app.get('/api/members/:id/keys', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const includeRevoked = req.query.includeRevoked === '1' || req.query.includeRevoked === 'true';
    // Kids can only see their own keys
    if (req.member.role === 'kid' && req.member.id !== memberId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(await pki.listMemberKeys(memberId, { includeRevoked }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/members/:id/keys', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    // Members can only register keys for themselves
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only register keys for yourself' });
    }
    const { public_key, encrypted_private_key, algorithm, credential_id, prf_enabled, protection_tier, label } = req.body;
    if (!public_key || !encrypted_private_key) {
      return res.status(400).json({ error: 'public_key and encrypted_private_key are required' });
    }
    const key = await pki.registerMemberKey({
      memberId,
      publicKey: public_key,
      encryptedPrivateKey: encrypted_private_key,
      algorithm: algorithm || 'x25519',
      credentialId: credential_id || null,
      prfEnabled: !!prf_enabled,
      protectionTier: protection_tier || 'passphrase',
      label: label || null,
      verificationMethod: (protection_tier || 'passphrase') === 'passphrase' ? 'passphrase' : 'manual',
    });
    await audit.log('key.registered', 'encryption_key', key.id, req.member.id, {
      protection_tier: key.protection_tier,
      protection_tier_verified: false,
      prf_enabled: key.prf_enabled,
      label: key.label
    });
    await keyNotificationDispatcher.dispatch({
      event: 'key.registered',
      memberId,
      memberName: req.member.name,
      actorId: req.member.id
    });
    res.status(201).json(key);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/members/:id/keys/webauthn/options', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only register keys for yourself' });
    }
    if (!webauthn.isSecureWebAuthnContext(req)) {
      return res.status(400).json({ error: 'WebAuthn requires HTTPS or localhost' });
    }
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const requestedMethod = req.body?.requested_method;
    if (!['security_key', 'passkey'].includes(requestedMethod)) {
      return res.status(400).json({ error: 'requested_method must be "security_key" or "passkey"' });
    }
    const existingKeys = await pki.listMemberKeys(memberId);
    const options = await webauthn.createMemberKeyRegistrationOptions(
      req,
      member,
      existingKeys.filter((key) => key.credential_id).map((key) => key.credential_id),
      requestedMethod
    );
    res.json(options);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/members/:id/keys/webauthn/complete', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only register keys for yourself' });
    }
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const result = await webauthn.completeMemberKeyRegistration(req, member, req.body || {});
    await audit.log('webauthn.credential_registered', 'family_member', memberId, req.member.id, {
      credential_id: result.verification.credential_id,
      requested_method: result.verification.requested_method,
      prf_enabled_on_create: result.verification.prf_enabled_on_create,
    });
    res.status(201).json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/members/:id/keys/webauthn/assertion-options', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only assert keys for yourself' });
    }
    if (!webauthn.isSecureWebAuthnContext(req)) {
      return res.status(400).json({ error: 'WebAuthn requires HTTPS or localhost' });
    }
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const credentialId = String(req.body?.credential_id || '').trim();
    if (!credentialId) {
      return res.status(400).json({ error: 'credential_id is required' });
    }
    const options = await webauthn.createMemberKeyAssertionOptions(req, member, credentialId);
    res.json(options);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/members/:id/keys/webauthn/finalize', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only register keys for yourself' });
    }
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const result = await webauthn.finalizeMemberKeyRegistration(req, member, req.body || {});
    await audit.log('key.registered', 'encryption_key', result.key.id, req.member.id, {
      protection_tier: result.key.protection_tier,
      protection_tier_verified: result.key.credential_verified === true,
      prf_enabled: result.key.prf_enabled,
      label: result.key.label,
      verification_method: result.key.verification_method
    });
    await keyNotificationDispatcher.dispatch({
      event: 'key.registered',
      memberId,
      memberName: req.member.name,
      actorId: req.member.id
    });
    res.status(201).json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/members/:id/keys/:keyId/recovery', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const keyId = Number(req.params.keyId);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only save recovery data for yourself' });
    }
    const { recovery_wrapped_private_key, recovery_type } = req.body || {};
    if (!recovery_wrapped_private_key) {
      return res.status(400).json({ error: 'recovery_wrapped_private_key is required' });
    }
    const updated = await pki.saveRecoveryWrap(
      keyId,
      memberId,
      recovery_wrapped_private_key,
      recovery_type || 'mnemonic_bip39'
    );
    if (!updated) return res.status(404).json({ error: 'Key not found' });
    await audit.log('key.recovery_enabled', 'encryption_key', keyId, req.member.id, {
      recovery_type: recovery_type || 'mnemonic_bip39'
    });
    res.json(updated);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/members/:id/keys/:keyId/material', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const keyId = Number(req.params.keyId);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only read key material for yourself' });
    }
    const key = await pki.getMemberKeyMaterial(keyId, memberId);
    if (!key) return res.status(404).json({ error: 'Key not found' });
    res.json(key);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/members/:id/keys/:keyId/tested', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const keyId = Number(req.params.keyId);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only test your own keys' });
    }
    const key = await pki.getMemberKey(keyId, memberId);
    if (!key || key.revoked_at) return res.status(404).json({ error: 'Key not found' });
    const updated = await pki.updateKeyLastUsed(keyId);
    await audit.log('key.tested', 'encryption_key', keyId, req.member.id, {
      member_id: memberId,
      protection_tier: key.protection_tier,
      verification_method: key.verification_method
    });
    res.json({ ok: true, key: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/members/:id/keys/:keyId/dependencies', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const keyId = Number(req.params.keyId);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only inspect dependencies for your own keys' });
    }
    const summary = await pki.getKeyDependencySummary(keyId, memberId);
    if (!summary) return res.status(404).json({ error: 'Key not found' });
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/members/:id/keys/:keyId', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const keyId = Number(req.params.keyId);
    if (req.member.id !== memberId) {
      return res.status(403).json({ error: 'Can only revoke keys for yourself' });
    }
    const summary = await pki.getKeyDependencySummary(keyId, memberId);
    if (!summary) return res.status(404).json({ error: 'Key not found or already revoked' });
    const soleHolderDocs = summary.documents.filter((doc) => doc.status === 'sole_active_holder');
    const inconsistentDocs = summary.documents.filter((doc) => doc.status === 'holder_metadata_inconsistent');
    if (soleHolderDocs.length || inconsistentDocs.length) {
      const blockedCode = soleHolderDocs.length ? 'PKI_KEY_SOLE_ACTIVE_HOLDER' : 'PKI_KEY_DEPENDENCY_INCONSISTENT';
      const blockedError = soleHolderDocs.length
        ? 'Key cannot be revoked because it is the sole active holder for encrypted documents'
        : 'Key cannot be revoked because encrypted document holder metadata is inconsistent';
      await audit.log('key.revoke_blocked', 'encryption_key', keyId, req.member.id, {
        member_id: memberId,
        code: blockedCode,
        affected_document_count: summary.document_count,
        sole_active_holder_document_count: soleHolderDocs.length,
        inconsistent_document_count: inconsistentDocs.length
      });
      return res.status(409).json({
        error: blockedError,
        code: blockedCode,
        affected_documents: (soleHolderDocs.length ? soleHolderDocs : inconsistentDocs).map((doc) => ({
          document_id: doc.document_id,
          title: doc.title
        }))
      });
    }
    const revoked = await pki.revokeMemberKey(keyId, memberId, req.member.id);
    if (!revoked) return res.status(404).json({ error: 'Key not found or already revoked' });
    await keyNotificationDispatcher.dispatch({
      event: 'key.revoked',
      memberId,
      memberName: req.member.name,
      actorId: req.member.id
    });
    res.json({ ok: true, revoked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/members/:id/keys/:keyId/verify-fingerprint', requireAuth, async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (req.member.role === 'kid' && req.member.id !== memberId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const keyId = Number(req.params.keyId);
    const key = await pki.getMemberKey(keyId, memberId);
    if (!key) return res.status(404).json({ error: 'Key not found' });
    const { expected_fingerprint } = req.body;
    if (!expected_fingerprint) return res.status(400).json({ error: 'expected_fingerprint required' });
    const match = key.key_fingerprint === expected_fingerprint;
    res.json({ match, server_fingerprint: key.key_fingerprint });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pki/posture', requireAuth, async (req, res) => {
  try {
    res.json(await pki.getPkiPostureSummary(req.member));
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
      filters.exclude_sealed_member_id = req.member.id;
    }
    res.json(await listDocuments(filters));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await audit.log('document.viewed', 'document', doc.id, req.member.id);
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/documents/:id/key-info', requireAuth, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const info = await pki.getDocumentKeyInfo(doc.id);
    if (!info) return res.status(404).json({ error: 'Document key info not found' });
    res.json(info);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/documents/:id/magicindex-status', requireAuth, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
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

app.post('/api/documents/:id/encrypt', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (isEncryptedDocument(doc)) {
      return res.status(409).json({ error: 'Document is already encrypted' });
    }
    const originalFiles = (doc.files || []).filter((file) => file.file_type === 'original');
    if (originalFiles.length !== 1) {
      return res.status(409).json({ error: 'Encrypting documents with multiple uploads is not supported yet' });
    }

    const parts = await parseMultipart(req);
    const file = parts.file;
    if (!file || !file.data?.length) return res.status(400).json({ error: 'Encrypted replacement file is required' });

    const metadata = parts.metadata ? JSON.parse(Array.isArray(parts.metadata) ? parts.metadata[0] : parts.metadata) : {};
    const encryption = normalizeEncryptionInput(metadata || {});
    if (!encryption.is_encrypted || encryption.encryption_mode === 'plaintext') {
      return res.status(400).json({ error: 'Encrypted metadata is required' });
    }

    let encryptionKeyId = null;
    if (encryption.encryption_mode === 'pki') {
      encryptionKeyId = await pki.validatePkiUpload(encryption.encryption_metadata, req.member.id);
    }

    const stored = await storeFile(file.data, file.filename, file.type);
    const updated = await encryptDocumentInPlace(doc.id, {
      encryptedFile: stored,
      encryptionMode: encryption.encryption_mode,
      encryptionMetadata: encryption.encryption_metadata,
      encryptionKeyId
    });

    if (encryptionKeyId) {
      await pki.updateKeyLastUsed(encryptionKeyId);
    }

    await audit.log(
      `document.encrypted.${encryption.encryption_mode}`,
      'document',
      updated.id,
      req.member.id,
      {
        original_file_id: originalFiles[0].id,
        encryption_key_id: encryptionKeyId,
        deleted_share_count: Number(updated._deleted_share_count || 0),
        cleanup_failure_count: Array.isArray(updated._cleanup_failures) ? updated._cleanup_failures.length : 0,
        orphaned_plaintext_files: Array.isArray(updated._cleanup_failures)
          ? updated._cleanup_failures.map((entry) => entry.stored_filename)
          : []
      }
    );
    delete updated._deleted_share_count;
    delete updated._cleanup_failures;
    res.json(updated);
  } catch (err) {
    const status = /already encrypted/i.test(err.message) ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.put('/api/documents/:id', requireAuth, async (req, res) => {
  try {
    if (req.member.role === 'kid') return res.status(403).json({ error: 'Parent access required' });
    const forbidden = ['is_encrypted', 'encryption_mode', 'encryption_metadata', 'encryption_key_id'];
    const found = forbidden.filter((k) => req.body && Object.prototype.hasOwnProperty.call(req.body, k));
    if (found.length) return res.status(400).json({ error: `Encryption fields are immutable via this endpoint: ${found.join(', ')}` });
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
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (isEncryptedDocument(doc)) return res.status(409).json({ error: 'MagicIndex re-analysis is unavailable for encrypted documents' });
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

app.delete('/api/documents/:id/magicindex', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!doc.metadata?.magicindex) return res.status(404).json({ error: 'No MagicIndex data to delete' });
    const cleaned = { ...doc.metadata };
    delete cleaned.magicindex;
    await updateDocument(doc.id, { metadata: cleaned });
    await audit.log('magicindex.deleted', 'document', doc.id, req.member.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

function normalizeStoredPkiHolders(entry = {}) {
  const existingHolders = Array.isArray(entry.holders) ? entry.holders : [];
  return existingHolders.map((holder, index) => ({
    ...holder,
    role: holder.role || (index === 0 ? 'owner' : 'backup'),
    wrapped_dek: holder.wrapped_dek || (index === 0 && entry.wrapped_dek ? entry.wrapped_dek : null)
  }));
}

function wrappedDekChanged(updatedWrappedDek, existingWrappedDek) {
  return String(updatedWrappedDek?.kind || '') !== String(existingWrappedDek?.kind || '')
    || String(updatedWrappedDek?.ephemeral_public_key_b64 || '') !== String(existingWrappedDek?.ephemeral_public_key_b64 || '')
    || String(updatedWrappedDek?.hkdf_salt_b64 || '') !== String(existingWrappedDek?.hkdf_salt_b64 || '')
    || String(updatedWrappedDek?.wrapped_dek_b64 || '') !== String(existingWrappedDek?.wrapped_dek_b64 || '');
}

function holderIntegrityChanged(updatedHolder, existingHolder) {
  const existingWrappedDek = existingHolder.wrapped_dek || null;
  const updatedWrappedDek = updatedHolder.wrapped_dek || null;
  return Number(updatedHolder.member_id) !== Number(existingHolder.member_id)
    || String(updatedHolder.role || '') !== String(existingHolder.role || '')
    || String(updatedHolder.key_fingerprint || '') !== String(existingHolder.key_fingerprint || '')
    || wrappedDekChanged(updatedWrappedDek, existingWrappedDek);
}

function choosePrimaryHolderKeyId(holders, previousPrimaryKeyId, keysById) {
  const previous = holders.find((holder) => Number(holder.encryption_key_id) === Number(previousPrimaryKeyId));
  if (previous) {
    const row = keysById.get(Number(previous.encryption_key_id));
    if (row && !row.revoked_at) return Number(previous.encryption_key_id);
  }
  const firstActive = holders.find((holder) => {
    const row = keysById.get(Number(holder.encryption_key_id));
    return row && !row.revoked_at;
  });
  return firstActive ? Number(firstActive.encryption_key_id) : null;
}

function pkiUploadHolders(metadata) {
  return metadata?.files?.upload?.holders || [];
}

function holderHasSameIdentity(left, right) {
  return Number(left?.member_id || 0) === Number(right?.member_id || 0)
    && Number(left?.trustee_id || 0) === Number(right?.trustee_id || 0)
    && Number(left?.encryption_key_id || 0) === Number(right?.encryption_key_id || 0)
    && String(left?.role || '') === String(right?.role || '')
    && String(left?.key_fingerprint || '') === String(right?.key_fingerprint || '')
    && (left?.sealed === true) === (right?.sealed === true)
    && String(left?.sealed_until || '') === String(right?.sealed_until || '')
    && !wrappedDekChanged(left?.wrapped_dek, right?.wrapped_dek);
}

async function validateNewSealedHolder(holder, actorId) {
  if (!holder || holder.sealed !== true || holder.sealed_until !== 'deadman_trigger') {
    throw new Error('Sealed designations must set sealed=true and sealed_until=deadman_trigger');
  }
  if (!holder.wrapped_dek || holder.wrapped_dek.kind !== 'pki_x25519') {
    throw new Error('Sealed designation requires holder-local wrapped_dek metadata');
  }
  const hasMember = Number(holder.member_id) > 0;
  const hasTrustee = Number(holder.trustee_id) > 0;
  if (hasMember === hasTrustee) throw new Error('Sealed designation requires exactly one recipient identity');
  if ((holder.role === 'beneficiary') !== hasMember || (holder.role === 'trustee') !== hasTrustee) {
    throw new Error('Sealed designation role must match its recipient identity');
  }
  const { rows } = await pool.query(
    `SELECT ek.id, ek.key_type, ek.member_id, ek.trustee_id, ek.key_fingerprint, ek.revoked_at,
            member.role AS member_role
     FROM encryption_keys ek
     LEFT JOIN family_members member ON member.id = ek.member_id
     WHERE ek.id = $1`,
    [Number(holder.encryption_key_id)]
  );
  const key = rows[0];
  if (!key || key.revoked_at) throw new Error('Sealed designation key is unavailable');
  if (key.key_fingerprint !== holder.key_fingerprint) throw new Error('Sealed designation key fingerprint mismatch');
  if (hasMember && (key.key_type !== 'member' || Number(key.member_id) !== Number(holder.member_id))) {
    throw new Error('Sealed beneficiary key does not belong to the selected member');
  }
  if (hasMember && Number(holder.member_id) === Number(actorId)) {
    throw new Error('A beneficiary designation must target a different household member');
  }
  if (hasMember && key.member_role !== 'kid') {
    throw new Error('Phase A beneficiary designations must target a household kid');
  }
  if (hasTrustee && (key.key_type !== 'trustee' || Number(key.trustee_id) !== Number(holder.trustee_id))) {
    throw new Error('Sealed trustee key does not belong to the selected trustee');
  }
}

app.post('/api/documents/:id/designations/seal', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) return res.status(403).json({ error: 'Access denied' });
    if (!isEncryptedDocument(doc) || doc.encryption_mode !== 'pki') return res.status(409).json({ error: 'Document is not PKI-encrypted' });
    const encryptionMetadata = req.body?.encryption_metadata;
    if (!encryptionMetadata || typeof encryptionMetadata !== 'object') return res.status(400).json({ error: 'encryption_metadata is required' });
    const normalized = normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: encryptionMetadata });
    if (Number(normalized.encryption_metadata.version) !== 2) return res.status(400).json({ error: 'Sealed designations require encryption_metadata.version = 2' });

    const existingHolders = normalizeStoredPkiHolders(doc.encryption_metadata?.files?.upload || {});
    const updatedHolders = pkiUploadHolders(normalized.encryption_metadata);
    const existingByKeyId = new Map(existingHolders.map((holder) => [Number(holder.encryption_key_id), holder]));
    for (const existing of existingHolders) {
      const candidate = updatedHolders.find((holder) => Number(holder.encryption_key_id) === Number(existing.encryption_key_id));
      if (!candidate || !holderHasSameIdentity(candidate, existing)) {
        return res.status(400).json({ error: 'Existing holders cannot be modified while sealing a designation' });
      }
    }
    const added = updatedHolders.filter((holder) => !existingByKeyId.has(Number(holder.encryption_key_id)));
    if (added.length !== 1) return res.status(400).json({ error: 'This route seals exactly one new designation at a time' });
    const sealedHolder = added[0];
    await validateNewSealedHolder(sealedHolder, req.member.id);

    const updated = await updatePkiDocumentAccess(doc.id, {
      encryptionMetadata: normalized.encryption_metadata,
      encryptionKeyId: doc.encryption_key_id,
      validate: async (lockedDoc) => {
        const lockedHolders = normalizeStoredPkiHolders(lockedDoc.encryption_metadata?.files?.upload || {});
        if (lockedHolders.length !== existingHolders.length || lockedHolders.some((holder) => {
          const expected = existingHolders.find((entry) => Number(entry.encryption_key_id) === Number(holder.encryption_key_id));
          return !expected || !holderHasSameIdentity(holder, expected);
        })) {
          throw new Error('Document holders changed while sealing this designation');
        }
      },
      afterUpdate: async (client) => trustees.upsertDesignation(client, {
        documentId: doc.id,
        memberId: sealedHolder.member_id || null,
        trusteeId: sealedHolder.trustee_id || null,
        role: sealedHolder.role,
        encryptionKeyId: sealedHolder.encryption_key_id,
        sealed: true
      })
    });
    if (!updated) return res.status(404).json({ error: 'Document not found' });
    await audit.log('designation.sealed', 'document', doc.id, req.member.id, {
      encryption_key_id: Number(sealedHolder.encryption_key_id), member_id: sealedHolder.member_id || null,
      trustee_id: sealedHolder.trustee_id || null, role: sealedHolder.role
    });
    res.json({ ok: true, document: updated });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/documents/:id/designations/:keyId/unseal', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) return res.status(403).json({ error: 'Access denied' });
    const keyId = Number(req.params.keyId);
    const metadata = structuredClone(doc.encryption_metadata || {});
    metadata.version = 2;
    const holders = pkiUploadHolders(metadata);
    const holder = holders.find((entry) => Number(entry.encryption_key_id) === keyId);
    if (!holder?.sealed) return res.status(404).json({ error: 'Sealed designation not found' });
    holder.sealed = false;
    holder.sealed_until = 'unsealed';
    const updated = await updatePkiDocumentAccess(doc.id, {
      encryptionMetadata: metadata,
      encryptionKeyId: doc.encryption_key_id,
      afterUpdate: async (client) => trustees.upsertDesignation(client, {
        documentId: doc.id, memberId: holder.member_id || null, trusteeId: holder.trustee_id || null,
        role: holder.role, encryptionKeyId: keyId, sealed: false
      })
    });
    if (!updated) return res.status(404).json({ error: 'Document not found' });
    await audit.log('designation.unsealed', 'document', doc.id, req.member.id, { encryption_key_id: keyId });
    res.json({ ok: true, document: updated });
  } catch (err) { res.status(400).json({ error: err.message }); }
});


app.post('/api/documents/:id/pki-holders/add', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!isEncryptedDocument(doc) || doc.encryption_mode !== 'pki') {
      return res.status(409).json({ error: 'Document is not PKI-encrypted' });
    }

    const body = req.body || {};
    const encryptionMetadata = body.encryption_metadata && typeof body.encryption_metadata === 'object'
      ? body.encryption_metadata
      : null;
    if (!encryptionMetadata) {
      return res.status(400).json({ error: 'encryption_metadata is required' });
    }

    const normalized = normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: encryptionMetadata });
    const existingEntry = doc.encryption_metadata?.files?.upload || {};
    const existingHolderKeyIds = Array.isArray(existingEntry.holders)
      ? existingEntry.holders.map((h) => Number(h.encryption_key_id)).filter(Boolean)
      : [];
    const primaryKeyId = await pki.validatePkiUpload(normalized.encryption_metadata, req.member.id, { existingHolderKeyIds });
    if (body.primary_encryption_key_id && Number(body.primary_encryption_key_id) !== Number(primaryKeyId)) {
      return res.status(400).json({ error: 'primary_encryption_key_id does not match the validated primary holder key' });
    }

    const updatedHolders = normalized.encryption_metadata?.files?.upload?.holders || [];
    const updated = await updatePkiDocumentAccess(doc.id, {
      encryptionMetadata: normalized.encryption_metadata,
      encryptionKeyId: primaryKeyId,
      validate: async (lockedDoc) => {
        const existingEntry = lockedDoc.encryption_metadata?.files?.upload || {};
        const normalizedExistingHolders = normalizeStoredPkiHolders(existingEntry);
        const existingByKeyId = new Map(normalizedExistingHolders.map((holder) => [Number(holder.encryption_key_id), holder]));
        const updatedKeyIds = new Set(updatedHolders.map((holder) => Number(holder.encryption_key_id)));

        for (const existingHolder of normalizedExistingHolders) {
          const keyId = Number(existingHolder.encryption_key_id);
          if (!updatedKeyIds.has(keyId)) {
            throw new Error('Removing existing PKI holders is not supported by this route');
          }
          const updatedHolder = updatedHolders.find((holder) => Number(holder.encryption_key_id) === keyId);
          if (!updatedHolder) {
            throw new Error('Existing PKI holder metadata is missing from the updated envelope');
          }
          if (holderIntegrityChanged(updatedHolder, existingHolder)) {
            throw new Error(`Existing PKI holder ${keyId} cannot be modified by the add-backup-key route`);
          }
        }

        const addedHolders = updatedHolders.filter((holder) => !existingByKeyId.has(Number(holder.encryption_key_id)));
        if (addedHolders.length !== 1) {
          throw new Error('This route supports adding exactly one holder at a time');
        }
        const addedHolder = addedHolders[0];
        if (!['backup', 'beneficiary'].includes(addedHolder.role)) {
          throw new Error('Added holder must have role backup or beneficiary');
        }
        if (addedHolder.role === 'backup' && Number(addedHolder.member_id) !== Number(req.member.id)) {
          throw new Error('Backup holders must belong to the acting member');
        }
        if (addedHolder.role === 'beneficiary' && Number(addedHolder.member_id) === Number(req.member.id)) {
          throw new Error('Beneficiary holders must belong to a different household member');
        }
      }
    });
    if (!updated) return res.status(404).json({ error: 'Document not found' });

    const holderCountBefore = doc.encryption_metadata?.files?.upload?.holders?.length || 0;
    const addedHolder = updatedHolders.find((holder) => !existingHolderKeyIds.includes(Number(holder.encryption_key_id)));
    await audit.log('document.pki_holder_added', 'document', doc.id, req.member.id, {
      added_holder_member_id: Number(addedHolder.member_id),
      added_holder_key_id: Number(addedHolder.encryption_key_id),
      role: addedHolder.role,
      holder_count_before: holderCountBefore,
      holder_count_after: updatedHolders.length,
      encryption_key_id: primaryKeyId
    });
    const holderMember = await getMember(addedHolder.member_id);
    await keyNotificationDispatcher.dispatch({
      event: 'key.holder_added',
      memberId: Number(addedHolder.member_id),
      memberName: holderMember?.name,
      actorId: req.member.id
    });
    res.json({ ok: true, document: updated });
  } catch (err) {
    const safeMessage = String(err?.message || 'Unable to update PKI holders');
    const knownSafe = [
      'Document not found',
      'Access denied',
      'Document is not PKI-encrypted',
      'encryption_metadata is required',
      'primary_encryption_key_id does not match the validated primary holder key',
      'Removing existing PKI holders is not supported by this route',
      'Existing PKI holder metadata is missing from the updated envelope',
      'This route supports adding exactly one holder at a time',
      'Added holder must have role backup or beneficiary',
      'Backup holders must belong to the acting member',
      'Beneficiary holders must belong to a different household member',
      'PKI uploads require at least one holder per file',
      'PKI holder must specify encryption_key_id',
      'PKI upload contains duplicate holder encryption_key_id values',
      'PKI holder must specify member_id',
      'PKI holder must specify key_fingerprint',
      'Multi-holder PKI uploads require holder-local wrapped_dek metadata for every holder',
      'PKI backup holders must belong to the uploading member',
      'PKI beneficiary holders must belong to a different member',
      'The primary PKI holder must belong to the uploading member',
      'PKI uploads must use the same primary encryption key for every file entry',
      'PKI uploads require a primary holder',
      'Only parent members may assign cross-member PKI holders',
      'PKI envelope requires a non-empty holders array for each file'
    ];
    const knownSafePrefixes = [
      'PKI holder role ',
      'Encryption key ',
      'Key fingerprint mismatch for encryption key ',
      'Existing PKI holder '
    ];
    if (knownSafe.includes(safeMessage) || knownSafePrefixes.some((prefix) => safeMessage.startsWith(prefix))) {
      return res.status(400).json({ error: safeMessage });
    }
    console.error('Unexpected PKI holder extension error:', err);
    res.status(500).json({ error: 'Unable to update PKI holders' });
  }
});

app.post('/api/documents/:id/pki-holders/replace', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!isEncryptedDocument(doc) || doc.encryption_mode !== 'pki') {
      return res.status(409).json({ error: 'Document is not PKI-encrypted' });
    }

    const body = req.body || {};
    const oldHolderKeyId = Number(body.old_holder_key_id);
    const newHolderKeyId = Number(body.new_holder_key_id);
    const encryptionMetadata = body.encryption_metadata && typeof body.encryption_metadata === 'object'
      ? body.encryption_metadata
      : null;
    if (!oldHolderKeyId) {
      return res.status(400).json({ error: 'old_holder_key_id is required' });
    }
    if (!newHolderKeyId) {
      return res.status(400).json({ error: 'new_holder_key_id is required' });
    }
    if (!encryptionMetadata) {
      return res.status(400).json({ error: 'encryption_metadata is required' });
    }

    const normalized = normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: encryptionMetadata });
    const existingEntry = doc.encryption_metadata?.files?.upload || {};
    const normalizedExistingHolders = normalizeStoredPkiHolders(existingEntry);
    const existingByKeyId = new Map(normalizedExistingHolders.map((holder) => [Number(holder.encryption_key_id), holder]));
    const oldHolder = existingByKeyId.get(oldHolderKeyId);
    if (!oldHolder) {
      return res.status(400).json({ error: 'old_holder_key_id is not an existing holder on this document' });
    }
    if (Number(oldHolder.member_id) !== Number(req.member.id)) {
      return res.status(400).json({ error: 'This route currently supports replacing your own revoked holder only' });
    }
    if (existingByKeyId.has(newHolderKeyId)) {
      return res.status(400).json({ error: 'new_holder_key_id is already enrolled on this document' });
    }

    const { rows: holderKeyRows } = await pool.query(
      `SELECT id, member_id, revoked_at
       FROM encryption_keys
       WHERE id = ANY($1::int[]) AND key_type = 'member'`,
      [[...new Set([...normalizedExistingHolders.map((holder) => Number(holder.encryption_key_id)), newHolderKeyId])]]
    );
    const holderKeysById = new Map(holderKeyRows.map((row) => [Number(row.id), row]));
    const oldHolderKeyRow = holderKeysById.get(oldHolderKeyId);
    if (!oldHolderKeyRow) {
      return res.status(400).json({ error: 'Existing holder key material is missing' });
    }
    if (!oldHolderKeyRow.revoked_at) {
      return res.status(400).json({ error: 'This route currently supports replacing revoked holders only' });
    }

    const existingHolderKeyIds = normalizedExistingHolders
      .map((holder) => Number(holder.encryption_key_id))
      .filter((keyId) => keyId !== oldHolderKeyId);
    await pki.validatePkiUpload(normalized.encryption_metadata, req.member.id, { existingHolderKeyIds });

    const updatedHolders = normalized.encryption_metadata?.files?.upload?.holders || [];
    const updatedByKeyId = new Map(updatedHolders.map((holder) => [Number(holder.encryption_key_id), holder]));
    if (updatedByKeyId.has(oldHolderKeyId)) {
      return res.status(400).json({ error: 'The replaced holder must be removed from the updated envelope' });
    }
    const newHolder = updatedByKeyId.get(newHolderKeyId);
    if (!newHolder) {
      return res.status(400).json({ error: 'The replacement holder must be present in the updated envelope' });
    }
    if (updatedHolders.length !== normalizedExistingHolders.length) {
      return res.status(400).json({ error: 'This route supports replacing exactly one holder at a time' });
    }
    if (Number(newHolder.member_id) !== Number(req.member.id)) {
      return res.status(400).json({ error: 'This route currently supports same-member replacement only' });
    }
    if (String(newHolder.role || '') !== String(oldHolder.role || '')) {
      return res.status(400).json({ error: 'Replacement holder must inherit the replaced holder role' });
    }

    const updated = await updatePkiDocumentAccess(doc.id, {
      encryptionMetadata: normalized.encryption_metadata,
      encryptionKeyId: choosePrimaryHolderKeyId(updatedHolders, doc.encryption_key_id, holderKeysById),
      validate: async (lockedDoc) => {
        const lockedEntry = lockedDoc.encryption_metadata?.files?.upload || {};
        const normalizedLockedHolders = normalizeStoredPkiHolders(lockedEntry);
        const lockedByKeyId = new Map(normalizedLockedHolders.map((holder) => [Number(holder.encryption_key_id), holder]));

        for (const existingHolder of normalizedLockedHolders) {
          const keyId = Number(existingHolder.encryption_key_id);
          if (keyId === oldHolderKeyId) continue;
          const updatedHolder = updatedByKeyId.get(keyId);
          if (!updatedHolder) {
            throw new Error('Unchanged PKI holder metadata is missing from the updated envelope');
          }
          if (holderIntegrityChanged(updatedHolder, existingHolder)) {
            throw new Error(`Existing PKI holder ${keyId} cannot be modified by the replace-holder route`);
          }
        }

        if (!lockedByKeyId.has(oldHolderKeyId)) {
          throw new Error('The replaced holder no longer exists on this document');
        }
      }
    });
    if (!updated) return res.status(404).json({ error: 'Document not found' });

    await audit.log('document.pki_holder_replaced', 'document', doc.id, req.member.id, {
      removed_holder_member_id: Number(oldHolder.member_id),
      removed_holder_key_id: oldHolderKeyId,
      role: oldHolder.role,
      replacement_holder_member_id: Number(newHolder.member_id),
      replacement_holder_key_id: newHolderKeyId,
      holder_count_before: normalizedExistingHolders.length,
      holder_count_after: updatedHolders.length,
      old_primary_pointer: Number(doc.encryption_key_id || 0) || null,
      new_primary_pointer: Number(updated.encryption_key_id || 0) || null
    });
    res.json({ ok: true, document: updated });
  } catch (err) {
    const safeMessage = String(err?.message || 'Unable to replace PKI holder');
    const knownSafe = [
      'Document not found',
      'Access denied',
      'Document is not PKI-encrypted',
      'old_holder_key_id is required',
      'new_holder_key_id is required',
      'encryption_metadata is required',
      'old_holder_key_id is not an existing holder on this document',
      'This route currently supports replacing your own revoked holder only',
      'new_holder_key_id is already enrolled on this document',
      'Existing holder key material is missing',
      'This route currently supports replacing revoked holders only',
      'The replaced holder must be removed from the updated envelope',
      'The replacement holder must be present in the updated envelope',
      'This route supports replacing exactly one holder at a time',
      'This route currently supports same-member replacement only',
      'Replacement holder must inherit the replaced holder role',
      'Unchanged PKI holder metadata is missing from the updated envelope',
      'The replaced holder no longer exists on this document',
      'PKI uploads require at least one holder per file',
      'PKI holder must specify encryption_key_id',
      'PKI upload contains duplicate holder encryption_key_id values',
      'PKI holder must specify member_id',
      'PKI holder must specify key_fingerprint',
      'Multi-holder PKI uploads require holder-local wrapped_dek metadata for every holder',
      'PKI backup holders must belong to the uploading member',
      'PKI beneficiary holders must belong to a different member',
      'The primary PKI holder must belong to the uploading member',
      'PKI uploads must use the same primary encryption key for every file entry',
      'PKI uploads require a primary holder',
      'Only parent members may assign cross-member PKI holders',
      'PKI envelope requires a non-empty holders array for each file'
    ];
    const knownSafePrefixes = [
      'PKI holder role ',
      'Encryption key ',
      'Key fingerprint mismatch for encryption key ',
      'Existing PKI holder '
    ];
    if (knownSafe.includes(safeMessage) || knownSafePrefixes.some((prefix) => safeMessage.startsWith(prefix))) {
      return res.status(400).json({ error: safeMessage });
    }
    console.error('Unexpected PKI holder replacement error:', err);
    res.status(500).json({ error: 'Unable to replace PKI holder' });
  }
});

app.post('/api/documents/:id/pki-holders/remove', requireAuth, requireParent, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!isEncryptedDocument(doc) || doc.encryption_mode !== 'pki') {
      return res.status(409).json({ error: 'Document is not PKI-encrypted' });
    }

    const body = req.body || {};
    const removeHolderKeyId = Number(body.remove_holder_key_id);
    const encryptionMetadata = body.encryption_metadata && typeof body.encryption_metadata === 'object'
      ? body.encryption_metadata
      : null;
    if (!removeHolderKeyId) {
      return res.status(400).json({ error: 'remove_holder_key_id is required' });
    }
    if (!encryptionMetadata) {
      return res.status(400).json({ error: 'encryption_metadata is required' });
    }

    const existingEntry = doc.encryption_metadata?.files?.upload || {};
    const normalizedExistingHolders = normalizeStoredPkiHolders(existingEntry);
    const existingByKeyId = new Map(normalizedExistingHolders.map((holder) => [Number(holder.encryption_key_id), holder]));
    const removeHolder = existingByKeyId.get(removeHolderKeyId);
    if (!removeHolder) {
      return res.status(400).json({ error: 'remove_holder_key_id is not an existing holder on this document' });
    }

    const { rows: holderKeyRows } = await pool.query(
      `SELECT id, member_id, revoked_at
       FROM encryption_keys
       WHERE id = ANY($1::int[]) AND key_type = 'member'`,
      [[...new Set(normalizedExistingHolders.map((holder) => Number(holder.encryption_key_id)))]]
    );
    const holderKeysById = new Map(holderKeyRows.map((row) => [Number(row.id), row]));
    const removeHolderKeyRow = holderKeysById.get(removeHolderKeyId);
    if (!removeHolderKeyRow) {
      return res.status(400).json({ error: 'Existing holder key material is missing' });
    }
    if (!removeHolderKeyRow.revoked_at) {
      return res.status(400).json({ error: 'This route currently supports removing revoked holders only' });
    }

    const normalized = normalizeEncryptionInput({ encryption_mode: 'pki', encryption_metadata: encryptionMetadata });
    const updatedHolders = normalized.encryption_metadata?.files?.upload?.holders || [];
    const updatedByKeyId = new Map(updatedHolders.map((holder) => [Number(holder.encryption_key_id), holder]));
    if (updatedByKeyId.has(removeHolderKeyId)) {
      return res.status(400).json({ error: 'The removed holder must be absent from the updated envelope' });
    }
    const addedHolders = updatedHolders.filter((holder) => !existingByKeyId.has(Number(holder.encryption_key_id)));
    if (addedHolders.length !== 0) {
      return res.status(400).json({ error: 'This route does not allow adding replacement holders' });
    }
    if (updatedHolders.length !== normalizedExistingHolders.length - 1) {
      return res.status(400).json({ error: 'This route supports removing exactly one holder at a time' });
    }
    if (!updatedHolders.length) {
      return res.status(400).json({ error: 'Cannot remove the final PKI holder from the document' });
    }

    const remainingActiveCount = updatedHolders.filter((holder) => {
      const row = holderKeysById.get(Number(holder.encryption_key_id));
      return row && !row.revoked_at;
    }).length;
    if (remainingActiveCount === 0) {
      return res.status(400).json({ error: 'Removing this holder would leave the document without any active unlock holders' });
    }

    const updated = await updatePkiDocumentAccess(doc.id, {
      encryptionMetadata: normalized.encryption_metadata,
      encryptionKeyId: choosePrimaryHolderKeyId(updatedHolders, doc.encryption_key_id, holderKeysById),
      validate: async (lockedDoc) => {
        const lockedEntry = lockedDoc.encryption_metadata?.files?.upload || {};
        const normalizedLockedHolders = normalizeStoredPkiHolders(lockedEntry);
        const lockedByKeyId = new Map(normalizedLockedHolders.map((holder) => [Number(holder.encryption_key_id), holder]));

        for (const existingHolder of normalizedLockedHolders) {
          const keyId = Number(existingHolder.encryption_key_id);
          if (keyId === removeHolderKeyId) continue;
          const updatedHolder = updatedByKeyId.get(keyId);
          if (!updatedHolder) {
            throw new Error('Unchanged PKI holder metadata is missing from the updated envelope');
          }
          if (holderIntegrityChanged(updatedHolder, existingHolder)) {
            throw new Error(`Existing PKI holder ${keyId} cannot be modified by the remove-holder route`);
          }
        }

        if (!lockedByKeyId.has(removeHolderKeyId)) {
          throw new Error('The removed holder no longer exists on this document');
        }
      }
    });
    if (!updated) return res.status(404).json({ error: 'Document not found' });

    await audit.log('document.pki_holder_removed', 'document', doc.id, req.member.id, {
      removed_holder_member_id: Number(removeHolder.member_id),
      removed_holder_key_id: removeHolderKeyId,
      role: removeHolder.role,
      holder_count_before: normalizedExistingHolders.length,
      holder_count_after: updatedHolders.length,
      old_primary_pointer: Number(doc.encryption_key_id || 0) || null,
      new_primary_pointer: Number(updated.encryption_key_id || 0) || null
    });
    res.json({ ok: true, document: updated });
  } catch (err) {
    const safeMessage = String(err?.message || 'Unable to remove PKI holder');
    const knownSafe = [
      'Document not found',
      'Access denied',
      'Document is not PKI-encrypted',
      'remove_holder_key_id is required',
      'encryption_metadata is required',
      'remove_holder_key_id is not an existing holder on this document',
      'Existing holder key material is missing',
      'This route currently supports removing revoked holders only',
      'The removed holder must be absent from the updated envelope',
      'This route supports removing exactly one holder at a time',
      'This route does not allow adding replacement holders',
      'Cannot remove the final PKI holder from the document',
      'Removing this holder would leave the document without any active unlock holders',
      'Unchanged PKI holder metadata is missing from the updated envelope',
      'The removed holder no longer exists on this document',
      'PKI uploads require at least one holder per file',
      'PKI holder must specify encryption_key_id',
      'PKI upload contains duplicate holder encryption_key_id values',
      'PKI holder must specify member_id',
      'PKI holder must specify key_fingerprint',
      'Multi-holder PKI uploads require holder-local wrapped_dek metadata for every holder',
      'PKI envelope requires a non-empty holders array for each file'
    ];
    const knownSafePrefixes = [
      'PKI holder role ',
      'Encryption key ',
      'Key fingerprint mismatch for encryption key ',
      'Existing PKI holder '
    ];
    if (knownSafe.includes(safeMessage) || knownSafePrefixes.some((prefix) => safeMessage.startsWith(prefix))) {
      return res.status(400).json({ error: safeMessage });
    }
    console.error('Unexpected PKI holder removal error:', err);
    res.status(500).json({ error: 'Unable to remove PKI holder' });
  }
});

// ── Document files ──────────────────────────────────────────────────────────

app.post('/api/documents/:id/files', requireAuth, async (req, res) => {
  try {
    if (req.member.role === 'kid') return res.status(403).json({ error: 'Parent access required' });
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (isEncryptedDocument(doc)) return res.status(409).json({ error: 'Adding files is unavailable for encrypted documents in v1' });
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
    const docId = Number(req.params.id);
    if (!(await canMemberAccessDocument(docId, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await pool.query(
      'SELECT df.* FROM document_files df WHERE df.id = $1 AND df.document_id = $2',
      [req.params.fileId, docId]
    );
    const file = rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = getFilePath(file.stored_filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    await audit.log('document.downloaded', 'document', docId, req.member.id, { file_id: file.id });
    allowSelfFraming(res);
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
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (isEncryptedDocument(doc)) return res.status(409).json({ error: 'Share links are unavailable for encrypted documents in v1' });
    const link = await createShareLink(req.params.id, req.member.id, req.body);
    await audit.log('share.created', 'share_link', link.id, req.member.id, { document_id: Number(req.params.id) });
    res.status(201).json(link);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/documents/:id/shares', requireAuth, async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!(await canMemberAccessDocument(doc.id, req.member))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(await listShareLinks(req.params.id));
  }
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

    allowSelfFraming(res);
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
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/links', requireAuth, requireParent, async (req, res) => {
  try {
    res.json(await magicLinks.listLinks(req.query));
  } catch (err) { res.status(400).json({ error: err.message }); }
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
    const isKid = req.member.role === 'kid';
    const ownerJoin = isKid ? 'JOIN document_owners do2 ON do2.document_id = d.id AND do2.member_id = $1' : '';
    const ownerParams = isKid ? [req.member.id] : [];
    const tasks = [
      pool.query(`SELECT COUNT(*)::int AS total FROM documents d ${ownerJoin} WHERE d.status = 'active'`, ownerParams),
      pool.query(`SELECT d.document_type, COUNT(*)::int AS count FROM documents d ${ownerJoin} WHERE d.status = 'active' GROUP BY d.document_type ORDER BY count DESC`, ownerParams),
      pool.query(`SELECT d.id, d.title, d.document_type, d.created_at FROM documents d ${ownerJoin} WHERE d.status = 'active' ORDER BY d.created_at DESC LIMIT 5`, ownerParams),
      pool.query(`SELECT d.id, d.title, d.document_type, d.expiry_date FROM documents d ${ownerJoin} WHERE d.status = 'active' AND d.expiry_date IS NOT NULL AND d.expiry_date <= NOW() + INTERVAL '90 days' ORDER BY d.expiry_date ASC LIMIT 10`, ownerParams),
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

const _cleanupInterval = setInterval(() => {
  cleanExpiredSessions().catch(() => {});
  webauthn.cleanExpiredChallenges().catch(() => {});
}, 60 * 60 * 1000);
if (process.env.NODE_ENV === 'test') _cleanupInterval.unref();

// ── Start ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Home Source listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
