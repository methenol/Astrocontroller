/* The profile hub's page: switch between telescopes, and create, change, remove, activate and
   deactivate their profiles. The selected telescope's own UI runs in the frame at p/<id>/. */

const $ = (s) => document.querySelector(s);
const POLL_MS = 3000;
const SELECTED_KEY = 'astro.hub.selected';

const state = { profiles: [], selected: null, managing: false, editing: null, loaded: false };

// ---- helpers ---------------------------------------------------------------------------------------

async function api(path, body, method) {
  const res = await fetch(`hub/api/${path}`, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data ?? {};
}

let toastTimer;
function toast(text, err = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('err', err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const store = {
  get: () => {
    try {
      return localStorage.getItem(SELECTED_KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      localStorage.setItem(SELECTED_KEY, v);
    } catch {
      /* private mode */
    }
  },
};

const kindOf = (p) => (p.driver === 'dwarf' ? 'Dwarf' : p.seestar.starfront ? 'Seestar · Starfront' : p.seestar.zwo ? 'Seestar · ZWO' : 'Seestar');
const phaseText = { stopped: 'stopped', starting: 'starting…', running: 'running', stopping: 'stopping…', restarting: 'restarting…', failed: 'failed to start' };
const byId = (id) => state.profiles.find((p) => p.id === id);

function confirmBox({ title, text, ok = 'OK', danger = false, check }) {
  const d = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  $('#confirm-ok').className = danger ? 'primary danger' : 'primary';
  $('#confirm-check-row').hidden = !check;
  $('#confirm-check').checked = false;
  if (check) $('#confirm-check-label').textContent = check;
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? { checked: $('#confirm-check').checked } : null), { once: true });
  });
}

// ---- switcher and frame ------------------------------------------------------------------------------

const phaseOf = (p) => (p.active ? p.status.phase : 'off');
/** "Dwarf · running · 2 more profiles": the line under the profile's name on its button. */
function subline(p) {
  const others = state.profiles.length - 1;
  return `${kindOf(p)} · ${p.active ? phaseText[p.status.phase] : 'deactivated'}${others > 0 ? ` · ${others} more` : ''}`;
}

/** The hub's own bar (manager, idle profile) and the profile shown in the telescope UI's bar. */
function renderSwitcher() {
  const p = byId(state.selected);
  $('#hub-profile-name').textContent = p ? p.name : 'Telescopes';
  $('#hub-profile-sub').textContent = p ? subline(p) : `${state.profiles.length} profiles`;
  $('#hub-profile-dot').className = `pdot ${p ? phaseOf(p) : ''}`;
  $('#btn-manage').setAttribute('aria-pressed', String(state.managing));
  postProfile();
  if (!$('#switch-layer').hidden) renderSwitchList();
}

// ---- the telescope UI in the frame asks for the switcher; only same-origin messages from it count
const toFrame = (msg) => {
  const w = $('#frame').contentWindow;
  if (w && frameFor) w.postMessage({ source: 'astro-hub', ...msg }, location.origin);
};
let postedProfile = '';
function postProfile(force = false) {
  const p = byId(frameFor);
  if (!p) return;
  const msg = { type: 'profile', id: p.id, name: p.name, sub: subline(p), phase: phaseOf(p) };
  const key = JSON.stringify(msg);
  if (!force && key === postedProfile) return;
  postedProfile = key;
  toFrame(msg);
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== $('#frame').contentWindow || e.data?.source !== 'astro-app') return;
  document.body.classList.toggle('night', !!e.data.night);
  if (e.data.type === 'hello') postProfile(true);
  else if (e.data.type === 'open-switcher') {
    const f = $('#frame').getBoundingClientRect();
    const r = e.data.rect ?? {};
    openSwitcher({ left: f.left + (r.left ?? 0), bottom: f.top + (r.bottom ?? 0) }, true);
  } else if (e.data.type === 'manage') openManager();
});

