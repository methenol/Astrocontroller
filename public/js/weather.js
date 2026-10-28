/**
 * Weather: is it safe to leave the telescope out tonight?
 *  - the Rain Guard, which the server runs (it keeps watching with no page open); this page shows
 *    it and, on a device that listens, sounds its alarm;
 *  - the night safety report, hour by hour from sunset to sunrise;
 *  - radar and infrared satellite imagery around the site.
 *
 * A listening device also watches the guard itself: if it stops hearing from the server while the
 * guard is armed it sounds a fault alarm of its own, since the server cannot reach it to warn it.
 */
import { $, esc, fixed, store, toast, busy } from './dom.js';
import { api } from './api.js';
import { on } from './bus.js';
import { state, isPanelActive } from './state.js';
import { showScreen } from './shell.js';
import { WxMap } from './wxmap.js';
import { temp, delta, speed, speedN, speedUnit, precip, imperial, settingUnit, settingToView, settingFromView } from './units.js';

const DEVICE_KEY = 'guardDevice';
const PATTERN_MS = 3600;
/** Without a guard message for this long beyond the poll interval, a listening device worries. */
const SILENCE_GRACE_MS = 2 * 60e3;
/** The state socket down this long while armed is a local fault. */
const SOCKET_GRACE_MS = 90e3;
const WATCHDOG_MS = 15e3;
const SAFETY_POLL_MS = 15 * 60e3;
const IMAGERY_REFRESH_MS = 10 * 60e3;
const SAT_STEP_MS = 10 * 60e3;
const SAT_FRAMES = 6;
const RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

let guard = null;
let lastGuardAt = 0;
let socketUp = false;
let socketDownSince = Date.now();
let localFault = null;
let localFaultSilenced = false;
let lastWatchKey = '';

// ---------------------------------------------------------------- sound
let audioCtx = null;
let soundTimer = null;
let soundKind = null;
let wakeLock = null;

const deviceOn = () => store.get(DEVICE_KEY) === '1';
const audioReady = () => audioCtx?.state === 'running';

async function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('this browser has no Web Audio');
  audioCtx ??= new Ctx();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  renderDevice();
  return audioReady();
}

function tone(at, freqs, len, type = 'square', vol = 0.32) {
  const t = audioCtx.currentTime + at;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  freqs.forEach((f, i) => osc.frequency.setValueAtTime(f, t + (i * len) / freqs.length));
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  gain.gain.setValueAtTime(vol, t + len - 0.14);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + len + 0.02);
}

const PATTERNS = {
  // the weather alarm: three falling two-tone blasts
  alarm: () => [0, 0.55, 1.1].forEach((at) => tone(at, [880, 660], 0.48)),
  // the guard cannot see: slow low tones, unlike the weather alarm
  fault: () => [0, 0.9].forEach((at) => tone(at, [440, 330], 0.75, 'sawtooth', 0.28)),
  // something nearby: one soft chime
  watch: () => tone(0, [660, 990], 0.6, 'sine', 0.22),
};

function play(kind) {
  if (!audioReady()) return;
  PATTERNS[kind]();
  if (kind !== 'watch') navigator.vibrate?.([400, 200, 400]);
}

function setSound(kind) {
  if (kind === soundKind) return;
  clearInterval(soundTimer);
  soundTimer = null;
  soundKind = kind;
  if (!kind) return;
  play(kind);
  soundTimer = setInterval(() => play(kind), PATTERN_MS);
}

function notify(body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('Rain Guard', { body, tag: 'rain-guard', requireInteraction: true });
  } catch {
    /* some mobile browsers only notify from a service worker */
  }
}

async function syncWakeLock() {
  const want = deviceOn() && guard?.armed && document.visibilityState === 'visible';
  if (!want) {
    if (wakeLock) await wakeLock.release().catch(() => undefined);
    wakeLock = null;
    return renderDevice();
  }
  if (wakeLock || !('wakeLock' in navigator)) return renderDevice();
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      renderDevice();
    }, { once: true });
  } catch {
    wakeLock = null;
  }
  renderDevice();
}

/** What this device should be sounding now, from the server's alarm and its own watchdog. */
function syncSound() {
  if (!deviceOn() || !guard?.armed) return setSound(null);
  const serverKind = guard.sounding ? (guard.alarm?.kinds?.length === 1 && guard.alarm.kinds[0] === 'fault' ? 'fault' : 'alarm') : null;
  const kind = serverKind ?? (localFault && !localFaultSilenced ? 'fault' : null);
  if (kind && kind !== soundKind) notify(kind === 'alarm' ? guard.alarm?.message ?? 'rain alarm' : localFault ?? guard.alarm?.message ?? 'the guard cannot see the weather');
  setSound(kind);
}

