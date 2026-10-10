/* Astrocontroller UI — vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDur = (s) => (s == null ? '–' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

const state = { telescope: null, agent: null, history: [], jobs: new Map(), config: null, attachments: [], mainSrc: 'tele', albumPage: 0, proc: new Map(), procInfo: null };

// ------------------------------------------------------------------ helpers
async function api(path, body, method) {
  const res = await fetch(`api/${path}`, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 2500);
}

async function control(body, label) {
  try {
    const r = await api('control', body);
    if (label) toast(typeof r.result === 'string' ? r.result : `${label} ✓`);
    return r;
  } catch (e) {
    toast(`${label ?? body.action}: ${e.message}`, true);
  }
}

function lightbox(src, caption = '') {
  const lb = $('#lightbox');
  $('img', lb).src = src;
  $('.lb-caption', lb).textContent = caption;
  lb.hidden = false;
}
$('#lightbox').onclick = () => ($('#lightbox').hidden = true);

let markedReady = false;
const md = (text) => {
  if (!window.marked) return `<p>${esc(text)}</p>`;
  if (!markedReady) {
    // Never render raw HTML from the model.
    window.marked.use({ renderer: { html: (t) => esc(t.text ?? t.raw ?? '') } });
    markedReady = true;
  }
  return window.marked.parse(text, { breaks: true, gfm: true });
};

// ------------------------------------------------------------------ app shell
//
// A phone shows one screen at a time and the bottom bar drives it; at desk widths the live view
// is always up-left and the section stack sits on the right. app.js's own tab handler keeps the
// .active classes (and loads each screen's data), so this only mirrors that state onto the two
// navs, <body data-screen>, the menus and the video subscription.
const wideMq = window.matchMedia('(min-width: 1000px)');
const viewOnScreen = () => wideMq.matches || $('#panel-view').classList.contains('active');
const screenName = () => ($$('.panel').find((p) => p.classList.contains('active') && p.id !== 'panel-view') || { id: 'panel-view' }).id.slice(6);
const storedScreen = () => {
  try { return localStorage.getItem('screen'); } catch { return null; }
};

// Which .panel classes a tab tap should set. At desk widths the live view is a fixed column that
// stays up whatever section is showing, and the View tab (bottom bar only) leaves the section alone.
function applyTabSelection(name) {
  const wide = wideMq.matches;
  for (const p of $$('.panel')) {
    if (p.id === 'panel-view') p.classList.toggle('active', name === 'view' || wide);
    else if (!(name === 'view' && wide)) p.classList.toggle('active', p.id === `panel-${name}`);
  }
}

function reflectScreen() {
  const name = screenName();
  document.body.dataset.screen = name;
  const inMore = name === 'database' || name === 'library' || name === 'skills' || name === 'log';
  for (const t of $$('#tabbar .tab')) {
    const on = t.dataset.tab === name || (t.id === 'btn-more' && inMore);
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  }
  for (const t of $$('.tabs-top .tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const t of $$('.sheet-item')) t.classList.toggle('active', t.dataset.tab === name);
  if (name !== 'view') {
    try { localStorage.setItem('screen', name); } catch {}
  }
  // A phone that is looking at something else should not keep the telescope streaming frames.
  videoSubscribe();
}

// Programmatic screen change: clicking the tab is the one path that also loads its data.
const showScreen = (name) => $(`.tab[data-tab="${name}"]`)?.click();

function closeOverlays() {
  $('#menu').classList.remove('open');
  $('#btn-menu').setAttribute('aria-expanded', 'false');
  $('#sheet-more').hidden = true;
  $('#btn-more').setAttribute('aria-expanded', 'false');
}

$('#btn-menu').onclick = (e) => {
  e.stopPropagation();
  $('#sheet-more').hidden = true;
  const open = $('#menu').classList.toggle('open');
  $('#btn-menu').setAttribute('aria-expanded', String(open));
};
$('#menu').onclick = (e) => {
  // picking an action dismisses the popover: on a phone it covers the screen it came from
  if (e.target.closest('button')) { $('#menu').classList.remove('open'); $('#btn-menu').setAttribute('aria-expanded', 'false'); }
};
$('#btn-more').onclick = (e) => {
 e.stopPropagation(); // the document handler closes overlays on any tap; this one owns the sheet
 const show = $('#sheet-more').hidden;
 closeOverlays();
 $('#sheet-more').hidden = !show;
 $('#btn-more').setAttribute('aria-expanded', String(show));
};
$('#sheet-more').onclick = (e) => {
  if (e.target.closest('[data-close]')) closeOverlays();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#btn-menu, #menu')) {
    $('#menu').classList.remove('open');
    $('#btn-menu').setAttribute('aria-expanded', 'false');
  }
  if (e.target.closest('.tab')) {
    $('#sheet-more').hidden = true;
    $('#btn-more').setAttribute('aria-expanded', 'false');
    reflectScreen();
  }
});

// ---- full-bleed live view
// The Fullscreen API where it exists (desktop, Android Chrome); iOS Safari has no element
// fullscreen, so an in-page mode covers the same need. Pinch zooms, drag pans, double-tap toggles.
let fullMode = false;
const zoom = { s: 1, x: 0, y: 0 };
function applyZoom(fig) {
  $('img', fig).style.transform = zoom.s > 1.02 ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` : '';
  fig.classList.toggle('zoomed', zoom.s > 1.02);
}
function setZoom(fig, s, x, y) {
  zoom.s = Math.max(1, Math.min(5, s));
  const r = fig.getBoundingClientRect();
  zoom.x = zoom.s <= 1.02 ? 0 : Math.min(0, Math.max(r.width * (1 - zoom.s), x));
  zoom.y = zoom.s <= 1.02 ? 0 : Math.max(r.height * (1 - zoom.s), Math.min(0, y));
  applyZoom(fig);
}
function exitFull() {
  if (!fullMode) return;
  fullMode = false;
  document.body.classList.remove('view-full');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  zoom.s = 1; zoom.x = 0; zoom.y = 0;
  applyZoom($('#view-main'));
}
async function enterFull() {
  if (fullMode) return;
  fullMode = true;
  document.body.classList.add('view-full'); // the chrome (nav, hints, buttons) keys off this in both modes
  const fig = $('#view-main');
  if (fig.requestFullscreen) {
    try { await fig.requestFullscreen(); } catch { /* iOS: the in-page mode already filled the screen */ }
  }
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) exitFull(); });
// Esc is promised by the ⛶ button's tooltip and by the README, and it is the only way out of the
// in-page mode on a keyboard. Topmost thing wins: the lightbox, then the enlarged live view.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
  if (fullMode) exitFull();
});

function attachViewGestures(fig) {
  const pts = new Map();
  let tap = { t: 0, x: 0, y: 0 }, press = null, pinch = null;
  const pair = () => [...pts.values()];
  fig.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType !== 'mouse') fig.setPointerCapture(e.pointerId);
    if (pts.size === 1) press = { x: e.clientX, y: e.clientY, t: Date.now(), moved: 0 };
    else if (pts.size === 2 && fullMode) {
      const [a, b] = pair();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s: zoom.s, x: zoom.x, y: zoom.y };
    }
  });
  fig.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (press) press.moved = Math.max(press.moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
    if (pinch && pts.size >= 2 && fullMode) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = pair();
      const s = ((pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch.d);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // keep the world point that was under the starting midpoint under the current one
      setZoom(fig, s, mx - ((pinch.mx - pinch.x) * s) / pinch.s, my - ((pinch.my - pinch.y) * s) / pinch.s);
      return;
    }
    if (fullMode && zoom.s > 1.02) setZoom(fig, zoom.s, zoom.x + (e.clientX - p.x), zoom.y + (e.clientY - p.y));
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const lifted = (e) => {
    const before = pts.size;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    const clean = before === 1 && press && press.moved < 14;
    if (!fullMode) {
      if (clean && e.pointerType !== 'mouse' && Date.now() - press.t < 450 && !e.target.closest('button')) enterFull();
      press = null;
      return;
    }
    const now = Date.now();
    if (clean && !e.target.closest('button') && now - tap.t < 330) {
      if (zoom.s > 1.02) setZoom(fig, 1, 0, 0);
      else setZoom(fig, 2.6, e.clientX * (1 - 2.6), e.clientY * (1 - 2.6));
      tap.t = 0;
    } else tap = { t: now, x: e.clientX, y: e.clientY };
    if (pts.size === 0) press = null;
  };
  fig.addEventListener('pointerup', lifted);
  fig.addEventListener('pointercancel', lifted);
}

