/**
 * A goal given as hours or as a signal-to-noise ratio: one control for every place a goal is set
 * (the program's add form and table, "Add to program" elsewhere, the general integration goal that
 * fillers and the target rest use). In SNR mode the server works out the hours this rig needs for
 * the target (src/astro/acquisition/snr-goal.ts) and keeps counting minutes.
 */
import { esc } from './dom.js';

/**
 * What an SNR goal buys, on the app's own scale (the acquisition planner: 3 a detection, 10 a clean
 * picture, 20 a deep one). The server's copy is SNR_GOAL_LEVELS in src/astro/acquisition/snr-goal.ts:
 * change both together. `max: null` is open-ended.
 */
export const SNR_LEVELS = [
  { label: 'Detection', min: 3, max: 5, note: 'the target shows, noisy: enough to frame it and judge it' },
  { label: 'Acceptable', min: 5, max: 10, note: 'a usable picture with visible noise' },
  { label: 'Clean', min: 10, max: 15, note: "a clean picture (the planner's own goal suggestion)" },
  { label: 'Very clean', min: 15, max: 20, note: 'smooth, room for stretching' },
  { label: 'Deep', min: 20, max: 30, note: 'faint outer structure comes through' },
  { label: 'Ultra-deep', min: 30, max: null, note: 'the faintest detail; very long projects' },
];
const CLEAN = 10;
export const SNR_DEFAULT = CLEAN;
const SNR_PRESETS = [3, 5, 8, 10, 12, 15, 20, 25, 30, 40];

/** The general goal's mode and SNR (rest settings): what a new target's goal control starts in. */
let defaults = { mode: 'time', snr: SNR_DEFAULT };
export const goalDefaults = () => defaults;
export function setGoalDefaults(rest) {
  if (rest) defaults = { mode: rest.goalMode === 'snr' ? 'snr' : 'time', snr: Number.isFinite(rest.snrTarget) ? rest.snrTarget : SNR_DEFAULT };
}

export function snrLevel(snr) {
  if (!(snr >= SNR_LEVELS[0].min)) return 'below detection';
  let label = SNR_LEVELS[0].label;
  for (const l of SNR_LEVELS) if (snr >= l.min) label = l.label;
  return label;
}

const range = (l) => (l.max === null ? `${l.min}+` : `${l.min}–${l.max}`);
const times = (snr) => {
  const x = (snr / CLEAN) ** 2;
  return x >= 10 ? `${Math.round(x)}` : `${Math.round(x * 100) / 100}`;
};
/** A level's integration relative to Clean: the hours go with SNR². */
const integration = (l) => (l.max === null ? `${times(l.min)}× or more` : `${times(l.min)}–${times(l.max)}×`);
const SNR_NOTE = 'Integration is relative to the time to Clean (SNR 10): the hours go with SNR², so twice the SNR takes four times as long. The SNR is the planner’s, per colour cell at the target’s mean surface brightness, on this rig under a dark moonless sky near transit — faint galaxies need many hours for any level; the hours are an estimate the plan updates.';

const hoursAt = (snr, perSqrtMin) => {
  const min = (snr / perSqrtMin) ** 2;
  return min < 60 ? `${Math.max(1, Math.round(min))} min` : `${+(min / 60).toFixed(min < 600 ? 1 : 0)} h`;
};
/** This target's hours for a level, from its rate (SNR after one minute). */
const targetHours = (l, perSqrtMin) => (l.max === null ? `${hoursAt(l.min, perSqrtMin)}+` : `${hoursAt(l.min, perSqrtMin)}–${hoursAt(l.max, perSqrtMin)}`);

/** The chart as plain text, for a title tooltip; with `perSqrtMin`, this target's hours too. */
export const snrChartTitle = (perSqrtMin) => `Imaging goal — target SNR — integration${perSqrtMin ? ' — this target' : ''}\n${SNR_LEVELS.map((l) => `${l.label}: ${range(l)} — ${integration(l)}${perSqrtMin ? ` — ${targetHours(l, perSqrtMin)}` : ''}`).join('\n')}\n\n${SNR_NOTE}`;

/**
 * The chart as a small popover (tap or hover the ⓘ), for touch screens where a title never shows.
 * `perSqrtMin` (a target's SNR after one minute) adds what each level takes on that target.
 */
export const snrHelpHtml = (perSqrtMin) => {
  ensureDatalist();
  const own = Number.isFinite(perSqrtMin) && perSqrtMin > 0 ? perSqrtMin : null;
  const rows = SNR_LEVELS.map((l) => `<tr title="${esc(l.note)}"><td>${esc(l.label)}</td><td>${esc(range(l))}</td><td>${esc(integration(l))}</td>${own ? `<td>${esc(targetHours(l, own))}</td>` : ''}</tr>`).join('');
  return `<details class="snr-help"><summary title="${esc(snrChartTitle(own))}" aria-label="What SNR to choose">ⓘ</summary><div class="snr-help-pop" role="note"><table><tr><th>Imaging goal</th><th>Target SNR</th><th>Integration</th>${own ? '<th>This target</th>' : ''}</tr>${rows}</table><p class="muted small">${esc(SNR_NOTE)}</p></div></details>`;
};

