/**
 * The agent chat. It is rendered incrementally: every entry keeps its DOM element, and a
 * streaming message only appends to its reasoning block and re-renders its own answer text, so an
 * open reasoning block keeps its state and its scroll position. Whether the view follows new
 * output is decided by the user's own scrolling (at the bottom = follow), and a ResizeObserver
 * keeps it pinned while content grows (streaming text, tool results, images that load later).
 */
import { $, $$, esc, md, toast, lightbox, fmtClock, fmtSecs } from './dom.js';
import { api, apiToast, captureUrl } from './api.js';
import { state } from './state.js';
import { grow, showScreen } from './shell.js';

/** The busy timer redraws this often. */
const ACTIVITY_TICK_MS = 1000;
const CONTEXT_HIGH = 80;
const CONTEXT_MID = 60;
const QUEUE_PREVIEW = 60;
const TOOL_ERROR_PREVIEW = 200;
const FOLLOW_SLACK_PX = 40;
const THINK_FOLLOW_PX = 24;
// what the server's prompt schema accepts (src/web/routes/agent.ts): checked here so a refusal is
// explained when the image is attached, not after the message was typed and sent
const MAX_ATTACHMENTS = 8;
const MAX_ATTACH_B64_CHARS = 16 * 1024 * 1024;
const MAX_ATTACH_TOTAL_B64_CHARS = 56 * 1024 * 1024;
const ATTACH_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const ui = {
  stick: true, // follow new output
  unseen: 0, // entries added while scrolled up
  thinkOpen: new Map(), // entry id -> the user's choice for its reasoning block
  toolOpen: new Map(), // entry id -> the user's choice for a tool block
  dirty: new Set(), // assistant entries with deltas not yet drawn
  frame: 0,
  lastPrompt: '',
  lastTop: 0,
  statusTimer: 0,
};
/** per assistant element: how much reasoning is drawn, the drawn answer, reasoning timing */
const drawn = new WeakMap();
const box = $('#chat');
const inner = $('#chat-inner');
const nearBottom = (el, slack = FOLLOW_SLACK_PX) => el.scrollHeight - el.scrollTop - el.clientHeight <= slack;

function updateJump() {
  const b = $('#btn-jump');
  b.hidden = ui.stick;
  b.textContent = ui.unseen ? `↓ ${ui.unseen} new` : '↓ Latest';
}
function toBottom() {
  box.scrollTop = box.scrollHeight;
  ui.lastTop = box.scrollTop;
  ui.unseen = 0;
  updateJump();
}
// Any move up (wheel, touch, keys, scrollbar) stops following at once, before the next frame can
// pull the view down again; reaching the bottom resumes it.
const unstick = () => {
  if (!ui.stick) return;
  ui.stick = false;
  updateJump();
};
box.addEventListener('wheel', (e) => {
  if (e.deltaY < 0) unstick();
}, { passive: true });
box.addEventListener('touchmove', unstick, { passive: true });
box.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) unstick();
});
box.addEventListener('scroll', () => {
  const top = box.scrollTop;
  if (top < ui.lastTop - 2) ui.stick = nearBottom(box, 4);
  else if (nearBottom(box)) ui.stick = true;
  ui.lastTop = top;
  if (ui.stick) ui.unseen = 0;
  updateJump();
}, { passive: true });
new ResizeObserver(() => {
  if (ui.stick) toBottom();
}).observe(inner);
$('#btn-jump').onclick = () => {
  ui.stick = true;
  toBottom();
};

// ---- status line, context, queue, todos
const ACTIVITY = { thinking: 'Thinking', writing: 'Writing', compacting: 'Compacting context', retrying: 'Retrying the model request', idle: 'Working' };

