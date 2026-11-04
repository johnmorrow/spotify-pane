// spotify-pane: a tiny local server that signs in to Spotify (PKCE), keeps the
// tokens, proxies the few Web API calls the pane needs, and serves the UI.
// Built-in modules only. Binds 127.0.0.1.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SPOTIFY_PANE_PORT || 8888);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = `${ORIGIN}/callback`;
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const CONFIG_DIR = process.env.SPOTIFY_PANE_HOME || path.join(os.homedir(), '.config', 'spotify-pane');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'tokens.json');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const API = 'https://api.spotify.com/v1';

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

// ---------- persisted state ----------

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });

let config = readJson(CONFIG_FILE) || {};
if (process.env.SPOTIFY_CLIENT_ID) config.clientId = process.env.SPOTIFY_CLIENT_ID;
let tokens = readJson(TOKEN_FILE); // { access_token, refresh_token, expires_at }
const pendingLogins = new Map();   // state -> code_verifier

// ---------- Spotify auth ----------

const b64url = (buf) => buf.toString('base64url');

function authorizeUrl() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  pendingLogins.set(state, verifier);
  setTimeout(() => pendingLogins.delete(state), 10 * 60_000).unref();
  const q = new URLSearchParams({
    client_id: config.clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  });
  return `https://accounts.spotify.com/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token ${res.status}: ${body.error_description || body.error || 'failed'}`);
  tokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token || tokens?.refresh_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
  };
  writeJson(TOKEN_FILE, tokens);
}

let refreshing = null;
let accessToken = async function () {
  if (!tokens?.refresh_token) return null;
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    .catch((e) => { console.error(e.message); if (/invalid_grant|revoked/i.test(e.message)) logout(); })
    .finally(() => { refreshing = null; });
  await refreshing;
  return tokens?.access_token ?? null;
}

function logout() { tokens = null; try { fs.unlinkSync(TOKEN_FILE); } catch {} }

// ---------- Spotify Web API ----------

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

let spotify = async function (method, endpoint, body) {
  const token = await accessToken();
  if (!token) throw new ApiError(401, 'not signed in');
  const res = await fetch(API + endpoint, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  // Player commands answer 200 with a bare text ID rather than JSON or 204; treat any non-JSON body as "no data".
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    if (res.status === 401) logout();
    throw new ApiError(res.status, data?.error?.message || `Spotify ${res.status}`);
  }
  return data;
}

// Trim the player payload to what the UI draws.
function shapeState(p) {
  if (!p || !p.item) return { playing: false, item: null, device: p?.device ?? null };
  const it = p.item;
  const isEpisode = it.type === 'episode';
  const images = (isEpisode ? it.images || it.show?.images : it.album?.images) || [];
  return {
    playing: p.is_playing,
    progress_ms: p.progress_ms,
    shuffle: p.shuffle_state,
    repeat: p.repeat_state,
    device: p.device && { id: p.device.id, name: p.device.name, type: p.device.type,
      volume: p.device.volume_percent, supports_volume: p.device.supports_volume },
    actions: p.actions?.disallows || {},
    item: {
      id: it.id, uri: it.uri, name: it.name, duration_ms: it.duration_ms,
      artists: isEpisode ? [it.show?.name].filter(Boolean) : (it.artists || []).map((a) => a.name),
      album: isEpisode ? it.show?.name : it.album?.name,
      image: images[0]?.url || null,
      url: it.external_urls?.spotify || null,
    },
  };
}

const controls = {
  play:     () => spotify('PUT', '/me/player/play'),
  pause:    () => spotify('PUT', '/me/player/pause'),
  next:     () => spotify('POST', '/me/player/next'),
  previous: () => spotify('POST', '/me/player/previous'),
  seek:     ({ position_ms }) => spotify('PUT', `/me/player/seek?position_ms=${Math.max(0, Math.round(+position_ms))}`),
  volume:   ({ volume }) => spotify('PUT', `/me/player/volume?volume_percent=${Math.min(100, Math.max(0, Math.round(+volume)))}`),
  shuffle:  ({ state }) => spotify('PUT', `/me/player/shuffle?state=${state ? 'true' : 'false'}`),
  repeat:   ({ state }) => spotify('PUT', `/me/player/repeat?state=${['off', 'context', 'track'].includes(state) ? state : 'off'}`),
  transfer: ({ device_id }) => spotify('PUT', '/me/player', { device_ids: [String(device_id)], play: true }),
};