// ---- the keyboard, in-page scrollers and the composer
const vv = window.visualViewport;
function fitViewport() {
  // iOS keeps the layout viewport full height when the keyboard opens, which would push the
  // composer under it; Chrome shrinks the layout viewport itself, so only correct the delta.
  const shrink = window.innerHeight - (vv ? vv.height : window.innerHeight);
  document.documentElement.style.setProperty('--vh', shrink > 60 ? `${Math.round(vv.height + vv.offsetTop)}px` : '');
}
if (vv) {
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
}
function grow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.34))}px`;
}
$('#prompt').addEventListener('input', (e) => grow(e.target));

// ---- layout boot
function layoutBoot() {
  if (wideMq.matches) $$('.group').forEach((g) => (g.open = true));
  const remember = storedScreen();
  if (wideMq.matches) {
    if (screenName() === 'view') showScreen(remember && remember !== 'view' ? remember : 'chat');
  } else {
    showScreen(remember && remember !== 'view' ? remember : 'view');
  }
  reflectScreen();
}
wideMq.addEventListener('change', layoutBoot);
window.addEventListener('orientationchange', () => setTimeout(layoutBoot, 250));
// (layoutBoot runs from the boot section: it touches the live-view state, which is declared below)
fitViewport();

// ------------------------------------------------------------------ websocket
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    setConn(false, 'UI disconnected');
    setTimeout(connect, 2000);
  };
}

function handle(m) {
  switch (m.type) {
    case 'hello':
      state.config = m.config;
      state.history = m.history ?? [];
      (m.jobs ?? []).forEach((j) => state.jobs.set(j.id, j));
      renderTelescope(m.telescope);
      renderHost();
      renderAgentStatus(m.agent);
      renderDuty(m.duty);
      renderChat();
      renderJobs();
      (m.processing ?? []).forEach((i) => state.proc.set(i.id, i));
      renderProcessing();
      $('#log').innerHTML = '';
      (m.logs ?? []).forEach(addLog);
      break;
    case 'telescope':
      renderTelescope(m.state);
      break;
    case 'config':
      state.config = m.config;
      renderHost();
      break;
    case 'agentStatus':
      renderAgentStatus(m.status);
      break;
    case 'duty':
      renderDuty(m.duty);
      break;
    case 'agent':
      onAgentEvent(m.event);
      break;
    case 'log':
      addLog(m.entry);
      break;
    case 'job':
      state.jobs.set(m.job.id, m.job);
      renderJobs();
      break;
    case 'processing':
      if (m.item) state.proc.set(m.item.id, m.item);
      renderProcessing();
      break;
    case 'capture':
      addCapture(m.path, m.label);
      break;
    case 'notify':
      if (m.name === 'albumUpdate' && $('#panel-album').classList.contains('active')) loadAlbum();
      break;
    case 'error':
      toast(m.message, true);
      break;
    case 'streams':
      renderStreamHealth(m.streams);
      break;
  }
}

// ------------------------------------------------------------------ telescope state
function setConn(ok, text) {
  const c = $('#chip-conn');
  c.classList.toggle('ok', ok);
  $('span', c).textContent = text;
}

function renderTelescope(t) {
  if (!t) return;
  state.telescope = t;
  setConn(t.connected, t.connected ? (t.device?.name ?? 'connected') : t.released ? 'released' : 'telescope offline');
  const lb = $('#btn-link');
  lb.textContent = t.released ? 'Connect' : 'Disconnect';
  lb.classList.toggle('primary', !!t.released);
  lb.classList.toggle('ghost', !t.released);
  $('#chip-battery').textContent = t.battery == null ? '🔋 –' : `🔋 ${t.battery}%${t.charging ? ' ⚡' : ''}`;
  $('#chip-temp').textContent = t.temperatureC == null ? '🌡 –' : `🌡 ${t.temperatureC}° body · ${t.cmosTempC?.tele ?? '–'}° sensor`;
  $('#chip-mode').textContent = t.shootingMode?.name ?? 'mode –';
  const m = t.motors ?? {};
  const mount = t.bodyMode === 'eq' ? 'EQ' : t.bodyMode === 'altaz' ? 'Alt-Az' : 'mount';
  $('#chip-mount').textContent = m.homed === false ? `${mount} · not homed` : m.pitchDeg != null ? `${mount} · rot ${m.rotationDeg}° pitch ${m.pitchDeg}°` : mount;
  $('#chip-sd').textContent = t.storage ? `SD ${t.storage.availableGB}/${t.storage.totalGB} GB` : 'SD –';
  if (t.shootingMode?.name) {
    const sel = $('#sel-mode');
    if (document.activeElement !== sel) sel.value = t.shootingMode.name;
  }

  const g = [
    ['Calibration', `${t.calibration?.state ?? '–'}${t.calibration?.result ? ` (az ${t.calibration.result.azimuth.toFixed(1)}°, alt ${t.calibration.result.altitude.toFixed(1)}°)` : ''}`],
    ['GoTo', `${t.goto?.state ?? '–'}${t.goto?.target ? ` · ${t.goto.target}` : ''}`],
    ['Tracking', `${t.tracking?.state ?? '–'}${t.tracking?.target ? ` · ${t.tracking.target}` : ''}`],
    ['Focus', t.focusPosition ?? '–'],
    ['Autofocus', `${t.autofocus?.state ?? '–'}${t.autofocus?.astro ? ` / astro ${t.autofocus.astro}` : ''}`],
    ['Polar align', t.eqSolving?.result ? `az ${(t.eqSolving.result.azimuthErrorDeg * 60).toFixed(1)}′ alt ${(t.eqSolving.result.altitudeErrorDeg * 60).toFixed(1)}′` : t.eqSolving?.state ?? '–'],
    ['FOV tele', t.fov?.tele ? `${t.fov.tele.h}°×${t.fov.tele.v}°` : '–'],
    ['Capture', Object.entries(t.capture ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'idle'],
    ['Sentry', t.sentry?.state ?? '–'],
    ['Firmware', t.device?.firmware ?? '–'],
  ];
  if (state.config?.observer) g.push(['Observer', `${state.config.observer.lat.toFixed(3)}, ${state.config.observer.lon.toFixed(3)}`]);
  $('#status-grid').innerHTML = g.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('');
  renderFocusTune(t);

  updateTeleBox();
  const recording = /running/.test(t.capture?.record ?? '');
  const rb = $('#btn-record');
  if (!rb.disabled) {
    rb.classList.toggle('on', recording);
    rb.textContent = recording ? '■ Stop rec' : '● Record';
  }
  if (stackActive() !== stackWasActive) {
    stackWasActive = stackActive();
    videoSubscribe();
    if (!stackWasActive) {
      delete blobUrls.stack;
      for (const [slot, src] of Object.entries(views)) if (src === 'stack') setView(slot, 'stack');
    }
  }
  const s = t.stacking?.tele?.state === 'running' || t.stacking?.tele?.currentCount ? t.stacking.tele : t.stacking?.wide?.state === 'running' ? t.stacking.wide : null;
  const bar = $('#stackbar');
  if (s && (s.state === 'running' || s.state === 'stopping' || s.currentCount)) {
    bar.hidden = false;
    $('#stack-target').textContent = `${s.state === 'running' ? 'Stacking' : 'Stack'} · ${s.target ?? 'target'}`;

    const pct = s.totalCount ? Math.min(100, (100 * (s.currentCount ?? 0)) / s.totalCount) : 0;
    $('#stack-progress').style.width = `${pct}%`;
    $('#stack-text').textContent = `${s.stackedCount ?? 0} stacked / ${s.currentCount ?? 0} taken${s.totalCount && s.totalCount < 999 ? ` of ${s.totalCount}` : ''}`;
    const rejected = (s.currentCount ?? 0) - (s.stackedCount ?? 0);
    $('#stack-stats').innerHTML = [`integration ${fmtDur(s.stackedTimeS)}`, `elapsed ${fmtDur(s.shootingTimeS)}`, `rejected ${rejected}`, `state ${s.state}`].map((x) => `<span>${x}</span>`).join('');
    $('#meta-stack').textContent = `${s.stackedCount ?? 0} frames`;
  } else {
    bar.hidden = true;
  }
}

/** The Focus group's readout line: what the last measurement said, or where a search has got to. */
function renderFocusTune(t) {
  const ft = t?.focusTune;
  $$('#grp-focus button').forEach((b) => (b.disabled = !!ft?.running));
  if (!ft?.message) return;
  const when = new Date(ft.finishedAt ?? ft.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#focus-note').textContent = ft.running ? `Star tune: ${ft.message}` : `${when} · ${ft.message}`;
}

// ------------------------------------------------------------------ live views
// Frames arrive over a dedicated WebSocket (/ws/video): [u8 source][f64 capture ms][JPEG].
// It reconnects by itself, so a server restart or network blip never leaves a view frozen.
const views = { main: 'tele', a: 'wide', b: 'stack' };
const SOURCES = ['tele', 'wide', 'stack'];
const lastFrame = { tele: 0, wide: 0, stack: 0 }; // local receive time per source
const blobUrls = {};
let videoWs = null;
let videoRetry = 0;
let stackWasActive = false;
function stackActive() {
  const s = state.telescope?.stacking;
  return !!s && (['running', 'stopping'].includes(s.tele?.state) || ['running', 'stopping'].includes(s.wide?.state));
}

function wantedSources() {
  // A phone that is looking at another screen does not need frames: the telescope and the Wi-Fi
  // both get a rest while you read the plan.
  if (document.hidden || !viewOnScreen()) return [];
  // The stack feed only means something while stacking (otherwise it mirrors the tele preview).
  return [...new Set(Object.values(views))].filter((s) => s !== 'stack' || stackActive());
}

function videoSubscribe() {
  if (videoWs?.readyState === 1) videoWs.send(JSON.stringify({ type: 'subscribe', sources: wantedSources() }));
}

function connectVideo() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws/video`);
  ws.binaryType = 'arraybuffer';
  videoWs = ws;
  ws.onopen = () => {
    videoRetry = 0;
    videoSubscribe();
  };
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength < 10) return;
    const dv = new DataView(ev.data);
    const src = SOURCES[dv.getUint8(0)];
    if (!src) return;
    lastFrame[src] = Date.now();
    const url = URL.createObjectURL(new Blob([new Uint8Array(ev.data, 9)], { type: 'image/jpeg' }));
    const old = blobUrls[src];
    blobUrls[src] = url;
    for (const [slot, s] of Object.entries(views)) {
      if (s !== src) continue;
      const img = $(slot === 'main' ? '#img-main' : `#img-${slot}`);
      img.src = url;
      img.style.visibility = 'visible';
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  };
  ws.onclose = () => {
    videoWs = null;
    setTimeout(connectVideo, Math.min(500 * 2 ** videoRetry++, 5000));
  };
}

function setView(slot, src) {
  views[slot] = src;
  const img = $(slot === 'main' ? '#img-main' : `#img-${slot}`);
  const fig = img.closest('figure');
  fig.dataset.src = src;
  $('.view-name', fig).textContent = src[0].toUpperCase() + src.slice(1);
  // Show this source's latest frame immediately if we have one; otherwise the placeholder.
  if (blobUrls[src]) {
    img.src = blobUrls[src];
    img.style.visibility = 'visible';
  } else {
    img.removeAttribute('src');
    img.style.visibility = 'hidden';
  }
  updateTeleBox();
  if (slot === 'main') {
    state.mainSrc = src;
    // Capture defaults to whichever camera is in the main view.
    if (src === 'tele' || src === 'wide') $('#cap-cam').value = src;
    $('#empty-main').textContent = src === 'stack' ? 'no live-stacking image yet' : 'waiting for video…';
  }
  videoSubscribe();
}

// Per-view health: age of the last frame actually received, plus the server's note for that source.
let serverStreams = {};
function renderStreamHealth(streams) {
  if (streams) serverStreams = streams;
  for (const fig of $$('figure.view')) {
    const src = fig.dataset.src;
    const st = serverStreams[src];
    let tag = $('.stale', fig);
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'stale';
      fig.appendChild(tag);
    }
    const age = lastFrame[src] ? Math.round((Date.now() - lastFrame[src]) / 1000) : null;
    let text = '';
    if (!videoWs) text = '⚠ video connection lost — reconnecting…';
    else if (st?.note) text = `ℹ ${st.note}`;
    else if (src === 'stack' && !stackActive()) text = 'no live stack running';
    else if (age === null) text = '⚠ waiting for first frame…';
    else if (age > 6) text = `⚠ no new frames for ${age}s`;
    tag.hidden = !text;
    if (tag.dataset.text !== text) {
      tag.dataset.text = text;
      tag.textContent = text;
    }
  }
}
setInterval(() => renderStreamHealth(), 1000);

