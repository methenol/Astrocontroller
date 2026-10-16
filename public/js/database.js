/**
 * The object database: search and filter the whole catalog. Every filter change re-queries the
 * server (typing is debounced) and the filters are remembered per browser. A row opens in place to
 * show the object's designations, tonight's altitude curve, and GoTo / ask-the-agent buttons.
 */
import { $, $$, esc, store, toast, timePart } from './dom.js';
import { api, control } from './api.js';
import { on } from './bus.js';
import { state } from './state.js';
import { draft } from './chat.js';
import { imagingRequest } from './tonight.js';

const GROUPS = [
  ['galaxy', 'galaxies'], ['nebula', 'nebulae'], ['emission', 'emission nebulae'], ['reflection', 'reflection nebulae'], ['dark', 'dark nebulae'],
  ['planetary', 'planetary nebulae'], ['supernova_remnant', 'supernova remnants'], ['cluster', 'star clusters'], ['open_cluster', 'open clusters'],
  ['globular', 'globular clusters'], ['galaxy_cluster', 'galaxy groups & clusters'], ['star', 'stars'],
];
const FIELDS = ['q', 'type', 'catalog', 'con', 'up', 'sort', 'maxmag', 'minsize', 'maxsize', 'minalt', 'named'];
const SELECTS = ['type', 'catalog', 'con', 'up', 'sort'];
const MORE = ['maxmag', 'minsize', 'maxsize', 'minalt', 'named'];
const PAGE = 50;
const TYPING_MS = 300;
const DEFAULT_MIN_ALT = 20;
/** GoTo is offered down to this altitude */
const GOTO_MIN_ALT = 5;
const STORE_KEY = 'db-filters';
const BRIGHT_CLASS = { 1: 'bright', 2: 'moderate', 3: 'faint' };

const db = { meta: null, items: [], total: 0, seq: 0, open: null, minAlt: DEFAULT_MIN_ALT };
const field = (f) => $(`#db-${f}`);
const value = (f) => (field(f).type === 'checkbox' ? (field(f).checked ? '1' : '') : field(f).value.trim());

function saveFilters() {
  store.set(STORE_KEY, JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, value(f)]))));
}
function restoreFilters() {
  let saved = {};
  try {
    const v = JSON.parse(store.get(STORE_KEY) || '{}');
    if (v && typeof v === 'object') saved = v;
  } catch {
    // a damaged entry is ignored
  }
  for (const f of FIELDS) {
    if (typeof saved[f] !== 'string') continue;
    if (field(f).type === 'checkbox') field(f).checked = saved[f] === '1';
    else field(f).value = saved[f];
  }
  // a stale saved option (a catalog that no longer exists) falls back to the default
  for (const f of SELECTS) if (field(f).selectedIndex < 0) field(f).selectedIndex = 0;
  if (MORE.some((f) => value(f))) field('more-filters').open = true;
}

const option = (k, label, n) => `<option value="${esc(k)}">${esc(label)} (${Number(n ?? 0).toLocaleString()})</option>`;

