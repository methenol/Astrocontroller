/**
 * Journal: what each night was. Per target, the visit as a timeline (GoTo, focus, stack, the
 * rejections, the end) and its statistics; the night's events (duty, roof, the plan, holds); and
 * the notes of the owner and the agent. Recorded by the server from the telescope's state
 * (night/recorder.ts), whatever the driver.
 */
import { $, esc, toast, busy } from './dom.js';
import { api, apiToast, seg } from './api.js';
import { on } from './bus.js';
import { state, isPanelActive } from './state.js';

const RELOAD_MS = 1500;
const MARK = {
  'goto-start': ['#93c5fd', 'GoTo'],
  'goto-done': ['#4ade80', 'on target'],
  'goto-failed': ['#f87171', 'GoTo failed'],
  'focus-start': ['#c4b5fd', 'autofocus'],
  'focus-done': ['#a78bfa', 'focused'],
  'focus-failed': ['#f87171', 'focus failed'],
  'finefocus-start': ['#c4b5fd', 'fine focus'],
  'finefocus-done': ['#a78bfa', 'fine focus done'],
  'stack-start': ['#2dd4bf', 'stacking'],
  reject: ['#fbbf24', 'rejected'],
  'stack-end': ['#2dd4bf', 'stack ended'],
  obscured: ['#f87171', 'obscured'],
  'link-lost': ['#f87171', 'link lost'],
  'link-back': ['#4ade80', 'link back'],
  note: ['#e5e7eb', 'note'],
  event: ['#8796ad', 'event'],
};

let nights = [];
let current = null; // the night shown
let data = null;
let seq = 0;

const tz = () => state.config?.observer?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const hm = (t) => (t == null ? '–' : new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t));
const secs = (s) => {
  if (s == null) return '–';
  const v = Math.round(s);
  if (v >= 3600) return `${Math.floor(v / 3600)} h ${Math.round((v % 3600) / 60)} min`;
  return v >= 60 ? `${Math.floor(v / 60)} min ${v % 60 ? `${v % 60} s` : ''}`.trim() : `${v} s`;
};

