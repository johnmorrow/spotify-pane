// spotify-pane: a tiny local server for the zterm pane. It serves the UI and
// forwards its commands to a backend:
//   macos   the Spotify app on this Mac, through AppleScript (default on macOS)
//   webapi  the Spotify Web API, any Connect device (needs a developer app)
//   mock    a fake player for UI work
// Built-in modules only. Binds 127.0.0.1.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ApiError } from './backends/common.mjs';

const PORT = Number(process.env.SPOTIFY_PANE_PORT || 8888);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CONFIG_DIR = process.env.SPOTIFY_PANE_HOME || path.join(os.homedir(), '.config', 'spotify-pane');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

const BACKEND = process.env.SPOTIFY_PANE_MOCK ? 'mock'
  : process.env.SPOTIFY_PANE_BACKEND || (process.platform === 'darwin' ? 'macos' : 'webapi');

async function loadBackend(name) {
  switch (name) {
    case 'macos':  return (await import('./backends/macos.mjs')).createMacosBackend();
    case 'webapi': return (await import('./backends/webapi.mjs')).createWebApiBackend({ origin: ORIGIN, configDir: CONFIG_DIR });
    case 'mock':   return (await import('./backends/mock.mjs')).createMockBackend();
    default: console.error(`unknown SPOTIFY_PANE_BACKEND '${name}' (macos, webapi, mock)`); process.exit(1);
  }
}
const backend = await loadBackend(BACKEND);

// Search, the queue and sign-in always go through the Web API, whatever plays the music:
// AppleScript can play a URI but can't search or queue.
const webapi = backend.search ? backend
  : (await import('./backends/webapi.mjs')).createWebApiBackend({ origin: ORIGIN, configDir: CONFIG_DIR });
const ACCOUNT_CONTROLS = ['config', 'logout', 'queue'];

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...(isObj ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  // Refuse DNS rebinding: only our own host names.
  const host = req.headers.host || '';
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(host)) return send(res, 421, 'wrong host');

  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, backend: backend.name });

    // Mutations need a custom header, which a cross-site page can't send without a preflight we never answer.
    if (req.method !== 'GET' && req.headers['x-spotify-pane'] !== '1') return send(res, 403, { error: 'forbidden' });

    const extra = req.method === 'GET' && (backend.routes?.[url.pathname] || webapi.routes?.[url.pathname]);
    if (extra) {
      const r = await extra(url);
      return r.html ? send(res, r.status || 200, r.html, { 'Content-Type': 'text/html; charset=utf-8' }) : send(res, r.status || 200, r.json);
    }

    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5);
      if (route === 'state' && req.method === 'GET') {
        return send(res, 200, { backend: backend.name, caps: backend.caps, ...(await backend.state()) });
      }
      if (route === 'auth' && req.method === 'GET') return send(res, 200, webapi.auth());
      if (route === 'search' && req.method === 'POST') return send(res, 200, await webapi.search(await readBody(req)));
      if (req.method === 'POST' && ACCOUNT_CONTROLS.includes(route) && !Object.hasOwn(backend.controls, route)) {
        await webapi.controls[route](await readBody(req)); return send(res, 200, { ok: true });
      }
      if (route === 'devices' && req.method === 'GET') {
        if (!backend.devices) return send(res, 404, { error: 'this backend has no device list' });
        return send(res, 200, await backend.devices());
      }
      const control = req.method === 'POST' && Object.hasOwn(backend.controls, route) && backend.controls[route];
      if (control) { await control(await readBody(req)); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'no such endpoint' });
    }

    // ----- static -----
    if (req.method !== 'GET') return send(res, 405, 'method not allowed');
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status === 500) console.error(e);
    return send(res, status, { error: e.message });
  }
});

server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is in use` : e); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log(`spotify-pane on ${ORIGIN} (backend: ${backend.name})`));
