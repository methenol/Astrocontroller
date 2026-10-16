/** The duty loop: the agent wakes on a schedule to work toward an objective until a set time. */
import { $, toast, fmtClock } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';

const DEFAULT_INTERVAL_MIN = 5;

export function renderDuty(d) {
  if (!d || typeof d !== 'object') return;
  state.duty = d;
  const bar = $('#duty-bar');
  bar.className = `duty-bar ${d.status}`;
  $('#duty-state').textContent = d.status === 'active' ? 'On duty' : d.status === 'paused' ? 'Duty paused' : 'Duty off';
  const parts = [];
  if (d.status !== 'off') {
    if (d.untilLabel) parts.push(`until ${d.untilLabel}`);
    if (d.status === 'active') parts.push(d.nextWakeAt ? `next sample ${fmtClock(d.nextWakeAt)}` : 'next sample after this turn');
    if (d.status === 'paused' && d.pausedReason) parts.push(d.pausedReason);
    parts.push(`${d.wakes} wake${d.wakes === 1 ? '' : 's'}`);
  } else if (d.endedReason) parts.push(`last: ${d.endedReason}`);
  if (d.pendingEvents) parts.push(`${d.pendingEvents} event(s) waiting`);
  if (d.heldByStop) parts.push('automatic wakes held until you write to the agent');
  $('#duty-text').textContent = parts.join(' · ');
  bar.title = d.objective ? `Objective: ${d.objective}` : '';
  $('#btn-duty').textContent = d.status === 'off' ? 'Start duty…' : 'Stop duty';
  $('#btn-duty-pause').hidden = d.status === 'off';
  $('#btn-duty-pause').textContent = d.status === 'paused' ? 'Resume' : 'Pause';
  $('#btn-duty-wake').hidden = d.status !== 'active';
}

/** Resolves true when the server took it. */
async function dutyApi(body) {
  try {
    renderDuty(await api('duty', body));
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

$('#btn-duty').onclick = () => {
  if (state.duty?.status && state.duty.status !== 'off') {
    if (confirm(`Stop the duty?\n\n${state.duty.objective ?? ''}`)) dutyApi({ action: 'stop' });
    return;
  }
  const form = $('#duty-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('#duty-objective').focus();
};
$('#btn-duty-pause').onclick = () => dutyApi({ action: state.duty?.status === 'paused' ? 'resume' : 'pause' });
$('#btn-duty-wake').onclick = () => dutyApi({ action: 'wake' });
$('#duty-cancel').onclick = () => ($('#duty-form').hidden = true);
$('#duty-until').onchange = () => ($('#duty-time').hidden = $('#duty-until').value !== 'time');
$('#duty-form').onsubmit = async (e) => {
  e.preventDefault();
  const sel = $('#duty-until').value;
  const until = sel === 'time' ? $('#duty-time').value : sel;
  if (sel === 'time' && !until) return toast('pick an end time', true);
  const objective = $('#duty-objective').value.trim();
  if (!objective) return toast('write the objective', true);
  const minutes = Number($('#duty-interval').value);
  const intervalS = Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MIN) * 60);
  // the form keeps what was typed when the server refuses it
  if (!(await dutyApi({ action: 'start', objective, until, intervalS }))) return;
  $('#duty-form').hidden = true;
  $('#duty-objective').value = '';
};
