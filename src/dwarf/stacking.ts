import { OPERATION_STATE } from './protocol.js';
import { errMsg, logger } from '../log.js';
import { SafeEmitter } from '../util/events.js';
import { median } from '../util/stats.js';

const log = logger('stacking');

/**
 * Live-stacking state, per camera, built from the firmware's stacking notifications.
 *
 * Firmware facts this relies on (DWARF 3 fw 1.5.3, from data/telescope-wire.log, 2026-10-12):
 * - A WIDE stack is reported on the tele notification ids: 15208 teleStackingState (no camera
 *   field at all) and 15209 teleStackingProgress with cameraType 1. 15236/15237 are never sent.
 *   cameraType 0 (tele) is omitted from the message, as proto3 omits zeros.
 * - Progress comes as two messages per frame: one with currentCount (frame taken), then about a
 *   second later one with updateType 1 and stackedCount (the frame's stacking result). A frame
 *   the firmware rejects advances currentCount and leaves stackedCount where it was.
 * - Every TASK_GET_DEVICE_STATE_INFO (the controller polls it) makes the firmware repeat the last
 *   two progress messages. Counting messages counts those twice: only count increases.
 * - The first message of a stack has updateType 2 and no counts (reference frame being taken).
 * - Progress can straggle in for a few seconds after a stop.
 */

export type CameraName = 'tele' | 'wide';
export const CAMERAS: readonly CameraName[] = ['tele', 'wide'];

export type StackVerdict =
  /** fewer than MIN_FRAMES frames taken: too early to judge */
  | 'starting'
  /** at least half the recent frames stacked */
  | 'ok'
  /** some recent frames rejected (between REJECTING_BELOW and OK_FROM) */
  | 'degraded'
  /** almost every recent frame rejected: the stack is collecting nothing */
  | 'rejecting'
  /** running, but no frame taken for far longer than the frame interval */
  | 'stalled';

export interface StackHealth {
  verdict: StackVerdict;
  /** frames judged in the recent window, and how many of them stacked */
  windowTaken: number;
  windowStacked: number;
  /** median seconds between frames taken (the effective sub length) */
  frameIntervalS?: number;
  /** when the current verdict began */
  since: number;
  /** when the last new frame was taken */
  lastFrameAt?: number;
}

export interface StackingInfo {
  state: string;
  target?: string;
  totalCount?: number;
  currentCount?: number;
  stackedCount?: number;
  shootingTimeS?: number;
  stackedTimeS?: number;
  expIndex?: number;
  gainIndex?: number;
  updatedAt?: number;
  startedAt?: number;
  stoppedAt?: number;
  health?: StackHealth;
}

/** below this many frames nothing is judged (the first frames include the reference frame) */
export const MIN_FRAMES = 10;
/** the window of recent frames the verdict is computed over */
export const WINDOW_FRAMES = 20;
/** stacked fraction below which the stack is "rejecting" */
export const REJECTING_BELOW = 0.2;
/** stacked fraction from which a stack is "ok" again */
export const OK_FROM = 0.5;
/** the frame interval is taken as known from this many measured intervals */
const MIN_INTERVALS = 3;
/** frame marks kept per camera: a few windows' worth */
const MARKS_KEPT = WINDOW_FRAMES * 3;
/** progress this soon after a stop is a straggler of the stopped stack */
const STRAGGLER_MS = 15_000;
/** a start sent this recently makes its camera the owner of stack notifications */
export const START_CLAIM_MS = 120_000;
/** stalled: no frame for max(STALL_INTERVALS × interval, STALL_MIN_MS) once the frame interval is known */
const STALL_INTERVALS = 5;
const STALL_MIN_MS = 120_000;
/**
 * Before the interval is known: no frame for 3 × the sub exposure + 60 s (or 150 s when the
 * exposure is unknown). 2026-10-12 05:21: a wide stack that ran 3 min without taking one frame.
 */
const STALL_BEFORE_SUBS = 3;
const STALL_BEFORE_SLACK_MS = 60_000;
const STALL_BEFORE_MIN_MS = 90_000;
const STALL_BEFORE_UNKNOWN_MS = 150_000;
const stallBeforeIntervalMs = (exposureS?: number) =>
  exposureS ? Math.max(STALL_BEFORE_SUBS * exposureS * 1000 + STALL_BEFORE_SLACK_MS, STALL_BEFORE_MIN_MS) : STALL_BEFORE_UNKNOWN_MS;

