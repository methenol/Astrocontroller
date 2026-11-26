/**
 * The agent's tools, run from the web UI (/api/tools): everything the agent can do, the user can
 * do here too, with the same checks and the same results.
 *
 * Both drivers register their tools under the same names, but a tool's arguments differ between
 * them (the Dwarf moves rotation/pitch, the Seestar azimuth/altitude). So the forms are declared in
 * index.html with every field either driver's tool takes, and the tool's own schema decides what
 * shows: a field, a submit button's action or a select's option the connected driver's tool does
 * not take is hidden, and a form or button whose tool this driver lacks is hidden whole.
 *
 *   <form class="tool-form" data-tool="move_motors">       the tool; data-label names it in results
 *     <label>Az <input name="azimuth_deg"></label>          an argument, coerced by the schema's type
 *     <input type="checkbox" name="apply" checked data-unchecked="false">   a checkbox sends true, or data-unchecked
 *     <button name="action" value="start">                  the button pressed is an argument too
 *   <button data-tool="sky_check" data-args='{"…"}'>        a one-click run with fixed arguments
 *   data-confirm="…"     asks first          data-driver="seestar"   only with that driver
 *   data-for="a b"       a field shown only while the form's action is a or b
 *
 * A form inside a .tool-card shows its result in the card's .tool-out; everything else goes to the
 * results drawer.
 */
import { $, $$, esc, toast, lightbox, unsupported, fmtClock } from './dom.js';
import { api, seg } from './api.js';
import { on, emit } from './bus.js';
import { state } from './state.js';

/** name → { description, schema, readOnly } for the connected driver */
let tools = new Map();
let loadedFor = null;
let loading = null;

export const hasTool = (name) => tools.has(name);
const props = (name) => tools.get(name)?.schema?.properties ?? {};
const enumOf = (p) => p?.enum ?? (p?.const !== undefined ? [p.const] : undefined) ?? p?.anyOf?.find((x) => x.enum)?.enum;
const typeOf = (p) => p?.type ?? p?.anyOf?.find((x) => x.type && x.type !== 'null')?.type;

/** Whether this driver's tool takes `arg` (and, given one, that value of it). */
export function accepts(name, arg, value) {
  const p = props(name)[arg];
  if (!p) return false;
  const en = enumOf(p);
  return value === undefined || !en || en.includes(value);
}

/** The values an enum argument of the tool takes. */
export const enumValues = (name, arg) => enumOf(props(name)[arg]) ?? [];

async function load() {
  const driver = state.config?.driver ?? '';
  if (loading || loadedFor === driver) return loading;
  loading = (async () => {
    try {
      const { tools: list = [] } = await api('tools');
      tools = new Map(list.map((t) => [t.name, t]));
      loadedFor = driver;
    } catch {
      // an older server, or none yet: the forms stay as declared and the next config tries again
      tools = new Map();
    } finally {
      loading = null;
    }
    applyAll();
    emit('tools', tools);
  })();
  return loading;
}
on('config', () => {
  applyAll();
  void load();
});

// ---- the forms follow the driver's schemas

const fieldWrap = (el) => el.closest('label, .fld') ?? el;
const toolOf = (el) => el.closest('[data-tool]')?.dataset.tool;

/** What the driver has no equivalent of (capabilities) is hidden, not shown dead: data-cap. */
const lacks = (el) => !!el.dataset.cap && state.config?.capabilities?.[el.dataset.cap] === false;

function applyDriver(root = document) {
  const d = state.config?.driver;
  for (const el of $$('[data-driver]', root)) el.hidden = !!d && !el.dataset.driver.split(' ').includes(d);
  for (const el of $$('[data-cap]', root)) el.hidden = lacks(el);
}

function applyForm(form) {
  const name = form.dataset.tool;
  const known = tools.size > 0;
  form.hidden = (known && !hasTool(name)) || lacks(form) || !!(form.dataset.driver && state.config?.driver && !form.dataset.driver.split(' ').includes(state.config.driver));
  if (!known || form.hidden) return;
  for (const b of $$('button[data-tool]', form)) b.hidden = !hasTool(b.dataset.tool);
  for (const el of $$('[name]', form)) {
    if (el.tagName === 'BUTTON') {
      el.hidden = !accepts(name, el.name, el.value) || driverHidden(el);
      continue;
    }
    fieldWrap(el).hidden = !accepts(name, el.name) || driverHidden(el);
    if (el.tagName === 'SELECT') fitOptions(el, enumValues(name, el.name));
  }
  showFor(form);
}

