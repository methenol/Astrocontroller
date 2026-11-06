/**
 * The Switches group on the View screen: the telescope's own on/off switches (the Dwarf's ring
 * light and power indicator, the dew heater, anti-tangle, auto shutdown…; the Seestar's dew heater,
 * indicator light, auto power-off and beep). Each driver says which it has; a state the telescope
 * has not reported shows neither On nor Off pressed.
 */
import { $, esc, toast } from './dom.js';
import { api } from './api.js';
import { on } from './bus.js';
import { state } from './state.js';

/** capabilities.js decides the group's visibility; it is not imported here, as it must register last */
const can = () => state.config?.capabilities?.switches !== false;

const group = $('#grp-switches');
const box = $('#switch-list');
/** the switch being set: its row stays disabled, and a refresh does not redraw under it */
let setting = null;
let loading = false;
let lastKey = '';

function render(list) {
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = '<p class="small muted">This telescope reports no switches.</p>';
    return;
  }
  const offline = !state.telescope?.connected;
  box.innerHTML = list
    .map((s) => {
      const dis = offline || setting === s.id ? ' disabled' : '';
      const unknown = s.on == null ? '<span class="sw-unknown">?</span>' : '';
      return `<div class="switch-row" data-sw="${esc(s.id)}">
        <span class="sw-label" title="${esc(s.hint)}">${esc(s.label)}${unknown}</span>
        <span class="sw-seg" role="group" aria-label="${esc(s.label)}">
          <button type="button" data-on="1" aria-pressed="${s.on === true}"${dis}>On</button><button type="button" data-on="0" aria-pressed="${s.on === false}"${dis}>Off</button>
        </span>
      </div>`;
    })
    .join('');
}

async function load() {
  if (!group.open || !can() || loading || setting) return;
  loading = true;
  try {
    render((await api('control', { action: 'switches' })).switches);
  } catch (e) {
    box.innerHTML = `<p class="small err">${esc(e.message)}</p>`;
  } finally {
    loading = false;
  }
}

box.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-on]');
  const row = b?.closest('[data-sw]');
  if (!b || !row || b.disabled || setting) return;
  const id = row.dataset.sw;
  const want = b.dataset.on === '1';
  setting = id;
  for (const x of row.querySelectorAll('button')) x.disabled = true;
  try {
    const r = await api('control', { action: 'switch', id, on: want });
    toast(r.result ?? `${id} ${want ? 'on' : 'off'}`);
    setting = null;
    render(r.switches);
  } catch (err) {
    toast(`${row.querySelector('.sw-label')?.textContent ?? id}: ${err.message}`, true);
    setting = null;
    void load();
  }
});

group.addEventListener('toggle', () => {
  if (group.open) void load();
});
on('config', () => void load());
// the telescope reconnecting, or reporting a switch (the Dwarf's state carries them): read them again
on('telescope', (t) => {
  const key = `${!!t?.connected}|${JSON.stringify(t?.switches ?? null)}`;
  if (key === lastKey) return;
  lastKey = key;
  void load();
});
