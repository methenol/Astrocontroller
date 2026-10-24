/** Manual controls on the View screen: nudging, focus, capture, camera mode and settings. */
import { $, $$, toast, busy, baseName } from './dom.js';
import { api, control } from './api.js';
import { emit } from './bus.js';
import { state } from './state.js';

// ---- nudging
// Held arrows send short nudges that each run out by themselves (NUDGE_MS), repeated faster than
// they expire, so the mount moves smoothly while held and stops on its own if this page goes away.
// Only one nudge loop ever runs, and every way a press can end stops it.
const NUDGE_MS = 700;
const NUDGE_EVERY_MS = 550;
let nudge = null; // { timer, button, pointerId }
/** The nudge request on the wire: a stop must reach the server after it, never before. */
let nudgeInFlight = Promise.resolve();

/** Ends the loop; the stop (with its toast label, if any) follows any nudge still in flight. */
function endNudge(label) {
  if (nudge) {
    clearInterval(nudge.timer);
    nudge = null;
  }
  return nudgeInFlight.then(() => control({ action: 'stop' }, label));
}

function stopNudge() {
  if (nudge) endNudge();
}

function startNudge(button, pointerId, angle) {
  if (nudge) {
    // a second finger or button while one is held: the first press ends here
    clearInterval(nudge.timer);
    nudge = null;
  }
  const speed = Number($('#speed').value);
  let failed = false;
  let sending = false;
  const loop = {};
  const tick = () => {
    // a slow link: skip a tick rather than queue nudges behind each other
    if (sending || nudge !== loop) return;
    sending = true;
    nudgeInFlight = api('control', { action: 'nudge', angle, speed, ms: NUDGE_MS })
      .catch((e) => {
        // one toast per press, not one per tick
        if (!failed) toast(`Nudge: ${e.message}`, true);
        failed = true;
      })
      .finally(() => {
        sending = false;
      });
  };
  Object.assign(loop, { timer: setInterval(tick, NUDGE_EVERY_MS), button, pointerId });
  nudge = loop;
  tick();
}

for (const b of $$('[data-nudge]')) {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      b.setPointerCapture(e.pointerId);
    } catch {
      // capture is best effort: the release handlers below still stop it
    }
    startNudge(b, e.pointerId, Number(b.dataset.nudge));
  });
  const end = (e) => {
    if (nudge && nudge.button === b && nudge.pointerId === e.pointerId) stopNudge();
  };
  b.addEventListener('pointerup', end);
  b.addEventListener('pointercancel', end);
  b.addEventListener('lostpointercapture', end);
  // keyboard and assistive tech: a click nudges once
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    control({ action: 'nudge', angle: Number(b.dataset.nudge), speed: Number($('#speed').value), ms: NUDGE_MS });
  });
}
// the page losing focus or going to the background never leaves the mount moving
window.addEventListener('blur', stopNudge);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopNudge();
});
window.addEventListener('pagehide', stopNudge);

$('#btn-stop').onclick = () => endNudge('Stopped');

// ---- one-shot actions
for (const b of $$('[data-act]')) {
  b.addEventListener('click', () =>
    busy(b, async () => {
      const act = b.dataset.act;
      if (act === 'autofocus') await control({ action: 'autofocus', mode: 'normal' }, 'Autofocus');
      else if (act === 'autofocus-astro') await control({ action: 'autofocus', mode: 'astro' }, 'Astro autofocus');
      else if (act === 'photo') {
        const r = await control({ action: 'photo', camera: b.dataset.camera }, null);
        if (r?.item?.filePath) toast(`saved ${baseName(r.item.filePath)}`);
      } else await control({ action: act }, b.textContent.trim());
    }),
  );
}