const opState = (n: unknown) => OPERATION_STATE[Number(n ?? 0)] ?? `state_${String(n)}`;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A stacking progress notification, as far as it is read (every field may be missing: proto3 omits zeros). */
interface Progress {
  cameraType?: number;
  currentCount?: number;
  stackedCount?: number;
  totalCount?: number;
  targetName?: string;
  shootingTime?: number;
  stackedTime?: number;
  expIndex?: number;
  gainIndex?: number;
}

function readProgress(d: Record<string, unknown>): Progress {
  return {
    cameraType: num(d.cameraType),
    currentCount: num(d.currentCount),
    stackedCount: num(d.stackedCount),
    totalCount: num(d.totalCount),
    targetName: str(d.targetName),
    shootingTime: num(d.shootingTime),
    stackedTime: num(d.stackedTime),
    expIndex: num(d.expIndex),
    gainIndex: num(d.gainIndex),
  };
}
const isActive = (s: string) => s === 'running';

interface Frames {
  /** (taken, stacked) at each increase of taken: frame k's result is known once frame k+1 is taken */
  marks: Array<{ taken: number; stacked: number; t: number }>;
  lastTaken: number;
  lastStacked: number;
}

/**
 * Events:
 * - 'progress' (cam, info): a new frame was taken or stacked (duplicates do not emit)
 * - 'health' (cam, health, previous): the verdict changed
 * - 'state' (cam, info): the run state changed (running / stopping / stopped / idle)
 */
export class StackTracker extends SafeEmitter {
  readonly info: Record<CameraName, StackingInfo> = { tele: { state: 'idle' }, wide: { state: 'idle' } };
  /** camera of the stack last started or reporting (state notifications carry no camera) */
  private owner: CameraName = 'tele';
  private startSentAt: Record<CameraName, number> = { tele: 0, wide: 0 };
  private frames: Record<CameraName, Frames> = { tele: emptyFrames(), wide: emptyFrames() };

  constructor(
    private readonly now: () => number = Date.now,
    /** the sub exposure the camera is set to, if known (used before the frame interval is measured) */
    private readonly exposureS: (cam: CameraName) => number | undefined = () => undefined,
  ) {
    super();
  }

  /** A start command is about to be sent for this camera. */
  startSent(cam: CameraName): void {
    this.owner = cam;
    this.startSentAt[cam] = this.now();
  }

  /** The start failed (refused or never confirmed): the camera's settings are free again. */
  startFailed(cam: CameraName): void {
    this.startSentAt[cam] = 0;
  }

  /** A stack is starting or running on this camera: its exposure and gain belong to the stack. */
  owns(cam: CameraName, o: { startGraceOnly?: boolean } = {}): boolean {
    const claimed = this.now() - this.startSentAt[cam] < START_CLAIM_MS;
    return o.startGraceOnly ? claimed : isActive(this.info[cam].state) || claimed;
  }

  running(): CameraName | null {
    return CAMERAS.find((c) => isActive(this.info[c].state)) ?? null;
  }

  /** Feed a notification; returns true if it was a stacking notification. */
  onNotification(name: string, d: Record<string, unknown>, ts: number): boolean {
    switch (name) {
      case 'teleStackingState':
      case 'wideStackingState':
        this.onState(name === 'wideStackingState' ? 'wide' : this.owner, opState(d.state), ts);
        return true;
      case 'teleStackingProgress':
      case 'wideStackingProgress':
        {
          const p = readProgress(d);
          this.onProgress(name === 'wideStackingProgress' || p.cameraType === 1 ? 'wide' : 'tele', p, ts);
        }
        return true;
      default:
        return false;
    }
  }

  /** Re-evaluate time-based verdicts (stalled); call periodically. */
  tick(): void {
    for (const cam of CAMERAS) if (isActive(this.info[cam].state)) this.judge(cam);
  }

