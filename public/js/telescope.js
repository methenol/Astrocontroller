/** The telescope's state: header chips, the status grid, the stacking bar, the address and the link. */
import { $, $$, esc, fmtDur, fixed, toast, fmtClock, unsupported } from './dom.js';
import { api } from './api.js';
import { on, emit } from './bus.js';
import { state } from './state.js';

/** totalCount at or above this means "until stopped" */
const OPEN_ENDED_COUNT = 999;
const ALERT_STATES = new Set(['unresponsive', 'contended']);
let linkAlert = null;
let stuckAlert = '';

export function setConn(ok, text) {
  const c = $('#chip-conn');
  c.classList.toggle('ok', ok);
  $('span', c).textContent = text;
}

function connText(t) {
  const ls = t.link?.state;
  if (t.connected) return t.device?.name ?? 'connected';
  if (t.released) return 'released';
  if (ls === 'unresponsive') return '⚠ telescope not responding';
  if (ls === 'contended') return '⚠ another app has the telescope';
  return 'telescope offline';
}

function renderChips(t) {
  setConn(!!t.connected, connText(t));
  $('#chip-conn').title = t.link?.detail ?? '';
  // the user has to act on these: say so once per episode
  const ls = t.link?.state;
  if (ALERT_STATES.has(ls) && linkAlert !== ls && t.link?.detail) toast(t.link.detail, true);
  linkAlert = ALERT_STATES.has(ls) ? ls : null;
  const stuck = Object.keys(t.photoStuckSince ?? {}).sort().join(',');
  if (stuck && stuck !== stuckAlert) toast(`The ${stuck.replace(',', ' and ')} camera is stuck in a photo that never finished and refuses commands: reboot the telescope to clear it.`, true);
  stuckAlert = stuck;

  const lb = $('#btn-link');
  lb.textContent = t.released ? 'Connect' : 'Disconnect';
  lb.classList.toggle('primary', !!t.released);
  lb.classList.toggle('ghost', !t.released);
  $('#chip-battery').textContent = t.battery == null ? '🔋 –' : `🔋 ${t.battery}%${t.charging ? ' ⚡' : ''}`;
  $('#chip-temp').textContent = t.temperatureC == null ? '🌡 –' : `🌡 ${t.temperatureC}° body · ${t.cmosTempC?.tele ?? '–'}° sensor`;
  const nd = t.ndLock ? ' · ND lock' : '';
  $('#chip-mode').textContent = `${t.shootingMode?.name ?? 'mode –'}${t.operation ? ` · ${t.operation}…` : ''}${nd}`;
  $('#chip-mode').title = [
    t.operation ? `The telescope is busy ${t.operation}; other commands wait until it finishes.` : '',
    t.ndLock ? 'The ND filter is fitted for darks: motion and light captures are refused until it is removed (dark_frames action=nd_removed).' : '',
  ].filter(Boolean).join(' ');
  const m = t.motors ?? {};
  const mount = t.bodyMode === 'eq' ? 'EQ' : t.bodyMode === 'altaz' ? 'Alt-Az' : 'mount';
  $('#chip-mount').textContent = m.homed === false ? `${mount} · not homed` : m.pitchDeg != null ? `${mount} · rot ${m.rotationDeg}° pitch ${m.pitchDeg}°` : mount;
  $('#chip-sd').textContent = t.storage ? `SD ${t.storage.availableGB}/${t.storage.totalGB} GB` : 'SD –';
  const sel = $('#sel-mode');
  if (t.shootingMode?.name && document.activeElement !== sel) sel.value = t.shootingMode.name;
}

