'use strict';

const crypto = require('crypto');
const { pool } = require('./db');

const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

function hashPassphrase(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassphrase(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

async function createSession(memberId) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)',
    [token, memberId, expiresAt]
  );
  return { token, expiresAt };
}

async function validateSession(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.token, s.expires_at, m.id, m.name, m.role, m.avatar_emoji
     FROM sessions s JOIN family_members m ON s.member_id = m.id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

async function destroySession(token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function cleanExpiredSessions() {
  const { rowCount } = await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  return rowCount;
}

async function authEnabled() {
  const { rows } = await pool.query(
    'SELECT 1 FROM family_members WHERE passphrase_hash IS NOT NULL LIMIT 1'
  );
  return rows.length > 0;
}

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(';').find(c => c.trim().startsWith(name + '='));
  return match ? match.split('=')[1].trim() : null;
}

function requireAuth(req, res, next) {
  if (!req.member) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireParent(req, res, next) {
  if (!req.member) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.member.role !== 'parent') {
    return res.status(403).json({ error: 'Parent access required' });
  }
  next();
}

module.exports = {
  hashPassphrase,
  verifyPassphrase,
  createSession,
  validateSession,
  destroySession,
  cleanExpiredSessions,
  authEnabled,
  parseCookie,
  requireAuth,
  requireParent,
  SESSION_DAYS
};
