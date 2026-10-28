const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const { listen, listenTarget, describe } = require('../lib/listen');

test('loopback by default, HOST to override, and a socket when Home Base says so', () => {
  assert.deepEqual(listenTarget({}, 3008), { host: '127.0.0.1', port: 3008 });
  assert.deepEqual(listenTarget({ PORT: '4000', HOST: '0.0.0.0' }, 3008), { host: '0.0.0.0', port: 4000 });
  assert.deepEqual(listenTarget({ SOVEREIGN_LISTEN: 'unix:/run/sovereign-apps/home-source/app.sock', PORT: '3008' }), { socket: '/run/sovereign-apps/home-source/app.sock' });
  for (const bad of ['tcp:0.0.0.0:3008', 'unix:relative.sock', 'unix:/run/x/app', '/run/x/app.sock']) assert.throws(() => listenTarget({ SOVEREIGN_LISTEN: bad }), /must look like unix:/, bad);
  assert.equal(describe({ host: '127.0.0.1', port: 3008 }), 'http://127.0.0.1:3008');
});

test('serves on the socket, 0660, replacing a stale socket but never another file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-listen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, 'app.sock');
  const app = express();
  // As server.js: the rate limits key on req.ip, which over a socket (no peer address) is the client
  // address nginx forwards from Tailscale Serve.
  app.set('trust proxy', 1);
  app.get('/api/health', (req, res) => res.json({ ip: req.ip }));
  const env = { SOVEREIGN_LISTEN: `unix:${socket}` };
  const start = () => new Promise((resolve) => { const server = listen(app, { env }, () => resolve(server)); });
  const first = await start();
  assert.equal(fs.statSync(socket).mode & 0o777, 0o660);
  const get = (headers = {}) => new Promise((resolve, reject) => http.get({ socketPath: socket, path: '/api/health', headers }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject));
  assert.equal((await get()).status, 200);
  assert.equal((await get({ 'X-Forwarded-For': '100.64.0.7' })).body.ip, '100.64.0.7');
  assert.equal((await get({ 'X-Forwarded-For': '203.0.113.9, 100.64.0.7' })).body.ip, '100.64.0.7', 'only the last hop is trusted');
  await new Promise((resolve) => first.close(resolve));
  // A crash (SIGKILL) leaves its socket behind; the next start replaces it.
  const crashed = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => process.stdout.write('up'))`]);
  await new Promise((resolve) => crashed.stdout.once('data', resolve));
  crashed.kill('SIGKILL');
  await new Promise((resolve) => crashed.on('exit', resolve));
  assert.equal(fs.lstatSync(socket).isSocket(), true, 'stale socket left behind');
  const second = await start();
  assert.equal((await get()).status, 200);
  await new Promise((resolve) => second.close(resolve));
  const notSocket = path.join(dir, 'file.sock');
  fs.writeFileSync(notSocket, 'data');
  assert.throws(() => listen(app, { env: { SOVEREIGN_LISTEN: `unix:${notSocket}` } }), /exists and is not a socket/);
  assert.equal(fs.readFileSync(notSocket, 'utf8'), 'data');
});
