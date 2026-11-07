/**
 * "Add to program" from anywhere a target is shown (the Database, Stellarium): a compact goal +
 * priority form. A catalog object is added by its name, so the program keeps the catalog's position
 * and designations; anything the catalog does not know (a star picked on the sky, a frame composed
 * off-centre) is added as a custom target at the position given. Adding a target that is already in
 * the program updates its goal and priority instead (the server's own rule).
 */
import { esc, toast } from './dom.js';
import { api } from './api.js';
import { emit } from './bus.js';

const DEFAULT_GOAL_H = 3;
const DEFAULT_PRIORITY = 3;
const PRIORITIES = [[5, '5 top'], [4, '4 high'], [3, '3 normal'], [2, '2 below normal'], [1, '1 low']];

const hours = (min) => `${+(min / 60).toFixed(1)} h`;
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The program target this name refers to (by catalog id, GoTo name or display name), if any. */
export async function findInProgram(...names) {
  const keys = names.filter(Boolean).map(norm);
  if (!keys.length) return null;
  try {
    const program = await api('plan/program');
    return (Array.isArray(program) ? program : []).find((t) => [t.name, t.gotoName, t.displayName].some((n) => keys.includes(norm(n)))) ?? null;
  } catch {
    return null;
  }
}

/** The form's markup; `entry` is the program target when it is already in the program. */
export function programFormHtml(entry, { disabled = '', compact = false } = {}) {
  const goalH = entry ? +(entry.goalMin / 60).toFixed(1) : DEFAULT_GOAL_H;
  const pri = entry?.priority ?? DEFAULT_PRIORITY;
  const status = entry
    ? `<span class="muted small prog-add-status">In the program: ${esc(hours(entry.goalMin))} goal, priority ${esc(entry.priority)}${entry.collectedMin ? `, ${esc(hours(entry.collectedMin))} collected` : ''}${entry.enabled === false ? ' (paused)' : ''}</span>`
    : '';
  return `<form class="prog-add${compact ? ' compact' : ''}" data-prog-add autocomplete="off">
    ${status}
    <span class="prog-add-row">
      <label>goal <input name="goal" type="number" min="0.5" step="0.5" value="${esc(goalH)}" inputmode="decimal" aria-label="Goal in hours"> h</label>
      <label>priority <select name="priority" aria-label="Priority">${PRIORITIES.map(([v, l]) => `<option value="${v}"${v === pri ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <button type="submit"${disabled ? ` disabled title="${esc(disabled)}"` : ''}>${entry ? 'Update program' : 'Add to program'}</button>
    </span>
  </form>`;
}

/**
 * Add (or update) a target. `t`: { name, display, raHours, decDeg, custom } where custom means the
 * position is the point (a composed frame), not the catalog object's.
 */
export async function addToProgram(t, goalH, priority) {
  const goalMin = Math.round((Number.isFinite(goalH) && goalH > 0 ? goalH : DEFAULT_GOAL_H) * 60);
  const base = { goalMin, priority: Number(priority) || DEFAULT_PRIORITY };
  const hasPos = Number.isFinite(t.raHours) && Number.isFinite(t.decDeg);
  const pos = hasPos ? { raHours: ((t.raHours % 24) + 24) % 24, decDeg: Math.max(-90, Math.min(90, t.decDeg)) } : {};
  const name = (t.name || t.display || '').trim();
  let r;
  if (t.custom || !name) {
    if (!hasPos) throw new Error('no position to add');
    r = await api('plan/program', { name: name || customName(pos), ...pos, ...base });
  } else {
    try {
      r = await api('plan/program', { name, ...base });
    } catch (e) {
      // the catalog does not know it (a star, a Stellarium-only object): a custom target at its position
      if (!hasPos || !/not in the catalog/i.test(e.message)) throw e;
      r = await api('plan/program', { name, ...pos, ...base });
    }
  }
  emit('program-changed', r);
  return r;
}

const customName = ({ raHours, decDeg }) => `Custom ${raHours.toFixed(2)}h ${decDeg >= 0 ? '+' : '−'}${Math.abs(decDeg).toFixed(1)}°`;

/**
 * Wire a container's [data-prog-add] forms: `target(form)` gives the target the form belongs to,
 * `done(entry)` runs after a successful add (to re-render the status line).
 */
export function wireProgramForms(container, target, done) {
  container.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-prog-add]');
    if (!form) return;
    e.preventDefault();
    const t = target(form);
    if (!t) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const r = await addToProgram(t, Number(form.elements.goal.value), form.elements.priority.value);
      toast(`${r.displayName}: ${hours(r.goalMin)} wanted, priority ${r.priority} — in the program`);
      done?.(r);
    } catch (err) {
      toast(`Add to program: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  });
}
