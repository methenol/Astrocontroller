/**
 * The live views. Frames arrive over a dedicated WebSocket (/ws/video) as
 * [u8 source][f64 capture ms][JPEG]; it reconnects by itself, so a server restart or a network
 * blip never leaves a view frozen. Only the sources on screen are subscribed: a phone looking at
 * another screen, or a hidden tab, gets no frames at all.
 */
import { $, $$, lightbox, lightboxOpen, closeLightbox } from './dom.js';
import { on } from './bus.js';
import { wsUrl } from './api.js';
import { state } from './state.js';
import { viewOnScreen } from './shell.js';

const SOURCES = ['tele', 'wide', 'stack'];
const HEADER_BYTES = 9;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5000;
const REVOKE_AFTER_MS = 2000;
const STALE_AFTER_S = 6;
const HEALTH_EVERY_MS = 1000;
/** the wide camera frame the tele box is given in */
const WIDE_W = 1920;
const WIDE_H = 1080;
const ZOOM_MIN = 1.02;
const ZOOM_MAX = 5;
const ZOOM_DOUBLE_TAP = 2.6;
const TAP_SLOP_PX = 14;
const TAP_MS = 450;
const DOUBLE_TAP_MS = 330;

const views = { main: 'tele', a: 'wide', b: 'stack' };
// Capture time per source, in server ms. Not the receive time: the server hands a new viewer the
// last frame it has, which may be minutes old, and that must not look live.
const lastFrame = { tele: 0, wide: 0, stack: 0 };
let clockSkew = 0; // server clock − browser clock, from the stream status messages
const blobUrls = {};
let videoWs = null;
let retry = 0;
let stackWasActive = false;
let serverStreams = {};

const imgOf = (slot) => $(slot === 'main' ? '#img-main' : `#img-${slot}`);
const RUNNING = new Set(['running', 'stopping']);

export function stackActive() {
  const s = state.telescope?.stacking;
  return !!s && (RUNNING.has(s.tele?.state) || RUNNING.has(s.wide?.state));
}

function wantedSources() {
  if (document.hidden || !viewOnScreen()) return [];
  // the stack feed only means something while stacking (otherwise it mirrors the tele preview)
  return [...new Set(Object.values(views))].filter((s) => s !== 'stack' || stackActive());
}

function subscribe() {
  // `main` is the source in the main view: a telescope that streams one camera at a time (the
  // Seestar) selects that one, not whichever thumbnail is also on screen
  const sources = wantedSources();
  if (videoWs?.readyState === WebSocket.OPEN) videoWs.send(JSON.stringify({ type: 'subscribe', sources, main: sources.includes(views.main) ? views.main : null }));
}

function connectVideo() {
  const ws = new WebSocket(wsUrl('ws/video'));
  ws.binaryType = 'arraybuffer';
  videoWs = ws;
  ws.onopen = () => {
    retry = 0;
    subscribe();
  };
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength <= HEADER_BYTES) return;
    const src = SOURCES[new DataView(ev.data).getUint8(0)];
    if (!src) return;
    lastFrame[src] = new DataView(ev.data).getFloat64(1, true) || Date.now() + clockSkew;
    const url = URL.createObjectURL(new Blob([new Uint8Array(ev.data, HEADER_BYTES)], { type: 'image/jpeg' }));
    const old = blobUrls[src];
    blobUrls[src] = url;
    for (const [slot, s] of Object.entries(views)) {
      if (s !== src) continue;
      const img = imgOf(slot);
      img.src = url;
      img.style.visibility = 'visible';
    }
    // the old frame may still be decoding in an <img>: let it finish first
    if (old) setTimeout(() => URL.revokeObjectURL(old), REVOKE_AFTER_MS);
  };
  ws.onclose = () => {
    if (videoWs === ws) videoWs = null;
    setTimeout(connectVideo, Math.min(RETRY_BASE_MS * 2 ** retry++, RETRY_MAX_MS));
  };
}

