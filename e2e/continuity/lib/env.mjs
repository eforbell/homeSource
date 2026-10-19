// Test-machine plumbing for the continuity acceptance drill: the gateway, the inboxes, the host
// container, and browsers. Nothing here knows the continuity domain; see ceremonies.mjs and
// acceptance.mjs for that.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const CONFIG = {
  appUrl: 'https://localhost/source/',
  mailpitUrl: process.env.HS_E2E_MAILPIT || 'http://127.0.0.1:8025',
  container: process.env.HS_E2E_CONTAINER || 'hs-host',
  mailpitContainer: 'hs-mailpit',
  network: 'hs-e2e',
  appDir: '/opt/sovereign-home/apps/homeSource',
  timezone: 'America/New_York'
};

// ── Redaction ────────────────────────────────────────────────────────────────

// Every bearer the drill sees is registered here so evidence files never contain one.
const secrets = new Set();
export function rememberSecret(value) {
  if (value && String(value).length >= 8) secrets.add(String(value));
  return value;
}
export function knownSecrets() { return [...secrets]; }
export function redact(text) {
  let out = String(text ?? '');
  out = out.replace(/([?&]token=)[A-Za-z0-9_\-%.]+/g, '$1<redacted>');
  for (const secret of secrets) out = out.split(secret).join('<redacted>');
  return out;
}

// ── Shell and host container ────────────────────────────────────────────────

