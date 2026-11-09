/** The E-STOP button and the banner that holds Enable Control while it is engaged. */
import { $, toast } from './dom.js';
import { api } from './api.js';

const TEXT = {
  startup: 'Telescope control is off (CONTROL_ENABLED_ON_STARTUP=false). You can talk to the agent; the telescope takes no commands until you enable control.',
  user: 'E-STOP engaged: movement and operations were halted. The telescope stays connected but takes no commands until you enable control.',
};

let lastFailed = '';

export function renderEStop(s) {
  const engaged = !!s?.engaged;
  document.body.classList.toggle('estopped', engaged);
  const btn = $('#btn-estop');
  // the start-up lock has halted nothing yet: the button still sends the stop commands
  const halted = engaged && s.source === 'user';
  btn.textContent = halted ? 'E-STOPPED' : 'E-STOP';
  btn.disabled = halted;
  $('#estop-banner').hidden = !engaged;
  const failed = engaged ? (s.haltFailed ?? []).join('; ') : '';
  $('#estop-text').textContent = engaged ? `${TEXT[s.source] ?? TEXT.user}${failed ? ` Could not confirm: ${failed}.` : ''}` : '';
  if (failed && failed !== lastFailed) toast(`E-Stop could not confirm: ${failed}`, true);
  lastFailed = failed;
}

async function press(engaged) {
  try {
    renderEStop(await api('estop', { engaged }));
  } catch (e) {
    toast(e.message, true);
  }
}

// one press, no confirmation: this is the button for when something is going wrong
$('#btn-estop').onclick = () => press(true);
$('#btn-estop-clear').onclick = () => {
  if (confirm('Enable telescope control? Nothing halted is resumed, but commands, the agent and the Duty controls can move the telescope again.')) void press(false);
};