// Green rectangle on wide views showing the tele field. teleInWide comes from the
// telescope's own tele↔wide matching: top-left x/y + size in the 1920×1080 wide frame.
function updateTeleBox() {
  const r = state.telescope?.teleInWide;
  for (const fig of $$('figure.view')) {
    let box = $('.tele-box', fig);
    if (!box) {
      box = document.createElement('div');
      box.className = 'tele-box';
      box.title = 'tele field of view';
      fig.appendChild(box);
    }
    const show = fig.dataset.src === 'wide' && r && r.width > 0;
    box.hidden = !show;
    if (show) {
      Object.assign(box.style, {
        left: `${(r.x / 1920) * 100}%`,
        top: `${(r.y / 1080) * 100}%`,
        width: `${(r.width / 1920) * 100}%`,
        height: `${(r.height / 1080) * 100}%`,
      });
    }
  }
}
$$('[data-swap]').forEach((b) =>
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = b.dataset.swap;
    if (target === views.main) return;
    const other = Object.entries(views).find(([, v]) => v === target)?.[0];
    if (other) setView(other, views.main);
    setView('main', target);
  }),
);
for (const slot of ['a', 'b']) {
  $(`#view-${slot}`).addEventListener('click', () => {
    const src = views[slot];
    setView(slot, views.main);
    setView('main', src);
  });
}
// Enlarging the live view: a tap on it, or the ⛶ chip. Where the Fullscreen API exists that is
// what you get; elsewhere (iOS) the in-page mode fills the screen the same way.
$('#btn-fullscreen').onclick = (e) => {
  e.stopPropagation();
  if (fullMode) exitFull();
  else enterFull();
};
$('#btn-unfull').onclick = (e) => {
  e.stopPropagation();
  exitFull();
};
$('#view-main').addEventListener('dblclick', (e) => {
  if (fullMode || e.target.closest('button')) return;
  lightbox(`api/snapshot/${state.mainSrc}?t=${Date.now()}`, state.mainSrc);
});
attachViewGestures($('#view-main'));

// Hidden tab: unsubscribe (saves the telescope and network); visible again: resubscribe.
document.addEventListener('visibilitychange', videoSubscribe);

// ------------------------------------------------------------------ manual controls
let nudgeTimer = null;
function startNudge(angle) {
  const speed = Number($('#speed').value);
  const tick = () => control({ action: 'nudge', angle, speed, ms: 700 });
  tick();
  nudgeTimer = setInterval(tick, 550);
}
function stopNudge() {
  if (!nudgeTimer) return;
  clearInterval(nudgeTimer);
  nudgeTimer = null;
  control({ action: 'stop' });
}
$$('[data-nudge]').forEach((b) => {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    startNudge(Number(b.dataset.nudge));
  });
  b.addEventListener('pointerup', stopNudge);
  b.addEventListener('pointercancel', stopNudge);
});
$('#btn-stop').onclick = () => control({ action: 'stop' }, 'Stopped');
$$('[data-act]').forEach((b) =>
  b.addEventListener('click', async () => {
    const act = b.dataset.act;
    b.disabled = true;
    try {
      if (act === 'autofocus') await control({ action: 'autofocus', mode: 'normal' }, 'Autofocus');
      else if (act === 'autofocus-astro') await control({ action: 'autofocus', mode: 'astro' }, 'Astro autofocus');
      else if (act === 'photo') {
        const r = await control({ action: 'photo', camera: b.dataset.camera }, null);
        if (r?.item) toast(`saved ${r.item.filePath.split('/').pop()}`);
      } else await control({ action: act }, b.textContent.trim());
    } finally {
      b.disabled = false;
    }
  }),
);

