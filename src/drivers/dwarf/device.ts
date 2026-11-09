/**
 * The Dwarf 3 as the rest of the application sees it: the dwarf driver's TelescopeDevice. This
 * class only wires the controller components together (src/drivers/dwarf/controller/) and
 * presents them as one device:
 *
 *   state.ts     published state and the pure notification reducer
 *   guards.ts    what may run now (one operation at a time, camera ownership by stacks, ND lock)
 *   system.ts    state/device reads, clock and location, power
 *   camera.ts    shooting modes, live view, camera settings, stills/burst/video/timelapse
 *   motors.ts    homing, absolute moves, joystick slews
 *   focuser.ts   counted focus steps, position read-back, autofocus
 *   follow.ts    following a routine (calibration, GoTo, autofocus) to its end
 *   astro.ts     calibration, GoTo, pointing recovery, tracking, polar alignment, astro recovery
 *   stacking-control.ts  stack preparation, start confirmation, stop
 *   darks.ts     dark masters
 *   extras.ts    the device switches the SDK never registered (anti-tangle, defog, cooling, shutdown)
 *
 * Events: 'state' (TelescopeState, throttled), 'notification' (Notification), 'stackProgress'
 * (cam, info), 'stackHealth' (cam, health, prev), 'released'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, observerLocation, requireObserverLocation } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { writeFileAtomic } from '../../util/fs.js';
import { gate } from './gate.js';
import { forgetDevice } from './http.js';
import { DwarfLink, type LinkTiming, type Notification, type RequestOptions } from './link.js';
import { protoTypeByName } from './protocol.js';
import { StackTracker, type CameraName, type StackHealth, type StackingInfo } from './stacking.js';
import { AstroControl } from './controller/astro.js';
import { CameraControl, type ShootingTech } from './controller/camera.js';
import { busyWith, isTracking, request, type Core, type Location } from './controller/core.js';
import { Darks, type DarkRequest } from './controller/darks.js';
import { DeviceExtrasControl } from './controller/extras.js';
import { Focuser } from './controller/focuser.js';
import { Routines } from './controller/follow.js';
import { Guards } from './controller/guards.js';
import { Motors, PITCH_RANGE, ROTATION_RANGE } from './controller/motors.js';
import { StackingControl, type StackRequest } from './controller/stacking-control.js';
import { applyNotification, StateStore, type ParamCache, type TelescopeState } from './controller/state.js';
import { SystemControl, type PowerAction } from './controller/system.js';
import { sleep } from './controller/util.js';
import { SafeEmitter } from '../../util/events.js';
import type { TelescopeDevice } from '../types.js';

export type { CameraName, StackingInfo, StackHealth };
export type { TelescopeState, FocusTune, DarkCaptureState, HorizonSurvey, PolarAlign } from './controller/state.js';
export type { PolarError } from './controller/astro.js';
export { AstroServiceHungError } from './controller/follow.js';
export { BURST_MAX } from './controller/camera.js';
export { FOCUS_MAX, FILTERS, WB_SCENES, camId, round, timezoneOffsetHours } from './controller/util.js';

const log = logger('dwarf');

const STACK_NOTIFICATIONS = new Set(['teleStackingState', 'wideStackingState', 'teleStackingProgress', 'wideStackingProgress']);
/** state read cadence, and the mount-angle poll (angles change during GoTo/tracking without notifications) */
const STATE_POLL_MS = 30_000;
const MOTOR_POLL_MS = 15_000;
const MOTOR_POLL_BUSY_MS = 60_000;
/** background traffic waits this long after an operation ends */
const AFTER_OPERATION_QUIET_MS = 5_000;
/** after a connect, the telescope reports a running stack or GoTo in the notifications that follow within this */
const CONNECT_SETTLE_MS = 3000;
/** default reply timeout of raw() */
const RAW_TIMEOUT_MS = 15_000;

export class Dwarf extends SafeEmitter implements TelescopeDevice {
  readonly driver = 'dwarf' as const;
  /** mechanical travel of the axes (degrees) */
  static readonly PITCH_RANGE = PITCH_RANGE;
  static readonly ROTATION_RANGE = ROTATION_RANGE;