// Stars and focus: Sharpness measures the current focus, Tune searches around it. The search takes a
// couple of minutes; its per-step progress arrives over the state socket.
const TUNE_STEP = 5;
$('#btn-star-measure').onclick = () => control({ action: 'star_measure' }, 'Star sharpness');
$('#btn-star-tune').onclick = async () => {
  const range = Number($('#sel-tune-range').value);
  const at = state.telescope?.focusPosition;
  const photos = Math.round((range / TUNE_STEP) * 2 + 1);
  if (!confirm(`Tune the focus on the stars?\n\nThe focuser steps ±${range} around ${at ?? 'where it is now'} and takes a tele photo at every step — about ${photos} photos, a couple of minutes — then stops on the sharpest. Run autofocus first if you have not tonight; it is the wide search, this is the fine one. Your camera exposure is restored afterwards.`)) return;
  const b = $('#btn-star-tune');
  b.classList.add('busy');
  try {
    await control({ action: 'star_sweep', range }, 'Star tune');
  } finally {
    b.classList.remove('busy');
  }
};

// Polar alignment (EQ mode): the measurement takes 1-3 minutes; the result and the adjustment to make
// arrive over the state socket into the group's readout line.
$('#btn-polar').onclick = async () => {
  if (!confirm('Measure the polar alignment?\n\nThe telescope rotates and plate-solves near the celestial pole (1-3 min). It must be tilted on its wedge with the base aimed at the pole, homed, with time/location synced and a clear sky.')) return;
  const b = $('#btn-polar');
  b.classList.add('busy');
  try {
    await control({ action: 'polar_align' }, 'Polar alignment');
  } finally {
    b.classList.remove('busy');
  }
};
$('#btn-polar-stop').onclick = () => control({ action: 'polar_stop' }, 'Stop polar alignment');

const FOCUS_STEPS = 3;
for (const b of $$('[data-focus]')) b.addEventListener('click', () => control({ action: 'focus', direction: b.dataset.focus, steps: FOCUS_STEPS }, 'Focus'));

// ---- capture
async function capture(btn, body, label) {
  return busy(btn, async () => {
    try {
      const r = await api('control', body);
      if (r.item?.filePath) toast(`📷 saved ${baseName(r.item.filePath)}`);
      else if (typeof r.result === 'string') toast(r.result);
      else toast(`${label} ✓`);
      emit('album-changed');
      return r;
    } catch (e) {
      toast(`${label}: ${e.message}`, true);
      return undefined;
    }
  });
}
const DEFAULT_BURST = 10;
const camera = () => $('#cap-cam').value;
$('#btn-photo').onclick = () => capture($('#btn-photo'), { action: 'photo', camera: camera() }, 'Photo');
$('#btn-burst').onclick = () => capture($('#btn-burst'), { action: 'burst', camera: camera(), count: Number($('#inp-burst').value) || DEFAULT_BURST }, 'Burst');
$('#btn-record').onclick = async () => {
  const b = $('#btn-record');
  const on = b.classList.contains('on');
  const r = await capture(b, { action: 'record', camera: camera(), on: !on }, on ? 'Stop recording' : 'Record');
  if (r) {
    b.classList.toggle('on', !on);
    b.textContent = on ? '● Record' : '■ Stop rec';
  }
};
$('#btn-stack').onclick = () => {
  if (!confirm('Start live stacking with the current DSO settings? (Point at the target with GoTo first — the agent can do the whole workflow for you.)')) return;
  capture($('#btn-stack'), { action: 'stack_start', camera: camera() }, 'Stacking');
};

// ---- mode and camera settings
$('#sel-mode').onchange = async (e) => {
  const sel = e.target;
  const r = await control({ action: 'mode', mode: sel.value }, `Mode ${sel.value}`);
  // refused: show the mode the telescope is in (the state render skips a focused select)
  if (!r && state.telescope?.shootingMode?.name) sel.value = state.telescope.shootingMode.name;
};
$('#btn-apply').onclick = () =>
  busy($('#btn-apply'), async () => {
    const cam = camera();
    const exp = $('#inp-exp').value.trim();
    const gain = $('#inp-gain').value.trim();
    if (gain && !Number.isFinite(Number(gain))) return toast('Gain must be a number', true);
    if (exp) await control({ action: 'setting', camera: cam, setting: 'exposure', value: exp }, 'Exposure');
    if (gain) await control({ action: 'setting', camera: cam, setting: 'gain', value: Number(gain) }, 'Gain');
  });
