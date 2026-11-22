/**
 * The Dwarf mini's rotation angle, counted by the driver. Its rotation axis has no home sensor and
 * the firmware never reports where it is (STEP_MOTOR_GET_POSITION and RUN_TO answer -14520 "needs
 * reset" all night; the gyro query answers -1; the device state has no motor angle). What it does
 * have is an exact relative move: STEP_MOTOR_RUN_IN_PULSE (14010) with mode=false turns an axis by a
 * pulse count. Measured 2026-11-21 on fw 1.1.4.19 (resolution 3):
 *  - 0.009° per pulse on both axes: 200 → 1.800°, 2000 → 18.000°, 8000 → 72.000° on pitch, both ways;
 *    40 000 pulses turned the base one full turn back onto the same view (rotation).
 *  - the rate is capped near 1950 Hz (≈ 17.5°/s); the reply comes ~0.1 s after the command, and the
 *    move ends at most pulses / rate + 0.17 s after the reply.
 *  - a second pulse command on the same axis cancels the one running (its count is then unknown);
 *    the two axes are independent.
 *  - direction=true turns rotation so the wide view pans left (the angle this counts upwards), and
 *    lowers pitch.
 * So every rotation the driver makes is a pulse move and is counted here. Zero is the rotation the
 * mini was powered on at: the firmware's own "initial position" (DWARFLAB app: "avoid rotating the
 * horizontal axis too far from its initial position"), told by the pitch axis having no reference
 * yet when the driver connects. The count is kept on disk, so a restart of this program while the
 * telescope stays on keeps it.
 *
 * The firmware's own routines (calibration, GoTo, tracking, polar alignment, panorama, sentry, the
 * DWARFLAB app's joystick) turn the base by amounts it never reports; the count is marked untracked
 * with what moved it. A GoTo gives it back: the rig is always on an EQ wedge (the rotation axis is
 * the polar axis), and at rotation 0 (the power-on pose, base marks aligned) with pitch 90 the mini
 * points at the celestial equator on the meridian (verified 2026-11-21 on the user's wedge: "pointing
 * up at the sky, south of straight up", the equator at latitude 28.8°). So rotation = −(hour angle of
 * where it points) × 15°/h, +180° when pitch is past the pole (over 180°). After a GoTo it points at
 * the target, and while the firmware tracks, the angle follows the target's hour angle (15.04°/h).
 * When tracking ends, the angle it reached is where the count goes on from.
 */
import fs from 'node:fs';
import { errMsg, logger } from '../../../log.js';
import { writeFileAtomic } from '../../../util/fs.js';
import { hourAngle, type Site } from '../../../astro/sky.js';

const log = logger('rotation');

export const PULSE_DEG = 0.009;
export const PULSES_PER_TURN = 40_000;
/** STEP_MOTOR_RUN_IN_PULSE resolution (1/8 steps); the pulse size above is for this one. */
export const PULSE_RESOLUTION = 3;
/** The firmware's rate cap (measured 8000 pulses in 4.1 s asked at 4000 Hz). */
export const PULSE_MAX_HZ = 1900;
export const PULSE_MIN_HZ = 50;
/** After the reply, beyond the pulse time: the ramp and the last steps (measured 0.02–0.17 s). */
export const PULSE_SETTLE_MS = 250;

export interface RotationCount {
  /** degrees from the power-on rotation; + = wide view pans left */
  deg: number;
  /** false once something the driver could not count turned the base */
  tracked: boolean;
  /** what turned it uncounted, when not tracked */
  lostTo?: string;
  /** when zero was set (the power-on the driver saw) */
  since: number;
  at: number;
  /** the J2000 position the firmware is tracking: the angle follows its hour angle */
  follow?: { raHours: number; decDeg: number; flipped: boolean; target?: string };
}