export function setView(slot, src) {
  views[slot] = src;
  const img = imgOf(slot);
  const fig = img.closest('figure');
  fig.dataset.src = src;
  $('.view-name', fig).textContent = src[0].toUpperCase() + src.slice(1);
  // this source's latest frame at once if there is one; otherwise the placeholder
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
    // capture defaults to whichever camera is in the main view
    if (src === 'tele' || src === 'wide') $('#cap-cam').value = src;
    $('#empty-main').textContent = src === 'stack' ? 'no live-stacking image yet' : 'waiting for video…';
  }
  subscribe();
}

function swapIntoMain(src) {
  if (src === views.main) return;
  const other = Object.entries(views).find(([, v]) => v === src)?.[0];
  if (other) setView(other, views.main);
  setView('main', src);
}

/** A tag per view: lost connection, the server's note, or how old its last frame is. */
function renderHealth() {
  for (const fig of $$('figure.view')) {
    const src = fig.dataset.src;
    const st = serverStreams[src];
    let tag = $('.stale', fig);
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'stale';
      fig.appendChild(tag);
    }
    const at = Math.max(lastFrame[src], st?.lastFrameAt ?? 0);
    const age = at ? Math.max(0, Math.round((Date.now() + clockSkew - at) / 1000)) : null;
    const stale = age !== null && age > STALE_AFTER_S && !(src === 'stack' && !stackActive());
    let text = '';
    if (!videoWs) text = '⚠ video connection lost — reconnecting…';
    else if (st?.note) text = stale ? `⚠ picture is ${fmtAge(age)} old — ${st.note}` : `ℹ ${st.note}`;
    else if (src === 'stack' && !stackActive()) text = 'no live stack running';
    else if (age === null) text = '⚠ waiting for first frame…';
    else if (stale) text = `⚠ no new frames for ${fmtAge(age)}`;
    tag.hidden = !text;
    if (tag.dataset.text !== text) {
      tag.dataset.text = text;
      tag.textContent = text;
    }
  }
}
function fmtAge(s) {
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

export function renderStreamHealth(streams, serverNow) {
  if (streams && typeof streams === 'object') serverStreams = streams;
  if (typeof serverNow === 'number') clockSkew = serverNow - Date.now();
  renderHealth();
}

// Green rectangle on wide views showing the tele field. teleInWide comes from the telescope's own
// tele↔wide matching: top-left x/y and size in the 1920×1080 wide frame.
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
    const show = fig.dataset.src === 'wide' && r && r.width > 0 && r.height > 0;
    box.hidden = !show;
    if (show) {
      Object.assign(box.style, {
        left: `${(r.x / WIDE_W) * 100}%`,
        top: `${(r.y / WIDE_H) * 100}%`,
        width: `${(r.width / WIDE_W) * 100}%`,
        height: `${(r.height / WIDE_H) * 100}%`,
      });
    }
  }
}

on('telescope', () => {
  updateTeleBox();
  const active = stackActive();
  if (active === stackWasActive) return;
  stackWasActive = active;
  subscribe();
  if (!active) {
    // the stack feed's last frame belongs to the stack that ended
    const old = blobUrls.stack;
    delete blobUrls.stack;
    for (const [slot, src] of Object.entries(views)) if (src === 'stack') setView(slot, 'stack');
    if (old) setTimeout(() => URL.revokeObjectURL(old), REVOKE_AFTER_MS);
  }
});
on('screen', subscribe);
on('view', subscribe);
document.addEventListener('visibilitychange', subscribe);

// ---- swapping views
for (const b of $$('[data-swap]')) {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    swapIntoMain(b.dataset.swap);
  });
}
for (const slot of ['a', 'b']) $(`#view-${slot}`).addEventListener('click', () => swapIntoMain(views[slot]));