const driverHidden = (el) => {
  const d = el.closest('[data-driver]')?.dataset.driver;
  return !!d && !!state.config?.driver && !d.split(' ').includes(state.config.driver);
};

/** A select keeps only the options the tool's enum has (iOS shows hidden options, so they are taken out). */
function fitOptions(sel, values) {
  if (!values.length) return;
  if (!sel.dataset.allOptions) sel.dataset.allOptions = sel.innerHTML;
  const keep = sel.value;
  sel.innerHTML = sel.dataset.allOptions;
  for (const o of [...sel.options]) if (o.value !== '' && !values.includes(o.value)) o.remove();
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  showFor(sel.form);
}

/** Fields that belong to some actions only follow the form's action select. */
function showFor(form) {
  if (!form) return;
  const act = form.querySelector('select[name="action"]')?.value;
  for (const el of $$('[data-for]', form)) {
    const inner = el.matches('[name]') ? el : el.querySelector('[name]');
    const schemaOk = !inner || !form.dataset.tool || tools.size === 0 || accepts(form.dataset.tool, inner.name);
    el.hidden = !schemaOk || (act !== undefined && !el.dataset.for.split(' ').includes(act));
  }
}

function applyAll() {
  applyDriver();
  for (const f of $$('form[data-tool]')) applyForm(f);
  if (tools.size) for (const b of $$('button[data-tool]:not(form button)')) b.hidden = !hasTool(b.dataset.tool) || driverHidden(b) || lacks(b);
}

document.addEventListener('change', (e) => {
  if (e.target.matches?.('form[data-tool] select[name="action"]')) showFor(e.target.form);
});

// ---- arguments

/** One input's value as the tool's schema types it; undefined leaves the argument out. */
function argValue(el, p) {
  if (el.type === 'checkbox') {
    if (el.checked) return el.dataset.checked !== undefined ? JSON.parse(el.dataset.checked) : true;
    return el.dataset.unchecked !== undefined ? JSON.parse(el.dataset.unchecked) : undefined;
  }
  const raw = el.value.trim();
  if (raw === '') return undefined;
  const label = fieldWrap(el).textContent.trim() || el.name;
  const t = typeOf(p);
  if (t === 'number' || t === 'integer') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${label}: "${raw}" is not a number`);
    return n;
  }
  if (t === 'boolean') return raw === 'true';
  if (t === 'array') {
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const it = typeOf(p.items);
    return it === 'number' || it === 'integer' ? items.map(Number) : items;
  }
  if ((t === 'object' || !t) && /^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${label}: not valid JSON`);
    }
  }
  return raw;
}

/** The form's arguments: its visible fields, the button pressed, and its fixed data-args. */
export function formArgs(form, submitter) {
  const name = form.dataset.tool;
  const schema = props(name);
  const args = { ...(form.dataset.args ? JSON.parse(form.dataset.args) : {}) };
  for (const el of $$('[name]', form)) {
    if (el.tagName === 'BUTTON' || el.disabled || fieldWrap(el).hidden || el.closest('[hidden]')) continue;
    const v = argValue(el, schema[el.name]);
    if (v !== undefined) args[el.name] = v;
  }
  if (submitter?.name) args[submitter.name] = submitter.value;
  if (submitter?.dataset.args) Object.assign(args, JSON.parse(submitter.dataset.args));
  return args;
}

// ---- running

/** Checks before a run (the Sun needs its filter confirmed…): return false to cancel, or change args. */
const beforeHooks = new Map();
export const beforeRun = (name, fn) => beforeHooks.set(name, fn);

