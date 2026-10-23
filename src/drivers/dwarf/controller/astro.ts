/**
 * Astronomy: plate-solve calibration, GoTo (on a calibration, or one-click), pointing recovery
 * after a failed routine, Sun/Moon tracking, polar alignment, astro service recovery, and the
 * daytime tracker and sentry mode.
 */
import * as sky from '../../../astro/sky.js';
import { config } from '../../../config.js';
import { errMsg, logger } from '../../../log.js';
import * as http from '../http.js';
import { isLinkFailure } from '../link.js';
import { Cmd, SOLAR_SYSTEM_INDEX, errorText } from '../protocol.js';
import type { CameraName } from '../stacking.js';
import type { CameraControl } from './camera.js';
import { isTracking, request, sendConfirmed, sendStop, trackingSince, type Core } from './core.js';
import { AstroServiceHungError, RefusedError, STOPPED_BY_REQUEST, type Routines } from './follow.js';
import type { Motors } from './motors.js';
import type { SystemControl } from './system.js';
import { astroState, camId, opState, sleep } from './util.js';

const log = logger('dwarf');

/**
 * Plate solving needs stars: with the Sun up a calibration, a one-click GoTo or a polar alignment
 * runs its whole routine and fails (-11504 on 2026-10-12, minutes of motion for nothing). The
 * refusal names when the sky is next dark enough; null when the Sun is down.
 */
export function daylightRefusal(what: string, site: sky.Site, when: Date, tz: string): string | null {
  const sunAlt = sky.bodyAlt(site, 'Sun', when);
  if (!(sunAlt > 0)) return null;
  const dusk = sky.fmtTime(sky.nightWindow(site, when).civilDusk, tz);
  return `${what} plate-solves the stars, and the Sun is up (altitude ${sunAlt.toFixed(1)}°): it cannot succeed until after sunset${dusk ? ` (civil dusk ${dusk})` : ''}. Nothing was moved.`;
}

const STOP_MS = 5000;
const RECOVERY_STOP_MS = 3000;
/** after a failed routine is stopped, the motor controller takes a while to release the axes */
const RECOVERY_RELEASE_MS = 5000;
/** the speed of the move back to the pointing before a failed routine */
const RECOVERY_SPEED_DEG_S = 15;
/** Sun/Moon tracking starts with a slew: its reply (or tracking) can take minutes */
const SPECIAL_TRACK_REPLY_MS = 180_000;
const SPECIAL_TRACK_CONFIRM_MS = 30_000;
/** the astro recovery: each step's reply, and the pauses after the stops and after going live */
const RECOVERY_STEP_MS = 5000;
const RECOVERY_PAUSE_MS = 2000;
const ENTER_CAMERA_MS = 8000;
/** the daytime tracker reports a lock within this, or never */
const TRACK_LOCK_MS = 8000;
const TRACK_START_MS = 3000;
/** how long a sentry start may go without any sentry state before the telescope is taken not to have the mode */
const SENTRY_ANSWER_MS = 30_000;
/** pitch 90° is the horizon */
const HORIZON_PITCH_DEG = 90;

export interface PolarError {
  azimuthErrorDeg: number;
  altitudeErrorDeg: number;
}

export class AstroControl {
  constructor(
    private readonly core: Core,
    private readonly routines: Routines,
    private readonly camera: CameraControl,
    private readonly motors: Motors,
    private readonly system: SystemControl,
  ) {}

  private get state() {
    return this.core.store.state;
  }

  private get timing() {
    return this.routines.astroTiming;
  }

  /**
   * Everything that slews the mount (calibration, GoTo, Sun/Moon tracking): refused with the ND
   * filter fitted, under a running or starting stack (it smears every following sub), and while
   * another caller's operation runs.
   */
  private assertDark(what: string, site: sky.Site, hint = ''): void {
    const refusal = daylightRefusal(what, site, this.timing.now(), config.observer.timezone);
    if (refusal) throw new RefusedError(refusal + hint);
  }

  private assertMayMove(what: string): void {
    const { guards } = this.core;
    guards.assertNoNdLock(what);
    guards.assertNoOperation(what);
    guards.assertNoStackForMotion();
  }