/** Normalise to (−180, 180]. */
const wrap180 = (d: number): number => {
  const x = ((((d + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
};

/**
 * The rotation of the EQ-mounted mini pointing at a J2000 position: −HA × 15° (its zero points at
 * the meridian), +180° on the far side of the pole (pitch past 180°).
 */
export function rotationForPointing(site: Site, raHours: number, decDeg: number, flipped: boolean, when = new Date()): number {
  return Math.round(wrap180(-hourAngle(site, raHours, decDeg, when) * 15 + (flipped ? 180 : 0)) * 1000) / 1000;
}

/** Pitch for a declination on the near side of the pole (pitch 90 = the equator, 180 = the pole). */
export const pitchForDec = (decDeg: number): number => decDeg + 90;
/** Its highest pitch (DWARFLAB: 225° of tilt): the far side of the pole reaches down to 270 − 225 = 45° declination. */
const FAR_SIDE_MIN_DEC = 45;

/** How long a pulse move still runs after its reply (ms), from the measured rate cap and settle time. */
export function pulseMoveMs(pulses: number, hz: number): number {
  return Math.ceil((pulses / Math.min(hz, PULSE_MAX_HZ)) * 1000) + PULSE_SETTLE_MS;
}

export class RotationOdometer {
  private s: RotationCount | null = null;

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RotationCount>;
      if (typeof j.deg === 'number' && typeof j.tracked === 'boolean' && typeof j.since === 'number') {
        this.s = { deg: j.deg, tracked: j.tracked, lostTo: j.lostTo, since: j.since, at: j.at ?? j.since, follow: j.follow };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`rotation count not read (${errMsg(e)}); it starts unknown`);
    }
  }

  /** Null until a power-on was seen (no count yet). */
  get(): RotationCount | null {
    return this.s ? { ...this.s } : null;
  }

  /** The angle when it can be trusted; while it follows a tracked target, from that target's hour angle now. */
  angle(site?: Site | null, when = new Date()): number | undefined {
    if (!this.s?.tracked) return undefined;
    const f = this.s.follow;
    if (f) return site ? rotationForPointing(site, f.raHours, f.decDeg, f.flipped, when) : undefined;
    return this.s.deg;
  }

  /** Whether the angle is following a tracked target. */
  following(): RotationCount['follow'] {
    return this.s?.follow ? { ...this.s.follow } : undefined;
  }

  /**
   * A GoTo reached a target and the firmware tracks it: the angle is the target's, and follows it.
   * The side of the pole: pitch past 180° when it is known; otherwise the near side, unless the far
   * side is reachable (declination ≥ 45°) and closer to the power-on rotation (the firmware keeps the
   * base near it: DWARFLAB "avoid rotating the horizontal axis too far from its initial position").
   */
  pointedAt(site: Site, raHours: number, decDeg: number, pitchDeg: number | undefined, target?: string, when = new Date()): number {
    let flipped: boolean;
    if (pitchDeg !== undefined) flipped = pitchDeg > 180;
    else {
      const near = rotationForPointing(site, raHours, decDeg, false, when);
      const far = rotationForPointing(site, raHours, decDeg, true, when);
      flipped = decDeg >= FAR_SIDE_MIN_DEC && Math.abs(far) < Math.abs(near);
    }
    const now = Date.now();
    const deg = rotationForPointing(site, raHours, decDeg, flipped, when);
    this.s = { deg, tracked: true, since: this.s?.since ?? now, at: now, follow: { raHours, decDeg, flipped, target } };
    log.info(`rotation: pointing at ${target ?? `RA ${raHours.toFixed(3)} h, Dec ${decDeg.toFixed(2)}°`} → ${deg}° (${flipped ? 'far' : 'near'} side of the pole), following it while it tracks`);
    this.save();
    return deg;
  }

  /** Tracking ended: the angle it reached is where the count goes on from. */
  stopFollowing(site: Site | null, when = new Date()): void {
    if (!this.s?.follow) return;
    const a = site ? this.angle(site, when) : undefined;
    const target = this.s.follow.target;
    this.s.follow = undefined;
    if (a === undefined) {
      this.s.tracked = false;
      this.s.lostTo = 'tracking that ended without a known site';
    } else {
      this.s.deg = a;
      log.info(`rotation: tracking${target ? ` ${target}` : ''} ended at ${a}°; counting from there`);
    }
    this.s.at = Date.now();
    this.save();
  }

  /** The telescope was powered on: where it stands now is zero. */
  powerOn(): void {
    const now = Date.now();
    this.s = { deg: 0, tracked: true, since: now, at: now };
    log.info('rotation: power-on seen, the count starts at 0° here');
    this.save();
  }

  /** A counted pulse move (degrees, + = direction true). */
  add(deg: number): void {
    if (!this.s) return;
    // while tracking, a turn moves the tracked position: rotation + is hour angle −, so RA +
    if (this.s.follow) this.s.follow.raHours = (((this.s.follow.raHours + deg / 15) % 24) + 24) % 24;
    this.s.deg = Math.round((this.s.deg + deg) * 1000) / 1000;
    this.s.at = Date.now();
    this.save();
  }

  /** Something turned the base by an amount the driver cannot know. */
  lose(what: string): void {
    if (!this.s || !this.s.tracked) return;
    this.s.follow = undefined;
    this.s.tracked = false;
    this.s.lostTo = what;
    this.s.at = Date.now();
    log.info(`rotation: ${what} turned the base by an unreported amount; the count is no longer exact`);
    this.save();
  }

  private save(): void {
    if (!this.file || !this.s) return;
    try {
      writeFileAtomic(this.file, JSON.stringify(this.s));
    } catch (e) {
      log.warn(`rotation count not saved (${errMsg(e)})`);
    }
  }
}
