/**
 * What every controller component shares: the link, the state, the live parameters, the guards,
 * and the observer location. Also the two ways of sending a command whose acknowledgement fw 1.5.3
 * may or may not send (`sendConfirmed`), and the state queries several components ask.
 */
import { errMsg, logger } from '../../../log.js';
import { DwarfCommandError, type DwarfLink, type RequestOptions } from '../link.js';
import { errorText } from '../protocol.js';
import type { StackTracker } from '../stacking.js';
import type { Guards } from './guards.js';
import type { ParamCache, StateStore, TelescopeState } from './state.js';
import { astroState, sleep } from './util.js';

const log = logger('dwarf');

export interface Location {
  lat: number;
  lon: number;
  elev: number;
}

export interface Core {
  readonly link: DwarfLink;
  readonly store: StateStore;
  readonly params: ParamCache;
  readonly guards: Guards;
  readonly stacks: StackTracker;
  location(): Location | null;
  requireLocation(): Location;
  /** last time the connection dropped or the telescope announced a power-off (ends motor routines) */
  lastDropAt: number;
  /** last time the mount moved: camera frames right after motion are corrupt for a few seconds */
  lastMotionAt: number;
}

export function request(core: Core, cmd: number, params: Record<string, unknown> = {}, opts?: RequestOptions) {
  return core.link.request(cmd, params, opts);
}

export interface ConfirmOptions {
  timeout?: number;
  /** checks the telescope's own state for the change (its notifications or a state read) */
  confirm?: () => boolean | Promise<boolean>;
  confirmMs?: number;
  /**
   * Check `confirm` while the reply is still awaited, and return as soon as it holds. Only for a
   * confirm that reads local state (no command traffic). The fast stack stops are answered under
   * another command id on fw 1.5.3 (2026-10-12: 11038 answered as the normal wide stop), so their
   * reply never matches and waiting for it cost the full timeout.
   */
  confirmEarly?: boolean;
}

/** How long sendConfirmed waits for the reply by default. */
const CONFIRM_REPLY_MS = 15_000;
/** After a missing reply, how long it keeps checking the telescope's state for the change. */
const CONFIRM_STATE_MS = 10_000;
/** How often the state is checked while the reply is still awaited (confirmEarly), and after it went missing. */
const CONFIRM_EARLY_POLL_MS = 250;
const CONFIRM_POLL_MS = 500;
/** Stops are fire-and-forget: wait this long for a reply at most. */
const STOP_TIMEOUT_MS = 5000;

/**
 * Send a command that fw 1.5.3 may or may not acknowledge. An error reply fails; a missing reply
 * is not a failure in itself: `confirm` checks the telescope's own state for the change, and only
 * if that also never shows it does this fail.
 */
export async function sendConfirmed(core: Core, cmd: number, params: Record<string, unknown>, what: string, o: ConfirmOptions = {}): Promise<Record<string, unknown> | null> {
  const timeout = o.timeout ?? CONFIRM_REPLY_MS;
  const confirmMs = o.confirmMs ?? CONFIRM_STATE_MS;
  const check = async () => (o.confirm ? Promise.resolve(o.confirm()).catch(() => false) : false);
  const reply = core.link.request(cmd, params, { timeout, bestEffort: true, allowError: true });
  let r: Record<string, unknown> | null;
  if (o.confirm && o.confirmEarly) {
    let replied = false;
    const early = (async () => {
      const end = Date.now() + timeout;
      while (!replied && Date.now() < end) {
        if (await check()) return true;
        await sleep(CONFIRM_EARLY_POLL_MS);
      }
      return false;
    })();
    const first = await Promise.race([reply.then((x) => ({ x })), early.then((ok) => ({ ok }))]);
    replied = true;
    if ('ok' in first) {
      if (first.ok) {
        // the change is there; a late error reply is only logged
        reply.then((x) => x && Number(x.code ?? 0) < 0 && log.warn(`${what}: error reply after the change was confirmed: ${errorText(Number(x.code))}`)).catch(() => {});
        return null;
      }
      r = await reply;
    } else {
      r = first.x;
    }
  } else {
    r = await reply;
  }
  const code = Number(r?.code ?? 0);
  if (r && code < 0) throw new DwarfCommandError(cmd, code, r);
  if (!r && o.confirm) {
    const end = Date.now() + confirmMs;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`${what}: the telescope neither acknowledged the command nor showed the change within ${Math.round((timeout + confirmMs) / 1000)} s`);
      await sleep(CONFIRM_POLL_MS);
    }
  }
  return r;
}

/** Send a stop the firmware may ignore; never throws (the caller judges by the state). */
export async function sendStop(core: Core, cmd: number, timeout = STOP_TIMEOUT_MS): Promise<void> {
  await core.link.request(cmd, {}, { bestEffort: true, timeout }).catch((e) => log.debug(`stop ${cmd}: ${errMsg(e)}`));
}

// ---- state queries -----------------------------------------------------------

/** The scope is tracking a target (after a GoTo): its motors then report "not homed", which is normal. */
export function isTracking(st: TelescopeState): boolean {
  const oc = st.oneClickGoto as { astroTrackingState?: { state?: number } } | undefined;
  return st.tracking.state === 'running' || astroState(oc?.astroTrackingState?.state) === 'running';
}

/** The scope started tracking at or after `t0` (a tracking state or one-click stage reported since). */
export function trackingSince(st: TelescopeState, t0: number): boolean {
  const oc = st.oneClickGoto as { astroTrackingState?: { state?: number }; at?: number } | undefined;
  if (st.tracking.state === 'running' && (st.tracking.at ?? 0) >= t0) return true;
  return astroState(oc?.astroTrackingState?.state) === 'running' && (oc?.at ?? 0) >= t0;
}

const ACTIVE = new Set(['running', 'plate_solving']);

/** What the telescope (or the controller) is busy with, if anything. */
export function busyWith(core: Core): string | null {
  const op = core.guards.operation;
  if (op) return op;
  const s = core.store.state;
  if (s.darkCapture?.state === 'running') return 'a dark capture';
  if (s.stacking.tele.state === 'running' || s.stacking.wide.state === 'running') return 'live stacking';
  if (ACTIVE.has(s.calibration.state)) return 'calibration';
  if (ACTIVE.has(s.goto.state)) return 'goto';
  if (s.eqSolving.state === 'running') return 'polar alignment';
  return null;
}

/** An astro routine (GoTo, calibration) is moving the motors. */
export function astroRoutineActive(st: TelescopeState): boolean {
  return ACTIVE.has(st.goto.state) || ACTIVE.has(st.calibration.state);
}
