/* Astrocontroller UI — vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDur = (s) => (s == null ? '–' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

const state = { telescope: null, agent: null, history: [], jobs: new Map(), config: null, attachments: [], mainSrc: 'tele', albumPage: 0 };

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
    case 'capture':
      addCapture(m.path, m.label);
      break;
    case 'notify':
      if (m.name === 'albumUpdate' && $('#panel-album').classList.contains('active')) loadAlbum();
      break;
    case 'error':
      toast(m.message, true);
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
    for (const [slot, src] of Object.entries(views)) if (src === 'stack') setView(slot, 'stack');
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
const views = { main: 'tele', a: 'wide', b: 'stack' };
let stackWasActive = false;
function stackActive() {
  const s = state.telescope?.stacking;
  return !!s && ['running', 'stopping'].includes(s.tele?.state) || ['running', 'stopping'].includes(s?.wide?.state);
}
function setView(slot, src) {
  views[slot] = src;
  const img = $(slot === 'main' ? '#img-main' : `#img-${slot}`);
  const fig = img.closest('figure');
  fig.dataset.src = src;
  $('.view-name', fig).textContent = src[0].toUpperCase() + src.slice(1);
  // The stack stream only carries frames while the telescope is stacking.
  const live = !(src === 'stack' && !stackActive());
  if (live) img.src = `stream/${src}?t=${Date.now()}`;
  else img.removeAttribute('src');
  img.style.visibility = live ? 'visible' : 'hidden';
  updateTeleBox();
  if (slot === 'main') {
    state.mainSrc = src;
    // Capture defaults to whichever camera is in the main view.
    if (src === 'tele' || src === 'wide') $('#cap-cam').value = src;
    $('#empty-main').textContent = src === 'stack' ? 'waiting for live-stacking image…' : 'waiting for stream…';
  }
}
// The placeholder sits behind the image, so the first decoded MJPEG frame covers it.

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
// Click on the main tele/wide view → track that point? We offer "send to agent" instead.
$('#view-main').addEventListener('dblclick', () => lightbox(`api/snapshot/${state.mainSrc}?t=${Date.now()}`, state.mainSrc));

document.addEventListener('visibilitychange', () => {
  // Release streams while the tab is hidden; restore on return.
  for (const slot of ['main', 'a', 'b']) {
    const img = $(slot === 'main' ? '#img-main' : `#img-${slot}`);
    if (document.hidden) img.removeAttribute('src');
    else setView(slot, views[slot]);
  }
});

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
    if (tab === 'library') loadLibrary();
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
function renderAgentStatus(s) {
  if (!s) return;
  state.agent = s;
  const el = $('#agent-status');
  el.className = `agent-status${s.busy ? ' busy' : ''}${!s.ready ? ' down' : ''}`;
  el.textContent = !s.ready ? `agent offline${s.error ? ` — ${s.error}` : ' (starting…)'}` : `${s.busy ? 'working… · ' : ''}${s.model}`;
  el.title = `${s.model} @ ${s.baseUrl}`;
  $('#sel-thinking').value = s.thinking;
  $('#btn-abort').hidden = !s.busy;
  if (!s.busy) $$('.typing').forEach((x) => x.classList.remove('typing'));
}

function entryEl(e) {
  const id = `e-${e.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    $('#chat').appendChild(el);
  }
  return el;
}

function renderEntry(e) {
  const el = entryEl(e);
  if (e.kind === 'user') {
    el.className = 'msg user';
    el.textContent = e.text + (e.images ? `  📎×${e.images}` : '');
  } else if (e.kind === 'assistant') {
    el.className = `msg assistant${e.streaming ? ' typing' : ''}`;
    const think = e.thinking ? `<details class="thinking"${e.streaming && !e.text ? ' open' : ''}><summary>thinking</summary><div>${esc(e.thinking)}</div></details>` : '';
    el.innerHTML = think + (e.text ? md(e.text) : '');
  } else if (e.kind === 'tool') {
    el.className = '';
    // Oh My Pi adds an "i" (intent) field to tool calls; show it as the caption.
    const { i: intent, ...rest } = e.args ?? {};
    const args = Object.keys(rest).length ? JSON.stringify(rest) : '';
    const wasOpen = $('details', el)?.open;
    el.innerHTML = `<details class="tool"${wasOpen ? ' open' : ''}><summary><span class="tname">${esc(e.name)}</span><span class="targs">${esc(intent ?? args)}</span><span class="tstate ${e.status}">${e.status === 'running' ? '…' : e.status === 'ok' ? `✓ ${e.ms ? (e.ms / 1000).toFixed(1) + 's' : ''}` : '✗'}</span></summary>${args ? `<pre>${esc(JSON.stringify(rest, null, 1))}</pre>` : ''}${e.result ? `<pre>${esc(e.result)}</pre>` : ''}</details>${(e.images ?? []).length ? `<div class="tool-images">${e.images.map((p) => `<img src="captures/${esc(p)}" data-cap="${esc(p)}">`).join('')}</div>` : ''}`;
  } else if (e.kind === 'notice') {
    el.className = `msg notice ${e.level}`;
    el.textContent = e.text;
  }
}

function renderChat() {
  $('#chat').innerHTML = '';
  if (!state.history.length) {
    $('#chat').innerHTML = `<div class="msg notice">Ask the agent to plan tonight's imaging, point at something, or check the sky. It can see both cameras and the live stack.</div>`;
  }
  state.history.forEach(renderEntry);
  scrollChat(true);
}

function scrollChat(force) {
  const c = $('#chat');
  if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 160) c.scrollTop = c.scrollHeight;
}

const pendingRender = new Map();
function onAgentEvent(ev) {
  if (ev.kind === 'reset') {
    state.history = ev.history;
    renderChat();
  } else if (ev.kind === 'entry') {
    const i = state.history.findIndex((h) => h.id === ev.entry.id);
    if (i >= 0) state.history[i] = ev.entry;
    else state.history.push(ev.entry);
    if (state.history.length === 1) $('#chat').innerHTML = '';
    renderEntry(ev.entry);
    scrollChat();
  } else if (ev.kind === 'delta') {
    let e = state.history.find((h) => h.id === ev.id);
    if (!e) {
      e = { kind: 'assistant', id: ev.id, text: '', thinking: '', streaming: true };
      state.history.push(e);
    }
    if (ev.channel === 'text') e.text += ev.delta;
    else e.thinking += ev.delta;
    e.streaming = true;
    if (!pendingRender.has(e.id)) {
      pendingRender.set(e.id, setTimeout(() => {
        pendingRender.delete(e.id);
        renderEntry(e);
        scrollChat();
      }, 80));
    }
  }
}

$('#chat').addEventListener('click', (e) => {
  const img = e.target.closest('img[data-cap]');
  if (img) lightbox(img.src, img.dataset.cap);
});

async function sendPrompt() {
  const text = $('#prompt').value.trim();
  if (!text) return;
  const images = state.attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
  $('#btn-send').disabled = true;
  try {
    await api('agent/prompt', { text, images });
    $('#prompt').value = '';
    state.attachments = [];
    renderAttachments();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('#btn-send').disabled = false;
  }
}
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  sendPrompt();
};
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$('#btn-abort').onclick = () => api('agent/abort', {}).catch((e) => toast(e.message, true));
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

async function loadLibrary() {
  try {
    const lib = await api('library');
    $('#lib-root').textContent = lib.root;
    $('#library').innerHTML = lib.targets.length
      ? lib.targets.map((t) => `<div class="lib-target"><b>${esc(t.target)}</b> ${t.sessions.map((s) => `<div class="muted small">${esc(s.name)} — ${s.lights} lights</div>`).join('')}</div>`).join('')
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
setView('main', 'tele');
setView('a', 'wide');
setView('b', 'stack');
connect();