// ---------------------------------------------------------------- the guard
const STATE_LOOK = {
  disarmed: { orb: '○', cls: '', title: 'Rain Guard: disarmed' },
  starting: { orb: '●', cls: 'armed', title: 'Rain Guard: armed, first check…' },
  clear: { orb: '●', cls: 'armed', title: 'Rain Guard: armed, dry' },
  watch: { orb: '◐', cls: 'watch', title: 'Rain Guard: armed, watching nearby weather' },
  alarm: { orb: '☔', cls: 'alarm', title: 'RAIN GUARD ALARM' },
  fault: { orb: '!', cls: 'fault', title: 'RAIN GUARD FAULT' },
};

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60e3);
  return m < 1 ? 'just now' : `${m} min ago`;
};

function renderGuard() {
  const g = guard;
  if (!g) return;
  const look = localFault && g.armed && !g.sounding ? STATE_LOOK.fault : STATE_LOOK[g.state] ?? STATE_LOOK.disarmed;
  const orb = $('#guard-orb');
  orb.textContent = look.orb;
  orb.className = `guard-orb ${look.cls}${g.sounding || (localFault && !localFaultSilenced) ? ' sounding' : ''}`;
  $('#guard-title').textContent = look.title;
  const a = g.assessment;
  let text;
  if (localFault && g.armed) text = localFault;
  else if (!g.armed) text = 'Arm it before leaving the telescope out: the server checks the forecast at the telescope and around it every few minutes, and this device sounds the alarm.';
  else if (g.alarm) text = `${g.alarm.message}${g.alarm.acknowledgedAt ? ` — silenced at ${clock(g.alarm.acknowledgedAt)}; it sounds again if this lasts` : ''}`;
  else if (g.state === 'starting') text = 'Fetching the first forecast…';
  else if (g.state === 'watch') text = a.hazards.map((h) => h.message).join('; ');
  else text = `No precipitation, storm or strong gust forecast in the next ${g.settings.lookaheadMin} minutes.`;
  $('#guard-text').textContent = text;

  $('#btn-guard-arm').hidden = g.armed;
  $('#btn-guard-disarm').hidden = !g.armed;
  $('#btn-guard-ack').hidden = !(g.sounding || (localFault && !localFaultSilenced));

  const site = g.site ? `${fixed(g.site.lat, 4)}, ${fixed(g.site.lon, 4)}` : 'unknown';
  const grid = a?.grid ? `${fixed(a.grid.lat, 3)}, ${fixed(a.grid.lon, 3)}` : '–';
  $('#guard-metrics').innerHTML = `
    <div><span>Precipitation, next ${esc(g.settings.lookaheadMin)} min</span>${a ? esc(precip(a.siteMm)) : '–'}</div>
    <div><span>Highest hourly chance</span>${a ? `${esc(a.maxProbability)}%` : '–'}</div>
    <div><span>Strongest gust</span>${a ? esc(speed(a.maxGustKmh)) : '–'}</div>
    <div><span>Last good check</span>${esc(ago(g.lastCheck))}${g.lastError ? ` <b class="sky bad" title="${esc(g.lastError)}">failing</b>` : ''}</div>
    <div><span>Next check</span>${esc(g.armed ? clock(g.nextCheck) : 'when armed')}</div>
    <div><span>Telescope · forecast cell</span><small>${esc(site)} · ${esc(grid)}</small></div>`;

  const slots = a?.slots ?? [];
  $('#guard-timeline').innerHTML = slots.length
    ? slots.map((s) => {
      const wet = s.mm >= g.settings.thresholdMm;
      return `<div class="guard-slot${wet ? ' wet' : ''}"><small>${esc(clock(new Date(s.end - 15 * 60e3).toISOString()))}</small><b>${wet ? esc(precip(s.mm)) : 'dry'}</b></div>`;
    }).join('')
    : '';
  $('#guard-hazards').innerHTML = (a?.hazards ?? []).map((h) => `<li class="${h.level === 'alarm' ? 'bad' : 'warn'}">${esc(h.message)}</li>`).join('');
  if (g.lastError) $('#guard-hazards').insertAdjacentHTML('beforeend', `<li class="warn">last check failed: ${esc(g.lastError)}</li>`);

  const form = $('#guard-settings');
  for (const [k, v] of Object.entries(g.settings)) {
    const input = form.elements.namedItem(k);
    if (!input) continue;
    const unit = form.querySelector(`[data-unit="${k}"]`);
    if (unit) {
      unit.textContent = settingUnit(k, unit.dataset.metric ??= unit.textContent);
      // the bounds in the markup are metric; the server checks the converted value
      if (imperial()) {
        input.removeAttribute('min');
        input.removeAttribute('max');
        input.step = 'any';
      }
    }
    if (document.activeElement !== input) input.value = settingToView(k, v);
  }

  const chip = $('#chip-guard');
  chip.hidden = !g.armed;
  chip.className = `chip chip-guard ${look.cls}`;
  chip.textContent = g.sounding ? '☔ ALARM' : localFault ? '☔ fault' : g.state === 'watch' ? '☔ watch' : '☔ armed';
  chip.title = `Rain Guard: ${text}`;
  renderDevice();
}