  /** The start was acknowledged: running from now unless a notification said so already. */
  confirmRunning(cam: CameraName, ts = this.now()): void {
    if (!isActive(this.info[cam].state)) this.onState(cam, 'running', ts);
  }

  /** The telescope reported no stack running (a state read): end what we think is running. */
  markIdle(cam: CameraName, ts = this.now()): void {
    if (this.info[cam].state !== 'idle' && this.info[cam].state !== 'stopped') this.onState(cam, 'idle', ts);
  }

  private onState(cam: CameraName, state: string, ts: number): void {
    const prev = this.info[cam];
    if (prev.state === state) return;
    const starting = isActive(state) && !isActive(prev.state);
    if (starting) this.resetFrames(cam);
    // the run this start claim led to has ended: the camera is free now, not START_CLAIM_MS after the start
    // ("stopping" keeps it: the firmware is still finishing the final stack)
    if (prev.state !== 'idle' && (state === 'stopped' || state === 'idle') && this.startSentAt[cam] <= (prev.startedAt ?? 0)) this.startSentAt[cam] = 0;
    this.info[cam] = {
      // a new stack learns its target from its own progress, not the last stack's
      // (2026-10-13 06:07: the M 45 stack reported "M 31" until its first frame)
      ...(starting ? {} : prev),
      state,
      startedAt: starting ? ts : prev.startedAt,
      stoppedAt: state === 'stopped' || state === 'idle' ? ts : undefined,
      health: starting ? { verdict: 'starting', windowTaken: 0, windowStacked: 0, since: ts } : prev.health,
    };
    this.tell('state', cam, this.info[cam]);
  }

  private onProgress(cam: CameraName, d: Progress, ts: number): void {
    if (cam !== this.owner) {
      // This stack's state notifications went to the other camera's entry: hand them over.
      const other = this.info[this.owner];
      if (isActive(other.state) && !other.currentCount) {
        this.info[this.owner] = { state: 'idle' };
        this.tell('state', this.owner, this.info[this.owner]);
      }
      this.owner = cam;
    }
    const prev = this.info[cam];
    if (!isActive(prev.state)) {
      // (a start sent after the stop makes this the new stack's progress, not a straggler)
      if (prev.stoppedAt && ts - prev.stoppedAt < STRAGGLER_MS && !(this.startSentAt[cam] > prev.stoppedAt)) return;
      // still stopping: the stopped stack's final progress (2026-10-13 02:29: judged as a new stack, "0 stacked of 83")
      if (prev.state === 'stopping' && !(this.startSentAt[cam] > (prev.startedAt ?? 0))) return;
      this.onState(cam, 'running', ts);
    }
    if (d.currentCount !== undefined && d.currentCount > this.frames[cam].lastTaken && d.currentCount > this.possibleFrames(cam, ts)) {
      // A repeat of an earlier stack's last progress (the firmware repeats it on a state read).
      // 2026-10-13 00:58: 13 s into a 60 s stack, {currentCount:18, expIndex:75} → judged "rejecting".
      log.debug(`${cam}: ignored progress ${d.currentCount} frames: more than the stack can have taken yet`);
      return;
    }
    if (d.currentCount !== undefined && d.currentCount < this.frames[cam].lastTaken - 1) {
      // counts went back: a new stack began without a state notification reaching us
      this.resetFrames(cam);
      this.info[cam].startedAt = ts;
    }
    const cur = this.info[cam];
    const f = this.frames[cam];
    const taken = d.currentCount ?? f.lastTaken;
    // proto3 omits zeros: a missing stackedCount is "unchanged" (it is only ever missing as 0 at the start)
    const stacked = d.stackedCount ?? f.lastStacked;
    const newTaken = taken > f.lastTaken;
    const newStacked = stacked > f.lastStacked;
    if (newTaken) {
      f.marks.push({ taken, stacked: f.lastStacked, t: ts });
      if (f.marks.length > MARKS_KEPT) f.marks.splice(0, f.marks.length - MARKS_KEPT);
    }
    f.lastTaken = Math.max(f.lastTaken, taken);
    f.lastStacked = Math.max(f.lastStacked, stacked);
    this.info[cam] = {
      ...cur,
      target: d.targetName ?? cur.target,
      totalCount: d.totalCount ?? cur.totalCount,
      currentCount: f.lastTaken || cur.currentCount,
      stackedCount: f.lastStacked || cur.stackedCount,
      shootingTimeS: d.shootingTime ?? cur.shootingTimeS,
      stackedTimeS: d.stackedTime ?? cur.stackedTimeS,
      expIndex: d.expIndex ?? cur.expIndex,
      gainIndex: d.gainIndex ?? cur.gainIndex,
      updatedAt: ts,
    };
    if (newTaken || newStacked) {
      this.judge(cam);
      this.tell('progress', cam, this.info[cam]);
    }
  }

