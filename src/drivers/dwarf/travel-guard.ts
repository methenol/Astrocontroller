import { logger, errMsg } from '../../log.js';
import { config } from '../../config.js';
import { Dwarf, round } from './device.js';
import { findObject } from '../../astro/catalog.js';
import * as sky from '../../astro/sky.js';
import { inWords } from '../../util/time.js';

const log = logger('travel');

/**
 * Rotation-travel guard for a running stack (tele or wide).
 *
 * The rotation axis only travels 0–315°. Tracking a target whose azimuth swings into the
 * remaining 45° makes the firmware stop the stack by itself at the end of travel, try its own
 * re-GoTo (which fails: the target is out of reach), and leave the astro service stuck
 * (-11501 ASTRO_FUNCTION_BUSY on every GoTo) until a power cycle. Seen 2026-10-11 00:13 local
 * on M 31: rotation 14.3° → 0.37° in 35 min, then the firmware's limit stop.
 *
 * The guard forecasts when tracking reaches the end of travel and stops the stack itself, a few
 * minutes early, which is an ordinary requested stop. Alt-Az: the forecast follows the target's
 * azimuth (rotation ≈ azimuth + a fixed offset set by how the base stands, learned live from the
 * tracking samples, 2026-10-11: −29.5°), so it also says when the target is reachable again. EQ, or
 * a target not in the catalog: a straight-line fit of the measured rotation rate.
 */

export interface TravelForecast {
  target?: string;
  rotationDeg: number;
  ratePerMin: number;
  /** the end of travel tracking is heading for */
  limitDeg: number;
  minutesToLimit: number | null;
  limitAt?: number;
  /** when the target's azimuth is back inside the rotation travel (Alt-Az forecast only) */
  reachableAgainAt?: number;
  method: 'azimuth' | 'rate';
  azOffsetDeg?: number;
  stage: 'ok' | 'notified' | 'stopping' | 'stopped' | 'stop_failed';
  updatedAt: number;
}

/** stop this many minutes before the forecast end of travel (and never closer than STOP_DEG) */
const STOP_MIN = 3;
const STOP_DEG = 2;
/** tell the agent this far ahead, so it can plan the next target */
const NOTICE_MIN = 45;
/** keep a margin inside the stops when saying "reachable again" */
const REACH_MARGIN_DEG = 5;

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const norm360 = (d: number) => ((d % 360) + 360) % 360;
/** One of the samples (the upper middle), never a mean: the values are angles, and a mean of two across ±180° would be the opposite direction. */
const middleSample = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** What the guard needs of the telescope (the Dwarf; a stand-in in tests). */
export type TravelDevice = Pick<Dwarf, 'state' | 'link' | 'operation' | 'readMotorPositions' | 'location' | 'publishState' | 'stopStacking'>;

export interface TravelGuardOptions {
  now?: () => number;
  /** catalog position of a stack's target (default: the object catalog) */
  lookup?: (name: string) => { raHours: number; decDeg: number } | null | undefined;
  checkEveryMs?: number;
}

/** after a failed stop, try again this much later */
const RETRY_STOP_MS = 60_000;
const CHECK_EVERY_MS = 15_000;
/** The motors are read this often during a stack, and at the faster rate within NEAR_LIMIT_MIN of the end. */
const MOTOR_POLL_MS = 60_000;
const MOTOR_POLL_NEAR_MS = 15_000;
const NEAR_LIMIT_MIN = 12;
/** Samples older than this are dropped from the fit. */
const SAMPLE_WINDOW_MS = 15 * 60_000;
/** The rate fit needs this many samples spread over this long. */
const RATE_MIN_SAMPLES = 3;
const RATE_MIN_SPAN_MS = 120_000;
/** Below this rate (°/min) the rotation counts as not moving. */
const RATE_STILL = 0.005;
/** Near the stop, a rotation faster than this (°/min) toward it is heading into it. */
const RATE_MOVING = 0.01;
/** The azimuth forecast looks this far ahead, in steps of FORECAST_STEP_MS. */
const FORECAST_HORIZON_MS = 8 * 3_600_000;
const FORECAST_STEP_MS = 60_000;

export class TravelGuard {
  private timer: NodeJS.Timeout | null = null;
  private stopFailedAt = 0;
  private readonly now: () => number;
  private readonly lookup: NonNullable<TravelGuardOptions['lookup']>;
  private samples: Array<{ t: number; rot: number; az?: number }> = [];
  /** the stack the samples belong to (its start time) */
  private stackKey = 0;
  private stage: TravelForecast['stage'] = 'ok';
  private ticking = false;

  constructor(
    private readonly dwarf: TravelDevice,
    private readonly notify: (text: string) => void,
    private readonly opts: TravelGuardOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.lookup = opts.lookup ?? findObject;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tick()
        .catch((e) => log.warn(`travel guard: ${errMsg(e)}`))
        .finally(() => (this.ticking = false));
    }, this.opts.checkEveryMs ?? CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tell the agent; a failing notifier never changes what the guard did. */
  private tell(text: string): void {
    try {
      this.notify(text);
    } catch (e) {
      log.warn(`could not deliver a travel notice: ${errMsg(e)}`);
    }
  }

