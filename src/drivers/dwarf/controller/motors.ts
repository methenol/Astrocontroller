/**
 * The two mount axes: rotation (motor 1) and pitch (motor 2). Every step is judged by the
 * positions the telescope reports afterwards, not by its replies: a reset or move can end on the
 * firmware's own time limit with the axis part of the way (-14511 "overtime get reset return",
 * verified 2026-10-04 02:43), and going again continues from where it stopped.
 */
import { errMsg, logger } from '../../../log.js';
import * as http from '../http.js';
import { DwarfCommandError } from '../link.js';
import { Cmd, errorText } from '../protocol.js';
import { astroRoutineActive, isTracking, request, sendStop, type Core } from './core.js';
import { MOTOR_NO_REFERENCE, MOTOR_OVERTIME, round, sleep } from './util.js';
import { dwarfModel, type DwarfModel } from './model.js';
import { PULSE_DEG, PULSE_MAX_HZ, PULSE_MIN_HZ, PULSE_RESOLUTION, pulseMoveMs, RotationOdometer } from './rotation-odometer.js';
import * as sky from '../../../astro/sky.js';

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
/** The Dwarf mini's pitch range: 225° of tilt (DWARFLAB spec), kept 5° inside it. */
export const MINI_PITCH_RANGE = [0, 220] as const;
export const pitchRangeFor = (model: DwarfModel | null): readonly [number, number] => (model === 'mini' ? MINI_PITCH_RANGE : PITCH_RANGE);
/**
 * The mini's rotation, in degrees from where it was powered on (counted: rotation-odometer.ts; +
 * pans the wide view left). Up to one turn either way: the base has no stop, the power cable wraps.
 */
export const MINI_ROTATION_RANGE = [-360, 360] as const;
/** The mini at nudge speed 1.0: the pulse rate cap (≈ 17°/s; its own joystick measured ≈ 18–20°/s). */
const MINI_NUDGE_MAX_DEG_S = PULSE_MAX_HZ * PULSE_DEG;
/**
 * The mini's moves are cut into pulse moves this long: a stop waits for the one running instead of
 * cutting it (a cut move's count is unknown), and a held nudge renews between them.
 */
const MINI_CHUNK_MS = 600;
const MINI_PULSE_REPLY_MS = 5000;
/**
 * Commands after which the mini's base has turned by an amount the firmware never reports: its own
 * routines and the joystick (the driver turns the mini's rotation with counted pulse moves only).
 */