// ---- the switcher -----------------------------------------------------------------------------------
let switcherFromFrame = false;
let listKey = '';
function renderSwitchList(force = false) {
  const key = JSON.stringify([state.selected, state.profiles.map((p) => [p.id, p.name, p.active, p.status.phase, p.driver])]);
  if (!force && key === listKey) return; // a poll that changed nothing must not steal the focus
  listKey = key;
  const running = state.profiles.filter((p) => p.active && p.status.phase === 'running').length;
  const off = state.profiles.filter((p) => !p.active).length;
  $('#switch-count').textContent = `${running} running${off ? ` · ${off} off` : ''}`;
  const list = $('#switch-list');
  if (!state.profiles.length) {
    list.replaceChildren(el('p', { class: 'muted small' }, 'No profiles yet.'));
    return;
  }
  list.replaceChildren(
    ...state.profiles.map((p) => {
      const current = p.id === state.selected && !state.managing;
      return el(
        'div',
        { class: `srow${current ? ' current' : ''}${p.active ? '' : ' off'}` },
        el(
          'button',
          { type: 'button', class: 'spick', 'aria-current': current ? 'true' : null, onclick: () => (closeSwitcher(false), select(p.id)) },
          el('span', { class: `dot ${p.active ? p.status.phase : ''}` }),
          el('span', { class: 'stext' }, el('b', {}, p.name), el('small', {}, `${kindOf(p)} · ${p.active ? phaseText[p.status.phase] : 'deactivated'}`)),
        ),
        p.active
          ? el('button', { type: 'button', class: 'sact warn', title: 'Stop this profile: no connection, no agent, no duty', onclick: () => (closeSwitcher(false), deactivate(p)) }, 'Deactivate')
          : el('button', { type: 'button', class: 'sact', onclick: () => (closeSwitcher(false), activate(p)) }, 'Activate'),
        p.active ? el('a', { class: 'sopen', href: `p/${encodeURIComponent(p.id)}/`, target: '_blank', rel: 'noopener', title: 'Open in its own browser tab', 'aria-label': `Open ${p.name} in a new browser tab` }, '↗') : null,
      );
    }),
  );
}

/** Opens the list under `anchor` (viewport px); on a phone it is a bottom sheet whatever the anchor. */
function openSwitcher(anchor, fromFrame) {
  switcherFromFrame = fromFrame;
  renderSwitchList(true);
  const menu = $('#switch-menu');
  const width = Math.min(420, window.innerWidth - 16);
  menu.style.setProperty('--x', `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`);
  menu.style.setProperty('--y', `${anchor.bottom + 6}px`);
  $('#switch-layer').hidden = false;
  $('#hub-profile').setAttribute('aria-expanded', 'true');
  (menu.querySelector('.spick[aria-current]') ?? menu.querySelector('button'))?.focus();
}
function closeSwitcher(refocus = true) {
  if ($('#switch-layer').hidden) return;
  $('#switch-layer').hidden = true;
  $('#hub-profile').setAttribute('aria-expanded', 'false');
  if (switcherFromFrame) toFrame({ type: 'switcher-closed', refocus });
  else if (refocus && !$('#hubbar').hidden) $('#hub-profile').focus();
}
$('#switch-layer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSwitcher();
});
$('#switch-layer').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSwitcher();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const picks = [...document.querySelectorAll('#switch-list .spick')];
    const i = picks.indexOf(document.activeElement);
    const next = picks[(i + (e.key === 'ArrowDown' ? 1 : -1) + picks.length) % picks.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }
});
$('#hub-profile').addEventListener('click', () => {
  if (!$('#switch-layer').hidden) return closeSwitcher();
  const r = $('#hub-profile').getBoundingClientRect();
  openSwitcher({ left: r.left, bottom: r.bottom }, false);
});
$('#switch-manage').addEventListener('click', () => (closeSwitcher(false), openManager()));
$('#switch-new').addEventListener('click', () => (closeSwitcher(false), openEditor(null)));

