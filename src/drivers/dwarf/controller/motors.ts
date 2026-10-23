/**
 * The two mount axes: rotation (motor 1) and pitch (motor 2). Every step is judged by the
 * positions the telescope reports afterwards, not by its replies: a reset or move can end on the
 * firmware's own time limit with the axis part of the way (-14511 "overtime get reset return",
 * verified 2026-10-04 02:43), and going again continues from where it stopped.
 */
import { errMsg, logger } from '../../../log.js';
import { DwarfCommandError } from '../link.js';
import { Cmd, errorText } from '../protocol.js';
import { astroRoutineActive, isTracking, request, sendStop, type Core } from './core.js';
import { MOTOR_NO_REFERENCE, MOTOR_OVERTIME, round, sleep } from './util.js';

const log = logger('motors');

export interface MotorPositions {
  rotationDeg?: number;
  pitchDeg?: number;
  homed: boolean;
}

type Axis = 1 | 2;
const AXIS_NAME: Record<Axis, string> = { 1: 'rotation', 2: 'pitch' };

/** Mechanical ranges (verified: rotation stop near 320°, home at rotation≈159° / pitch≈2.4°, pitch 180 = zenith). */
export const PITCH_RANGE = [0, 195] as const;
export const ROTATION_RANGE = [0, 315] as const;
/**
 * What a reset may report, wider than the range moves are sent to: the firmware's own EQ GoTos take
 * pitch past PITCH_RANGE (2026-10-21 on the wedge: 219.3°, the same again after a second reset).
 * Only a reading beyond this is a wrong reference (2026-10-11 02:48: 323°).
 */
const REPORT_RANGE: Record<Axis, readonly [number, number]> = { 1: ROTATION_RANGE, 2: [0, 250] };
/** The park pose after homing: rotation at the centre of travel, pitch pointing down. */
export const PARK = { rotationDeg: 159, pitchDeg: 2.5 } as const;
const PITCH_HIT_STOP = /-14519/;

// Timings and limits (fw 1.5.3).
const POSITION_READ_MS = 8000;
const STOP_MS = 3000;
/** after stopping an astro routine, the motor controller takes a moment to hand the axes over */
const RELEASE_SETTLE_MS = 1000;
/** a reset finds the reference switch and drives back: up to 4 min on the full travel */
const RESET_MS = 240_000;
const RESET_ATTEMPTS = 3;
const RESET_RETRY_WAIT_MS = 3000;
/** where the rotation reset finds its reference switch; a reset that ends here did not drive back */
const ROTATION_SWITCH_DEG = 12;
const SWITCH_TOLERANCE_DEG = 0.05;
/** a position this far outside the travel after a reset is a wrong reference, not slack */
const RANGE_SLACK_DEG = 5;
/** the parking moves after homing */
const PARK_SPEED_DEG_S = 20;
const PARK_SPEED_SLOW_DEG_S = 10;
/** close enough to the park pose to skip the move */
const PARK_ROTATION_TOLERANCE_DEG = 0.5;
const PARK_PITCH_TOLERANCE_DEG = 3;
/** a run-to: twice the time the distance takes at the speed, plus this */
const RUN_SLACK_MS = 60_000;
/** when the start is unknown, assume this far */
const RUN_UNKNOWN_DISTANCE_DEG = 200;
const RUN_ATTEMPTS = 2;
/** a move that ends within this of its target is done */
const ARRIVED_DEG = 1;
const SPEED_MIN_DEG_S = 0.1;
const SPEED_MAX_DEG_S = 30;
/** joystick vectors are re-sent at this cadence (the firmware stops on silence); a slew lasts 0.1–30 s */
const JOYSTICK_RESEND_MS = 250;
const JOYSTICK_MS = 1000;
const NUDGE_MIN_MS = 100;
const NUDGE_MAX_MS = 30_000;
const NUDGE_MIN_SPEED = 0.01;

export class Motors {
  /**
   * Bumped by every nudge and every stop. A nudge loop runs only while it is the latest: a stop ends
   * it at once instead of after its full duration, and a newer nudge takes over without the older
   * loop's closing stop cutting it short.
   */
  private nudgeGen = 0;

  constructor(private readonly core: Core) {}

  async readPositions(): Promise<MotorPositions> {
    const out: MotorPositions = { homed: true };
    for (const id of [1, 2] as const) {
      // replies carry the axis id: never take the other axis's (late) reply for this one
      const r = await request(this.core, Cmd.STEP_MOTOR_GET_POSITION, { id }, { allowError: true, timeout: POSITION_READ_MS, match: (x) => x.id === undefined || Number(x.id) === id });
      if (r && Number(r.code) === MOTOR_NO_REFERENCE) out.homed = false;
      else if (r && typeof r.position === 'number') out[id === 1 ? 'rotationDeg' : 'pitchDeg'] = round(r.position, 2);
    }
    this.core.store.publish({ motors: { ...out, updatedAt: Date.now() } });
    return out;
  }