  /**
   * Plate-solve calibration. Followed through the telescope's notifications: a calibrationResult
   * is success; the calibration state ending without one is failure; an error reply fails at once.
   */
  async calibrate(): Promise<string> {
    this.assertMayMove('plate-solve calibration');
    const loc = this.core.requireLocation();
    this.assertDark('calibration', loc);
    await this.camera.ensureMode('DSO');
    const t = this.timing;
    let ran = false;
    const solves = () => this.state.calibration.plateSolvingTimes ?? '?';
    const resultSince = (t0: number) => (this.state.calibration.at ?? 0) >= t0;
    return this.routines.follow({
      what: 'calibration',
      cmd: Cmd.ASTRO_START_CALIBRATION,
      params: { lon: loc.lon, lat: loc.lat },
      totalMs: t.calibrationMs,
      stopCmds: [Cmd.ASTRO_STOP_CALIBRATION],
      // a success reply may be only the start's acknowledgement: the notifications decide
      onReply: (_r, c) => {
        if (resultSince(c.t0)) c.finish(null);
      },
      onNotify: (n, c) => {
        if (n.name === 'calibrationResult') c.finish(null);
        else if (n.name === 'calibrationState') {
          const st = astroState(n.data.state);
          if (st === 'running' || st === 'plate_solving') ran = true;
          // the result can trail the state change by a moment
          else if (ran && (st === 'stopped' || st === 'idle')) {
            c.ended(t.calibrationEndGraceMs, () => (resultSince(c.t0) ? null : new Error(`calibration ended without a result after ${solves()} plate solve(s); plate-solving did not succeed at this pointing`)));
          }
        }
      },
      atDeadline: (c) =>
        resultSince(c.t0) ? null : new Error(`calibration did not finish within ${Math.round(t.calibrationMs / 60000)} min (state ${this.state.calibration.state}, ${this.state.calibration.plateSolvingTimes ?? 0} plate solve(s))`),
      done: (s) => {
        const r = this.state.calibration.result;
        return `calibration complete in ${s} s${r ? ` (azimuth ${r.azimuth.toFixed(2)}°, altitude ${r.altitude.toFixed(2)}°)` : ''}; plate solves: ${solves()}`;
      },
    });
  }

  /** GoTo a deep-sky position (RA hours, Dec degrees). Requires a prior calibration unless oneClick. */
  async gotoRaDec(raHours: number, decDeg: number, name: string, oneClick: boolean): Promise<string> {
    this.assertMayMove('GoTo');
    // a missing location refuses before the mode switch
    const loc = oneClick ? this.core.requireLocation() : null;
    if (loc) this.assertDark(`the one-click GoTo to ${name}`, loc);
    await this.camera.ensureMode('DSO');
    if (loc) {
      const dso = await http.resolveShootingMode('DSO');
      return this.runOneClick(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, { ra: raHours, dec: decDeg, targetName: name, lon: loc.lon, lat: loc.lat, shootingMode: dso.id, gotoOnly: false }, name);
    }
    return this.runGoto(Cmd.ASTRO_START_GOTO_DSO, { ra: raHours * 15, dec: decDeg, targetName: name, gotoOnly: false }, name);
  }

  async gotoSolarSystem(body: string, oneClick: boolean): Promise<string> {
    this.assertMayMove('GoTo');
    const key = body.trim().toLowerCase();
    if (!Object.hasOwn(SOLAR_SYSTEM_INDEX, key)) throw new Error(`unknown solar system body "${body}" (${Object.keys(SOLAR_SYSTEM_INDEX).join(', ')})`);
    const index = SOLAR_SYSTEM_INDEX[key];
    const loc = this.core.requireLocation();
    const pretty = key[0].toUpperCase() + key.slice(1);
    if (oneClick) {
      this.assertDark(`the one-click GoTo to ${pretty}`, loc, pretty === 'Moon' ? ' For the Moon in daylight use track_sun_moon.' : '');
      const mode = await http.resolveShootingMode(pretty === 'Moon' ? 'Moon' : pretty === 'Sun' ? 'Sun' : 'Planet');
      await this.camera.ensureMode(mode.name);
      return this.runOneClick(Cmd.ASTRO_START_ONE_CLICK_GOTO_SOLAR_SYSTEM, { index, lon: loc.lon, lat: loc.lat, targetName: pretty, shootingMode: mode.id, forceStart: false }, pretty);
    }
    return this.runGoto(Cmd.ASTRO_START_GOTO_SOLAR_SYSTEM, { index, lon: loc.lon, lat: loc.lat, targetName: pretty, forceStart: false }, pretty);
  }