  /** Emit without letting a listener's error stop the tracker mid-update. */
  private tell(event: 'state' | 'progress' | 'health', ...args: unknown[]): void {
    for (const fn of this.rawListeners(event) as Array<(...a: unknown[]) => void>) {
      try {
        fn.apply(this, args);
      } catch (err) {
        log.error(`a stack ${event} listener failed: ${errMsg(err)}`);
      }
    }
  }

  /** The most frames a stack we started can have taken by ts (unbounded when the start or the exposure is unknown). */
  private possibleFrames(cam: CameraName, ts: number): number {
    const sent = this.startSentAt[cam];
    const exposureS = this.exposureS(cam);
    if (!sent || !exposureS || ts < sent) return Infinity;
    return Math.floor((ts - sent) / (exposureS * 1000)) + 2;
  }

  private resetFrames(cam: CameraName): void {
    this.frames[cam] = emptyFrames();
    const i = this.info[cam];
    this.info[cam] = { state: i.state, startedAt: i.startedAt };
  }

  private judge(cam: CameraName): void {
    const info = this.info[cam];
    const f = this.frames[cam];
    const now = this.now();
    const marks = f.marks;
    const last = marks[marks.length - 1];
    const intervals: number[] = [];
    for (let i = Math.max(1, marks.length - WINDOW_FRAMES); i < marks.length; i++) {
      const dn = marks[i].taken - marks[i - 1].taken;
      if (dn > 0) intervals.push((marks[i].t - marks[i - 1].t) / dn);
    }
    const intervalMs = intervals.length >= MIN_INTERVALS ? median(intervals) : undefined;

    // Frames whose result is known: every frame before the latest one taken.
    const judged = f.lastTaken - 1;
    let verdict: StackVerdict;
    let windowTaken = 0;
    let windowStacked = 0;
    if (judged >= MIN_FRAMES) {
      // the mark at or just before (latest - WINDOW) frames
      const from = Math.max(0, f.lastTaken - WINDOW_FRAMES - 1);
      const base = [...marks].reverse().find((m) => m.taken <= from + 1) ?? marks[0];
      windowTaken = Math.max(1, judged - (base.taken - 1));
      windowStacked = Math.max(0, f.lastStacked - base.stacked);
      windowStacked = Math.min(windowStacked, windowTaken);
      const ratio = windowStacked / windowTaken;
      const was = info.health?.verdict;
      if (ratio < REJECTING_BELOW) verdict = 'rejecting';
      else if (ratio >= OK_FROM) verdict = 'ok';
      else verdict = was === 'rejecting' ? 'rejecting' : 'degraded';
    } else {
      verdict = 'starting';
    }
    const lastFrameAt = last?.t ?? info.startedAt;
    const stallMs = intervalMs ? Math.max(STALL_INTERVALS * intervalMs, STALL_MIN_MS) : stallBeforeIntervalMs(this.exposureS(cam));
    if (isActive(info.state) && lastFrameAt && now - lastFrameAt > stallMs) verdict = 'stalled';

    const prev = info.health;
    const health: StackHealth = {
      verdict,
      windowTaken,
      windowStacked,
      frameIntervalS: intervalMs ? Math.round(intervalMs / 100) / 10 : undefined,
      since: prev && prev.verdict === verdict ? prev.since : now,
      lastFrameAt,
    };
    info.health = health;
    if (!prev || prev.verdict !== verdict) this.tell('health', cam, health, prev);
  }
}

function emptyFrames(): Frames {
  return { marks: [], lastTaken: 0, lastStacked: 0 };
}

