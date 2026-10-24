/**
 * What the connected driver's telescope can do (config.capabilities): the controls it has no
 * equivalent of are disabled with the reason, and the screens it has nothing for are hidden. The
 * same UI serves every driver; only this changes with it.
 */
import { $$ } from './dom.js';
import { on } from './bus.js';
import { state } from './state.js';

/** [selector, capability, what the control does] */
const CONTROLS = [
  ['[data-nudge], #btn-stop', 'nudge', 'Manual slewing'],
  ['[data-act="home"]', 'home', 'Homing'],
  ['[data-act="level"]', 'level', 'Level'],
  ['[data-act="park"]', 'park', 'Park'],
  ['[data-act="goto_stop"]', 'goto', 'GoTo'],
  ['[data-act="autofocus"]', 'autofocus', 'Autofocus'],
  ['[data-act="autofocus-astro"]', 'autofocusAstro', 'Star autofocus'],
  ['[data-focus]', 'focusSteps', 'Manual focus'],
  ['#btn-star-measure', 'starFocus', 'Star sharpness'],
  ['#btn-star-tune', 'starTune', 'Star focus tuning'],
  ['#btn-polar, #btn-polar-stop', 'polarAlign', 'Polar alignment'],
  ['#sel-mode', 'modes', 'Shooting modes'],
  ['#inp-exp', 'exposure', 'Exposure'],
  ['#inp-gain', 'gain', 'Gain'],
  ['[data-act="sync"]', 'sync', 'Time and location sync'],
  ['[data-act="liveview"]', 'liveView', 'Waking the live view'],
  ['[data-act="stack_stop"], #btn-stack', 'stack', 'Live stacking'],
  ['[data-power="reboot"]', 'reboot', 'Reboot'],
  ['[data-power="shutdown"]', 'shutdown', 'Shut down'],
  ['#btn-photo', 'photo', 'Photos'],
  ['#btn-burst, #inp-burst', 'burst', 'Burst'],
  ['#btn-record', 'record', 'Video recording'],
];

/** [selector, capability]: hidden when the telescope has none of it */
const SCREENS = [
  ['[data-tab="album"]', 'album'],
  ['#sessions-card', 'sessions'],
];

/** True unless the driver says it cannot (an old server sends no capabilities: everything is on). */
export const can = (config, cap) => config?.capabilities?.[cap] !== false;

function apply(config) {
  const label = config?.driverLabel ?? 'telescope';
  for (const [sel, cap, what] of CONTROLS) {
    const ok = can(config, cap);
    for (const el of $$(sel)) {
      if (!('capTitle' in el.dataset)) el.dataset.capTitle = el.title ?? '';
      el.disabled = !ok;
      el.classList.toggle('unsupported', !ok);
      el.title = ok ? el.dataset.capTitle : `${what} is not available on the ${label}`;
    }
  }
  for (const [sel, cap] of SCREENS) for (const el of $$(sel)) el.hidden = !can(config, cap);
  // Apply sends exposure and gain: it works if either does
  const applyBtn = document.getElementById('btn-apply');
  if (applyBtn) applyBtn.disabled = !can(config, 'exposure') && !can(config, 'gain');
}

on('config', apply);
// the screens re-enable their buttons as the telescope state changes (registered after them: this runs last)
on('telescope', () => apply(state.config));
