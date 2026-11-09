/**
 * The tele focuser: counted single steps, positions read back from the device state, and the
 * telescope's own autofocus.
 *
 * No continuous moves: over a slow link the position notifications arrive seconds late in bursts
 * and the stop lands late, so a continuous move overshot by hundreds of units and swung the focuser
 * end to end (2026-10-12 08:14 UTC: target ~550, went 572 → 238 → 702 → 440). Steps are counted, not
 * steered by a lagging readback: send the difference, let the notifications settle, read the
 * position, correct the remainder.
 */
import { logger } from '../../../log.js';
import type { Notification } from '../link.js';
import { Cmd, errorText } from '../protocol.js';
import { request, sendStop, type Core } from './core.js';
import type { Routines } from './follow.js';
import { FOCUS_MAX, sleep } from './util.js';

const log = logger('dwarf');

/** fw 1.5.3 command for the stored infinity focus position (not in the published protocol). */
const CMD_GET_INFINITY_FOCUS = 15011;
const INFINITY_READ_MS = 4000;
const INFINITY_READ_ATTEMPTS = 2;
const STATE_READ_MS = 8000;
const STOP_MS = 5000;
/** a single focusStep call moves at most this many steps */
const MAX_STEPS_PER_CALL = 200;
/** a move that ends further than this from its goal is logged */
const MISS_LOG_UNITS = 5;
/** a step count that differs from the expected by more than this (or 20 %) is reported */
const STEP_MISMATCH_UNITS = 3;
const STEP_MISMATCH_FRACTION = 0.2;
/** the first wait for notifications, and the poll while they keep coming */
const SETTLE_FIRST_MS = 400;
const SETTLE_POLL_MS = 200;
/** an astro AF that moved the focuser by no more than this did not focus */
const AF_UNMOVED_UNITS = 3;
/** autofocus aims at the centre of the 1920×1080 live view unless told otherwise */
const AF_CENTER = { x: 960, y: 540 };
/** AF state values (fw 1.5.3): 1 running, 3 done; 0 idle after running */
const AF_RUNNING = 1;
const AF_DONE = 3;
const AF_IDLE = 0;
/** How long after the routine ends its result code is still awaited. */
const AF_RESULT_GRACE_MS = 400;

export interface FocusTiming {
  /** one single step every `stepMs` */
  stepMs: number;
  /** a position is settled when its notifications are quiet for `quietMs` … */
  quietMs: number;
  /** … or after at most `settleMaxMs` */
  settleMaxMs: number;
  maxStepsPerPass: number;
  passes: number;
}

export class Focuser {
  readonly focusTiming: FocusTiming = { stepMs: 100, quietMs: 1200, settleMaxMs: 10000, maxStepsPerPass: 450, passes: 4 };
  /** Autofocus time limits (tests shorten them). */
  readonly autofocusTiming = { astroMs: 480_000, normalMs: 90_000 };
  private cachedInfinity: number | null = null;
  /**
   * The focuser move in progress. Moves run one after another: two at once (a UI button pressed
   * again, the agent stepping meanwhile) interleaved their steps, and each corrected against the
   * other's motion. An autofocus waits for a manual move to finish likewise.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly core: Core,
    private readonly routines: Routines,
  ) {}

  async infinityPosition(): Promise<number> {
    for (let i = 0; i < INFINITY_READ_ATTEMPTS; i++) {
      const r = await request(this.core, CMD_GET_INFINITY_FOCUS, {}, { bestEffort: true, timeout: INFINITY_READ_MS });
      if (r && typeof r.pos === 'number') return (this.cachedInfinity = r.pos);
    }
    if (this.cachedInfinity !== null) return this.cachedInfinity;
    throw new Error('the telescope did not report its stored infinity focus position (no reply to 15011); try again');
  }

  /** Run `fn` once every focuser move queued before it has ended. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Drive the focuser to an absolute position (~1 unit per step; "far" raises it; travel 0–702). */
  async focusTo(target: number, tolerance = 0): Promise<number> {
    if (!Number.isFinite(target)) throw new Error('focus target must be a number');
    this.core.guards.assertFocusFree(`moving the focus to ${Math.round(target)}`);
    return this.serial(() => this.focusToNow(target, tolerance));
  }