export function run(cmd, args, { input, allowFail = false, timeout = 600_000 } = {}) {
  const result = spawnSync(cmd, args, { input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed (${result.status}): ${redact(result.stderr || result.stdout).slice(-2000)}`);
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export function hostSh(script, opts = {}) {
  return run('docker', ['exec', '-i', CONFIG.container, 'bash', '-s'], { ...opts, input: script });
}

// Read-only PostgreSQL inspection, as the runbook's psql examples do. Returns parsed rows.
export function sql(query, params = []) {
  const literal = (value) => value === null || value === undefined
    ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
  const bound = query.replace(/\$(\d+)/g, (_m, n) => literal(params[Number(n) - 1]));
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${bound}) t;`;
  const { stdout } = run('docker', ['exec', '-i', CONFIG.container, 'sudo', '-u', 'postgres',
    'psql', '-d', 'homesource', '-AtX', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: wrapped });
  return JSON.parse(stdout.trim() || '[]');
}
export const sqlOne = (query, params) => sql(query, params)[0] || null;

// The runbook §8 accelerated simulation driver, verbatim, run in the Homebase-managed checkout
// as the service user with the same environment the units use.
const SIMULATION_DRIVER = `require('dotenv').config();
const { advanceDueSwitches, dispatchOutbox } = require('./lib/continuity');
const { pool } = require('./lib/db');
const at = new Date(process.env.SIMULATED_AT);
if (!Number.isFinite(at.getTime())) throw new Error('SIMULATED_AT must be an ISO-8601 timestamp');
(async () => {
  try {
    console.log(JSON.stringify({ at: at.toISOString(), state: await advanceDueSwitches({ now: at }) }));
    console.log(JSON.stringify({ at: at.toISOString(), outbox: await dispatchOutbox({ now: at }) }));
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

export function simulateAt(at) {
  const iso = new Date(at).toISOString();
  const { stdout } = run('docker', ['exec', '-i', '-u', 'sovereign', '-w', CONFIG.appDir,
    '-e', `SIMULATED_AT=${iso}`, '-e', `TZ=${CONFIG.timezone}`, CONFIG.container, 'node', '-'],
  { input: SIMULATION_DRIVER });
  // The dispatcher's mailer also logs multi-line objects; keep only the driver's own lines.
  const lines = stdout.split('\n').filter((line) => line.startsWith('{"at":')).map((line) => JSON.parse(line));
  return { at: iso, state: lines.find((l) => l.state)?.state, outbox: lines.find((l) => l.outbox)?.outbox, log: redact(stdout) };
}

export function systemctl(...args) {
  return hostSh(`systemctl ${args.join(' ')}`, { allowFail: true });
}

export function startUnitAndJournal(unit) {
  const cursor = hostSh(`journalctl -u ${unit} -n 0 --show-cursor --no-pager | sed -n 's/^-- cursor: //p'`).stdout.trim();
  const started = systemctl('start', unit);
  const journal = hostSh(`journalctl -u ${unit} --no-pager ${cursor ? `--after-cursor='${cursor}'` : '-n 50'}`).stdout;
  return { exit: started.status, journal };
}

// Deny or restore the SMTP relay without touching Home Source state (runbook §12.4).
export function setRelayReachable(reachable) {
  if (reachable) {
    run('docker', ['network', 'connect', '--alias', 'mailpit', CONFIG.network, CONFIG.mailpitContainer], { allowFail: true });
  } else {
    run('docker', ['network', 'disconnect', CONFIG.network, CONFIG.mailpitContainer], { allowFail: true });
  }
}

// ── Gateway HTTP (TLS to the self-signed Homebase gateway, IPv4 loopback) ───

export function request(method, urlPath, { headers = {}, body, cookie } = {}) {
  const target = new URL(urlPath, CONFIG.appUrl);
  const payload = body === undefined ? undefined
    : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const finalHeaders = { ...headers };
  if (payload && !finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json';
  if (payload) finalHeaders['content-length'] = payload.length;
  if (cookie) finalHeaders.cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method, hostname: target.hostname, port: target.port || 443, path: target.pathname + target.search,
      headers: finalHeaders, family: 4, rejectUnauthorized: false, servername: 'localhost'
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode, headers: res.headers, buffer,
          text: () => buffer.toString('utf8'),
          json: () => { try { return JSON.parse(buffer.toString('utf8')); } catch { return null; } }
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class AppSession {
  constructor(label) { this.label = label; this.cookie = null; this.member = null; }

  async login(name, passphrase) {
    const res = await request('POST', 'api/auth/login', { body: { name, passphrase } });
    if (res.status !== 200) throw new Error(`login ${name} failed: ${res.status} ${res.text()}`);
    const match = String(res.headers['set-cookie'] || '').match(/hs_session=([^;]+)/);
    this.cookie = `hs_session=${match[1]}`;
    rememberSecret(match[1]);
    this.member = res.json().member;
    return this;
  }

  async call(method, urlPath, body, { expect = [200, 201] } = {}) {
    const res = await request(method, urlPath, { body, cookie: this.cookie });
    if (expect && !expect.includes(res.status)) {
      throw new Error(`${this.label} ${method} ${urlPath} -> ${res.status}: ${res.text().slice(0, 400)}`);
    }
    return res.json();
  }
  get(p, opts) { return this.call('GET', p, undefined, opts); }
  post(p, body = {}, opts) { return this.call('POST', p, body, opts); }
  put(p, body = {}, opts) { return this.call('PUT', p, body, opts); }
  del(p, opts) { return this.call('DELETE', p, undefined, opts); }
  raw(method, p, body) { return request(method, p, { body, cookie: this.cookie }); }

  // Same form fields as public/api.js API.upload: one file part plus a JSON metadata part.
  async upload(urlPath, { filename, mime, bytes }, metadata) {
    const boundary = `----hs-e2e-${crypto.randomBytes(8).toString('hex')}`;
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}--\r\n`)
    ];
    const res = await request('POST', urlPath, {
      body: Buffer.concat(parts), cookie: this.cookie,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
    });
    if (![200, 201].includes(res.status)) throw new Error(`upload ${filename} -> ${res.status}: ${res.text().slice(0, 400)}`);
    return res.json();
  }
}

// ── Mailpit inboxes ──────────────────────────────────────────────────────────

const consumedMail = new Set();

