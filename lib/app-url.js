'use strict';

function appBaseUrl(env = process.env) {
  const configured = String(env.APP_URL || '').trim();
  if (!configured) throw new Error('APP_URL is required');
  let base;
  try {
    base = new URL(configured);
  } catch {
    throw new Error('APP_URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('APP_URL must be an absolute http(s) URL');
  }
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if (base.protocol !== 'https:' && !localHost) {
    throw new Error('APP_URL must use HTTPS except on localhost');
  }
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}

function buildAppUrl(page, { env = process.env, token = null } = {}) {
  const relativePage = String(page || '').replace(/^\/+/, '');
  if (!relativePage) throw new TypeError('Application page is required');
  const result = new URL(relativePage, appBaseUrl(env));
  if (token !== null) result.searchParams.set('token', String(token));
  return result.toString();
}

function tryBuildAppUrl(page, options = {}) {
  try { return buildAppUrl(page, options); } catch { return null; }
}

module.exports = { appBaseUrl, buildAppUrl, tryBuildAppUrl };
