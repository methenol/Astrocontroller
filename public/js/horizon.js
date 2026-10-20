/** Tonight: the site's obstruction map — survey it, see it, clear it, import or export it. */
import { $, esc, fmtClock, lightbox, toast } from './dom.js';
import { api, apiToast } from './api.js';
import { on } from './bus.js';

const PLOT_W = 720;
const PLOT_H = 160;
const PLOT_MIN_ALT = 30;
const COMPASS = [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'], [360, 'N']];

let mask = null;
let survey = null;
let loadSeq = 0;
// set when the map changed here, so the plan below is reloaded with it
let onChange = () => {};

export function onHorizonChange(fn) {
  onChange = fn;
}

/** The profile as a filled skyline: azimuth across (north at both ends), altitude up; unobserved bins hatched. */
function plot(m) {
  const prof = Array.isArray(m.profile) ? m.profile : [];
  const top = Math.max(PLOT_MIN_ALT, Math.ceil(Math.max(0, ...prof.filter((v) => v != null)) / 10) * 10);
  const x = (az) => (az / 360) * PLOT_W;
  const y = (alt) => PLOT_H - (alt / top) * PLOT_H;
  const runs = [];
  let cur = null;
  prof.forEach((v, k) => {
    if (v == null) {
      cur = null;
      return;
    }
    if (!cur) runs.push((cur = []));
    cur.push([k, v], [k + 1, v]);
  });
  const fills = runs.map((r) => `<polygon class="hz-fill" points="${[[r[0][0], 0], ...r, [r[r.length - 1][0], 0]].map(([a, v]) => `${x(a).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
  const unknown = prof.map((v, k) => (v == null ? `<rect class="hz-unknown" x="${x(k).toFixed(1)}" y="0" width="${(PLOT_W / 360).toFixed(2)}" height="${PLOT_H}"/>` : '')).join('');
  const capped = (m.capped ?? []).map((k) => `<rect class="hz-capped" x="${x(k).toFixed(1)}" y="0" width="${(PLOT_W / 360).toFixed(2)}" height="3"/>`).join('');
  const grid = [];
  for (let a = 10; a < top; a += 10) grid.push(`<line class="hz-grid" x1="0" x2="${PLOT_W}" y1="${y(a)}" y2="${y(a)}"/><text class="hz-lbl" x="3" y="${y(a) - 2}">${a}°</text>`);
  const ticks = COMPASS.map(([a, n]) => `<line class="hz-grid" x1="${x(a)}" x2="${x(a)}" y1="0" y2="${PLOT_H}"/><text class="hz-lbl" x="${Math.min(PLOT_W - 14, Math.max(2, x(a) - 6))}" y="${PLOT_H + 13}">${n}</text>`).join('');
  return `<svg class="hz-plot" viewBox="0 0 ${PLOT_W} ${PLOT_H + 16}" role="img" aria-label="Obstruction altitude by compass direction">
    ${unknown}${grid.join('')}${ticks}${fills}${capped}</svg>`;
}

function render() {
  const el = $('#horizon');
  const running = !!survey?.running;
  const buttons = `<div class="ctl-row hz-buttons">
      ${running ? '<button id="hz-stop">Stop survey</button>' : '<button id="hz-run" title="Pan all round with the wide camera and map the trees and buildings (night only, ~20 min)">Map obstructions</button>'}
      ${mask && !running ? '<button class="ghost" id="hz-clear" title="Forget this site\'s map: the planner goes back to the minimum altitude alone">Clear</button>' : ''}
      ${mask ? '<button class="ghost" id="hz-export" title="Download as azimuth altitude lines for other planners">Export</button>' : ''}
      ${running ? '' : '<button class="ghost" id="hz-import-btn" title="A horizon file of azimuth altitude lines (N.I.N.A., Stellarium, Clear Night Coach, Telescopius)">Import</button><input type="file" id="hz-import" accept=".hrz,.txt,.csv,text/plain" hidden>'}
    </div>`;
  let status;
  if (running) {
    const pct = survey.total ? Math.round(((survey.index ?? 0) / survey.total) * 100) : 0;
    status = `<div class="small">${esc(survey.phase)} · ${esc(survey.message ?? '')}</div><div class="progress"><div style="width:${pct}%"></div></div>`;
  } else {
    const last = survey?.error ? `<div class="small hz-error">Last survey (${esc(fmtClock(survey.finishedAt))}) failed: ${esc(survey.error)}</div>` : '';
    status = mask
      ? `<div class="small">${esc(mask.summary)}${mask.notObserved?.length ? ` · not observed: ${esc(mask.notObserved.join(', '))}` : ''}</div>${last}`
      : `<div class="small muted">No obstruction map for this site: the planner uses the minimum altitude alone. Map it at night with the scope set up where it will shoot.</div>${last}`;
  }
  const pano = mask?.panoramaUrl ? `<img class="hz-pano" id="hz-pano" src="${esc(mask.panoramaUrl)}" alt="The surroundings unrolled, north at the left edge: red = obstruction line, yellow = the limit the planner uses" title="Red = obstruction line · yellow = the planner's limit (with margin)">` : '';
  el.innerHTML = `<div class="row-head"><h3>Site obstructions</h3></div>${buttons}${status}${mask ? plot(mask) : ''}${pano}`;
}

export async function loadHorizon() {
  const mine = ++loadSeq;
  try {
    const r = await api('horizon');
    if (mine !== loadSeq) return;
    mask = r.mask;
    survey = r.survey;
    render();
  } catch (e) {
    if (mine === loadSeq) $('#horizon').innerHTML = `<h3>Site obstructions</h3><span class="muted small">${esc(e.message)}</span>`;
  }
}

$('#horizon').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.id === 'hz-run') {
    if (!confirm('Map the obstructions around the scope?\n\nThe telescope GoTos two or three sky positions to fix its pointing by plate solving (calibrating if needed), then pans all round at low altitude taking wide-camera stills, about 15–25 minutes. Night only; set it up where it will shoot and point it at clear sky first. The wide camera\'s settings are restored afterwards.')) return;
    t.disabled = true;
    if (await apiToast('horizon/survey', {})) toast('Obstruction survey started');
    loadHorizon();
  } else if (t.id === 'hz-stop') {
    await apiToast('horizon/stop', {});
  } else if (t.id === 'hz-clear') {
    if (!confirm('Clear this site\'s obstruction map? The planner goes back to the minimum altitude alone.')) return;
    if (await apiToast('horizon', undefined, 'DELETE')) {
      toast('Obstruction map cleared');
      await loadHorizon();
      onChange();
    }
  } else if (t.id === 'hz-export') {
    location.href = 'api/horizon/export';
  } else if (t.id === 'hz-import-btn') {
    $('#hz-import').click();
  } else if (t.id === 'hz-pano') {
    lightbox(t.src, 'North at the left edge · red = obstruction line · yellow = the planner\'s limit');
  }
});

$('#horizon').addEventListener('change', async (e) => {
  if (e.target.id !== 'hz-import') return;
  const file = e.target.files?.[0];
  if (!file) return;
  const r = await apiToast('horizon/import', { text: await file.text() });
  if (r) {
    toast('Horizon imported');
    await loadHorizon();
    onChange();
  }
});

// progress over the state socket; the finished map (and the plan it changes) is fetched when a run ends
on('telescope', (t) => {
  const s = t.horizonSurvey ?? null;
  const was = survey;
  if (JSON.stringify(s) === JSON.stringify(was)) return;
  survey = s;
  if (was?.running && !s?.running) {
    if (s?.error) toast(`Obstruction survey: ${s.error}`, true);
    loadHorizon().then(onChange);
  } else if ($('#horizon').offsetParent !== null) {
    render();
  }
});
