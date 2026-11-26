/**
 * The Camera group's filter and its full settings list, read and set through the agent's own
 * get_camera_settings / set_camera_setting tools so both drivers behave as they do for the agent
 * (the Dwarf's per-mode parameters, the Seestar's filter wheel with its focus offset).
 *
 * The two drivers report their settings in different shapes: the Dwarf names each parameter with
 * its options or range; the Seestar has a few camera fields and then its own settings by key. Both
 * become one list of rows here: a label, the current value, and the control that fits it.
 */
import { $, $$, esc, toast } from './dom.js';
import { on } from './bus.js';
import { state } from './state.js';
import { runTool, hasTool } from './tools.js';

/** The tele filters until the telescope reports its own (the Dwarf's names, the Seestar's wheel). */
const FILTERS = { dwarf: ['VIS', 'Astro', 'Duo-Band'], seestar: ['IRCUT', 'LP', 'Dark'] };

let filters = { driver: null, options: [], current: null };
let loadingFilters = null;

const driver = () => state.config?.driver ?? 'dwarf';

/** The filter selects: the Camera group's (it applies at once) and the Stacking form's (sent with the start). */
function renderFilters() {
  const opts = filters.options.length ? filters.options : (FILTERS[driver()] ?? []);
  const sel = $('#sel-filter');
  if (document.activeElement !== sel) {
    sel.innerHTML = `<option value="">${filters.current ? `filter: ${esc(filters.current)}` : 'filter…'}</option>${opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}`;
  }
  const st = $('#stack-filter');
  const keep = st.value;
  st.innerHTML = `<option value="">as is${filters.current ? ` (${esc(filters.current)})` : ''}</option>${opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}`;
  if (opts.includes(keep)) st.value = keep;
}

/** The tele's filter options and the one in, from the telescope (once per driver, and after a change). */
async function loadFilters(force = false) {
  if (!state.telescope?.connected || !hasTool('get_camera_settings')) return renderFilters();
  if (loadingFilters || (!force && filters.driver === driver())) return loadingFilters;
  loadingFilters = (async () => {
    const r = await runTool('get_camera_settings', { camera: 'tele' }, { label: 'Filters', quiet: true, silent: true });
    const j = r?.json ?? {};
    if (j.filterWheel) filters = { driver: driver(), options: (j.filterWheel.slots ?? []).filter(Boolean), current: j.filterWheel.name ?? null };
    else if (j.settings?.filter) filters = { driver: driver(), options: (j.settings.filter.options ?? []).map(String), current: j.settings.filter.current ?? null };
    else filters = { driver: driver(), options: [], current: null };
    loadingFilters = null;
    renderFilters();
  })();
  return loadingFilters;
}

$('#sel-filter').onchange = async (e) => {
  const value = e.target.value;
  if (!value) return;
  await runTool('set_camera_setting', { camera: 'tele', setting: 'filter', value }, { label: `Filter ${value}`, quiet: true });
  e.target.blur();
  await loadFilters(true);
};

for (const id of ['#grp-mode', '#grp-stack']) {
  $(id).addEventListener('toggle', (e) => {
    if (e.target.open) void loadFilters();
  });
}
on('config', () => {
  if (filters.driver !== driver()) filters = { driver: null, options: [], current: null };
  renderFilters();
});
on('tools', () => {
  if ($('#grp-mode').open || $('#grp-stack').open) void loadFilters();
});

// ---- every setting