function fillFilters(m) {
  const groupCount = Object.fromEntries((m.groups ?? []).map((g) => [g.key, g.count]));
  field('type').insertAdjacentHTML('beforeend', GROUPS.filter(([k]) => groupCount[k]).map(([k, label]) => option(k, label, groupCount[k])).join(''));
  field('catalog').insertAdjacentHTML('beforeend', [...(m.lists ?? []).map((l) => [l.key, l.title, l.count]), ...(m.sources ?? []).map((s) => [s.key, s.title, s.objects])].map(([k, t, n]) => option(k, t, n)).join(''));
  field('con').insertAdjacentHTML('beforeend', [...(m.constellations ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((c) => option(c.abbr, c.name, c.count)).join(''));
  field('q').placeholder = `Search ${Number(m.total ?? 0).toLocaleString()} objects: M 31, Sh2-155, Veil, Vega…`;
  field('minalt').placeholder = String(state.config?.minAltitude ?? DEFAULT_MIN_ALT);
  const sources = m.sources ?? [];
  $('#db-sources').innerHTML = `<p class="muted">${Number(m.total ?? 0).toLocaleString()} objects merged from ${sources.length} catalogs${m.built ? ` (built ${esc(m.built)})` : ''}. An object in several catalogs is one entry with all its designations. Positions are J2000.</p>
    <ul class="db-src">${sources.map((s) => `<li><b>${esc(s.title)}</b> · ${Number(s.objects ?? 0).toLocaleString()}<br><span class="muted">${esc(s.cite)}</span></li>`).join('')}</ul>`;
}

/** The filters are filled once: a second call while the first is loading waits for it (no doubled options). */
let metaLoad = null;
function loadMeta() {
  metaLoad ??= api('catalog/meta').then(
    (m) => {
      db.meta = m;
      fillFilters(m);
      restoreFilters();
      return true;
    },
    (e) => {
      metaLoad = null; // the next visit tries again
      $('#db-count').textContent = `database unavailable: ${e.message}`;
      return false;
    },
  );
  return metaLoad;
}

export async function loadDatabase() {
  if (await loadMeta()) search();
}

async function search(append = false) {
  const seq = ++db.seq;
  const p = new URLSearchParams();
  const set = (k, v) => v && p.set(k, v);
  set('q', value('q'));
  set('types', value('type'));
  set('catalog', value('catalog'));
  set('constellation', value('con'));
  set('up', value('up'));
  set('sort', value('sort') === 'relevance' ? '' : value('sort'));
  set('maxMag', value('maxmag'));
  set('minSize', value('minsize'));
  set('maxSize', value('maxsize'));
  set('minAlt', value('minalt'));
  set('named', value('named'));
  p.set('offset', String(append ? db.items.length : 0));
  p.set('limit', String(PAGE));
  if (!append) $('#db-count').textContent = 'searching…';
  try {
    const r = await api(`catalog/search?${p}`);
    if (seq !== db.seq) return; // a newer search has started
    const items = Array.isArray(r.items) ? r.items : [];
    db.items = append ? [...db.items, ...items] : items;
    db.total = Number(r.total ?? db.items.length);
    db.minAlt = r.window?.minAltitude ?? state.config?.minAltitude ?? DEFAULT_MIN_ALT;
    const win = r.window ? ` · tonight ${r.window.start} → ${r.window.end}, above ${r.window.minAltitude}°` : '';
    $('#db-count').textContent = `${db.total.toLocaleString()} ${db.total === 1 ? 'object' : 'objects'}${win}`;
    render(append);
  } catch (e) {
    if (seq === db.seq) $('#db-count').textContent = e.message;
  }
}

const arcmin = (a) => (a < 1 ? `${Math.round(a * 60)}″` : `${+a.toFixed(1)}′`);
const fmtSize = (o) => (o.majorArcmin ? `${arcmin(o.majorArcmin)}${o.minorArcmin && o.minorArcmin !== o.majorArcmin ? `×${arcmin(o.minorArcmin)}` : ''}` : '');

/** Sexagesimal with carries, so 59.6s rounds to the next minute rather than printing 60. */
function fmtRa(h) {
  const total = Math.round((((h % 24) + 24) % 24) * 3600);
  const hh = Math.floor(total / 3600) % 24;
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${hh}h ${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
}
function fmtDec(d) {
  const total = Math.round(Math.abs(d) * 60);
  return `${d < 0 ? '−' : '+'}${Math.floor(total / 60)}° ${String(total % 60).padStart(2, '0')}′`;
}

function row(o) {
  const aliases = Array.isArray(o.aliases) ? o.aliases : [];
  const others = aliases.filter((a) => a !== o.name).slice(0, 3);
  const ids = [o.id !== o.name ? o.id : null, ...others.filter((a) => a !== o.id)].filter(Boolean).slice(0, 3);
  const facts = [o.typeName, o.constellation, fmtSize(o), o.mag != null ? `mag ${o.mag}` : BRIGHT_CLASS[o.brightClass] ?? ''].filter(Boolean);
  const up = o.altitudeNow != null && o.altitudeNow >= db.minAlt;
  const alt = o.altitudeNow == null ? '' : `<span class="db-alt ${up ? 'up' : o.altitudeNow > 0 ? 'low' : 'down'}" title="altitude now">${o.altitudeNow > 0 ? `${esc(o.altitudeNow)}°` : 'set'}</span>`;
  const tonight = o.hoursUpTonight ? `${esc(o.hoursUpTonight)} h up · best ${esc(timePart(o.bestTime))}` : o.hoursUpTonight === 0 ? 'not up tonight' : '';
  const open = db.open === o.id;
  return `<div class="db-item${open ? ' open' : ''}" data-id="${esc(o.id)}">
    <button type="button" class="db-row" aria-expanded="${open}">
      <span class="db-main"><b>${esc(o.name)}</b>${ids.length ? `<small>${esc(ids.join(' · '))}</small>` : ''}<small>${esc(facts.join(' · '))}</small></span>
      <span class="db-vis">${alt}<small>${tonight}</small></span>
    </button>
    <div class="db-detail"${open ? '' : ' hidden'}></div>
  </div>`;
}

function render(append) {
  const list = $('#db-results');
  if (!db.items.length) list.innerHTML = '<p class="muted">Nothing matches these filters.</p>';
  else if (append) list.insertAdjacentHTML('beforeend', db.items.slice(list.querySelectorAll('.db-item').length).map(row).join(''));
  else list.innerHTML = db.items.map(row).join('');
  const more = $('#db-load');
  more.hidden = db.items.length >= db.total;
  more.textContent = `Show more (${Math.max(0, db.total - db.items.length).toLocaleString()} left)`;
  if (!append) {
    const panel = list.closest('.panel');
    if (panel) panel.scrollTop = 0;
  }
  // an append leaves the open row's element (and its detail) as it was
  if (db.open && !append) {
    const el = $(`.db-item[data-id="${CSS.escape(db.open)}"] .db-detail`);
    if (el) detail(db.open, el);
  }
}

/** Tonight's altitude across the dark window, with the minimum altitude and "now". */
function altitudeChart(t) {
  const W = 320;
  const H = 96;
  const pad = 2;
  const curve = Array.isArray(t.curve) ? t.curve : [];
  const n = curve.length;
  if (n < 2) return '';
  const x = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (a) => H - 14 - (Math.max(0, Math.min(90, a)) / 90) * (H - 22);
  const line = curve.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.alt).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const t0 = Date.parse(curve[0].t);
  const t1 = Date.parse(curve[n - 1].t);
  const now = Date.now();
  const nowX = t1 > t0 && now >= t0 && now <= t1 ? pad + ((now - t0) / (t1 - t0)) * (W - 2 * pad) : null;
  const mid = Math.floor((n - 1) / 2);
  const tick = (i) => esc(timePart(curve[i].local));
  const minY = y(t.minAltitude ?? 0).toFixed(1);
  return `<svg class="db-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Altitude tonight, peaking at ${esc(t.maxAltitude)}° at ${esc(t.bestTime ?? '')}">
    <line class="ax" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>
    <line class="min" x1="0" x2="${W}" y1="${minY}" y2="${minY}"/>
    <path class="area" d="${area}"/><path class="ln" d="${line}"/>
    ${nowX != null ? `<line class="now" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="0" y2="${y(0)}"/>` : ''}
    <text x="${pad}" y="${H - 2}">${tick(0)}</text><text x="${W / 2}" y="${H - 2}" text-anchor="middle">${tick(mid)}</text><text x="${W - pad}" y="${H - 2}" text-anchor="end">${tick(n - 1)}</text>
    <text x="${W - pad}" y="${(Number(minY) - 3).toFixed(1)}" text-anchor="end" class="minl">${esc(t.minAltitude)}°</text>
  </svg>`;
}

async function detail(id, el) {
  el.innerHTML = '<span class="muted small">loading…</span>';
  try {
    const d = await api(`catalog/object?id=${encodeURIComponent(id)}`);
    const t = d.tonight;
    const size = fmtSize(d);
    const tonight = t
      ? t.hoursAboveMin
        ? `${t.hoursAboveMin} h above ${t.minAltitude}° (${timePart(t.from)} → ${timePart(t.until)}), peaks at ${t.maxAltitude}° at ${timePart(t.bestTime)} · Moon ${t.moonIllumination}%, ${t.moonSeparationDeg}° away`
        : `stays below ${t.minAltitude}° (peaks at ${t.maxAltitude}°)`
      : null;
    const rows = [
      ['Type', `${d.typeName} in ${d.constellation}`],
      ['RA / Dec (J2000)', Number.isFinite(d.raHours) && Number.isFinite(d.decDeg) ? `${fmtRa(d.raHours)} · ${fmtDec(d.decDeg)}` : '–'],
      ['Size', size ? `${size}${d.posAngle != null ? ` · PA ${d.posAngle}°` : ''}${d.fitsTeleFov ? ` · ${d.fitsTeleFov}` : ''}` : 'unknown'],
      ['Brightness', d.mag != null ? `mag ${d.mag}${d.surfaceBrightness != null ? ` · surface ${d.surfaceBrightness} mag/arcmin²` : ''}` : BRIGHT_CLASS[d.brightClass] ? `${BRIGHT_CLASS[d.brightClass]} (catalog class; no magnitude)` : 'unknown'],
      ['Now', d.altitudeNow != null ? `altitude ${d.altitudeNow}° · azimuth ${d.azimuthNow}°` : '–'],
      tonight ? ['Tonight', tonight] : null,
      ['Catalogs', (d.sourceTitles ?? []).join(' · ')],
    ].filter(Boolean);
    const aliases = Array.isArray(d.aliases) ? d.aliases : [];
    const low = d.altitudeNow != null && d.altitudeNow < GOTO_MIN_ALT;
    el.innerHTML = `${t ? altitudeChart(t) : ''}
      <div class="db-facts">${rows.map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join('')}</div>
      ${aliases.length ? `<div class="db-aliases">${aliases.map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
      <div class="ctl-row db-actions">
        <button type="button" class="primary" data-db-goto="${esc(d.id)}" data-label="${esc(d.gotoName)}"${low ? ' disabled title="below the horizon"' : ''}>GoTo ${esc(d.gotoName)}</button>
        <button type="button" data-db-agent="${esc(d.gotoName)}">Ask the agent to image it</button>
      </div>`;
  } catch (e) {
    el.innerHTML = `<span class="muted small">${esc(e.message)}</span>`;
  }
}

$('#db-results').addEventListener('click', async (e) => {
  const go = e.target.closest('[data-db-goto]');
  if (go) {
    const label = go.dataset.label;
    if (!confirm(`Slew the telescope to ${label}? (calibrates first, then GoTo and tracking)`)) return;
    go.disabled = true;
    go.classList.add('busy');
    toast(`GoTo ${label}: calibrating and slewing…`);
    try {
      await control({ action: 'goto', name: go.dataset.dbGoto }, `GoTo ${label}`);
    } finally {
      go.disabled = false;
      go.classList.remove('busy');
    }
    return;
  }
  const ask = e.target.closest('[data-db-agent]');
  if (ask) return draft(imagingRequest(ask.dataset.dbAgent));
  const r = e.target.closest('.db-row');
  if (!r) return;
  const item = r.closest('.db-item');
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
  r.setAttribute('aria-expanded', 'true');
  const d = $('.db-detail', item);
  d.hidden = false;
  detail(id, d);
});

let timer;
const changed = (delay = 0) => {
  saveFilters();
  clearTimeout(timer);
  timer = setTimeout(() => search(), delay);
};
$('#db-form').addEventListener('submit', (e) => {
  e.preventDefault();
  field('q').blur(); // a phone keyboard covers half the results
  changed();
});
$('#db-form').addEventListener('input', (e) => changed(e.target.matches('input[type=search], input[type=number]') ? TYPING_MS : 0));
$('#db-reset').onclick = () => {
  for (const f of FIELDS) {
    if (field(f).type === 'checkbox') field(f).checked = false;
    else if (field(f).tagName === 'SELECT') field(f).selectedIndex = 0;
    else field(f).value = '';
  }
  changed();
};
$('#db-load').onclick = () => search(true);

on('tab', (name) => {
  if (name === 'database') loadDatabase();
});
