/**
 * The Calendar: which targets are coming into and going out of their windows, ranked by what
 * changes next, with each one's progress towards its goal and a night-by-night heatmap of the hours
 * clear of the Moon. A card opens a sheet with the target's details and actions.
 */
import { $, esc, store, toast } from './dom.js';
import { api, control } from './api.js';
import { on } from './bus.js';
import { draft } from './chat.js';
import { imagingRequest } from './tonight.js';
import { altitudeChart, GROUPS } from './database.js';
import { programFormHtml, wireProgramForms } from './program-add.js';

const STORE_KEY = 'cal-filters';
const FIELDS = ['scope', 'type', 'catalog', 'con', 'sort', 'maxmag', 'minsize', 'maxsize', 'minfov', 'named', 'q'];
const SERVER_FIELDS = FIELDS.filter((f) => f !== 'sort');
const RANGES = [30, 60, 90, 180];
const DEFAULT_RANGE = 60;
const LIMIT_STEP = 60;
const MAX_LIMIT = 200;
const TYPING_MS = 300;
const GOTO_MIN_ALT = 5;
const FULL_MOON_PCT = 93;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SECTIONS = [
  ['closing', 'Closing', 'best window or season ends soon'],
  ['peak', 'In the best window', 'more than 30 nights left'],
  ['opening', 'Coming up', 'opens within 4 months'],
  ['later', 'Later', 'out of reach for now'],
];
const VERDICT = {
  done: ['done', '✓', 'Goal reached'],
  'on-track': ['done', '●', 'On track'],
  tight: ['waiting', '▲', 'Tight'],
  short: ['failed', '✕', "Won't finish"],
  'no-window': ['failed', '✕', 'No window'],
};
// hours clear of the Moon, darkest to brightest
const HEAT = [[3, '#1e3a60', '<3'], [5, '#2c5487', '3–5'], [7, '#4a80c4', '5–7'], [9, '#7ab0ee', '7–9'], [Infinity, '#b6d6fb', '9+']];

const cal = { data: null, byKey: new Map(), seq: 0, open: null, limit: LIMIT_STEP, query: null, metaLoaded: null };
let range = Number(store.get('cal-range')) || DEFAULT_RANGE;
if (!RANGES.includes(range)) range = DEFAULT_RANGE;

const field = (f) => $(`#cal-${f}`);
const value = (f) => (field(f).type === 'checkbox' ? (field(f).checked ? '1' : '') : field(f).value.trim());
const hours = (x) => `${+Number(x).toFixed(1)}`;
const plural = (n) => `${n} ${n === 1 ? 'night' : 'nights'}`;
const dayLabel = (i) => {
  const n = cal.data.nights[Math.min(i, cal.data.nights.length - 1)];
  if (!n) return '';
  const [, m, d] = n.date.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
};
/** A night index as a date; windows reach past the nights sent, so it is counted from tonight. */
function dateAt(i) {
  const [y, m, d] = cal.data.nights[0].date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + i));
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
}

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
    if (field(f).tagName === 'SELECT' && field(f).selectedIndex < 0) field(f).selectedIndex = 0;
  }
  if (['catalog', 'con', 'maxmag', 'minsize', 'maxsize', 'minfov', 'named', 'q'].some((f) => value(f))) $('#cal-more').open = true;
}

const option = (k, label) => `<option value="${esc(k)}">${esc(label)}</option>`;