  readonly link: DwarfLink;
  readonly stacks: StackTracker;
  /** The device switches the official SDK never registered: anti-tangle, defog, cooling, shutdown, power sound, do-not-disturb. */
  readonly extras: DeviceExtrasControl;
  /** Live parameter values keyed by packed paramId (decimal string). */
  readonly params: ParamCache = new Map();
  /** Overrides from the agent/UI for this run (falls back to .env). */
  locationOverride: Location | null = null;

  private readonly store: StateStore;
  private readonly guards: Guards;
  private readonly core: Core;
  private readonly system: SystemControl;
  private readonly camera: CameraControl;
  private readonly motors: Motors;
  private readonly routines: Routines;
  private readonly focuser: Focuser;
  private readonly astro: AstroControl;
  private readonly stacking: StackingControl;
  private readonly darks: Darks;

  private readonly releasedFile = path.join(config.paths.data, 'released.json');
  private stateTimer: NodeJS.Timeout | null = null;
  /** the post-connect resync in flight ('connected' and 'responsive' can both start one) */
  private resync: Promise<void> | null = null;
  private motorTimer: NodeJS.Timeout | null = null;

  constructor(o: { host?: string; port?: number; linkTiming?: Partial<LinkTiming> } = {}) {
    super();
    this.link = new DwarfLink(o.host ?? config.dwarf.host, o.port ?? config.dwarf.wsPort, o.linkTiming);
    /** each camera's sub exposure at its stack start (the tracker's stall timing) */
    const exposureAtStart: Partial<Record<CameraName, number>> = {};
    this.stacks = new StackTracker(Date.now, (cam) => exposureAtStart[cam]);
    this.store = new StateStore((st) => this.emit('state', st));
    this.store.state.stacking = this.stacks.info;
    this.guards = new Guards(this.store, this.stacks, path.join(config.paths.data, 'nd-lock.json'));

    const self = this;
    this.core = {
      link: this.link,
      store: this.store,
      params: this.params,
      guards: this.guards,
      stacks: this.stacks,
      location: () => self.locationOverride ?? observerLocation(),
      requireLocation: () => self.locationOverride ?? requireObserverLocation(),
      lastDropAt: 0,
      lastMotionAt: 0,
    };
    this.system = new SystemControl(this.core);
    this.camera = new CameraControl(this.core, this.system);
    this.motors = new Motors(this.core);
    this.routines = new Routines(this.core);
    this.focuser = new Focuser(this.core, this.routines);
    this.astro = new AstroControl(this.core, this.routines, this.camera, this.motors, this.system);
    this.stacking = new StackingControl(this.core, this.camera, exposureAtStart);
    this.darks = new Darks(this.core);
  this.extras = new DeviceExtrasControl(this.core);

    this.stacks.on('progress', (cam: CameraName, info: StackingInfo) => this.emit('stackProgress', cam, info));
    this.stacks.on('health', (cam: CameraName, h: StackHealth, prev?: StackHealth) => {
      log.info(`${cam} stack health: ${prev?.verdict ?? 'none'} → ${h.verdict} (${h.windowStacked}/${h.windowTaken} recent frames stacked${h.frameIntervalS ? `, a frame every ${h.frameIntervalS} s` : ''})`);
      this.emit('stackHealth', cam, h, prev);
      this.store.changed();
    });
    this.stacks.on('state', () => this.store.changed());

    this.link.on('notification', (n: Notification) => this.onNotification(n));
    this.link.on('connected', () => {
      this.syncLink();
      if (this.link.usable) this.startResync();
    });
    this.link.on('disconnected', () => {
      this.core.lastDropAt = Date.now();
      this.syncLink();
    });
    this.link.on('health', () => this.syncLink());
    // back from a hang (after a power cycle): resync like a fresh connection
    this.link.on('responsive', () => {
      this.syncLink();
      this.startResync();
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  start(): void {
    if (this.stateTimer) return; // already started
    // a release survives a restart: the user may be using the DWARFLAB app
    gate.released = fs.existsSync(this.releasedFile);
    this.store.state.released = gate.released;
    if (gate.released) log.warn('the telescope is released (Disconnect in the web UI): not connecting until Connect is pressed');
    else this.link.start();
    this.stateTimer = setInterval(() => {
      if (this.link.usable && !this.quietPeriod()) void this.refreshState().catch(() => {});
      this.stacks.tick();
      // keep the published link health (ages, counts) current for the UI and the agent
      this.store.state.link = this.link.health();
    }, STATE_POLL_MS);
    // Not during operations: they read the positions themselves, and the firmware is busy moving.
    // During a capture (stacking, tracking) the angles change slowly: once a minute is plenty.
    let lastMotorPoll = 0;
    this.motorTimer = setInterval(() => {
      if (!this.link.usable || this.quietPeriod()) return;
      if ((this.isBusy() || this.isTracking()) && Date.now() - lastMotorPoll < MOTOR_POLL_BUSY_MS) return;
      lastMotorPoll = Date.now();
      void this.motors.readPositions().catch(() => {});
    }, MOTOR_POLL_MS);
    this.syncLink();
    if (!gate.released) void this.system.refreshDeviceInfo();
  }

  stop(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.motorTimer) clearInterval(this.motorTimer);
    this.stateTimer = this.motorTimer = null;
    this.link.stop();
  }

  /**
   * Disconnect button: close the control link and stop every other kind of traffic (HTTP, FTP,
   * video) so the telescope is free for another client, and stay that way until connectLink().
   */
  release(): void {
    gate.released = true;
    try {
      writeFileAtomic(this.releasedFile, JSON.stringify({ since: Date.now() }));
    } catch (e) {
      // released for this run regardless; only a restart would forget it
      log.warn(`could not record the release in ${this.releasedFile} (a restart reconnects): ${errMsg(e)}`);
    }
    this.link.stop();
    this.store.state.released = true;
    this.syncLink();
    log.info('telescope released by the user: control link closed, no traffic until Connect');
    this.emit('released');
  }

  /** Connect button: take the telescope back. */
  connectLink(): void {
    gate.released = false;
    try {
      fs.rmSync(this.releasedFile, { force: true });
    } catch (e) {
      // connected for this run regardless; a restart would come up released again
      log.warn(`could not clear the release in ${this.releasedFile} (a restart stays disconnected): ${errMsg(e)}`);
    }
    this.store.state.released = false;
    log.info('connecting to the telescope (Connect pressed)');
    this.link.start();
    this.syncLink();
  }

  /** Telescope address changed in the web UI: drop what we knew about the old device and reconnect there. */
  setHost(host: string): void {
    log.info(`telescope address set to ${host}${gate.released ? ' (released: connects when Connect is pressed)' : ''}`);
    this.store.state.device = {};
    this.store.state.storage = undefined;
    forgetDevice();
    this.link.retarget(host);
    this.store.changed();
  }

  /** Mirror the link into the published state; `connected` only while commands are executed. */
  private syncLink(): void {
    this.store.state.connected = this.link.usable;
    this.store.state.link = this.link.health();
    this.store.changed();
  }

  private startResync(): void {
    if (this.resync) return;
    this.resync = this.onConnected().finally(() => (this.resync = null));
  }

  private async onConnected(): Promise<void> {
    try {
      await this.system.refreshState();
      // the telescope reports a running stack/GoTo in the notifications that follow a connect
      await sleep(CONNECT_SETTLE_MS);
      await this.motors.readPositions().catch(() => {});
      // (un-homed motors alone are not a reason: a freshly powered telescope has them too and needs the sync)
      const busy = this.isBusy() ?? (this.isTracking() ? 'tracking' : null);
      if (busy) {
        // Reconnected in the middle of a capture or an operation: only read. Re-arming the cameras or
        // setting the clock under a running stack or tracking mount could disturb it.
        log.info(`connected while ${busy}: resync limited to reading the state (time/location not pushed)`);
        await this.system.refreshDeviceInfo();
        return;
      }
      if (config.dwarf.autoSyncTimeLocation) await this.system.syncTimeLocation().catch((e) => log.warn(`time/location sync failed: ${errMsg(e)}`));
      await this.system.refreshDeviceInfo();
      // Entering the camera makes the telescope (re)start its RTSP previews and broadcast every
      // current camera parameter, which primes the live settings cache.
      await this.camera.ensureLiveView(true).catch(() => {});
    } catch (err) {
      log.warn(`post-connect refresh failed: ${errMsg(err)}`);
    }
  }

  private onNotification(n: Notification): void {
    const st = this.store.state;
    const d = n.data as Record<string, any>;
    if (STACK_NOTIFICATIONS.has(n.name)) {
      st.lastNotificationAt = n.ts;
      // fw 1.5.3 reports a wide stack on the tele ids: the tracker sorts out which camera
      this.stacks.onNotification(n.name, d, n.ts);
    } else {
      const darkWas = st.darkCapture?.fwState;
      applyNotification(st, this.params, n);
      switch (n.name) {
        case 'shootingMode':
          if (typeof d.dstMode === 'number') {
            this.system
              .setModeState(d.dstMode)
              .then(() => this.store.changed())
              .catch((e) => log.warn(`could not read the new shooting mode ${d.dstMode}: ${errMsg(e)}`));
          }
          break;
        case 'darkCaptureState': {
          const fw = st.darkCapture?.fwState;
          log.info(`dark capture: firmware state ${fw}`);
          // the firmware leaving "running" is the end of a capture: confirm it from the saved master
          if (darkWas === 'running' && fw !== 'running') this.darks.onFirmwareEnded();
          break;
        }
        case 'powerOff':
          log.warn('telescope is powering off');
          this.core.lastDropAt = Date.now();
          break;
        case 'hostSlaveMode':
          // mode 1 = another client is the host and our commands are only observed
          log.info(`session role: ${Number(d.mode ?? 0) === 1 ? 'SLAVE (another client controls the telescope)' : 'host'}${d.lock ? ', locked' : ''}`);
          break;
      }
    }
    this.emit('notification', n);
    this.store.changed();
  }

  // ---- state ---------------------------------------------------------------

  get state(): TelescopeState {
    return this.store.state;
  }

  /** last time the mount moved: camera frames right after motion are corrupt for a few seconds */
  get lastMotionAt(): number {
    return this.core.lastMotionAt;
  }

  location(): Location | null {
    return this.core.location();
  }

  requireLocation(): Location {
    return this.core.requireLocation();
  }

  /** Throttled state-change broadcast for the UI. */
  changed(): void {
    this.store.changed();
  }

  /** Publish a state change made outside the notification path (a long operation's progress). */
  publishState(patch: Partial<TelescopeState>): void {
    this.store.publish(patch);
  }

  refreshState(): Promise<Record<string, unknown>> {
    return this.system.refreshState();
  }

  refreshDeviceInfo(): Promise<void> {
    return this.system.refreshDeviceInfo();
  }

  /** What the telescope (or the controller) is busy with, if anything. */
  isBusy(): string | null {
    return busyWith(this.core);
  }

  /** The scope is tracking a target (its motors then report "not homed", which is normal). */
  isTracking(): boolean {
    return isTracking(this.store.state);
  }

  // ---- guards --------------------------------------------------------------

  get operation(): string | null {
    return this.guards.operation;
  }

  exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.guards.exclusive(label, fn);
  }

  assertNoOperation(what: string): void {
    this.guards.assertNoOperation(what);
  }

  stackOwnsCamera(cam: CameraName): boolean {
    return this.guards.stackOwnsCamera(cam);
  }

  assertCameraFree(cam: CameraName, what: string): void {
    this.guards.assertCameraFree(cam, what);
  }

  setNdLock(on: boolean, note = ''): void {
    this.guards.setNdLock(on, note);
  }

  assertNoNdLock(what: string): void {
    this.guards.assertNoNdLock(what);
  }

  /** The controller may send commands of its own now: commands are executed and no long operation runs. */
  canAct(): boolean {
    return this.link.usable && !this.guards.operation;
  }

  /** Inside an operation (or just after one): the controller's own background traffic waits. */
  quietPeriod(): boolean {
    if (this.guards.operation) return true;
    const busy = this.isBusy();
    if (busy && busy !== 'live stacking') return true;
    return Date.now() - this.guards.lastOpEndedAt < AFTER_OPERATION_QUIET_MS;
  }

  // ---- commands ------------------------------------------------------------

  request(cmd: number, params: Record<string, unknown> = {}, opts?: RequestOptions) {
    return request(this.core, cmd, params, opts);
  }

  /** Escape hatch: send any command with an explicit proto type. */
  raw(cmd: number, params: Record<string, unknown>, reqType?: string, resType?: string, timeoutMs = RAW_TIMEOUT_MS) {
    return this.link.request(cmd, params, {
      reqType: reqType ? protoTypeByName(reqType) : undefined,
      resType: resType ? protoTypeByName(resType) : undefined,
      timeout: timeoutMs,
      allowError: true,
    });
  }

  syncTimeLocation(loc: Location | null = this.location()): Promise<string[]> {
    return this.system.syncTimeLocation(loc);
  }

  power(action: PowerAction): Promise<void> {
    return this.system.power(action);
  }

  // ---- camera --------------------------------------------------------------

  currentModeId(): Promise<number> {
    return this.camera.currentModeId();
  }

  setShootingMode(nameOrId: string | number) {
    return this.camera.setShootingMode(nameOrId);
  }

  ensureMode(name: string): Promise<void> {
    return this.camera.ensureMode(name);
  }

  setShootingTech(tech: ShootingTech): Promise<void> {
    return this.camera.setShootingTech(tech);
  }

  ensureLiveView(force = false): Promise<void> {
    return this.camera.ensureLiveView(force);
  }

  autoExposureForLiveView(cam: CameraName): Promise<number | 'unreported' | null> {
    return this.camera.autoExposureForLiveView(cam);
  }

  raiseLiveViewGain(cam: CameraName): Promise<{ from: number; to: number } | null> {
    return this.camera.raiseLiveViewGain(cam);
  }

  rearmLiveView(cam: CameraName): Promise<void> {
    return this.camera.rearmLiveView(cam);
  }

  restoreWideLiveView(): Promise<void> {
    return this.camera.restoreWideLiveView();
  }

  cameraSettings(camera: CameraName, modeId?: number) {
    return this.camera.cameraSettings(camera, modeId);
  }

  setSetting(camera: CameraName, setting: string, value: string | number | boolean, modeId?: number): Promise<string> {
    return this.camera.setSetting(camera, setting, value, modeId);
  }

  exposureSeconds(camera: CameraName): Promise<number | null> {
    return this.camera.exposureSeconds(camera);
  }

  takePhoto(camera: CameraName) {
    return this.camera.takePhoto(camera);
  }

  burst(camera: CameraName, count: number): Promise<string> {
    return this.camera.burst(camera, count);
  }

  record(camera: CameraName, action: 'start' | 'stop'): Promise<string> {
    return this.camera.record(camera, action);
  }

  timelapse(camera: CameraName, action: 'start' | 'stop', intervalS?: number, totalS?: number): Promise<string> {
    return this.camera.timelapse(camera, action, intervalS, totalS);
  }

  // ---- motors --------------------------------------------------------------

  readMotorPositions() {
    return this.motors.readPositions();
  }

  homeMotors(): Promise<string> {
    return this.motors.home();
  }

  moveTo(target: { rotationDeg?: number; pitchDeg?: number }, speedDegPerS = 10): Promise<string> {
    return this.motors.moveTo(target, speedDegPerS);
  }

  park(): Promise<string> {
    return this.motors.park();
  }

  /** Re-reference both axes where they stand, no park (inside a running operation). */
  rereferenceMotors() {
    return this.motors.rereferenceNow();
  }

  nudge(angleDeg: number, speed: number, durationMs: number): Promise<void> {
    return this.motors.nudge(angleDeg, speed, durationMs);
  }

  /** E-Stop: stop everything at once. Returns what could not be confirmed stopped. */
  async emergencyHalt(): Promise<string[]> {
    if (!this.link.usable) return ['the telescope is not connected'];
    const st = this.store.state;
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['motors', () => this.motors.stopMotion()],
      ['astro routines', () => this.astro.haltAll()],
    ];
    for (const cam of ['tele', 'wide'] as CameraName[]) {
      if (st.stacking[cam].state === 'running') steps.push([`${cam} stacking`, () => this.stopStacking(cam, true)]);
      if (st.capture.record === `${cam}:running`) steps.push([`${cam} recording`, () => this.record(cam, 'stop')]);
      if (st.capture.timelapse === `${cam}:running`) steps.push([`${cam} timelapse`, () => this.timelapse(cam, 'stop')]);
    }
    const results = await Promise.allSettled(steps.map(([, run]) => run()));
    return results.flatMap((r, i) => (r.status === 'rejected' ? [`${steps[i][0]}: ${errMsg(r.reason)}`] : []));
  }

