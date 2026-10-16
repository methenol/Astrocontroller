/** The library: transfer jobs, sessions on the SD card, the local library, processing and captures. */
import { $, esc, fmtDur, lightbox, toast, baseName } from './dom.js';
import { api, apiToast, seg, captureUrl } from './api.js';
import { on } from './bus.js';
import { state, isPanelActive } from './state.js';

const PROCESSING_POLL_MS = 30000;
const PROCESSING_SHOWN = 20;
const CAPTURES_SHOWN = 60;
const ACTIVE_JOB = new Set(['running', 'queued']);
/** Finished jobs kept, as the server keeps them (src/library/jobs.ts): a page open for nights stays small. */
const FINISHED_JOBS_KEPT = 50;
const CANCELLABLE = new Set(['waiting', 'uploading', 'submitted']);
const RETRYABLE = new Set(['failed', 'cancelled']);

/** done/total as a whole percentage in 0..100; 0 when either is missing. */
const percent = (done, total) => (Number(total) > 0 && Number.isFinite(Number(done)) ? Math.round(Math.min(100, Math.max(0, (100 * Number(done)) / Number(total)))) : 0);

// ---- transfer jobs
export function renderJobs() {
  const finished = [...state.jobs.values()].filter((j) => !ACTIVE_JOB.has(j.status)).sort((a, b) => (b.finishedAt ?? Infinity) - (a.finishedAt ?? Infinity));
  for (const j of finished.slice(FINISHED_JOBS_KEPT)) state.jobs.delete(j.id);
  const jobs = [...state.jobs.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  $('#jobs').innerHTML = jobs.length
    ? jobs.map((j) => {
      const p = j.progress;
      const pct = p?.bytesTotal ? percent(p.bytesDone, p.bytesTotal) : percent(p?.filesDone, p?.filesTotal);
      return `<div class="job"><b>${esc(j.description)}</b> — ${esc(j.status)}${j.status === 'running' ? ` ${pct}% (${esc(p?.filesDone ?? 0)}/${esc(p?.filesTotal ?? '?')} files)` : ''}${j.error ? ` <span class="muted">${esc(j.error)}</span>` : ''}
        ${ACTIVE_JOB.has(j.status) ? `<button class="ghost" data-cancel="${esc(j.id)}">cancel</button>` : ''}
        ${j.status === 'running' ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}</div>`;
    }).join('')
    : 'no jobs';
}
$('#jobs').addEventListener('click', (e) => {
  const id = e.target.closest('[data-cancel]')?.dataset.cancel;
  if (id) apiToast(`jobs/${seg(id)}/cancel`, {});
});

// ---- the local library
async function loadLibrary() {
  try {
    const lib = await api('library');
    $('#lib-root').textContent = lib.root ?? '';
    const targets = Array.isArray(lib.targets) ? lib.targets : [];
    $('#library').innerHTML = targets.length
      ? targets.map((t) => {
        const sessions = Array.isArray(t.sessions) ? t.sessions : [];
        // one pooled image per camera: tele and wide subs never go into one stack
        const all = ['tele', 'wide']
          .map((cam) => [cam, sessions.filter((s) => s.camera === cam).length])
          .filter(([, n]) => n > 1)
          .map(([cam, n]) => ` <button class="ghost" data-process-target="${esc(t.target)}" data-process-camera="${esc(cam)}" title="stack every ${esc(cam)} session of this target as one image">Process all ${n} ${esc(cam)} nights</button>`)
          .join('');
        return `<div class="lib-target"><b>${esc(t.target)}</b>${all} ${sessions.map((s) => `<div class="muted small">${esc(s.name)} — ${esc(s.camera ?? '')} ${esc(s.lights)} lights${s.rejected ? ` (${esc(s.rejected)} rejected)` : ''} ${esc(s.startedAt ?? '')} <button class="ghost" data-process="${esc(s.name)}">Process</button></div>`).join('')}</div>`;
      }).join('')
      : 'empty';
  } catch (e) {
    $('#library').textContent = e.message;
  }
  try {
    const caps = await api('captures');
    $('#captures').innerHTML = '';
    // the server lists them oldest first; addCapture prepends, so the newest ends up first
    for (const c of (Array.isArray(caps) ? caps : []).slice(-CAPTURES_SHOWN)) addCapture(c.path, c.name);
  } catch {
    // the captures strip is optional
  }
}
$('#library').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-process], [data-process-target]');
  if (!b) return;
  try {
    await api('processing', b.dataset.processTarget ? { target: b.dataset.processTarget, camera: b.dataset.processCamera } : { session: b.dataset.process });
    toast('processing queued');
    loadProcessing();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- sessions on the SD card
$('#btn-sessions').onclick = async () => {
  $('#sessions').textContent = 'reading SD card…';
  try {
    const { sessions = [] } = await api('sessions?counts=1');
    $('#sessions').innerHTML = sessions.length
      ? sessions.map((s) => `<div class="sess"><div><b>${esc(s.target)}</b> <span class="muted">${esc(s.camera)} · ${esc(s.exposureS)}s · gain ${esc(s.gain)} · ${esc(s.startedAt ?? '')} · ${esc(s.fitsCount ?? '?')} FITS · ${esc(s.sizeMB ?? '?')} MB</span></div>${s.transferred ? '<span class="muted">in library</span>' : ''}<button data-session="${esc(s.folder)}">Transfer</button></div>`).join('')
      : 'no sessions';
  } catch (e) {
    $('#sessions').textContent = e.message;
  }
};
$('#sessions').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-session]')?.dataset.session;
  if (!f) return;
  try {
    await api('transfer', { session: f });
    toast('transfer queued');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- processing
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
  if (!q) return void (el.textContent = '–');
  if (q.error) return void (el.textContent = q.error);
  const jobs = [...(q.running ?? []), ...(q.queued ?? [])];
  el.innerHTML = jobs.length
    ? jobs.map((j) => `<div>${esc(j.label ?? j.id)} — ${esc(j.state)} ${percent(j.progress ?? 0, 1)}%${j.position != null ? ` · #${esc(j.position)}` : ''}${j.message ? ` · ${esc(j.message)}` : ''}</div>`).join('') + (q.drains_in != null ? `<div>drains in ~${esc(fmtDur(q.drains_in))}</div>` : '')
    : 'queue empty';
}
export function renderProcessing() {
  const newest = [...state.proc.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  // only the newest are shown: the rest are dropped, so pushes over many nights never pile up here
  for (const i of newest.slice(PROCESSING_SHOWN)) state.proc.delete(i.id);
  const items = newest.slice(0, PROCESSING_SHOWN);
  $('#proc-items').innerHTML = items.length
    ? items.map((i) => {
      let pct = null;
      if (i.state === 'uploading' && i.upload?.bytesTotal) pct = percent(i.upload.bytesDone, i.upload.bytesTotal);
      else if (i.state === 'submitted' && Number.isFinite(i.studio?.progress)) pct = percent(i.studio.progress, 1);
      const eta = i.state === 'submitted' && i.studio?.etaS != null ? ` · ETA ${Math.max(1, Math.round(i.studio.etaS / 60))} min` : '';
      const msg = i.lastError ?? i.studio?.message ?? i.message ?? '';
      const outs = i.state === 'done' && i.outputs?.length ? `<div class="muted small">${i.outputs.map((p) => esc(baseName(p))).join(', ')}</div>` : '';
      const btn = CANCELLABLE.has(i.state) ? `<button class="ghost" data-proc-cancel="${esc(i.id)}">Cancel</button>` : RETRYABLE.has(i.state) ? `<button class="ghost" data-proc-retry="${esc(i.id)}">Retry</button>` : '';
      return `<div class="proc-item"><b>${esc(i.target)}</b> <span class="muted small">${esc(i.profile ?? '')}</span> <span class="badge ${esc(i.state)}">${esc(i.state)}</span>${btn}
        <div class="muted small">${esc(msg)}${eta}</div>${pct != null ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}${outs}</div>`;
    }).join('')
    : 'no processing items';
}
async function loadProcessing() {
  clearTimeout(procTimer);
  try {
    const d = await api('processing');
    state.procInfo = d;
    for (const i of d.items ?? []) state.proc.set(i.id, i);
    renderProcHead();
    renderProcessing();
    renderProcQueue();
  } catch (e) {
    $('#proc-head').textContent = e.message;
  }
  if (isPanelActive('library') && !document.hidden) procTimer = setTimeout(loadProcessing, PROCESSING_POLL_MS);
}
$('#btn-proc-refresh').onclick = loadProcessing;
$('#proc-items').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-proc-cancel], [data-proc-retry]');
  if (!b) return;
  const cancel = b.dataset.procCancel;
  const id = cancel || b.dataset.procRetry;
  try {
    const item = await api(`processing/${seg(id)}/${cancel ? 'cancel' : 'retry'}`, {});
    if (item?.id) state.proc.set(item.id, item);
    renderProcessing();
  } catch (err) {
    toast(err.message, true);
  }
});
// back on screen: the poll that stopped while hidden starts again
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isPanelActive('library')) loadProcessing();
});

// ---- captures (images the agent looked at)
export function addCapture(path, label) {
  if (!path) return;
  const g = $('#captures');
  const img = document.createElement('img');
  img.src = captureUrl(path);
  img.title = label ?? path;
  img.alt = '';
  img.dataset.cap = path;
  img.onclick = () => lightbox(img.src, path);
  g.prepend(img);
  while (g.children.length > CAPTURES_SHOWN) g.lastChild.remove();
}

on('tab', (name) => {
  if (name !== 'library') return;
  loadLibrary();
  loadProcessing();
});
