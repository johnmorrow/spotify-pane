// Command-line client for a running spotify-pane server. bin/spotify-pane
// starts the server first, then hands these commands here:
//
//   now [--json]                          what's playing
//   search <query> [--type T] [--json]    T: track (default), album, playlist, artist
//   play <query|uri|link> [--type T]      play the top hit, or exactly that URI/link
//   queue <query|uri|link>                add a track after the current one
//   login [client-id]                     sign in to the Web API (search and queue need it)
//
// "<title> by <artist>" searches for that title by that artist.

import { execFile } from 'node:child_process';

const PORT = Number(process.env.SPOTIFY_PANE_PORT || 8888);
const BASE = `http://127.0.0.1:${PORT}`;

function die(msg, code = 1) { console.error(`spotify-pane: ${msg}`); process.exit(code); }

async function api(route, body) {
  const res = await fetch(`${BASE}/api/${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spotify-Pane': '1' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- arguments ----------

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--json') flags.json = true;
  else if (a === '--type' || a === '-t') flags.type = rest[++i];
  else if (a === '--limit' || a === '-n') flags.limit = Number(rest[++i]);
  else words.push(a);
}
const text = words.join(' ').trim();

// spotify:album:ID, https://open.spotify.com/intl-de/album/ID?si=..., or null
function toUri(s) {
  if (/^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]{22}$/.test(s)) return s;
  const m = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})/i.exec(s);
  return m ? `spotify:${m[1].toLowerCase()}:${m[2]}` : null;
}

// "Mishima by Philip Glass" -> "Mishima artist:Philip Glass"
function toQuery(s) {
  const m = /^(.+?)\s+by\s+(.+)$/i.exec(s);
  return m ? `${m[1]} artist:${m[2]}` : s;
}

const describe = (r) => [r.name, r.by && `— ${r.by}`, r.album && r.type === 'track' && `(${r.album})`, r.year && `[${r.year}]`,
  r.tracks != null && r.type !== 'track' && `${r.tracks} tracks`].filter(Boolean).join(' ');

async function resolve(input, type) {
  const uri = toUri(input);
  if (uri) return { uri, name: uri };
  if (/^spotify:|open\.spotify\.com/i.test(input)) die(`not a Spotify URI or link: ${input}`, 2);
  const hits = await api('search', { q: toQuery(input), type: type || 'track', limit: 5 });
  if (!hits.length) die(`nothing found for "${input}"${type ? ` (${type})` : ''}`);
  return hits[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowLine(s) {
  if (s.need) return `not ready: ${s.need}`;
  if (!s.item) return 'nothing playing';
  const t = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  return `${s.playing ? '▶' : '⏸'} ${s.item.name} — ${s.item.artists.join(', ')} (${s.item.album || ''}) ${t(s.progress_ms)}/${t(s.item.duration_ms)}`
    + (s.device?.name ? ` on ${s.device.name}` : '');
}

// ---------- commands ----------

switch (cmd) {
  case 'now': {
    const s = await api('state');
    console.log(flags.json ? JSON.stringify(s, null, 2) : nowLine(s));
    break;
  }

  case 'search': {
    if (!text) die('usage: spotify-pane search <query> [--type track|album|playlist|artist] [--json]', 2);
    const hits = await api('search', { q: toQuery(text), type: flags.type || 'track', limit: flags.limit || 8 });
    if (flags.json) console.log(JSON.stringify(hits, null, 2));
    else if (!hits.length) console.log('no results');
    else hits.forEach((h, i) => console.log(`${String(i + 1).padStart(2)}. ${h.uri}  ${describe(h)}`));
    break;
  }

  case 'play': {
    if (!text) { await api('play', {}); console.log('resumed'); break; }
    const hit = await resolve(text, flags.type);
    await api('playUri', { uri: hit.uri });
    console.log(`playing ${hit.uri}  ${hit.type ? describe(hit) : ''}`.trimEnd());
    // Confirm from the player itself; the app takes a moment to switch.
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      const s = await api('state');
      if (s.item && s.playing) { console.log(nowLine(s)); break; }
    }
    break;
  }

  case 'queue': {
    if (!text) die('usage: spotify-pane queue <track query|uri|link>', 2);
    const hit = await resolve(text, 'track');
    if (!/^spotify:(track|episode):/.test(hit.uri)) die('only a track or episode can be queued; use `play` for albums and playlists', 2);
    await api('queue', { uri: hit.uri });
    console.log(`queued ${hit.uri}  ${hit.type ? describe(hit) : ''}`.trimEnd());
    break;
  }

  case 'login': {
    if (words[0]) await api('config', { clientId: words[0] });
    const auth = await api('auth');
    if (!auth.configured) {
      die(`no client ID yet. Create an app at https://developer.spotify.com/dashboard with redirect URI
  ${auth.redirectUri}
then run: spotify-pane login <client-id>`, 2);
    }
    if (auth.signedIn && !words[0]) { console.log('already signed in'); break; }
    const { url } = await api('login-url');
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(opener, [url], (err) => { if (err) console.log(`open this in a browser:\n${url}`); });
    console.log('finish signing in in your browser…');
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      if ((await api('auth')).signedIn) { console.log('signed in'); process.exit(0); }
    }
    die('timed out waiting for sign-in');
  }

  default:
    die(`unknown command '${cmd}'`, 2);
}