  /**
   * GoTo on an existing calibration. Complete = tracking reported after the start; failed = an
   * error reply, the GoTo state ending without tracking, or silence.
   */
  private runGoto(cmd: number, params: Record<string, unknown>, name: string): Promise<string> {
    const t = this.timing;
    let ran = false;
    return this.routines.follow({
      what: `GoTo ${name}`,
      cmd,
      params,
      totalMs: t.gotoMs,
      stopCmds: [Cmd.ASTRO_STOP_GOTO],
      onReply: (_r, c) => {
        if (trackingSince(this.state, c.t0)) c.finish(null);
      },
      onNotify: (n, c) => {
        if (n.name === 'trackingState' && astroState(n.data.state) === 'running') c.finish(null);
        else if (n.name === 'gotoState') {
          const st = astroState(n.data.state);
          if (st === 'running') ran = true;
          else if (ran && (st === 'stopped' || st === 'idle')) {
            c.ended(t.gotoEndGraceMs, () => (trackingSince(this.state, c.t0) ? null : new Error(`GoTo ${name} ended without tracking (GoTo state ${st})`)));
          }
        }
      },
      atDeadline: (c) => (trackingSince(this.state, c.t0) ? null : new Error(`GoTo ${name} did not reach tracking within ${Math.round(t.gotoMs / 60000)} min (GoTo state ${this.state.goto.state})`)),
      done: (s) => `GoTo ${name} complete in ${s} s; now tracking ${name}`,
    });
  }

  /**
   * One-click GoTo: calibrate (plate-solve), slew, refine, track. Verified 2026-10-04 on fw 1.5.3:
   * the telescope reports its progress as oneClickGotoState notifications and reached tracking
   * (M 31, 04:23) without ever sending an allEnd reply. Complete = tracking (or allEnd).
   */
  private runOneClick(cmd: number, params: Record<string, unknown>, name: string): Promise<string> {
    const steps: string[] = [];
    let lastStage = '';
    const gotoMs = this.timing.gotoMs;
    return this.routines.follow({
      what: `one-click GoTo ${name}`,
      cmd,
      params,
      totalMs: gotoMs,
      stopCmds: [Cmd.ASTRO_STOP_ONE_CLICK_GOTO],
      onReply: (r, c) => {
        steps.push(`step ${r.step ?? '?'}`);
        log.info(`one-click GoTo ${name}: reply step ${r.step ?? '?'}${r.allEnd ? ' (all end)' : ''}`);
        if (r.allEnd) c.finish(null);
      },
      onNotify: (n, c) => {
        if (n.name === 'oneClickGotoState') {
          const d = n.data as Record<string, any>;
          const key = ['astroTrackingState', 'astroAutoFocusState', 'astroGotoState', 'astroCalibrationState'].find((k) => d[k]);
          if (!key) return;
          const stage = `${key.replace(/^astro|State$/g, '')} ${astroState(d[key].state)}`;
          if (stage !== lastStage) {
            lastStage = stage;
            steps.push(stage);
            log.info(`one-click GoTo ${name}: ${stage} (${Math.round((Date.now() - c.t0) / 1000)} s)`);
          }
          if (key === 'astroTrackingState' && astroState(d[key].state) === 'running') c.finish(null);
        } else if (n.name === 'trackingState' && astroState(n.data.state) === 'running') {
          c.finish(null);
        }
      },
      atDeadline: (c) =>
        trackingSince(this.state, c.t0) ? null : new Error(`one-click GoTo ${name} timed out after ${Math.round(gotoMs / 60000)} min without reaching tracking (last stage: ${lastStage || 'none reported'})`),
      done: (s) => `one-click GoTo ${name} complete in ${s} s (${steps.join(' → ')}); now tracking ${name}`,
    });
  }