async function loadNights() {
  try {
    const r = await api('journal');
    nights = r.nights ?? [];
    if (!current || !nights.some((n) => n.night === current)) current = r.tonight ?? nights[0]?.night ?? null;
    $('#jr-night').innerHTML = nights.map((n) => `<option value="${esc(n.night)}" ${n.night === current ? 'selected' : ''}>${esc(n.night)}${n.night === r.tonight ? ' (tonight)' : ''}${n.sessions ? ` · ${n.targets.length} target${n.targets.length === 1 ? '' : 's'}, ${Math.round(n.integrationMin)} min` : ''}</option>`).join('');
  } catch (e) {
    $('#jr-summary').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

export async function loadJournal() {
  await loadNights();
  if (!current) {
    $('#jr-summary').innerHTML = '<p class="muted small">Nothing recorded yet. Every GoTo, focus and stack is written here as it happens, whatever starts it.</p>';
    $('#jr-sessions').innerHTML = '';
    return;
  }
  const mine = ++seq;
  try {
    const r = await api(`journal/${seg(current)}`);
    if (mine !== seq) return;
    data = r;
    render();
  } catch (e) {
    if (mine === seq) $('#jr-summary').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

function render() {
  const s = data.summary;
  const rejPct = s.stacked + s.rejected ? Math.round((s.rejected / (s.stacked + s.rejected)) * 100) : 0;
  $('#jr-summary').innerHTML = `<div class="jr-tiles">
    <div><span>Targets</span><b>${esc(s.targets.length)}</b><small>${esc(s.targets.join(', ') || '–')}</small></div>
    <div><span>Integration</span><b>${esc(Math.round(s.integrationMin))} min</b><small>${esc(s.sessions)} session${s.sessions === 1 ? '' : 's'}</small></div>
    <div><span>Frames kept</span><b>${esc(s.stacked)}</b><small>${esc(s.rejected)} rejected (${esc(rejPct)}%)</small></div>
    <div><span>Getting on target</span><b>${esc(s.acquireMin)} min</b><small>GoTo, solve, centre</small></div>
    <div><span>Focusing</span><b>${esc(s.focusMin)} min</b><small>autofocus and fine focus</small></div>
    <div><span>Span</span><b>${esc(hm(s.firstAt))}–${esc(hm(s.lastAt))}</b><small>${esc(s.notes)} note${s.notes === 1 ? '' : 's'}</small></div>
  </div>`;
  $('#jr-sessions').innerHTML = data.sessions.length ? data.sessions.map(sessionCard).join('') : '<div class="card muted small">No target sessions this night.</div>';
  const targets = [...new Set(data.sessions.map((x) => x.displayName ?? x.target))];
  $('#jr-note-target').innerHTML = `<option value="">the whole night</option>${targets.map((t) => `<option>${esc(t)}</option>`).join('')}`;
  $('#jr-notes').innerHTML = data.notes.length
    ? [...data.notes].reverse().map((n) => `<div class="jr-note ${esc(n.author)}" data-note="${esc(n.id)}"><div class="msg-meta"><b>${esc(n.author === 'agent' ? 'Agent' : 'You')}</b> ${esc(hm(n.at))}${n.target ? ` · ${esc(n.target)}` : ''}<span class="spacer"></span><button class="ghost" data-edit-note="${esc(n.id)}">Edit</button><button class="ghost" data-del-note="${esc(n.id)}" aria-label="Delete note">✕</button></div><div class="jr-note-text">${esc(n.text)}</div></div>`).join('')
    : '<p class="muted small">No notes yet.</p>';
  $('#jr-events').innerHTML = data.events.length
    ? `<div class="jr-events">${[...data.events].reverse().map((e) => `<div><span class="muted">${esc(hm(e.at))}</span> <span class="badge">${esc(e.kind)}</span> ${esc(e.text)}</div>`).join('')}</div>`
    : '<p class="muted small">No events.</p>';
}

/** The visit as a strip: phases as bands (getting on target, focusing, stacking), events as ticks. */
function timeline(s) {
  const W = 1000;
  const H = 46;
  const t0 = s.startedAt;
  const lastEntry = Math.max(t0, ...s.marks.map((m) => m.at), ...(s.samples ?? []).map((p) => p.at));
  const t1 = Math.max(s.endedAt ?? (s.id === data.active ? Date.now() : lastEntry), t0 + 60e3);
  const x = (t) => ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * W;
  const parts = [];
  const band = (a, b, cls, label) => {
    if (a == null) return;
    const xa = x(a);
    const xb = x(b ?? t1);
    parts.push(`<rect class="jr-band ${cls}" x="${xa}" y="14" width="${Math.max(2, xb - xa)}" height="14"><title>${esc(label)} ${esc(hm(a))}–${esc(hm(b ?? t1))}</title></rect>`);
  };
  const find = (k, after = 0) => s.marks.find((m) => m.kind === k && m.at >= after);
  for (const m of s.marks.filter((q) => q.kind === 'goto-start')) band(m.at, (find('goto-done', m.at) ?? find('goto-failed', m.at))?.at, 'goto', 'GoTo');
  for (const m of s.marks.filter((q) => q.kind === 'focus-start' || q.kind === 'finefocus-start')) band(m.at, (find(m.kind === 'focus-start' ? 'focus-done' : 'finefocus-done', m.at) ?? find('focus-failed', m.at))?.at, 'focus', 'focus');
  for (const m of s.marks.filter((q) => q.kind === 'stack-start')) band(m.at, find('stack-end', m.at)?.at ?? s.endedAt, 'stack', 'stacking');
  for (const m of s.marks) {
    const [c, label] = MARK[m.kind] ?? ['#8796ad', m.kind];
    const xm = x(m.at);
    const tall = m.kind === 'reject' ? Math.min(14, 4 + (m.n ?? 1)) : 10;
    parts.push(`<line x1="${xm}" x2="${xm}" y1="${m.kind === 'reject' ? 28 : 4}" y2="${m.kind === 'reject' ? 28 + tall : 14}" stroke="${c}" stroke-width="${m.kind === 'reject' ? 3 : 2}"><title>${esc(hm(m.at))} ${esc(label)}${m.text ? `: ${esc(m.text)}` : ''}</title></line>`);
  }
  return `<svg class="jr-strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Timeline of ${esc(s.displayName ?? s.target)}">${parts.join('')}</svg><div class="jr-axis muted small"><span>${esc(hm(t0))}</span><span>${esc(hm(t1))}</span></div>`;
}

/** Frames kept (and rejected) as the stack grew, from the samples. */
function spark(s) {
  const xs = s.samples ?? [];
  if (xs.length < 2) return '';
  const W = 300;
  const H = 46;
  const t0 = xs[0].at;
  const t1 = xs[xs.length - 1].at || t0 + 1;
  const max = Math.max(1, ...xs.map((p) => p.stacked + p.rejected));
  const pt = (t, v) => `${(((t - t0) / Math.max(1, t1 - t0)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 6)).toFixed(1)}`;
  const kept = xs.map((p) => pt(p.at, p.stacked)).join(' ');
  const rej = xs.map((p) => pt(p.at, p.rejected)).join(' ');
  const alts = xs.filter((p) => p.alt != null);
  const altLine = alts.length > 1 ? `<polyline class="jr-alt" points="${alts.map((p) => `${(((p.at - t0) / Math.max(1, t1 - t0)) * W).toFixed(1)},${(H - 2 - (p.alt / 90) * (H - 6)).toFixed(1)}`).join(' ')}"><title>altitude</title></polyline>` : '';
  return `<svg class="jr-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Frames kept and rejected over time">${altLine}<polyline class="jr-kept" points="${kept}"><title>frames kept</title></polyline><polyline class="jr-rej" points="${rej}"><title>frames rejected</title></polyline></svg>`;
}

function sessionCard(s) {
  const st = s.stats ?? {};
  const q = st.quality;
  const cell = (label, v) => (v == null || v === '' ? '' : `<div><span>${esc(label)}</span>${v}</div>`);
  const status = s.status === 'active' ? (s.id === data.active ? '<span class="badge uploading">now</span>' : '<span class="badge waiting">unfinished</span>') : s.status === 'done' ? '<span class="badge done">done</span>' : `<span class="badge ${s.status === 'failed' ? 'failed' : 'waiting'}">${esc(s.status)}</span>`;
  return `<div class="card jr-session">
    <div class="row-head"><h3>${esc(s.displayName ?? s.target)}</h3>${status}${s.planned ? '<span class="badge">planned</span>' : '<span class="badge" title="not one of the night plan\'s blocks">unplanned</span>'}<span class="muted small">${esc(hm(s.startedAt))}–${s.endedAt ? esc(hm(s.endedAt)) : 'now'}${s.endReason ? ` · ${esc(s.endReason)}` : ''}</span></div>
    ${timeline(s)}
    <div class="jr-legend muted small"><span><i class="goto"></i>getting on target</span><span><i class="focus"></i>focus</span><span><i class="stack"></i>stacking</span><span><i class="rej"></i>rejections</span></div>
    <div class="jr-stats">
      <div class="status-grid">
        ${cell('Time to target', st.acquireS != null ? `${esc(secs(st.acquireS))}${st.gotoAttempts > 1 ? ` (${esc(st.gotoAttempts)} GoTos)` : ''}` : null)}
        ${cell('Focus', st.focusS != null ? `${esc(secs(st.focusS))}${st.focusPosition != null ? ` → <b>${esc(st.focusPosition)}</b>` : ''}` : st.focusPosition != null ? `at ${esc(st.focusPosition)}` : null)}
        ${cell('Stacking', st.stackS != null ? esc(secs(st.stackS)) : null)}
        ${cell('Integration', st.integrationS != null ? `<b>${esc(secs(st.integrationS))}</b>${st.efficiencyPct != null ? ` (${esc(st.efficiencyPct)}% of the time)` : ''}` : null)}
        ${cell('Frames', st.framesTaken != null ? `${esc(st.stacked)} kept / ${esc(st.rejected)} rejected (${esc(st.rejectionPct)}%)` : null)}
        ${cell('Subs', st.subS ? `${esc(st.subS)} s${st.gain != null ? `, gain ${esc(st.gain)}` : ''}${st.filter ? `, ${esc(st.filter)}` : ''}` : null)}
        ${cell('Altitude', st.altStart != null ? `${esc(Math.round(st.altStart))}° → ${st.altEnd != null ? esc(Math.round(st.altEnd)) : '…'}°${st.altMax != null ? ` (max ${esc(Math.round(st.altMax))}°)` : ''}${st.azStart != null ? ` · az ${esc(st.azStart)}°` : ''}` : null)}
        ${cell('Moon', st.moonIllumPct != null ? `${esc(st.moonIllumPct)}%, ${st.moonAltDeg > 0 ? `up, ${esc(st.moonSepDeg)}° away` : 'down'}` : null)}
        ${cell('Sky (forecast)', st.sky != null ? `${esc(st.sky)}/100` : null)}
        ${cell('Stack quality', q ? `${q.stars != null ? `${esc(q.stars)} stars` : ''}${q.hfrPx != null ? `, HFR ${esc(Number(q.hfrPx).toFixed(2))} px` : ''}${q.background != null ? `, bg ${esc(q.background)}` : ''}` : null)}
      </div>
      ${spark(s)}
    </div>
    <details class="jr-marks"><summary class="muted small">${esc(s.marks.length)} entries</summary>${s.marks.map((m) => `<div class="small"><span class="muted">${esc(hm(m.at))}</span> <i class="jr-dot" style="background:${(MARK[m.kind] ?? ['#8796ad'])[0]}"></i> ${esc(m.text ?? (MARK[m.kind] ?? [, m.kind])[1])}</div>`).join('')}</details>
  </div>`;
}

$('#jr-night').onchange = (e) => {
  current = e.target.value;
  loadJournal();
};
const step = (d) => {
  const i = nights.findIndex((n) => n.night === current);
  const j = i + d;
  if (j < 0 || j >= nights.length) return;
  current = nights[j].night;
  loadJournal();
};
// nights are newest first: "earlier" walks down the list
$('#jr-prev').onclick = () => step(1);
$('#jr-next').onclick = () => step(-1);

$('#jr-note-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#jr-note').value.trim();
  if (!text || !current) return;
  const target = $('#jr-note-target').value || undefined;
  const r = await busy($('#jr-note-add'), () => apiToast(`journal/${seg(current)}/notes`, { text, target }));
  if (r) {
    $('#jr-note').value = '';
    toast('Note added');
    loadJournal();
  }
};

$('#jr-notes').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-note]');
  const edit = e.target.closest('[data-edit-note]');
  if (del) {
    if (!confirm('Delete this note?')) return;
    if (await apiToast(`journal/${seg(current)}/notes/${seg(del.dataset.delNote)}`, undefined, 'DELETE')) loadJournal();
  } else if (edit) {
    const n = data.notes.find((x) => x.id === edit.dataset.editNote);
    const text = n && prompt('Edit the note', n.text);
    if (text && text.trim() && text !== n.text && (await apiToast(`journal/${seg(current)}/notes/${seg(n.id)}`, { text }))) loadJournal();
  }
});

let reloadTimer = null;
on('journal-changed', (night) => {
  if (!isPanelActive('journal') || (night && night !== current && nights.some((n) => n.night === night))) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadJournal, RELOAD_MS);
});
on('tab', (name) => {
  if (name === 'journal') loadJournal();
});