let datalistAdded = false;
/** The SNR presets as suggestions for the number field (one datalist for the page). */
function ensureDatalist() {
  if (datalistAdded || typeof document === 'undefined') return;
  datalistAdded = true;
  const dl = document.createElement('datalist');
  dl.id = 'snr-presets';
  dl.innerHTML = SNR_PRESETS.map((v) => `<option value="${v}">${esc(snrLevel(v))}</option>`).join('');
  document.body.appendChild(dl);
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * The control: a mode switch, the number, its unit and the chart. `hours` and `snr` are both kept
 * (data attributes), so switching back and forth does not lose either figure.
 * o: { mode, hours, snr, name, id, label, compact, minHours, stepHours, perSqrtMin (the target's SNR after one minute: its hours in the chart) }
 */
export function goalControlHtml(o = {}) {
  ensureDatalist();
  const mode = o.mode === 'snr' ? 'snr' : 'time';
  const hours = Number.isFinite(o.hours) ? r1(o.hours) : 3;
  const snr = Number.isFinite(o.snr) ? o.snr : SNR_DEFAULT;
  const name = o.name ?? 'goal';
  const idAttr = o.id ? ` id="${esc(o.id)}"` : '';
  const minH = o.minHours ?? 0.5;
  const stepH = o.stepHours ?? 0.5;
  const value = mode === 'snr' ? snr : hours;
  return `<span class="goal-ctl" data-goal-ctl data-mode="${mode}" data-hours="${esc(hours)}" data-snr="${esc(snr)}" data-min-h="${esc(minH)}" data-step-h="${esc(stepH)}">${o.label === false ? '' : `<span>${esc(o.label ?? 'goal')}</span>`}
    <select name="${esc(name)}Mode" data-goal-mode aria-label="Goal as hours or as a signal-to-noise ratio" title="Set the goal as integration hours, or as a target signal-to-noise ratio the plan turns into hours"><option value="time"${mode === 'time' ? ' selected' : ''}>hours</option><option value="snr"${mode === 'snr' ? ' selected' : ''}>SNR</option></select>
    <input${idAttr} name="${esc(name)}" type="number" data-goal-value ${mode === 'snr' ? `min="1" max="500" step="1" list="snr-presets" aria-label="Target signal-to-noise ratio"` : `min="${esc(minH)}" step="${esc(stepH)}" aria-label="Goal in hours"`} value="${esc(value)}" inputmode="decimal">
    <span class="goal-unit" data-goal-unit>${mode === 'snr' ? '' : 'h'}</span>${snrHelpHtml(o.perSqrtMin)}</span>`;
}

/** Flip a control between hours and SNR, keeping the other figure for the way back. */
function applyMode(ctl, mode) {
  const input = ctl.querySelector('[data-goal-value]');
  const unit = ctl.querySelector('[data-goal-unit]');
  if (input.value !== '') ctl.dataset[ctl.dataset.mode === 'snr' ? 'snr' : 'hours'] = input.value;
  ctl.dataset.mode = mode;
  if (mode === 'snr') {
    Object.assign(input, { min: 1, max: 500, step: 1 });
    input.setAttribute('list', 'snr-presets');
    input.setAttribute('aria-label', 'Target signal-to-noise ratio');
    input.value = ctl.dataset.snr || SNR_DEFAULT;
    unit.textContent = '';
  } else {
    input.removeAttribute('list');
    input.removeAttribute('max');
    Object.assign(input, { min: ctl.dataset.minH ?? 0.5, step: ctl.dataset.stepH ?? 0.5 });
    input.setAttribute('aria-label', 'Goal in hours');
    input.value = ctl.dataset.hours || 3;
    unit.textContent = 'h';
  }
  input.title = mode === 'snr' ? `${snrLevel(Number(input.value))}: the plan works out the hours` : '';
}

/**
 * Make a container's goal controls live. `onChange(ctl, goal)` (optional) runs when the owner
 * changes the mode or the figure — the program table saves right away; a form reads it on submit.
 */
export function wireGoalControls(root, onChange) {
  root.addEventListener('change', (e) => {
    const ctl = e.target.closest?.('[data-goal-ctl]');
    if (!ctl) return;
    if (e.target.matches('[data-goal-mode]')) {
      applyMode(ctl, e.target.value);
    } else if (e.target.matches('[data-goal-value]') && ctl.querySelector('[data-goal-mode]').value === 'snr') {
      e.target.title = `${snrLevel(Number(e.target.value))}: the plan works out the hours`;
    }
    if (onChange) {
      const goal = readGoal(ctl);
      if (goal) onChange(ctl, goal);
    }
  });
}

/**
 * The goal a control holds, as the server takes it: { goalMode: 'time', goalMin } or
 * { goalMode: 'snr', snrGoal }; null when the figure is not a usable number.
 */
export function readGoal(ctlOrForm) {
  const ctl = ctlOrForm.matches?.('[data-goal-ctl]') ? ctlOrForm : ctlOrForm.querySelector('[data-goal-ctl]');
  if (!ctl) return null;
  const mode = ctl.querySelector('[data-goal-mode]').value;
  const v = Number(ctl.querySelector('[data-goal-value]').value);
  if (mode === 'snr') return Number.isFinite(v) && v >= 1 && v <= 500 ? { goalMode: 'snr', snrGoal: Math.round(v * 10) / 10 } : null;
  return Number.isFinite(v) && v >= 0 ? { goalMode: 'time', goalMin: Math.round(v * 60) } : null;
}

const hoursText = (min) => `${+(min / 60).toFixed(1)} h`;

/** A target's goal in words: "SNR 30 (Very clean) ≈ 12.5 h" or "3 h". */
export function goalText(t) {
  if (t?.goalMode === 'snr' && Number.isFinite(t.snrGoal)) return `SNR ${t.snrGoal} (${snrLevel(t.snrGoal)}) ≈ ${hoursText(t.goalMin)}`;
  return hoursText(t?.goalMin ?? 0);
}
