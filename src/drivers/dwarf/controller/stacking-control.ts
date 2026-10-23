/**
 * Starting and stopping live stacks. One path for the agent and the web UI: DSO mode, wait out the
 * end of the previous stack on the camera, apply exposure/gain/filter/frame count, start, and
 * confirm the start from the telescope's own stacking state. From the first settings write to the
 * confirmed start the camera belongs to the coming stack (Guards.preparingStack), so nothing else
 * changes what it shoots in between.
 */
import { logger } from '../../../log.js';
import { DwarfCommandError } from '../link.js';
import { Cmd, errorText } from '../protocol.js';
import type { CameraName } from '../stacking.js';
import type { CameraControl } from './camera.js';
import { request, sendConfirmed, type Core } from './core.js';
import { finishEndedSession } from './session-finish.js';
import { FILTERS, resolveFilter, sleep } from './util.js';

const log = logger('dwarf');

export interface StackRequest {
  exposure?: string | number;
  gain?: number;
  filter?: string | number;
  frames?: number;
  force?: boolean;
  startedBy: 'agent' | 'ui';
}

export interface StackControlInfo {
  startedBy?: 'agent' | 'ui';
  /** when a stop was asked for, to tell a requested stop from one the scope made itself */
  stopRequestedAt?: number;
}

/** the firmware's "busy" reply to settings sent while the previous stack is still closing */
const STILL_CLOSING = -1;
/** once running is reported, a reply (possibly carrying a warning code) gets this long to arrive */
const REPLY_AFTER_RUNNING_MS = 1500;
const RUNNING_POLL_MS = 100;
/** a normal stop finishes the final stack first, which takes up to minutes on long subs */
const STOP_REPLY_MS = 30_000;
const STOP_CONFIRM_MS = 120_000;

const START_CMD: Record<CameraName, number> = { tele: Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING, wide: Cmd.ASTRO_START_WIDE_CAPTURE_LIVE_STACKING };
const STOP_CMD: Record<CameraName, { normal: number; fast: number }> = {
  tele: { normal: Cmd.ASTRO_STOP_CAPTURE_RAW_LIVE_STACKING, fast: Cmd.ASTRO_FAST_STOP_CAPTURE_RAW_LIVE_STACKING },
  wide: { normal: Cmd.ASTRO_STOP_WIDE_CAPTURE_LIVE_STACKING, fast: Cmd.ASTRO_FAST_STOP_WIDE_CAPTURE_LIVE_STACKING },
};

export class StackingControl {
  /** How long a start may go unacknowledged, how long the stacking notifications then get to confirm it, and how long they get after an error reply. */
  readonly stackTiming = { replyMs: 20000, confirmMs: 45000, errorConfirmMs: 8000 };
  /** After a stop the firmware keeps closing the stack for a while; settings sent then fail with -1. */
  readonly stackRestartTiming = { settleMs: 20_000, retryMs: 5_000 };
  readonly stackControl: Record<CameraName, StackControlInfo> = { tele: {}, wide: {} };

  constructor(
    private readonly core: Core,
    private readonly camera: CameraControl,
    /** each camera's exposure at its stack start (the tracker's sub cadence) */
    private readonly exposureAtStart: Partial<Record<CameraName, number>>,
  ) {}

  private get state() {
    return this.core.store.state;
  }

  /**
   * 2026-10-12 05:25-05:28: settings sent right after a stop failed with -1 (three starts failed
   * that way and read as a wrong shooting mode); they are sent after the settle time and retried
   * once on -1.
   */
  async startWith(camera: CameraName, o: StackRequest): Promise<string> {
    this.core.guards.assertNoOperation('starting live stacking');
    // refused before the mode switch and the settings writes: a refusal leaves the camera as it was
    this.core.guards.assertNoNdLock('live stacking');
    return this.core.guards.preparingStack(camera, () => this.prepareAndStart(camera, o));
  }

  private async prepareAndStart(camera: CameraName, o: StackRequest): Promise<string> {
    await this.camera.ensureMode('DSO');
    const t = this.stackRestartTiming;
    const sinceStop = Date.now() - (this.state.stacking[camera].stoppedAt ?? 0);
    if (sinceStop < t.settleMs) await sleep(t.settleMs - sinceStop);
    await finishEndedSession(this.core, camera, 'the next stack');
    const set = async (key: string, value: string | number): Promise<string> => {
      try {
        return await this.camera.setSetting(camera, key, value);
      } catch (e) {
        if (!(e instanceof DwarfCommandError && e.code === STILL_CLOSING)) throw e;
        log.info(`${camera} ${key} refused with ${STILL_CLOSING} before a stack start (previous stack still closing): retrying in ${t.retryMs / 1000} s`);
        await sleep(t.retryMs);
        return this.camera.setSetting(camera, key, value);
      }
    };
    const applied: string[] = [];
    if (o.exposure !== undefined) applied.push(await set('exposure', o.exposure));
    if (o.gain !== undefined) applied.push(await set('gain', o.gain));
    let filterIndex: number | undefined;
    if (o.filter !== undefined) {
      if (camera === 'tele') {
        filterIndex = resolveFilter(o.filter);
        applied.push(await set('filter', filterIndex));
      } else {
        applied.push(`filter ${o.filter} not applied: the wide camera has no filter choice`);
      }
    }
    if (o.frames !== undefined) applied.push(await set(camera === 'wide' ? 'stackCount_wide' : 'stackCount', o.frames));
    this.stackControl[camera] = { startedBy: o.startedBy };
    const r = await this.start(camera, { filterIndex, force: o.force });
    return [...applied, r].join('\n');
  }