/** The Database's filter lists, filled once; the calendar still works if they cannot be had. */
function loadMeta() {
  cal.metaLoaded ??= api('catalog/meta').then(
    (m) => {
      const counts = new Set((m.groups ?? []).filter((g) => g.count).map((g) => g.key));
      field('type').insertAdjacentHTML('beforeend', GROUPS.filter(([k]) => counts.has(k)).map(([k, l]) => option(k, l)).join(''));
      field('catalog').insertAdjacentHTML('beforeend', [...(m.lists ?? []).map((l) => [l.key, l.title]), ...(m.sources ?? []).map((s) => [s.key, s.title])].map(([k, t]) => option(k, t)).join(''));
      field('con').insertAdjacentHTML('beforeend', [...(m.constellations ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((c) => option(c.abbr, c.name)).join(''));
      restoreFilters();
    },
    () => {
      cal.metaLoaded = null; // the next visit tries again
      restoreFilters();
    },
  );
  return cal.metaLoaded;
}

function queryString() {
  const p = new URLSearchParams();
  const set = (k, f) => value(f) && p.set(k, value(f));
  if (value('scope') === 'program') p.set('scope', 'program');
  set('types', 'type');
  set('catalog', 'catalog');
  set('constellation', 'con');
  set('maxMag', 'maxmag');
  set('minSize', 'minsize');
  set('maxSize', 'maxsize');
  set('minFovPercent', 'minfov');
  set('named', 'named');
  set('q', 'q');
  p.set('limit', String(cal.limit));
  return p.toString();
}

async function load() {
  const seq = ++cal.seq;
  const q = queryString();
  cal.query = q;
  if (!cal.data) $('#cal-list').innerHTML = '<p class="muted">Working out the coming nights…</p>';
  $('#cal-count').textContent = 'updating…';
  try {
    const r = await api(`calendar?${q}`);
    if (seq !== cal.seq) return; // a newer request has started
    cal.data = r;
    cal.byKey = new Map(r.targets.map((t) => [t.key, t]));
    render();
    if (cal.open && cal.byKey.has(cal.open)) openSheet(cal.open, false);
    else closeSheet();
  } catch (e) {
    if (seq !== cal.seq) return;
    $('#cal-count').textContent = '';
    $('#cal-list').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

function visible() {
  const sort = value('sort');
  let list = cal.data.targets;
  if (value('scope') === 'open') list = list.filter((t) => t.verdict !== 'done');
  const cmp = {
    next: (a, b) => (a.verdict === 'done') - (b.verdict === 'done') || (a.deadline ?? 1e9) - (b.deadline ?? 1e9),
    need: (a, b) => b.needH - a.needH,
    name: (a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true }),
  }[sort] ?? (() => 0);
  return [...list].sort(cmp);
}

function heatFill(h) {
  if (h < cal.data.minBlockMin / 60) return null;
  return HEAT.find(([max]) => h < max)[1];
}
const isOptimal = (t, i) => t.optimal.runs.some(([a, b]) => i >= a && i <= b);

function heatStrip(t, n) {
  let cells = '';
  for (let i = 0; i < n && i < t.clear.length; i++) {
    const f = heatFill(t.clear[i]);
    if (f) cells += `<rect x="${i}" width=".88" height="1" fill="${f}"/>`;
    if (isOptimal(t, i)) cells += `<rect x="${i}" width="1" height=".16" class="cal-opt"/>`;
  }
  return `<svg class="cal-heat" data-key="${esc(t.key)}" data-n="${n}" viewBox="0 0 ${n} 1" preserveAspectRatio="none" aria-hidden="true">${cells}</svg>`;
}

function timelineHead(n) {
  const nights = cal.data.nights.slice(0, n);
  let labels = '';
  let last = -1;
  nights.forEach((x, i) => {
    const [, m, d] = x.date.split('-').map(Number);
    if (m !== last && (i === 0 || d <= 3) && i / n < 0.94) labels += `<span style="left:${(i / n) * 100}%">${MONTHS[m - 1]}</span>`;
    if (m !== last && (i === 0 || d <= 3)) last = m;
    const prev = nights[i - 1]?.moonPercent;
    const next = nights[i + 1]?.moonPercent;
    if (prev !== undefined && next !== undefined && x.moonPercent >= prev && x.moonPercent > next && x.moonPercent >= FULL_MOON_PCT) {
      labels += `<em style="left:${((i + 0.5) / n) * 100}%" title="Full Moon ${esc(dayLabel(i))}"></em>`;
    }
  });
  const moon = nights.map((x, i) => `<rect x="${i}" width=".9" height="1" fill="#e8eef8" opacity="${((x.moonPercent / 100) * 0.95 + 0.03).toFixed(2)}"/>`).join('');
  return `<div class="cal-axis">${labels}</div><svg class="cal-moon" viewBox="0 0 ${n} 1" preserveAspectRatio="none" role="img" aria-label="Moon brightness each night">${moon}</svg>`;
}

function leftCell(t) {
  const big = (num, label) => `<div class="cal-days">${esc(num)}<small>${esc(label)}</small></div>`;
  if (t.verdict === 'done') return big('✓', 'goal reached');
  if (t.deadline === null) return big('–', 'no window this year');
  const left = (run, word) => big(run[1] + 1, `${run[1] === 0 ? 'night' : 'nights'} ${word}`);
  if (t.group === 'closing' && t.optimal.current) return left(t.optimal.current, 'optimal');
  if (t.group === 'closing') return left(t.collectable.current, 'left');
  if (t.group === 'peak') return left(t.optimal.current, 'optimal');
  return big(t.deadline, `${t.deadline === 1 ? 'night' : 'nights'} away`);
}

const pct = (t) => (t.goalMin > 0 ? Math.min(100, (t.collectedMin / t.goalMin) * 100).toFixed(0) : 0);
const collectedText = (t) => (t.goalMin > 0 ? `${hours(t.collectedMin / 60)} / ${hours(t.goalMin / 60)} h` : `${hours(t.collectedMin / 60)} h collected`);
const progressBar = (t) => (t.goalMin > 0 ? `<span class="cal-prog" aria-hidden="true"><b style="width:${pct(t)}%"></b></span>` : '');
const verdictBadge = (t) => {
  const v = VERDICT[t.verdict];
  return v ? `<span class="badge ${v[0]}">${v[1]} ${v[2]}</span>` : '';
};
function whyLine(t) {
  if (t.verdict === 'done') return `Collected ${hours(t.collectedMin / 60)} h of ${hours(t.goalMin / 60)} h.`;
  if (t.verdict === 'no-window') return 'Has no usable night in the coming year at this site.';
  if (t.verdict === 'no-goal') return `About ${hours(t.expectedOptimalH)} h expected in optimal nights, ${hours(t.expectedTotalH)} h in all.`;
  return `Needs ${hours(t.needH)} h. About ${hours(t.expectedOptimalH)} h expected in optimal nights, ${hours(t.expectedTotalH)} h in all.`;
}

function card(t) {
  return `<button type="button" class="cal-card${t.verdict === 'done' ? ' finished' : ''}" data-cal-open="${esc(t.key)}" aria-label="${esc(t.displayName)}: details and actions">
    <span class="cal-top">${leftCell(t)}
      <span class="cal-mid"><b class="cal-name">${esc(t.displayName)}${t.inProgram ? '<span class="cal-p" title="In the program">P</span>' : ''}</b>${progressBar(t)}<small>${esc(collectedText(t))}</small></span>
      ${verdictBadge(t)}</span>
    <small class="cal-why">${esc(whyLine(t))}</small>
    ${heatStrip(t, range)}
  </button>`;
}

function render() {
  const r = cal.data;
  const list = visible();
  const n = Math.min(range, r.nights.length);
  const more = r.catalogTotal !== null && r.limit < MAX_LIMIT && r.catalogTotal > r.limit;
  const scope = r.catalogTotal === null ? 'program only' : `top ${Math.min(r.limit, r.catalogTotal).toLocaleString()} of ${r.catalogTotal.toLocaleString()} catalog matches, plus your program and targets in progress`;
  $('#cal-count').textContent = `${list.length} ${list.length === 1 ? 'target' : 'targets'} · ${scope} · above ${r.minAltitude}°`;
  $('#cal-load').hidden = !more;
  for (const b of $('#cal-range').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === range));
  $('#cal-head').innerHTML = timelineHead(n);
  const body = value('sort') === 'next'
    ? SECTIONS.map(([k, title, sub]) => {
        const g = list.filter((t) => t.group === k);
        return g.length ? `<div class="cal-section"><h3>${title}</h3><span class="muted small">${g.length} · ${sub}</span></div>${g.map(card).join('')}` : '';
      }).join('')
    : list.map(card).join('');
  $('#cal-list').innerHTML = body || '<p class="muted">Nothing matches these filters.</p>';
}

function windowText(run, next) {
  if (run) return `now → ${run[1] >= 364 ? 'beyond a year' : `${dateAt(run[1])} (${plural(run[1] + 1)})`}`;
  if (next) return `${dateAt(next[0])} → ${next[1] >= 364 ? 'beyond a year' : dateAt(next[1])}, opens in ${plural(next[0])}`;
  return 'none in the coming year';
}

function sheetHtml(t) {
  const facts = [t.typeName, t.constellation, t.majorArcmin ? `${+t.majorArcmin.toFixed(1)}′` : '', t.mag != null ? `mag ${t.mag}` : ''].filter(Boolean).join(' · ');
  const aliases = t.aliases.filter((a) => a !== t.displayName).join(' · ');
  const low = t.altitudeNow < GOTO_MIN_ALT;
  const pos = `data-ra="${esc(t.raHours)}" data-dec="${esc(t.decDeg)}" data-display="${esc(t.displayName)}"`;
  const left = t.verdict === 'done' ? 'Goal reached' : t.verdict === 'no-goal' ? `No goal set; about ${hours(t.expectedTotalH)} h expected` : `Needs ${hours(t.needH)} h; about ${hours(t.expectedOptimalH)} h expected in optimal nights, ${hours(t.expectedTotalH)} h overall`;
  const entry = t.inProgram ? { goalMin: t.goalMin, priority: t.priority, collectedMin: t.collectedMin, enabled: t.enabled } : null;
  const goal = t.goalMin > 0 ? `${t.goalSource === 'program' ? 'program goal' : 'general goal'}` : 'no goal set';
  return `<div class="row-head"><h3>${esc(t.displayName)}</h3>${verdictBadge(t)}<span class="spacer"></span><button type="button" class="ghost" data-cal-close aria-label="Close details">Close</button></div>
    <span class="muted small">${esc(facts)}${aliases ? `<br>${esc(aliases)}` : ''}</span>
    <div>${progressBar(t)}<span class="small">${esc(collectedText(t))} · ${goal}${t.collectedNights ? ` · ${plural(t.collectedNights)}` : ''}</span></div>
    ${heatStrip(t, Math.min(180, cal.data.nights.length))}
    <div class="db-facts">
      <div><span>Optimal</span>${esc(windowText(t.optimal.current, t.optimal.next))}</div>
      <div><span>Can collect</span>${esc(windowText(t.collectable.current, t.collectable.next))}</div>
      <div><span>Tonight</span>${esc(hours(t.up[0] ?? 0))} h up, ${esc(hours(t.clear[0] ?? 0))} h clear of the Moon</div>
      <div><span>Time left</span>${esc(left)}</div>
    </div>
    <div id="cal-chart"></div>
    <div class="ctl-row db-actions">
      <button type="button" class="primary" data-cal-goto${low ? ' disabled title="below the horizon"' : ''}>GoTo ${esc(t.gotoName)}</button>
      <button type="button" class="ghost" data-sky="${esc(t.gotoName)}" ${pos}>View in Stellarium</button>
      <button type="button" class="ghost" data-research="${esc(t.gotoName)}" ${pos}>Research</button>
      <button type="button" data-cal-agent>Ask the agent to image it</button>
    </div>
    ${programFormHtml(entry)}`;
}

let chartSeq = 0;
async function loadChart(t) {
  const mine = ++chartSeq;
  if (!t.catalogId) return;
  try {
    const d = await api(`catalog/object?id=${encodeURIComponent(t.catalogId)}`);
    const el = $('#cal-chart');
    if (mine === chartSeq && el && d.tonight) el.innerHTML = altitudeChart(d.tonight);
  } catch {
    // the sheet is complete without tonight's curve
  }
}

function openSheet(key, focus = true) {
  const t = cal.byKey.get(key);
  if (!t) return;
  cal.open = key;
  const el = $('#cal-sheet');
  el.innerHTML = sheetHtml(t);
  el.hidden = false;
  loadChart(t);
  if (focus) $('[data-cal-close]', el).focus();
}

function closeSheet() {
  cal.open = null;
  $('#cal-sheet').hidden = true;
  $('#cal-sheet').innerHTML = '';
}

async function gotoTarget(t, btn) {
  if (!confirm(`Slew the telescope to ${t.gotoName}? (calibrates first, then GoTo and tracking)`)) return;
  btn.disabled = true;
  btn.classList.add('busy');
  toast(`GoTo ${t.gotoName}: calibrating and slewing…`);
  try {
    await control(t.catalogId ? { action: 'goto', name: t.catalogId } : { action: 'goto_sky', name: t.gotoName, raHours: t.raHours, decDeg: t.decDeg }, `GoTo ${t.gotoName}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

$('#panel-calendar').addEventListener('click', (e) => {
  const open = e.target.closest('[data-cal-open]');
  if (open) return openSheet(open.dataset.calOpen);
  if (e.target.closest('[data-cal-close]')) return closeSheet();
  const t = cal.byKey.get(cal.open);
  const go = e.target.closest('[data-cal-goto]');
  if (go && t) return gotoTarget(t, go);
  if (e.target.closest('[data-cal-agent]') && t) return draft(imagingRequest(t.gotoName));
  const r = e.target.closest('[data-range]');
  if (r) {
    range = Number(r.dataset.range);
    store.set('cal-range', String(range));
    render();
    if (cal.open) openSheet(cal.open, false);
  }
});

wireProgramForms(
  $('#cal-sheet'),
  () => {
    const t = cal.byKey.get(cal.open);
    if (!t) return null;
    return t.catalogId ? { name: t.catalogId, display: t.gotoName, raHours: t.raHours, decDeg: t.decDeg } : { name: t.name, display: t.displayName, raHours: t.raHours, decDeg: t.decDeg, custom: true };
  },
);

let timer;
$('#cal-form').addEventListener('submit', (e) => e.preventDefault());
$('#cal-form').addEventListener('input', (e) => {
  saveFilters();
  clearTimeout(timer);
  const name = e.target.id.replace('cal-', '');
  // the order and the "not finished" view are the page's own; the rest asks the server
  timer = setTimeout(() => {
    cal.limit = LIMIT_STEP;
    if (cal.data && queryString() === cal.query) render();
    else load();
  }, SERVER_FIELDS.includes(name) && e.target.matches('input[type=search], input[type=number]') ? TYPING_MS : 0);
});
$('#cal-load').onclick = () => {
  cal.limit = Math.min(MAX_LIMIT, cal.limit + LIMIT_STEP);
  load();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cal.open) closeSheet();
});

const tip = $('#cal-tip');
$('#panel-calendar').addEventListener('mousemove', (e) => {
  const s = e.target.closest?.('svg.cal-heat');
  if (!s) {
    tip.hidden = true;
    return;
  }
  const t = cal.byKey.get(s.dataset.key);
  const n = Number(s.dataset.n);
  const box = s.getBoundingClientRect();
  const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n)));
  if (!t || t.up[i] === undefined) return;
  const min = cal.data.minBlockMin / 60;
  const state = t.up[i] < min ? 'Not usable' : t.clear[i] < min ? 'Moon in the way' : isOptimal(t, i) ? 'Optimal' : 'Can collect';
  tip.innerHTML = `<b>${esc(t.displayName)}</b> · ${esc(dayLabel(i))}<br>${state}<br>${esc(hours(t.up[i]))} h up · ${esc(hours(t.clear[i]))} h clear of the Moon`;
  tip.hidden = false;
  tip.style.left = `${Math.min(window.innerWidth - 240, e.clientX + 12)}px`;
  tip.style.top = `${e.clientY + 14}px`;
});
$('#panel-calendar').addEventListener('mouseleave', () => (tip.hidden = true));

$('#cal-range').innerHTML = RANGES.map((r, i) => `<button type="button" data-range="${r}">${r}${i ? '' : ' nights'}</button>`).join('');
$('#cal-legend').innerHTML = `<span>Hours clear of the Moon:</span>${HEAT.map(([, c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}<span><i class="cal-opt-key"></i>Optimal</span>`;

async function loadCalendar() {
  await loadMeta();
  load();
}

on('tab', (name) => {
  if (name === 'calendar') loadCalendar();
});
// a goal or priority changed, here or in the Plan tab
on('program-changed', () => {
  if (cal.data) load();
});
