'use strict';

const crypto = require('node:crypto');

// The one brrr-compatible push service this install sends through (PUSH_BASE_URL, default brrr). A malformed
// value is an error, not a fallback: falling back would send a self-hosted service's secrets to brrr.
const DEFAULT_PUSH_BASE_URL = 'https://api.brrr.now';

function pushBaseUrl(value = process.env.PUSH_BASE_URL) {
  if (value === undefined || value === null || value === '') return DEFAULT_PUSH_BASE_URL;
  const raw = String(value).trim();
  let url;
  try { url = new URL(raw); } catch { throw new TypeError('PUSH_BASE_URL is not a valid URL'); }
  // Checks raw, not url.search and url.hash: those are empty for a URL ending in a bare "?" or "#".
  if (!['http:', 'https:'].includes(url.protocol) || /[?#]/.test(raw) || url.username || url.password) {
    throw new TypeError('PUSH_BASE_URL must be a plain http(s) URL');
  }
  return url.href.replace(/\/+$/, '');
}

const MIN_SECRET_LENGTH = 12;

function normalizeBrrrTarget(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) throw new TypeError('A brrr secret or webhook URL is required');
  const prefix = `${pushBaseUrl()}/v1/`;
  const isUrl = /^https?:\/\//i.test(raw);
  if (!isUrl && !/^[A-Za-z0-9_-]+$/.test(raw)) throw new TypeError('brrr target is invalid');
  const value = isUrl ? raw : `${prefix}${raw}`;
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('brrr target is invalid'); }
  if (!parsed.href.startsWith(prefix)) {
    throw new TypeError('This push target is for a different push service. Save a new secret from the current one.');
  }
  if (parsed.pathname.length - new URL(prefix).pathname.length < MIN_SECRET_LENGTH || parsed.search || parsed.hash) {
    throw new TypeError('brrr target is invalid');
  }
  return parsed.toString();
}

// False for a saved target that would be refused at send time, e.g. one saved before PUSH_BASE_URL changed.
function isCurrentTarget(target) {
  try {
    normalizeBrrrTarget(target);
    return true;
  } catch {
    return false;
  }
}

// Doesn't validate: a target saved for a previous service must still display, so its owner can replace it.
function maskSecret(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) return '';
  const secret = raw.split('/').filter(Boolean).pop() || '';
  return secret.length <= 4 ? 'saved' : `••••${secret.slice(-4)}`;
}

function fingerprintTarget(secretOrUrl) {
  return crypto.createHash('sha256').update(normalizeBrrrTarget(secretOrUrl)).digest('hex');
}

// BRRR_ICON_URL replaces the brrr icon on iPhone/iPad. brrr fetches it from outside
// the tailnet, so it must be a public https URL (e.g. a CDN). brrr hides subtitles
// when a custom icon is set.
function withIconUrl(payload, iconUrl = process.env.BRRR_ICON_URL) {
  const raw = String(iconUrl || '').trim();
  if (payload.icon_url || !raw) return payload;
  let parsed;
  try { parsed = new URL(raw); } catch { return payload; }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return payload;
  return { ...payload, icon_url: parsed.toString() };
}

async function sendBrrrNotification(secretOrUrl, payload, { fetchImpl = fetch, iconUrl } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('brrr payload is required');
  const response = await fetchImpl(normalizeBrrrTarget(secretOrUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withIconUrl(payload, iconUrl)),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const error = new Error(`brrr send failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

module.exports = { pushBaseUrl, normalizeBrrrTarget, isCurrentTarget, maskSecret, fingerprintTarget, sendBrrrNotification, withIconUrl };