  /** Start a stack with the camera's current settings. */
  async start(camera: CameraName, opts: { filterIndex?: number; force?: boolean } = {}): Promise<string> {
    const { guards, stacks } = this.core;
    guards.assertNoOperation('starting live stacking');
    guards.assertNoNdLock('live stacking');
    await finishEndedSession(this.core, camera, 'the next stack');
    this.exposureAtStart[camera] = (await this.camera.exposureSeconds(camera).catch(() => null)) ?? undefined;
    stacks.startSent(camera);
    try {
      return await this.startNow(camera, opts);
    } catch (e) {
      // a refused start must not keep the camera locked for the retry's settings
      if (this.state.stacking[camera].state !== 'running') stacks.startFailed(camera);
      throw e;
    }
  }

  private async startNow(camera: CameraName, opts: { filterIndex?: number; force?: boolean }): Promise<string> {
    const force = !!opts.force;
    let params: Record<string, unknown> = { forceStart: force };
    let what = 'wide live stacking';
    if (camera === 'tele') {
      const ir = opts.filterIndex ?? (await this.camera.currentFilterIndex());
      params = { irIndex: ir, forceStart: force };
      what = `tele live stacking (filter ${FILTERS[ir] ?? ir})`;
    }
    const cmd = START_CMD[camera];
    const { reply, confirmed } = await this.startAndConfirm(camera, cmd, params);
    const code = Number(reply?.code ?? 0);
    if (code < 0) {
      if (!confirmed) throw new DwarfCommandError(cmd, code, reply ?? {});
      // a warning, not a refusal: the firmware reported it and stacks anyway
      if (!force) return `${what} started with a WARNING from the telescope: ${errorText(code)}. It is stacking; check the first frames.`;
      return camera === 'tele'
        ? `WARNING: ${errorText(code)}. The telescope started a forced tele stack anyway; without calibration+GoTo it may not save a session or FITS. For a real capture run goto_target first.`
        : `WARNING: ${errorText(code)}. The telescope started the forced wide stack anyway.`;
    }
    if (!confirmed) {
      const s = Math.round((this.stackTiming.replyMs + this.stackTiming.confirmMs) / 1000);
      throw new Error(`the telescope neither acknowledged the ${camera} live-stacking start nor reported stacking within ${s} s. Check stacking_status before retrying (it may still start).`);
    }
    if (reply && this.state.stacking[camera].state !== 'running') this.core.stacks.confirmRunning(camera);
    return `${what} started${reply ? '' : "; confirmed from the telescope's stacking notifications (fw 1.5.3 often does not acknowledge this command)"}`;
  }

  /**
   * Send a stack start and wait for whichever proves the outcome first: its reply, or the stacking
   * notifications (fw 1.5.3 often never replies — 2026-10-04 and 2026-10-12 — while the state
   * notification follows the command within 100 ms). An error reply is not final by itself: with
   * force the firmware reports the missing prerequisite (-11530 dark temperature mismatch,
   * 2026-10-12 04:34) and may stack anyway, and some codes are warnings it stacks through even
   * without force (-11526 overexposure: the counts keep rising, as the reference client
   * stevejcl/dwarf_python_api found on hardware). The notifications decide, for a short while.
   */
  private async startAndConfirm(camera: CameraName, cmd: number, params: Record<string, unknown>): Promise<{ reply: Record<string, unknown> | null; confirmed: boolean }> {
    const t = this.stackTiming;
    const t0 = Date.now();
    let settled = false;
    const reply = request(this.core, cmd, params, { timeout: t.replyMs, allowError: true, bestEffort: true });
    const confirmed = this.runningSince(camera, t0, t.replyMs + t.confirmMs, () => settled);
    try {
      const first = await Promise.race([reply.then((r) => ({ r })), confirmed.then((c) => ({ c }))]);
      if ('c' in first) {
        if (!first.c) return { reply: null, confirmed: false };
        // running: give a reply a moment to arrive, as it may carry a warning code
        const r = await Promise.race([reply.catch(() => null), sleep(REPLY_AFTER_RUNNING_MS).then(() => null)]);
        return { reply: r, confirmed: true };
      }
      const r = first.r;
      const code = Number(r?.code ?? 0);
      if (r && code >= 0) return { reply: r, confirmed: true };
      if (r && code < 0) {
        const ok = await Promise.race([confirmed, sleep(t.errorConfirmMs).then(() => false)]);
        return { reply: r, confirmed: ok };
      }
      // no reply at all: the notifications decide
      return { reply: null, confirmed: await confirmed };
    } finally {
      settled = true;
    }
  }

  /** Stacking reported as running by the telescope's own notifications since `since`. */
  private async runningSince(camera: CameraName, since: number, timeoutMs: number, cancelled: () => boolean): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !cancelled()) {
      const s = this.state.stacking[camera];
      if (s.state === 'running' && Math.max(s.updatedAt ?? 0, s.startedAt ?? 0) >= since) return true;
      await sleep(RUNNING_POLL_MS);
    }
    return false;
  }

  /** A normal stop finishes the final stack first; a fast stop discards it. The stacking state is the proof either way. */
  async stop(camera: CameraName, fast = false): Promise<void> {
    const cmd = fast ? STOP_CMD[camera].fast : STOP_CMD[camera].normal;
    this.stackControl[camera].stopRequestedAt = Date.now();
    await sendConfirmed(this.core, cmd, {}, `stop ${camera} stacking`, {
      timeout: STOP_REPLY_MS,
      confirmMs: STOP_CONFIRM_MS,
      confirmEarly: true,
      confirm: () => this.state.stacking[camera].state !== 'running',
    });
  }
}