function renderGrid(t) {
  const cal = t.calibration?.result;
  const eq = t.eqSolving?.result;
  const g = [
    ['Calibration', `${t.calibration?.state ?? '–'}${cal ? ` (az ${fixed(cal.azimuth, 1)}°, alt ${fixed(cal.altitude, 1)}°)` : ''}`],
    ['GoTo', `${t.goto?.state ?? '–'}${t.goto?.target ? ` · ${t.goto.target}` : ''}`],
    ['Tracking', `${t.tracking?.state ?? '–'}${t.tracking?.target ? ` · ${t.tracking.target}` : ''}`],
    ['Focus', t.focusPosition ?? '–'],
    ['Autofocus', `${t.autofocus?.state ?? '–'}${t.autofocus?.astro ? ` / astro ${t.autofocus.astro}` : ''}`],
    ['Polar align', eq ? `az ${fixed(eq.azimuthErrorDeg * 60, 1)}′ alt ${fixed(eq.altitudeErrorDeg * 60, 1)}′` : t.eqSolving?.state ?? '–'],
    ['FOV tele', t.fov?.tele ? `${t.fov.tele.h}°×${t.fov.tele.v}°` : '–'],
    ['Capture', Object.entries(t.capture ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'idle'],
    ['Sentry', t.sentry?.state ?? '–'],
    ['Darks', darkText(t.darkCapture)],
    ['Firmware', t.device?.firmware ?? '–'],
  ];
  const obs = state.config?.observer;
  if (obs) g.push(['Observer', `${fixed(obs.lat, 3)}, ${fixed(obs.lon, 3)}`]);
  $('#status-grid').innerHTML = g.map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join('');
}

function darkText(d) {
  if (!d?.state) return '–';
  const what = d.exposureS != null ? ` · ${d.exposureS} s gain ${d.gain ?? '?'} ×${d.frames ?? '?'}` : '';
  const end = d.state === 'running' && d.expectedEndAt ? ` · until ~${fmtClock(d.expectedEndAt)}` : '';
  return `${d.state}${what}${end}${d.error ? ` · ${d.error}` : ''}`;
}

/** The Focus group's readout line: what the last measurement said, or where a search has got to. */
function renderFocusTune(t) {
  const ft = t.focusTune;
  for (const b of $$('#grp-focus button')) b.disabled = !!ft?.running || unsupported(b);
  if (!ft?.message) return;
  $('#focus-note').textContent = ft.running ? `Star tune: ${ft.message}` : `${fmtClock(ft.finishedAt ?? ft.startedAt)} · ${ft.message}`;
}

/** The Polar group's readout line: measuring, or the last result with the adjustment to make. */
function renderPolarAlign(t) {
  const pa = t.polarAlign;
  $('#btn-polar').disabled = !!pa?.running || unsupported($('#btn-polar'));
  if (!pa?.message) return;
  const note = $('#polar-note');
  note.textContent = pa.running ? `Polar alignment: ${pa.message}` : `${fmtClock(pa.finishedAt ?? pa.startedAt)} · ${pa.message}`;
  note.classList.toggle('err', pa.ok === false);
}

function renderRecord(t) {
  const recording = /running/.test(t.capture?.record ?? '');
  const rb = $('#btn-record');
  if (rb.disabled) return; // a toggle is in flight: its answer sets the button
  rb.classList.toggle('on', recording);
  rb.textContent = recording ? '■ Stop rec' : '● Record';
}

function renderStackBar(t) {
  const st = t.stacking ?? {};
  // a running stack first (either camera), then the last one with frames to show
  const live = (c) => c?.state === 'running' || c?.state === 'stopping';
  const s = live(st.tele) ? st.tele : live(st.wide) ? st.wide : st.tele?.currentCount ? st.tele : st.wide?.currentCount ? st.wide : null;
  const bar = $('#stackbar');
  if (!s || !(s.state === 'running' || s.state === 'stopping' || s.currentCount)) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const taken = s.currentCount ?? 0;
  const stacked = s.stackedCount ?? 0;
  $('#stack-target').textContent = `${s.state === 'running' ? 'Stacking' : 'Stack'} · ${s.target ?? 'target'}`;
  // an open-ended stack has no fraction done: the bar stays empty rather than creep towards "999"
  const bounded = s.totalCount > 0 && s.totalCount < OPEN_ENDED_COUNT;
  const pct = bounded ? Math.min(100, (100 * taken) / s.totalCount) : 0;
  $('#stack-progress').style.width = `${pct}%`;
  $('#stack-text').textContent = `${stacked} stacked / ${taken} taken${bounded ? ` of ${s.totalCount}` : ''}`;
  $('#stack-stats').innerHTML = [`integration ${fmtDur(s.stackedTimeS)}`, `elapsed ${fmtDur(s.shootingTimeS)}`, `rejected ${Math.max(0, taken - stacked)}`, `state ${s.state}`].map((x) => `<span>${esc(x)}</span>`).join('');
  $('#meta-stack').textContent = `${stacked} frames`;
}

export function renderTelescope(t) {
  if (!t || typeof t !== 'object') return;
  state.telescope = t;
  renderChips(t);
  renderGrid(t);
  renderFocusTune(t);
  renderPolarAlign(t);
  renderRecord(t);
  renderStackBar(t);
  emit('telescope', t);
}

/** Live stacking would be cut short: the confirm prompts say so. */
export const stackWarning = () => {
  const st = state.telescope?.stacking ?? {};
  const running = ['tele', 'wide'].filter((c) => st[c]?.state === 'running');
  return running.length ? ` Live stacking (${running.join(' and ')}) is running and will be interrupted.` : '';
};

// ---- power and the link
for (const b of $$('[data-power]')) {
  b.addEventListener('click', async () => {
    const act = b.dataset.power;
    const reboot = act === 'reboot';
    if (!confirm(reboot ? `Reboot the telescope?${stackWarning()} It reconnects in about a minute${state.config?.driver === 'seestar' ? '' : '; the motors then need homing'}.` : `Shut the telescope down?${stackWarning()}`)) return;
    b.disabled = true;
    try {
      const r = await api('control', { action: act });
      toast(typeof r.result === 'string' ? r.result : `${reboot ? 'Reboot' : 'Shut down'} ✓`);
    } catch (e) {
      toast(`${reboot ? 'Reboot' : 'Shut down'}: ${e.message}`, true);
    } finally {
      b.disabled = unsupported(b);
    }
  });
}

$('#btn-link').onclick = async () => {
  const released = !!state.telescope?.released;
  if (!released) {
    const running = [...state.jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued').length;
    if (!confirm(`Release the telescope? Astrocontroller closes every connection to it (control, video, transfers) until you press Connect.${running ? ` ${running} transfer(s) will be cancelled (run them again later; copied files are skipped).` : ''}`)) return;
  }
  const b = $('#btn-link');
  b.disabled = true;
  try {
    const r = await api('link', { connect: released });
    toast(released ? 'Connecting…' : `Telescope released${r.cancelledTransfers ? `, ${r.cancelledTransfers} transfer(s) cancelled` : ''}`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false;
  }
};

// ---- the telescope's address
export function renderHost() {
  const h = state.config?.telescopeHost;
  if (!h) return;
  const inp = $('#inp-host');
  if (document.activeElement !== inp) inp.value = h.host;
  const v = h.envVar ?? 'DWARF_HOST';
  $('#host-note').textContent = h.source === 'ui' ? `Set here (overrides ${v} ${h.envHost}; clear the field to go back to it).` : `From ${v} in .env.`;
}
on('config', renderHost);

$('#host-form').onsubmit = async (e) => {
  e.preventDefault();
  const h = state.config?.telescopeHost;
  const host = $('#inp-host').value.trim();
  const target = host || h?.envHost;
  if (target === h?.host && (host || h?.source === 'env')) return toast(`Already using ${target}`);
  if (state.telescope?.connected && !confirm(`Connect to the telescope at ${target}?${stackWarning()} The current connection is closed.`)) return;
  $('#btn-host').disabled = true;
  try {
    state.config = await api('telescope-host', { host });
    $('#inp-host').blur();
    emit('config', state.config);
    toast(state.telescope?.released ? `Address set to ${state.config.telescope} (press Connect)` : `Connecting to ${state.config.telescope}…`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#btn-host').disabled = false;
  }
};