let frameFor = null;
function renderStage() {
  const frame = $('#frame');
  const idle = $('#idle');
  $('#manager').hidden = !state.managing;
  const p = byId(state.selected);
  // the telescope UI has the switcher in its own bar; the hub's bar is for when none is up
  $('#hubbar').hidden = !state.managing && !!p?.active && p.status.phase !== 'failed';
  document.title = p && !state.managing ? `${p.name} · Astrocontroller` : 'Astrocontroller';

  if (state.managing || !p) {
    frame.hidden = true;
    idle.hidden = true;
    if (!p && !state.managing && state.loaded) openManager();
    return;
  }
  // an active profile shows its UI (the proxy answers "starting" and reloads by itself until it runs)
  if (p.active && p.status.phase !== 'failed') {
    idle.hidden = true;
    frame.hidden = false;
    if (frameFor !== p.id) {
      frameFor = p.id;
      frame.src = `p/${encodeURIComponent(p.id)}/`;
    }
    return;
  }
  // inactive, or given up on: no UI to show, and nothing of it runs
  if (frameFor !== null) {
    frameFor = null;
    frame.src = 'about:blank';
  }
  frame.hidden = true;
  idle.hidden = false;
  $('#idle-name').textContent = p.name;
  $('#idle-why').textContent = p.active
    ? `Its process stopped at start: ${p.status.lastExit ?? 'unknown reason'}. The last lines it printed are below; fix the profile and activate it again.`
    : `${kindOf(p)} — deactivated. Nothing of this profile runs: no connection to the telescope, no duty, no plan, no autonomous night; the agent never wakes. Activate it to use it.`;
  $('#idle-activate').textContent = p.active ? 'Try again' : 'Activate';
  const out = $('#idle-output');
  out.hidden = !p.active;
  if (p.active) api(`profiles/${encodeURIComponent(p.id)}/output`).then((r) => (out.textContent = r.lines.slice(-40).join('\n') || '(no output)'), () => undefined);
}

function select(id) {
  if (!id) return openManager();
  state.selected = id;
  state.managing = false;
  store.set(id);
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  render();
}

function openManager() {
  state.managing = true;
  render();
}

// ---- manager ---------------------------------------------------------------------------------------

function fmtLoc(l) {
  if (l.latitude === null) return 'not set';
  return `${l.latitude.toFixed(4)}, ${l.longitude.toFixed(4)} · ${Math.round(l.elevationM)} m · ${l.timezone}`;
}

function renderCards() {
  const cards = $('#cards');
  if (!state.profiles.length) {
    cards.replaceChildren(el('p', { class: 'muted' }, 'No profiles yet. Create one for each telescope.'));
    return;
  }
  cards.replaceChildren(
    ...state.profiles.map((p) => {
      const s = p.status;
      const where = p.driver === 'seestar' && p.seestar.zwo ? `ZWO Telescope Network${p.seestar.serial ? ` · ${p.seestar.serial}` : ''}` : p.hostOverride ? `${p.hostOverride} (set in its System panel)` : p.host || (p.driver === 'dwarf' ? '192.168.88.1 (default)' : 'seestar.local (default)');
      const facts = [
        ['Type', kindOf(p)],
        ['Telescope', where],
        p.seestar.starfront ? ['Building', p.seestar.building ? String(p.seestar.building) : 'unknown (the telescope checks the roof)'] : null,
        p.driver === 'seestar' && p.seestar.zwo ? ['ZWO key', p.keyFile ?? 'not set'] : null,
        ['Location', fmtLoc(p.location)],
        ['Status', p.active ? `${phaseText[s.phase]}${s.phase === 'failed' || s.phase === 'restarting' ? ` (${s.lastExit})` : ''}` : 'deactivated'],
      ].filter(Boolean);
      return el(
        'article',
        { class: `pcard ${p.active ? '' : 'inactive'}` },
        el('header', {}, el('span', { class: `dot ${p.active ? s.phase : ''}` }), el('h3', { title: p.name }, p.name), el('span', { class: `badge ${p.active ? 'on' : ''}` }, p.active ? 'active' : 'inactive')),
        el('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
        p.keyProblem ? el('p', { class: 'problem' }, p.keyProblem) : null,
        p.tunnelProblem ? el('p', { class: 'problem' }, p.tunnelProblem) : null,
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'primary', onclick: () => select(p.id) }, 'Open'),
          p.active ? el('button', { type: 'button', onclick: () => deactivate(p) }, 'Deactivate') : el('button', { type: 'button', onclick: () => activate(p) }, 'Activate'),
          el('button', { type: 'button', onclick: () => openEditor(p) }, 'Edit'),
          p.active ? el('button', { type: 'button', onclick: () => restart(p) }, 'Restart') : null,
          el('button', { type: 'button', onclick: () => showOutput(p) }, 'Output'),
          el('button', { type: 'button', class: 'danger', onclick: () => removeProfile(p) }, 'Remove'),
        ),
      );
    }),
  );
}

