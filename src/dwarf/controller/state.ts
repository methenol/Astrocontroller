/**
 * The telescope's published state and how the firmware's reports change it.
 *
 * `applyNotification` and `applyDeviceStateInfo` are the only places that turn firmware reports
 * into state; they are pure apart from mutating the state they are given, so they are tested
 * without a link. The `StateStore` owns the state object and throttles change broadcasts.
 */
import type { LinkHealth, Notification } from '../link.js';
import type { TravelForecast } from '../travel-guard.js';
import type { CameraName, StackingInfo } from '../stacking.js';
import { logger, errMsg } from '../../log.js';
import { astroState, bodyMode, deviceOn, opState, round, WB_SCENES } from './util.js';

const log = logger('dwarf');
/** State broadcasts are coalesced to one per this. */
const STATE_THROTTLE_MS = 150;

/**
 * In DSO mode the firmware (1.5.3.9) echoes a set of an astro camera parameter (context byte 0x02,
 * e.g. tele exposure 0x0201000000000001) under context 0x0b, and the wide one (0x0201100000000001)
 * under 0x0c; it reports the 0x02 id itself during a stack. Both are the same setting, so the
 * echo is stored under the id that is sent.
 */
const ASTRO_ECHO_CONTEXTS = new Set([0x0bn, 0x0cn]);
export function canonicalParamId(id: unknown): string {
  const s = String(id);
  let v: bigint;
  try {
    v = BigInt(s);
  } catch {
    return s;
  }
  return ASTRO_ECHO_CONTEXTS.has(v >> 56n) ? String((0x02n << 56n) | (v & ((1n << 56n) - 1n))) : s;
}

const teleInWide = (d: Record<string, any>) => ({ x: d.x ?? 0, y: d.y ?? 0, width: d.width ?? 0, height: d.height ?? 0 });
const fov = (c: Record<string, any>) => ({ h: round(c.hFov, 3), v: round(c.vFov ?? 0, 3) });

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

/** Progress of the obstruction survey (media/horizon/survey.ts), for the web UI. */
export interface HorizonSurvey {
  running: boolean;
  phase: string;
  startedAt: number;
  finishedAt?: number;
  index?: number;
  total?: number;
  message?: string;
  error?: string;
  /** the mask it saved */
  maskId?: string;
}

export interface DarkCaptureState {
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
  /** Wide/guide encoder positions: the SDK's state schema predated them, the APK's carries them. */
  wideFocusPosition?: number;
  guideFocusPosition?: number;
  /** Device switches, carried on the wire as `DeviceSwitchState` (0 off, 1 on). */
  switches?: { antiTangle?: boolean; lensDefog?: boolean; autoCooling?: boolean; autoShutdown?: boolean; powerSound?: boolean; doNotDisturb?: boolean };
  /** The device's own IMU attitude, in degrees, as it reports it (`CMD_NOTIFY_DEVICE_ATTITUDE`). */
  attitude?: { pitchDeg: number; yawDeg: number; rollDeg: number; at: number };
  motors: { rotationDeg?: number; pitchDeg?: number; homed?: boolean; updatedAt?: number };
  fov: { tele?: { h: number; v: number }; wide?: { h: number; v: number } };
  teleInWide?: { x: number; y: number; width: number; height: number };
  calibration: { state: string; plateSolvingTimes?: number; result?: { azimuth: number; altitude: number }; at?: number };
  goto: { state: string; target?: string; at?: number };
  tracking: { state: string; target?: string; at?: number };
  oneClickGoto?: Record<string, unknown>;
  stacking: { tele: StackingInfo; wide: StackingInfo };
  darkCapture?: DarkCaptureState;
  /** ND filter fitted for dark frames: nothing may move the scope or take light frames. */
  ndLock?: { since: number; note: string } | null;
  eqSolving: { state: string; result?: { azimuthErrorDeg: number; altitudeErrorDeg: number; at: number } };
  autofocus: { state: string; astro?: string };
  /** a star-sharpness measurement or focus sweep in progress (media/focus.ts publishes its progress here) */
  focusTune?: FocusTune;
  /** the obstruction survey in progress or last run */
  horizonSurvey?: HorizonSurvey;
  capture: { photo?: string; burst?: string; record?: string; timelapse?: string; panorama?: string; burstProgress?: string };
  sentry?: { state: string; objectType?: number };
  trackResult?: Record<string, unknown>;
  /** daytime object tracking (track_object), from its normalTrackState reports */
  objectTracking?: { camera: CameraName; state: string };
  whiteBalance: { tele?: Record<string, unknown>; wide?: Record<string, unknown> };
  /** rotation-travel forecast for the running tele stack (travel-guard.ts) */
  travel?: TravelForecast;
  /** the last astro-service recovery; ok: whether retrying the refused command worked (undefined until tried) */
  astroRecovery?: { at: number; ok?: boolean; steps: string[] };
  /** a camera whose photo never finished, since when (photo-watch.ts): it refuses commands until a reboot */
  photoStuckSince?: Partial<Record<CameraName, number>>;
  lastNotificationAt?: number;
}