function renderDevice() {
  const box = $('#guard-device');
  box.checked = deviceOn();
  const notes = [];
  if (deviceOn()) {
    if (!audioReady()) notes.push('sound not enabled yet');
    if (guard?.armed) notes.push(wakeLock ? 'screen kept on' : 'wakeLock' in navigator ? 'keep this page open and visible' : 'keep this page open; the screen may sleep');
  }
  $('#guard-device-note').textContent = notes.length ? `(${notes.join(' · ')})` : '';
  $('#btn-guard-unlock').hidden = !(deviceOn() && guard?.armed && !audioReady());
}

/** The server's guard status (hello, a 'guard' message, or an API reply). */
export function renderGuardState(g) {
  if (!g || typeof g !== 'object') return;
  guard = g;
  lastGuardAt = Date.now();
  if (localFault) {
    localFault = null;
    localFaultSilenced = false;
  }
  const watchKey = g.state === 'watch' ? (g.assessment?.hazards ?? []).map((h) => h.message).join('|') : '';
  if (watchKey && watchKey !== lastWatchKey && deviceOn() && g.armed && !g.sounding) play('watch');
  lastWatchKey = watchKey;
  renderGuard();
  syncSound();
  syncWakeLock();
}

function watchdog() {
  if (!guard?.armed || !deviceOn()) return;
  const now = Date.now();
  const pollMs = (guard.pollSec ?? 180) * 1000;
  let why = null;
  if (!socketUp && now - socketDownSince > SOCKET_GRACE_MS) why = `Lost contact with Astrocontroller ${Math.round((now - socketDownSince) / 60e3)} min ago: the Rain Guard cannot warn this device.`;
  else if (socketUp && now - lastGuardAt > pollMs + SILENCE_GRACE_MS) why = `No word from the Rain Guard for ${Math.round((now - lastGuardAt) / 60e3)} min: it may have stopped checking.`;
  if (why !== localFault) {
    if (why && !localFault) localFaultSilenced = false;
    localFault = why;
    renderGuard();
    syncSound();
  }
}

async function guardCall(path, btn) {
  const run = async () => {
    try {
      renderGuardState(await api(`guard/${path}`, {}));
    } catch (e) {
      toast(`Rain Guard: ${e.message}`, true);
    }
  };
  return btn ? busy(btn, run) : run();
}

async function enableDevice() {
  store.set(DEVICE_KEY, '1');
  try {
    await unlockAudio();
  } catch (e) {
    toast(e.message, true);
  }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined);
  renderDevice();
  syncWakeLock();
}

