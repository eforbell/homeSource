'use strict';

const crypto = require('crypto');
const { pool } = require('./db');
const { hashPassphrase, verifyPassphrase } = require('./auth');
const { isEncryptedDocument } = require('./encryption-mode');

async function createShareLink(documentId, createdBy, options = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const pinHash = options.pin ? hashPassphrase(options.pin) : null;

  const { rows } = await pool.query(`
    INSERT INTO share_links (document_id, token, created_by, access_level, pin_hash, expires_at, max_uses)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    documentId, token, createdBy,
    options.access_level || 'view',
    pinHash,
    options.expires_at || null,
    options.max_uses || null
  ]);
  return rows[0];
}

async function getShareLink(token) {
  const { rows } = await pool.query(`
    SELECT sl.*, d.title AS document_title, d.document_type, d.status AS document_status, d.is_encrypted, d.encryption_mode
    FROM share_links sl
    JOIN documents d ON sl.document_id = d.id
    WHERE sl.token = $1
  `, [token]);

  const link = rows[0];
  if (!link) return null;
  if (link.document_status === 'archived') return null;
  if (isEncryptedDocument(link)) return null;
  if (link.expires_at && new Date(link.expires_at) < new Date()) return null;
  if (link.max_uses && link.use_count >= link.max_uses) return null;

  return link;
}

async function validateSharePin(token, pin) {
  const { rows } = await pool.query('SELECT pin_hash FROM share_links WHERE token = $1', [token]);
  if (!rows[0]) return false;
  if (!rows[0].pin_hash) return true;
  return verifyPassphrase(pin, rows[0].pin_hash);
}

// A PIN-protected link's files open only with proof that the PIN was entered: /verify hands the page a value that
// names this link and its current PIN and lapses after DOWNLOAD_PROOF_SECONDS, and the page adds it to its file
// addresses (an iframe or a download link can't carry a header). The key lives only in this process, so after a
// restart the PIN is asked for again; changing the PIN, or another link, makes a proof worthless. The PIN itself is
// never in it.
const DOWNLOAD_PROOF_SECONDS = 30 * 60;
const downloadProofKey = crypto.randomBytes(32);

function downloadProofMac(link, expires) {
  return crypto.createHmac('sha256', downloadProofKey)
    .update(`share-download\n${link.id}\n${link.token}\n${link.pin_hash}\n${expires}`)
    .digest('base64url');
}

function createDownloadProof(link, now = Date.now()) {
  const expires = Math.floor(now / 1000) + DOWNLOAD_PROOF_SECONDS;
  return `${expires}.${downloadProofMac(link, expires)}`;
}

// A link without a PIN needs no proof, as before.
function hasDownloadProof(link, proof, now = Date.now()) {
  if (!link.pin_hash) return true;
  const match = /^([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/.exec(typeof proof === 'string' ? proof : '');
  if (!match) return false;
  const expires = Number(match[1]);
  const seconds = Math.floor(now / 1000);
  if (expires <= seconds || expires > seconds + DOWNLOAD_PROOF_SECONDS) return false;
  return crypto.timingSafeEqual(Buffer.from(downloadProofMac(link, expires)), Buffer.from(match[2]));
}

async function incrementUseCount(token) {
  await pool.query('UPDATE share_links SET use_count = use_count + 1 WHERE token = $1', [token]);
}

async function listShareLinks(documentId) {
  const { rows } = await pool.query(
    'SELECT sl.*, m.name AS created_by_name FROM share_links sl JOIN family_members m ON sl.created_by = m.id WHERE sl.document_id = $1 ORDER BY sl.created_at DESC',
    [documentId]
  );
  return rows;
}

async function revokeShareLink(id, memberId) {
  const { rowCount } = await pool.query(
    'DELETE FROM share_links WHERE id = $1 AND created_by = $2',
    [id, memberId]
  );
  return rowCount > 0;
}

module.exports = { DOWNLOAD_PROOF_SECONDS, createShareLink, getShareLink, validateSharePin, incrementUseCount, listShareLinks, revokeShareLink, createDownloadProof, hasDownloadProof };
