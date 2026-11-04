'use strict';

const $ = (id) => document.getElementById(id);
const screens = ['setup', 'signin', 'launch', 'permission', 'idle', 'player'];
const show = (name) => screens.forEach((s) => { $(s).hidden = s !== name; });

// ---------- server calls ----------

async function api(route, body) {
  const res = await fetch('/api/' + route, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Spotify-Pane': '1' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

// ---------- state ----------

let state = null;          // last shaped player state from the server
let stateAt = 0;           // when it arrived, for interpolating progress
let seeking = false;
let volumeTouchedAt = 0;   // ignore server volume briefly after the user moves it
let lastArt = null;
let pollTimer;
let forceSetup = false;
let caps = {};            // what the backend can do  // the person asked to change the client ID

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const setPct = (el) => el.style.setProperty('--pct', `${(el.value - el.min) / (el.max - el.min) * 100}%`);

function progressNow() {
  if (!state?.item) return 0;
  const p = state.progress_ms + (state.playing ? Date.now() - stateAt : 0);
  return Math.min(p, state.item.duration_ms);
}

// ---------- rendering ----------

function render() {
  const s = state;
  if (!s?.item) return;
  const it = s.item;
  $('title').textContent = it.name;
  $('artist').textContent = it.artists.join(', ');
  $('album').textContent = it.album || '';
  if (it.image !== lastArt) {
    lastArt = it.image;
    if (it.image) $('art').src = it.image; else $('art').removeAttribute('src');
    $('backdrop').style.backgroundImage = it.image ? `url("${it.image}")` : 'none';
  }
  $('art-link').href = it.url || '#';
  $('playpause').textContent = s.playing ? '⏸' : '▶';
  $('shuffle').classList.toggle('on', !!s.shuffle);
  $('repeat').classList.toggle('on', s.repeat !== 'off');
  $('repeat').classList.toggle('track', s.repeat === 'track');
  $('prev').disabled = !!s.actions.skipping_prev;
  $('next').disabled = !!s.actions.skipping_next;
  $('shuffle').disabled = !!s.actions.toggling_shuffle;
  $('repeat').disabled = !!s.actions.toggling_repeat_context;
  $('device').textContent = s.device?.name || '';
  const canVolume = s.device?.supports_volume !== false && s.device?.volume != null;
  $('volume-wrap').hidden = !canVolume;
  if (canVolume && Date.now() - volumeTouchedAt > 3000) { $('volume').value = s.device.volume; setPct($('volume')); }
  $('duration').textContent = fmt(it.duration_ms);
  document.title = `${s.playing ? '▶' : '⏸'} ${it.name} · ${it.artists[0] || ''}`;
  tick();
}

function tick() {
  if (!state?.item || seeking) return;
  const p = progressNow();
  $('elapsed').textContent = fmt(p);
  $('seek').value = Math.round(p / state.item.duration_ms * 1000) || 0;
  setPct($('seek'));
}
setInterval(tick, 250);

async function renderDevices() {
  const list = $('devices');
  try {
    const devices = await api('devices');
    list.replaceChildren(...devices.map((d) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = `${d.name}  ·  ${d.type}`;
      b.onclick = () => control('transfer', { device_id: d.id });
      li.append(b);
      return li;
    }));
    if (!devices.length) list.innerHTML = '<li class="muted">No devices found. Open Spotify on this computer or your phone.</li>';
  } catch (e) { list.innerHTML = ''; toast(e.message); }
}

// ---------- polling ----------

const PERMISSION_TEXT = {
  'permission-pending': 'macOS is asking whether your terminal may control Spotify. Look for the dialog and click OK.',
  'permission-denied': 'Your terminal is not allowed to control Spotify. Turn it on in System Settings → Privacy & Security → Automation, then come back.',
  'not-installed': 'The Spotify app is not installed on this Mac. Install it from spotify.com/download.',
};

async function poll() {
  clearTimeout(pollTimer);
  let next = document.hidden ? 10000 : 2000;
  try {
    const s = await api('state');
    caps = s.caps || {};
    if (s.need) {
      state = null; document.title = 'Spotify';
      if (s.redirectUri) $('redirect-uri').textContent = s.redirectUri;
      if (s.need === 'setup' || (forceSetup && s.backend === 'webapi')) { show('setup'); next = 5000; }
      else if (s.need === 'signin') { show('signin'); next = 1500; }  // fast, to notice the browser sign-in finishing
      else if (s.need === 'launch') { show('launch'); next = 3000; }
      else { $('permission-text').textContent = PERMISSION_TEXT[s.need] || s.need; show('permission'); next = 3000; }
    } else if (forceSetup) {
      show('setup'); next = 5000;
    } else {
      state = s; stateAt = Date.now();
      if (s.item) { show('player'); render(); }
      else {
        document.title = 'Spotify';
        $('devices-wrap').hidden = !caps.devices;
        $('idle-play').hidden = !!caps.devices;
        if (caps.devices && $('idle').hidden) renderDevices();
        show('idle'); next = caps.devices ? 5000 : 2000;
      }
    }
  } catch (e) {
    if (e.status === 429) next = 15000;
    else if (e.status !== 401) toast(e.message);
  }
  pollTimer = setTimeout(poll, next);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

// ---------- controls ----------

// Send a command, update the UI at once, then re-poll to settle on Spotify's truth.
async function control(route, body = {}, optimistic) {
  if (optimistic && state) { optimistic(state); render(); }
  try { await api(route, body); }
  catch (e) {
    toast(PERMISSION_TEXT[e.message]
        || (e.status === 404 ? 'No active device. Start Spotify somewhere first.'
        : e.status === 403 ? `Spotify refused: ${e.message}` : e.message));
  }
  setTimeout(poll, 400);
}

const togglePlay = () => {
  const playing = state?.playing;
  if (state) { state.progress_ms = progressNow(); stateAt = Date.now(); }
  control(playing ? 'pause' : 'play', {}, (s) => { s.playing = !playing; });
};
const skip = (dir) => control(dir, {});
const cycleRepeat = () => {
  const order = caps.repeatTrack ? { off: 'context', context: 'track', track: 'off' } : { off: 'context', context: 'off', track: 'off' };
  const nextMode = order[state?.repeat || 'off'];
  control('repeat', { state: nextMode }, (s) => { s.repeat = nextMode; });
};
const toggleShuffle = () => {
  const on = !state?.shuffle;
  control('shuffle', { state: on }, (s) => { s.shuffle = on; });
};
let volumeTimer;
const setVolume = (v) => {
  v = Math.max(0, Math.min(100, Math.round(v)));
  $('volume').value = v; setPct($('volume')); volumeTouchedAt = Date.now();
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => control('volume', { volume: v }, (s) => { if (s.device) s.device.volume = v; }), 150);
};

$('playpause').onclick = togglePlay;
$('prev').onclick = () => skip('previous');
$('next').onclick = () => skip('next');
$('shuffle').onclick = toggleShuffle;
$('repeat').onclick = cycleRepeat;

$('seek').addEventListener('input', () => {
  seeking = true; setPct($('seek'));
  if (state?.item) $('elapsed').textContent = fmt($('seek').value / 1000 * state.item.duration_ms);
});
$('seek').addEventListener('change', () => {
  const ms = $('seek').value / 1000 * (state?.item?.duration_ms || 0);
  seeking = false;
  control('seek', { position_ms: ms }, (s) => { s.progress_ms = ms; stateAt = Date.now(); });
});
$('volume').addEventListener('input', () => setVolume(+$('volume').value));

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if ($('player').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const actions = {
    ' ': togglePlay, k: togglePlay,
    ArrowRight: () => skip('next'), l: () => skip('next'),
    ArrowLeft: () => skip('previous'), j: () => skip('previous'),
    ArrowUp: () => setVolume(+$('volume').value + 5),
    ArrowDown: () => setVolume(+$('volume').value - 5),
    s: toggleShuffle, r: cycleRepeat,
  };
  if (actions[e.key]) { e.preventDefault(); actions[e.key](); }
});

// ---------- setup + sign-in ----------

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('setup-error').textContent = '';
  try { await api('config', { clientId: $('client-id').value.trim() }); forceSetup = false; poll(); }
  catch (err) { $('setup-error').textContent = err.message; }
});
$('signin-btn').onclick = async () => {
  try { location.href = (await api('login-url')).url; }  // off-origin: zterm opens it in the system browser
  catch (e) { toast(e.message); }
};
$('change-client').onclick = (e) => { e.preventDefault(); forceSetup = true; poll(); };
$('refresh-devices').onclick = renderDevices;
$('launch-btn').onclick = () => control('launch');
$('idle-play').onclick = () => control('play');

poll();