// Stars and focus: Sharpness measures the current focus, Tune searches around it. The search takes a
// couple of minutes; its per-step progress arrives over the state socket (renderFocusTune).
$('#btn-star-measure').onclick = () => control({ action: 'star_measure' }, 'Star sharpness');
$('#btn-star-tune').onclick = async () => {
  const range = Number($('#sel-tune-range').value);
  const b = $('#btn-star-tune');
  const at = state.telescope?.focusPosition;
  if (!confirm(`Tune the focus on the stars?\n\nThe focuser steps ±${range} around ${at ?? 'where it is now'} and takes a tele photo at every step — about ${Math.round((range / 5) * 2 + 1)} photos, a couple of minutes — then stops on the sharpest. Run autofocus first if you have not tonight; it is the wide search, this is the fine one. Your camera exposure is restored afterwards.`)) return;
  b.classList.add('busy');
  try {
    await control({ action: 'star_sweep', range }, 'Star tune');
  } finally {
    b.classList.remove('busy');
  }
};
$$('[data-power]').forEach((b) =>
  b.addEventListener('click', async () => {
    const act = b.dataset.power;
    const busy = state.telescope?.stacking?.tele?.state === 'running' ? ' Live stacking is running and will be interrupted.' : '';
    if (!confirm(act === 'reboot' ? `Reboot the telescope?${busy} It reconnects in about a minute; the motors then need homing.` : `Shut the telescope down?${busy}`)) return;
    b.disabled = true;
    try {
      await control({ action: act }, act === 'reboot' ? 'Reboot' : 'Shut down');
    } finally {
      b.disabled = false;
    }
  }),
);
$('#btn-link').onclick = async () => {
  const released = !!state.telescope?.released;
  if (!released) {
    const running = [...state.jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
    if (!confirm(`Release the telescope? Astrocontroller closes every connection to it (control, video, transfers) until you press Connect.${running ? ` ${running} transfer(s) will be cancelled (run them again later; copied files are skipped).` : ''}`)) return;
  }
  try {
    const r = await api('link', { connect: released });
    toast(released ? 'Connecting…' : `Telescope released${r.cancelledTransfers ? `, ${r.cancelledTransfers} transfer(s) cancelled` : ''}`);
  } catch (e) {
    toast(e.message, true);
  }
};

// ---- telescope address
function renderHost() {
  const h = state.config?.telescopeHost;
  if (!h) return;
  const inp = $('#inp-host');
  if (document.activeElement !== inp) inp.value = h.host;
  $('#host-note').textContent = h.source === 'ui' ? `Set here (overrides DWARF_HOST ${h.envHost}; clear the field to go back to it).` : 'From DWARF_HOST in .env.';
}
$('#host-form').onsubmit = async (e) => {
  e.preventDefault();
  const host = $('#inp-host').value.trim();
  const target = host || state.config?.telescopeHost?.envHost;
  if (target === state.config?.telescopeHost?.host && (host || state.config?.telescopeHost?.source === 'env')) return toast(`Already using ${target}`);
  const busy = state.telescope?.stacking?.tele?.state === 'running' ? ' Live stacking is running and will be interrupted.' : '';
  if (state.telescope?.connected && !confirm(`Connect to the telescope at ${target}?${busy} The current connection is closed.`)) return;
  $('#btn-host').disabled = true;
  try {
    state.config = await api('telescope-host', { host });
    $('#inp-host').blur();
    renderHost();
    toast(state.telescope?.released ? `Address set to ${state.config.telescope} (press Connect)` : `Connecting to ${state.config.telescope}…`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#btn-host').disabled = false;
  }
};

// ---- duty loop
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function renderDuty(d) {
  if (!d) return;
  state.duty = d;
  const bar = $('#duty-bar');
  bar.className = `duty-bar ${d.status}`;
  $('#duty-state').textContent = d.status === 'active' ? 'On duty' : d.status === 'paused' ? 'Duty paused' : 'Duty off';
  const parts = [];
  if (d.status !== 'off') {
    if (d.untilLabel) parts.push(`until ${d.untilLabel}`);
    if (d.status === 'active') parts.push(d.nextWakeAt ? `next sample ${clock(d.nextWakeAt)}` : 'next sample after this turn');
    if (d.status === 'paused' && d.pausedReason) parts.push(d.pausedReason);
    parts.push(`${d.wakes} wake${d.wakes === 1 ? '' : 's'}`);
  } else if (d.endedReason) parts.push(`last: ${d.endedReason}`);
  if (d.pendingEvents) parts.push(`${d.pendingEvents} event(s) waiting`);
  if (d.heldByStop) parts.push('automatic wakes held until you write to the agent');
  $('#duty-text').textContent = parts.join(' · ');
  bar.title = d.objective ? `Objective: ${d.objective}` : '';
  $('#btn-duty').textContent = d.status === 'off' ? 'Start duty…' : 'Stop duty';
  $('#btn-duty-pause').hidden = d.status === 'off';
  $('#btn-duty-pause').textContent = d.status === 'paused' ? 'Resume' : 'Pause';
  $('#btn-duty-wake').hidden = d.status !== 'active';
}
const dutyApi = (body) => api('duty', body).then(renderDuty).catch((e) => toast(e.message, true));
$('#btn-duty').onclick = () => {
  if (state.duty?.status && state.duty.status !== 'off') {
    if (confirm(`Stop the duty?\n\n${state.duty.objective ?? ''}`)) dutyApi({ action: 'stop' });
    return;
  }
  $('#duty-form').hidden = !$('#duty-form').hidden;
  if (!$('#duty-form').hidden) $('#duty-objective').focus();
};
$('#btn-duty-pause').onclick = () => dutyApi({ action: state.duty?.status === 'paused' ? 'resume' : 'pause' });
$('#btn-duty-wake').onclick = () => dutyApi({ action: 'wake' });
$('#duty-cancel').onclick = () => ($('#duty-form').hidden = true);
$('#duty-until').onchange = () => ($('#duty-time').hidden = $('#duty-until').value !== 'time');
$('#duty-form').onsubmit = async (e) => {
  e.preventDefault();
  const sel = $('#duty-until').value;
  const until = sel === 'time' ? $('#duty-time').value : sel;
  if (sel === 'time' && !until) return toast('pick an end time', true);
  const objective = $('#duty-objective').value.trim();
  if (!objective) return toast('write the objective', true);
  await dutyApi({ action: 'start', objective, until, intervalS: Math.round(Number($('#duty-interval').value || 5) * 60) });
  $('#duty-form').hidden = true;
  $('#duty-objective').value = '';
};

// ---- capture
async function capture(btn, body, label) {
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    const r = await api('control', body);
    if (r.item) toast(`📷 saved ${r.item.filePath.split('/').pop()}`);
    else if (r.result) toast(r.result);
    else toast(`${label} ✓`);
    if ($('#panel-album').classList.contains('active')) loadAlbum();
    return r;
  } catch (e) {
    toast(`${label}: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}
$('#btn-photo').onclick = () => capture($('#btn-photo'), { action: 'photo', camera: $('#cap-cam').value }, 'Photo');
$('#btn-burst').onclick = () => capture($('#btn-burst'), { action: 'burst', camera: $('#cap-cam').value, count: Number($('#inp-burst').value) || 10 }, 'Burst');
$('#btn-record').onclick = async () => {
  const b = $('#btn-record');
  const on = b.classList.contains('on');
  const r = await capture(b, { action: 'record', camera: $('#cap-cam').value, on: !on }, on ? 'Stop recording' : 'Record');
  if (r) {
    b.classList.toggle('on', !on);
    b.textContent = on ? '● Record' : '■ Stop rec';
  }
};
$('#btn-stack').onclick = () => {
  if (!confirm('Start live stacking with the current DSO settings? (Point at the target with GoTo first — the agent can do the whole workflow for you.)')) return;
  capture($('#btn-stack'), { action: 'stack_start', camera: $('#cap-cam').value }, 'Stacking');
};

$$('[data-focus]').forEach((b) => b.addEventListener('click', () => control({ action: 'focus', direction: b.dataset.focus, steps: 3 }, 'Focus')));
$('#sel-mode').onchange = (e) => control({ action: 'mode', mode: e.target.value }, `Mode ${e.target.value}`);
$('#btn-apply').onclick = async () => {
  const camera = $('#sel-cam').value;
  const exp = $('#inp-exp').value.trim();
  const gain = $('#inp-gain').value.trim();
  if (exp) await control({ action: 'setting', camera, setting: 'exposure', value: exp }, 'Exposure');
  if (gain) await control({ action: 'setting', camera, setting: 'gain', value: Number(gain) }, 'Gain');
};

// ------------------------------------------------------------------ tabs
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    if (!t.dataset.tab) return; // the More chip is a tab visually, but it opens a sheet, not a section
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    applyTabSelection(t.dataset.tab);
    const tab = t.dataset.tab;
    if (tab === 'tonight') {
      loadTonight();
      loadWeather();
    }
    if (tab === 'database') loadDatabase();
    if (tab === 'album') loadAlbum();
    if (tab === 'library') {
      loadLibrary();
      loadProcessing();
    }
    if (tab === 'skills') loadSkills();
  }),
);
$('#btn-night').onclick = () => {
  document.body.classList.toggle('night');
  localStorage.setItem('night', document.body.classList.contains('night') ? '1' : '');
};
try {
  if (localStorage.getItem('night')) document.body.classList.add('night');
} catch {}

// ------------------------------------------------------------------ agent chat
//
// The chat is rendered incrementally: every entry keeps its DOM element, and a streaming
// message only appends to its reasoning block and re-renders its own answer text, so an open
// reasoning block keeps its state and its scroll position. Whether the view follows new output
// is decided by the user's own scrolling (at the bottom = follow), and a ResizeObserver keeps it
// pinned while content grows (streaming text, tool results, images that load later).
const chatUI = {
  stick: true, // follow new output
  unseen: 0, // entries added while scrolled up
  thinkOpen: new Map(), // entry id -> the user's choice for its reasoning block
  toolOpen: new Map(), // entry id -> the user's choice for a tool block
  dirty: new Set(), // assistant entries with deltas not yet drawn
  frame: 0,
  lastPrompt: '',
};
const chatBox = $('#chat');
const chatInner = $('#chat-inner');
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const fmtSecs = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const nearBottom = (el, slack = 40) => el.scrollHeight - el.scrollTop - el.clientHeight <= slack;

function toBottom() {
  chatBox.scrollTop = chatBox.scrollHeight;
  lastTop = chatBox.scrollTop;
  chatUI.unseen = 0;
  updateJump();
}
function updateJump() {
  const b = $('#btn-jump');
  b.hidden = chatUI.stick;
  b.textContent = chatUI.unseen ? `↓ ${chatUI.unseen} new` : '↓ Latest';
}
// Any move up (wheel, touch, keys, scrollbar) stops following at once, before the next frame can
// pull the view down again; reaching the bottom resumes it.
let lastTop = 0;
const release = () => {
  if (!chatUI.stick) return;
  chatUI.stick = false;
  updateJump();
};
chatBox.addEventListener('wheel', (e) => {
  if (e.deltaY < 0) release();
}, { passive: true });
chatBox.addEventListener('touchmove', release, { passive: true });
chatBox.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) release();
});
chatBox.addEventListener('scroll', () => {
  const top = chatBox.scrollTop;
  if (top < lastTop - 2) chatUI.stick = nearBottom(chatBox, 4);
  else if (nearBottom(chatBox)) chatUI.stick = true;
  lastTop = top;
  if (chatUI.stick) chatUI.unseen = 0;
  updateJump();
}, { passive: true });
new ResizeObserver(() => {
  if (chatUI.stick) toBottom();
}).observe(chatInner);
$('#btn-jump').onclick = () => {
  chatUI.stick = true;
  toBottom();
};

// ---- status line, context, queue, todos
let statusTimer = 0;
function renderAgentStatus(s) {
  if (!s) return;
  state.agent = s;
  const el = $('#agent-status');
  el.className = `agent-status${s.busy ? ' busy' : ''}${!s.ready ? ' down' : ''}`;
  el.textContent = !s.ready ? `agent offline${s.error ? ` — ${s.error}` : ' (starting…)'}` : s.model;
  el.title = `${s.model} @ ${s.baseUrl}`;
  $('#sel-thinking').value = s.thinking;
  $('#btn-abort').hidden = !s.busy;
  $('#btn-queue').hidden = !s.busy;
  $('#btn-send').textContent = s.busy ? 'Steer' : 'Send';
  $('#btn-send').title = s.busy ? 'Enter: deliver now, at the agent\'s next step' : 'Enter';
  $('#prompt').placeholder = s.busy
    ? 'Steer the agent (Enter: now) or queue a follow-up (Alt+Enter: when it finishes)…'
    : 'Ask the agent… e.g. “What should I image tonight?” or “Raise the scope and show me the wide view”';
  const c = s.context;
  const ctx = $('#ctx');
  ctx.hidden = !c;
  if (c) {
    const pct = Math.round(c.percent);
    ctx.querySelector('i').style.width = `${Math.min(100, pct)}%`;
    ctx.className = `ctx${pct >= 80 ? ' high' : pct >= 60 ? ' mid' : ''}`;
    $('#ctx-text').textContent = `${pct}%`;
    ctx.title = `context ${c.tokens.toLocaleString()} of ${c.contextWindow.toLocaleString()} tokens${s.tokensPerSecond ? ` · ${s.tokensPerSecond.toFixed(1)} tok/s` : ''} — Compact summarises older history to free space`;
  }
  renderQueue(s.queue);
  renderTodos(s.todos ?? []);
  renderActivity();
  clearInterval(statusTimer);
  if (s.busy) statusTimer = setInterval(renderActivity, 1000);
  if (!s.busy) for (const id of [...chatUI.dirty]) flushAssistant(id);
}

function renderActivity() {
  const s = state.agent;
  const el = $('#activity');
  if (!s?.busy) {
    el.hidden = true;
    return;
  }
  const a = s.activity ?? { kind: 'thinking', since: Date.now() };
  const what = { thinking: 'Thinking', writing: 'Writing', tool: `Running ${a.tool ?? 'a tool'}`, compacting: 'Compacting context', retrying: 'Retrying the model request', idle: 'Working' }[a.kind] ?? 'Working';
  el.hidden = false;
  $('#activity-text').textContent = `${what} · ${fmtSecs(Date.now() - a.since)}${s.turnStartedAt ? ` (turn ${fmtSecs(Date.now() - s.turnStartedAt)})` : ''}`;
  for (const t of $$('.tool .tstate.running', chatInner)) {
    const at = Number(t.dataset.at);
    if (at) t.textContent = fmtSecs(Date.now() - at);
  }
}

function renderQueue(q) {
  const items = [...(q?.steering ?? []).map((m) => ['steering', m]), ...(q?.followUp ?? []).map((m) => ['followUp', m])];
  $('#queue-list').hidden = !items.length;
  $('#queue-list').innerHTML = items
    .map(([kind, m], i) => `<span class="qchip ${kind}" title="${esc(m)}">${kind === 'steering' ? 'steer' : 'queued'}: ${esc(m.length > 60 ? `${m.slice(0, 60)}…` : m)}<button type="button" data-q="${i}" title="remove">×</button></span>`)
    .join('');
  $('#queue-list').onclick = (e) => {
    const i = e.target.dataset?.q;
    if (i === undefined) return;
    const [queue, message] = items[Number(i)];
    api('agent/queue/remove', { message, queue }).catch((err) => toast(err.message, true));
  };
}

function renderTodos(phases) {
  const card = $('#todo-card');
  const tasks = phases.flatMap((p) => p.tasks ?? []);
  card.hidden = !tasks.length;
  if (!tasks.length) return;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const now = tasks.find((t) => t.status === 'in_progress');
  $('#todo-summary').textContent = `Plan · ${done}/${tasks.length} done${now ? ` · now: ${now.content}` : ''}`;
  const icon = { completed: '✓', in_progress: '▸', blocked: '⏸', abandoned: '✗', pending: '○' };
  $('#todo-list').innerHTML = phases
    .map((p) => `<div class="todo-phase">${phases.length > 1 ? `<b>${esc(p.name)}</b>` : ''}${(p.tasks ?? []).map((t) => `<div class="todo ${t.status}"><span>${icon[t.status] ?? '○'}</span>${esc(t.content)}${t.blocker ? ` <span class="muted">(${esc(t.blocker)})</span>` : ''}</div>`).join('')}</div>`)
    .join('');
}

// ---- entries
const domId = (id) => `e-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

function entryEl(e) {
  let el = document.getElementById(domId(e.id));
  if (!el) {
    el = document.createElement('div');
    el.id = domId(e.id);
    chatInner.appendChild(el);
    if (!chatUI.stick && e.kind !== 'notice') {
      chatUI.unseen++;
      updateJump();
    }
  }
  return el;
}

function renderEntry(e) {
  if (e.kind === 'assistant') return renderAssistant(e);
  const el = entryEl(e);
  if (e.kind === 'user' && /^\[Astrocontroller /.test(e.text)) {
    // a wake from the duty loop or an event: not something the user typed
    const [head, ...rest] = e.text.split('\n');
    const open = el.querySelector('details')?.open ?? false;
    el.className = 'msg auto';
    el.title = fmtClock(e.at);
    el.innerHTML = `<details${open ? ' open' : ''}><summary>${esc(head.replace(/^\[|\]$/g, ''))} · ${fmtClock(e.at)}</summary><pre>${esc(rest.join('\n').trim())}</pre></details>`;
  } else if (e.kind === 'user') {
    el.className = 'msg user';
    el.title = fmtClock(e.at);
    el.textContent = e.text + (e.images ? `  📎×${e.images}` : '');
  } else if (e.kind === 'tool') {
    renderTool(el, e);
  } else if (e.kind === 'notice') {
    el.className = `msg notice ${e.level}`;
    el.textContent = e.text;
  }
}

function renderTool(el, e) {
  el.className = 'tool-entry';
  const { i: argIntent, ...rest } = e.args ?? {};
  const intent = e.intent ?? argIntent;
  const args = Object.keys(rest).length ? JSON.stringify(rest) : '';
  const user = chatUI.toolOpen.get(e.id);
  const open = user ?? $('details', el)?.open ?? false;
  const state_ = e.status === 'running' ? `<span class="tstate running" data-at="${e.at}">${fmtSecs(Date.now() - e.at)}</span>` : e.status === 'ok' ? `<span class="tstate ok">✓ ${e.ms ? fmtSecs(e.ms) : ''}</span>` : '<span class="tstate error">✗ failed</span>';
  const errLine = e.status === 'error' && e.result ? `<div class="tool-err">${esc(e.result.split('\n')[0].slice(0, 200))}</div>` : '';
  el.innerHTML = `<details class="tool ${e.status}"${open ? ' open' : ''}><summary><span class="tname">${esc(e.name)}</span><span class="targs">${esc(intent ?? args)}</span>${state_}</summary>${args ? `<pre>${esc(JSON.stringify(rest, null, 1))}</pre>` : ''}${e.result ? `<pre class="tres">${esc(e.result)}</pre>` : ''}</details>${errLine}${(e.images ?? []).length ? `<div class="tool-images">${e.images.map((p) => `<img src="captures/${esc(p)}" data-cap="${esc(p)}" loading="lazy">`).join('')}</div>` : ''}`;
  $('summary', el).addEventListener('click', () => chatUI.toolOpen.set(e.id, !$('details', el).open));
}

function renderAssistant(e) {
  const el = entryEl(e);
  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = `<details class="thinking" hidden><summary></summary><pre class="t-body"></pre></details><div class="content"></div><div class="msg-meta"><time></time><button type="button" class="copy" title="copy the answer">copy</button></div>`;
    const det = $('details', el);
    $('summary', el).addEventListener('click', () => chatUI.thinkOpen.set(e.id, !det.open));
    $('.copy', el).addEventListener('click', () => {
      const cur = state.history.find((h) => h.id === e.id);
      navigator.clipboard?.writeText(cur?.text ?? '').then(() => toast('copied'), () => toast('copy failed', true));
    });
    el._thinkLen = 0;
    el._text = null;
  }
  el.className = `msg assistant${e.streaming ? ' typing' : ''}`;
  $('time', el).textContent = fmtClock(e.at);
  // reasoning: append what is new (no re-render: keeps the block's state and scroll)
  const det = $('details', el);
  const body = $('.t-body', el);
  if (e.thinking) {
    det.hidden = false;
    if (e.thinking.length < el._thinkLen) {
      body.textContent = '';
      el._thinkLen = 0;
    }
    if (e.thinking.length > el._thinkLen) {
      const follow = nearBottom(body, 24);
      body.append(e.thinking.slice(el._thinkLen));
      el._thinkLen = e.thinking.length;
      if (follow) body.scrollTop = body.scrollHeight;
    }
    const auto = !!e.streaming && !e.text; // open while it thinks, folded once it answers
    const open = chatUI.thinkOpen.get(e.id) ?? auto;
    if (det.open !== open) det.open = open;
    const thinkingNow = e.streaming && !e.text;
    if (thinkingNow && !el._thinkT0) el._thinkT0 = Date.now();
    const ms = e.thinkingMs ?? (el._thinkT0 ? (thinkingNow ? Date.now() : el._thinkEnd ?? (el._thinkEnd = Date.now())) - el._thinkT0 : null);
    $('summary', el).textContent = thinkingNow ? `Thinking… ${ms != null ? fmtSecs(ms) : ''}` : ms != null ? `Thought for ${fmtSecs(ms)}` : 'Reasoning';
  }
  // answer: re-render only when its text changed
  if (e.text !== el._text) {
    el._text = e.text;
    $('.content', el).innerHTML = e.text ? md(e.text) : '';
  }
  $('.msg-meta', el).hidden = !!e.streaming || !e.text;
}

function flushAssistant(id) {
  chatUI.dirty.delete(id);
  const e = state.history.find((h) => h.id === id);
  if (e) renderAssistant(e);
}

function scheduleFlush(id) {
  chatUI.dirty.add(id);
  if (chatUI.frame) return;
  chatUI.frame = requestAnimationFrame(() => {
    chatUI.frame = 0;
    for (const d of [...chatUI.dirty]) flushAssistant(d);
  });
}

function renderChat() {
  // keep elements of entries that still exist (a reconnect resends the same history)
  const ids = new Set(state.history.map((h) => domId(h.id)));
  for (const el of [...chatInner.children]) if (!ids.has(el.id)) el.remove();
  const order = [...chatInner.children].map((c) => c.id);
  const same = order.every((id, i) => domId(state.history[i]?.id) === id);
  if (!same) chatInner.innerHTML = '';
  const stick = chatUI.stick;
  chatUI.stick = true; // a (re)load is not "new while scrolled up"
  state.history.forEach(renderEntry);
  chatUI.stick = stick;
  $('#chat-empty').hidden = state.history.length > 0;
  if (chatUI.stick) toBottom();
}

function onAgentEvent(ev) {
  if (ev.kind === 'reset') {
    state.history = ev.history;
    if (!ev.history.length) {
      chatInner.innerHTML = '';
      chatUI.thinkOpen.clear();
      chatUI.toolOpen.clear();
    }
    renderChat();
  } else if (ev.kind === 'entry') {
    const i = state.history.findIndex((h) => h.id === ev.entry.id);
    if (i >= 0) state.history[i] = ev.entry;
    else state.history.push(ev.entry);
    $('#chat-empty').hidden = true;
    renderEntry(ev.entry);
  } else if (ev.kind === 'delta') {
    let e = state.history.find((h) => h.id === ev.id);
    if (!e) {
      e = { kind: 'assistant', id: ev.id, text: '', thinking: '', streaming: true, at: Date.now() };
      state.history.push(e);
      $('#chat-empty').hidden = true;
    }
    if (ev.channel === 'text') e.text += ev.delta;
    else e.thinking += ev.delta;
    e.streaming = true;
    scheduleFlush(e.id);
  }
}

chatInner.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-cap]');
  if (img) lightbox(img.src, img.dataset.cap);
});

// ---- composer
async function sendPrompt(mode = 'auto') {
  const text = $('#prompt').value.trim();
  if (!text) return;
  const images = state.attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
  $('#btn-send').disabled = true;
  try {
    await api('agent/prompt', { text, images, mode });
    chatUI.lastPrompt = text;
    $('#prompt').value = '';
    grow($('#prompt'));
    state.attachments = [];
    renderAttachments();
    chatUI.stick = true; // sending a message jumps to the conversation's end
    toBottom();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('#btn-send').disabled = false;
  }
}
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  sendPrompt('steer');
};
$('#btn-queue').onclick = () => sendPrompt('followUp');
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt(e.altKey || e.ctrlKey || e.metaKey ? 'followUp' : 'steer');
  } else if (e.key === 'ArrowUp' && !$('#prompt').value && chatUI.lastPrompt) {
    e.preventDefault();
    $('#prompt').value = chatUI.lastPrompt;
  } else if (e.key === 'Escape' && state.agent?.busy) {
    api('agent/abort', {}).catch((err) => toast(err.message, true));
  }
});
$('#btn-abort').onclick = () => api('agent/abort', {}).catch((e) => toast(e.message, true));
$('#btn-compact').onclick = async () => {
  if (!confirm('Summarise the older conversation to free context space? (The agent keeps a summary; recent messages stay.)')) return;
  await api('agent/compact', {}).catch((e) => toast(e.message, true));
};
$('#btn-new').onclick = async () => {
  if (!confirm('Start a new conversation? (Skills and notes are kept.)')) return;
  await api('agent/new', {}).catch((e) => toast(e.message, true));
};
$('#sel-thinking').onchange = (e) => api('agent/thinking', { level: e.target.value }).then(() => toast(`thinking: ${e.target.value}`)).catch((err) => toast(err.message, true));