  private clock(t: number): string {
    return new Date(t).toLocaleTimeString('en-GB', { timeZone: config.observer.timezone, hour: '2-digit', minute: '2-digit' });
  }

  private reset(): void {
    this.samples = [];
    this.stage = 'ok';
    this.stopFailedAt = 0;
    if (this.dwarf.state.travel) this.dwarf.publishState({ travel: undefined });
  }

  /** One check (the timer calls it; tests call it directly). */
  async tick(): Promise<void> {
    const d = this.dwarf;
    // the rotation axis carries both cameras: every running stack is stopped; the forecast follows
    // the tele stack's target when both run (the wide one is usually on the same field)
    const running = (['tele', 'wide'] as const).filter((c) => d.state.stacking[c].state === 'running');
    const cam: 'tele' | 'wide' = running[0] ?? 'tele';
    const st = d.state.stacking[cam];
    if (!running.length) {
      // keep a 'stopped' forecast on show until the next stack; anything else is over
      if (this.stage !== 'stopped') this.reset();
      return;
    }
    // a new stack starts the samples over; one of two stacks ending (a partly failed stop) does not
    const key = Math.max(...running.map((c) => d.state.stacking[c].startedAt ?? 0));
    const cams = running.join(' and ');
    if (key > this.stackKey) {
      this.stackKey = key;
      this.reset();
    }
    if (!d.link.usable || d.operation || this.stage === 'stopping') return;

    // The motor timer reads once a minute during a stack; read more often close to the end.
    const last = d.state.travel;
    const pollMs = last?.minutesToLimit != null && last.minutesToLimit < NEAR_LIMIT_MIN ? MOTOR_POLL_NEAR_MS : MOTOR_POLL_MS;
    if (this.now() - (d.state.motors.updatedAt ?? 0) >= pollMs) await d.readMotorPositions();
    const rot = d.state.motors.rotationDeg;
    const at = d.state.motors.updatedAt ?? this.now();
    if (rot === undefined) return;
    if (this.samples.length && this.samples[this.samples.length - 1].t === at) return;

    const site = d.location();
    const obj = st.target ? this.lookup(st.target) ?? undefined : undefined;
    const altaz = d.state.bodyMode !== 'eq' && !!site && !!obj;
    const az = altaz ? sky.altAz(site!, obj!.raHours, obj!.decDeg, new Date(at)).azimuth : undefined;
    this.samples.push({ t: at, rot, az });
    this.samples = this.samples.filter((s) => at - s.t <= SAMPLE_WINDOW_MS);

    const f = this.forecast(rot, at, altaz ? { site: site!, ra: obj!.raHours, dec: obj!.decDeg } : null);
    if (!f) return;
    f.target = st.target;
    f.stage = this.stage;
    d.publishState({ travel: f });

    const [lo] = Dwarf.ROTATION_RANGE;
    const distance = Math.abs(rot - f.limitDeg);
    const when = f.limitAt ? this.clock(f.limitAt) : '?';
    const again = f.reachableAgainAt ? ` ${st.target} is back inside the rotation travel from about ${this.clock(f.reachableAgainAt)}.` : '';

    if (this.stage === 'ok' && f.minutesToLimit !== null && f.minutesToLimit <= NOTICE_MIN) {
      this.stage = 'notified';
      this.tell(
        `rotation travel: the ${cams} stack on ${st.target ?? 'the target'} reaches the end of the rotation axis (${f.limitDeg}°) at about ${when} (rotation now ${rot}°, ${f.ratePerMin > 0 ? '+' : ''}${f.ratePerMin}°/min, forecast from ${f.method === 'azimuth' ? "the target's azimuth" : 'the measured rate'}). Astrocontroller will stop the stack itself about ${STOP_MIN} min before, which avoids the firmware's own limit stop (that left the astro service stuck until a power cycle on 2026-10-11).${again} Plan what to image next.`,
      );
    }

    const due = (f.minutesToLimit !== null && f.minutesToLimit <= STOP_MIN) || (distance <= STOP_DEG && Math.abs(f.ratePerMin) > RATE_MOVING && (f.limitDeg === lo ? f.ratePerMin < 0 : f.ratePerMin > 0));
    // a failed stop is tried again: the firmware's own limit stop is what this guard prevents
    const retry = this.stage === 'stop_failed' && this.now() - this.stopFailedAt >= RETRY_STOP_MS;
    if (due && (this.stage === 'ok' || this.stage === 'notified' || retry)) {
      this.stage = 'stopping';
      d.publishState({ travel: { ...f, stage: 'stopping' } });
      log.warn(`rotation ${rot}° is ${round(distance, 1)}° from the end of travel (${f.limitDeg}°): stopping the ${cams} stack before the firmware's limit stop`);
      const counts = running.map((c) => `${running.length > 1 ? `${c}: ` : ''}${d.state.stacking[c].stackedCount ?? '?'} stacked of ${d.state.stacking[c].currentCount ?? '?'} taken`).join('; ');
      try {
        // each one stopped even when another's stop fails; any failure is the retry's business
        const failed: string[] = [];
        for (const c of running) {
          await d.stopStacking(c).catch((e: unknown) => failed.push(`${c}: ${errMsg(e)}`));
        }
        if (failed.length) throw new Error(failed.join('; '));
        this.stage = 'stopped';
        d.publishState({ travel: { ...f, stage: 'stopped' } });
        this.tell(
          `rotation travel: Astrocontroller STOPPED the ${cams} stack on ${st.target ?? 'the target'} (${counts}) with rotation at ${rot}°, ${round(distance, 1)}° from the end of travel, before the firmware's own limit stop. The subs so far are saved as usual. ${st.target ?? 'The target'} is now outside what the rotation axis can reach, so a GoTo to it would be refused.${again} Now: GoTo another target and restart live_stacking${f.reachableAgainAt ? `, or GoTo ${st.target} again after ${this.clock(f.reachableAgainAt)}` : ''}. If a GoTo is refused with -11501, goto_target runs astro_recover by itself.`,
        );
      } catch (e) {
        this.stage = 'stop_failed';
        this.stopFailedAt = this.now();
        d.publishState({ travel: { ...f, stage: 'stop_failed' } });
        this.tell(
          `rotation travel: the ${cams} stack on ${st.target ?? 'the target'} is ${round(distance, 1)}° from the end of the rotation axis, and Astrocontroller's stop failed (${errMsg(e)}). Stop it now (live_stacking action=stop fast_stop=true); Astrocontroller tries again in ${inWords(RETRY_STOP_MS)}. If the firmware hits its limit and GoTo then fails with -11501, run astro_recover.`,
        );
      }
    }
  }