  /**
   * Before driving the motors directly, make sure no astro routine (GoTo, one-click GoTo, tracking)
   * still holds them; otherwise resets and moves are ignored or fought. Only what the telescope
   * reports as running is stopped: sending these stops unconditionally leaves the motor controller
   * in a "needs reset" state (-14520, observed on fw 1.5.3). Refused while a stack runs or starts.
   */
  private async release(): Promise<void> {
    this.core.guards.assertNoStackForMotion();
    const st = this.core.store.state;
    if (astroRoutineActive(st) || isTracking(st)) {
      await sendStop(this.core, Cmd.ASTRO_STOP_GOTO, STOP_MS);
      await sendStop(this.core, Cmd.ASTRO_STOP_ONE_CLICK_GOTO, STOP_MS);
      await sleep(RELEASE_SETTLE_MS);
    }
  }

  private markMotion(): void {
    this.core.lastMotionAt = Date.now();
  }

  /** Home both axes against their reference switches (needed after power-on), then park. */
  async home(): Promise<string> {
    return this.core.guards.exclusive('homing the motors', () => this.homeNow());
  }

  /** Homing inside an operation that is already running (astro recovery). */
  async homeNow(): Promise<string> {
    this.core.guards.assertNoNdLock('homing the motors');
    await this.release();
    const notes: string[] = [];
    const stillThere = this.dropCheck('homing');
    await this.homeAxis(2, true, stillThere, notes);
    // rotation reference switch at ≈12° (direction=true has no switch → -14520)
    const rot = await this.homeAxis(1, false, stillThere, notes);
    this.markMotion();
    stillThere();
    if (Math.abs(rot - PARK.rotationDeg) > PARK_ROTATION_TOLERANCE_DEG) await this.runAxis(1, PARK.rotationDeg, PARK_SPEED_DEG_S, rot);
    const mid = await this.readPositions();
    stillThere();
    if (mid.pitchDeg !== undefined && mid.pitchDeg > PARK_PITCH_TOLERANCE_DEG) {
      try {
        await this.runAxis(2, PARK.pitchDeg, PARK_SPEED_DEG_S, mid.pitchDeg);
      } catch (e) {
        // A reset can come back in ~1 s with a wrong pitch reference (2026-10-12 00:55, after the
        // scope was tilted by hand for darks: 22.7° reported, the stop hit 1 s into the park move).
        // Resetting again found the true reference.
        if (!PITCH_HIT_STOP.test(errMsg(e))) throw e;
        notes.push(`pitch hit its stop while parking from ${mid.pitchDeg}° (wrong reference after the first reset), so it was reset again`);
        stillThere();
        const p2 = await this.homeAxis(2, true, stillThere, notes);
        stillThere();
        if (p2 > PARK_PITCH_TOLERANCE_DEG) await this.runAxis(2, PARK.pitchDeg, PARK_SPEED_DEG_S, p2);
      }
    }
    this.markMotion();
    const q = await this.readPositions();
    return `homed: rotation ${q.rotationDeg}° (centre of travel), pitch ${q.pitchDeg}° (pointing down; raise with move_motors, e.g. pitch 160 ≈ 70° altitude)${notes.length ? `. Notes: ${notes.join('; ')}` : ''}`;
  }

  /**
   * A power-off or a lost connection ends a reset routine: resetting through a shutdown left the
   * pitch with a wrong reference (2026-10-11 02:48: 323°, outside its travel).
   */
  private dropCheck(what: string): () => void {
    const started = Date.now();
    return () => {
      if (this.core.lastDropAt >= started) {
        throw new Error(`${what} stopped: the telescope powered off or the connection dropped during it, so nothing more was sent. Once it is back, call motors_home once.`);
      }
    };
  }

  /**
   * Give both axes their reference again where they stand, without parking: after a GoTo the
   * motors read "not homed" (-14520), and each reset drives back to where it started, so the pose a
   * plate-solved GoTo reached can be read in motor angles (the obstruction survey's anchors).
   * Tracking is stopped first. Inside an operation that is already running.
   */
  async rereferenceNow(): Promise<MotorPositions> {
    this.core.guards.assertNoNdLock('re-referencing the motors');
    await this.release();
    const notes: string[] = [];
    const stillThere = this.dropCheck('re-referencing the motors');
    await this.homeAxis(2, true, stillThere, notes);
    const rot = await this.homeAxis(1, false, stillThere, notes);
    this.markMotion();
    stillThere();
    if (notes.length) log.info(`re-reference: ${notes.join('; ')}`);
    // A rotation reset can stop at its switch instead of driving back (2026-10-21 at the survey's SE
    // anchor: 248.8° → 12.000° in 11 s, where the NE one drove back in 21 s): the pose is lost.
    if (Math.abs(rot - ROTATION_SWITCH_DEG) < SWITCH_TOLERANCE_DEG) {
      throw new Error(`the rotation reset stopped at its reference switch (${rot}°) instead of driving back to where it started, so the pose before it is lost`);
    }
    return this.readPositions();
  }