/** The answer in one line, for a toast. */
function brief(r) {
  const j = r.json && typeof r.json === 'object' ? r.json : null;
  const line = (j && LEAD_KEYS.map((k) => j[k]).find((x) => typeof x === 'string')) || String(r.text ?? '').split('\n')[0];
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

const NO_ENTRY = { done() {}, fail() {} };

/**
 * Runs a tool and shows what it answered: in `out` (an element) or the results drawer. quiet: the
 * drawer keeps it but stays shut, a toast says how it went; silent: a read for the page itself,
 * only a failure is shown. Resolves the result ({ text, json, images }), or undefined when it
 * failed (the error is shown).
 */
export async function runTool(name, args = {}, { label, button, out, quiet, silent } = {}) {
  const hook = beforeHooks.get(name);
  if (hook && (await hook(args)) === false) return undefined;
  const title = label ?? button?.dataset.label ?? button?.textContent.trim() ?? name;
  const entry = silent ? NO_ENTRY : out ? inlineEntry(out, title, name) : drawerEntry(title, name, quiet);
  if (button) {
    button.disabled = true;
    button.classList.add('busy');
  }
  try {
    const r = await api(`tools/${seg(name)}`, args);
    entry.done(r);
    if (quiet && !silent) toast(`${title}: ${brief(r) || 'done'}`);
    else if (!out && !silent) openDrawer();
    emit('tool-done', { name, args, result: r });
    return r;
  } catch (e) {
    entry.fail(e.message);
    toast(`${title}: ${e.message}`, true);
    return undefined;
  } finally {
    if (button) {
      button.disabled = unsupported(button);
      button.classList.remove('busy');
    }
  }
}

document.addEventListener('submit', (e) => {
  const form = e.target.closest?.('form[data-tool]');
  if (!form) return;
  e.preventDefault();
  const sub = e.submitter && form.contains(e.submitter) ? e.submitter : form.querySelector('button[type="submit"], button:not([type])');
  void submitForm(form, sub);
});

async function submitForm(form, sub) {
  let args;
  try {
    args = formArgs(form, sub);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const ask = sub?.dataset.confirm ?? form.dataset.confirm;
  if (ask && !confirm(ask)) return;
  const card = form.closest('.tool-card');
  const out = card?.querySelector('.tool-out') ?? undefined;
  // "Focuser · Go": the form's name and the button pressed
  const label = sub?.dataset.label ?? ([form.dataset.label, sub?.textContent.trim()].filter(Boolean).join(' · ') || undefined);
  // a button may run another tool on the same fields (the Mosaics card's one project, four actions)
  await runTool(sub?.dataset.tool ?? form.dataset.tool, args, { button: sub, out, label });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest?.('button[data-tool]');
  if (!b || b.form || b.closest('form[data-tool]')) return;
  e.preventDefault();
  if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
  const card = b.closest('.tool-card');
  void runTool(b.dataset.tool, b.dataset.args ? JSON.parse(b.dataset.args) : {}, { button: b, out: card?.querySelector('.tool-out') ?? undefined });
});

// ---- showing results

const LEAD_KEYS = ['verdict', 'summary', 'result', 'assessment', 'quality', 'reason', 'why', 'next', 'note', 'notes'];
const MAX_ITEMS = 60;
const MAX_DEPTH = 4;
const words = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

function scalar(v) {
  if (v === null || v === undefined) return '<span class="muted">–</span>';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return esc(Number.isInteger(v) ? v : +v.toFixed(4));
  return esc(v);
}
const isScalar = (v) => v === null || typeof v !== 'object';

/** A JSON answer as something to read: key-value lists, tables for lists of records, the verdict first. */
export function renderValue(v, depth = 0) {
  if (isScalar(v)) return scalar(v);
  if (depth >= MAX_DEPTH) return `<code class="td-code">${esc(JSON.stringify(v)).slice(0, 400)}</code>`;
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="muted">none</span>';
    const more = v.length > MAX_ITEMS ? `<div class="muted small">+${v.length - MAX_ITEMS} more</div>` : '';
    const items = v.slice(0, MAX_ITEMS);
    if (items.every(isScalar)) return `${items.map(scalar).join(', ')}${more}`;
    const keys = [...new Set(items.flatMap((x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x) : [])))];
    const flat = items.every((x) => x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((y) => isScalar(y) || (Array.isArray(y) && y.every(isScalar))));
    if (flat && keys.length && keys.length <= 10) {
      const cell = (y) => (Array.isArray(y) ? y.map(scalar).join(', ') : scalar(y));
      return `<div class="td-scroll"><table class="td-table"><thead><tr>${keys.map((k) => `<th>${esc(words(k))}</th>`).join('')}</tr></thead><tbody>${items.map((x) => `<tr>${keys.map((k) => `<td>${cell(x[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${more}`;
    }
    return `<ol class="td-ol">${items.map((x) => `<li>${renderValue(x, depth + 1)}</li>`).join('')}</ol>${more}`;
  }
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  if (!entries.length) return '<span class="muted">–</span>';
  return `<dl class="kv">${entries.map(([k, x]) => `<dt>${esc(words(k))}</dt><dd>${renderValue(x, depth + 1)}</dd>`).join('')}</dl>`;
}

/** A tool's answer: its images, its verdict lines, then the rest. */
export function renderResult(r) {
  const imgs = (r.images ?? []).map((src) => `<img src="${esc(src)}" alt="" loading="lazy" data-lb="${esc(src)}">`).join('');
  let body;
  if (r.json && typeof r.json === 'object' && !Array.isArray(r.json)) {
    const lead = LEAD_KEYS.filter((k) => isScalar(r.json[k]) && r.json[k] !== undefined && r.json[k] !== null).map((k) => `<p class="td-lead"><b>${esc(words(k))}</b> ${scalar(r.json[k])}</p>`);
    const rest = Object.fromEntries(Object.entries(r.json).filter(([k, x]) => !(LEAD_KEYS.includes(k) && isScalar(x))));
    body = `${lead.join('')}${Object.keys(rest).length ? renderValue(rest) : ''}`;
  } else if (r.json !== undefined && r.json !== null) body = renderValue(r.json);
  else body = `<pre class="td-text">${esc(r.text ?? '')}</pre>`;
  return `${imgs ? `<div class="td-imgs">${imgs}</div>` : ''}${body}`;
}

document.addEventListener('click', (e) => {
  const img = e.target.closest?.('img[data-lb]');
  if (img) lightbox(img.dataset.lb, img.dataset.lb.split('/').pop());
});

/** A result shown in a card on its own screen (the Acquisition and Plan cards). */
function inlineEntry(out, title, name) {
  out.hidden = false;
  out.innerHTML = `<div class="td-item running"><div class="td-meta"><span class="spinner"></span> ${esc(title)}…</div></div>`;
  const started = Date.now();
  return {
    done: (r) => (out.innerHTML = `<div class="td-item"><div class="td-meta muted small">${esc(name)} · ${fmtClock(started)} · ${secs(started)}</div>${renderResult(r)}</div>`),
    fail: (m) => (out.innerHTML = `<div class="td-item err"><div class="td-meta muted small">${esc(name)} · ${fmtClock(started)}</div><p class="err">${esc(m)}</p></div>`),
  };
}

const secs = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

// ---- the results drawer: every run that has no card of its own, newest first

const DRAWER_KEEP = 12;
const drawer = $('#tool-drawer');
const list = $('#td-list');
const chip = $('#chip-results');
let running = 0;

function syncChip() {
  const n = list.children.length;
  chip.hidden = !n || !drawer.hidden;
  chip.textContent = running ? `⏳ ${running} running` : `⧉ results`;
  chip.classList.toggle('busy', running > 0);
}

export function openDrawer() {
  drawer.hidden = false;
  syncChip();
}
function closeDrawer() {
  drawer.hidden = true;
  syncChip();
}

function drawerEntry(title, name, quiet) {
  const el = document.createElement('article');
  el.className = 'td-item running';
  const started = Date.now();
  el.innerHTML = `<header class="td-meta"><b>${esc(title)}</b><span class="muted small"><span class="spinner"></span> running <span data-el>0s</span></span></header><div class="td-body"></div>`;
  list.prepend(el);
  while (list.children.length > DRAWER_KEEP) list.lastElementChild.remove();
  running++;
  const timer = setInterval(() => {
    const t = el.querySelector('[data-el]');
    if (t) t.textContent = secs(started);
  }, 1000);
  syncChip();
  const finish = (cls, body) => {
    clearInterval(timer);
    running = Math.max(0, running - 1);
    el.className = `td-item${cls}`;
    $('.td-meta .muted', el).textContent = `${name} · ${fmtClock(started)} · ${secs(started)}`;
    $('.td-body', el).innerHTML = body;
    syncChip();
  };
  return {
    done: (r) => finish('', renderResult(r)),
    fail: (m) => {
      finish(' err', `<p class="err">${esc(m)}</p>`);
      if (!quiet) openDrawer();
    },
  };
}

$('#td-close').onclick = closeDrawer;
$('#td-clear').onclick = () => {
  for (const el of [...list.children]) if (!el.classList.contains('running')) el.remove();
  if (!list.children.length) closeDrawer();
  syncChip();
};
chip.onclick = openDrawer;
document.addEventListener('keydown', (e) => {
  // an open picture closes first (dom.js)
  if (e.key === 'Escape' && !drawer.hidden && $('#lightbox').hidden) closeDrawer();
});
