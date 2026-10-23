/**
 * A camera whose photo never ends. 2026-10-12 19:37 and 19:45 (fw 1.5.3.9): a tele photo was
 * acknowledged with photoState 1 and then nothing: no reply, no end, no album entry, and every
 * later command on the camera (go live, a mode switch) refused with -8 until a reboot. The device
 * state read keeps reporting the tele photoState running.
 *
 * A photo running that this controller is not taking, across state reads at least STUCK_AFTER_MS
 * apart, is a stuck camera: it is published (state.photoStuckSince) and the next photo is refused
 * at once with what clears it, instead of waiting out another photo that cannot finish.
 */
import type { CameraName } from '../stacking.js';
import type { Core } from './core.js';

export const STUCK_AFTER_MS = 60_000;

interface Watch {
  inFlight: Set<CameraName>;
  runningSince: Partial<Record<CameraName, number>>;
}
const watches = new WeakMap<Core, Watch>();
const of = (core: Core): Watch => {
  let w = watches.get(core);
  if (!w) watches.set(core, (w = { inFlight: new Set(), runningSince: {} }));
  return w;
};

/** A photo of ours is under way on this camera until the returned function is called. */
export function photoInFlight(core: Core, camera: CameraName): () => void {
  const w = of(core);
  w.inFlight.add(camera);
  delete w.runningSince[camera];
  return () => {
    w.inFlight.delete(camera);
    delete w.runningSince[camera];
  };
}

/** What a device state read says about a camera's photo. */
export function notePhotoState(core: Core, camera: CameraName, running: boolean, now = Date.now()): void {
  const w = of(core);
  const st = core.store.state;
  if (!running) {
    delete w.runningSince[camera];
    if (st.photoStuckSince?.[camera]) delete st.photoStuckSince[camera];
    return;
  }
  if (w.inFlight.has(camera)) return;
  const since = (w.runningSince[camera] ??= now);
  if (now - since >= STUCK_AFTER_MS) markPhotoStuck(core, camera, since);
}

export function markPhotoStuck(core: Core, camera: CameraName, since: number): void {
  const st = core.store.state;
  st.photoStuckSince = { ...st.photoStuckSince, [camera]: st.photoStuckSince?.[camera] ?? since };
}

export const stuckPhotoMessage = (camera: CameraName) =>
  `the ${camera} camera's photo service is stuck (a photo the telescope accepted never finished; it refuses further commands, -8): a telescope reboot (power reboot) clears it`;