const MINI_ROTATING_CMDS: ReadonlyArray<[string, string]> = [
  ['ASTRO_START_CALIBRATION', 'a calibration'],
  ['ASTRO_START_GOTO_DSO', 'a GoTo'],
  ['ASTRO_START_GOTO_SOLAR_SYSTEM', 'a GoTo'],
  ['ASTRO_START_ONE_CLICK_GOTO_DSO', 'a one-click GoTo'],
  ['ASTRO_START_ONE_CLICK_GOTO_SOLAR_SYSTEM', 'a one-click GoTo'],
  ['ASTRO_START_EQ_SOLVING', 'a polar alignment'],
  ['ASTRO_START_TRACK_SPECIAL_TARGET', 'Sun/Moon tracking'],
  ['ASTRO_START_TELE_MOSAIC', 'a mosaic'],
  ['ASTRO_START_ONE_CLICK_SHOOTING', 'one-click shooting'],
  ['ASTRO_START_SKY_TARGET_FINDER', 'the sky target finder'],
  ['PANORAMA_START_GRID', 'a panorama'],
  ['SENTRY_MODE_START', 'sentry mode'],
  ['TRACK_START_TRACK', 'object tracking'],
  ['TRACK_START_CLICK', 'object tracking'],
  ['UFOTRACK_MODE_START', 'object tracking'],
  ['STEP_MOTOR_SERVICE_DUAL_CAMERA_LINKAGE', 'tap-to-centre'],
  ['STEP_MOTOR_SERVICE_JOYSTICK', 'the joystick'],
  ['STEP_MOTOR_SERVICE_JOYSTICK_FIXED_ANGLE', 'the joystick'],
];
const MINI_ROTATING = new Map<number, string>(
  MINI_ROTATING_CMDS.map(([k, v]) => [(Cmd as unknown as Record<string, number | undefined>)[k], v] as [number | undefined, string]).filter((e): e is [number, string] => typeof e[0] === 'number'),
);
/** What the replies say about the mini's rotation when the count is not exact. */
function miniRotationUnknown(lostTo: string | undefined): string {
  return lostTo
    ? `the rotation count is not exact since ${lostTo} turned the base (the firmware does not report how far); it is exact again from the next power-on`
    : 'the rotation has no count yet: the driver has not seen this power-on (it sets zero where the mini stands when it connects to a just-powered-on mini)';
}
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
/** pause before reading a position again after a transient error */
const POSITION_REREAD_MS = 200;
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
  /** The mini's rotation count (unused on the Dwarf 3, whose rotation reports its angle). */
  readonly rotation: RotationOdometer;
  /** The mini's pulse moves the driver has in flight on rotation (any other is someone else's). */
  private ownRotationPulses = 0;
  /** The first position read after a (re)connect tells a power-on: pitch without a reference. */
  private freshConnect = true;
  /** Per-axis chain: a pulse move never starts while one runs (it would cancel it uncounted). */
  private readonly pulseChain: Record<Axis, Promise<unknown>> = { 1: Promise.resolve(), 2: Promise.resolve() };
  /** The mini's held nudge: velocities (°/s) and the lease end. */
  private slew: { rotDegS: number; pitchDegS: number; until: number } | null = null;
  private slewLoop: Promise<void> | null = null;

  constructor(
    private readonly core: Core,
    rotationFile: string | null = null,
  ) {
    this.rotation = new RotationOdometer(rotationFile);
  }

  /** The link is (back) up: the next position read decides whether the mini was powered on. */
  connected(): void {
    this.freshConnect = true;
  }

  /** Every command sent on the link: the mini's rotation count is lost to the routines that turn it uncounted. */
  noteSent(cmd: number, params: Record<string, unknown>): void {
    if (dwarfModel(this.core.store.state.device) !== 'mini') return;
    const what = MINI_ROTATING.get(cmd);
    if (what) return this.rotation.lose(what);
    const id = Number(params.id);
    if (id !== 1) return;
    if (cmd === Cmd.STEP_MOTOR_RUN_IN_PULSE && this.ownRotationPulses === 0) this.rotation.lose('a rotation pulse move the driver did not send');
    else if (cmd === Cmd.STEP_MOTOR_RUN || cmd === Cmd.STEP_MOTOR_RESET || cmd === Cmd.STEP_MOTOR_RUN_TO) this.rotation.lose('a rotation run/reset command');
  }

  /**
   * A GoTo reached its target and the firmware tracks it: the mini's rotation is the target's (its
   * hour angle on the EQ wedge) and follows it while it tracks.
   */
  async miniPointedAt(raHours: number, decDeg: number, target: string): Promise<void> {
    if ((await this.model()) !== 'mini') return;
    const site = this.core.location();
    if (!site) return this.rotation.lose(`a GoTo to ${target} (no observer location to work out the rotation)`);
    const p = await this.readPositions().catch(() => null);
    this.rotation.pointedAt(site, raHours, decDeg, p?.pitchDeg, target);
    await this.readPositions().catch(() => null);
  }

  /** A calibration plate-solved where it ended (azimuth/altitude): the mini's rotation is that pointing's. */
  async miniCalibratedAt(azimuthDeg: number, altitudeDeg: number): Promise<void> {
    if ((await this.model()) !== 'mini') return;
    const site = this.core.location();
    if (!site) return this.rotation.lose('a calibration (no observer location to work out the rotation)');
    const { raHours, decDeg } = sky.raDecFromAltAz(site, azimuthDeg, altitudeDeg);
    const p = await this.readPositions().catch(() => null);
    this.rotation.pointedAt(site, raHours, decDeg, p?.pitchDeg, 'the calibration pointing');
    // not tracking after a calibration: the angle stays where it was solved
    if (!isTracking(this.core.store.state)) this.rotation.stopFollowing(site);
    await this.readPositions().catch(() => null);
  }

  /** The mini's rotation for replies: its counted angle, or why there is none. */
  miniRotationText(): string {
    const a = this.rotation.angle(this.core.location());
    return a !== undefined ? `rotation ${round(a, 2)}° from where it was powered on` : miniRotationUnknown(this.rotation.get()?.lostTo);
  }

  /** The model from the device info; read over HTTP when not known yet, so a mini never gets a Dwarf 3 rotation reset. */
  async model(): Promise<DwarfModel | null> {
    const st = this.core.store.state;
    const known = dwarfModel(st.device);
    if (known) return known;
    try {
      const info = await http.getDeviceInfo();
      st.device = { ...st.device, name: info.deviceName, serial: info.sn };
      http.setCardRoot(dwarfModel(st.device) === 'mini' ? '/DWARF_mini' : '/DWARF3');
      this.core.store.changed();
    } catch (e) {
      log.debug(`device model unknown (device info: ${errMsg(e)})`);
    }
    return dwarfModel(st.device);
  }

  async readPositions(): Promise<MotorPositions> {
    const out: MotorPositions = { homed: true };
    // the mini's rotation never has a reference (-14520): "homed" is its pitch's, its angle is counted
    const mini = dwarfModel(this.core.store.state.device) === 'mini';
    const axes: Axis[] = mini ? [2] : [1, 2];
    for (const id of axes) {
      // replies carry the axis id: never take the other axis's (late) reply for this one
      const read = () => request(this.core, Cmd.STEP_MOTOR_GET_POSITION, { id }, { allowError: true, timeout: POSITION_READ_MS, match: (x) => x.id === undefined || Number(x.id) === id });
      let r = await read();
      // a firmware time-out right after a move (-14512, 2026-11-21 on the Dwarf mini: the next read 50 ms later was fine) is read again once
      const code = Number(r?.code ?? 0);
      if (r && code < 0 && code !== MOTOR_NO_REFERENCE) {
        await sleep(POSITION_REREAD_MS);
        r = await read();
      }
      if (r && Number(r.code) === MOTOR_NO_REFERENCE) out.homed = false;
      else if (r && typeof r.position === 'number') out[id === 1 ? 'rotationDeg' : 'pitchDeg'] = round(r.position, 2);
      // A just-powered-on mini has no pitch reference until its first reset: where its base stands now
      // is its power-on rotation, zero. (A pitch left without one by a failed routine before this
      // program restarted reads the same; then zero is set where the base stands, which is wrong.)
      if (mini && id === 2 && r && this.freshConnect) {
        this.freshConnect = false;
        if (!out.homed) this.rotation.powerOn();
      }
    }
    let extra = {};
    if (mini) {
      const site = this.core.location();
      // tracking ended: the angle it reached is where the count goes on from
      if (this.rotation.following() && !isTracking(this.core.store.state)) this.rotation.stopFollowing(site);
      const a = this.rotation.angle(site);
      if (a !== undefined) out.rotationDeg = round(a, 2);
      const c = this.rotation.get();
      extra = { rotationCounted: a !== undefined, ...(a === undefined ? { rotationUnknown: miniRotationUnknown(c?.lostTo) } : {}) };
    }
    this.core.store.publish({ motors: { ...out, ...extra, updatedAt: Date.now() } });
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
    await this.release();
    const notes: string[] = [];
    const stillThere = this.dropCheck('homing');
    if ((await this.model()) === 'mini') return this.homeMiniNow(stillThere, notes);
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
   * The mini: pitch is reset against its reference (its rotation has none: a rotation reset just turns
   * the base until the firmware's time limit), the base turns back to its power-on rotation by the
   * count, and pitch is lowered to the park pose.
   */
  private async homeMiniNow(stillThere: () => void, notes: string[]): Promise<string> {
    const pitch = await this.homeAxis(2, true, stillThere, notes);
    this.markMotion();
    stillThere();
    const rot = await this.miniRotationHome(stillThere);
    if (pitch > PARK.pitchDeg + PARK_PITCH_TOLERANCE_DEG) await this.runAxis(2, PARK.pitchDeg, PARK_SPEED_DEG_S, pitch);
    this.markMotion();
    const q = await this.readPositions();
    return `homed: pitch ${q.pitchDeg}° (pointing down; raise with move_motors, e.g. pitch 90 = level); ${rot}${notes.length ? `. Notes: ${notes.join('; ')}` : ''}`;
  }

  /** The mini's base back to its power-on rotation, the way it came (unwinding), when the count is exact. */
  private async miniRotationHome(stillThere: () => void): Promise<string> {
    const a = this.rotation.angle(this.core.location());
    if (a === undefined) return `rotation left where it is: ${miniRotationUnknown(this.rotation.get()?.lostTo)}`;
    if (Math.abs(a) >= PULSE_DEG) await this.turnMiniRotation(-a, PARK_SPEED_DEG_S, stillThere);
    return `rotation back at its power-on position (it had turned ${round(a, 2)}°)`;
  }

  /**
   * One pulse move on one axis of the mini, counted when it is rotation. Resolves once the move has
   * ended. Moves on the same axis queue: one sent while another runs would cancel it uncounted.
   */
  private pulseAxis(id: Axis, deg: number, degPerS: number): Promise<void> {
    const run = async () => {
      const pulses = Math.round(Math.abs(deg) / PULSE_DEG);
      if (!pulses) return;
      const hz = Math.max(PULSE_MIN_HZ, Math.min(PULSE_MAX_HZ, Math.round(Math.abs(degPerS) / PULSE_DEG)));
      // direction=true: rotation counts up (the wide view pans left); pitch goes down
      const direction = id === 1 ? deg > 0 : deg < 0;
      if (id === 1) this.ownRotationPulses++;
      let r: Record<string, unknown> | null;
      try {
        this.markMotion();
        r = await request(
          this.core,
          Cmd.STEP_MOTOR_RUN_IN_PULSE,
          { id, frequency: hz, direction, speedRamping: 100, resolution: PULSE_RESOLUTION, pulse: pulses, mode: false },
          { timeout: MINI_PULSE_REPLY_MS, allowError: true, match: (x) => x.id === undefined || Number(x.id) === id },
        );
      } finally {
        if (id === 1) this.ownRotationPulses--;
      }
      if (!r) {
        // sent, but whether the firmware ran it is unknown
        if (id === 1) this.rotation.lose('a rotation pulse move without a reply');
        throw new Error(`${AXIS_NAME[id]} pulse move got no reply within ${MINI_PULSE_REPLY_MS / 1000} s`);
      }
      const code = Number(r.code ?? 0);
      if (code < 0) throw new DwarfCommandError(Cmd.STEP_MOTOR_RUN_IN_PULSE, code, r);
      if (id === 1) this.rotation.add((direction ? 1 : -1) * pulses * PULSE_DEG);
      await sleep(pulseMoveMs(pulses, hz));
      this.markMotion();
    };
    const next = this.pulseChain[id].then(run, run);
    this.pulseChain[id] = next.catch(() => undefined);
    return next;
  }

  /** Turn the mini's base by a counted amount, in moves of at most MINI_CHUNK_MS (a stop ends it between two). */
  private async turnMiniRotation(deltaDeg: number, degPerS: number, stillThere?: () => void): Promise<void> {
    const gen = this.nudgeGen;
    const rate = Math.max(PULSE_MIN_HZ * PULSE_DEG, Math.min(MINI_NUDGE_MAX_DEG_S, Math.abs(degPerS)));
    const chunk = (rate * MINI_CHUNK_MS) / 1000;
    let left = deltaDeg;
    while (Math.abs(left) >= PULSE_DEG) {
      if (gen !== this.nudgeGen) throw new Error(`stopped with the base ${round(deltaDeg - left, 2)}° of the ${round(deltaDeg, 2)}° turn along (the count is exact: ${this.miniRotationText()})`);
      stillThere?.();
      const step = Math.sign(left) * Math.min(Math.abs(left), chunk);
      await this.pulseAxis(1, step, rate);
      left -= Math.round(step / PULSE_DEG) * PULSE_DEG;
    }
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
    await this.release();
    const notes: string[] = [];
    const stillThere = this.dropCheck('re-referencing the motors');
    await this.homeAxis(2, true, stillThere, notes);
    if ((await this.model()) === 'mini') {
      this.markMotion();
      if (notes.length) log.info(`re-reference: ${notes.join('; ')}`);
      return this.readPositions();
    }
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
    return this.core.guards.exclusive('parking', async () => {
      if ((await this.model()) === 'mini') {
        // the mini parks at its power-on rotation (when counted), pitch down
        await this.release();
        const rot = await this.miniRotationHome(() => {});
        const r = await this.moveToNow({ pitchDeg: PARK.pitchDeg }, PARK_SPEED_SLOW_DEG_S);
        return `${r}; ${rot}`;
      }
      return this.moveToNow(PARK, PARK_SPEED_SLOW_DEG_S);
    });
  }

  /**
   * Move to absolute motor angles. A scope that is tracking or was left un-homed by an astro routine
   * is released and homed first, so a move always works. An out-of-range target moves nothing.
   */
  async moveTo(target: { rotationDeg?: number; pitchDeg?: number }, speedDegPerS = 10): Promise<string> {
    return this.core.guards.exclusive('moving the motors', () => this.moveToNow(target, speedDegPerS));
  }

  private async moveToNow(target: { rotationDeg?: number; pitchDeg?: number }, speedDegPerS: number): Promise<string> {
    const speed = Number.isFinite(speedDegPerS) ? Math.max(SPEED_MIN_DEG_S, Math.min(SPEED_MAX_DEG_S, speedDegPerS)) : PARK_SPEED_SLOW_DEG_S;
    const model = await this.model();
    if (model === 'mini' && target.rotationDeg !== undefined) {
      const [mMin, mMax] = MINI_ROTATION_RANGE;
      if (this.rotation.angle(this.core.location()) === undefined) throw new Error(`rotation ${target.rotationDeg}° cannot be driven to: ${miniRotationUnknown(this.rotation.get()?.lostTo)}. Turn it with nudge instead. Nothing was moved.`);
      if (!(target.rotationDeg >= mMin && target.rotationDeg <= mMax)) throw new Error(`rotation ${target.rotationDeg}° is out of range ${mMin}–${mMax}° (degrees from the power-on rotation; the base has no stop, the cable wraps beyond a turn). Nothing was moved.`);
    }
    const [pMin, pMax] = pitchRangeFor(model);
    const [rMin, rMax] = model === 'mini' ? MINI_ROTATION_RANGE : ROTATION_RANGE;
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
    if (target.rotationDeg !== undefined) {
      if (model === 'mini') {
        const from = this.rotation.angle(this.core.location());
        if (from === undefined) throw new Error(`pitch moved, rotation not: ${miniRotationUnknown(this.rotation.get()?.lostTo)}`);
        await this.turnMiniRotation(target.rotationDeg - from, speed);
      } else await this.runAxis(1, target.rotationDeg, speed, before.rotationDeg);
    }
    this.markMotion();
    const p = await this.readPositions();
    if (model === 'mini') return `${homed}now at pitch ${p.pitchDeg}°, ${this.miniRotationText()}`;
    return `${homed}now at rotation ${p.rotationDeg}°, pitch ${p.pitchDeg}°`;
  }

  /**
   * Joystick-style slew. angleDeg uses screen convention: 0 = up, 90 = right. The firmware uses math
   * convention (0 = right, 90 = up), verified on hardware: fw 0° pans right (rotation angle
   * decreases), fw 90° raises pitch. Speed 0..1 (≈ 30°/s at 1.0; 0.3 ≈ 9°/s). Always ends with a stop.
   */
  async nudge(angleDeg: number, speed: number, durationMs: number): Promise<void> {
    const { guards } = this.core;
    guards.assertNoOperation('slewing');
    guards.assertNoStackForMotion();
    if (!Number.isFinite(angleDeg) || !Number.isFinite(speed) || !Number.isFinite(durationMs)) throw new Error('slew: angle, speed and duration must be numbers');
    if (dwarfModel(this.core.store.state.device) === 'mini') return this.nudgeMini(angleDeg, speed, durationMs);
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

  /**
   * The mini's nudge: counted pulse moves instead of the joystick (which turns the base uncounted).
   * The call holds a lease on the slew for its duration; a nudge while one runs renews the lease and
   * sets the new direction and speed, and the motion goes on without a gap. Each call returns when its
   * own lease is over (the UI renews before that) or the slew stopped.
   */
  private async nudgeMini(angleDeg: number, speed: number, durationMs: number): Promise<void> {
    const rate = Math.max(NUDGE_MIN_SPEED, Math.min(1, speed)) * MINI_NUDGE_MAX_DEG_S;
    const a = (angleDeg * Math.PI) / 180;
    // screen convention: 0 = up (pitch up), 90 = right (the view pans right: rotation counts down)
    const rotDegS = Math.abs(Math.sin(a)) < 1e-9 ? 0 : -Math.sin(a) * rate;
    const pitchDegS = Math.abs(Math.cos(a)) < 1e-9 ? 0 : Math.cos(a) * rate;
    const until = Date.now() + Math.max(NUDGE_MIN_MS, Math.min(NUDGE_MAX_MS, durationMs));
    this.slew = { rotDegS, pitchDegS, until };
    if (!this.slewLoop) {
      const gen = this.nudgeGen;
      this.slewLoop = this.runMiniSlew(gen).finally(() => {
        this.slewLoop = null;
        if (this.nudgeGen === gen) this.slew = null;
      });
    }
    const loop = this.slewLoop;
    await Promise.race([loop, sleep(Math.max(0, until - Date.now()))]);
    // not renewed: this was the last lease, so the reply waits for the last pulse move to end
    if (this.slew?.until === until || !this.slew) await loop.catch(() => undefined);
  }

  private async runMiniSlew(gen: number): Promise<void> {
    const [pMin, pMax] = MINI_PITCH_RANGE;
    // where pitch is, followed through the moves (read again at the end)
    let pitch = this.core.store.state.motors.pitchDeg;
    try {
      while (gen === this.nudgeGen && this.slew && Date.now() < this.slew.until) {
        const { rotDegS, pitchDegS, until } = this.slew;
        const ms = Math.min(MINI_CHUNK_MS, Math.max(NUDGE_MIN_MS, until - Date.now()));
        const dRot = (rotDegS * ms) / 1000;
        let dPitch = (pitchDegS * ms) / 1000;
        // pitch stays inside its travel (pulse moves do not check it)
        if (pitch !== undefined) dPitch = Math.max(pMin - pitch, Math.min(pMax - pitch, dPitch));
        const moves: Array<Promise<void>> = [];
        if (Math.abs(dRot) >= PULSE_DEG) moves.push(this.pulseAxis(1, dRot, Math.abs(rotDegS)));
        if (Math.abs(dPitch) >= PULSE_DEG) moves.push(this.pulseAxis(2, dPitch, Math.abs(pitchDegS)));
        if (!moves.length) break;
        await Promise.all(moves);
        if (pitch !== undefined) pitch += Math.round(dPitch / PULSE_DEG) * PULSE_DEG;
      }
    } finally {
      this.markMotion();
      await this.readPositions().catch(() => null);
    }
  }

  async stopMotion(): Promise<void> {
    this.nudgeGen++; // any nudge loop still running ends before its next vector
    if (dwarfModel(this.core.store.state.device) === 'mini') {
      // the pulse move running finishes (a cut one's count would be unknown): at most MINI_CHUNK_MS
      this.slew = null;
      await Promise.all([this.pulseChain[1], this.pulseChain[2], this.slewLoop]).catch(() => undefined);
      await sendStop(this.core, Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP, STOP_MS);
      return;
    }
    await sendStop(this.core, Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP, STOP_MS);
    for (const id of [1, 2]) await request(this.core, Cmd.STEP_MOTOR_STOP, { id }, { bestEffort: true, timeout: STOP_MS }).catch(() => null);
  }
}