// ---- full-bleed live view
// The Fullscreen API where it exists (desktop, Android Chrome); iOS Safari has no element
// fullscreen, so an in-page mode covers the same need. Pinch zooms, drag pans, double-tap toggles.
let fullMode = false;
const zoom = { s: 1, x: 0, y: 0 };
const fig = $('#view-main');

function applyZoom() {
  const zoomed = zoom.s > ZOOM_MIN;
  $('img', fig).style.transform = zoomed ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` : '';
  fig.classList.toggle('zoomed', zoomed);
}
function setZoom(s, x, y) {
  zoom.s = Math.max(1, Math.min(ZOOM_MAX, s));
  const r = fig.getBoundingClientRect();
  const zoomed = zoom.s > ZOOM_MIN;
  zoom.x = zoomed ? Math.min(0, Math.max(r.width * (1 - zoom.s), x)) : 0;
  zoom.y = zoomed ? Math.min(0, Math.max(r.height * (1 - zoom.s), y)) : 0;
  applyZoom();
}
function exitFull() {
  if (!fullMode) return;
  fullMode = false;
  document.body.classList.remove('view-full');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setZoom(1, 0, 0);
}
async function enterFull() {
  if (fullMode) return;
  fullMode = true;
  document.body.classList.add('view-full'); // the chrome (nav, hints, buttons) keys off this in both modes
  if (fig.requestFullscreen) {
    try {
      await fig.requestFullscreen();
    } catch {
      // iOS: the in-page mode already fills the screen
    }
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) exitFull();
});
// Esc: the topmost thing closes first, the lightbox, then the enlarged live view.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (lightboxOpen()) closeLightbox();
  else exitFull();
});

function attachGestures() {
  const pts = new Map();
  let tapAt = 0;
  let press = null;
  let pinch = null;
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
      const s = (pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch.d;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // keep the image point that was under the starting midpoint under the current one
      setZoom(s, mx - ((pinch.mx - pinch.x) * s) / pinch.s, my - ((pinch.my - pinch.y) * s) / pinch.s);
      return;
    }
    if (fullMode && zoom.s > ZOOM_MIN) setZoom(zoom.s, zoom.x + (e.clientX - p.x), zoom.y + (e.clientY - p.y));
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const lifted = (e) => {
    if (!pts.has(e.pointerId)) return;
    const before = pts.size;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    const clean = before === 1 && press && press.moved < TAP_SLOP_PX && e.type === 'pointerup' && !e.target.closest('button');
    if (!fullMode) {
      // a tap (not a click: the mouse has the ⛶ button and double-click) enlarges
      if (clean && e.pointerType !== 'mouse' && Date.now() - press.t < TAP_MS) enterFull();
      press = null;
      return;
    }
    const now = Date.now();
    if (clean && now - tapAt < DOUBLE_TAP_MS) {
      if (zoom.s > ZOOM_MIN) setZoom(1, 0, 0);
      else setZoom(ZOOM_DOUBLE_TAP, e.clientX * (1 - ZOOM_DOUBLE_TAP), e.clientY * (1 - ZOOM_DOUBLE_TAP));
      tapAt = 0;
    } else if (clean) tapAt = now;
    if (pts.size === 0) press = null;
  };
  fig.addEventListener('pointerup', lifted);
  fig.addEventListener('pointercancel', lifted);
}

$('#btn-fullscreen').onclick = (e) => {
  e.stopPropagation();
  if (fullMode) exitFull();
  else enterFull();
};
$('#btn-unfull').onclick = (e) => {
  e.stopPropagation();
  exitFull();
};
fig.addEventListener('dblclick', (e) => {
  if (fullMode || e.target.closest('button')) return;
  lightbox(`api/snapshot/${encodeURIComponent(state.mainSrc)}?t=${Date.now()}`, state.mainSrc);
});
attachGestures();

/** Starts the video socket with the default layout. */
export function startVideo() {
  setView('main', 'tele');
  setView('a', 'wide');
  setView('b', 'stack');
  connectVideo();
  setInterval(renderHealth, HEALTH_EVERY_MS);
}
