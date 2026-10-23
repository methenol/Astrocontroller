/**
 * Finishing an ended stacking session, the way the official app's "Finish" button does (go live).
 *
 * The reference client (stevejcl/dwarf_python_api, V3 notes) found on hardware that without it the
 * firmware keeps the ended session and refuses the next stack start with -11501
 * ASTRO_FUNCTION_BUSY. This controller's wire logs (2026-10-10, -11, -12) show the other half:
 * while the tele reports captureRawState STOPPED (3), a tele photo is acknowledged with
 * photoState 1 and then never answers; after a go live, photos work again.
 *
 * An ended session is known two ways: a stack this connection saw stop (its stoppedAt), or the
 * device state read reporting the tele capture STOPPED (also after a restart of the controller).
 * Each is finished once, best effort: whatever follows reports any refusal itself.
 */
import { logger } from '../../../log.js';
import { Cmd } from '../protocol.js';
import type { CameraName } from '../stacking.js';
import { request, type Core } from './core.js';

const log = logger('dwarf');

/** the go live answers at once when it answers at all */
export const GO_LIVE_MS = 5_000;
/** captureRawState as the device state read reports it (notify.OperationState) */
export const CAPTURE_STOPPED = 3;
const GO_LIVE_CMD: Record<CameraName, number> = { tele: Cmd.ASTRO_GO_LIVE, wide: Cmd.ASTRO_WIDE_GO_LIVE };

interface Sessions {
  /** when each camera's ended session was last finished */
  finishedAt: Partial<Record<CameraName, number>>;
  /** the device reports this camera's capture stopped but not finished */
  reportedEnded: Partial<Record<CameraName, boolean>>;
}
const sessions = new WeakMap<Core, Sessions>();
const of = (core: Core): Sessions => {
  let s = sessions.get(core);
  if (!s) sessions.set(core, (s = { finishedAt: {}, reportedEnded: {} }));
  return s;
};

/** What the device state read says about a camera's capture: ended-but-not-finished, or not. */
export function noteCaptureState(core: Core, camera: CameraName, captureState: number): void {
  of(core).reportedEnded[camera] = captureState === CAPTURE_STOPPED;
}

/** Whether a camera has an ended session that was not finished since. */
export function hasEndedSession(core: Core, camera: CameraName): boolean {
  const s = of(core);
  if (s.reportedEnded[camera]) return true;
  const endedAt = core.store.state.stacking[camera].stoppedAt;
  return !!endedAt && endedAt > (s.finishedAt[camera] ?? 0);
}

/** Finish a camera's ended session with go live, if it has one; `before` names what it clears the way for. */
export async function finishEndedSession(core: Core, camera: CameraName, before: string): Promise<void> {
  if (!hasEndedSession(core, camera)) return;
  const s = of(core);
  s.finishedAt[camera] = Date.now();
  s.reportedEnded[camera] = false;
  const r = await request(core, GO_LIVE_CMD[camera], {}, { timeout: GO_LIVE_MS, allowError: true, bestEffort: true }).catch(() => null);
  // the go live itself makes the firmware report the stack idle, which reads as a newer end
  s.finishedAt[camera] = Date.now();
  log.info(`${camera} go live before ${before} (finishes the ended stacking session): ${r ? `code ${Number(r.code ?? 0)}` : 'no reply'}`);
}