  stopMotion(): Promise<void> {
    return this.motors.stopMotion();
  }

  // ---- focus ---------------------------------------------------------------

  get focusTiming() {
    return this.focuser.focusTiming;
  }

  get autofocusTiming() {
    return this.focuser.autofocusTiming;
  }

  focusTo(target: number, tolerance = 0): Promise<number> {
    return this.focuser.focusTo(target, tolerance);
  }

  focusStep(direction: 'near' | 'far', steps: number): Promise<string> {
    return this.focuser.focusStep(direction, steps);
  }

  settledFocusPosition(): Promise<number> {
    return this.focuser.settledPosition();
  }

  infinityFocusPosition(): Promise<number> {
    return this.focuser.infinityPosition();
  }

  autofocus(kind: 'normal' | 'astro', x?: number, y?: number): Promise<string> {
    return this.focuser.autofocus(kind, x, y);
  }

  // ---- astro ---------------------------------------------------------------

  get astroTiming() {
    return this.routines.astroTiming;
  }

  calibrate(): Promise<string> {
    return this.astro.calibrate();
  }

  startMosaic(o: { horizontalScale: number; verticalScale: number; rotation?: number; irIndex?: number }): Promise<void> {
    return this.astro.startMosaic(o);
  }

  gotoRaDec(raHours: number, decDeg: number, name: string, oneClick: boolean): Promise<string> {
    return this.astro.gotoRaDec(raHours, decDeg, name, oneClick);
  }

