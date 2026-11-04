// macOS backend: drives the Spotify desktop app on this Mac through
// AppleScript (JXA). No developer app, no sign-in, no user cap. The first
// call makes macOS ask whether the terminal may control Spotify.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { ApiError } from './common.mjs';

const TIMEOUT_MS = 6000;

// One script for every call; argv[0] is the command, the rest its arguments.
// Arguments travel as argv, never spliced into the source.
const SCRIPT = String.raw`
function run(argv) {
  const [cmd, arg] = argv;
  const s = Application('Spotify');
  if (cmd === 'launch') { s.activate(); return 'ok'; }
  if (!s.running()) return JSON.stringify({ running: false });
  switch (cmd) {
    case 'state': {
      const st = s.playerState();
      let track = null;
      if (st !== 'stopped') {
        const t = s.currentTrack();
        track = { name: t.name(), artist: t.artist(), album: t.album(), duration: t.duration(),
                  id: t.id(), art: t.artworkUrl() };
      }
      return JSON.stringify({ running: true, state: st, position: s.playerPosition(),
        volume: s.soundVolume(), shuffle: s.shuffling(), repeat: s.repeating(), track });
    }
    case 'play': s.play(); break;
    case 'pause': s.pause(); break;
    case 'next': s.nextTrack(); break;
    case 'previous': s.previousTrack(); break;
    case 'seek': s.playerPosition = Number(arg); break;
    case 'volume': s.soundVolume = Number(arg); break;
    case 'shuffle': s.shuffling = arg === 'true'; break;
    case 'repeat': s.repeating = arg === 'true'; break;
    default: throw new Error('unknown command ' + cmd);
  }
  return 'ok';
}`;

function jxa(...args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', SCRIPT, ...args.map(String)], { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      const msg = `${stderr || err.message}`;
      if (err.killed || /-1712|timed out/i.test(msg)) return reject(new ApiError(503, 'permission-pending'));
      if (/-1743|not authori[sz]ed/i.test(msg)) return reject(new ApiError(503, 'permission-denied'));
      if (/-2700|can.t be found|-10814/i.test(msg)) return reject(new ApiError(503, 'not-installed'));
      reject(new ApiError(500, msg.replace(/^.*execution error: /s, '').trim()));
    });
  });
}

// "spotify:track:abc" -> "https://open.spotify.com/track/abc"
const webUrl = (id) => {
  const m = /^spotify:(track|episode|show|album|artist):([A-Za-z0-9]+)$/.exec(id || '');
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
};

export function createMacosBackend() {
  const deviceName = os.hostname().replace(/\.local$/, '');
  let inflight = null; // collapse overlapping polls into one osascript

  async function readState() {
    inflight ??= jxa('state').finally(() => { inflight = null; });
    return JSON.parse(await inflight);
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

  return {
    name: 'macos',
    caps: { devices: false, repeatTrack: false, launch: true },

    async state() {
      let r;
      try { r = await readState(); }
      catch (e) {
        if (e.status === 503) return { need: e.message };
        throw e;
      }
      if (!r.running) return { need: 'launch' };
      const t = r.track;
      const device = { name: deviceName, type: 'Computer', volume: r.volume, supports_volume: true };
      if (!t) return { playing: false, item: null, device };
      return {
        playing: r.state === 'playing',
        progress_ms: Math.round(r.position * 1000),
        shuffle: r.shuffle,
        repeat: r.repeat ? 'context' : 'off',
        device,
        // Spotify's "shuffling enabled"/"repeating enabled" share one Apple Event code and read false; ignore them.
        actions: {},
        item: {
          id: t.id, name: t.name, duration_ms: t.duration,
          artists: t.artist ? [t.artist] : [],
          album: t.album,
          image: t.art || null,
          url: webUrl(t.id),
        },
      };
    },

    controls: {
      play:     () => jxa('play'),
      pause:    () => jxa('pause'),
      next:     () => jxa('next'),
      previous: () => jxa('previous'),
      seek:     ({ position_ms }) => jxa('seek', (clamp(position_ms, 0, 1e8) / 1000).toFixed(3)),
      volume:   ({ volume }) => jxa('volume', Math.round(clamp(volume, 0, 100))),
      shuffle:  ({ state }) => jxa('shuffle', state ? 'true' : 'false'),
      repeat:   ({ state }) => jxa('repeat', state && state !== 'off' ? 'true' : 'false'),
      launch:   () => jxa('launch'),
    },
  };
}