async function mailpit(method, p) {
  const res = await fetch(new URL(p, CONFIG.mailpitUrl), { method });
  if (!res.ok) throw new Error(`mailpit ${method} ${p} -> ${res.status}`);
  return method === 'DELETE' ? null : res.json();
}

export async function clearMailboxes() { await mailpit('DELETE', '/api/v1/messages'); consumedMail.clear(); }

export async function listMail() {
  const { messages } = await mailpit('GET', '/api/v1/messages?limit=1000');
  return messages.map((m) => ({ id: m.ID, to: m.To.map((t) => t.Address.toLowerCase()), subject: m.Subject, created: m.Created }));
}

export async function mailTo(address) {
  return (await listMail()).filter((m) => m.to.includes(address.toLowerCase()));
}

// Wait for the next not-yet-consumed message to `to` whose subject matches.
export async function waitForMail({ to, subject, timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await mailTo(to))
      .filter((m) => !consumedMail.has(m.id) && (!subject || subject.test(m.subject)))
      .sort((a, b) => a.created.localeCompare(b.created))[0];
    if (match) {
      consumedMail.add(match.id);
      const full = await mailpit('GET', `/api/v1/message/${match.id}`);
      return { id: match.id, to: match.to, subject: full.Subject, text: full.Text || '', date: full.Date, raw: full };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no mail to ${to} matching ${subject} within ${timeoutMs}ms`);
}

// Extract the one link to `page` from a message body and remember its token as a secret.
export function linkFrom(message, page) {
  const match = message.text.match(new RegExp(`https?://[^\\s]+/${page.replace('.', '\\.')}\\?token=[A-Za-z0-9_\\-%]+`));
  if (!match) throw new Error(`no ${page} link in "${message.subject}"`);
  const url = new URL(match[0]);
  rememberSecret(url.searchParams.get('token'));
  return { url: match[0], token: url.searchParams.get('token'), origin: url.origin, pathname: url.pathname };
}

// ── Browsers ─────────────────────────────────────────────────────────────────

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE_PATH, path.join(REPO, 'package.json'),
    path.join(REPO, '..', 'package.json')].filter(Boolean);
  for (const candidate of candidates) {
    try { return createRequire(candidate)('playwright-core'); } catch { /* next */ }
  }
  throw new Error('playwright-core is not resolvable; set PLAYWRIGHT_CORE_PATH to a package.json beside it');
}

export function gatewaySpki() {
  const pem = run('bash', ['-c', 'echo | openssl s_client -connect 127.0.0.1:443 -servername localhost 2>/dev/null | openssl x509 -pubkey -noout']).stdout;
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64');
}

export async function launchBrowser() {
  const { chromium } = loadPlaywright();
  // Trust exactly the gateway's key (not "ignore errors"): WebAuthn refuses origins with
  // certificate errors. localhost is pinned to IPv4 because the gateway is published there only.
  return chromium.launch({
    headless: process.env.HS_E2E_HEADED !== '1',
    args: [`--ignore-certificate-errors-spki-list=${gatewaySpki()}`, '--host-resolver-rules=MAP localhost 127.0.0.1']
  });
}

// A separate "browser profile" per person, optionally carrying a session cookie.
export async function newProfile(browser, { cookie } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, baseURL: CONFIG.appUrl });
  if (cookie) {
    const [name, value] = cookie.split('=');
    await context.addCookies([{ name, value, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  }
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    const answer = page.__nextPrompt;
    page.__nextPrompt = undefined;
    if (dialog.type() === 'prompt') await dialog.accept(answer ?? '');
    else await dialog.accept();
  });
  page.__dialogs = dialogs;
  return { context, page };
}

// A CTAP2 security key with the PRF (hmac-secret) extension, attached to one tab: that tab is
// the person's device for every later ceremony.
export async function attachSecurityKey(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true
    }
  });
  return {
    authenticatorId,
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials
  };
}

export async function download(page, trigger) {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()]);
  const filePath = await file.path();
  return { name: file.suggestedFilename(), bytes: fs.readFileSync(filePath) };
}
