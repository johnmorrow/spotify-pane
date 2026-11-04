// Spotify Web API backend: signs in with PKCE, controls any Spotify Connect
// device. Needs a developer app (client ID) and Premium; Spotify caps a
// development-mode app at a handful of allowlisted users.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, readJson, writeJson, page } from './common.mjs';

const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const API = 'https://api.spotify.com/v1';

export function createWebApiBackend({ origin, configDir }) {
  const REDIRECT_URI = `${origin}/callback`;
  const CONFIG_FILE = path.join(configDir, 'config.json');
  const TOKEN_FILE = path.join(configDir, 'tokens.json');

  const config = readJson(CONFIG_FILE) || {};
  if (process.env.SPOTIFY_CLIENT_ID) config.clientId = process.env.SPOTIFY_CLIENT_ID;
  let tokens = readJson(TOKEN_FILE); // { access_token, refresh_token, expires_at }
  const pendingLogins = new Map();   // state -> code_verifier

  // ---------- auth ----------

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
  async function accessToken() {
    if (!tokens?.refresh_token) return null;
    if (Date.now() < tokens.expires_at) return tokens.access_token;
    refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
      .catch((e) => { console.error(e.message); if (/invalid_grant|revoked/i.test(e.message)) logout(); })
      .finally(() => { refreshing = null; });
    await refreshing;
    return tokens?.access_token ?? null;
  }

  function logout() { tokens = null; try { fs.unlinkSync(TOKEN_FILE); } catch {} }

  // ---------- API ----------

  async function spotify(method, endpoint, body) {
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
        id: it.id, name: it.name, duration_ms: it.duration_ms,
        artists: isEpisode ? [it.show?.name].filter(Boolean) : (it.artists || []).map((a) => a.name),
        album: isEpisode ? it.show?.name : it.album?.name,
        image: images[0]?.url || null,
        url: it.external_urls?.spotify || null,
      },
    };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+v || 0)));

  return {
    name: 'webapi',
    caps: { devices: true, repeatTrack: true },

    async state() {
      if (!config.clientId) return { need: 'setup', redirectUri: REDIRECT_URI };
      if (!tokens?.refresh_token) return { need: 'signin' };
      try { return shapeState(await spotify('GET', '/me/player?additional_types=episode')); }
      catch (e) { if (e.status === 401) return { need: 'signin' }; throw e; }
    },

    async devices() {
      return (await spotify('GET', '/me/player/devices')).devices
        .map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active }));
    },

    controls: {
      play:     () => spotify('PUT', '/me/player/play'),
      pause:    () => spotify('PUT', '/me/player/pause'),
      next:     () => spotify('POST', '/me/player/next'),
      previous: () => spotify('POST', '/me/player/previous'),
      seek:     ({ position_ms }) => spotify('PUT', `/me/player/seek?position_ms=${clamp(position_ms, 0, 1e8)}`),
      volume:   ({ volume }) => spotify('PUT', `/me/player/volume?volume_percent=${clamp(volume, 0, 100)}`),
      shuffle:  ({ state }) => spotify('PUT', `/me/player/shuffle?state=${state ? 'true' : 'false'}`),
      repeat:   ({ state }) => spotify('PUT', `/me/player/repeat?state=${['off', 'context', 'track'].includes(state) ? state : 'off'}`),
      transfer: ({ device_id }) => spotify('PUT', '/me/player', { device_ids: [String(device_id)], play: true }),
      config:   ({ clientId }) => {
        if (!/^[0-9a-f]{32}$/i.test(clientId || '')) throw new ApiError(400, 'That does not look like a Spotify client ID (32 hex characters).');
        config.clientId = clientId; writeJson(CONFIG_FILE, config); logout();
      },
      logout:   () => logout(),
    },

    // GET routes besides the shared ones.
    routes: {
      // The pane navigates straight to Spotify, which zterm hands to the system browser.
      '/api/login-url': () => {
        if (!config.clientId) throw new ApiError(400, 'no client ID');
        return { json: { url: authorizeUrl() } };
      },
      '/callback': async (url) => {
        const state = url.searchParams.get('state');
        const verifier = pendingLogins.get(state);
        if (url.searchParams.get('error') || !verifier) {
          return { status: 400, html: page('Spotify', `Sign-in failed: ${url.searchParams.get('error') || 'unknown or expired request'}. Try again from the pane.`) };
        }
        pendingLogins.delete(state);
        await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT_URI, code_verifier: verifier });
        return { html: page('Spotify', 'Connected to Spotify. You can close this tab; the pane picks it up on its own.') };
      },
    },
  };
}