export function initialState(): TelescopeState {
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

/** Live parameter values keyed by packed paramId (decimal string), as the telescope pushes them. */
export type ParamCache = Map<string, { mode?: number; value?: number | boolean; ts: number }>;

const SENTRY_STATES = ['idle', 'init', 'detect', 'track', 'track_finish', 'stopping'];

/**
 * Apply one notification to the state. Stacking notifications are not handled here (the stack
 * tracker owns them), nor are shooting-mode changes (their name needs an HTTP lookup): the caller
 * routes those.
 */
export function applyNotification(st: TelescopeState, params: ParamCache, n: Notification): void {
  const d = n.data as Record<string, any>;
  st.lastNotificationAt = n.ts;
  const cam: CameraName = (d.cameraType ?? d.camId ?? 0) === 1 ? 'wide' : 'tele';
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
  case 'wideFocusPosition':
    st.wideFocusPosition = d.pos ?? 0;
    break;
  case 'guideFocusPosition':
    st.guideFocusPosition = d.pos ?? 0;
    break;
  case 'antiTangleState':
    st.switches = { ...st.switches, antiTangle: deviceOn(d.state) };
    break;
  case 'lensDefogState':
    st.switches = { ...st.switches, lensDefog: deviceOn(d.state) };
    break;
  case 'autoCoolingState':
    st.switches = { ...st.switches, autoCooling: deviceOn(d.state) };
    break;
  case 'autoShutdownState':
    st.switches = { ...st.switches, autoShutdown: deviceOn(d.state) };
    break;
  case 'powerSoundState':
    st.switches = { ...st.switches, powerSound: deviceOn(d.state) };
    break;
  case 'shootingDoNotDisturbState':
    st.switches = { ...st.switches, doNotDisturb: deviceOn(d.state) };
    break;
  case 'deviceAttitude':
    st.attitude = { pitchDeg: d.pitch ?? 0, yawDeg: d.yaw ?? 0, rollDeg: d.roll ?? 0, at: n.ts };
      break;
    case 'bodyStatus':
      st.bodyMode = bodyMode(d.bodyStatus);
      break;
    case 'pictureMatching':
      st.teleInWide = teleInWide(d);
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
      st.tracking = { state: astroState(d.state), target: d.targetName ?? st.tracking.target, at: n.ts };
      break;
    case 'oneClickGotoState':
      st.oneClickGoto = { ...d, at: n.ts };
      // a one-click GoTo reports its tracking here, not as a trackingState: without this the status
      // read "tracking: idle" all night while the scope tracked (2026-10-13, C 20)
      if (d.astroTrackingState) {
        const t = d.astroTrackingState as { state?: number; targetName?: string };
        st.tracking = { state: astroState(t.state), target: t.targetName ?? st.tracking.target, at: n.ts };
      }
      break;
    case 'darkCaptureState': {
      const fw = opState(d.state);
      const cur = st.darkCapture;
      // A capture the controller started (startedAt set) ends by its master appearing, not by this
      // state. Any other (the DWARFLAB app's, or one running across a restart) follows the firmware:
      // kept at "running" it would hold the tele camera and the busy state for ever.
      if (cur?.state === 'running' && cur.startedAt !== undefined) st.darkCapture = { ...cur, fwState: fw };
      else if (fw === 'running') st.darkCapture = { state: 'running', fwState: fw };
      else if (cur?.state === 'running') st.darkCapture = { ...cur, state: fw, fwState: fw, finishedAt: n.ts };
      // after a finished capture a trailing "idle" keeps its outcome (done, the master)
      else st.darkCapture = { ...cur, state: cur?.state ?? fw, fwState: fw };
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
      st.sentry = { state: SENTRY_STATES[d.state ?? 0] ?? String(d.state), objectType: d.objectType };
      break;
    case 'normalTrackState':
      st.objectTracking = { camera: cam, state: opState(d.state) };
      break;
    case 'trackResult':
    case 'wideTrackResult':
    case 'sentryTrackResult':
      st.trackResult = { ...d, camera: n.name === 'wideTrackResult' ? 'wide' : 'tele', at: n.ts };
      break;
    case 'intParam':
      // proto3 omits zero values: a missing mode is mode 0 (auto), a missing value is 0.
      if (d.paramId) params.set(canonicalParamId(d.paramId), { mode: d.mode ?? 0, value: d.value ?? 0, ts: n.ts });
      break;
    case 'boolParam':
      if (d.paramId) params.set(canonicalParamId(d.paramId), { value: Boolean(d.value), ts: n.ts });
      break;
    case 'whiteBalance':
      st.whiteBalance[cam] = {
        mode: ['auto', 'kelvin', 'scene'][Number(d.mode ?? 0)] ?? d.mode,
        kelvin: d.ct,
        scene: d.scene !== undefined && d.scene >= 0 ? WB_SCENES[d.scene] : undefined,
      };
      break;
  }
}

/**
 * The `DeviceStateInfo` entries that carry a `DeviceSwitchState`, keyed as the state model names them.
 * The SDK's schema for the state read stops before all of these; the APK's carries them.
 */
const SWITCH_FIELDS: Readonly<Record<string, keyof NonNullable<TelescopeState['switches']>>> = Object.freeze({
  antiTangle: 'antiTangle',
  lensDefog: 'lensDefog',
  autoCooling: 'autoCooling',
  autoShutdown: 'autoShutdown',
  powerSound: 'powerSound',
  shootingDoNotDisturb: 'doNotDisturb',
});

/**
 * Apply a device state read (TASK_GET_DEVICE_STATE_INFO). Returns the tele camera's capture state
 * (exclusiveState.captureRawState: 1 running, 3 stopped but not finished, on fw 1.5.3; the wide
 * entry is not known to carry it), whether a tele photo is running (exclusiveState.photoState 1),
 * and the shooting mode id, which the caller resolves to a name.
 */
export function applyDeviceStateInfo(
  st: TelescopeState,
  s: Record<string, any>,
): { teleCapturing: boolean; teleCaptureState: number; telePhotoRunning: boolean; shootingModeId?: number } {
  const tele = s.teleCameraStateInfo ?? {};
  const wide = s.wideCameraStateInfo ?? {};
  if (tele.hFov) st.fov.tele = fov(tele);
  if (wide.hFov) st.fov.wide = fov(wide);
  if (tele.cmosTemperature) st.cmosTempC.tele = tele.cmosTemperature.temperature ?? 0;
  if (wide.cmosTemperature) st.cmosTempC.wide = wide.cmosTemperature.temperature ?? 0;
  const dev = s.deviceStateInfo ?? {};
  if (dev.batteryInfo) st.battery = dev.batteryInfo.percentage ?? 0;
  if (dev.chargingState) st.charging = (dev.chargingState.state ?? 0) > 0;
  if (dev.temperature) st.temperatureC = dev.temperature.temperature ?? 0;
  if (dev.storageInfo) st.storage = { availableGB: dev.storageInfo.availableSize ?? 0, totalGB: dev.storageInfo.totalSize ?? 0 };
  if (dev.bodyStatus) st.bodyMode = bodyMode(dev.bodyStatus.bodyStatus);
  if (dev.pictureMatching) st.teleInWide = teleInWide(dev.pictureMatching);
  const sw: Partial<NonNullable<TelescopeState['switches']>> = {};
  for (const [field, key] of Object.entries(SWITCH_FIELDS)) if (dev[field]) sw[key] = deviceOn(dev[field].state);
  if (Object.keys(sw).length) st.switches = { ...st.switches, ...sw };
  const focus = s.focusMotorStateInfo?.focusPosition;
  // proto3 omits 0: a focusPosition entry without pos is position 0
  if (focus) st.focusPosition = focus.pos ?? 0;
  const wideFocus = s.wideFocusMotorStateInfo?.focusPosition;
  if (wideFocus) st.wideFocusPosition = wideFocus.pos ?? 0;
  const guideFocus = s.guideFocusMotorStateInfo?.focusPosition;
  if (guideFocus) st.guideFocusPosition = guideFocus.pos ?? 0;
  applyMotionState(st, s.motionMotorStateInfo?.exclusiveState);
  const teleCaptureState = Number(tele.exclusiveState?.captureRawState?.state ?? 0);
  return {
    teleCapturing: teleCaptureState === 1,
    teleCaptureState,
    telePhotoRunning: Number(tele.exclusiveState?.photoState?.state ?? 0) === 1,
    shootingModeId: typeof s.shootingMode === 'number' ? s.shootingMode : undefined,
  };
}

/**
 * The mount's routine in a device state read: a one-click GoTo that is tracking reads
 * `{oneClickGotoState:{astroTrackingState:{state:1,targetName}}, currentState:'oneClickGotoState'}`
 * (2026-10-13, fw 1.5.3.9). Without it a restart or reconnect forgot that the scope was tracking.
 * An empty exclusive state is a mount doing nothing, which ends a tracking known from before.
 */
function applyMotionState(st: TelescopeState, motion: Record<string, any> | undefined): void {
  if (!motion) return;
  const now = Date.now();
  const oc = motion.oneClickGotoState;
  if (oc) st.oneClickGoto = { ...oc, at: (st.oneClickGoto as { at?: number } | undefined)?.at ?? now };
  const tr = oc?.astroTrackingState ?? motion.trackingState ?? motion.astroTrackingState;
  if (tr) {
    const state = astroState(tr.state);
    // the time is when tracking was first seen: a re-read of the same tracking is not a new start
    const at = st.tracking.state === state ? (st.tracking.at ?? now) : now;
    st.tracking = { state, target: tr.targetName ?? st.tracking.target, at };
  } else if (!motion.currentState) {
    if (st.tracking.state === 'running') st.tracking = { state: 'idle', target: st.tracking.target, at: now };
    if (st.oneClickGoto) st.oneClickGoto = undefined;
  }
}

/** Owns the state object; change broadcasts are coalesced to one per `throttleMs`. */
export class StateStore {
  readonly state: TelescopeState;
  private pending = false;

  constructor(
    private readonly emit: (state: TelescopeState) => void,
    private readonly throttleMs = STATE_THROTTLE_MS,
    state: TelescopeState = initialState(),
  ) {
    this.state = state;
  }

  changed(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      try {
        this.emit(this.state);
      } catch (e) {
        // a failing subscriber must not stop later broadcasts
        log.error(`a state listener failed: ${errMsg(e)}`);
      }
    }, this.throttleMs).unref();
  }

  publish(patch: Partial<TelescopeState>): void {
    Object.assign(this.state, patch);
    this.changed();
  }
}