  /**
   * One axis. The firmware's reset finds the axis's reference switch and then drives it back to
   * where it started (verified 2026-10-10/11 on fw 1.5.3: pitch 136 → 136, 153 → 153, 90 → 90), so a
   * valid position afterwards means homed, wherever it is. Retried only when the reset did not give
   * a position (time limit, no reply).
   */
  private async homeAxis(id: Axis, direction: boolean, stillThere: () => void, notes: string[]): Promise<number> {
    const axis = AXIS_NAME[id];
    const [lo, hi] = REPORT_RANGE[id];
    let last = '';
    for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt++) {
      stillThere();
      const r = await request(this.core, Cmd.STEP_MOTOR_RESET, { id, direction }, { timeout: RESET_MS, allowError: true, bestEffort: true });
      stillThere();
      const code = Number(r?.code ?? 0);
      if (r && code < 0 && code !== MOTOR_NO_REFERENCE && !MOTOR_OVERTIME.has(code)) throw new DwarfCommandError(Cmd.STEP_MOTOR_RESET, code, r);
      const p = await this.readPositions().catch(() => null);
      const v = id === 1 ? p?.rotationDeg : p?.pitchDeg;
      if (v !== undefined) {
        if (v < lo - RANGE_SLACK_DEG || v > hi + RANGE_SLACK_DEG) {
          throw new Error(
            `${axis} reports ${v}° after its reset, outside the ${lo}–${hi}° it can reach: the motor controller has a wrong reference (seen after the telescope was powered off in the middle of a reset). Nothing more was moved. Fix: power the telescope off, let it finish shutting down, power it on, then call motors_home once.`,
          );
        }
        if (attempt > 1) notes.push(`${axis} needed ${attempt} resets (${last})`);
        return v;
      }
      last = !r ? `no reply within ${Math.round(RESET_MS / 60_000)} min` : MOTOR_OVERTIME.has(code) ? `stopped at the firmware's time limit (${errorText(code)})` : 'still no reference (-14520)';
      if (attempt < RESET_ATTEMPTS) await sleep(RESET_RETRY_WAIT_MS);
    }
    throw new Error(`homing failed: ${axis} has no reference after ${RESET_ATTEMPTS} resets (${last}). Power-cycling the telescope resets its motor controller.`);
  }

  /**
   * Run one axis to an absolute angle. The reply arrives when the motion ends; the timeout allows
   * for the distance at this speed. Without a reply, or when the firmware's time limit ends the move
   * early, the measured position decides, and an unfinished move continues once from there.
   */
  private async runAxis(id: Axis, end: number, speed: number, from?: number): Promise<void> {
    let pos = from;
    let last = '';
    for (let attempt = 1; attempt <= RUN_ATTEMPTS; attempt++) {
      const dist = pos !== undefined ? Math.abs(end - pos) : RUN_UNKNOWN_DISTANCE_DEG;
      const timeout = Math.round((dist / speed) * 2000 + RUN_SLACK_MS);
      this.markMotion();
      const r = await request(this.core, Cmd.STEP_MOTOR_RUN_TO, { id, endPosition: end, speed, speedRamping: 100, resolutionLevel: 3 }, { timeout, bestEffort: true, allowError: true });
      this.markMotion();
      const code = Number(r?.code ?? 0);
      if (r && code >= 0) return;
      if (r && !MOTOR_OVERTIME.has(code)) throw new DwarfCommandError(Cmd.STEP_MOTOR_RUN_TO, code, r);
      const p = await this.readPositions().catch(() => null);
      pos = id === 1 ? p?.rotationDeg : p?.pitchDeg;
      if (pos !== undefined && Math.abs(pos - end) < ARRIVED_DEG) return;
      last = r ? errorText(code) : `no reply within ${Math.round(timeout / 1000)} s`;
    }
    throw new Error(`${AXIS_NAME[id]} did not reach ${end}° (now ${pos ?? 'unknown'}°; ${last})`);
  }

  /** Drive to the park pose (no homing: needs a homed mount). */
  async park(): Promise<string> {
    return this.core.guards.exclusive('parking', () => this.moveToNow(PARK, PARK_SPEED_SLOW_DEG_S));
  }

  /**
   * Move to absolute motor angles. A scope that is tracking or was left un-homed by an astro routine
   * is released and homed first, so a move always works. An out-of-range target moves nothing.
   */
  async moveTo(target: { rotationDeg?: number; pitchDeg?: number }, speedDegPerS = 10): Promise<string> {
    return this.core.guards.exclusive('moving the motors', () => this.moveToNow(target, speedDegPerS));
  }

  private async moveToNow(target: { rotationDeg?: number; pitchDeg?: number }, speedDegPerS: number): Promise<string> {
    this.core.guards.assertNoNdLock('moving the motors');
    const speed = Number.isFinite(speedDegPerS) ? Math.max(SPEED_MIN_DEG_S, Math.min(SPEED_MAX_DEG_S, speedDegPerS)) : PARK_SPEED_SLOW_DEG_S;
    const [pMin, pMax] = PITCH_RANGE;
    const [rMin, rMax] = ROTATION_RANGE;
    if (target.pitchDeg !== undefined && !(target.pitchDeg >= pMin && target.pitchDeg <= pMax)) {
      throw new Error(`pitch ${target.pitchDeg}° is out of range ${pMin}–${pMax}° (90 = horizon, 180 = zenith in Alt-Az). Nothing was moved.`);
    }
    if (target.rotationDeg !== undefined && !(target.rotationDeg >= rMin && target.rotationDeg <= rMax)) {
      throw new Error(`rotation ${target.rotationDeg}° is out of range ${rMin}–${rMax}° (mechanical stops; centre ≈159°). Nothing was moved.`);
    }
    await this.release();
    let before = await this.readPositions();
    let homed = '';
    if (!before.homed) {
      // tracking after a GoTo, or a failed calibration/GoTo, leaves the axes without a reference (-14520)
      await this.homeNow();
      homed = 'the motors had no reference (tracking or after an astro routine), so they were homed first; ';
      before = await this.readPositions();
    }
    if (target.pitchDeg !== undefined) await this.runAxis(2, target.pitchDeg, speed, before.pitchDeg);
    if (target.rotationDeg !== undefined) await this.runAxis(1, target.rotationDeg, speed, before.rotationDeg);
    this.markMotion();
    const p = await this.readPositions();
    return `${homed}now at rotation ${p.rotationDeg}°, pitch ${p.pitchDeg}°`;
  }

  /**
   * Joystick-style slew. angleDeg uses screen convention: 0 = up, 90 = right. The firmware uses math
   * convention (0 = right, 90 = up), verified on hardware: fw 0° pans right (rotation angle
   * decreases), fw 90° raises pitch. Speed 0..1 (≈ 30°/s at 1.0; 0.3 ≈ 9°/s). Always ends with a stop.
   */
  async nudge(angleDeg: number, speed: number, durationMs: number): Promise<void> {
    const { guards } = this.core;
    guards.assertNoNdLock('slewing');
    guards.assertNoOperation('slewing');
    guards.assertNoStackForMotion();
    if (!Number.isFinite(angleDeg) || !Number.isFinite(speed) || !Number.isFinite(durationMs)) throw new Error('slew: angle, speed and duration must be numbers');
    const fwAngle = (((90 - angleDeg) % 360) + 360) % 360;
    const len = Math.max(NUDGE_MIN_SPEED, Math.min(1, speed));
    const end = Date.now() + Math.max(NUDGE_MIN_MS, Math.min(NUDGE_MAX_MS, durationMs));
    const gen = ++this.nudgeGen;
    const current = () => gen === this.nudgeGen;
    try {
      while (current() && Date.now() < end) {
        this.markMotion();
        await request(this.core, Cmd.STEP_MOTOR_SERVICE_JOYSTICK, { vectorAngle: fwAngle, vectorLength: len }, { bestEffort: true, timeout: JOYSTICK_MS });
        if (!current()) break;
        await sleep(Math.min(JOYSTICK_RESEND_MS, Math.max(0, end - Date.now())));
      }
    } finally {
      // superseded by a newer nudge: that one owns the joystick and sends its own stop
      if (current()) await sendStop(this.core, Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP, STOP_MS);
      this.markMotion();
    }
  }

  async stopMotion(): Promise<void> {
    this.nudgeGen++; // any nudge loop still running ends before its next vector
    await sendStop(this.core, Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP, STOP_MS);
    for (const id of [1, 2]) await request(this.core, Cmd.STEP_MOTOR_STOP, { id }, { bestEffort: true, timeout: STOP_MS }).catch(() => null);
  }
}