function blobToB64(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(blob);
  });
}
function renderAttachments() {
  $('#attach-list').innerHTML = state.attachments.map((a, i) => `<img src="data:${a.mimeType};base64,${a.data}" title="click to remove" data-i="${i}">`).join('');
}
$('#attach-list').onclick = (e) => {
  const i = e.target.dataset?.i;
  if (i !== undefined) {
    state.attachments.splice(Number(i), 1);
    renderAttachments();
  }
};
$('#file').onchange = async (e) => {
  for (const f of e.target.files) state.attachments.push({ data: await blobToB64(f), mimeType: f.type || 'image/jpeg' });
  e.target.value = '';
  renderAttachments();
};
$('#btn-snap').onclick = async () => {
  try {
    const res = await fetch(`api/snapshot/${state.mainSrc}?t=${Date.now()}`);
    if (!res.ok) throw new Error('no frame available');
    state.attachments.push({ data: await blobToB64(await res.blob()), mimeType: 'image/jpeg' });
    renderAttachments();
  } catch (e) {
    toast(e.message, true);
  }
};

// ------------------------------------------------------------------ tonight
async function loadTonight() {
  try {
    const c = await api('conditions');
    const moonUp = c.moon.altitude > 0;
    $('#conditions').innerHTML = `<h3>Conditions</h3>
      <div class="status-grid">
        <div><span>Sun altitude</span>${c.sunAltitude}° ${c.sunAltitude < -18 ? '(dark)' : c.sunAltitude < 0 ? '(twilight)' : '(day)'}</div>
        <div><span>Sunset</span>${c.night.sunset ?? '–'}</div>
        <div><span>Astro dusk</span>${c.night.astroDusk ?? '–'}</div>
        <div><span>Astro dawn</span>${c.night.astroDawn ?? '–'}</div>
        <div><span>Moon</span>${c.moon.illuminationPercent}% ${c.moon.phase}</div>
        <div><span>Moon now</span>${moonUp ? `up, alt ${c.moon.altitude}°` : 'below horizon'}</div>
      </div>`;
  } catch (e) {
    $('#conditions').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
  $('#plan').textContent = 'planning…';
  try {
    const type = $('#sel-plan-type').value;
    const p = await api(`plan${type ? `?types=${type}` : ''}`);
    const wx = p.targets.some((t) => t.weatherAlignment != null);
    const skyCls = (q) => (q == null ? '' : q >= 60 ? 'ok' : q >= 35 ? 'warn' : 'bad');
    $('#plan').innerHTML = `<p class="muted small">${p.window.start} → ${p.window.end} (${p.window.hours} h) · min altitude ${p.minAltitude}° · Moon ${p.moon.illuminationPercent}% · ${esc(p.weather ?? '')}</p>
      <table class="plan-table"><tr><th>Target</th><th>Best</th><th title="${wx ? 'weather = forecast quality during the target\'s own best hours (weighted toward its peak); clear / up = forecast-weighted hours / hours above the minimum altitude' : 'hours above the minimum altitude'}">${wx ? 'Weather' : 'Hours'}</th><th>Fit / filter</th><th></th></tr>
      ${p.targets.map((t) => `<tr><td><b>${esc(t.displayName ?? t.name)}</b><small>${esc([t.name, ...t.aliases].filter((a, i, arr) => arr.indexOf(a) === i).slice(0, 3).join(' · '))}</small><small>${esc(t.type)}, ${t.sizeArcmin}′, mag ${t.magnitude ?? '–'}</small></td>
        <td data-label="Best time">${esc(t.bestTime ?? '')}<small>max ${t.maxAltitude}°${t.skyAtBest != null ? ` · <span class="sky ${skyCls(t.skyAtBest)}">sky ${t.skyAtBest}</span>` : ''}</small></td>
        <td data-label="${wx ? 'Weather' : 'Hours above minimum'}">${t.weatherAlignment != null ? `<b class="sky ${skyCls(t.weatherAlignment)}">${t.weatherAlignment}/100</b><small>${t.clearHours} clear / ${t.hoursAboveMin} h up</small>` : `${t.hoursAboveMin} h`}</td>
        <td data-label="Framing &amp; filter"><small>${esc(t.framing)}</small><small>${esc(t.suggestedFilter.split(' (')[0])}</small></td>
        <td><button class="ghost" data-image="${esc(t.gotoName ?? t.name)}">Image</button></td></tr>`).join('')}</table>`;
  } catch (e) {
    $('#plan').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}
$('#sel-plan-type').onchange = loadTonight;

async function loadWeather() {
  try {
    const w = await api('weather');
    const c = w.current ?? {};
    $('#chip-wx').textContent = `☁ ${c.cloudCover ?? '–'}% · tonight ${w.averageScore}/100`;
    $('#chip-wx').title = w.verdict;
    $('#weather').innerHTML = `<h3>Weather & observability</h3>
      <div class="wx-verdict">${esc(w.verdict)}</div>
      <div class="muted small">now: ${c.cloudCover}% cloud · ${c.temperatureC}°C · RH ${c.humidity}% · dew point ${c.dewPointC}°C · wind ${c.windKmh}/${c.gustKmh} km/h${w.commonIssues.length ? ` · watch: ${esc(w.commonIssues.slice(0, 4).join(', '))}` : ''}</div>
      <div class="wx-strip">${w.hours.map((h) => `<div class="wx-h ${h.rating}" title="${esc(`${h.local}: ${h.issues.join('; ') || 'clear'}${h.seeing ? ` · seeing ${h.seeing}, transparency ${h.transparency}` : ''}`)}">
        <div>${esc(h.local.split(', ')[1] ?? h.local)}</div><div class="sc">${h.score}</div><div>☁${h.cloudTotal}</div><div class="rain ${h.precipProbability >= 50 ? 'high' : h.precipProbability >= 25 ? 'mid' : ''}" title="${esc(`rain chance ${h.precipProbability}% · expected ${h.precipMm ?? 0} mm`)}">🌧${h.precipProbability}%${h.precipMm >= 0.1 ? `<br>${h.precipMm.toFixed(1)}mm` : ''}</div><div>💧${h.dewSpreadC}°</div><div>🌬${Math.round(h.gustKmh)}</div></div>`).join('')}</div>
      <div class="muted small">score 0–100 · ☁ cloud % · 🌧 rain chance (and mm expected) · 💧 dew-point spread · 🌬 gusts km/h · Open-Meteo + 7Timer</div>`;
  } catch (e) {
    $('#weather').innerHTML = `<span class="muted">weather unavailable: ${esc(e.message)}</span>`;
  }
}
setTimeout(loadWeather, 1500);
setInterval(loadWeather, 15 * 60 * 1000);
$('#plan').addEventListener('click', (e) => {
  const b = e.target.closest('[data-image]');
  if (!b) return;
  $('#prompt').value = `Plan and capture ${b.dataset.image} tonight: check visibility and conditions, choose filter/exposure/gain, then calibrate, GoTo, focus and start live stacking. Keep me posted on progress.`;
  $('.tab[data-tab=chat]').click();
  $('#prompt').focus();
});

// ------------------------------------------------------------------ database
//
// Search and filter the whole object catalog. Every filter change re-queries the server (typing
// is debounced); the filters are remembered per browser. A row opens in place to show the
// object's designations, tonight's altitude curve and GoTo / ask-the-agent buttons.
const DB_GROUPS = [
  ['galaxy', 'galaxies'], ['nebula', 'nebulae'], ['emission', 'emission nebulae'], ['reflection', 'reflection nebulae'], ['dark', 'dark nebulae'],
  ['planetary', 'planetary nebulae'], ['supernova_remnant', 'supernova remnants'], ['cluster', 'star clusters'], ['open_cluster', 'open clusters'],
  ['globular', 'globular clusters'], ['galaxy_cluster', 'galaxy groups & clusters'], ['star', 'stars'],
];
const DB_FIELDS = ['q', 'type', 'catalog', 'con', 'up', 'sort', 'maxmag', 'minsize', 'maxsize', 'minalt', 'named'];
const db = { meta: null, items: [], total: 0, seq: 0, open: null };
const dbEl = (f) => $(`#db-${f}`);
const dbVal = (f) => (dbEl(f).type === 'checkbox' ? (dbEl(f).checked ? '1' : '') : dbEl(f).value.trim());

function dbSaveFilters() {
  try { localStorage.setItem('db-filters', JSON.stringify(Object.fromEntries(DB_FIELDS.map((f) => [f, dbVal(f)])))); } catch {}
}
function dbRestoreFilters() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('db-filters') || '{}'); } catch {}
  for (const f of DB_FIELDS) {
    if (saved[f] === undefined) continue;
    if (dbEl(f).type === 'checkbox') dbEl(f).checked = saved[f] === '1';
    else dbEl(f).value = saved[f];
  }
  // a stale saved option (e.g. a catalog that no longer exists) falls back to the default
  for (const f of ['type', 'catalog', 'con', 'up', 'sort']) if (dbEl(f).selectedIndex < 0) dbEl(f).selectedIndex = 0;
  if (['maxmag', 'minsize', 'maxsize', 'minalt', 'named'].some((f) => dbVal(f))) dbEl('more-filters').open = true;
}