/** "a..b" → [a, b] */
const rangeOf = (r) => {
  const m = /^(-?[\d.]+)\.\.(-?[\d.]+)$/.exec(String(r ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const words = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

/**
 * The settings as rows: { section, key, label, kind: bool|select|number|text|json, value, options?, min?, max?, unit? }.
 * A Dwarf entry is { current, options | range | type: 'bool' }; options with a hint among them
 * ("or a kelvin value…") become a free field with suggestions.
 */
export function settingRows(json, drv) {
  const rows = [];
  if (drv === 'seestar' || json?.filterWheel !== undefined || json?.exposure?.stackSubS !== undefined) {
    const cam = 'Camera';
    rows.push({ section: cam, key: 'exposure', label: 'Stack sub length', kind: 'number', value: json.exposure?.stackSubS, unit: 's', min: 0 });
    rows.push({ section: cam, key: 'live_exposure', label: 'Live exposure', kind: 'number', value: json.exposure?.liveS, unit: 's', min: 0 });
    rows.push({ section: cam, key: 'gain', label: 'Gain', kind: 'number', value: json.gain, min: 0 });
    if (json.filterWheel) rows.push({ section: cam, key: 'filter', label: 'Filter', kind: 'select', value: json.filterWheel.name, options: (json.filterWheel.slots ?? []).filter(Boolean) });
    for (const [k, v] of Object.entries(json.settings ?? {})) {
      if (k === 'exp_ms' || k === 'second_camera') continue;
      const kind = typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : v && typeof v === 'object' ? 'json' : 'text';
      rows.push({ section: 'Seestar settings', key: k, label: words(k), kind, value: kind === 'json' ? JSON.stringify(v) : v });
    }
    return rows;
  }
  const add = (section, entries) => {
    for (const [k, e] of Object.entries(entries ?? {})) {
      if (!e || typeof e !== 'object') continue;
      const value = e.current;
      const range = rangeOf(e.range);
      const opts = Array.isArray(e.options) ? e.options.filter((o) => o !== null && typeof o !== 'object') : null;
      const hints = opts?.filter((o) => typeof o === 'string' && /\s/.test(o) && /^or\b/i.test(o)) ?? [];
      const row = { section, key: k, label: words(k), value, note: e.note };
      if (e.type === 'bool') rows.push({ ...row, kind: 'bool', value: value === true || value === 1 });
      else if (opts?.length && !hints.length) rows.push({ ...row, kind: 'select', options: opts.map(String) });
      else if (opts?.length) rows.push({ ...row, kind: 'text', options: opts.filter((o) => !hints.includes(o)).map(String), hint: hints.join(' ') });
      else if (range) rows.push({ ...row, kind: 'number', min: range[0], max: range[1] });
      else rows.push({ ...row, kind: typeof value === 'number' ? 'number' : 'text' });
    }
  };
  add('Camera', json?.settings);
  add(`Mode${json?.modeId !== undefined ? ` (id ${json.modeId})` : ''}`, json?.modeSettings);
  add('Whole telescope', json?.deviceSettings);
  return rows;
}

function control(r, i) {
  const id = `cs-${i}`;
  const v = r.value ?? '';
  if (r.kind === 'bool') {
    return `<span class="sw-seg" role="group" aria-label="${esc(r.label)}"><button type="button" data-cs="${i}" data-v="true" aria-pressed="${r.value === true}">On</button><button type="button" data-cs="${i}" data-v="false" aria-pressed="${r.value === false}">Off</button></span>`;
  }
  if (r.kind === 'select') {
    const opts = r.options.includes(String(v)) || v === '' ? r.options : [String(v), ...r.options];
    return `<select id="${id}" data-cs="${i}" aria-label="${esc(r.label)}">${opts.map((o) => `<option${String(o) === String(v) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  const list = r.options?.length ? ` list="${id}-l"` : '';
  const dl = r.options?.length ? `<datalist id="${id}-l">${r.options.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : '';
  const num = r.kind === 'number' ? ` type="number" step="any" inputmode="decimal"${r.min !== undefined ? ` min="${r.min}"` : ''}${r.max !== undefined ? ` max="${r.max}"` : ''}` : ' spellcheck="false" autocapitalize="off"';
  return `<input id="${id}" data-cs="${i}" value="${esc(v)}"${num}${list} enterkeyhint="done" aria-label="${esc(r.label)}"${r.hint ? ` placeholder="${esc(r.hint)}"` : ''}>${dl}${r.unit ? `<span class="muted small">${esc(r.unit)}</span>` : ''}`;
}

let rows = [];
let shownFor = null;

function renderSettings(camera) {
  const box = $('#cam-settings');
  if (!rows.length) {
    box.innerHTML = '<p class="small muted">The telescope reported no settings.</p>';
    return;
  }
  let section = null;
  box.innerHTML = rows
    .map((r, i) => {
      const head = r.section !== section ? `<h5 class="cs-sec">${esc((section = r.section))}</h5>` : '';
      const range = r.min !== undefined && r.max !== undefined ? ` <span class="muted small">${r.min}–${r.max}</span>` : '';
      return `${head}<div class="cs-row"><span class="cs-label" title="${esc(r.note ?? r.key)}">${esc(r.label)}${range}</span><span class="cs-ctl">${control(r, i)}</span></div>`;
    })
    .join('');
  shownFor = camera;
}

async function showSettings() {
  const camera = $('#cs-cam').value;
  const r = await runTool('get_camera_settings', { camera }, { label: `${camera} settings`, button: $('#btn-cam-settings'), quiet: true, silent: true });
  if (!r) return;
  rows = settingRows(r.json ?? {}, driver());
  renderSettings(camera);
}
$('#btn-cam-settings').onclick = showSettings;
$('#cs-cam').onchange = () => {
  if (shownFor) void showSettings();
};

/** A setting changed in the list: the value typed as the row's kind, applied, and the list read again. */
async function apply(i, raw) {
  const r = rows[i];
  if (!r) return;
  let value = raw;
  if (r.kind === 'bool') value = raw === 'true';
  else if (r.kind === 'number') {
    if (raw === '') return;
    value = Number(raw);
    if (!Number.isFinite(value)) return toast(`${r.label}: "${raw}" is not a number`, true);
  } else if (r.kind === 'json') {
    try {
      JSON.parse(raw);
    } catch {
      return toast(`${r.label}: not valid JSON`, true);
    }
  } else if (r.kind === 'select' && /^-?\d+(\.\d+)?$/.test(raw) && typeof r.value === 'number') value = Number(raw);
  for (const el of $$(`[data-cs="${i}"]`)) el.disabled = true;
  const ok = await runTool('set_camera_setting', { camera: shownFor ?? 'tele', setting: r.key, value }, { label: `${r.label} → ${raw}`, quiet: true });
  if (ok && r.key === 'filter') void loadFilters(true);
  await showSettings();
}

$('#cam-settings').addEventListener('change', (e) => {
  const el = e.target.closest('[data-cs]');
  if (el && el.tagName !== 'BUTTON') void apply(Number(el.dataset.cs), el.value.trim());
});
$('#cam-settings').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cs]');
  if (b && b.getAttribute('aria-pressed') !== 'true') void apply(Number(b.dataset.cs), b.dataset.v);
});
