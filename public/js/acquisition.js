/**
 * The Acquisition screen: exposure advice, measurements of this telescope's sensor and sky, sub
 * length, the quality probe, the dark library and the filter focus offsets. The cards are tool
 * forms (tools.js); this adds the session suggestions and asks before anything that shoots for a
 * long time or forgets measurements.
 */
import { $, esc } from './dom.js';
import { api } from './api.js';
import { on } from './bus.js';
import { state } from './state.js';
import { beforeRun } from './tools.js';

let listed = false;

/** Session folders to pick from: the library's, and those still on the telescope. */
async function loadSessions() {
  if (listed) return;
  listed = true;
  const [lib, dev] = await Promise.all([api('library').catch(() => null), state.config?.capabilities?.sessions === false ? null : api('sessions').catch(() => null)]);
  const names = new Set();
  for (const t of lib?.targets ?? []) for (const s of t.sessions ?? []) if (s.name) names.add(s.name);
  for (const s of dev?.sessions ?? []) if (s.folder) names.add(s.folder);
  $('#acq-sessions').innerHTML = ['latest', ...[...names].sort().reverse()].map((n) => `<option value="${esc(n)}">`).join('');
}
on('tab', (name) => {
  if (name === 'acq') void loadSessions();
});
// a new session or transfer: list them again next time
on('album-changed', () => (listed = false));

const ask = (msg) => confirm(msg);

beforeRun('dark_frames', (a) =>
  a.action !== 'capture' ||
  ask(
    `Capture a master dark (${a.exposure_s ?? '?'} s, gain ${a.gain ?? '?'}, ${a.frames ?? 20} frames)?\n\nIt runs in the background for about frames × exposure + 1 min. A DWARF mini closes its own dark filter; on a DWARF 3 the lens must be covered until the master is saved.`,
  ),
);
beforeRun('focus_offsets', (a) => {
  if (a.action === 'calibrate') return ask('Calibrate the filter focus offsets now?\n\nThe scope must be on a star field near the zenith and focused. It sweeps the focus through each filter in the background (~15 min on a Seestar, ~45 min on a Dwarf): do not stack, move or focus meanwhile.');
  if (a.action === 'forget') return ask(`Forget the measured focus offsets${a.filter ? ` of ${a.filter}` : ' of every filter'}?`);
  return true;
});
beforeRun('acquisition_quality', (a) => {
  if (a.action === 'measure') return ask(`Run the quality probe${a.target ? ` on ${a.target}` : ' on the plan’s current target'}?\n\nThe telescope shoots a few settings on the sky (minutes) to find the best signal-to-noise per hour.`);
  if (a.action === 'forget') return ask('Forget the quality samples of this target?');
  return true;
});
beforeRun('acquisition_measure', (a) => a.action !== 'forget' || ask(`Forget the stored ${a.forget ?? ''} measurement?`));
beforeRun('sub_length', (a) => a.action !== 'forget' || ask('Forget every sub-length analysis of this telescope?'));