async function loadDatabase() {
  if (!db.meta) {
    try {
      db.meta = await api('catalog/meta');
    } catch (e) {
      $('#db-count').textContent = `database unavailable: ${e.message}`;
      return;
    }
    const m = db.meta;
    const groupCount = Object.fromEntries(m.groups.map((g) => [g.key, g.count]));
    dbEl('type').insertAdjacentHTML('beforeend', DB_GROUPS.filter(([k]) => groupCount[k]).map(([k, label]) => `<option value="${k}">${label} (${groupCount[k].toLocaleString()})</option>`).join(''));
    dbEl('catalog').insertAdjacentHTML('beforeend', [...m.lists.map((l) => [l.key, l.title, l.count]), ...m.sources.map((s) => [s.key, s.title, s.objects])].map(([k, t, n]) => `<option value="${k}">${esc(t)} (${n.toLocaleString()})</option>`).join(''));
    dbEl('con').insertAdjacentHTML('beforeend', [...m.constellations].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${c.abbr}">${esc(c.name)} (${c.count.toLocaleString()})</option>`).join(''));
    dbEl('q').placeholder = `Search ${m.total.toLocaleString()} objects: M 31, Sh2-155, Veil, Vega…`;
    dbEl('minalt').placeholder = String(state.config?.minAltitude ?? 20);
    $('#db-sources').innerHTML = `<p class="muted">${m.total.toLocaleString()} objects merged from ${m.sources.length} catalogs${m.built ? ` (built ${esc(m.built)})` : ''}. An object in several catalogs is one entry with all its designations. Positions are J2000.</p>
      <ul class="db-src">${m.sources.map((s) => `<li><b>${esc(s.title)}</b> · ${s.objects.toLocaleString()}<br><span class="muted">${esc(s.cite)}</span></li>`).join('')}</ul>`;
    dbRestoreFilters();
  }
  dbSearch();
}

async function dbSearch(append = false) {
  const seq = ++db.seq;
  const p = new URLSearchParams();
  const set = (k, v) => v && p.set(k, v);
  set('q', dbVal('q'));
  set('types', dbVal('type'));
  set('catalog', dbVal('catalog'));
  set('constellation', dbVal('con'));
  set('up', dbVal('up'));
  set('sort', dbVal('sort') === 'relevance' ? '' : dbVal('sort'));
  set('maxMag', dbVal('maxmag'));
  set('minSize', dbVal('minsize'));
  set('maxSize', dbVal('maxsize'));
  set('minAlt', dbVal('minalt'));
  set('named', dbVal('named'));
  p.set('offset', String(append ? db.items.length : 0));
  p.set('limit', '50');
  if (!append) $('#db-count').textContent = 'searching…';
  try {
    const r = await api(`catalog/search?${p}`);
    if (seq !== db.seq) return; // a newer search has started
    db.items = append ? [...db.items, ...r.items] : r.items;
    db.total = r.total;
    db.minAlt = r.window?.minAltitude ?? state.config?.minAltitude ?? 20;
    const win = r.window ? ` · tonight ${r.window.start} → ${r.window.end}, above ${r.window.minAltitude}°` : '';
    $('#db-count').textContent = `${r.total.toLocaleString()} ${r.total === 1 ? 'object' : 'objects'}${win}`;
    renderDatabase(append);
  } catch (e) {
    if (seq === db.seq) $('#db-count').textContent = e.message;
  }
}

const fmtSize = (o) => (o.majorArcmin ? `${o.majorArcmin < 1 ? `${Math.round(o.majorArcmin * 60)}″` : `${+o.majorArcmin.toFixed(1)}′`}${o.minorArcmin && o.minorArcmin !== o.majorArcmin ? `×${o.minorArcmin < 1 ? `${Math.round(o.minorArcmin * 60)}″` : `${+o.minorArcmin.toFixed(1)}′`}` : ''}` : '');
const BRIGHT_CLASS = { 1: 'bright', 2: 'moderate', 3: 'faint' };
const fmtRa = (h) => `${Math.floor(h)}h ${String(Math.floor((h % 1) * 60)).padStart(2, '0')}m ${String(Math.round((((h % 1) * 60) % 1) * 60) % 60).padStart(2, '0')}s`;
const fmtDec = (d) => `${d < 0 ? '−' : '+'}${Math.floor(Math.abs(d))}° ${String(Math.floor((Math.abs(d) % 1) * 60)).padStart(2, '0')}′`;

function dbRow(o) {
  const others = o.aliases.filter((a) => a !== o.name).slice(0, 3);
  const ids = [o.id !== o.name ? o.id : null, ...others.filter((a) => a !== o.id)].filter(Boolean).slice(0, 3);
  const facts = [o.typeName, o.constellation, fmtSize(o), o.mag != null ? `mag ${o.mag}` : o.brightClass ? BRIGHT_CLASS[o.brightClass] : ''].filter(Boolean);
  const up = o.altitudeNow != null && o.altitudeNow >= db.minAlt;
  const alt = o.altitudeNow == null ? '' : `<span class="db-alt ${up ? 'up' : o.altitudeNow > 0 ? 'low' : 'down'}" title="altitude now">${o.altitudeNow > 0 ? `${o.altitudeNow}°` : 'set'}</span>`;
  const tonight = o.hoursUpTonight ? `${o.hoursUpTonight} h up · best ${esc((o.bestTime ?? '').split(', ').pop())}` : o.hoursUpTonight === 0 ? 'not up tonight' : '';
  return `<div class="db-item${db.open === o.id ? ' open' : ''}" data-id="${esc(o.id)}">
    <button type="button" class="db-row" aria-expanded="${db.open === o.id}">
      <span class="db-main"><b>${esc(o.name)}</b>${ids.length ? `<small>${esc(ids.join(' · '))}</small>` : ''}<small>${esc(facts.join(' · '))}</small></span>
      <span class="db-vis">${alt}<small>${tonight}</small></span>
    </button>
    <div class="db-detail"${db.open === o.id ? '' : ' hidden'}></div>
  </div>`;
}

function renderDatabase(append) {
  const list = $('#db-results');
  if (!db.items.length) list.innerHTML = '<p class="muted">Nothing matches these filters.</p>';
  else if (append) list.insertAdjacentHTML('beforeend', db.items.slice(list.querySelectorAll('.db-item').length).map(dbRow).join(''));
  else list.innerHTML = db.items.map(dbRow).join('');
  $('#db-load').hidden = db.items.length >= db.total;
  $('#db-load').textContent = `Show more (${(db.total - db.items.length).toLocaleString()} left)`;
  if (!append) list.closest('.panel').scrollTop = 0;
  if (db.open) {
    const el = $(`.db-item[data-id="${CSS.escape(db.open)}"] .db-detail`);
    if (el) dbDetail(db.open, el);
  }
}

/** Tonight's altitude across the dark window, with the minimum altitude and "now". */
function altitudeChart(t) {
  const W = 320, H = 96, pad = 2;
  const n = t.curve.length;
  if (n < 2) return '';
  const x = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (a) => H - 14 - (Math.max(0, a) / 90) * (H - 22);
  const line = t.curve.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.alt).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const t0 = Date.parse(t.curve[0].t), t1 = Date.parse(t.curve[n - 1].t), now = Date.now();
  const nowX = now >= t0 && now <= t1 ? pad + ((now - t0) / (t1 - t0)) * (W - 2 * pad) : null;
  const mid = Math.floor((n - 1) / 2);
  const tick = (i) => esc((t.curve[i].local ?? '').split(', ').pop());
  return `<svg class="db-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Altitude tonight, peaking at ${t.maxAltitude}° at ${esc(t.bestTime ?? '')}">
    <line class="ax" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>
    <line class="min" x1="0" x2="${W}" y1="${y(t.minAltitude).toFixed(1)}" y2="${y(t.minAltitude).toFixed(1)}"/>
    <path class="area" d="${area}"/><path class="ln" d="${line}"/>
    ${nowX != null ? `<line class="now" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="0" y2="${y(0)}"/>` : ''}
    <text x="${pad}" y="${H - 2}">${tick(0)}</text><text x="${W / 2}" y="${H - 2}" text-anchor="middle">${tick(mid)}</text><text x="${W - pad}" y="${H - 2}" text-anchor="end">${tick(n - 1)}</text>
    <text x="${W - pad}" y="${(y(t.minAltitude) - 3).toFixed(1)}" text-anchor="end" class="minl">${t.minAltitude}°</text>
  </svg>`;
}

