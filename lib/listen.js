const fs = require('fs');

// Where the server listens (Home Base Feature-10 SID-002). Under Home Base, SOVEREIGN_LISTEN=unix:<path>
// names a socket in a directory only this app's user and nginx can enter, so nothing else on the host or
// the tailnet can reach the app around nginx. Without it, the app listens on loopback (HOST to override).
function listenTarget(env = process.env, defaultPort = 3008) {
  const value = String(env.SOVEREIGN_LISTEN || '').trim();
  if (value) {
    const match = /^unix:(\/[^\0]+\.sock)$/.exec(value);
    if (!match) throw new Error(`SOVEREIGN_LISTEN must look like unix:/path/app.sock, not ${value}`);
    return { socket: match[1] };
  }
  return { host: env.HOST || '127.0.0.1', port: Number(env.PORT) || defaultPort };
}

// A socket left by the previous run is removed first (only a socket: any other file there is an error),
// and the new one is made reachable by nginx's group (the directory decides who else).
function listen(app, { env = process.env, defaultPort = 3008 } = {}, onListening = () => {}) {
  const target = listenTarget(env, defaultPort);
  if (!target.socket) return app.listen(target.port, target.host, () => onListening(target));
  let stale = null;
  try { stale = fs.lstatSync(target.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stale && !stale.isSocket()) throw new Error(`${target.socket} exists and is not a socket`);
  if (stale) fs.unlinkSync(target.socket);
  return app.listen(target.socket, () => {
    fs.chmodSync(target.socket, 0o660);
    onListening(target);
  });
}

function describe(target) {
  return target.socket ? `unix:${target.socket}` : `http://${target.host}:${target.port}`;
}

module.exports = { describe, listen, listenTarget };