  private forecast(rot: number, now: number, target: { site: NonNullable<ReturnType<Dwarf['location']>>; ra: number; dec: number } | null): TravelForecast | null {
    const [lo, hi] = Dwarf.ROTATION_RANGE;
    const withAz = this.samples.filter((s) => s.az !== undefined);
    if (target && withAz.length >= 2) {
      // rotation = azimuth + offset (both increase together; verified 2026-10-11 against M 31)
      const offset = middleSample(withAz.map((s) => norm180(s.rot - s.az!)));
      const az0 = sky.altAz(target.site, target.ra, target.dec, new Date(now)).azimuth;
      const step = FORECAST_STEP_MS;
      let pred = rot;
      let prevAz = az0;
      let limitAt: number | undefined;
      // the end tracking is heading for (replaced by the one reached, when one is reached within the horizon)
      const az1 = sky.altAz(target.site, target.ra, target.dec, new Date(now + FORECAST_STEP_MS)).azimuth;
      let limitDeg: number = norm180(az1 - az0) < 0 ? lo : hi;
      let reachableAgainAt: number | undefined;
      for (let t = now + step; t <= now + FORECAST_HORIZON_MS; t += step) {
        const az = sky.altAz(target.site, target.ra, target.dec, new Date(t)).azimuth;
        pred += norm180(az - prevAz);
        prevAz = az;
        if (limitAt === undefined) {
          if (pred <= lo || pred >= hi) {
            limitAt = t;
            limitDeg = pred <= lo ? lo : hi;
          }
        } else {
          // A fresh GoTo picks the rotation angle for the azimuth again: back in reach when that lands inside the travel.
          const fresh = norm360(az + offset);
          if (fresh >= lo + REACH_MARGIN_DEG && fresh <= hi - REACH_MARGIN_DEG) {
            reachableAgainAt = t;
            break;
          }
        }
      }
      return {
        rotationDeg: rot,
        ratePerMin: round(norm180(az1 - az0), 3),
        limitDeg,
        minutesToLimit: limitAt !== undefined ? round((limitAt - now) / 60000, 1) : null,
        limitAt,
        reachableAgainAt,
        method: 'azimuth',
        azOffsetDeg: round(offset, 1),
        stage: this.stage,
        updatedAt: now,
      };
    }
    // Straight-line fit of the measured rotation (EQ, or no catalog position): needs 2 min of samples.
    const pts = this.samples;
    if (pts.length < RATE_MIN_SAMPLES || pts[pts.length - 1].t - pts[0].t < RATE_MIN_SPAN_MS) return null;
    const mt = pts.reduce((a, p) => a + p.t, 0) / pts.length;
    const mr = pts.reduce((a, p) => a + p.rot, 0) / pts.length;
    const num = pts.reduce((a, p) => a + (p.t - mt) * (p.rot - mr), 0);
    const den = pts.reduce((a, p) => a + (p.t - mt) ** 2, 0);
    const perMin = den > 0 ? (num / den) * 60000 : 0;
    const limitDeg = perMin < 0 ? lo : hi;
    const minutes = Math.abs(perMin) > RATE_STILL ? (limitDeg - rot) / perMin : null;
    return {
      rotationDeg: rot,
      ratePerMin: round(perMin, 3),
      limitDeg,
      minutesToLimit: minutes !== null && minutes >= 0 ? round(minutes, 1) : null,
      limitAt: minutes !== null && minutes >= 0 ? now + minutes * 60000 : undefined,
      method: 'rate',
      stage: this.stage,
      updatedAt: now,
    };
  }
}