function render() {
  renderSwitcher();
  renderStage();
  if (state.managing) renderCards();
}

async function refresh() {
  try {
    const r = await api('profiles');
    state.profiles = r.profiles;
    state.loaded = true;
    if (state.selected && !byId(state.selected)) state.selected = null;
    render();
  } catch (e) {
    console.warn('profile list:', e.message);
  }
}

async function act(p, verb, label) {
  try {
    await api(`profiles/${encodeURIComponent(p.id)}/${verb}`, {});
    toast(`${p.name}: ${label}`);
  } catch (e) {
    toast(`${p.name}: ${e.message}`, true);
  }
  await refresh();
}

const activate = (p) => act(p, 'activate', 'activated');
async function deactivate(p) {
  const ok = await confirmBox({
    title: `Deactivate ${p.name}?`,
    text: 'Its process stops: the telescope connection closes (a ZWO tunnel gives the scope back), the agent stops, and no plan, duty or autonomous night runs for it until you activate it again. Anything in progress on the telescope is not stopped first.',
    ok: 'Deactivate',
    danger: true,
  });
  if (ok) await act(p, 'deactivate', 'deactivated');
}
async function restart(p) {
  const ok = await confirmBox({ title: `Restart ${p.name}?`, text: 'Its process restarts with its current settings; the agent and the connection come back by themselves.', ok: 'Restart' });
  if (ok) {
    if (frameFor === p.id) frameFor = null;
    await act(p, 'restart', 'restarting');
  }
}

