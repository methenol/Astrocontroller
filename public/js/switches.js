/**
 * The Switches group on the View screen: the telescope's own on/off switches (the Dwarf's ring
 * light and power indicator, the dew heater, anti-tangle, auto shutdown…; the Seestar's dew heater,
 * indicator light, auto power-off and beep). Each driver says which it has; a state the telescope
 * has not reported shows neither On nor Off pressed.
 *
 * The dew heater has an Auto toggle (on by default; the server's dew-auto.ts): while it is on the
 * server holds the heater on when the forecast gives any chance of dew this hour or next, off while
 * the scope is parked, and on Starfront's autonomous nights to the roof (open on, closed off,
 * parked or not). The button against the hold is
 * disabled until Auto is turned off.
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
/** the server's dew heater Auto status (null until read, or where the server has none) */
let dew = null;
let dewBusy = false;
let list = null;
const DEW = 'lens_defog';

function dewHint() {
  if (!dew) return '';
  if (!dew.auto) return '<p class="small muted sw-note">Auto is off: the dew heater stays as you set it.</p>';
  const why = dew.reason ? esc(dew.reason) : 'checking the forecast…';
  const err = dew.lastError ? ` <span class="err">${esc(dew.lastError)}</span>` : '';
  const lead = dew.hold === true ? 'Auto keeps it on: ' : dew.hold === false ? 'Auto keeps it off: ' : 'Auto: ';
  return `<p class="small muted sw-note">${lead}${why}${err}</p>`;
}

function render(next) {
  if (next !== undefined) list = next;
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = '<p class="small muted">This telescope reports no switches.</p>';
    return;
  }
  const offline = !state.telescope?.connected;
  box.innerHTML = list
    .map((s) => {
      const dis = offline || setting === s.id ? ' disabled' : '';
      const unknown = s.on == null ? '<span class="sw-unknown">?</span>' : '';
      const isDew = s.id === DEW && dew;
      // Auto holding the heater one way (a dew risk, the Starfront roof): the other button waits for Auto to be turned off
      const hold = isDew && dew.auto ? dew.hold : null;
      const lock = (which) => (hold === !which ? ` disabled title="Auto is keeping the dew heater ${hold ? 'on' : 'off'}: turn Auto off first"` : '');
      const onDis = dis || lock(true);
      const offDis = dis || lock(false);
      const auto = isDew
        ? `<button type="button" class="sw-auto" data-dew-auto aria-pressed="${!!dew.auto}" title="Turn the dew heater on automatically when the forecast gives any chance of dew this hour or next ; off while parked (on Starfront nights: on with the roof open, off with it closed)"${dewBusy ? ' disabled' : ''}>Auto</button>`
        : '';
      return `<div class="switch-row" data-sw="${esc(s.id)}">
        <span class="sw-label" title="${esc(s.hint)}">${esc(s.label)}${unknown}</span>
        ${auto}<span class="sw-seg" role="group" aria-label="${esc(s.label)}">
          <button type="button" data-on="1" aria-pressed="${s.on === true}"${onDis}>On</button><button type="button" data-on="0" aria-pressed="${s.on === false}"${offDis}>Off</button>
        </span>
      </div>${isDew ? dewHint() : ''}`;
    })
    .join('');
}

async function load() {
  if (!group.open || !can() || loading || setting) return;
  loading = true;
  try {
    const [sw, d] = await Promise.all([api('control', { action: 'switches' }), api('dew-auto').catch(() => null)]);
    dew = d;
    render(sw.switches);
  } catch (e) {
    box.innerHTML = `<p class="small err">${esc(e.message)}</p>`;
  } finally {
    loading = false;
  }
}

box.addEventListener('click', async (e) => {
  const a = e.target.closest('button[data-dew-auto]');
  if (a) {
    if (a.disabled || dewBusy || !dew) return;
    const want = !dew.auto;
    dewBusy = true;
    a.disabled = true;
    try {
      dew = await api('dew-auto', { auto: want });
      toast(`Dew heater Auto ${want ? 'on' : 'off'}`);
    } catch (err) {
      toast(`Dew heater Auto: ${err.message}`, true);
    } finally {
      dewBusy = false;
    }
    // Auto turning on may just have switched the heater: read the switches again
    if (want) void load();
    else if (list) render();
    return;
  }
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
// the server's Auto checked the forecast or the roof, or switched the heater
on('dew-auto', (d) => {
  const switched = (d?.lastTurnedOn && d.lastTurnedOn !== dew?.lastTurnedOn) || (d?.lastTurnedOff && d.lastTurnedOff !== dew?.lastTurnedOff);
  dew = d;
  if (switched) void load();
  else if (list && !setting && !loading && group.open) render();
});
// the telescope reconnecting, or reporting a switch (the Dwarf's state carries them): read them again
on('telescope', (t) => {
  const key = `${!!t?.connected}|${JSON.stringify(t?.switches ?? null)}`;
  if (key === lastKey) return;
  lastKey = key;
  void load();
});