  /** Stop any GoTo, and end the wait of a running calibration/GoTo at once. */
  async stopGoto(): Promise<void> {
    await sendStop(this.core, Cmd.ASTRO_STOP_GOTO, STOP_MS);
    await sendStop(this.core, Cmd.ASTRO_STOP_ONE_CLICK_GOTO, STOP_MS);
    this.routines.failAll(new Error(STOPPED_BY_REQUEST));
  }

  /**
   * Run an astro routine as the one operation, recovering the pointing if it fails with the scope
   * moved or the motors un-homed (a failed calibration resets pitch and leaves the axes in "need
   * reset", -14520): re-home if needed, return to the pointing before, rethrow with what was done.
   */
  async withPointingRecovery<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.core.guards.exclusive(label, () => this.withPointingRecoveryNow(label, fn));
  }

  private async withPointingRecoveryNow<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const before = await this.motors.readPositions().catch(() => null);
    try {
      return await fn();
    } catch (err) {
      throw await this.recoverPointing(label, err, before);
    } finally {
      await this.camera.restoreWideLiveView();
    }
  }

  private async recoverPointing(label: string, err: unknown, before: Awaited<ReturnType<Motors['readPositions']>> | null): Promise<unknown> {
    const msg = errMsg(err);
    // the operator stopped it: leave the scope where it stopped
    if (msg.includes(STOPPED_BY_REQUEST)) return err;
    // refused before anything was sent: nothing moved, nothing to recover
    if (err instanceof RefusedError) return err;
    // a hung astro service executes no recovery either, and moves could land once it wakes up
    if (err instanceof AstroServiceHungError) return err;
    // unreachable or hung: every recovery command would fail too, and moving a scope we cannot
    // see could undo a GoTo the telescope is still carrying out
    if (isLinkFailure(err) || !this.core.link.usable) {
      return new Error(`${msg}. No pointing recovery was attempted (the telescope is not executing commands); once it answers again, check telescope_status before deciding what happened.`);
    }
    // A GoTo that ends up tracking reached its target: leave the scope exactly where it is
    // (tracking also makes the motors report "not homed", which is not a failure).
    if (isTracking(this.state)) {
      await this.camera.restoreWideLiveView();
      return new Error(`${msg}. The telescope is tracking now, so the pointing was left as is; check the frame (view_camera source=tele, exposure_s=2) before deciding it failed.`);
    }
    await this.camera.restoreWideLiveView();
    // the failed routine must let go of the motors before they are touched
    await sendStop(this.core, Cmd.ASTRO_STOP_ONE_CLICK_GOTO, RECOVERY_STOP_MS);
    await sendStop(this.core, Cmd.ASTRO_STOP_CALIBRATION, RECOVERY_STOP_MS);
    await sleep(RECOVERY_RELEASE_MS);
    const after = await this.motors.readPositions().catch(() => null);
    const back = before?.homed && before.pitchDeg !== undefined && before.rotationDeg !== undefined ? { rotationDeg: before.rotationDeg, pitchDeg: before.pitchDeg } : null;
    let recovery = '';
    if (after && !after.homed) {
      try {
        await this.motors.home();
        if (back) {
          await this.motors.moveTo(back, RECOVERY_SPEED_DEG_S);
          recovery = ` The failed ${label} left the motors un-homed; I re-homed them and returned to the previous pointing (rotation ${back.rotationDeg}°, pitch ${back.pitchDeg}°).`;
        } else {
          recovery = ` The failed ${label} left the motors un-homed; I re-homed them (now pointing down — raise with move_motors).`;
        }
      } catch (e) {
        recovery = ` The failed ${label} left the motors un-homed and automatic re-homing failed (${errMsg(e)}); run motors_home.`;
      }
    } else if (after?.pitchDeg !== undefined && back) {
      // the firmware's plate-solve sequence leaves the scope wherever it gave up (often pointing at the ground)
      try {
        await this.motors.moveTo(back, RECOVERY_SPEED_DEG_S);
        recovery = ` The failed ${label} had left the scope at rotation ${after.rotationDeg}°, pitch ${after.pitchDeg}°; I returned it to the previous pointing (rotation ${back.rotationDeg}°, pitch ${back.pitchDeg}°).`;
      } catch (e) {
        recovery = ` Scope is at rotation ${after.rotationDeg}°, pitch ${after.pitchDeg}° (altitude ≈ ${Math.round(after.pitchDeg - HORIZON_PITCH_DEG)}°); returning to the previous pointing failed (${errMsg(e)}).`;
      }
    }
    return new Error(`${msg}.${recovery}`);
  }

  async trackSunMoon(body: 'sun' | 'moon', action: 'start' | 'stop'): Promise<void> {
    if (action === 'stop') {
      await sendConfirmed(this.core, Cmd.ASTRO_STOP_TRACK_SPECIAL_TARGET, {}, `stop ${body} tracking`, { confirm: () => !isTracking(this.state) });
      return;
    }
    this.assertMayMove('Sun/Moon tracking');
    const loc = this.core.requireLocation();
    // the reply may come only once it tracks (or never): tracking in the state also confirms
    await sendConfirmed(this.core, Cmd.ASTRO_START_TRACK_SPECIAL_TARGET, { index: body === 'sun' ? 0 : 1, lon: loc.lon, lat: loc.lat }, `${body} tracking`, {
      timeout: SPECIAL_TRACK_REPLY_MS,
      confirmMs: SPECIAL_TRACK_CONFIRM_MS,
      confirm: () => isTracking(this.state),
    });
  }

  /** EQ-mode polar alignment measurement: the polar axis error. */
  async measurePolarAlignment(): Promise<PolarError> {
    const loc = this.core.location();
    if (loc) this.assertDark('polar alignment', loc);
    return this.core.guards.exclusive('polar alignment', () => this.measurePolarAlignmentNow());
  }

  private async measurePolarAlignmentNow(): Promise<PolarError> {
    this.core.guards.assertNoNdLock('polar alignment');
    // the solve rotates the mount between its plate solves
    this.core.guards.assertNoStackForMotion();
    const loc = this.core.requireLocation();
    const t = this.timing;
    let res: PolarError | undefined;
    let ran = false;
    await this.routines.follow({
      what: 'polar alignment',
      cmd: Cmd.ASTRO_START_EQ_SOLVING,
      params: { lon: loc.lon, lat: loc.lat },
      totalMs: t.eqSolvingMs,
      stopCmds: [Cmd.ASTRO_STOP_EQ_SOLVING],
      activity: new Set(['eqSolvingState']),
      // the result comes in the reply, when the solve has finished; a reply without the errors is only
      // the start's acknowledgement (proto3 omits a 0, so one of the two is enough)
      onReply: (r, c) => {
        if (r.aziErr === undefined && r.altErr === undefined) return;
        const azimuthErrorDeg = Number(r.aziErr ?? 0);
        const altitudeErrorDeg = Number(r.altErr ?? 0);
        if (!Number.isFinite(azimuthErrorDeg) || !Number.isFinite(altitudeErrorDeg)) return c.finish(new Error(`polar alignment replied with an unreadable result (${JSON.stringify(r)})`));
        res = { azimuthErrorDeg, altitudeErrorDeg };
        c.finish(null);
      },
      onNotify: (n, c) => {
        if (n.name !== 'eqSolvingState') return;
        const st = opState(n.data.state);
        if (st === 'running') ran = true;
        else if (ran && (st === 'stopped' || st === 'idle')) {
          c.ended(t.gotoEndGraceMs, () => (res ? null : new Error(`polar alignment ended (state ${st}) without a result: the plate solves did not succeed (stars in the tele view? clouds?)`)));
        }
      },
      atDeadline: () => new Error(`polar alignment gave no result within ${Math.round(t.eqSolvingMs / 60000)} min`),
      done: () => '',
    });
    if (!res) throw new Error('polar alignment ended without a result');
    this.core.store.publish({ eqSolving: { state: 'idle', result: { ...res, at: Date.now() } } });
    return res;
  }

  async stopPolarAlignment(): Promise<void> {
    await sendStop(this.core, Cmd.ASTRO_STOP_EQ_SOLVING, STOP_MS);
  }

  /**
   * Release an astro service that refuses everything with -11501 ASTRO_FUNCTION_BUSY although
   * nothing is running (2026-10-11 00:13: after the firmware's own limit stop and failed re-GoTo,
   * GoTo, mode switches and photos all failed until a power cycle). Every astro stop the firmware
   * knows, then "go live" (what the DWARF app sends to leave a finished stack's view), the camera
   * re-entered, and the motors re-homed if they lost their reference. None of these are verified
   * to clear that state: the caller judges by retrying what was refused. Power cycling stays the
   * last resort.
   */
  async recoverAstroService(o: { rehome?: boolean } = {}): Promise<{ steps: string[] }> {
    return this.core.guards.exclusive('recovering the astro service', () => this.recoverAstroServiceNow(o));
  }

  private async recoverAstroServiceNow(o: { rehome?: boolean }): Promise<{ steps: string[] }> {
    const { link, stacks } = this.core;
    if (stacks.owns('tele') || stacks.owns('wide')) {
      throw new Error('refused: live stacking is running or starting; stop it first (live_stacking action=stop) — the recovery stops every astro function');
    }
    if (this.state.darkCapture?.state === 'running') {
      throw new Error('refused: a dark capture is running; the recovery re-enters the camera and would spoil the master. Wait for it or stop it first (dark_frames action=stop).');
    }
    // a telescope that executes nothing would let every step time out (about a minute) and change nothing
    if (!link.usable) {
      const ls = link.health().state;
      throw new Error(
        `refused: the telescope is not executing commands (link ${ls}), so no recovery step could reach it. ${ls === 'unresponsive' ? 'Its command service has hung: it needs a physical power cycle.' : 'Wait for the connection to come back.'}`,
      );
    }
    const steps: string[] = [];
    const send = async (cmd: number, label: string) => {
      try {
        const r = await request(this.core, cmd, {}, { bestEffort: true, allowError: true, timeout: RECOVERY_STEP_MS });
        const code = Number(r?.code ?? 0);
        steps.push(`${label}: ${!r ? 'no reply' : code < 0 ? errorText(code) : 'ok'}`);
      } catch (e) {
        steps.push(`${label}: ${errMsg(e)}`);
      }
    };
    await send(Cmd.ASTRO_FAST_STOP_CAPTURE_RAW_LIVE_STACKING, 'fast stop tele stacking');
    await send(Cmd.ASTRO_FAST_STOP_WIDE_CAPTURE_LIVE_STACKING, 'fast stop wide stacking');
    await send(Cmd.ASTRO_STOP_RESTACKED, 'stop restack');
    await send(Cmd.ASTRO_STOP_MAKE_FITS_THUMB, 'stop FITS thumbnails');
    await send(Cmd.ASTRO_STOP_ONE_CLICK_GOTO, 'stop one-click GoTo');
    await send(Cmd.ASTRO_STOP_GOTO, 'stop GoTo');
    await send(Cmd.ASTRO_STOP_CALIBRATION, 'stop calibration');
    await send(Cmd.ASTRO_STOP_TRACK_SPECIAL_TARGET, 'stop special tracking');
    await send(Cmd.ASTRO_STOP_SKY_TARGET_FINDER, 'stop sky target finder');
    await send(Cmd.ASTRO_STOP_EQ_SOLVING, 'stop EQ solving');
    await sleep(RECOVERY_PAUSE_MS);
    await send(Cmd.ASTRO_GO_LIVE, 'tele go live');
    await send(Cmd.ASTRO_WIDE_GO_LIVE, 'wide go live');
    await sleep(RECOVERY_PAUSE_MS);
    const r = await request(this.core, Cmd.TASK_MANAGER_ENTER_CAMERA, { clientParam: { encodeType: 1 } }, { timeout: ENTER_CAMERA_MS, allowError: true, bestEffort: true }).catch(() => null);
    steps.push(`enter camera: ${r ? 'ok' : 'no reply'}`);
    this.camera.noteLiveViewWoken();
    await this.system.refreshState().catch(() => {});
    const m = await this.motors.readPositions().catch(() => null);
    if (m && (!m.homed || o.rehome) && !this.state.ndLock) {
      try {
        steps.push(await this.motors.homeNow());
      } catch (e) {
        steps.push(`homing failed: ${errMsg(e)}`);
      }
    }
    // not verified here: the caller retries what was refused and records the outcome
    this.core.store.publish({ astroRecovery: { at: Date.now(), ok: undefined, steps } });
    log.info(`astro service recovery: ${steps.join('; ')}`);
    return { steps };
  }

  // ---- daytime -------------------------------------------------------------

  async trackObject(camera: CameraName, box: { x: number; y: number; w: number; h: number }): Promise<void> {
    this.core.guards.assertNoNdLock('object tracking');
    this.core.guards.assertNoOperation('object tracking');
    this.core.guards.assertNoStackForMotion();
    // a lock is a track result with a box on the frame; (-100,-100) is the tracker reporting it has lost it
    const locked = (d: Record<string, unknown>) => Number(d.x) >= 0 && Number(d.y) >= 0;
    const started = this.core.link.waitFor((n) => /trackResult$/i.test(n.name) && locked(n.data), TRACK_LOCK_MS).catch(() => null);
    // fw 1.5.3.9 answers 14800 only when the tracker gives up (2026-10-12: a lock, then lost,
    // then -14901 TRACKER_FAILED within a second); while it keeps the lock there is no reply
    const reply = await request(this.core, Cmd.TRACK_START_TRACK, { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), camId: camId(camera) }, { bestEffort: true, timeout: TRACK_START_MS });
    const code = Number(reply?.code ?? 0);
    if (code < 0) throw new Error(`the tracker could not hold the subject (${errorText(code)}): give it a box tightly around one distinct subject with contrast against its background`);
    if (!(await started)) throw new Error(`tracker did not report a lock within ${TRACK_LOCK_MS / 1000} s — check the box covers the subject`);
  }

  async stopTracking(): Promise<void> {
    // fw 1.5.3.9 never answers 14801; the tracker reports itself stopped within a few tens of ms
    const stopped = () => !this.state.objectTracking || ['idle', 'stopped'].includes(this.state.objectTracking.state);
    await sendConfirmed(this.core, Cmd.TRACK_STOP_TRACK, {}, 'stop tracking', { timeout: STOP_MS, confirm: stopped, confirmEarly: true });
  }

  async sentry(action: 'start' | 'stop', type = 0): Promise<void> {
    if (action === 'stop') {
      await sendConfirmed(this.core, Cmd.SENTRY_MODE_STOP, {}, 'stop sentry mode', { confirm: () => !this.state.sentry || this.state.sentry.state === 'idle' });
      return;
    }
    this.core.guards.assertNoNdLock('sentry mode');
    this.core.guards.assertNoOperation('sentry mode');
    this.core.guards.assertNoStackForMotion();
    const answered = this.core.link.waitFor((n) => n.name === 'sentryState', SENTRY_ANSWER_MS).then(() => true, () => false);
    try {
      await sendConfirmed(this.core, Cmd.SENTRY_MODE_START, { type }, 'start sentry mode', { confirm: () => !!this.state.sentry && this.state.sentry.state !== 'idle' });
    } catch (err) {
      // 2026-10-12 (DWARF 3, fw 1.5.3.9): neither 14802 nor 14806 (UFO) gets a reply or any sentry
      // state, in DSO or in Auto Tracking mode: the firmware does not have it
      if (!(await answered) && !this.state.sentry) throw new Error(`sentry mode is not available on this telescope (firmware ${this.state.device?.firmware ?? '?'}): it neither answered the start nor reported a sentry state. Use track_object to follow one subject instead.`);
      throw err;
    }
  }
}