async function removeProfile(p) {
  const r = await confirmBox({
    title: `Remove ${p.name}?`,
    text: `The profile is stopped and removed. Its library (${p.libraryPath}) is kept.`,
    ok: 'Remove',
    danger: true,
    check: p.legacy || !p.dataPath.endsWith(`/profiles/${p.id}`) ? null : `Also delete its data folder (${p.dataPath}): the agent's home, notes, skills, chat history and plans`,
  });
  if (!r) return;
  try {
    await api(`profiles/${encodeURIComponent(p.id)}${r.checked ? '?purge=true' : ''}`, undefined, 'DELETE');
    toast(`${p.name} removed`);
    if (state.selected === p.id) state.selected = null;
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

async function showOutput(p) {
  $('#output-title').textContent = `${p.name}: output`;
  $('#output-text').textContent = 'loading…';
  $('#output').showModal();
  try {
    const r = await api(`profiles/${encodeURIComponent(p.id)}/output`);
    $('#output-text').textContent = r.lines.join('\n') || '(nothing yet: the profile has not run since the hub started)';
    $('#output-text').scrollTop = 1e9;
  } catch (e) {
    $('#output-text').textContent = e.message;
  }
}

// ---- the edit form -------------------------------------------------------------------------------------

const form = $('#edit-form');
const F = (name) => form.elements.namedItem(name);

function zones() {
  const list = $('#zones');
  if (list.childElementCount) return;
  let all = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = ['UTC'];
  }
  list.replaceChildren(...all.map((z) => el('option', { value: z })));
}

function syncForm() {
  const driver = form.querySelector('input[name=driver]:checked')?.value ?? 'dwarf';
  const seestar = driver === 'seestar';
  const zwo = seestar && F('zwo').checked;
  if (!zwo) F('starfront').checked = false;
  const starfront = zwo && F('starfront').checked;
  const show = { seestar, zwo, local: !zwo, starfront };
  for (const n of form.querySelectorAll('[data-when]')) n.hidden = !show[n.dataset.when];
  F('host').placeholder = seestar ? 'seestar.local' : '192.168.88.1 (AP mode)';
  $('#host-hint').textContent = seestar ? 'The Seestar on your network (station mode).' : 'The Dwarf in STA mode on your network; 192.168.88.1 when you are on its own Wi-Fi.';
  if (starfront) loadBuildings();
}

let buildingsLoaded = false;
async function loadBuildings() {
  const sel = F('building');
  const want = Number(sel.dataset.want ?? sel.value ?? 0);
  if (buildingsLoaded) return;
  buildingsLoaded = true;
  const opts = [el('option', { value: '0' }, 'Unknown — the telescope checks which roof is open')];
  try {
    const r = await api('starfront/buildings');
    for (const b of r.buildings) opts.push(el('option', { value: String(b.number) }, `${b.name} (#${b.number}${b.open ? ', roof open now' : ''})`));
    $('#building-hint').textContent = 'The roof of this building is followed: the night starts when it opens.';
  } catch (e) {
    for (let n = 1; n <= 20; n++) opts.push(el('option', { value: String(n) }, `Building ${n}`));
    $('#building-hint').textContent = `The Starfront building list could not be loaded (${e.message}); pick its number.`;
    buildingsLoaded = false;
  }
  if (want && !opts.some((o) => o.value === String(want))) opts.push(el('option', { value: String(want) }, `Building ${want}`));
  sel.replaceChildren(...opts);
  sel.value = String(want);
}

function openEditor(p) {
  zones();
  state.editing = p ?? null;
  form.reset();
  $('#edit-error').textContent = '';
  $('#edit-title').textContent = p ? `Edit ${p.name}` : 'New profile';
  $('#edit-save').textContent = p ? 'Save' : 'Create';
  const s = p?.seestar ?? {};
  const l = p?.location ?? {};
  F('name').value = p?.name ?? '';
  form.querySelector(`input[name=driver][value=${p?.driver ?? 'dwarf'}]`).checked = true;
  F('zwo').checked = !!s.zwo;
  F('host').value = p?.host ?? '';
  F('user').value = s.user ?? '';
  F('password').value = '';
  F('password').placeholder = s.hasPassword ? 'saved — leave empty to keep it' : '';
  F('serial').value = s.serial ?? '';
  F('country').value = s.country ?? 'US';
  F('starfront').checked = !!s.starfront;
  const sel = F('building');
  sel.dataset.want = String(s.building ?? 0);
  sel.replaceChildren(el('option', { value: String(s.building ?? 0) }, s.building ? `Building ${s.building}` : 'Unknown — the telescope checks which roof is open'));
  buildingsLoaded = false;
  F('latitude').value = l.latitude ?? '';
  F('longitude').value = l.longitude ?? '';
  F('elevationM').value = l.elevationM ?? '';
  F('timezone').value = l.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  F('env').value = Object.entries(p?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
  $('#paths').textContent = p ? `Data folder (agent home, workspace, sessions): ${p.dataPath} · Library: ${p.libraryPath}` : 'Each profile gets its own data folder (agent home, notes, skills, sessions) and library folder.';
  syncForm();
  $('#edit').showModal();
}

function numOrNull(v, what) {
  const t = String(v).trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`${what} is not a number`);
  return n;
}

function readForm() {
  const env = {};
  for (const raw of F('env').value.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) throw new Error(`"${line}" is not NAME=value`);
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const latitude = numOrNull(F('latitude').value, 'Latitude');
  const longitude = numOrNull(F('longitude').value, 'Longitude');
  if ((latitude === null) !== (longitude === null)) throw new Error('Set both latitude and longitude, or neither');
  const driver = form.querySelector('input[name=driver]:checked').value;
  const zwo = driver === 'seestar' && F('zwo').checked;
  return {
    name: F('name').value.trim(),
    driver,
    host: zwo ? '' : F('host').value.trim(),
    location: { latitude, longitude, elevationM: numOrNull(F('elevationM').value, 'Elevation') ?? 0, timezone: F('timezone').value.trim() || 'UTC' },
    seestar: {
      zwo,
      user: F('user').value.trim(),
      password: F('password').value || undefined,
      serial: F('serial').value.trim(),
      country: F('country').value.trim() || 'US',
      starfront: zwo && F('starfront').checked,
      building: Number(F('building').value) || 0,
    },
    env,
  };
}

form.addEventListener('change', syncForm);
$('#edit-cancel').addEventListener('click', () => $('#edit').close());
$('#btn-here').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('This browser has no location', true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      F('latitude').value = pos.coords.latitude.toFixed(5);
      F('longitude').value = pos.coords.longitude.toFixed(5);
      if (pos.coords.altitude !== null) F('elevationM').value = Math.round(pos.coords.altitude);
      F('timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    },
    (e) => toast(`Location: ${e.message} (browsers give it only over https or on localhost)`, true),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('#edit-error');
  err.textContent = '';
  let input;
  try {
    input = readForm();
  } catch (e) {
    err.textContent = e.message;
    return;
  }
  const p = state.editing;
  $('#edit-save').disabled = true;
  try {
    if (p) {
      const r = await api(`profiles/${encodeURIComponent(p.id)}`, input, 'PUT');
      $('#edit').close();
      toast(`${r.name} saved`);
      if (r.restartNeeded) {
        const ok = await confirmBox({ title: `Restart ${r.name} now?`, text: 'The new settings apply when its process restarts. Restarting now drops the connection for a moment; the agent comes back by itself.', ok: 'Restart now' });
        if (ok) {
          if (frameFor === r.id) frameFor = null;
          await act(r, 'restart', 'restarting with the new settings');
        }
      }
    } else {
      const ok = await confirmBox({ title: `Create ${input.name}`, text: 'Activate it now? An active profile connects to its telescope and its agent can be woken; you can activate it later from the list.', ok: 'Create and activate' });
      const r = await api('profiles', { ...input, activate: !!ok });
      $('#edit').close();
      toast(`${r.name} created${ok ? ' and activated' : ''}`);
      await refresh();
      if (ok) select(r.id);
    }
  } catch (e) {
    err.textContent = e.message;
  } finally {
    $('#edit-save').disabled = false;
    await refresh();
  }
});

// ---- wiring ----------------------------------------------------------------------------------------------

$('#btn-manage').addEventListener('click', () => (state.managing ? select(state.selected ?? state.profiles[0]?.id ?? null) : openManager()));
$('#btn-new').addEventListener('click', () => openEditor(null));
$('#idle-edit').addEventListener('click', () => {
  const p = byId(state.selected);
  if (p) openEditor(p);
});
$('#idle-activate').addEventListener('click', () => {
  const p = byId(state.selected);
  if (p) activate(p);
});

state.selected = decodeURIComponent(location.hash.slice(1)) || store.get();
await refresh();
if (!byId(state.selected)) state.selected = state.profiles.find((p) => p.active)?.id ?? state.profiles[0]?.id ?? null;
if (state.selected) select(state.selected);
else openManager();
setInterval(refresh, POLL_MS);