async function dbDetail(id, el) {
  el.innerHTML = '<span class="muted small">loading…</span>';
  try {
    const d = await api(`catalog/object?id=${encodeURIComponent(id)}`);
    const t = d.tonight;
    const rows = [
      ['Type', `${d.typeName} in ${d.constellation}`],
      ['RA / Dec (J2000)', `${fmtRa(d.raHours)} · ${fmtDec(d.decDeg)}`],
      ['Size', fmtSize(d) ? `${fmtSize(d)}${d.posAngle != null ? ` · PA ${d.posAngle}°` : ''}${d.fitsTeleFov ? ` · ${d.fitsTeleFov}` : ''}` : 'unknown'],
      ['Brightness', d.mag != null ? `mag ${d.mag}${d.surfaceBrightness != null ? ` · surface ${d.surfaceBrightness} mag/arcmin²` : ''}` : d.brightClass ? `${BRIGHT_CLASS[d.brightClass]} (catalog class; no magnitude)` : 'unknown'],
      ['Now', d.altitudeNow != null ? `altitude ${d.altitudeNow}° · azimuth ${d.azimuthNow}°` : '–'],
      t ? ['Tonight', t.hoursAboveMin ? `${t.hoursAboveMin} h above ${t.minAltitude}° (${esc(t.from?.split(', ').pop() ?? '')} → ${esc(t.until?.split(', ').pop() ?? '')}), peaks at ${t.maxAltitude}° at ${esc(t.bestTime?.split(', ').pop() ?? '')} · Moon ${t.moonIllumination}%, ${t.moonSeparationDeg}° away` : `stays below ${t.minAltitude}° (peaks at ${t.maxAltitude}°)`] : null,
      ['Catalogs', d.sourceTitles.join(' · ')],
    ].filter(Boolean);
    el.innerHTML = `${t ? altitudeChart(t) : ''}
      <div class="db-facts">${rows.map(([k, v]) => `<div><span>${k}</span>${k === 'Catalogs' || k === 'Tonight' ? v : esc(v)}</div>`).join('')}</div>
      ${d.aliases.length ? `<div class="db-aliases">${d.aliases.map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
      <div class="ctl-row db-actions">
        <button type="button" class="primary" data-db-goto="${esc(d.id)}" data-label="${esc(d.gotoName)}"${d.altitudeNow != null && d.altitudeNow < 5 ? ' disabled title="below the horizon"' : ''}>GoTo ${esc(d.gotoName)}</button>
        <button type="button" data-db-agent="${esc(d.gotoName)}">Ask the agent to image it</button>
      </div>`;
  } catch (e) {
    el.innerHTML = `<span class="muted small">${esc(e.message)}</span>`;
  }
}

$('#db-results').addEventListener('click', async (e) => {
  const go = e.target.closest('[data-db-goto]');
  if (go) {
    if (!confirm(`Slew the telescope to ${go.dataset.label}? (calibrates first, then GoTo and tracking)`)) return;
    go.disabled = true;
    go.classList.add('busy');
    toast(`GoTo ${go.dataset.label}: calibrating and slewing…`);
    await control({ action: 'goto', name: go.dataset.dbGoto }, `GoTo ${go.dataset.label}`);
    go.disabled = false;
    go.classList.remove('busy');
    return;
  }
  const ask = e.target.closest('[data-db-agent]');
  if (ask) {
    $('#prompt').value = `Plan and capture ${ask.dataset.dbAgent} tonight: check visibility and conditions, choose filter/exposure/gain, then calibrate, GoTo, focus and start live stacking. Keep me posted on progress.`;
    showScreen('chat');
    $('#prompt').focus();
    return;
  }
  const row = e.target.closest('.db-row');
  if (!row) return;
  const item = row.closest('.db-item');
  const id = item.dataset.id;
  const wasOpen = db.open === id;
  for (const other of $$('.db-item.open')) {
    other.classList.remove('open');
    $('.db-row', other).setAttribute('aria-expanded', 'false');
    $('.db-detail', other).hidden = true;
  }
  db.open = wasOpen ? null : id;
  if (wasOpen) return;
  item.classList.add('open');
  row.setAttribute('aria-expanded', 'true');
  const detail = $('.db-detail', item);
  detail.hidden = false;
  dbDetail(id, detail);
});

let dbTimer;
const dbChanged = (delay = 0) => {
  dbSaveFilters();
  clearTimeout(dbTimer);
  dbTimer = setTimeout(() => dbSearch(), delay);
};
$('#db-form').addEventListener('submit', (e) => {
  e.preventDefault();
  dbEl('q').blur(); // a phone keyboard covers half the results
  dbChanged();
});
$('#db-form').addEventListener('input', (e) => dbChanged(e.target.matches('input[type=search], input[type=number]') ? 300 : 0));
$('#db-reset').onclick = () => {
  for (const f of DB_FIELDS) {
    if (dbEl(f).type === 'checkbox') dbEl(f).checked = false;
    else if (dbEl(f).tagName === 'SELECT') dbEl(f).selectedIndex = 0;
    else dbEl(f).value = '';
  }
  dbChanged();
};
$('#db-load').onclick = () => dbSearch(true);

// ------------------------------------------------------------------ album
async function loadAlbum() {
  const type = $('#sel-album').value;
  $('#album-page').textContent = state.albumPage + 1;
  $('#album').innerHTML = '<p class="muted">loading…</p>'; /* the telescope can take ~10s to answer; a void reads as broken */
  try {
    const { counts, items } = await api(`album?type=${type}&page=${state.albumPage}`);
    const names = { 0: 'all', 1: 'photos', 2: 'videos', 3: 'burst', 4: 'astro', 5: 'panorama' };
    $('#album-counts').textContent = counts.filter((c) => c.count).map((c) => `${names[c.mediaType] ?? c.mediaType}: ${c.count}`).join(' · ');
    $('#album').innerHTML = items
      .map((m) => {
        const thumb = m.thumbnailPath || m.filePath;
        const label = m.astroTargetName || m.filePath.split('/').pop();
        const sub = m.astroImageDetails ? `${m.astroImageDetails.shotsStacked}×${m.astroImageDetails.params?.exp}s · ${m.astroImageDetails.params?.filter ?? ''}` : new Date(m.modificationTime * 1000).toLocaleString();
        const folder = m.astroImageDetails?.srcDir ? m.astroImageDetails.srcDir.replace(/\/$/, '').split('/').pop() : '';
        return `<div class="tile"><img loading="lazy" src="api/device-file?path=${encodeURIComponent(thumb)}" data-full="${esc(m.filePath)}" alt=""><div class="cap"><b title="${esc(label)}">${esc(label)}</b><span class="muted">${esc(sub)}</span><br>
          ${folder ? `<button data-session="${esc(folder)}">⇩ session</button>` : `<button data-file="${esc(m.filePath)}">⇩ library</button>`}
          <button data-ask="${esc(m.filePath)}">ask agent</button></div></div>`;
      })
      .join('') || '<p class="muted">Nothing captured yet. Take a Photo from the View screen, or ask the agent for a target.</p>';
  } catch (e) {
    $('#album').innerHTML = `<p class="muted">${state.telescope?.connected ? esc(e.message) : 'the telescope is offline — reconnect it to read the album'}</p>`;
  }
}
$('#sel-album').onchange = () => {
  state.albumPage = 0;
  loadAlbum();
};
$('#album-prev').onclick = () => {
  state.albumPage = Math.max(0, state.albumPage - 1);
  loadAlbum();
};
$('#album-next').onclick = () => {
  state.albumPage++;
  loadAlbum();
};
$('#album').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.full) lightbox(`api/device-file?path=${encodeURIComponent(t.dataset.full)}`, t.dataset.full);
  else if (t.dataset.session) {
    try {
      await api('transfer', { session: t.dataset.session });
      toast('transfer queued — see Library tab');
    } catch (err) {
      toast(err.message, true);
    }
  } else if (t.dataset.file) {
    try {
      await api('transfer', { paths: [t.dataset.file] });
      toast('transfer queued');
    } catch (err) {
      toast(err.message, true);
    }
  } else if (t.dataset.ask) {
    $('#prompt').value = `Look at device:${t.dataset.ask} and assess it (focus, tracking, noise, framing). Suggest improvements for next time.`;
    $('.tab[data-tab=chat]').click();
  }
});

// ------------------------------------------------------------------ library
function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  $('#jobs').innerHTML = jobs.length
    ? jobs
        .map((j) => {
          const p = j.progress;
          const pct = p && p.bytesTotal ? Math.round((100 * p.bytesDone) / p.bytesTotal) : p && p.filesTotal ? Math.round((100 * p.filesDone) / p.filesTotal) : 0;
          return `<div class="job"><b>${esc(j.description)}</b> — ${j.status}${j.status === 'running' ? ` ${pct}% (${p?.filesDone ?? 0}/${p?.filesTotal ?? '?'} files)` : ''}${j.error ? ` <span class="muted">${esc(j.error)}</span>` : ''}
            ${j.status === 'running' || j.status === 'queued' ? `<button class="ghost" data-cancel="${j.id}">cancel</button>` : ''}
            ${j.status === 'running' ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}</div>`;
        })
        .join('')
    : 'no jobs';
}
$('#jobs').addEventListener('click', (e) => {
  const id = e.target.dataset.cancel;
  if (id) api(`jobs/${id}/cancel`, {}).catch((err) => toast(err.message, true));
});

$('#library').addEventListener('click', async (e) => {
  const s = e.target.dataset.process;
  const t = e.target.dataset.processTarget;
  if (!s && !t) return;
  try {
    await api('processing', t ? { target: t } : { session: s });
    toast('processing queued');
  } catch (err) {
    toast(err.message, true);
  }
});

// ------------------------------------------------------------------ processing
let procTimer;
function renderProcHead() {
  const p = state.procInfo;
  if (!p) return;
  const sv = p.server ?? {};
  const dot = `<i class="dot" style="background:var(--${sv.ok ? 'ok' : 'err'})" title="${esc(sv.ok ? `v${sv.version ?? '?'}` : sv.error ?? 'unreachable')}"></i>`;
  $('#proc-head').innerHTML = `${dot}${esc(sv.url ?? 'no server')} · profile ${esc(p.profile ?? '–')} · data ${esc(p.dataAccess ?? '–')} · auto-process ${p.autoProcess ? 'on' : 'off'}${sv.ok ? '' : ` · ${esc(sv.error ?? 'unreachable')}`}`;
}
function renderProcQueue() {
  const q = state.procInfo?.queue;
  const el = $('#proc-queue');
  if (!q) return (el.textContent = '–');
  if (q.error) return (el.textContent = q.error);
  const jobs = [...(q.running ?? []), ...(q.queued ?? [])];
  el.innerHTML = jobs.length
    ? jobs.map((j) => `<div>${esc(j.label ?? j.id)} — ${esc(j.state)} ${Math.round(100 * (j.progress ?? 0))}%${j.position != null ? ` · #${esc(j.position)}` : ''}${j.message ? ` · ${esc(j.message)}` : ''}</div>`).join('') + (q.drains_in != null ? `<div>drains in ~${fmtDur(q.drains_in)}</div>` : '')
    : 'queue empty';
}
function renderProcessing() {
  const items = [...state.proc.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  $('#proc-items').innerHTML = items.length
    ? items
        .map((i) => {
          let pct = null;
          if (i.state === 'uploading' && i.upload?.bytesTotal) pct = (100 * i.upload.bytesDone) / i.upload.bytesTotal;
          else if (i.state === 'submitted' && i.studio?.progress != null) pct = 100 * i.studio.progress;
          const eta = i.state === 'submitted' && i.studio?.etaS != null ? ` · ETA ${Math.max(1, Math.round(i.studio.etaS / 60))} min` : '';
          const msg = i.lastError ?? i.studio?.message ?? i.message ?? '';
          const outs = i.state === 'done' && i.outputs?.length ? `<div class="muted small">${i.outputs.map((p) => esc(String(p).split('/').pop())).join(', ')}</div>` : '';
          const btn = ['waiting', 'uploading', 'submitted'].includes(i.state) ? `<button class="ghost" data-proc-cancel="${esc(i.id)}">Cancel</button>` : ['failed', 'cancelled'].includes(i.state) ? `<button class="ghost" data-proc-retry="${esc(i.id)}">Retry</button>` : '';
          return `<div class="proc-item"><b>${esc(i.target)}</b> <span class="muted small">${esc(i.profile ?? '')}</span> <span class="badge ${esc(i.state)}">${esc(i.state)}</span>${btn}
            <div class="muted small">${esc(msg)}${eta}</div>${pct != null ? `<div class="progress"><div style="width:${Math.round(pct)}%"></div></div>` : ''}${outs}</div>`;
        })
        .join('')
    : 'no processing items';
}
async function loadProcessing() {
  clearTimeout(procTimer);
  try {
    const d = await api('processing');
    state.procInfo = d;
    (d.items ?? []).forEach((i) => state.proc.set(i.id, i));
    renderProcHead();
    renderProcessing();
    renderProcQueue();
  } catch (e) {
    $('#proc-head').textContent = e.message;
  }
  if ($('#panel-library').classList.contains('active') && !document.hidden) procTimer = setTimeout(loadProcessing, 30000);
}
$('#btn-proc-refresh').onclick = loadProcessing;
$('#proc-items').addEventListener('click', async (e) => {
  const c = e.target.dataset.procCancel;
  const r = e.target.dataset.procRetry;
  const id = c || r;
  if (!id) return;
  try {
    const item = await api(`processing/${id}/${c ? 'cancel' : 'retry'}`, {});
    if (item?.id) state.proc.set(item.id, item);
    renderProcessing();
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadLibrary() {
  try {
    const lib = await api('library');
    $('#lib-root').textContent = lib.root;
    $('#library').innerHTML = lib.targets.length
      ? lib.targets.map((t) => `<div class="lib-target"><b>${esc(t.target)}</b>${t.sessions.length > 1 ? ` <button class="ghost" data-process-target="${esc(t.target)}" title="stack every session of this target as one image">Process all ${t.sessions.length} nights</button>` : ''} ${t.sessions.map((s) => `<div class="muted small">${esc(s.name)} — ${esc(s.camera ?? '')} ${s.lights} lights${s.rejected ? ` (${s.rejected} rejected)` : ''} ${esc(s.startedAt ?? '')} <button class="ghost" data-process="${esc(s.name)}">Process</button></div>`).join('')}</div>`).join('')
      : 'empty';
  } catch (e) {
    $('#library').textContent = e.message;
  }
  try {
    const caps = await api('captures');
    $('#captures').innerHTML = '';
    caps.forEach((c) => addCapture(c.path, c.name));
  } catch {}
}
$('#btn-sessions').onclick = async () => {
  $('#sessions').textContent = 'reading SD card…';
  try {
    const { sessions } = await api('sessions?counts=1');
    $('#sessions').innerHTML = sessions.length
      ? sessions.map((s) => `<div class="sess"><div><b>${esc(s.target)}</b> <span class="muted">${s.camera} · ${s.exposureS}s · gain ${s.gain} · ${esc(s.startedAt ?? '')} · ${s.fitsCount ?? '?'} FITS · ${s.sizeMB ?? '?'} MB</span></div>${s.transferred ? '<span class="muted">in library</span>' : ''}<button data-session="${esc(s.folder)}">Transfer</button></div>`).join('')
      : 'no sessions';
  } catch (e) {
    $('#sessions').textContent = e.message;
  }
};
$('#sessions').addEventListener('click', async (e) => {
  const f = e.target.dataset.session;
  if (!f) return;
  try {
    await api('transfer', { session: f });
    toast('transfer queued');
  } catch (err) {
    toast(err.message, true);
  }
});
function addCapture(path, label) {
  const g = $('#captures');
  const img = document.createElement('img');
  img.src = `captures/${path}`;
  img.title = label ?? path;
  img.dataset.cap = path;
  img.onclick = () => lightbox(img.src, path);
  g.prepend(img);
  while (g.children.length > 60) g.lastChild.remove();
}

// ------------------------------------------------------------------ skills
let currentSkill = null;
async function loadSkills() {
  try {
    const skills = await api('skills');
    $('#skills').innerHTML = skills.map((s) => `<li data-skill="${esc(s.name)}" class="${s.name === currentSkill ? 'active' : ''}">${esc(s.name)}<small>${esc(s.description.slice(0, 90))}</small></li>`).join('') || '<li class="muted">no skills yet</li>';
    $('.skill-editor').classList.toggle('on', !!currentSkill);
  } catch (e) {
    toast(e.message, true);
  }
}
$('#skills').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-skill]');
  if (!li) return;
  currentSkill = li.dataset.skill;
  const s = await api(`skills/${currentSkill}`);
  $('#skill-name').textContent = currentSkill;
  $('#skill-content').value = s.content;
  $('#btn-skill-save').disabled = false;
  $$('#skills li').forEach((x) => x.classList.toggle('active', x === li));
  $('.skill-editor').classList.add('on');
});
$('#btn-skill-save').onclick = async () => {
  if (!currentSkill) return;
  try {
    await api(`skills/${currentSkill}`, { content: $('#skill-content').value }, 'PUT');
    toast('skill saved');
  } catch (e) {
    toast(e.message, true);
  }
};

// ------------------------------------------------------------------ log
function addLog(l) {
  const el = document.createElement('div');
  el.className = l.level;
  el.textContent = `${new Date(l.ts).toLocaleTimeString()} ${l.level.toUpperCase()} [${l.scope}] ${l.msg}`;
  const log = $('#log');
  log.appendChild(el);
  while (log.children.length > 400) log.firstChild.remove();
}

// ------------------------------------------------------------------ boot
connectVideo();
setView('main', 'tele');
setView('a', 'wide');
setView('b', 'stack');
connect();
layoutBoot();