  private async focusToNow(target: number, tolerance: number): Promise<number> {
    // checked again: a stack or an operation may have started while this move waited its turn
    this.core.guards.assertFocusFree(`moving the focus to ${Math.round(target)}`);
    const goal = Math.max(0, Math.min(FOCUS_MAX, Math.round(target)));
    const t = this.focusTiming;
    let pos = await this.settledPosition();
    for (let pass = 0; pass < t.passes && Math.abs(goal - pos) > tolerance; pass++) {
      const n = Math.min(Math.abs(goal - pos), t.maxStepsPerPass);
      await this.steps(goal > pos ? 'far' : 'near', n, `focus move to ${goal} from ${pos}`);
      pos = await this.settledPosition();
    }
    if (Math.abs(goal - pos) > Math.max(tolerance, MISS_LOG_UNITS)) log.warn(`focus move to ${goal} ended at ${pos}`);
    return pos;
  }

  async focusStep(direction: 'near' | 'far', steps: number): Promise<string> {
    if (!Number.isFinite(steps)) throw new Error('focus steps must be a number');
    this.core.guards.assertFocusFree('moving the focus');
    return this.serial(() => this.focusStepNow(direction, steps));
  }

  private async focusStepNow(direction: 'near' | 'far', steps: number): Promise<string> {
    this.core.guards.assertFocusFree('moving the focus');
    const n = Math.max(1, Math.min(MAX_STEPS_PER_CALL, Math.round(steps)));
    const before = await this.settledPosition();
    await this.steps(direction, n, `focus ${n} step(s) ${direction}`);
    const after = await this.settledPosition();
    const expect = direction === 'far' ? Math.min(FOCUS_MAX, before + n) : Math.max(0, before - n);
    const note = Math.abs(after - expect) > Math.max(STEP_MISMATCH_UNITS, n * STEP_MISMATCH_FRACTION) ? ` (expected about ${expect}: the focuser moved ${Math.abs(after - before)} of ${n})` : '';
    return `focus moved ${n} step(s) ${direction}: position ${before} → ${after}${note}`;
  }

  /** Counted, paced single steps ("far" raises the position). The firmware does not answer them. */
  private async steps(direction: 'near' | 'far', n: number, what: string): Promise<void> {
    const { link } = this.core;
    const dir = direction === 'near' ? 1 : 0;
    for (let i = 0; i < n; i++) {
      if (!link.usable) throw new Error(`${what} interrupted: the telescope link dropped (${i} of ${n} steps sent)`);
      await link.post(Cmd.FOCUS_MANUAL_SINGLE_STEP_FOCUS, { direction: dir });
      await sleep(this.focusTiming.stepMs);
    }
  }

  /** The focuser position once its (late, bursty) notifications have stopped, read from the device state. */
  async settledPosition(): Promise<number> {
    const { link, store } = this.core;
    const t = this.focusTiming;
    const end = Date.now() + t.settleMaxMs;
    let last = Date.now();
    const onNotify = (n: Notification) => {
      if (n.name === 'focusPosition') last = Date.now();
    };
    link.on('notification', onNotify);
    try {
      await sleep(Math.min(SETTLE_FIRST_MS, t.quietMs));
      while (Date.now() - last < t.quietMs && Date.now() < end) await sleep(Math.min(SETTLE_POLL_MS, t.quietMs / 2));
    } finally {
      link.off('notification', onNotify);
    }
    const s = (await request(this.core, Cmd.TASK_GET_DEVICE_STATE_INFO, {}, { timeout: STATE_READ_MS })) as Record<string, any>;
    const fp = s?.focusMotorStateInfo?.focusPosition;
    // proto3 omits 0: a focusPosition entry without pos is position 0. A reply without the entry says
    // nothing: the last known position stands, and with none there is nothing to count steps from.
    const p = fp ? Number(fp.pos ?? 0) : store.state.focusPosition;
    if (p === undefined || !Number.isFinite(p)) throw new Error('the telescope did not report the focuser position (no focusMotorStateInfo in its state); nothing more was moved');
    store.state.focusPosition = p;
    store.changed();
    return p;
  }

  /**
   * Autofocus. Done = the telescope's AF state reporting the end (fw 1.5.3 does not always answer
   * the start); the focuser position is read back before and after, since the position
   * notifications lag and arrive in bursts. fw 1.5.3, 2026-10-12: every astro AF ended after ~24 s
   * in state "stopped" without moving the focuser; that was once taken for a focused scope. It is a
   * failure. An AF that never reports its end is stopped and reported as unverified.
   */
  async autofocus(kind: 'normal' | 'astro', x = AF_CENTER.x, y = AF_CENTER.y): Promise<string> {
    return this.core.guards.exclusive('autofocus', () => this.serial(() => this.autofocusNow(kind, x, y)));
  }

