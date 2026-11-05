// Mock backend: a fake player for working on the UI without Spotify.
// SPOTIFY_PANE_MOCK_NEED=setup|signin|launch|permission-pending|... shows that screen instead.

export function createMockBackend() {
  const m = { playing: true, at: Date.now(), pos: 42_000, shuffle: false, repeat: 'off', volume: 60 };
  const DURATION = 214_000;
  const pos = () => (m.pos + (m.playing ? Date.now() - m.at : 0)) % DURATION;
  const set = (f) => { m.pos = pos(); m.at = Date.now(); f(); };
  const need = process.env.SPOTIFY_PANE_MOCK_NEED;

  return {
    name: 'mock',
    caps: { devices: true, repeatTrack: true, launch: true },
    async state() {
      if (need) return { need, redirectUri: 'http://127.0.0.1:8888/callback' };
      return {
        playing: m.playing, progress_ms: pos(), shuffle: m.shuffle, repeat: m.repeat,
        device: { name: 'MacBook Pro', type: 'Computer', volume: m.volume, supports_volume: true },
        actions: {},
        item: { id: 't', name: 'A Fairly Long Song Title For Ellipsis', duration_ms: DURATION,
          artists: ['Example Artist', 'Guest'], album: 'Example Album', image: null, url: null },
      };
    },
    async search({ q, type = 'track' }) {
      return [1, 2, 3].map((n) => ({ uri: `spotify:${type}:${String(n).repeat(22)}`, type, name: `${q} (result ${n})`, by: 'Mock Artist', year: '2001' }));
    },
    auth: () => ({ configured: true, signedIn: true }),
    async devices() { return [{ id: 'd1', name: 'MacBook Pro', type: 'Computer', active: true }]; },
    controls: {
      play:     () => set(() => { m.playing = true; }),
      pause:    () => set(() => { m.playing = false; }),
      next:     () => set(() => { m.pos = 0; }),
      previous: () => set(() => { m.pos = 0; }),
      seek:     ({ position_ms }) => set(() => { m.pos = +position_ms; }),
      volume:   ({ volume }) => { m.volume = +volume; },
      shuffle:  ({ state }) => { m.shuffle = !!state; },
      repeat:   ({ state }) => { m.repeat = state; },
      transfer: () => set(() => { m.playing = true; }),
      launch:   () => {},
      queue:    () => {},
      playUri:  ({ uri }) => set(() => { m.pos = 0; m.playing = true; m.uri = uri; }),
    },
  };
}
