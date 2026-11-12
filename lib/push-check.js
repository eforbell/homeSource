'use strict';

// Kept local so this app remains independently deployable. This is NOT a delivery test:
// /v1/check only confirms that the configured gateway recognizes a secret and has a route.
const result = (status, message, extra = {}) => ({ status, message, ...extra });

async function checkPushSecret(target, { baseUrl = process.env.PUSH_BASE_URL,
  fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!target) return result('unconfigured', 'No push secret saved.');
  let base, secret;
  try {
    const rawBase = baseUrl === undefined || baseUrl === null || baseUrl === ''
      ? 'https://api.brrr.now' : String(baseUrl).trim();
    base = new URL(rawBase);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || /[?#]/.test(rawBase)) throw new Error();
    const prefix = `${base.href.replace(/\/+$/, '')}/v1/`;
    const raw = String(target).trim();
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (url.username || url.password || /[?#\s]/.test(raw) || !url.href.startsWith(prefix)) throw new Error();
      secret = url.href.slice(prefix.length).replace(/\/$/, '');
    } else secret = raw;
    if (!/^[A-Za-z0-9_-]+$/.test(secret) || ['send', 'check'].includes(secret)) throw new Error();
  } catch {
    return result('failed', 'Push configuration is invalid or belongs to a different service. Save a secret from the configured service.');
  }
  if (base.hostname === 'brrr.now' || base.hostname.endsWith('.brrr.now')) {
    return result('unsupported', 'Not verified: this push service does not support silent verification.');
  }
  try {
    const response = await fetchImpl(`${base.href.replace(/\/+$/, '')}/v1/check`, {
      method: 'GET', headers: { Authorization: `Bearer ${secret}` },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if ([404, 405, 501].includes(response.status)) return result('unsupported', 'Not verified: this push service does not support silent verification.');
    if ([401, 403].includes(response.status)) return result('failed', 'Not verified: the gateway rejected this secret. Copy a current device or person secret from homePush.');
    if (response.status === 410) return result('failed', 'Not verified: this secret has no active devices. Re-enroll a device in homePush.');
    if (response.status === 502) return result('failed', 'Not verified: the gateway has no usable APNs key for these devices, or is unavailable.');
    if (response.status !== 200) return result('failed', 'Not verified: the push gateway could not complete the check. Try again later.');
    const body = await response.json();
    if (body?.ok !== true || !['device', 'person'].includes(body.kind) ||
        !Number.isInteger(body.active) || !Number.isInteger(body.reachable) ||
        body.reachable < 1 || body.active < body.reachable) {
      return result('failed', 'Not verified: the gateway returned an unexpected check response.');
    }
    return result('verified', `homePush secret verified: gateway ready for ${body.reachable} device(s). No notification sent; phone delivery is not tested.`, { reachable: body.reachable });
  } catch {
    // Never echo upstream bodies, URLs, or exceptions: they may contain a secret.
    return result('failed', 'Not verified: could not reach the push check endpoint. Check the gateway connection and try again.');
  }
}

module.exports = { checkPushSecret };