  private async autofocusNow(kind: 'normal' | 'astro', x: number, y: number): Promise<string> {
    const { store, guards } = this.core;
    const astro = kind === 'astro';
    // either kind drives the tele focuser
    if (guards.stackOwnsCamera('tele')) throw new Error('refused: the tele camera is live stacking; an autofocus now would blur every following sub. Stop the stack first.');
    // the autofocus shoots with the tele camera
    guards.assertCameraFree('tele', 'an autofocus');
    const limitMs = astro ? this.autofocusTiming.astroMs : this.autofocusTiming.normalMs;
    const names = new Set(astro ? ['astroAutoFocusState', 'astroAutoFocusFastState'] : ['autoFocusState']);
    const position = () => this.settledPosition().catch(() => store.state.focusPosition);
    const before = await position();
    let ran = false;
    let timedOut = false;
    let secs = 0;
    const cmd = astro ? Cmd.FOCUS_START_ASTRO_AUTO_FOCUS : Cmd.FOCUS_AUTO_FOCUS;
    // the reply with the result code lands just after the state that ends the routine (2026-11-09: 110 ms)
    let code = 0;
    const onResult = (r: { cmd: number; data: Record<string, any> }) => {
      if (r.cmd === cmd) code = Number(r.data?.code ?? 0);
    };
    this.core.link.on('reply', onResult);
    try {
      await this.followAutofocus(kind, cmd, astro, limitMs, names, (v) => (ran = v), () => ran, () => (timedOut = true), (s) => (secs = s), x, y);
      if (!timedOut) await sleep(AF_RESULT_GRACE_MS);
    } finally {
      this.core.link.off('reply', onResult);
    }
    if (timedOut) {
      if (astro) await sendStop(this.core, Cmd.FOCUS_STOP_ASTRO_AUTO_FOCUS, STOP_MS);
      const now = await position();
      throw new Error(
        `autofocus (${kind}) did not report its end within ${Math.round(limitMs / 60000)} min${ran ? ' (it did start)' : ' (no sign that it started)'}${astro ? '; it was stopped' : ''}. Focus position ${before ?? '?'} before, ${now ?? '?'} now: the focus is not verified. Measure it (star_sharpness) before relying on it.`,
      );
    }
    const after = await position();
    if (astro && before !== undefined && after !== undefined && Math.abs(after - before) <= AF_UNMOVED_UNITS) {
      throw new Error(
        `astro autofocus FAILED: it ended after ${secs} s WITHOUT MOVING THE FOCUSER (position ${before} before, ${after} after). The telescope gave up; the focus is unchanged and not verified. Measure it (star_sharpness); if the stars are soft or ring-shaped, run star_focus (a sweep with measured positions). Common causes: no or too few stars in the tele view (cloud, wrong exposure), or the stars too far out of focus to detect — start from focus_position action=infinity.`,
      );
    }
    const warned = code < 0 ? ` — WARNING: the telescope reported ${errorText(code)}, so this position is not verified. Measure it (star_sharpness) or run star_focus before relying on it.` : '';
    return `autofocus (${kind}) finished in ${secs} s: focus position ${before ?? '?'} → ${after ?? '?'}${warned}`;
  }

  private followAutofocus(
    kind: 'normal' | 'astro',
    cmd: number,
    astro: boolean,
    limitMs: number,
    names: Set<string>,
    setRan: (v: boolean) => void,
    getRan: () => boolean,
    onTimeout: () => void,
    setSecs: (s: number) => void,
    x: number,
    y: number,
  ): Promise<string> {
    return this.routines.follow({
      what: `autofocus (${kind})`,
      cmd,
      params: astro ? { mode: 0 } : { mode: 0, centerX: Math.round(x), centerY: Math.round(y) },
      totalMs: limitMs,
      stopCmds: astro ? [Cmd.FOCUS_STOP_ASTRO_AUTO_FOCUS] : [],
      activity: new Set([...names, 'focusPosition']),
      onReply: () => {},
      onNotify: (n, c) => {
        if (!names.has(n.name)) return;
        const st = Number(n.data.state ?? 0);
        if (st === AF_RUNNING) setRan(true);
        // an end state after our start ends it, also when the running state was not seen
        else if (st === AF_DONE || (getRan() && st === AF_IDLE)) c.finish(null);
      },
      atDeadline: () => {
        onTimeout();
        return null;
      },
      done: (s) => {
        setSecs(s);
        return String(s);
      },
    });
  }
}
