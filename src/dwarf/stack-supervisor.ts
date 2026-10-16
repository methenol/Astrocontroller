import { logger, errMsg } from '../log.js';
import { CAMERAS, type StackTracker, type StackHealth, type CameraName, type StackingInfo } from './stacking.js';
import { inWords } from '../util/time.js';

const log = logger('stack-supervisor');

const CHECK_EVERY_MS = 15_000;
/** A failed automatic stop is tried again after this long. */
const STOP_RETRY_MS = 60_000;
/** Actions kept for status reports. */
const ACTIONS_KEPT = 50;
/** frames this close together are not deep-sky subs: the exposure is wrong */
const FAST_FRAME_S = 2;

/**
 * Acts on a live stack that collects nothing.
 *
 * 2026-10-12: a wide stack rejected every frame from 01:04 local and kept "running"; an alarm went
 * to the agent, which did nothing about it, and the night was lost. Telling the agent is not
 * enough. The supervisor:
 * 1. tells the agent at once when a stack turns `rejecting` (almost every recent frame rejected)
 *    or `stalled` (no frame for far longer than the frame interval), with when it will act;
 * 2. if the stack is still bad after `autoStopAfterMs`, stops it itself (the frames stacked so far
 *    are kept, as with any stop) and tells the agent the stack is stopped and must be restarted
 *    once the cause is fixed;
 * 3. tells the agent when frames stack again before that.
 */

export interface SupervisedDevice {
  readonly stacks: StackTracker;
  stopStacking(cam: CameraName): Promise<void>;
  /** the controller may send commands now (link usable, no long operation running) */
  canAct(): boolean;
}

export interface StackSupervisorOptions {
  /** stop a stack that has been rejecting or stalled this long (0 = never stop, only notify) */
  autoStopAfterMs: number;
  checkEveryMs?: number;
  now?: () => number;
  clock?: (t: number) => string;
}

interface Alarm {
  verdict: 'rejecting' | 'stalled';
  since: number;
  /** stack identity: its start time */
  startedAt?: number;
  stopping?: boolean;
  stopFailedAt?: number;
}

export interface SupervisorAction {
  at: number;
  camera: CameraName;
  action: 'alarm' | 'recovered' | 'stopped' | 'stop_failed';
  verdict?: string;
  detail: string;
}

export class StackSupervisor {
  private alarms: Partial<Record<CameraName, Alarm>> = {};
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly clock: (t: number) => string;
  /** the most recent actions, newest last (for status reports) */
  readonly actions: SupervisorAction[] = [];
  private ticking = false;
  private readonly onHealth = (cam: CameraName, h: StackHealth) => this.health(cam, h);

  constructor(
    private readonly device: SupervisedDevice,
    private readonly notify: (text: string) => void,
    private readonly opts: StackSupervisorOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.clock = opts.clock ?? ((t) => new Date(t).toISOString().slice(11, 16) + ' UTC');
  }