$('#btn-guard-arm').onclick = async (e) => {
  // the device that arms the guard is the one that wakes its owner, unless they said otherwise
  if (store.get(DEVICE_KEY) === null || deviceOn()) await enableDevice();
  await guardCall('arm', e.currentTarget);
  loadSafety();
};
$('#btn-guard-disarm').onclick = (e) => guardCall('disarm', e.currentTarget);
$('#btn-guard-check').onclick = (e) => guardCall('check', e.currentTarget);
$('#btn-guard-ack').onclick = (e) => {
  localFaultSilenced = true;
  setSound(null);
  if (guard?.sounding) guardCall('ack', e.currentTarget);
  else renderGuard();
};
$('#btn-guard-test').onclick = async () => {
  try {
    await unlockAudio();
    play('alarm');
    setTimeout(() => play('fault'), 2000);
    toast('Alarm, then fault sound: check you can hear both where you sleep');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#btn-guard-unlock').onclick = () => unlockAudio().then(syncSound, (e) => toast(e.message, true));
$('#guard-device').onchange = (e) => {
  if (e.target.checked) enableDevice().then(syncSound);
  else {
    store.set(DEVICE_KEY, '0');
    setSound(null);
    syncWakeLock();
  }
};
$('#guard-settings').addEventListener('change', async (e) => {
  const input = e.target;
  const v = Number(input.value);
  if (!input.name || !Number.isFinite(v)) return;
  try {
    renderGuardState(await api('guard/settings', { [input.name]: settingFromView(input.name, v) }));
    toast('Rain Guard settings saved');
    loadSafety();
  } catch (err) {
    toast(err.message, true);
    if (guard) renderGuard();
  }
});
$('#guard-settings').addEventListener('submit', (e) => e.preventDefault());
$('#chip-guard').onclick = () => showScreen('weather');

// A suspended AudioContext (a reload while armed) can only be resumed from a user gesture: take the first one.
document.addEventListener('pointerdown', () => {
  if (deviceOn() && audioCtx?.state !== 'running') unlockAudio().then(syncSound).catch(() => undefined);
}, { capture: true });
document.addEventListener('visibilitychange', syncWakeLock);
on('socket', (up) => {
  socketUp = up;
  if (!up) socketDownSince = Date.now();
});

// ---------------------------------------------------------------- night safety report
const RISK_ICON = { safe: '✓', caution: '!', danger: '✕' };
let safetySeq = 0;

function safetyHour(h) {
  const hz = Array.isArray(h.hazards) ? h.hazards : [];
  const title = `${h.local}: ${hz.map((x) => x.text).join('; ') || 'no hazard'}`;
  const time = String(h.local ?? '').split(', ').pop();
  return `<div class="wx-h safety-h ${esc(h.risk)}" title="${esc(title)}">
    <div>${esc(time)}</div><div class="sc">${RISK_ICON[h.risk] ?? ''}</div><div>${esc(temp(h.temperatureC))}</div><div title="cloud cover (seeing the sky is the Tonight tab's score)">☁${esc(h.cloudTotal ?? '–')}%</div>
    <div class="rain ${h.precipProbability >= 50 ? 'high' : h.precipProbability >= 20 ? 'mid' : ''}">🌧${esc(h.precipProbability)}%</div><div>🌬${esc(speedN(h.gustKmh))}</div><div>💧${esc(delta(h.dewSpreadC))}</div></div>`;
}

async function loadSafety() {
  const el = $('#safety');
  const mine = ++safetySeq;
  try {
    const r = await api('weather/safety');
    if (mine !== safetySeq) return;
    const age = r.stale ? `<span class="wx-age"> · forecast from ${esc(r.ageMin)} min ago${r.staleError ? ` (refresh failed: ${esc(r.staleError)})` : ''}</span>` : '';
    const lines = (r.report ?? []).map((l) => `<div class="safety-line ${esc(l.risk)}"><b><i class="dot"></i>${esc(l.subject)}</b><span>${esc(l.text)}</span></div>`).join('');
    // the safety verdict is about the equipment, not the sky: say how cloudy the night is beside it
    const clouds = (r.hours ?? []).map((h) => h.cloudTotal).filter((c) => typeof c === 'number');
    const meanCloud = clouds.length ? Math.round(clouds.reduce((a, b) => a + b, 0) / clouds.length) : null;
    const sky = meanCloud === null ? '' : `<div class="safety-line ${meanCloud >= 70 ? 'caution' : 'safe'}"><b><i class="dot"></i>Sky</b><span>${meanCloud >= 70 ? 'Mostly cloudy' : meanCloud >= 30 ? 'Partly cloudy' : 'Mostly clear'}: ${meanCloud}% cloud on average overnight. Safety is not seeing — the Tonight tab scores the sky for imaging.</span></div>`;
    el.innerHTML = `<h3>Tonight at the telescope</h3>
      <div class="safety-verdict ${esc(r.risk)}">${esc(r.verdict)}</div>
      <div class="muted small">${esc(r.night?.from ?? '–')} → ${esc(r.night?.to ?? '–')} · alarm limits: gusts ${esc(speed(r.limits?.gustKmh))}, rain chance ${esc(r.limits?.probabilityPct)}%, cold ${esc(temp(r.limits?.minTempC))}${age}</div>
      <div class="safety-report">${lines}${sky}</div>
      <div class="wx-strip">${(r.hours ?? []).map(safetyHour).join('')}</div>
      <div class="muted small">✓ safe · ! with care · ✕ bring it in (equipment safety, not seeing) — temperature · ☁ cloud cover · 🌧 precipitation chance · 🌬 gusts ${esc(speedUnit())} · 💧 dew-point spread · Open-Meteo</div>`;
  } catch (e) {
    if (mine === safetySeq) el.innerHTML = `<h3>Tonight at the telescope</h3><span class="muted">${esc(e.message)}</span>`;
  }
}

// ---------------------------------------------------------------- imagery
const radar = new WxMap($('#map-radar'), { minZoom: 4, maxZoom: 7, zoom: 7 });
const sat = new WxMap($('#map-sat'), { minZoom: 3, maxZoom: 6, zoom: 5 });
let imageryAt = 0;
let playing = true;

const siteNow = () => guard?.site ?? (state.config?.observer ? { lat: state.config.observer.lat, lon: state.config.observer.lon } : null);
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The geostationary satellite that sees the site, as a GIBS infrared layer; null where none does. */
function satLayer(lon) {
  if (lon >= -165 && lon < -105) return 'GOES-West_ABI_Band13_Clean_Infrared';
  if (lon >= -105 && lon <= -15) return 'GOES-East_ABI_Band13_Clean_Infrared';
  if (lon >= 75 || lon < -165) return 'Himawari_AHI_Band13_Clean_Infrared';
  return null;
}

async function loadRadar(site) {
  try {
    const res = await fetch(RAINVIEWER, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const past = Array.isArray(j?.radar?.past) ? j.radar.past : [];
    const host = typeof j?.host === 'string' && j.host.startsWith('https://') ? j.host : null;
    if (!host || !past.length) throw new Error('no radar frames');
    radar.show(site, past.map((f) => ({ label: hhmm(f.time * 1000), url: (z, x, y) => `${host}${f.path}/256/${z}/${x}/${y}/2/1_1.png` })));
  } catch (e) {
    radar.message(`radar unavailable: ${e.message}`);
  }
}

async function loadSat(site) {
  const layer = satLayer(site.lon);
  if (!layer) return sat.message('no geostationary infrared imagery covers this longitude on NASA GIBS');
  const tile = (time) => (z, x, y) => `${GIBS}/${layer}/default/${time}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
  // ask for the latest tile once to learn its time, then step back from it: one consistent loop
  let latest = null;
  try {
    const res = await fetch(tile('default')(0, 0, 0), { cache: 'no-store' });
    const t = Date.parse(res.headers.get('layer-time-actual') ?? '');
    if (Number.isFinite(t)) latest = t;
  } catch {
    /* fall back to the server's latest, unlabelled */
  }
  const name = layer.split('_')[0];
  if (latest === null) return sat.show(site, [{ label: 'latest', url: tile('default') }], name);
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const frames = [];
  for (let i = SAT_FRAMES - 1; i >= 0; i--) {
    const t = latest - i * SAT_STEP_MS;
    frames.push({ label: hhmm(t), url: tile(iso(t)) });
  }
  sat.show(site, frames, name);
}

async function loadImagery(force = false) {
  if (!force && Date.now() - imageryAt < IMAGERY_REFRESH_MS) return;
  const site = siteNow();
  if (!site) {
    radar.message('the observer location is unknown');
    sat.message('the observer location is unknown');
    return;
  }
  imageryAt = Date.now();
  await Promise.all([loadRadar(site), loadSat(site)]);
  radar.play(playing);
  sat.play(playing);
}

$('#btn-wx-play').onclick = (e) => {
  playing = !playing;
  e.currentTarget.textContent = playing ? 'Pause' : 'Play';
  e.currentTarget.setAttribute('aria-pressed', String(playing));
  radar.play(playing);
  sat.play(playing);
};
$('#btn-wx-reload').onclick = () => {
  loadImagery(true);
  loadSafety();
};

// ---------------------------------------------------------------- tab life
on('tab', (name) => {
  if (name !== 'weather') return;
  loadSafety();
  loadImagery();
  if (!guard) api('guard').then(renderGuardState, (e) => ($('#guard-text').textContent = e.message));
});
on('screen', (name) => {
  // the loops cost nothing on screen but CPU in a pocket
  if (name !== 'weather') {
    radar.stop();
    sat.stop();
  } else {
    radar.play(playing);
    sat.play(playing);
  }
});

export function startGuardWatch() {
  setInterval(watchdog, WATCHDOG_MS);
  setInterval(() => {
    if (isPanelActive('weather')) {
      loadSafety();
      loadImagery();
    }
  }, SAFETY_POLL_MS);
  // the "x min ago" figures age between messages
  setInterval(() => guard && isPanelActive('weather') && renderGuard(), 60e3);
}
