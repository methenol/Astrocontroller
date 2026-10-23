/**
 * Following one telescope routine (calibration, GoTo, one-click GoTo, autofocus) from its start
 * command to its end. fw 1.5.3 answers these starts late, once per step, or never, so a routine is
 * judged by the telescope's notifications; the start command's reply only fails it when it is an
 * error. Every way a routine can stop being able to finish ends the wait at once: a stop request,
 * a power-off, the link dropping or no longer executing commands, or total silence (a hung astro
 * service). Before this, only a reply, tracking or the 7-10 min limit ended it (2026-10-12 21:18: a
 * stopped one-click GoTo, then a reboot, left the controller "busy GoTo" and refusing everything
 * while the telescope was idle).
 */
import { DwarfCommandError, type Notification } from '../link.js';
import { request, sendStop, type Core } from './core.js';

/** The astro service took a routine and reported nothing at all: hung (a reboot clears it). Nothing was moved. */
export class AstroServiceHungError extends Error {
  readonly astroHung = true;
}

/** Refused before anything was sent to the telescope: there is no pointing to recover. */
export class RefusedError extends Error {
  readonly refused = true;
}

/** Notifications that show the astro service is working on a routine. */
const ASTRO_NOTIFICATIONS: ReadonlySet<string> = new Set(['calibrationState', 'calibrationResult', 'gotoState', 'trackingState', 'oneClickGotoState']);

export interface RoutineCtx {
  readonly t0: number;
  /** end the routine: null = success */
  finish(err: Error | null): void;
  /** the routine's state ended: give its result `graceMs` to arrive, then `verdict` decides */
  ended(graceMs: number, verdict: () => Error | null): void;
}

export interface RoutineSpec {
  what: string;
  cmd: number;
  params: Record<string, unknown>;
  totalMs: number;
  /** sent when the routine is declared hung */
  stopCmds: number[];
  /** notifications that show the routine is under way (default: the astro routine states) */
  activity?: ReadonlySet<string>;
  onReply: (r: Record<string, any>, c: RoutineCtx) => void;
  onNotify: (n: Notification, c: RoutineCtx) => void;
  /** the overall time limit is reached: success (null) or the failure */
  atDeadline: (c: RoutineCtx) => Error | null;
  done: (seconds: number) => string;
}

/** Time limits of the astro routines (tests shorten them). */
export interface AstroTiming {
  calibrationMs: number;
  gotoMs: number;
  eqSolvingMs: number;
  /**
   * A working routine answers or reports its first stage within about a minute (2026-10-12: 0-42 s).
   * Nothing at all for this long is a hung astro service (2026-10-12 23:18 and 23:29 local: two
   * 10-min waits for GoTos that never started; astro_recover did not help, a reboot did).
   */
  silentMs: number;
  /** after the GoTo state ends, how long tracking may take to be reported */
  gotoEndGraceMs: number;
  /** after the calibration state ends, how long its result may take */
  calibrationEndGraceMs: number;
  /** the clock of the daylight refusal (tests set it to a night) */
  now: () => Date;
}

/** stops sent to a routine declared hung */
const HUNG_STOP_MS = 5000;

export const STOPPED_BY_REQUEST = 'stopped by request (stop_goto); the scope was left where it stopped';

export class Routines {
  readonly astroTiming: AstroTiming = {
    calibrationMs: 420_000,
    gotoMs: 600_000,
    eqSolvingMs: 600_000,
    silentMs: 180_000,
    gotoEndGraceMs: 10_000,
    calibrationEndGraceMs: 3_000,
    now: () => new Date(),
  };

  /** Waiting routines: ended early by stop_goto, a power-off or a dropped link. */
  private readonly waiters = new Set<(e: Error) => void>();

  constructor(private readonly core: Core) {}

  /** End every waiting routine with this error (stop_goto). */
  failAll(err: Error): void {
    for (const fail of [...this.waiters]) fail(err);
  }

  /** Call `fail` when the telescope powers off or the link drops; returns the unsubscribe. */
  abortable(fail: (e: Error) => void): () => void {
    const { link } = this.core;
    const onDrop = () => fail(new Error('connection closed during the operation (the telescope rebooted, powered off or the link dropped); it is not running any more'));
    const onNotify = (n: Notification) => {
      if (n.name === 'powerOff') onDrop();
    };
    this.waiters.add(fail);
    link.on('disconnected', onDrop);
    link.on('notification', onNotify);
    return () => {
      this.waiters.delete(fail);
      link.off('disconnected', onDrop);
      link.off('notification', onNotify);
    };
  }

  follow(o: RoutineSpec): Promise<string> {
    const { link } = this.core;
    const t0 = Date.now();
    const silentMs = this.astroTiming.silentMs;
    return new Promise<string>((resolve, reject) => {
      let finished = false;
      let heard = false;
      let endTimer: NodeJS.Timeout | null = null;
      const c: RoutineCtx = {
        t0,
        finish: (err) => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          clearTimeout(silent);
          if (endTimer) clearTimeout(endTimer);
          link.off('reply', onReply);
          link.off('notification', onNotify);
          link.off('unresponsive', onDead);
          offAbort();
          if (err) reject(err);
          else resolve(o.done(Math.round((Date.now() - t0) / 1000)));
        },
        ended: (graceMs, verdict) => {
          if (!endTimer && !finished) endTimer = setTimeout(() => c.finish(verdict()), graceMs);
        },
      };
      const onReply = (r: { cmd: number; data: Record<string, any> }) => {
        if (r.cmd !== o.cmd || finished) return;
        heard = true;
        const code = Number(r.data.code ?? 0);
        if (code < 0) return c.finish(new DwarfCommandError(o.cmd, code, r.data));
        o.onReply(r.data, c);
      };
      const onNotify = (n: Notification) => {
        if (finished) return;
        if ((o.activity ?? ASTRO_NOTIFICATIONS).has(n.name)) heard = true;
        o.onNotify(n, c);
      };
      const deadline = setTimeout(() => c.finish(o.atDeadline(c)), o.totalMs);
      const silent = setTimeout(() => {
        if (heard || finished) return;
        for (const cmd of o.stopCmds) void sendStop(this.core, cmd, HUNG_STOP_MS);
        c.finish(
          new AstroServiceHungError(
            `${o.what}: the telescope reported nothing at all for ${Math.round(silentMs / 60000)} min (no reply, no stage), so its astro service is hung. No recovery moves were made. If astro_recover already ran, power-cycle it now (power action=reboot), then motors_home, sync_time_and_location and try again`,
          ),
        );
      }, silentMs);
      // a hung telescope never ends the routine: fail now with the reason, not after 7-10 min
      const onDead = (e: Error) => c.finish(e);
      const offAbort = this.abortable((e) => c.finish(e));
      link.on('reply', onReply);
      link.on('notification', onNotify);
      link.on('unresponsive', onDead);
      // replies arrive through onReply (one-click replies once per step); this catches the link failing
      request(this.core, o.cmd, o.params, { timeout: o.totalMs, bestEffort: true, allowError: true }).catch((e) => c.finish(e));
    });
  }
}
