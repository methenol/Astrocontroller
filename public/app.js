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
      renderAgentStatus(m.agent);
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
    case 'agentStatus':
      renderAgentStatus(m.status);
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
  setConn(t.connected, t.connected ? (t.device?.name ?? 'connected') : 'telescope offline');
  $('#chip-battery').textContent = `🔋 ${t.battery ?? '–'}%${t.charging ? ' ⚡' : ''}`;
  $('#chip-temp').textContent = `🌡 ${t.temperatureC ?? '–'}° / ${t.cmosTempC?.tele ?? '–'}°`;
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
  if (document.hidden) return [];
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
$('#btn-fullscreen').onclick = (e) => {
  e.stopPropagation();
  $('#view-main').requestFullscreen?.();
};
$('#view-main').addEventListener('dblclick', () => lightbox(`api/snapshot/${state.mainSrc}?t=${Date.now()}`, state.mainSrc));

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
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${t.dataset.tab}`));
    const tab = t.dataset.tab;
    if (tab === 'tonight') {
      loadTonight();
      loadWeather();
    }
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
  if (e.kind === 'user') {
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
    $('#plan').innerHTML = `<p class="muted small">${p.window.start} → ${p.window.end} (${p.window.hours} h) · min altitude ${p.minAltitude}° · Moon ${p.moon.illuminationPercent}%</p>
      <table class="plan-table"><tr><th>Target</th><th>Best</th><th>Hours</th><th>Fit / filter</th><th></th></tr>
      ${p.targets.map((t) => `<tr><td><b>${esc(t.aliases.find((a) => /^M \d/.test(a)) ?? t.name)}</b><small>${esc([t.name, ...t.aliases].filter((a, i, arr) => arr.indexOf(a) === i).slice(0, 3).join(' · '))}</small><small>${esc(t.type)}, ${t.sizeArcmin}′, mag ${t.magnitude ?? '–'}</small></td>
        <td>${esc(t.bestTime ?? '')}<small>max ${t.maxAltitude}°</small></td><td>${t.hoursAboveMin}</td>
        <td><small>${esc(t.framing)}</small><small>${esc(t.suggestedFilter.split(' (')[0])}</small></td>
        <td><button class="ghost" data-image="${esc(t.aliases.find((a) => /^M \d/.test(a)) ?? t.name)}">Image</button></td></tr>`).join('')}</table>`;
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
        <div>${esc(h.local.split(', ')[1] ?? h.local)}</div><div class="sc">${h.score}</div><div>☁${h.cloudTotal}</div><div>💧${h.dewSpreadC}°</div><div>🌬${Math.round(h.gustKmh)}</div></div>`).join('')}</div>
      <div class="muted small">score 0–100 · ☁ cloud % · 💧 dew-point spread · 🌬 gusts km/h · Open-Meteo + 7Timer</div>`;
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

// ------------------------------------------------------------------ album
async function loadAlbum() {
  const type = $('#sel-album').value;
  $('#album-page').textContent = state.albumPage + 1;
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
      .join('') || '<p class="muted">no media</p>';
  } catch (e) {
    $('#album').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
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