export function renderAgentStatus(s) {
  if (!s || typeof s !== 'object') return;
  state.agent = s;
  const el = $('#agent-status');
  el.className = `agent-status${s.busy ? ' busy' : ''}${!s.ready ? ' down' : ''}`;
  el.textContent = !s.ready ? `agent offline${s.error ? ` — ${s.error}` : ' (starting…)'}` : s.model ?? 'agent';
  el.title = `${s.model ?? ''} @ ${s.baseUrl ?? ''}`;
  if (s.thinking) $('#sel-thinking').value = s.thinking;
  $('#btn-abort').hidden = !s.busy;
  $('#btn-queue').hidden = !s.busy;
  $('#btn-send').textContent = s.busy ? 'Steer' : 'Send';
  $('#btn-send').title = s.busy ? 'Enter: deliver now, at the agent\'s next step' : 'Enter';
  $('#prompt').placeholder = s.busy
    ? 'Steer the agent (Enter: now) or queue a follow-up (Alt+Enter: when it finishes)…'
    : 'Ask the agent… e.g. “What should I image tonight?” or “Raise the scope and show me the wide view”';
  renderContext(s);
  renderQueue(s.queue);
  renderTodos(Array.isArray(s.todos) ? s.todos : []);
  renderActivity();
  clearInterval(ui.statusTimer);
  if (s.busy) ui.statusTimer = setInterval(renderActivity, ACTIVITY_TICK_MS);
  else for (const id of [...ui.dirty]) flushAssistant(id);
}

function renderContext(s) {
  const c = s.context;
  const ctx = $('#ctx');
  ctx.hidden = !c;
  if (!c) return;
  const pct = Math.round(c.percent ?? 0);
  ctx.querySelector('i').style.width = `${Math.min(100, pct)}%`;
  ctx.className = `ctx${pct >= CONTEXT_HIGH ? ' high' : pct >= CONTEXT_MID ? ' mid' : ''}`;
  $('#ctx-text').textContent = `${pct}%`;
  ctx.title = `context ${(c.tokens ?? 0).toLocaleString()} of ${(c.contextWindow ?? 0).toLocaleString()} tokens${Number.isFinite(s.tokensPerSecond) && s.tokensPerSecond > 0 ? ` · ${s.tokensPerSecond.toFixed(1)} tok/s` : ''} — Compact summarises older history to free space`;
}

function renderActivity() {
  const s = state.agent;
  const el = $('#activity');
  if (!s?.busy) {
    el.hidden = true;
    return;
  }
  const a = s.activity ?? { kind: 'thinking', since: Date.now() };
  const what = a.kind === 'tool' ? `Running ${a.tool ?? 'a tool'}` : ACTIVITY[a.kind] ?? 'Working';
  el.hidden = false;
  $('#activity-text').textContent = `${what} · ${fmtSecs(Date.now() - a.since)}${s.turnStartedAt ? ` (turn ${fmtSecs(Date.now() - s.turnStartedAt)})` : ''}`;
  for (const t of $$('.tool .tstate.running', inner)) {
    const at = Number(t.dataset.at);
    if (at) t.textContent = fmtSecs(Date.now() - at);
  }
}

let queueItems = [];
function renderQueue(q) {
  queueItems = [...(q?.steering ?? []).map((m) => ['steering', m]), ...(q?.followUp ?? []).map((m) => ['followUp', m])];
  const list = $('#queue-list');
  list.hidden = !queueItems.length;
  list.innerHTML = queueItems
    .map(([kind, m], i) => `<span class="qchip ${kind}" title="${esc(m)}">${kind === 'steering' ? 'steer' : 'queued'}: ${esc(m.length > QUEUE_PREVIEW ? `${m.slice(0, QUEUE_PREVIEW)}…` : m)}<button type="button" data-q="${i}" title="remove">×</button></span>`)
    .join('');
}
$('#queue-list').onclick = (e) => {
  const i = e.target.closest('[data-q]')?.dataset.q;
  const item = i === undefined ? undefined : queueItems[Number(i)];
  if (!item) return;
  const [queue, message] = item;
  apiToast('agent/queue/remove', { message, queue });
};

const TODO_ICON = { completed: '✓', in_progress: '▸', blocked: '⏸', abandoned: '✗', pending: '○' };
function renderTodos(phases) {
  const card = $('#todo-card');
  const tasks = phases.flatMap((p) => p.tasks ?? []);
  card.hidden = !tasks.length;
  if (!tasks.length) return;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const now = tasks.find((t) => t.status === 'in_progress');
  $('#todo-summary').textContent = `Plan · ${done}/${tasks.length} done${now ? ` · now: ${now.content}` : ''}`;
  $('#todo-list').innerHTML = phases
    .map((p) => `<div class="todo-phase">${phases.length > 1 ? `<b>${esc(p.name)}</b>` : ''}${(p.tasks ?? []).map((t) => `<div class="todo ${esc(t.status)}"><span>${TODO_ICON[t.status] ?? '○'}</span>${esc(t.content)}${t.blocker ? ` <span class="muted">(${esc(t.blocker)})</span>` : ''}</div>`).join('')}</div>`)
    .join('');
}

