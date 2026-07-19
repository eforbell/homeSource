'use strict';

const crypto = require('node:crypto');

function normalizeBrrrTarget(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) throw new TypeError('A brrr secret or webhook URL is required');
  const value = /^https?:\/\//i.test(raw) ? raw : `https://api.brrr.now/v1/${raw}`;
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('brrr target is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.brrr.now') {
    throw new TypeError('brrr targets must use https://api.brrr.now');
  }
  if (!parsed.pathname.startsWith('/v1/') || parsed.pathname.length < 16 || parsed.search || parsed.hash) {
    throw new TypeError('brrr target is invalid');
  }
  return parsed.toString();
}

function maskSecret(secretOrUrl) {
  if (!secretOrUrl) return '';
  const normalized = normalizeBrrrTarget(secretOrUrl);
  const secret = normalized.split('/').filter(Boolean).pop() || '';
  return secret.length <= 4 ? 'saved' : `••••${secret.slice(-4)}`;
}

function fingerprintTarget(secretOrUrl) {
  return crypto.createHash('sha256').update(normalizeBrrrTarget(secretOrUrl)).digest('hex');
}

async function sendBrrrNotification(secretOrUrl, payload, { fetchImpl = fetch } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('brrr payload is required');
  const response = await fetchImpl(normalizeBrrrTarget(secretOrUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const error = new Error(`brrr send failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

module.exports = { normalizeBrrrTarget, maskSecret, fingerprintTarget, sendBrrrNotification };
