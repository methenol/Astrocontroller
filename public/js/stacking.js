/**
 * The Stacking group: start a stack with the sub length, gain, filter and frame count given, stop
 * it, and look at it. The Dwarf takes them all with its start (live_stacking); the Seestar is given
 * them as camera settings first and then starts (start_stacking), as the agent does it. An empty
 * field keeps what the telescope has.
 */
import { $, toast } from './dom.js';
import { state } from './state.js';
import { runTool } from './tools.js';
import { stackWarning } from './telescope.js';

const form = $('#stack-form');
const camera = () => $('#cap-cam').value;
const seestar = () => state.config?.driver === 'seestar';
const val = (n) => form.elements[n]?.value.trim() ?? '';

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const exposure = val('exposure');
  const gain = val('gain');
  const filter = val('filter');
  const frames = val('frames');
  if (gain && !Number.isFinite(Number(gain))) return toast('Gain must be a number', true);
  if (frames && !Number.isInteger(Number(frames))) return toast('Frames must be a whole number', true);
  const what = [exposure && `${exposure} s subs`, gain && `gain ${gain}`, filter, !seestar() && frames && `${frames} frames`].filter(Boolean).join(', ');
  if (!confirm(`Start live stacking${what ? ` (${what})` : ' with the current settings'}?${stackWarning()} Point at the target with GoTo first.`)) return;
  const button = $('#btn-stack-go');
  if (!seestar()) {
    const args = { action: 'start', camera: camera() };
    if (exposure) args.exposure = exposure;
    if (gain) args.gain = Number(gain);
    if (filter) args.filter = filter;
    if (frames) args.frames = Number(frames);
    if (form.elements.force.checked) args.force = true;
    await runTool('live_stacking', args, { button, label: 'Start stacking' });
    return;
  }
  // the Seestar: each setting as the agent sets it, stopping at the first the scope refuses
  const settings = [exposure && ['exposure', exposure], gain && ['gain', Number(gain)], filter && ['filter', filter]].filter(Boolean);
  button.disabled = true;
  try {
    for (const [setting, value] of settings) {
      if (!(await runTool('set_camera_setting', { camera: 'tele', setting, value }, { label: `${setting} ${value}`, quiet: true }))) return;
    }
  } finally {
    button.disabled = false;
  }
  await runTool('start_stacking', form.elements.restart.checked ? { restart: true } : {}, { button, label: 'Start stacking' });
});

$('#btn-stack-halt').onclick = (e) => runTool('live_stacking', { action: 'stop', camera: camera() }, { button: e.currentTarget, label: 'Stop stacking', quiet: true });
$('#btn-stack-fast').onclick = (e) => runTool('live_stacking', { action: 'stop', camera: camera(), fast_stop: true }, { button: e.currentTarget, label: 'Fast stop', quiet: true });
$('#btn-stack-image').onclick = (e) =>
  seestar() ? runTool('get_image', { kind: 'stacked' }, { button: e.currentTarget, label: 'Stacked image' }) : runTool('view_camera', { source: 'stack' }, { button: e.currentTarget, label: 'Stacked image' });