// ---- entries
const domId = (id) => `e-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const AUTO_PREFIX = /^\[Astrocontroller /;

function entryEl(e) {
  let el = document.getElementById(domId(e.id));
  if (!el) {
    el = document.createElement('div');
    el.id = domId(e.id);
    inner.appendChild(el);
    if (!ui.stick && e.kind !== 'notice') {
      ui.unseen++;
      updateJump();
    }
  }
  return el;
}

function renderEntry(e) {
  if (!e || typeof e !== 'object') return;
  if (e.kind === 'assistant') return renderAssistant(e);
  const el = entryEl(e);
  const text = String(e.text ?? '');
  if (e.kind === 'user' && AUTO_PREFIX.test(text)) {
    // a wake from the duty loop or an event: not something the user typed
    const [head, ...rest] = text.split('\n');
    const open = el.querySelector('details')?.open ?? false;
    el.className = 'msg auto';
    el.title = fmtClock(e.at);
    el.innerHTML = `<details${open ? ' open' : ''}><summary>${esc(head.replace(/^\[|\]$/g, ''))} · ${esc(fmtClock(e.at))}</summary><pre>${esc(rest.join('\n').trim())}</pre></details>`;
  } else if (e.kind === 'user') {
    el.className = 'msg user';
    el.title = fmtClock(e.at);
    el.textContent = text + (e.images ? `  📎×${e.images}` : '');
  } else if (e.kind === 'tool') {
    renderTool(el, e);
  } else if (e.kind === 'notice') {
    el.className = `msg notice ${esc(e.level)}`;
    el.textContent = text;
  }
}

function renderTool(el, e) {
  el.className = 'tool-entry';
  const { i: argIntent, ...rest } = e.args && typeof e.args === 'object' ? e.args : {};
  const intent = e.intent ?? argIntent;
  const args = Object.keys(rest).length ? JSON.stringify(rest) : '';
  const open = ui.toolOpen.get(e.id) ?? $('details', el)?.open ?? false;
  const result = typeof e.result === 'string' ? e.result : '';
  const status = e.status === 'running' ? `<span class="tstate running" data-at="${Number(e.at) || 0}">${Number(e.at) ? fmtSecs(Date.now() - e.at) : ''}</span>`
    : e.status === 'ok' ? `<span class="tstate ok">✓ ${e.ms ? fmtSecs(e.ms) : ''}</span>`
    : '<span class="tstate error">✗ failed</span>';
  const errLine = e.status === 'error' && result ? `<div class="tool-err">${esc(result.split('\n')[0].slice(0, TOOL_ERROR_PREVIEW))}</div>` : '';
  const images = Array.isArray(e.images) ? e.images : [];
  el.innerHTML = `<details class="tool ${esc(e.status)}"${open ? ' open' : ''}><summary><span class="tname">${esc(e.name)}</span><span class="targs">${esc(intent ?? args)}</span>${status}</summary>${args ? `<pre>${esc(JSON.stringify(rest, null, 1))}</pre>` : ''}${result ? `<pre class="tres">${esc(result)}</pre>` : ''}</details>${errLine}${images.length ? `<div class="tool-images">${images.map((p) => `<img src="${esc(captureUrl(p))}" data-cap="${esc(p)}" loading="lazy" alt="">`).join('')}</div>` : ''}`;
  $('summary', el).addEventListener('click', () => ui.toolOpen.set(e.id, !$('details', el).open));
}

function renderAssistant(e) {
  const el = entryEl(e);
  let d = drawn.get(el);
  if (!d) {
    el.innerHTML = '<details class="thinking" hidden><summary></summary><pre class="t-body"></pre></details><div class="content"></div><div class="msg-meta"><time></time><button type="button" class="copy" title="copy the answer">copy</button></div>';
    const det = $('details', el);
    $('summary', el).addEventListener('click', () => ui.thinkOpen.set(e.id, !det.open));
    $('.copy', el).addEventListener('click', () => {
      const cur = state.history.find((h) => h.id === e.id);
      if (!navigator.clipboard) return toast('copy is not available here', true);
      navigator.clipboard.writeText(cur?.text ?? '').then(() => toast('copied'), () => toast('copy failed', true));
    });
    d = { thinkLen: 0, text: null, t0: 0, tEnd: 0 };
    drawn.set(el, d);
  }
  const thinking = String(e.thinking ?? '');
  const text = String(e.text ?? '');
  el.className = `msg assistant${e.streaming ? ' typing' : ''}`;
  $('time', el).textContent = fmtClock(e.at);
  // reasoning: append what is new (no re-render: keeps the block's state and scroll)
  const det = $('details', el);
  const body = $('.t-body', el);
  if (thinking) {
    det.hidden = false;
    if (thinking.length < d.thinkLen) {
      body.textContent = '';
      d.thinkLen = 0;
    }
    if (thinking.length > d.thinkLen) {
      const follow = nearBottom(body, THINK_FOLLOW_PX);
      body.append(thinking.slice(d.thinkLen));
      d.thinkLen = thinking.length;
      if (follow) body.scrollTop = body.scrollHeight;
    }
    const thinkingNow = !!e.streaming && !text; // open while it thinks, folded once it answers
    const open = ui.thinkOpen.get(e.id) ?? thinkingNow;
    if (det.open !== open) det.open = open;
    if (thinkingNow && !d.t0) d.t0 = Date.now();
    if (!thinkingNow && d.t0 && !d.tEnd) d.tEnd = Date.now();
    const ms = e.thinkingMs ?? (d.t0 ? (thinkingNow ? Date.now() : d.tEnd) - d.t0 : null);
    $('summary', el).textContent = thinkingNow ? `Thinking… ${ms != null ? fmtSecs(ms) : ''}` : ms != null ? `Thought for ${fmtSecs(ms)}` : 'Reasoning';
  }
  // answer: re-render only when its text changed
  if (text !== d.text) {
    d.text = text;
    $('.content', el).innerHTML = text ? md(text) : '';
  }
  $('.msg-meta', el).hidden = !!e.streaming || !text;
}

function flushAssistant(id) {
  ui.dirty.delete(id);
  const e = state.history.find((h) => h.id === id);
  if (e) renderAssistant(e);
}

function scheduleFlush(id) {
  ui.dirty.add(id);
  if (ui.frame) return;
  ui.frame = requestAnimationFrame(() => {
    ui.frame = 0;
    for (const d of [...ui.dirty]) flushAssistant(d);
  });
}

export function renderChat() {
  // keep the elements of entries that still exist (a reconnect resends the same history)
  const ids = new Set(state.history.map((h) => domId(h.id)));
  for (const el of [...inner.children]) if (!ids.has(el.id)) el.remove();
  const order = [...inner.children].map((c) => c.id);
  if (!order.every((id, i) => domId(state.history[i]?.id) === id)) inner.innerHTML = '';
  const stick = ui.stick;
  ui.stick = true; // a (re)load is not "new while scrolled up"
  state.history.forEach(renderEntry);
  ui.stick = stick;
  $('#chat-empty').hidden = state.history.length > 0;
  if (ui.stick) toBottom();
}

export function onAgentEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.kind === 'reset') {
    state.history = Array.isArray(ev.history) ? ev.history : [];
    if (!state.history.length) {
      inner.innerHTML = '';
      ui.thinkOpen.clear();
      ui.toolOpen.clear();
    }
    renderChat();
  } else if (ev.kind === 'entry' && ev.entry) {
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
    if (typeof ev.delta !== 'string') return;
    if (ev.channel === 'text') e.text = (e.text ?? '') + ev.delta;
    else e.thinking = (e.thinking ?? '') + ev.delta;
    e.streaming = true;
    scheduleFlush(e.id);
  }
}

inner.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-cap]');
  if (img) lightbox(img.src, img.dataset.cap);
});

// ---- composer
const prompt = $('#prompt');
prompt.addEventListener('input', () => grow(prompt));

/** Puts a request in the composer and opens the chat, for the user to send or edit. */
export function draft(text) {
  prompt.value = text;
  grow(prompt);
  showScreen('chat');
  prompt.focus();
}

let sending = false;
async function sendPrompt(mode) {
  const raw = prompt.value;
  const text = raw.trim();
  // Enter repeats while a send is on the wire: one message is sent once
  if (!text || sending) return;
  const sent = [...state.attachments];
  const images = sent.map((a) => ({ data: a.data, mimeType: a.mimeType }));
  sending = true;
  $('#btn-send').disabled = true;
  try {
    await api('agent/prompt', { text, images, mode });
    ui.lastPrompt = text;
    // what was typed or attached while it was sent stays for the next message
    if (prompt.value === raw) {
      prompt.value = '';
      grow(prompt);
    }
    state.attachments = state.attachments.filter((a) => !sent.includes(a));
    renderAttachments();
    ui.stick = true; // sending a message jumps to the conversation's end
    toBottom();
  } catch (e) {
    toast(e.message, true);
  } finally {
    sending = false;
    $('#btn-send').disabled = false;
  }
}
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  sendPrompt('steer');
};
$('#btn-queue').onclick = () => sendPrompt('followUp');
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt(e.altKey || e.ctrlKey || e.metaKey ? 'followUp' : 'steer');
  } else if (e.key === 'ArrowUp' && !prompt.value && ui.lastPrompt) {
    e.preventDefault();
    prompt.value = ui.lastPrompt;
  } else if (e.key === 'Escape' && state.agent?.busy) {
    apiToast('agent/abort', {});
  }
});
$('#btn-abort').onclick = () => apiToast('agent/abort', {});
$('#btn-compact').onclick = () => {
  if (confirm('Summarise the older conversation to free context space? (The agent keeps a summary; recent messages stay.)')) apiToast('agent/compact', {});
};
$('#btn-new').onclick = () => {
  if (confirm('Start a new conversation? (Skills and notes are kept.)')) apiToast('agent/new', {});
};
$('#sel-thinking').onchange = (e) => {
  const level = e.target.value;
  api('agent/thinking', { level }).then(() => toast(`thinking: ${level}`), (err) => {
    toast(err.message, true);
    if (state.agent?.thinking) e.target.value = state.agent.thinking;
  });
};

// ---- attachments
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsDataURL(blob);
  });
}
function renderAttachments() {
  $('#attach-list').innerHTML = state.attachments.map((a, i) => `<img src="data:${esc(a.mimeType)};base64,${esc(a.data)}" title="click to remove" data-i="${i}" alt="">`).join('');
}
/** Adds an image if the server will take it; says why not otherwise. */
function attach(data, mimeType, name) {
  if (state.attachments.length >= MAX_ATTACHMENTS) return toast(`at most ${MAX_ATTACHMENTS} images per message`, true);
  if (!ATTACH_TYPES.has(mimeType)) return toast(`${name}: only JPEG, PNG, WebP and GIF images can be sent`, true);
  if (!data) return toast(`${name} is empty`, true);
  const mb = (chars) => Math.floor((chars * 3) / 4 / 2 ** 20);
  if (data.length > MAX_ATTACH_B64_CHARS) return toast(`${name} is too large (at most ${mb(MAX_ATTACH_B64_CHARS)} MB)`, true);
  const total = state.attachments.reduce((n, a) => n + a.data.length, data.length);
  if (total > MAX_ATTACH_TOTAL_B64_CHARS) return toast(`${name} does not fit: the images of one message are at most ${mb(MAX_ATTACH_TOTAL_B64_CHARS)} MB together`, true);
  state.attachments.push({ data, mimeType });
}
$('#attach-list').onclick = (e) => {
  const i = e.target.dataset?.i;
  if (i === undefined) return;
  state.attachments.splice(Number(i), 1);
  renderAttachments();
};
$('#file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    if (!ATTACH_TYPES.has(f.type)) {
      toast(`${f.name}: only JPEG, PNG, WebP and GIF images can be sent`, true);
      continue;
    }
    try {
      attach(await blobToB64(f), f.type, f.name);
    } catch (err) {
      toast(`${f.name}: ${err.message}`, true);
    }
  }
  renderAttachments();
};
$('#btn-snap').onclick = async () => {
  try {
    const res = await fetch(`api/snapshot/${encodeURIComponent(state.mainSrc)}?t=${Date.now()}`);
    if (!res.ok) throw new Error('no frame available');
    attach(await blobToB64(await res.blob()), 'image/jpeg', 'the snapshot');
    renderAttachments();
  } catch (e) {
    toast(e.message, true);
  }
};
