import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import Long from 'long';
import { config, observerLocation, requireObserverLocation } from '../config.js';
import { logger, errMsg } from '../log.js';
import { DwarfLink, DwarfCommandError, isLinkFailure, type LinkHealth, type Notification, type RequestOptions } from './link.js';
import { Cmd, OPERATION_STATE, ASTRO_STATE, SOLAR_SYSTEM_INDEX, errorText, protoTypeByName } from './protocol.js';
import * as http from './http.js';
import { listDir } from './ftp.js';
import { gate } from './gate.js';

const log = logger('dwarf');

export type CameraName = 'tele' | 'wide';
export const camId = (c: CameraName) => (c === 'wide' ? 1 : 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Firmware time limits on a motor move or reset ("overtime"): the axis stopped early, not an error in the request. */
const MOTOR_OVERTIME = new Set([-14510, -14511, -14512, -14513, -14514, -14515, -14521, -14522]);
const opState = (n: unknown) => OPERATION_STATE[Number(n ?? 0)] ?? `state_${n}`;
const astroState = (n: unknown) => ASTRO_STATE[Number(n ?? 0)] ?? `state_${n}`;

/** Progress of a star-sharpness measurement or star-focus sweep, for the web UI. */
export interface FocusTune {
  running: boolean;
  action: 'measure' | 'sweep';
  startedAt: number;
  finishedAt?: number;
  total?: number;
  index?: number;
  position?: number;
  best?: { position: number; hfrPx: number; score: number };
  message?: string;
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
}

export interface TelescopeState {
  /** connected AND the telescope is executing commands (see link for why not) */
  connected: boolean;
  /** control-link health: connected / connecting / unresponsive (hung, needs a power cycle) / contended (another client) / released */
  link?: LinkHealth;
  /** the user released the telescope from the web UI (Disconnect): no traffic until Connect */
  released?: boolean;
  /** The long operation the controller is running (calibration, GoTo, homing, …), if any. */
  operation?: string;
  device: { name?: string; serial?: string; firmware?: string; ip?: string };
  battery?: number;
  charging?: boolean;
  temperatureC?: number;
  cmosTempC: { tele?: number; wide?: number };
  storage?: { availableGB: number; totalGB: number };
  shootingMode?: { id: number; name: string };
  shootingTech: { tele?: string; wide?: string };
  bodyMode?: 'eq' | 'altaz' | 'unknown';
  focusPosition?: number;
  motors: { rotationDeg?: number; pitchDeg?: number; homed?: boolean; updatedAt?: number };
  fov: { tele?: { h: number; v: number }; wide?: { h: number; v: number } };
  teleInWide?: { x: number; y: number; width: number; height: number };
  calibration: { state: string; plateSolvingTimes?: number; result?: { azimuth: number; altitude: number }; at?: number };
  goto: { state: string; target?: string; at?: number };
  tracking: { state: string; target?: string };
  oneClickGoto?: Record<string, unknown>;
  stacking: { tele: StackingInfo; wide: StackingInfo };
  darkCapture?: {
    state: string;
    progress?: number;
    remainingS?: number;
    exposureS?: number;
    gain?: number;
    frames?: number;
    sensorC?: number;
    startedAt?: number;
    expectedEndAt?: number;
    finishedAt?: number;
    error?: string;
    /** the firmware's own dark-capture state (notification 15206) */
    fwState?: string;
    master?: string;
  };
  /** ND filter fitted for dark frames: nothing may move the scope or take light frames. */
  ndLock?: { since: number; note: string } | null;
  eqSolving: { state: string; result?: { azimuthErrorDeg: number; altitudeErrorDeg: number; at: number } };
  autofocus: { state: string; astro?: string };
  /** a star-sharpness measurement or focus sweep in progress (media/focus.ts publishes its progress here) */
  focusTune?: FocusTune;
  capture: { photo?: string; burst?: string; record?: string; timelapse?: string; panorama?: string; burstProgress?: string };
  sentry?: { state: string; objectType?: number };
  trackResult?: Record<string, unknown>;
  whiteBalance: { tele?: Record<string, unknown>; wide?: Record<string, unknown> };
  lastNotificationAt?: number;
}

function initialState(): TelescopeState {
  return {
    connected: false,
    device: {},
    cmosTempC: {},
    shootingTech: {},
    motors: {},
    fov: {},
    calibration: { state: 'idle' },
    goto: { state: 'idle' },
    tracking: { state: 'idle' },
    stacking: { tele: { state: 'idle' }, wide: { state: 'idle' } },
    eqSolving: { state: 'idle' },
    autofocus: { state: 'idle' },
    capture: {},
    whiteBalance: {},
  };
}

export class Dwarf extends EventEmitter {
  readonly link: DwarfLink;
  state: TelescopeState = initialState();
  /** Live parameter values keyed by packed paramId (decimal string). */
  readonly params = new Map<string, { mode?: number; value?: number | boolean; ts: number }>();
  private stateTimer: NodeJS.Timeout | null = null;
  private emitPending = false;
  private lastLiveViewWake = 0;
  /** Overrides from the agent/UI for this run (falls back to .env). */
  locationOverride: { lat: number; lon: number; elev: number } | null = null;

  constructor() {
    super();
    this.link = new DwarfLink(config.dwarf.host, config.dwarf.wsPort);
    this.link.on('notification', (n: Notification) => this.onNotification(n));
    this.loadNdLock();
    this.link.on('connected', () => {
      this.syncLink();
      if (this.link.usable) void this.onConnected();
    });
    this.link.on('disconnected', () => this.syncLink());
    this.link.on('health', () => this.syncLink());
    // Back from a hang (after a power cycle): resync like a fresh connection.
    this.link.on('responsive', () => {
      this.syncLink();
      void this.onConnected();
    });
  }

  /** Mirror the link into the published state; `connected` only while commands are executed. */
  private syncLink(): void {
    this.state.connected = this.link.usable;
    this.state.link = this.link.health();
    this.changed();
  }

  private releasedFile = path.join(config.paths.data, 'released.json');

  start(): void {
    // A release survives a restart: the user may be using the DWARFLAB app.
    gate.released = fs.existsSync(this.releasedFile);
    this.state.released = gate.released;
    if (gate.released) log.warn('the telescope is released (Disconnect in the web UI): not connecting until Connect is pressed');
    else this.link.start();
    this.stateTimer = setInterval(() => {
      if (this.link.usable && !this.quietPeriod()) void this.refreshState().catch(() => {});
      // keep the published link health (ages, counts) current for the UI and the agent
      this.state.link = this.link.health();
    }, 30000);
    // Keep the reported mount angles current (they change during GoTo/tracking without notifications).
    // Not during operations: they read the positions themselves, and the firmware is busy moving.
    // During a capture (stacking, tracking) the angles change slowly: once a minute is plenty.
    let lastMotorPoll = 0;
    this.motorTimer = setInterval(() => {
      if (!this.link.usable || this.quietPeriod()) return;
      if ((this.isBusy() || this.isTracking()) && Date.now() - lastMotorPoll < 60000) return;
      lastMotorPoll = Date.now();
      void this.readMotorPositions().catch(() => {});
    }, 15000);
    this.syncLink();
    if (!gate.released) void this.refreshDeviceInfo();
  }

  /**
   * Disconnect button: close the control link and stop every other kind of traffic (HTTP, FTP,
   * video) so the telescope is free for another client, and stay that way until connectLink().
   */
  release(): void {
    gate.released = true;
    fs.writeFileSync(this.releasedFile, JSON.stringify({ since: Date.now() }));
    this.link.stop();
    this.state.released = true;
    this.syncLink();
    log.info('telescope released by the user: control link closed, no traffic until Connect');
    this.emit('released');
    this.changed();
  }

  /** Connect button: take the telescope back. */
  connectLink(): void {
    gate.released = false;
    fs.rmSync(this.releasedFile, { force: true });
    this.state.released = false;
    log.info('connecting to the telescope (Connect pressed)');
    this.link.start();
    this.syncLink();
  }

  /** Telescope address changed in the web UI: drop what we knew about the old device and reconnect there. */
  setHost(host: string): void {
    log.info(`telescope address set to ${host}${gate.released ? ' (released: connects when Connect is pressed)' : ''}`);
    this.state.device = {};
    this.state.storage = undefined;
    this.link.retarget(host);
    this.changed();
  }

  private motorTimer: NodeJS.Timeout | null = null;

  stop(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.motorTimer) clearInterval(this.motorTimer);
    this.link.stop();
  }

  location(): { lat: number; lon: number; elev: number } | null {
    return this.locationOverride ?? observerLocation();
  }

  requireLocation(): { lat: number; lon: number; elev: number } {
    return this.locationOverride ?? requireObserverLocation();
  }

  /** Throttled state-change broadcast for the UI. */
  private changed(): void {
    if (this.emitPending) return;
    this.emitPending = true;
    setTimeout(() => {
      this.emitPending = false;
      this.emit('state', this.state);
    }, 150);
  }

  /** Publish a state change made outside the notification path (a long operation's progress) to the UI. */
  publishState(patch: Partial<TelescopeState>): void {
    Object.assign(this.state, patch);
    this.changed();
  }

  request(cmd: number, params: Record<string, unknown> = {}, opts?: RequestOptions) {
    return this.link.request(cmd, params, opts);
  }

  private async onConnected(): Promise<void> {
    try {
      await this.refreshState();
      // The telescope reports a running stack/GoTo in the notifications that follow a connect.
      await sleep(3000);
      await this.readMotorPositions().catch(() => {});
      // (Un-homed motors alone are not a reason: a freshly powered telescope has them too and needs the sync.)
      const busy = this.isBusy() ?? (this.isTracking() ? 'tracking' : null);
      if (busy) {
        // Reconnected in the middle of a capture or an operation: only read. Re-arming the cameras or
        // setting the clock under a running stack or tracking mount could disturb it.
        log.info(`connected while ${busy}: resync limited to reading the state (time/location not pushed)`);
        await this.refreshDeviceInfo();
        return;
      }
      if (config.dwarf.autoSyncTimeLocation) await this.syncTimeLocation().catch((e) => log.warn(`time/location sync failed: ${errMsg(e)}`));
      await this.refreshDeviceInfo();
      // Entering the camera makes the telescope (re)start its RTSP previews and broadcast every
      // current camera parameter, which primes our live settings cache.
      await this.ensureLiveView(true).catch(() => {});
    } catch (err) {
      log.warn(`post-connect refresh failed: ${errMsg(err)}`);
    }
  }

  async refreshDeviceInfo(): Promise<void> {
    try {
      const info = await http.getDeviceInfo();
      const fw = await http.getFirmware().catch(() => null);
      this.state.device = { name: info.deviceName, serial: info.sn, ip: info.staIpAddress, firmware: fw?.version };
      if (info.sdCardInfo) this.state.storage = { availableGB: info.sdCardInfo.availableSize, totalGB: info.sdCardInfo.totalSize };
      this.changed();
    } catch (err) {
      log.debug(`device info unavailable: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async refreshState(): Promise<Record<string, unknown>> {
    const s = (await this.request(Cmd.TASK_GET_DEVICE_STATE_INFO, {}, { timeout: 12000 })) as Record<string, any>;
    const st = this.state;
    if (typeof s.shootingMode === 'number') await this.setModeState(s.shootingMode);
    const tele = s.teleCameraStateInfo ?? {};
    const wide = s.wideCameraStateInfo ?? {};
    if (tele.hFov) st.fov.tele = { h: round(tele.hFov, 3), v: round(tele.vFov, 3) };
    if (wide.hFov) st.fov.wide = { h: round(wide.hFov, 3), v: round(wide.vFov, 3) };
    if (tele.cmosTemperature) st.cmosTempC.tele = tele.cmosTemperature.temperature ?? 0;
    if (wide.cmosTemperature) st.cmosTempC.wide = wide.cmosTemperature.temperature ?? 0;
    const dev = s.deviceStateInfo ?? {};
    if (dev.batteryInfo) st.battery = dev.batteryInfo.percentage ?? 0;
    if (dev.chargingState) st.charging = (dev.chargingState.state ?? 0) > 0;
    if (dev.temperature) st.temperatureC = dev.temperature.temperature ?? 0;
    if (dev.storageInfo) st.storage = { availableGB: dev.storageInfo.availableSize ?? 0, totalGB: dev.storageInfo.totalSize ?? 0 };
    if (dev.bodyStatus) st.bodyMode = bodyMode(dev.bodyStatus.bodyStatus);
    if (dev.pictureMatching) st.teleInWide = dev.pictureMatching;
    const focus = s.focusMotorStateInfo?.focusPosition;
    if (focus) st.focusPosition = focus.pos ?? 0;
    this.changed();
    return s;
  }

  private async setModeState(id: number): Promise<void> {
    let name = String(id);
    try {
      name = (await http.getShootingModes()).find((m) => m.id === id)?.name ?? name;
    } catch {
      /* HTTP unavailable */
    }
    this.state.shootingMode = { id, name };
  }

  private onNotification(n: Notification): void {
    const d = n.data as Record<string, any>;
    const st = this.state;
    st.lastNotificationAt = n.ts;
    const cam = (d.cameraType ?? d.camId ?? 0) === 1 ? 'wide' : 'tele';
    switch (n.name) {
      case 'battery':
        st.battery = d.percentage ?? 0;
        break;
      case 'charging':
        st.charging = (d.state ?? 0) > 0;
        break;
      case 'temperature':
        st.temperatureC = d.temperature ?? 0;
        break;
      case 'cmosTemperature':
        st.cmosTempC[cam] = d.temperature ?? 0;
        break;
      case 'sdCard':
        st.storage = { availableGB: d.availableSize ?? 0, totalGB: d.totalSize ?? 0 };
        break;
      case 'focusPosition':
        st.focusPosition = d.pos ?? 0;
        break;
      case 'bodyStatus':
        st.bodyMode = bodyMode(d.bodyStatus);
        break;
      case 'pictureMatching':
        st.teleInWide = { x: d.x ?? 0, y: d.y ?? 0, width: d.width ?? 0, height: d.height ?? 0 };
        break;
      case 'shootingMode':
        if (typeof d.dstMode === 'number') void this.setModeState(d.dstMode).then(() => this.changed());
        break;
      case 'calibrationState':
        st.calibration = { ...st.calibration, state: astroState(d.state), plateSolvingTimes: d.plateSolvingTimes };
        break;
      case 'calibrationResult':
        st.calibration = { ...st.calibration, result: { azimuth: d.azi ?? 0, altitude: d.alt ?? 0 }, at: n.ts };
        break;
      case 'gotoState':
        st.goto = { state: astroState(d.state), target: d.targetName ?? st.goto.target, at: n.ts };
        break;
      case 'trackingState':
        st.tracking = { state: astroState(d.state), target: d.targetName ?? st.tracking.target };
        break;
      case 'oneClickGotoState':
        st.oneClickGoto = { ...d, at: n.ts };
        break;
      case 'teleStackingState':
      case 'wideStackingState': {
        const which = n.name === 'wideStackingState' ? 'wide' : 'tele';
        const state = opState(d.state);
        const prev = st.stacking[which];
        st.stacking[which] = {
          ...prev,
          state,
          startedAt: state === 'running' && prev.state !== 'running' ? n.ts : prev.startedAt,
          stoppedAt: state === 'stopped' || state === 'idle' ? n.ts : undefined,
        };
        break;
      }
      case 'teleStackingProgress':
      case 'wideStackingProgress': {
        const which = n.name === 'wideStackingProgress' ? 'wide' : 'tele';
        const prev = st.stacking[which];
        // Ignore stragglers that arrive just after a stop.
        if ((prev.state === 'stopped' || prev.state === 'idle') && prev.stoppedAt && n.ts - prev.stoppedAt < 15000) break;
        st.stacking[which] = {
          ...prev,
          state: prev.state === 'idle' || prev.state === 'stopped' ? 'running' : prev.state,
          target: d.targetName ?? prev.target,
          totalCount: d.totalCount ?? prev.totalCount,
          currentCount: d.currentCount ?? prev.currentCount,
          stackedCount: d.stackedCount ?? prev.stackedCount,
          shootingTimeS: d.shootingTime ?? prev.shootingTimeS,
          stackedTimeS: d.stackedTime ?? prev.stackedTimeS,
          expIndex: d.expIndex ?? prev.expIndex,
          gainIndex: d.gainIndex ?? prev.gainIndex,
          updatedAt: n.ts,
        };
        this.emit('stackProgress', which, st.stacking[which]);
        break;
      }
      case 'darkCaptureState': {
        const fw = opState(d.state);
        const was = st.darkCapture?.fwState;
        st.darkCapture = { ...st.darkCapture, state: st.darkCapture?.state ?? fw, fwState: fw };
        log.info(`dark capture: firmware state ${fw}`);
        // the firmware leaving "running" is the end of a capture: confirm it from the saved master
        if (was === 'running' && fw !== 'running') this.darkCheck?.();
        break;
      }
      case 'darkCaptureProgress':
        st.darkCapture = { ...st.darkCapture, state: st.darkCapture?.state ?? 'running', progress: d.progress, remainingS: d.remainingTime };
        break;
      case 'eqSolvingState':
        st.eqSolving = { ...st.eqSolving, state: opState(d.state) };
        break;
      case 'autoFocusState':
        st.autofocus = { ...st.autofocus, state: opState(d.state) };
        break;
      case 'astroAutoFocusState':
      case 'astroAutoFocusFastState':
        st.autofocus = { ...st.autofocus, astro: opState(d.state) };
        break;
      case 'photoState':
        st.capture.photo = `${cam}:${opState(d.state)}`;
        break;
      case 'burstState':
        st.capture.burst = `${cam}:${opState(d.state)}`;
        break;
      case 'burstProgress':
      case 'teleBurstProgress':
      case 'wideBurstProgress':
        st.capture.burstProgress = `${d.completedCount ?? 0}/${d.totalCount ?? '?'}`;
        break;
      case 'recordState':
        st.capture.record = `${cam}:${opState(d.state)}`;
        break;
      case 'timelapseState':
        st.capture.timelapse = `${cam}:${opState(d.state)}`;
        break;
      case 'panoramaState':
        st.capture.panorama = opState(d.state);
        break;
      case 'sentryState':
        st.sentry = { state: ['idle', 'init', 'detect', 'track', 'track_finish', 'stopping'][d.state ?? 0] ?? String(d.state), objectType: d.objectType };
        break;
      case 'trackResult':
      case 'wideTrackResult':
      case 'sentryTrackResult':
        st.trackResult = { ...d, camera: n.name === 'wideTrackResult' ? 'wide' : 'tele', at: n.ts };
        break;
      case 'intParam':
        // proto3 omits zero values: a missing mode is mode 0 (auto), a missing value is 0.
        if (d.paramId) this.params.set(String(d.paramId), { mode: d.mode ?? 0, value: d.value ?? 0, ts: n.ts });
        break;
      case 'boolParam':
        if (d.paramId) this.params.set(String(d.paramId), { value: Boolean(d.value), ts: n.ts });
        break;
      case 'whiteBalance':
        st.whiteBalance[cam] = { mode: ['auto', 'kelvin', 'scene'][Number(d.mode ?? 0)] ?? d.mode, kelvin: d.ct, scene: d.scene !== undefined && d.scene >= 0 ? WB_SCENES[d.scene] : undefined };
        break;
      case 'powerOff':
        log.warn('telescope is powering off');
        break;
      case 'hostSlaveMode':
        // mode 1 = another client is the host and our commands are only observed
        log.info(`session role: ${Number(d.mode ?? 0) === 1 ? 'SLAVE (another client controls the telescope)' : 'host'}${d.lock ? ', locked' : ''}`);
        break;
    }
    this.emit('notification', n);
    this.changed();
  }

  /**
   * Send a command that fw 1.5.3 may or may not acknowledge. An error reply fails; a missing
   * reply is not a failure in itself: `confirm` checks the telescope's own state for the change
   * (its notifications or a state read), and only if that also never shows it does this fail.
   */
  private async send(cmd: number, params: Record<string, unknown>, what: string, o: { timeout?: number; confirm?: () => boolean | Promise<boolean>; confirmMs?: number } = {}): Promise<Record<string, unknown> | null> {
    const timeout = o.timeout ?? 15000;
    const r = await this.request(cmd, params, { timeout, bestEffort: true, allowError: true });
    const code = Number(r?.code ?? 0);
    if (r && code < 0) throw new DwarfCommandError(cmd, code, r);
    if (!r && o.confirm) {
      const end = Date.now() + (o.confirmMs ?? 10000);
      for (;;) {
        if (await Promise.resolve(o.confirm()).catch(() => false)) break;
        if (Date.now() > end) throw new Error(`${what}: the telescope neither acknowledged the command nor showed the change within ${Math.round((timeout + (o.confirmMs ?? 10000)) / 1000)} s`);
        await sleep(500);
      }
    }
    return r;
  }

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  async syncTimeLocation(loc = this.location()): Promise<string[]> {
    const done: string[] = [];
    const now = Date.now();
    const offsetH = -new Date(now).getTimezoneOffset() / 60;
    const tzOffset = timezoneOffsetHours(config.observer.timezone, now) ?? offsetH;
    await this.request(Cmd.SYSTEM_SET_TIME, { timestamp: Math.floor(now / 1000), timezoneOffset: tzOffset });
    done.push(`time=${new Date(now).toISOString()} (UTC${tzOffset >= 0 ? '+' : ''}${tzOffset})`);
    await this.request(Cmd.SYSTEM_SET_TIME_ZONE, { timezone: config.observer.timezone }, { allowError: true });
    done.push(`timezone=${config.observer.timezone}`);
    if (loc) {
      await this.request(Cmd.SYSTEM_SET_LOCATION, { latitude: loc.lat, longitude: loc.lon, altitude: loc.elev, enable: true });
      done.push(`location=${loc.lat.toFixed(5)},${loc.lon.toFixed(5)} elev ${loc.elev}m`);
    }
    log.info(`synced ${done.join(', ')}`);
    return done;
  }

  async power(action: 'reboot' | 'shutdown' | 'rgb_on' | 'rgb_off' | 'indicator_on' | 'indicator_off'): Promise<void> {
    const map = { reboot: 13505, shutdown: 13502, rgb_on: 13500, rgb_off: 13501, indicator_on: 13503, indicator_off: 13504 };
    // These commands are acted on but not acknowledged by fw 1.5.3.
    try {
      await this.request(map[action], {}, { bestEffort: true, timeout: 3000 });
    } catch (err) {
      // a reboot or shutdown closes the connection: that is the command working
      if (!((action === 'reboot' || action === 'shutdown') && /connection closed/.test(errMsg(err)))) throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Modes & camera
  // -------------------------------------------------------------------------

  async setShootingMode(nameOrId: string | number): Promise<http.ShootingModeDef> {
    this.assertNoOperation('changing the shooting mode');
    const mode = await http.resolveShootingMode(nameOrId);
    await this.send(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE, { mode: mode.id }, `switching to ${mode.name} mode`, {
      timeout: 20000,
      confirmMs: 15000,
      confirm: async () => {
        await this.refreshState();
        return this.state.shootingMode?.id === mode.id;
      },
    });
    await this.request(Cmd.TASK_MANAGER_ENTER_CAMERA, { clientParam: { encodeType: 1 } }, { timeout: 15000, allowError: true, bestEffort: true });
    this.state.shootingMode = { id: mode.id, name: mode.name };
    this.lastLiveViewWake = Date.now();
    this.changed();
    return mode;
  }

  async setShootingTech(tech: 'single_photo' | 'stacking' | 'burst' | 'video' | 'timelapse' | 'panorama'): Promise<void> {
    const id = Number(Object.entries(http.SHOOTING_TECH_NAMES).find(([, n]) => n === tech)?.[0]);
    if (!id) throw new Error(`unknown technique ${tech}`);
    await this.send(Cmd.TASK_MANAGER_SWITCH_SHOOTING_TECH, { tech: id }, `switching to ${tech}`);
    this.state.shootingTech.tele = tech;
    this.state.shootingTech.wide = tech;
  }

  async currentModeId(): Promise<number> {
    if (!this.state.shootingMode) await this.refreshState();
    return this.state.shootingMode?.id ?? 1;
  }

  /**
   * Long operations the controller runs on the telescope (calibration, GoTo, homing, a motor move,
   * autofocus, polar alignment). One at a time: a second one is refused, not interleaved. While one
   * runs the controller sends nothing else on its own (no polls, no live-view or exposure fixes),
   * so the telescope's firmware has its command service to itself — background commands landing in
   * the middle of a calibration were the leading suspect for the command service hanging
   * (2026-10-10 03:04: calibration stuck after its first plate solve, hung until a power cycle).
   */
  private readonly opContext = new AsyncLocalStorage<string>();
  private activeOp: { label: string; since: number } | null = null;

  /** Run `fn` as the one long operation; nested calls (a move that homes first) run inside it. */
  async exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.opContext.getStore() !== undefined) return fn();
    if (this.activeOp) {
      throw new Error(`refused: the telescope is busy ${this.activeOp.label} (started ${Math.round((Date.now() - this.activeOp.since) / 1000)} s ago); wait for it to finish or stop it first — commands interleaved with a running operation can hang the telescope's command service`);
    }
    this.activeOp = { label, since: Date.now() };
    this.state.operation = label;
    this.changed();
    try {
      return await this.opContext.run(label, fn);
    } finally {
      this.activeOp = null;
      this.state.operation = undefined;
      this.lastOpEndedAt = Date.now();
      this.changed();
    }
  }

  /** Refuse `what` while another caller's operation runs (from inside the operation it is allowed). */
  assertNoOperation(what: string): void {
    if (this.activeOp && this.opContext.getStore() === undefined) {
      throw new Error(`refused: the telescope is busy ${this.activeOp.label}; ${what} now would interfere — wait for it to finish`);
    }
  }

  /** The long operation the controller is running, if any. */
  get operation(): string | null {
    return this.activeOp?.label ?? null;
  }

  /** Inside an operation (or just after one): the controller's own background traffic waits. */
  quietPeriod(): boolean {
    if (this.activeOp) return true;
    const busy = this.isBusy();
    if (busy && busy !== 'live stacking') return true;
    return Date.now() - this.lastOpEndedAt < 5000;
  }

  private lastOpEndedAt = 0;

  isBusy(): string | null {
    if (this.activeOp) return this.activeOp.label;
    const s = this.state;
    if (s.stacking.tele.state === 'running' || s.stacking.wide.state === 'running') return 'live stacking';
    if (['running', 'plate_solving'].includes(s.calibration.state)) return 'calibration';
    if (['running', 'plate_solving'].includes(s.goto.state)) return 'goto';
    if (s.eqSolving.state === 'running') return 'polar alignment';
    return null;
  }

  /**
   * Make sure RTSP previews are being produced (enter-camera + preview quality).
   * Skipped while an astro operation is running so it can't disturb it.
   */
  async ensureLiveView(force = false): Promise<void> {
    if (this.isBusy()) return;
    if (Date.now() - this.lastLiveViewWake < (force ? 5000 : 60000)) return;
    this.lastLiveViewWake = Date.now();
    await this.request(Cmd.TASK_MANAGER_ENTER_CAMERA, { clientParam: { encodeType: 1 } }, { bestEffort: true, timeout: 5000 });
    await this.request(Cmd.CAMERA_TELE_SET_PREVIEW_QUALITY, { level: 1 }, { bestEffort: true, timeout: 3000 });
    await this.request(Cmd.CAMERA_WIDE_SET_PREVIEW_QUALITY, { level: 1 }, { bestEffort: true, timeout: 3000 });
  }

  // ---- parameters ---------------------------------------------------------

  async cameraSettings(camera: CameraName, modeId?: number) {
    const mode = modeId ?? (await this.currentModeId());
    const schema = await http.getParamSchema(mode);
    const defs = schema.cameras[camId(camera)] ?? {};
    const live = (def: http.ParamDef) => this.params.get(String(def.paramId));
    const out: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(defs)) {
      const cur = live(def);
      if (name === 'exp') {
        const values = (def.values ?? []) as Array<{ name: string; value: number }>;
        // Only live values from the telescope are trusted (the HTTP schema's currentValue goes stale).
        const current = !cur ? 'unknown (not reported since connect)' : cur.mode === 0 ? 'auto' : values.find((v) => v.value === cur.value)?.name ?? cur.value;
        out.exposure = {
          current,
          options: ['auto', ...values.map((v) => v.name)],
          unit: 'seconds',
        };
      } else if (name === 'gain') {
        out.gain = { current: cur?.value ?? def.currentValue, options: def.values, note: def.range?.map((r) => `${r.minValue}-${r.maxValue}`).join(',') };
      } else if (name === 'wb') {
        out.white_balance = { current: this.state.whiteBalance[camera] ?? 'unknown', options: ['auto', ...WB_SCENES, 'or a kelvin value 2800-7500'] };
      } else if (name === 'filterType') {
        const v = (cur?.value as number | undefined) ?? (def.currentValue as number);
        out.filter = { current: FILTERS[v] ?? v, options: (def.values as number[]).map((i) => FILTERS[i] ?? i) };
      } else {
        out[name] = describeParam(def, cur?.value);
      }
    }
    const extra: Record<string, unknown> = {};
    for (const [name, def] of Object.entries({ ...schema.techSettings, ...schema.modeParams })) {
      extra[name] = describeParam(def, this.params.get(String(def.paramId))?.value);
    }
    const device: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(schema.device)) device[name] = describeParam(def, this.params.get(String(def.paramId))?.value);
    return {
      camera,
      modeId: mode,
      settings: out,
      modeSettings: extra,
      deviceSettings: device,
      notes: 'deviceSettings apply to the whole telescope in every mode: autoShutdown = power off automatically when idle; disableHostSlave = multi-client host/slave arbitration. Change any of these with set_camera_setting (camera can be either).',
    };
  }

  /**
   * Set any camera/mode setting by name. Handles exposure (by label or "auto"),
   * gain, white balance, filter, and every generic int/bool parameter the
   * device advertises for the mode.
   */
  async setSetting(camera: CameraName, setting: string, value: string | number | boolean, modeId?: number): Promise<string> {
    this.assertNoOperation('changing camera settings');
    const mode = modeId ?? (await this.currentModeId());
    const schema = await http.getParamSchema(mode);
    const defs = schema.cameras[camId(camera)] ?? {};
    const key = setting.toLowerCase().replace(/[\s-]/g, '_');
    const pid = (def: http.ParamDef) => Long.fromString(String(def.paramId), false);

    if (['exposure', 'exp', 'shutter'].includes(key)) {
      const def = defs.exp;
      if (!def) throw new Error(`exposure is not adjustable in mode ${mode}`);
      if (String(value).toLowerCase() === 'auto') {
        await this.request(Cmd.PARAM_SET_EXPOSURE, { paramId: pid(def), mode: 0, value: (this.params.get(String(def.paramId))?.value as number) ?? 0 });
        return `${camera} exposure → auto`;
      }
      const values = def.values as Array<{ name: string; value: number }>;
      const match = matchExposure(values, value);
      await this.request(Cmd.PARAM_SET_EXPOSURE, { paramId: pid(def), mode: 1, value: match.value });
      const secs = match.name.includes('/') ? 0 : Number(match.name);
      const warn = secs >= 1 ? ` — WARNING: the ${camera} live view is now PAUSED (the telescope stops live streaming at exposures ≥ 1 s) for the user and for you until exposure is set back to "auto". For a one-off night check use view_camera/analyze_image with exposure_s instead, which restores the setting automatically.` : '';
      return `${camera} exposure → ${match.name}s (manual)${warn}`;
    }
    if (key === 'gain' || key === 'iso') {
      const def = defs.gain;
      if (!def) throw new Error(`gain is not adjustable in mode ${mode}`);
      const allowed = (def.values as number[]) ?? [];
      const want = Number(value);
      if (!Number.isFinite(want)) throw new Error('gain must be a number');
      const pick = allowed.length ? allowed.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)) : want;
      await this.request(Cmd.PARAM_SET_GAIN, { paramId: pid(def), mode: 1, value: pick });
      return `${camera} gain → ${pick}${pick !== want ? ` (nearest allowed to ${want})` : ''}`;
    }
    if (['white_balance', 'wb'].includes(key)) {
      const def = defs.wb;
      if (!def) throw new Error(`white balance is not adjustable in mode ${mode}`);
      const v = String(value).toLowerCase();
      if (v === 'auto') {
        await this.request(Cmd.PARAM_SET_WB, { paramId: pid(def), mode: 0, value: 0 });
        return `${camera} white balance → auto`;
      }
      const scene = WB_SCENES.findIndex((s) => s.toLowerCase() === v);
      if (scene >= 0) {
        await this.request(Cmd.PARAM_SET_WB, { paramId: pid(def), mode: 2, value: scene });
        return `${camera} white balance → ${WB_SCENES[scene]}`;
      }
      const kelvin = Number(String(value).replace(/k$/i, ''));
      if (!Number.isFinite(kelvin)) throw new Error(`white balance must be auto, a scene (${WB_SCENES.join(', ')}) or kelvin`);
      const cts = def.ctModeValues ?? [kelvin];
      const ct = cts.reduce((a, b) => (Math.abs(b - kelvin) < Math.abs(a - kelvin) ? b : a));
      await this.request(Cmd.PARAM_SET_WB, { paramId: pid(def), mode: 1, value: ct });
      return `${camera} white balance → ${ct}K`;
    }
    if (['filter', 'filtertype', 'ir_filter', 'ircut'].includes(key)) {
      const def = defs.filterType;
      if (!def) throw new Error(`the filter is not selectable in mode ${mode} on the ${camera} camera`);
      const idx = resolveFilter(value);
      await this.request(Cmd.PARAM_SET_GENERAL_INT_PARAM, { paramId: pid(def), value: idx });
      return `${camera} filter → ${FILTERS[idx]}`;
    }

    // Generic parameters: camera general params, then mode/tech/device params.
    const all: Record<string, http.ParamDef> = { ...schema.device, ...schema.modeParams, ...schema.techSettings, ...defs };
    const name = Object.keys(all).find((n) => n.toLowerCase() === key.replace(/_/g, '') || n.toLowerCase() === key || snake(n) === key);
    const def = name ? all[name] : undefined;
    if (!def) {
      throw new Error(`unknown setting "${setting}" for ${camera} in mode ${mode}. Known: exposure, gain, white_balance, filter, ${Object.keys(all).join(', ')}`);
    }
    if (def.valueType === 3) {
      const b = typeof value === 'boolean' ? value : ['true', '1', 'on', 'yes'].includes(String(value).toLowerCase());
      // fw 1.5.3 applies bool params but never acknowledges them: send, then verify by reading back.
      await this.request(Cmd.PARAM_SET_GENERAL_BOOL_PARAM, { paramId: pid(def), value: b }, { bestEffort: true, timeout: 2000 });
      http.invalidateParamSchema();
      const after = await http.getParamSchema(mode);
      const all2: Record<string, http.ParamDef> = { ...after.device, ...after.modeParams, ...after.techSettings, ...(after.cameras[camId(camera)] ?? {}) };
      const now = all2[name!]?.currentValue;
      if (now !== undefined && Boolean(now) !== b) throw new Error(`${name} did not change (device still reports ${now})`);
      return `${name} → ${b}${now !== undefined ? ' (verified on device)' : ''}`;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${name} needs a numeric value`);
    if (def.minValue !== undefined && def.maxValue !== undefined && def.maxValue > def.minValue && (n < def.minValue || n > def.maxValue)) {
      throw new Error(`${name} must be within ${def.minValue}..${def.maxValue}`);
    }
    await this.request(Cmd.PARAM_SET_GENERAL_INT_PARAM, { paramId: pid(def), value: n });
    return `${name} → ${n}`;
  }

  /**
   * Current exposure of a camera in the current mode: null = auto, else seconds.
   * Long manual exposures stop the camera's RTSP live stream on the telescope.
   */
  async exposureSeconds(camera: CameraName): Promise<number | null> {
    const schema = await http.getParamSchema(await this.currentModeId());
    const def = schema.cameras[camId(camera)]?.exp;
    if (!def) return null;
    // Only trust values the telescope pushed to us (15264); the HTTP schema's currentValue goes stale.
    const live = this.params.get(String(def.paramId));
    if (!live || live.mode === 0) return null;
    const idx = live.value as number;
    const name = (def.values as Array<{ name: string; value: number }> | undefined)?.find((v) => v.value === idx)?.name;
    if (!name) return null;
    if (name.includes('/')) {
      const [a, b] = name.split('/').map(Number);
      return a / b;
    }
    return Number(name);
  }

  // ---- capture -----------------------------------------------------------

  /** Take a still photo and return the album entry it produced. */
  async takePhoto(camera: CameraName): Promise<http.MediaItem | null> {
    this.assertNoOperation('taking a photo');
    const started = Math.floor(Date.now() / 1000) - 2;
    // a long exposure answers only after it is read out: allow for it, then the album is the proof
    const expS = (await this.exposureSeconds(camera).catch(() => null)) ?? 0;
    const budget = Math.round(expS * 1000) + 30000;
    const done = this.link.waitFor((n) => n.name === 'photoState' && (n.data.state ?? 0) === 0 && (((n.data.cameraType as number) ?? 0) === camId(camera)), budget + 10000);
    done.catch(() => {}); // observed below; never an unhandled rejection if the command throws
    const cmd = camera === 'tele' ? Cmd.CAMERA_TELE_PHOTOGRAPH : Cmd.CAMERA_WIDE_PHOTOGRAPH;
    const r = await this.request(cmd, {}, { timeout: budget, bestEffort: true, allowError: true });
    if (r && Number(r.code ?? 0) < 0) {
      done.catch(() => {});
      throw new DwarfCommandError(cmd, Number(r.code), r);
    }
    await done.catch(() => sleep(1500));
    return this.findNewMedia(1, camera, started, 8);
  }

  async findNewMedia(mediaType: number, camera: CameraName | null, sinceEpochS: number, tries = 5): Promise<http.MediaItem | null> {
    for (let i = 0; i < tries; i++) {
      const items = await http.listMedia(mediaType, 0, 10).catch(() => [] as http.MediaItem[]);
      const hit = items.find((m) => m.modificationTime >= sinceEpochS && (camera === null || (m.camId ?? 0) === camId(camera)));
      if (hit) return hit;
      await sleep(1000);
    }
    return null;
  }

  async burst(camera: CameraName, count: number): Promise<string> {
    this.assertNoOperation('a burst');
    await this.setShootingTech('burst');
    const schema = await http.getParamSchema(await this.currentModeId());
    const def = schema.techSettings.burstCount;
    if (def) await this.request(Cmd.PARAM_SET_GENERAL_INT_PARAM, { paramId: Long.fromString(String(def.paramId)), value: count });
    const done = this.link.waitFor((n) => n.name === 'burstState' && (n.data.state ?? 0) === 0, 60000 + count * 5000);
    done.catch(() => {});
    await this.send(camera === 'tele' ? Cmd.CAMERA_TELE_BURST : Cmd.CAMERA_WIDE_BURST, { count }, 'burst');
    const ok = await done.then(() => true).catch(() => false);
    return ok
      ? `burst of ${count} on ${camera} finished (${this.state.capture.burstProgress ?? 'done'})`
      : `burst of ${count} on ${camera} started, but the telescope did not report its end (progress ${this.state.capture.burstProgress ?? 'unknown'}); check list_album`;
  }

  async record(camera: CameraName, action: 'start' | 'stop'): Promise<void> {
    if (action === 'start') await this.setShootingTech('video');
    const cmd = camera === 'tele' ? (action === 'start' ? Cmd.CAMERA_TELE_START_RECORD : Cmd.CAMERA_TELE_STOP_RECORD) : action === 'start' ? Cmd.CAMERA_WIDE_START_RECORD : Cmd.CAMERA_WIDE_STOP_RECORD;
    const want = action === 'start' ? 'running' : 'idle|stopped';
    await this.send(cmd, action === 'start' ? { encodeType: 1 } : {}, `${action} recording`, { confirm: () => new RegExp(`^${camera}:(${want})$`).test(this.state.capture.record ?? '') });
  }

  async timelapse(camera: CameraName, action: 'start' | 'stop', intervalS?: number, totalS?: number): Promise<void> {
    if (action === 'start') {
      await this.setShootingTech('timelapse');
      if (intervalS !== undefined) await this.setSetting(camera, 'timelapseIntervalTime', intervalS);
      if (totalS !== undefined) await this.setSetting(camera, 'timelapseTotalTime', totalS);
    }
    const cmd = camera === 'tele' ? (action === 'start' ? Cmd.CAMERA_TELE_START_TIMELAPSE_PHOTO : Cmd.CAMERA_TELE_STOP_TIMELAPSE_PHOTO) : action === 'start' ? Cmd.CAMERA_WIDE_START_TIMELAPSE_PHOTO : Cmd.CAMERA_WIDE_STOP_TIMELAPSE_PHOTO;
    const want = action === 'start' ? 'running' : 'idle|stopped';
    await this.send(cmd, {}, `${action} timelapse`, { confirm: () => new RegExp(`^${camera}:(${want})$`).test(this.state.capture.timelapse ?? '') });
  }

  // -------------------------------------------------------------------------
  // Motors
  // -------------------------------------------------------------------------

  async readMotorPositions(): Promise<{ rotationDeg?: number; pitchDeg?: number; homed: boolean }> {
    const out: { rotationDeg?: number; pitchDeg?: number; homed: boolean } = { homed: true };
    for (const [id, key] of [[1, 'rotationDeg'], [2, 'pitchDeg']] as const) {
      // replies carry the axis id: never take the other axis's (late) reply for this one
      const r = await this.request(Cmd.STEP_MOTOR_GET_POSITION, { id }, { allowError: true, timeout: 8000, match: (x) => x.id === undefined || Number(x.id) === id });
      if (r && typeof r.code === 'number' && r.code === -14520) out.homed = false;
      else if (r && typeof r.position === 'number') out[key] = round(r.position, 2);
    }
    this.state.motors = { ...out, updatedAt: Date.now() };
    this.changed();
    return out;
  }

  /** Home both axes against their limit switches (needed after power-on). */
  /** Mechanical/sane ranges (verified: rotation stop near 320°, home at rotation≈159° / pitch≈2.4°, pitch 180 = zenith). */
  static readonly PITCH_RANGE = [0, 195] as const;
  static readonly ROTATION_RANGE = [0, 315] as const;

  /**
   * Before driving the motors directly, make sure no astro routine (GoTo, one-click GoTo,
   * sidereal/special tracking) is still holding them; otherwise resets and moves are
   * ignored or fought. Refuses while live stacking, which manual motion would ruin.
   */
  private async releaseMotors(): Promise<void> {
    if (this.state.stacking.tele.state === 'running' || this.state.stacking.wide.state === 'running') {
      throw new Error('live stacking is running — stop it (live_stacking action=stop) before moving the mount');
    }
    // Only stop what the telescope reports as running: sending these stops unconditionally
    // leaves the motor controller in a "needs reset" state (-14520, observed on fw 1.5.3).
    const st = this.state;
    const active = (x: string) => ['running', 'plate_solving'].includes(x);
    if (active(st.goto.state) || active(st.calibration.state) || this.isTracking()) {
      await this.request(Cmd.ASTRO_STOP_GOTO, {}, { bestEffort: true, timeout: 3000 });
      await this.request(Cmd.ASTRO_STOP_ONE_CLICK_GOTO, {}, { bestEffort: true, timeout: 3000 });
      await sleep(1000);
    }
  }

  // -------------------------------------------------------------------------
  // ND-filter lock: while the magnetic ND filter sits on the lenses for darks, any motion (or
  // the park position) knocks it off, and light frames would be worthless. Persisted, so a
  // restart mid-session keeps it.
  // -------------------------------------------------------------------------
  private ndLockFile = path.join(config.paths.data, 'nd-lock.json');

  loadNdLock(): void {
    try {
      this.state.ndLock = JSON.parse(fs.readFileSync(this.ndLockFile, 'utf8'));
    } catch {
      this.state.ndLock = null;
    }
  }

  setNdLock(on: boolean, note = ''): void {
    if (on) {
      this.state.ndLock = this.state.ndLock ?? { since: Date.now(), note };
      fs.writeFileSync(this.ndLockFile, JSON.stringify(this.state.ndLock));
      log.info(`ND filter fitted: motion and light frames locked (${note})`);
    } else {
      this.state.ndLock = null;
      fs.rmSync(this.ndLockFile, { force: true });
      log.info('ND filter removed: lock released');
    }
    this.changed();
  }

  assertNoNdLock(what: string): void {
    if (!this.state.ndLock) return;
    throw new Error(`refused: ${what} while the ND filter is fitted for darks — any motion knocks the magnetic filter off, and light frames would be black. When the operator has removed the filter, call dark_frames action=nd_removed operator_confirmed=true, then motors_home (a hand-tilted scope has lost its motor position).`);
  }

  /**
   * Home both axes against their reference switches. Every step is judged by the motor positions
   * the telescope reports afterwards, not by its replies: a reset can end on the firmware's own time
   * limit (-14511 "overtime get reset return", verified 2026-10-04 02:43 after an EQ solve left the
   * rotation far from its switch) with the axis part of the way there, and resetting again goes on
   * from where it stopped.
   */
  async homeMotors(): Promise<string> {
    return this.exclusive('homing the motors', () => this.homeMotorsNow());
  }

  private async homeMotorsNow(): Promise<string> {
    this.assertNoNdLock('homing the motors');
    await this.releaseMotors();
    const notes: string[] = [];
    const reset = async (id: 1 | 2, direction: boolean) => {
      const r = await this.request(Cmd.STEP_MOTOR_RESET, { id, direction }, { timeout: 240000, allowError: true, bestEffort: true });
      const code = Number(r?.code ?? 0);
      if (!r) notes.push(`${id === 1 ? 'rotation' : 'pitch'} reset: no reply within 4 min`);
      else if (MOTOR_OVERTIME.has(code)) notes.push(`${id === 1 ? 'rotation' : 'pitch'} reset stopped at the firmware's time limit (${errorText(code)}); reset again from there`);
      else if (code < 0 && code !== -14520) throw new DwarfCommandError(Cmd.STEP_MOTOR_RESET, code, r ?? {});
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Pitch to its bottom reference. After a failed calibration the firmware ignores resets
      // for a while, and a long way down can hit the time limit: repeat until it is really there.
      for (let i = 0; i < 5; i++) {
        await reset(2, true);
        const pp = await this.readMotorPositions().catch(() => null);
        if (pp?.pitchDeg !== undefined && pp.pitchDeg < 20) break;
        await sleep(3000);
      }
      // Rotation reference switch at ≈12° (direction=true has no switch → -14520).
      for (let i = 0; i < 3; i++) {
        await reset(1, false);
        const pr = await this.readMotorPositions().catch(() => null);
        if (pr?.homed && pr.rotationDeg !== undefined) break;
        await sleep(3000);
      }
      this.lastMotionAt = Date.now();
      const p = await this.readMotorPositions();
      if (p.homed && p.pitchDeg !== undefined && p.rotationDeg !== undefined && p.pitchDeg < 20) {
        // Park rotation at the centre of travel so every session starts from the same frame.
        await this.runAxis(1, 159, 20, p.rotationDeg);
        const q = await this.readMotorPositions();
        return `homed: rotation ${q.rotationDeg}° (centre of travel), pitch ${q.pitchDeg}° (pointing down; raise with move_motors, e.g. pitch 160 ≈ 70° altitude)${notes.length ? `. Notes: ${notes.join('; ')}` : ''}`;
      }
      if (attempt === 3) {
        throw new Error(`homing did not complete after 3 rounds: motors report ${p.homed ? `rotation ${p.rotationDeg}°, pitch ${p.pitchDeg}°` : 'still not homed (-14520)'}${notes.length ? ` (${notes.join('; ')})` : ''}. Power-cycling the telescope resets its motor controller.`);
      }
      await sleep(5000);
    }
    return 'unreachable';
  }

  /**
   * Run one axis to an absolute angle. The reply arrives when the motion ends; the timeout allows
   * for the distance at this speed. Without a reply, or when the firmware's own time limit ends the
   * move early, the measured position decides, and an unfinished move continues once from there.
   */
  private async runAxis(id: 1 | 2, end: number, speed: number, from?: number): Promise<void> {
    const axis = id === 1 ? 'rotation' : 'pitch';
    const at = async () => {
      const p = await this.readMotorPositions().catch(() => null);
      return id === 1 ? p?.rotationDeg : p?.pitchDeg;
    };
    let pos = from;
    let last = '';
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      const dist = pos !== undefined ? Math.abs(end - pos) : 200;
      const timeout = Math.round((dist / speed) * 2000 + 60000);
      this.lastMotionAt = Date.now();
      const r = await this.request(Cmd.STEP_MOTOR_RUN_TO, { id, endPosition: end, speed, speedRamping: 100, resolutionLevel: 3 }, { timeout, bestEffort: true, allowError: true });
      this.lastMotionAt = Date.now();
      const code = Number(r?.code ?? 0);
      if (r && code >= 0) return;
      if (r && !MOTOR_OVERTIME.has(code)) throw new DwarfCommandError(Cmd.STEP_MOTOR_RUN_TO, code, r);
      pos = await at();
      if (pos !== undefined && Math.abs(pos - end) < 1) return;
      last = r ? errorText(code) : `no reply within ${Math.round(timeout / 1000)} s`;
    }
    throw new Error(`${axis} did not reach ${end}° (now ${pos ?? 'unknown'}°; ${last})`);
  }

  /**
   * Move to absolute motor angles (rotation = motor 1, pitch = motor 2). A scope that is tracking
   * or was left un-homed by an astro routine is released and homed first, so a move always works.
   */
  async moveTo(target: { rotationDeg?: number; pitchDeg?: number }, speedDegPerS = 10): Promise<string> {
    return this.exclusive('moving the motors', () => this.moveToNow(target, speedDegPerS));
  }

  private async moveToNow(target: { rotationDeg?: number; pitchDeg?: number }, speedDegPerS: number): Promise<string> {
    this.assertNoNdLock('moving the motors');
    const speed = Math.max(0.1, Math.min(30, speedDegPerS));
    const [pMin, pMax] = Dwarf.PITCH_RANGE;
    const [rMin, rMax] = Dwarf.ROTATION_RANGE;
    if (target.pitchDeg !== undefined && (target.pitchDeg < pMin || target.pitchDeg > pMax)) {
      throw new Error(`pitch ${target.pitchDeg}° is out of range ${pMin}–${pMax}° (90 = horizon, 180 = zenith in Alt-Az). Nothing was moved.`);
    }
    if (target.rotationDeg !== undefined && (target.rotationDeg < rMin || target.rotationDeg > rMax)) {
      throw new Error(`rotation ${target.rotationDeg}° is out of range ${rMin}–${rMax}° (mechanical stops; centre ≈159°). Nothing was moved.`);
    }
    await this.releaseMotors();
    let before = await this.readMotorPositions();
    let homed = '';
    if (!before.homed) {
      // Tracking after a GoTo, or a failed calibration/GoTo, leaves the axes without a reference (-14520).
      await this.homeMotors();
      homed = 'the motors had no reference (tracking or after an astro routine), so they were homed first; ';
      before = await this.readMotorPositions();
    }
    if (target.pitchDeg !== undefined) await this.runAxis(2, target.pitchDeg, speed, before.pitchDeg);
    if (target.rotationDeg !== undefined) await this.runAxis(1, target.rotationDeg, speed, before.rotationDeg);
    this.lastMotionAt = Date.now();
    const p = await this.readMotorPositions();
    return `${homed}now at rotation ${p.rotationDeg}°, pitch ${p.pitchDeg}°`;
  }

  /** Last time the mount moved; camera frames right after motion are corrupt for a few seconds. */
  lastMotionAt = 0;

  /**
   * Joystick-style slew. angleDeg uses screen convention: 0 = up, 90 = right.
   * The firmware uses math convention (0 = right, 90 = up), verified on hardware:
   * fw 0° pans right (rotation angle decreases), fw 90° raises pitch.
   * Speed 0..1 (≈ 30°/s at 1.0; 0.3 ≈ 9°/s).
   */
  async nudge(angleDeg: number, speed: number, durationMs: number): Promise<void> {
    this.assertNoNdLock('slewing');
    this.assertNoOperation('slewing');
    const fwAngle = (((90 - angleDeg) % 360) + 360) % 360;
    const len = Math.max(0.01, Math.min(1, speed));
    const end = Date.now() + Math.max(100, Math.min(30000, durationMs));
    try {
      while (Date.now() < end) {
        this.lastMotionAt = Date.now();
        await this.request(Cmd.STEP_MOTOR_SERVICE_JOYSTICK, { vectorAngle: fwAngle, vectorLength: len }, { bestEffort: true, timeout: 1000 });
        await sleep(Math.min(250, Math.max(0, end - Date.now())));
      }
    } finally {
      await this.request(Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP, {}, { bestEffort: true, timeout: 3000 });
      this.lastMotionAt = Date.now();
    }
  }

  async stopMotion(): Promise<void> {
    await this.request(Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP, {}, { bestEffort: true, timeout: 3000 });
    for (const id of [1, 2]) await this.request(Cmd.STEP_MOTOR_STOP, { id }, { bestEffort: true, timeout: 3000 });
  }

  // -------------------------------------------------------------------------
  // Focus
  // -------------------------------------------------------------------------

  /**
   * Autofocus. Done = the telescope's AF state returning to idle/stopped after it ran (fw 1.5.3
   * does not always answer the start command). A run that never reports its end is said so.
   */
  async autofocus(kind: 'normal' | 'astro', x = 960, y = 540): Promise<string> {
    return this.exclusive('autofocus', () => this.autofocusNow(kind, x, y));
  }

  private async autofocusNow(kind: 'normal' | 'astro', x: number, y: number): Promise<string> {
    const astro = kind === 'astro';
    const limitMs = astro ? 480000 : 90000;
    const names = astro ? ['astroAutoFocusState', 'astroAutoFocusFastState'] : ['autoFocusState'];
    let ran = false;
    const t0 = Date.now();
    const done = this.link.waitFor((n) => {
      if (!names.includes(n.name)) return false;
      const st = Number(n.data.state ?? 0);
      if (st === 1) ran = true;
      return ran && (st === 0 || st === 3);
    }, limitMs);
    done.catch(() => {});
    const cmd = astro ? Cmd.FOCUS_START_ASTRO_AUTO_FOCUS : Cmd.FOCUS_AUTO_FOCUS;
    const r = await this.request(cmd, astro ? { mode: 0 } : { mode: 0, centerX: Math.round(x), centerY: Math.round(y) }, { timeout: 30000, bestEffort: true, allowError: true });
    if (r && Number(r.code ?? 0) < 0) {
      done.catch(() => {});
      throw new DwarfCommandError(cmd, Number(r.code), r);
    }
    const finished = await done.then(() => true).catch(() => false);
    await sleep(500);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!finished) {
      return `autofocus (${kind}) did not report its end within ${Math.round(limitMs / 60000)} min${ran ? ' (it did start)' : ' (no sign that it started)'}; focus position now ${this.state.focusPosition ?? '?'}. Check sharpness (analyze_image) before relying on it.`;
    }
    return `autofocus (${kind}) finished in ${secs} s at focus position ${this.state.focusPosition ?? '?'}`;
  }

  private cachedInfinity: number | null = null;
  async infinityFocusPosition(): Promise<number> {
    for (let i = 0; i < 2; i++) {
      const r = await this.request(15011, {}, { bestEffort: true, timeout: 4000 });
      if (r && typeof r.pos === 'number') return (this.cachedInfinity = r.pos);
    }
    if (this.cachedInfinity !== null) return this.cachedInfinity;
    throw new Error('the telescope did not report its stored infinity focus position (no reply to 15011); try again');
  }

  /**
   * Drive the focuser to an absolute position. Verified on hardware: "far"
   * raises the position (~1 unit per single step, ~100 units/s continuous);
   * the near limit is 0. In Normal mode realtime AF may move it afterwards.
   */
  async focusTo(target: number, tolerance = 2): Promise<number> {
    const readPos = async () => {
      const s = (await this.request(Cmd.TASK_GET_DEVICE_STATE_INFO, {}, { timeout: 8000 })) as Record<string, any>;
      const p = Number(s.focusMotorStateInfo?.focusPosition?.pos ?? 0);
      this.state.focusPosition = p;
      return p;
    };
    let pos = await readPos();
    for (let pass = 0; pass < 4 && Math.abs(target - pos) > 25; pass++) {
      const far = target > pos;
      const stopAt = far ? target - 12 : target + 12;
      const reached = this.link
        .waitFor((n) => n.name === 'focusPosition' && (far ? Number(n.data.pos ?? 0) >= stopAt : Number(n.data.pos ?? 0) <= stopAt), Math.abs(target - pos) * 15 + 3000)
        .catch(() => null);
      await this.request(Cmd.FOCUS_START_MANUAL_CONTINU_FOCUS, { direction: far ? 0 : 1 }, { bestEffort: true, timeout: 1500 });
      await reached;
      await this.request(Cmd.FOCUS_STOP_MANUAL_CONTINU_FOCUS, {}, { bestEffort: true, timeout: 800 });
      await sleep(400);
      pos = await readPos();
    }
    for (let i = 0; i < 80 && Math.abs(target - pos) > tolerance; i++) {
      await this.request(Cmd.FOCUS_MANUAL_SINGLE_STEP_FOCUS, { direction: target > pos ? 0 : 1 }, { bestEffort: true, timeout: 150 });
      await sleep(120);
      if (i % 5 === 4) pos = await readPos();
      else pos = this.state.focusPosition ?? pos;
    }
    return readPos();
  }

  async focusStep(direction: 'near' | 'far', steps: number): Promise<string> {
    const dir = direction === 'near' ? 1 : 0;
    // Single-step focus commands get no reply from the firmware: fire and pace them.
    for (let i = 0; i < Math.max(1, Math.min(200, steps)); i++) {
      await this.request(Cmd.FOCUS_MANUAL_SINGLE_STEP_FOCUS, { direction: dir }, { bestEffort: true, timeout: 150 });
    }
    await sleep(300);
    return `focus moved ${steps} step(s) ${direction}; position ${this.state.focusPosition ?? '?'}`;
  }

  // -------------------------------------------------------------------------
  // Astronomy
  // -------------------------------------------------------------------------

  /**
   * Plate-solve calibration. Followed through the telescope's notifications: a calibrationResult
   * is success; the calibration state ending without one is failure; an error reply fails at
   * once. The start command's own reply is not waited for (the firmware may send it late or not).
   */
  async calibrate(): Promise<string> {
    this.assertNoNdLock('plate-solve calibration');
    const loc = this.requireLocation();
    await this.ensureMode('DSO');
    const t0 = Date.now();
    const cmd = Cmd.ASTRO_START_CALIBRATION;
    return new Promise<string>((resolve, reject) => {
      let ran = false;
      let done = false;
      let endTimer: NodeJS.Timeout | null = null;
      const finish = (err: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (endTimer) clearTimeout(endTimer);
        this.link.off('notification', onNotify);
        this.link.off('unresponsive', onDead);
        if (err) return reject(err);
        const r = this.state.calibration.result;
        resolve(`calibration complete in ${Math.round((Date.now() - t0) / 1000)} s${r ? ` (azimuth ${r.azimuth.toFixed(2)}°, altitude ${r.altitude.toFixed(2)}°)` : ''}; plate solves: ${this.state.calibration.plateSolvingTimes ?? '?'}`);
      };
      const ended = () => {
        // the result can trail the state change by a moment
        if (!endTimer) endTimer = setTimeout(() => finish((this.state.calibration.at ?? 0) >= t0 ? null : new Error(`calibration ended without a result after ${this.state.calibration.plateSolvingTimes ?? '?'} plate solve(s); plate-solving did not succeed at this pointing`)), 3000);
      };
      const onNotify = (n: Notification) => {
        if (n.name === 'calibrationResult') finish(null);
        else if (n.name === 'calibrationState') {
          const st = astroState(n.data.state);
          if (st === 'running' || st === 'plate_solving') ran = true;
          else if (ran && (st === 'stopped' || st === 'idle')) ended();
        }
      };
      const timer = setTimeout(() => finish((this.state.calibration.at ?? 0) >= t0 ? null : new Error(`calibration did not finish within 7 min (state ${this.state.calibration.state}, ${this.state.calibration.plateSolvingTimes ?? 0} plate solve(s))`)), 420000);
      // a hung telescope never ends the operation: fail now with the reason, not after 7-10 min
      const onDead = (e: Error) => finish(e);
      this.link.on('notification', onNotify);
      this.link.on('unresponsive', onDead);
      this.request(cmd, { lon: loc.lon, lat: loc.lat }, { timeout: 420000, bestEffort: true, allowError: true }).then(
        (r) => {
          const code = Number(r?.code ?? 0);
          if (r && code < 0) finish(new DwarfCommandError(cmd, code, r));
          // a success reply may be the start's acknowledgement: the notifications decide
          else if (r && (this.state.calibration.at ?? 0) >= t0) finish(null);
        },
        (e) => finish(e),
      );
    });
  }

  /**
   * Run an astro operation that may fail with the motors left un-homed (a failed calibration
   * resets pitch and leaves the axes in "need reset", -14520). On failure: re-home if needed and
   * return to the pointing we had before, then rethrow with an explanation.
   */
  async withPointingRecovery<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.exclusive(label, () => this.withPointingRecoveryNow(label, fn));
  }

  private async withPointingRecoveryNow<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const before = await this.readMotorPositions().catch(() => null);
    try {
      return await fn();
    } catch (err) {
      // The telescope is unreachable or hung: every recovery command would fail too, and moving a
      // scope we cannot see could undo a GoTo that the telescope is still carrying out. Report only.
      if (isLinkFailure(err) || !this.link.usable) {
        throw new Error(`${errMsg(err)}. No pointing recovery was attempted (the telescope is not executing commands); once it answers again, check telescope_status before deciding what happened.`);
      }
      // A GoTo that ends up tracking reached its target: leave the scope exactly where it is
      // (tracking also makes the motors report "not homed", which is not a failure).
      if (this.isTracking()) {
        await this.restoreWideLiveView();
        throw new Error(`${errMsg(err)}. The telescope is tracking now, so the pointing was left as is; check the frame (view_camera source=tele, exposure_s=2) before deciding it failed.`);
      }
      await this.restoreWideLiveView();
      // Make sure the failed routine has let go of the motors before we touch them.
      await this.request(Cmd.ASTRO_STOP_ONE_CLICK_GOTO, {}, { bestEffort: true, timeout: 3000 });
      await this.request(Cmd.ASTRO_STOP_CALIBRATION, {}, { bestEffort: true, timeout: 3000 });
      await sleep(5000);
      const after = await this.readMotorPositions().catch(() => null);
      let recovery = '';
      if (after && !after.homed) {
        try {
          await this.homeMotors();
          if (before?.homed && before.pitchDeg !== undefined && before.rotationDeg !== undefined) {
            await this.moveTo({ rotationDeg: before.rotationDeg, pitchDeg: before.pitchDeg }, 15);
            recovery = ` The failed ${label} left the motors un-homed; I re-homed them and returned to the previous pointing (rotation ${before.rotationDeg}°, pitch ${before.pitchDeg}°).`;
          } else {
            recovery = ` The failed ${label} left the motors un-homed; I re-homed them (now pointing down — raise with move_motors).`;
          }
        } catch (e) {
          recovery = ` The failed ${label} left the motors un-homed and automatic re-homing failed (${errMsg(e)}); run motors_home.`;
        }
      } else if (after?.pitchDeg !== undefined && before?.homed && before.pitchDeg !== undefined && before.rotationDeg !== undefined) {
        // The firmware's plate-solve sequence leaves the scope wherever it gave up (often pointing at the ground).
        try {
          await this.moveTo({ rotationDeg: before.rotationDeg, pitchDeg: before.pitchDeg }, 15);
          recovery = ` The failed ${label} had left the scope at rotation ${after.rotationDeg}°, pitch ${after.pitchDeg}°; I returned it to the previous pointing (rotation ${before.rotationDeg}°, pitch ${before.pitchDeg}°).`;
        } catch (e) {
          recovery = ` Scope is at rotation ${after.rotationDeg}°, pitch ${after.pitchDeg}° (altitude ≈ ${Math.round(after.pitchDeg - 90)}°); returning to the previous pointing failed (${errMsg(e)}).`;
        }
      }
      throw new Error(`${errMsg(err)}.${recovery}`);
    } finally {
      await this.restoreWideLiveView();
    }
  }

  /**
   * Calibration/plate-solving leaves the wide camera at a long manual exposure (observed: 1 s),
   * which stops its live video. Put it back to auto afterwards.
   */
  async restoreWideLiveView(): Promise<void> {
    await sleep(500);
    const exp = await this.exposureSeconds('wide').catch(() => null);
    if (exp !== null && exp >= 1) {
      await this.setSetting('wide', 'exposure', 'auto').catch((e) => log.warn(`could not restore wide exposure: ${errMsg(e)}`));
      log.info(`wide exposure was left at ${exp}s by the telescope's calibration; set back to auto for live view`);
    }
  }

  async ensureMode(name: string): Promise<void> {
    const mode = await http.resolveShootingMode(name);
    if (this.state.shootingMode?.id !== mode.id) await this.setShootingMode(mode.id);
  }

  /** GoTo a deep-sky position (RA hours, Dec degrees). Requires prior calibration unless oneClick. */
  async gotoRaDec(raHours: number, decDeg: number, name: string, oneClick: boolean): Promise<string> {
    this.assertNoNdLock('GoTo');
    await this.ensureMode('DSO');
    if (oneClick) {
      const loc = this.requireLocation();
      const dso = await http.resolveShootingMode('DSO');
      return this.runOneClick(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, { ra: raHours, dec: decDeg, targetName: name, lon: loc.lon, lat: loc.lat, shootingMode: dso.id, gotoOnly: false }, name);
    }
    return this.runGoto(Cmd.ASTRO_START_GOTO_DSO, { ra: raHours * 15, dec: decDeg, targetName: name, gotoOnly: false }, name);
  }

  async gotoSolarSystem(body: string, oneClick: boolean): Promise<string> {
    this.assertNoNdLock('GoTo');
    const index = SOLAR_SYSTEM_INDEX[body.toLowerCase()];
    if (!index) throw new Error(`unknown solar system body ${body}`);
    const loc = this.requireLocation();
    const pretty = body[0].toUpperCase() + body.slice(1).toLowerCase();
    if (oneClick) {
      const mode = await http.resolveShootingMode(pretty === 'Moon' ? 'Moon' : pretty === 'Sun' ? 'Sun' : 'Planet');
      await this.ensureMode(mode.name);
      return this.runOneClick(Cmd.ASTRO_START_ONE_CLICK_GOTO_SOLAR_SYSTEM, { index, lon: loc.lon, lat: loc.lat, targetName: pretty, shootingMode: mode.id, forceStart: false }, pretty);
    }
    return this.runGoto(Cmd.ASTRO_START_GOTO_SOLAR_SYSTEM, { index, lon: loc.lon, lat: loc.lat, targetName: pretty, forceStart: false }, pretty);
  }

  /**
   * GoTo on an existing calibration. Complete = tracking (a trackingState notification or a
   * success reply); failed = an error reply, or the GoTo state ending without tracking.
   */
  private runGoto(cmd: number, params: Record<string, unknown>, name: string): Promise<string> {
    const t0 = Date.now();
    return new Promise<string>((resolve, reject) => {
      let ran = false;
      let done = false;
      let endTimer: NodeJS.Timeout | null = null;
      const finish = (err: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (endTimer) clearTimeout(endTimer);
        this.link.off('notification', onNotify);
        this.link.off('unresponsive', onDead);
        if (err) reject(err);
        else resolve(`GoTo ${name} complete in ${Math.round((Date.now() - t0) / 1000)} s; now tracking ${name}`);
      };
      const ended = (why: string) => {
        if (!endTimer) endTimer = setTimeout(() => finish(this.isTracking() ? null : new Error(`GoTo ${name} ended without tracking (${why})`)), 10000);
      };
      const onNotify = (n: Notification) => {
        if (n.name === 'trackingState' && astroState(n.data.state) === 'running') finish(null);
        else if (n.name === 'gotoState') {
          const st = astroState(n.data.state);
          if (st === 'running') ran = true;
          else if (ran && (st === 'stopped' || st === 'idle')) ended(`GoTo state ${st}`);
        }
      };
      const timer = setTimeout(() => finish(this.isTracking() ? null : new Error(`GoTo ${name} did not reach tracking within 10 minutes (GoTo state ${this.state.goto.state})`)), 600000);
      // a hung telescope never ends the operation: fail now with the reason, not after 7-10 min
      const onDead = (e: Error) => finish(e);
      this.link.on('notification', onNotify);
      this.link.on('unresponsive', onDead);
      this.request(cmd, params, { timeout: 600000, bestEffort: true, allowError: true }).then(
        (r) => {
          const code = Number(r?.code ?? 0);
          if (r && code < 0) finish(new DwarfCommandError(cmd, code, r));
          else if (r && this.isTracking()) finish(null);
        },
        (e) => finish(e),
      );
    });
  }

  /** One-click goto replies several times (per step) until all_end. */
  /** The scope is tracking a target (after a GoTo): its motors then report "not homed", which is normal. */
  isTracking(): boolean {
    const oc = this.state.oneClickGoto as { astroTrackingState?: { state?: number } } | undefined;
    return this.state.tracking.state === 'running' || astroState(oc?.astroTrackingState?.state) === 'running';
  }

  /**
   * One-click GoTo: calibrate (plate-solve), slew, refine, track. Verified 2026-10-04 on fw 1.5.3:
   * the telescope reports its progress as oneClickGotoState notifications and reached tracking
   * (M 31, 04:23) without ever sending the allEnd reply this used to wait for, so the GoTo "timed
   * out" and the recovery path moved a scope that was on target. Complete = tracking (or allEnd).
   */
  private runOneClick(cmd: number, params: Record<string, unknown>, name: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const steps: string[] = [];
      const t0 = Date.now();
      let lastStage = '';
      const timer = setTimeout(() => {
        if (this.isTracking()) finish(null);
        else finish(new Error(`one-click GoTo ${name} timed out after 10 minutes without reaching tracking (last stage: ${lastStage || 'none reported'})`));
      }, 600000);
      const onReply = (r: { cmd: number; data: Record<string, any> }) => {
        if (r.cmd !== cmd) return;
        const code = Number(r.data.code ?? 0);
        steps.push(`step ${r.data.step ?? '?'}${code < 0 ? ` error ${errorText(code)}` : ''}`);
        log.info(`one-click GoTo ${name}: reply step ${r.data.step ?? '?'}${code < 0 ? ` error ${errorText(code)}` : ''}${r.data.allEnd ? ' (all end)' : ''}`);
        if (code < 0) finish(new DwarfCommandError(cmd, code, r.data));
        else if (r.data.allEnd) finish(null);
      };
      const onNotify = (n: Notification) => {
        if (n.name === 'oneClickGotoState') {
          const d = n.data as Record<string, any>;
          const key = ['astroTrackingState', 'astroAutoFocusState', 'astroGotoState', 'astroCalibrationState'].find((k) => d[k]);
          if (!key) return;
          const stage = `${key.replace(/^astro|State$/g, '')} ${astroState(d[key].state)}`;
          if (stage !== lastStage) {
            lastStage = stage;
            steps.push(stage);
            log.info(`one-click GoTo ${name}: ${stage} (${Math.round((Date.now() - t0) / 1000)} s)`);
          }
          if (key === 'astroTrackingState' && astroState(d[key].state) === 'running') finish(null);
        } else if (n.name === 'trackingState' && astroState(n.data.state) === 'running') {
          finish(null);
        }
      };
      let done = false;
      const finish = (err: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.link.off('reply', onReply);
        this.link.off('notification', onNotify);
        this.link.off('unresponsive', onDead);
        if (err) reject(err);
        else resolve(`one-click GoTo ${name} complete in ${Math.round((Date.now() - t0) / 1000)} s (${steps.join(' → ')}); now tracking ${name}`);
      };
      this.link.on('reply', onReply);
      // a hung telescope never ends the operation: fail now with the reason, not after 7-10 min
      const onDead = (e: Error) => finish(e);
      this.link.on('notification', onNotify);
      this.link.on('unresponsive', onDead);
      this.request(cmd, params, { bestEffort: true, timeout: 600000, allowError: true }).catch((e) => finish(e));
    });
  }

  async stopGoto(): Promise<void> {
    await this.request(Cmd.ASTRO_STOP_GOTO, {}, { bestEffort: true, timeout: 5000 });
    await this.request(Cmd.ASTRO_STOP_ONE_CLICK_GOTO, {}, { bestEffort: true, timeout: 5000 });
  }

  async trackSunMoon(body: 'sun' | 'moon', action: 'start' | 'stop'): Promise<void> {
    if (action === 'start') this.assertNoNdLock('Sun/Moon tracking');
    if (action === 'stop') {
      await this.send(Cmd.ASTRO_STOP_TRACK_SPECIAL_TARGET, {}, `stop ${body} tracking`, { confirm: () => !this.isTracking() });
      return;
    }
    const loc = this.requireLocation();
    // the reply may come only once it tracks (or never): tracking in the state also confirms
    await this.send(Cmd.ASTRO_START_TRACK_SPECIAL_TARGET, { index: body === 'sun' ? 0 : 1, lon: loc.lon, lat: loc.lat }, `${body} tracking`, { timeout: 180000, confirmMs: 30000, confirm: () => this.isTracking() });
  }

  async startStacking(camera: CameraName, opts: { filterIndex?: number; force?: boolean } = {}): Promise<string> {
    this.assertNoOperation('starting live stacking');
    this.assertNoNdLock('live stacking');
    if (camera === 'tele') {
      let ir = opts.filterIndex;
      if (ir === undefined) {
        const schema = await http.getParamSchema(await this.currentModeId());
        const def = schema.cameras[0]?.filterType;
        const live = def ? this.params.get(String(def.paramId))?.value : undefined;
        ir = typeof live === 'number' ? live : typeof def?.currentValue === 'number' ? (def.currentValue as number) : 0;
      }
      const t0 = Date.now();
      // fw 1.5.3 does not always acknowledge this (verified 2026-10-04: no reply in 30 s while the
      // stack ran normally), so a missing reply is checked against the stacking notifications.
      const r = await this.request(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING, { irIndex: ir, forceStart: !!opts.force }, { timeout: 20000, allowError: true, bestEffort: true });
      const code = Number(r?.code ?? 0);
      if (!r) {
        if (!(await this.stackingConfirmed('tele', t0, 45000))) {
          throw new Error('the telescope neither acknowledged the live-stacking start nor reported stacking within 65 s. Check stacking_status before retrying (it may still start).');
        }
        return `tele live stacking started (filter ${FILTERS[ir] ?? ir}); confirmed from the telescope's stacking progress (it does not acknowledge this command)`;
      }
      if (code < 0) {
        // With force_start the firmware reports the missing prerequisite but starts a preview-only stack.
        await sleep(3000);
        if (this.state.stacking.tele.state !== 'running') throw new DwarfCommandError(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING, code, r ?? {});
        return `WARNING: ${errorText(code)}. The telescope started a forced preview stack anyway, but without calibration+GoTo it does not save a session or FITS. For a real capture run goto_target first.`;
      }
      this.state.stacking.tele = { state: 'running', startedAt: Date.now() };
      return `tele live stacking started (filter ${FILTERS[ir] ?? ir})`;
    }
    const t0 = Date.now();
    const r = await this.request(Cmd.ASTRO_START_WIDE_CAPTURE_LIVE_STACKING, { forceStart: !!opts.force }, { timeout: 20000, allowError: true, bestEffort: true });
    const code = Number(r?.code ?? 0);
    if (code < 0) throw new DwarfCommandError(Cmd.ASTRO_START_WIDE_CAPTURE_LIVE_STACKING, code, r ?? {});
    if (!r && !(await this.stackingConfirmed('wide', t0, 45000))) {
      throw new Error('the telescope neither acknowledged the wide live-stacking start nor reported stacking within 65 s. Check stacking_status before retrying.');
    }
    if (r) this.state.stacking.wide = { state: 'running', startedAt: Date.now() };
    return 'wide live stacking started';
  }

  /** Stacking reported as running by the telescope's own notifications since `since`. */
  private async stackingConfirmed(camera: CameraName, since: number, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = this.state.stacking[camera];
      if (s.state === 'running' && Math.max(s.updatedAt ?? 0, s.startedAt ?? 0) >= since) return true;
      await sleep(500);
    }
    return false;
  }

  /** Who started the current stack and when we asked it to stop (to tell a requested stop from one the scope made itself). */
  readonly stackControl: Record<CameraName, { startedBy?: 'agent' | 'ui'; stopRequestedAt?: number }> = { tele: {}, wide: {} };

  async stopStacking(camera: CameraName, fast = false): Promise<void> {
    const cmd = camera === 'tele' ? (fast ? 11037 : Cmd.ASTRO_STOP_CAPTURE_RAW_LIVE_STACKING) : fast ? 11038 : Cmd.ASTRO_STOP_WIDE_CAPTURE_LIVE_STACKING;
    this.stackControl[camera].stopRequestedAt = Date.now();
    // A normal stop finishes the final stack first; the stacking state is the proof either way.
    await this.send(cmd, {}, `stop ${camera} stacking`, { timeout: 30000, confirmMs: 120000, confirm: () => this.state.stacking[camera].state !== 'running' });
  }

  /** EQ-mode polar alignment measurement. Returns the polar axis error. */
  async measurePolarAlignment(): Promise<{ azimuthErrorDeg: number; altitudeErrorDeg: number }> {
    return this.exclusive('polar alignment', () => this.measurePolarAlignmentNow());
  }

  private async measurePolarAlignmentNow(): Promise<{ azimuthErrorDeg: number; altitudeErrorDeg: number }> {
    this.assertNoNdLock('polar alignment');
    const loc = this.requireLocation();
    const reply = await this.request(Cmd.ASTRO_START_EQ_SOLVING, { lon: loc.lon, lat: loc.lat }, { timeout: 600000 });
    const code = Number(reply?.code ?? 0);
    if (code < 0) throw new DwarfCommandError(Cmd.ASTRO_START_EQ_SOLVING, code, reply ?? {});
    const res = { azimuthErrorDeg: Number(reply?.aziErr ?? 0), altitudeErrorDeg: Number(reply?.altErr ?? 0) };
    this.state.eqSolving = { state: 'idle', result: { ...res, at: Date.now() } };
    this.changed();
    return res;
  }

  async stopPolarAlignment(): Promise<void> {
    await this.request(Cmd.ASTRO_STOP_EQ_SOLVING, {}, { bestEffort: true, timeout: 5000 });
  }

  // -------------------------------------------------------------------------
  // Daytime tracking
  // -------------------------------------------------------------------------

  async trackObject(camera: CameraName, box: { x: number; y: number; w: number; h: number }): Promise<void> {
    this.assertNoNdLock('object tracking');
    // fw 1.5.3 doesn't reply to 14800; tracking is confirmed by track-result notifications.
    const started = this.link.waitFor((n) => /trackResult|normalTrackState/i.test(n.name), 8000).catch(() => null);
    await this.request(Cmd.TRACK_START_TRACK, { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), camId: camId(camera) }, { bestEffort: true, timeout: 3000 });
    if (!(await started)) throw new Error('tracker did not report a lock within 8 s — check the box covers the subject');
  }

  async stopTracking(): Promise<void> {
    await this.request(Cmd.TRACK_STOP_TRACK, {}, { bestEffort: true, timeout: 5000 });
  }

  async sentry(action: 'start' | 'stop', type = 0): Promise<void> {
    if (action === 'start') this.assertNoNdLock('sentry mode');
    if (action === 'start') await this.send(Cmd.SENTRY_MODE_START, { type }, 'start sentry mode', { confirm: () => !!this.state.sentry && this.state.sentry.state !== 'idle' });
    else await this.send(Cmd.SENTRY_MODE_STOP, {}, 'stop sentry mode', { confirm: () => !this.state.sentry || this.state.sentry.state === 'idle' });
  }

  /** Escape hatch: send any command with an explicit proto type. */
  /** The tele camera's dark masters as the firmware lists them (11023): its own index codes plus readable names. */
  async darkFrameList(): Promise<Array<{ expIndex: number; gainIndex: number; binIndex: number; exposure: string; gain: string; bin: string; temperatureC?: number }>> {
    const r = await this.request(11023, {}, { timeout: 15000 });
    return ((r?.results ?? []) as Array<Record<string, any>>).map((d) => ({
      expIndex: Number(d.expIndex ?? 0),
      gainIndex: Number(d.gainIndex ?? 0),
      binIndex: Number(d.binIndex ?? 0),
      exposure: String(d.expName ?? ''),
      gain: String(d.gainName ?? ''),
      bin: String(d.binName ?? ''),
      temperatureC: d.temperature ?? undefined,
    }));
  }

  /** Re-check for the finished master now (set while a capture runs). */
  private darkCheck: (() => void) | null = null;

  /**
   * Start a tele dark master (11021) with the firmware's index codes. The firmware does not
   * answer this command (verified 2026-10-03: 20 x 15 s and 20 x 30 s masters saved, no reply),
   * so completion is detected from its state notification and, reliably, from the master file
   * appearing (or being rewritten) in CALI_FRAME/dark/cam_0. Only an immediate refusal is
   * reported here; state.darkCapture follows the rest.
   */
  async captureDarks(o: { expIndex: number; gainIndex: number; binIndex: number; frames: number; exposureS: number; gain: number }): Promise<void> {
    if (this.state.darkCapture?.state === 'running') throw new Error('a dark capture is already running (dark_frames action=status)');
    const dir = '/Astronomy/CALI_FRAME/dark/cam_0';
    const key = (f: { name: string; size: number; modifiedAt?: string }) => `${f.size}|${f.modifiedAt ?? ''}`;
    const before = new Map((await listDir(dir).catch(() => [])).map((f) => [f.name, key(f)]));
    const want = new RegExp(`^dark_exp_${o.exposureS.toFixed(6).replace('.', '\\.')}_gain_${o.gain}_.*stack_${o.frames}\\.fits$`, 'i');
    const now = Date.now();
    const runMs = o.frames * o.exposureS * 1000;
    this.state.darkCapture = { state: 'running', fwState: undefined, exposureS: o.exposureS, gain: o.gain, frames: o.frames, sensorC: this.state.cmosTempC.tele, startedAt: now, expectedEndAt: now + runMs + 60000, progress: 0 };
    this.changed();
    const finish = (patch: Partial<NonNullable<TelescopeState['darkCapture']>>) => {
      if (this.state.darkCapture?.state !== 'running') return;
      this.state.darkCapture = { ...this.state.darkCapture, ...patch, remainingS: 0, finishedAt: Date.now() };
      clearInterval(timer);
      this.darkCheck = null;
      log.info(`dark capture ${o.exposureS} s / gain ${o.gain}: ${this.state.darkCapture.state}${this.state.darkCapture.master ? ` (${this.state.darkCapture.master})` : ''}${this.state.darkCapture.error ? ` — ${this.state.darkCapture.error}` : ''}`);
      this.changed();
    };
    let checking = false;
    const check = async () => {
      if (checking || this.state.darkCapture?.state !== 'running') return;
      checking = true;
      try {
        const files = await listDir(dir);
        const hit = files.find((f) => want.test(f.name) && before.get(f.name) !== key(f));
        if (hit) finish({ state: 'done', progress: 100, master: hit.name });
        else if (Date.now() > now + runMs * 2 + 300000) finish({ state: 'unknown', error: 'no new master appeared in CALI_FRAME; check dark_frames action=list' });
      } catch {
        /* FTP busy: next round */
      } finally {
        checking = false;
      }
    };
    this.darkCheck = () => void check();
    // the master can only exist after frames x exposure: look from 90 % of that on, every 20 s
    const timer = setInterval(() => {
      if (Date.now() >= now + runMs * 0.9) void check();
    }, 20000);
    // in case a firmware version does answer: a refusal comes back at once
    const reply = this.request(11021, { expIndex: o.expIndex, gainIndex: o.gainIndex, binIndex: o.binIndex, capSize: o.frames }, { bestEffort: true, allowError: true, timeout: 8000 });
    const r = await reply.catch(() => null);
    const code = Number(r?.code ?? 0);
    if (code < 0) {
      finish({ state: 'failed', error: errorText(code) });
      throw new Error(`the telescope refused the dark capture: ${errorText(code)}`);
    }
  }

  async stopDarks(): Promise<void> {
    await this.request(11022, {}, { bestEffort: true, timeout: 10000 });
    if (this.state.darkCapture?.state === 'running') this.state.darkCapture = { ...this.state.darkCapture, state: 'stopped', finishedAt: Date.now() };
    this.darkCheck = null;
    this.changed();
  }

  async raw(cmd: number, params: Record<string, unknown>, reqType?: string, resType?: string, timeoutMs = 15000) {
    return this.request(cmd, params, {
      reqType: reqType ? protoTypeByName(reqType) : undefined,
      resType: resType ? protoTypeByName(resType) : undefined,
      timeout: timeoutMs,
      allowError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const FILTERS = ['VIS (no filter / UV-IR cut)', 'Astro (IR pass)', 'Duo-Band (Ha/OIII)'];
export const WB_SCENES = ['Incandescent', 'Warm Fluorescent', 'Fluorescent', 'Sunlight', 'Cloudy', 'Shadow', 'Twilight'];

function resolveFilter(v: unknown): number {
  const s = String(v).toLowerCase();
  if (/^\d$/.test(s)) return Number(s);
  if (s.includes('duo') || s.includes('ha') || s.includes('narrow') || s.includes('dual')) return 2;
  if (s.includes('astro') || s.includes('ir pass') || s.includes('irpass')) return 1;
  if (s.includes('vis') || s.includes('none') || s.includes('normal') || s.includes('uv')) return 0;
  throw new Error(`unknown filter "${v}" (use VIS, Astro, or Duo-Band)`);
}

function matchExposure(values: Array<{ name: string; value: number }>, want: unknown) {
  const s = String(want).trim().toLowerCase().replace(/s(ec(onds?)?)?$/, '').trim();
  const exact = values.find((v) => v.name.toLowerCase() === s);
  if (exact) return exact;
  const secs = (name: string) => {
    if (name.includes('/')) {
      const [a, b] = name.split('/').map(Number);
      return a / b;
    }
    return Number(name);
  };
  const target = secs(s);
  if (!Number.isFinite(target) || target <= 0) throw new Error(`exposure "${want}" not understood; use e.g. "1/100", "0.5", "15" or "auto"`);
  return values.reduce((a, b) => (Math.abs(Math.log(secs(b.name) / target)) < Math.abs(Math.log(secs(a.name) / target)) ? b : a));
}

function describeParam(def: http.ParamDef, live?: unknown) {
  const out: Record<string, unknown> = { current: live ?? def.currentValue };
  if (def.valueType === 3) out.type = 'bool';
  else if (def.values) out.options = def.values;
  else if (def.minValue !== undefined) out.range = `${def.minValue}..${def.maxValue}`;
  return out;
}

const snake = (s: string) => s.replace(/([A-Z])/g, '_$1').toLowerCase();

function bodyMode(v: unknown): 'eq' | 'altaz' | 'unknown' {
  return v === 1 ? 'eq' : v === 2 ? 'altaz' : 'unknown';
}

export function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function timezoneOffsetHours(tz: string, at: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    const part = dtf.formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    if (!m) return part === 'GMT' ? 0 : null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3] ?? 0) / 60);
  } catch {
    return null;
  }
}