  gotoSolarSystem(body: string, oneClick: boolean): Promise<string> {
    return this.astro.gotoSolarSystem(body, oneClick);
  }

  stopGoto(): Promise<void> {
    return this.astro.stopGoto();
  }

  withPointingRecovery<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.astro.withPointingRecovery(label, fn);
  }

  trackSunMoon(body: 'sun' | 'moon', action: 'start' | 'stop'): Promise<void> {
    return this.astro.trackSunMoon(body, action);
  }

  measurePolarAlignment() {
    return this.astro.measurePolarAlignment();
  }

  stopPolarAlignment(): Promise<void> {
    return this.astro.stopPolarAlignment();
  }

  recoverAstroService(o: { rehome?: boolean } = {}): Promise<{ steps: string[] }> {
    return this.astro.recoverAstroService(o);
  }

  trackObject(camera: CameraName, box: { x: number; y: number; w: number; h: number }): Promise<void> {
    return this.astro.trackObject(camera, box);
  }

  stopTracking(): Promise<void> {
    return this.astro.stopTracking();
  }

  sentry(action: 'start' | 'stop', type = 0): Promise<void> {
    return this.astro.sentry(action, type);
  }

  // ---- live stacking -------------------------------------------------------

  get photoTiming() {
    return this.camera.photoTiming;
  }

  get stackTiming() {
    return this.stacking.stackTiming;
  }

  get stackRestartTiming() {
    return this.stacking.stackRestartTiming;
  }

  get stackControl() {
    return this.stacking.stackControl;
  }

  startStackingWith(camera: CameraName, o: StackRequest): Promise<string> {
    return this.stacking.startWith(camera, o);
  }

  startStacking(camera: CameraName, opts: { filterIndex?: number; force?: boolean } = {}): Promise<string> {
    return this.stacking.start(camera, opts);
  }

  stopStacking(camera: CameraName, fast = false): Promise<void> {
    return this.stacking.stop(camera, fast);
  }

  // ---- darks ---------------------------------------------------------------

  get darkTiming() {
    return this.darks.darkTiming;
  }

  /** Lists a folder on the SD card (FTP; tests replace it). */
  get listSdDir() {
    return this.darks.listSdDir;
  }

  set listSdDir(fn: Darks['listSdDir']) {
    this.darks.listSdDir = fn;
  }

  darkFrameList() {
    return this.darks.list();
  }

  captureDarks(o: DarkRequest): Promise<void> {
    return this.darks.capture(o);
  }

  stopDarks(): Promise<void> {
    return this.darks.stop();
  }
}