  start(): void {
    if (this.timer) return;
    this.device.stacks.on('health', this.onHealth);
    this.timer = setInterval(() => void this.tick().catch((e) => log.warn(`stack supervisor: ${errMsg(e)}`)), this.opts.checkEveryMs ?? CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    this.device.stacks.off('health', this.onHealth);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The alarm on a camera, if any (for status lines). */
  alarm(cam: CameraName): { verdict: string; since: number; stopAt?: number } | undefined {
    const a = this.alarms[cam];
    if (!a) return undefined;
    // an alarm belongs to one running stack (with the automatic stop off, no tick clears it)
    const info = this.device.stacks.info[cam];
    if (info.state !== 'running' || info.startedAt !== a.startedAt) return undefined;
    return { verdict: a.verdict, since: a.since, stopAt: this.opts.autoStopAfterMs > 0 ? a.since + this.opts.autoStopAfterMs : undefined };
  }

  private record(a: Omit<SupervisorAction, 'at'>): void {
    this.actions.push({ at: this.now(), ...a });
    if (this.actions.length > ACTIONS_KEPT) this.actions.splice(0, this.actions.length - ACTIONS_KEPT);
  }

  /** Tell the agent; a failing notifier never breaks supervision. */
  private tell(text: string): void {
    try {
      this.notify(text);
    } catch (e) {
      log.warn(`could not deliver a stack notice: ${errMsg(e)}`);
    }
  }

  private health(cam: CameraName, h: StackHealth): void {
    const info = this.device.stacks.info[cam];
    const a = this.alarms[cam];
    if (h.verdict === 'rejecting' || h.verdict === 'stalled') {
      if (a && a.startedAt === info.startedAt) {
        // rejecting ↔ stalled within one episode: keep the episode's start (the stop deadline)
        a.verdict = h.verdict;
        return;
      }
      const alarm: Alarm = { verdict: h.verdict, since: this.now(), startedAt: info.startedAt };
      this.alarms[cam] = alarm;
      const text = this.alarmText(cam, info, h, alarm);
      log.warn(text);
      this.record({ camera: cam, action: 'alarm', verdict: h.verdict, detail: text });
      this.tell(text);
      return;
    }
    // A stall ends when frames arrive again, even if not all stack ("degraded"): stopping a stack
    // that is collecting would be wrong. (A rejecting stack is held at "rejecting" until it is ok.)
    const recovered = h.verdict === 'ok' || (h.verdict === 'degraded' && a?.verdict === 'stalled');
    if (a && (recovered || h.verdict === 'starting')) {
      delete this.alarms[cam];
      if (recovered && a.startedAt === info.startedAt) {
        const text = `${cam} stack on ${info.target ?? 'the target'}: frames are stacking again (${h.windowStacked} of the last ${h.windowTaken} accepted; ${info.stackedCount ?? 0} stacked of ${info.currentCount ?? 0} taken in total). The automatic stop is called off.`;
        log.info(text);
        this.record({ camera: cam, action: 'recovered', verdict: h.verdict, detail: text });
        this.tell(text);
      }
    }
  }

  private alarmText(cam: CameraName, info: StackingInfo, h: StackHealth, a: Alarm): string {
    const stopAt = this.opts.autoStopAfterMs > 0 ? ` Astrocontroller STOPS this stack itself at ${this.clock(a.since + this.opts.autoStopAfterMs)} if it is still not collecting.` : '';
    const counts = `${info.stackedCount ?? 0} stacked of ${info.currentCount ?? 0} taken`;
    if (h.verdict === 'stalled') {
      const quiet = h.lastFrameAt ? Math.round((this.now() - h.lastFrameAt) / 60000) : '?';
      return `${cam} stack on ${info.target ?? 'the target'} is STALLED: no frame taken for ${quiet} min${h.frameIntervalS ? ` (it was taking one every ${h.frameIntervalS} s)` : ' since it started'} (${counts}). It is running in name only.${stopAt} Act now: stop it (live_stacking action=stop), check telescope_status (tracking, link) and the camera (view_camera), then GoTo the target again and restart the stack, or move on.`;
    }
    const fast = h.frameIntervalS !== undefined && h.frameIntervalS < FAST_FRAME_S;
    return `${cam} stack on ${info.target ?? 'the target'} is COLLECTING NOTHING: ${h.windowTaken - h.windowStacked} of the last ${h.windowTaken} frames were REJECTED by the scope (${counts}).${fast ? ` Frames arrive every ${h.frameIntervalS} s, far faster than a deep-sky sub: the exposure is not what the stack needs (get_camera_settings ${cam}).` : ''}${stopAt} Act now: stop it (live_stacking action=stop), find the cause — cloud or dew (sky_check, view_camera source=stack), exposure/gain (get_camera_settings ${cam}), lost tracking or the target drifting out (telescope_status, view_camera) — fix it, GoTo again and restart the stack, or move to another target or the other camera.`;
  }

  /** Check the deadlines; exported for tests (the timer calls it). */
  async tick(): Promise<void> {
    if (this.opts.autoStopAfterMs <= 0 || this.ticking) return;
    this.ticking = true;
    try {
      await this.checkDeadlines();
    } finally {
      this.ticking = false;
    }
  }

  private async checkDeadlines(): Promise<void> {
    for (const cam of CAMERAS) {
      const a = this.alarms[cam];
      if (!a || a.stopping) continue;
      const info = this.device.stacks.info[cam];
      if (info.state !== 'running' || info.startedAt !== a.startedAt) {
        // stopped or restarted by someone else: the episode is over
        delete this.alarms[cam];
        continue;
      }
      const now = this.now();
      if (now - a.since < this.opts.autoStopAfterMs) continue;
      if (a.stopFailedAt && now - a.stopFailedAt < STOP_RETRY_MS) continue;
      if (!this.device.canAct()) continue;
      a.stopping = true;
      const counts = `${info.stackedCount ?? 0} stacked of ${info.currentCount ?? 0} taken`;
      const mins = Math.round((now - a.since) / 60000);
      log.warn(`${cam} stack ${a.verdict} for ${mins} min: stopping it`);
      try {
        await this.device.stopStacking(cam);
        delete this.alarms[cam];
        const text = `Astrocontroller STOPPED the ${cam} stack on ${info.target ?? 'the target'}: it had been ${a.verdict === 'stalled' ? 'stalled (no frames)' : 'rejecting every frame'} for ${mins} min (${counts}). The frames stacked so far are saved as usual. Nothing is being collected now: find and fix the cause (sky_check, view_camera, get_camera_settings ${cam}, telescope_status), then GoTo and start the stack again, or image another target.`;
        this.record({ camera: cam, action: 'stopped', verdict: a.verdict, detail: text });
        this.tell(text);
      } catch (e) {
        a.stopping = false;
        a.stopFailedAt = now;
        const text = `Astrocontroller tried to stop the ${cam} stack on ${info.target ?? 'the target'} (${a.verdict} for ${mins} min, ${counts}) and the stop failed: ${errMsg(e)}. Stop it now (live_stacking action=stop fast_stop=true). It retries in ${inWords(STOP_RETRY_MS)}.`;
        log.error(text);
        this.record({ camera: cam, action: 'stop_failed', verdict: a.verdict, detail: text });
        this.tell(text);
      }
    }
  }
}