// SPOTIFY_PANE_MOCK=1: fake player for working on the UI without an account.
if (process.env.SPOTIFY_PANE_MOCK) {
  const m = { playing: true, at: Date.now(), pos: 42_000, shuffle: false, repeat: 'off', volume: 60 };
  const pos = () => m.pos + (m.playing ? Date.now() - m.at : 0);
  const set = (f) => { m.pos = pos(); m.at = Date.now(); f(); };
  config.clientId ??= '0'.repeat(32);
  tokens = { refresh_token: 'mock', access_token: 'mock', expires_at: Infinity };
  accessToken = async () => 'mock';
  spotify = async (method, endpoint) => {
    if (endpoint.startsWith('/me/player?')) return {
      is_playing: m.playing, progress_ms: pos() % 214_000, shuffle_state: m.shuffle, repeat_state: m.repeat,
      device: { id: 'd1', name: 'MacBook Pro', type: 'Computer', volume_percent: m.volume, supports_volume: true },
      actions: { disallows: {} },
      item: { type: 'track', id: 't', uri: 'spotify:track:t', name: 'A Fairly Long Song Title For Ellipsis', duration_ms: 214_000,
        artists: [{ name: 'Example Artist' }, { name: 'Guest' }], album: { name: 'Example Album', images: [] }, external_urls: {} },
    };
    if (endpoint.endsWith('/devices')) return { devices: [{ id: 'd1', name: 'MacBook Pro', type: 'Computer', is_active: true }] };
    const q = new URLSearchParams(endpoint.split('?')[1] || '');
    if (endpoint.endsWith('/play')) set(() => { m.playing = true; });
    if (endpoint.endsWith('/pause')) set(() => { m.playing = false; });
    if (endpoint.includes('/seek')) set(() => { m.pos = +q.get('position_ms'); });
    if (endpoint.includes('/volume')) m.volume = +q.get('volume_percent');
    if (endpoint.includes('/shuffle')) m.shuffle = q.get('state') === 'true';
    if (endpoint.includes('/repeat')) m.repeat = q.get('state');
    return null;
  };
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...(isObj ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;background:#121212;color:#eee;display:grid;place-items:center;height:100vh;margin:0}</style>
<p>${message}</p>`;
}

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  // Refuse DNS-rebinding: only our own host names.
  const host = req.headers.host || '';
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(host)) return send(res, 421, 'wrong host');

  const url = new URL(req.url, ORIGIN);
  try {
    // ----- auth -----
    if (url.pathname === '/login') {
      if (!config.clientId) return send(res, 302, '', { Location: '/' });
      return send(res, 302, '', { Location: authorizeUrl() });
    }
    if (url.pathname === '/callback') {
      const verifier = pendingLogins.get(url.searchParams.get('state'));
      if (url.searchParams.get('error') || !verifier) {
        return send(res, 400, page('Spotify', `Sign-in failed: ${url.searchParams.get('error') || 'unknown or expired request'}. Try again from the pane.`), { 'Content-Type': 'text/html' });
      }
      pendingLogins.delete(url.searchParams.get('state'));
      await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT_URI, code_verifier: verifier });
      return send(res, 200, page('Spotify', 'Connected to Spotify. You can close this tab; the pane picks it up on its own.'), { 'Content-Type': 'text/html' });
    }

    // ----- api -----
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) {
      // Mutations need a custom header, which a cross-site page can't send without a preflight we never answer.
      if (req.method !== 'GET' && req.headers['x-spotify-pane'] !== '1') return send(res, 403, { error: 'forbidden' });
      const route = url.pathname.slice(5);

      if (route === 'status') return send(res, 200, { configured: !!config.clientId, signedIn: !!tokens?.refresh_token, redirectUri: REDIRECT_URI });
      if (route === 'config' && req.method === 'POST') {
        const { clientId } = await readBody(req);
        if (!/^[0-9a-f]{32}$/i.test(clientId || '')) return send(res, 400, { error: 'That does not look like a Spotify client ID (32 hex characters).' });
        config.clientId = clientId; writeJson(CONFIG_FILE, config); logout();
        return send(res, 200, { ok: true });
      }
      // The pane navigates straight to Spotify, which zterm hands to the system browser.
      if (route === 'login-url') return config.clientId ? send(res, 200, { url: authorizeUrl() }) : send(res, 400, { error: 'no client ID' });
      if (route === 'logout' && req.method === 'POST') { logout(); return send(res, 200, { ok: true }); }
      if (route === 'state') return send(res, 200, shapeState(await spotify('GET', '/me/player?additional_types=episode')));
      if (route === 'devices') return send(res, 200, (await spotify('GET', '/me/player/devices')).devices
        .map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active })));
      if (req.method === 'POST' && controls[route]) { await controls[route](await readBody(req)); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'no such endpoint' });
    }

    // ----- static -----
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
server.listen(PORT, '127.0.0.1', () => console.log(`spotify-pane on ${ORIGIN}`));
