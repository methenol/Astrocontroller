/**
 * What is known about the Seestar, folded from get_device_state / iscope_get_app_state replies and
 * the notifications on the control link. Pure functions over one state object, so the device can
 * be reasoned about and tested without a scope.
 *
 * The star session runs two views: View (tele) and SecondView (wide). The *selected* camera is the
 * one whose view exposes; the other sleeps. Operations (AutoGoto, AutoFocus, Stack, ScopeHome,
 * 3PPA…) report themselves as events: inner steps carry `page`, the outer frame carries `route`
 * and `lapse_ms`; a terminal inner step while the outer frame still runs is kept as `<name>.step`.
 */
import type { LinkHealth } from './link.js';
import type { TunnelStatus } from './tunnel.js';
import type { Camera } from './frames.js';

export const TERMINAL_STATES = new Set(['complete', 'fail', 'cancel']);
/** inner steps that set a view's stage while working and clear it when done */
export const STAGE_EVENTS = new Set(['ContinuousExposure', 'Sleep', 'Stack', 'AutoGoto', 'AutoFocus', 'PlateSolve', 'Initialise', 'DarkLibrary']);
const QUIET_EVENTS = new Set(['PiStatus', 'Exposure', 'FocuserMove', 'Annotate', 'BalanceSensor', 'GSensorMove']);
const RECENT_MAX = 60;

export const VIEW_OF: Record<Camera, 'View' | 'SecondView'> = { tele: 'View', wide: 'SecondView' };
export const CAMERA_OF: Record<string, Camera> = { View: 'tele', SecondView: 'wide' };

export interface OperationState {
  state: string;
  at: number;
  error?: string;
  code?: number;
  outer: boolean;
  detail?: Record<string, unknown>;
}

export interface ViewState {
  state?: string;
  mode?: string;
  targetType?: string;
  stage?: string;
  target?: string;
  targetRaDec?: [number, number];
  lpFilter?: boolean;
  gain?: number;
}

export interface SeestarState {
  driver: 'seestar';
  connection: 'local' | 'zwo';
  connected: boolean;
  released: boolean;
  link: LinkHealth | null;
  tunnel: TunnelStatus | null;
  device: {
    name?: string;
    model?: string;
    serial?: string;
    firmware?: string;
    firmwareInt?: number;
    focalLengthMm?: number;
    fNumber?: number;
    chipSize?: [number, number];
    pixelSizeUm?: number;
  };
  fov: { h: number; v: number } | null;
  mount: { raHours?: number; decDeg?: number; altDeg?: number; azDeg?: number; tracking?: boolean; eqMode?: boolean; parked?: boolean; moving?: string; at?: number };
  /** the tele camera's view */
  view: ViewState;
  /** the wide camera's view */
  secondView: ViewState;
  /** the camera whose view exposes, as the firmware last said */
  camera: Camera | null;
  stack: { state?: string; stacked?: number; dropped?: number; total?: number; lastError?: string; jpg?: string; at?: number };
  focus: { position?: number; maxStep?: number };
  /** the wide camera's own focuser (second_focuser): the firmware puts it at its infinity when the wide view starts */
  wideFocus: { position?: number; maxStep?: number };
  power: { batteryPct?: number; charging?: boolean; chargerStatus?: string; tempC?: number; overTemp?: boolean };
  storage: { freeMB?: number; totalMB?: number };
  ops: Record<string, OperationState>;
  alert: { error?: string; code?: number; at?: number };
  lastEventAt: number | null;
  recent: Array<{ at: number; event: string; state?: string; summary: string }>;
  deviceState: Record<string, unknown> | null;
  polarAlign: Record<string, unknown> | null;
  horizonSurvey: Record<string, unknown> | null;
  focusTune: Record<string, unknown> | null;
}

export function initialState(connection: 'local' | 'zwo'): SeestarState {
  return {
    driver: 'seestar',
    connection,
    connected: false,
    released: false,
    link: null,
    tunnel: null,
    device: {},
    fov: null,
    mount: {},
    view: {},
    secondView: {},
    camera: null,
    stack: {},
    focus: {},
    wideFocus: {},
    power: {},
    storage: {},
    ops: {},
    alert: {},
    lastEventAt: null,
    recent: [],
    deviceState: null,
    polarAlign: null,
    horizonSurvey: null,
    focusTune: null,
  };
}

type Obj = Record<string, any>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
export const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length >= 2 && num(v[0]) !== undefined && num(v[1]) !== undefined ? [v[0], v[1]] : undefined);

/** Field of view (degrees) from the sensor and focal length. */
export function fovFromOptics(chip: [number, number] | undefined, pixelUm: number | undefined, focalMm: number | undefined): { h: number; v: number } | null {
  if (!chip || !pixelUm || !focalMm) return null;
  const [a, b] = chip;
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  const deg = (px: number) => (2 * Math.atan((px * pixelUm) / 1000 / 2 / focalMm) * 180) / Math.PI;
  return { h: +deg(short).toFixed(3), v: +deg(long).toFixed(3) };
}

export function applyDeviceState(st: SeestarState, r: Obj): void {
  st.deviceState = r;
  const d = obj(r.device);
  if (d) {
    st.device.name = str(d.name) ?? st.device.name;
    st.device.model = str(d.user_product_model) ?? str(d.product_model) ?? st.device.model;
    st.device.serial = str(d.sn) ?? st.device.serial;
    st.device.firmware = str(d.firmware_ver_string) ?? st.device.firmware;
    st.device.firmwareInt = num(d.firmware_ver_int) ?? st.device.firmwareInt;
    st.device.focalLengthMm = num(d.focal_len) ?? st.device.focalLengthMm;
    st.device.fNumber = num(d.fnumber) ?? st.device.fNumber;
  }
  const c = obj(r.camera);
  if (c) {
    st.device.chipSize = pair(c.chip_size) ?? st.device.chipSize;
    st.device.pixelSizeUm = num(c.pixel_size_um) ?? st.device.pixelSizeUm;
  }
  st.fov = fovFromOptics(st.device.chipSize, st.device.pixelSizeUm, st.device.focalLengthMm) ?? st.fov;
  const m = obj(r.mount);
  if (m) {
    st.mount.tracking = bool(m.tracking) ?? st.mount.tracking;
    st.mount.eqMode = bool(m.equ_mode) ?? st.mount.eqMode;
    st.mount.parked = bool(m.close) ?? st.mount.parked;
  }
  const f = obj(r.focuser);
  if (f) {
    st.focus.position = num(f.step) ?? st.focus.position;
    st.focus.maxStep = num(f.max_step) ?? st.focus.maxStep;
  }
  const f2 = obj(r.second_focuser);
  if (f2) {
    st.wideFocus.position = num(f2.step) ?? st.wideFocus.position;
    st.wideFocus.maxStep = num(f2.max_step) ?? st.wideFocus.maxStep;
  }
  const p = obj(r.pi_status);
  if (p) applyPiStatus(st, p);
  const vol = obj(r.storage)?.storage_volume;
  const v0 = Array.isArray(vol) ? obj(vol[0]) : undefined;
  if (v0) {
    st.storage.freeMB = num(v0.freeMB) ?? num(v0.free_mb) ?? st.storage.freeMB;
    st.storage.totalMB = num(v0.totalMB) ?? num(v0.total_mb) ?? st.storage.totalMB;
  }
}

function applyPiStatus(st: SeestarState, p: Obj): void {
  st.power.batteryPct = num(p.battery_capacity) ?? st.power.batteryPct;
  st.power.charging = bool(p.charge_online) ?? st.power.charging;
  st.power.chargerStatus = str(p.charger_status) ?? st.power.chargerStatus;
  st.power.tempC = num(p.temp) ?? st.power.tempC;
  st.power.overTemp = bool(p.is_overtemp) ?? st.power.overTemp;
}

export function applyAppState(st: SeestarState, r: Obj): void {
  const v = obj(r.View);
  if (!v || !Object.keys(v).length) st.view = {};
  else {
    applyView(st.view, v);
    const stack = obj(v.Stack);
    if (stack) {
      st.stack.state = str(stack.state) ?? st.stack.state;
      st.stack.stacked = num(stack.stacked_frame) ?? st.stack.stacked;
      st.stack.dropped = num(stack.dropped_frame) ?? st.stack.dropped;
    }
  }
  const w = obj(r.SecondView);
  if (!w || !Object.keys(w).length) st.secondView = {};
  else applyView(st.secondView, w);
  const sel = str(v?.selected_cam) ?? str(r.selected_cam);
  if (sel && CAMERA_OF[sel]) st.camera = CAMERA_OF[sel]!;
}

export function applyView(view: ViewState, v: Obj): void {
  view.state = str(v.state) ?? view.state;
  view.mode = str(v.mode) ?? view.mode;
  view.targetType = str(v.mode) ? str(v.target_type) : view.targetType;
  view.stage = str(v.stage) ?? view.stage;
  view.target = str(v.target_name) ?? view.target;
  view.targetRaDec = pair(v.target_ra_dec) ?? view.targetRaDec;
  view.lpFilter = bool(v.lp_filter) ?? view.lpFilter;
  view.gain = num(v.gain) ?? view.gain;
  if (view.state && TERMINAL_STATES.has(view.state)) view.stage = undefined;
}

/** Which view an event belongs to: the wide's when its route names SecondView, else the tele's. */
export function viewOfEvent(e: Obj): 'view' | 'secondView' {
  const route = e.route;
  if (Array.isArray(route) && route.some((r) => typeof r === 'string' && r.includes('SecondView'))) return 'secondView';
  if (typeof route === 'string' && route.includes('SecondView')) return 'secondView';
  return 'view';
}

export const isOuter = (e: Obj): boolean => !('page' in e) && ('route' in e || 'lapse_ms' in e);

export function applyEvent(st: SeestarState, e: Obj): void {
  const name = str(e.Event) ?? str(e.event);
  if (!name) return;
  const at = num(e.at) ?? Date.now();
  st.lastEventAt = at;
  const state = str(e.state);
  if (!QUIET_EVENTS.has(name)) {
    st.recent.push({ at, event: name, state, summary: summarize(name, e) });
    if (st.recent.length > RECENT_MAX) st.recent.splice(0, st.recent.length - RECENT_MAX);
  }
  const outer = isOuter(e);
  if (state) {
    const key = TERMINAL_STATES.has(state) && !outer && st.ops[name] && !TERMINAL_STATES.has(st.ops[name]!.state) && st.ops[name]!.outer ? `${name}.step` : name;
    st.ops[key] = { state, at, outer, error: str(e.error), code: num(e.code), detail: e };
  }
  if (STAGE_EVENTS.has(name) && state) {
    const view = st[viewOfEvent(e)];
    if (state === 'working') view.stage = name;
    else if (TERMINAL_STATES.has(state) && view.stage === name && outer) view.stage = undefined;
  }
  switch (name) {
    case 'PiStatus':
      applyPiStatus(st, e);
      break;
    case 'View':
      applyView(st.view, e);
      if (str(e.selected_cam) && CAMERA_OF[e.selected_cam]) st.camera = CAMERA_OF[e.selected_cam]!;
      break;
    case 'SecondView':
      applyView(st.secondView, e);
      break;
    case 'SelectCamera': {
      const cam = str(e.selected_cam) ?? str(e.cam) ?? str(e.name);
      if (cam && CAMERA_OF[cam]) st.camera = CAMERA_OF[cam]!;
      break;
    }
    case 'Stack':
      // a frame completing is progress of a working stack, not a state of its own
      st.stack.state = state === 'frame_complete' ? 'working' : (state ?? st.stack.state);
      st.stack.stacked = num(e.stacked_frame) ?? st.stack.stacked;
      st.stack.dropped = num(e.dropped_frame) ?? st.stack.dropped;
      st.stack.total = num(e.total_frame) ?? st.stack.total;
      st.stack.lastError = str(e.error) ?? (state === 'working' || state === 'frame_complete' ? undefined : st.stack.lastError);
      st.stack.jpg = str(e.jpg_name) ?? st.stack.jpg;
      st.stack.at = at;
      if (state === 'cancel' || state === 'fail' || state === 'complete') st.stack.state = state;
      break;
    case 'FocuserMove': {
      // the wide's focuser reports with route SecondView (the wide view's start moves it, 2026-11-04)
      const r = e.route;
      const wide = (Array.isArray(r) && r.some((x) => typeof x === 'string' && x.includes('SecondView'))) || (st.camera === 'wide' && !(Array.isArray(r) && r.length));
      const f = wide ? st.wideFocus : st.focus;
      f.position = num(e.position) ?? num(e.step) ?? f.position;
      break;
    }
    case 'ScopeTrack':
      st.mount.tracking = bool(e.tracking) ?? (state === 'on' ? true : state === 'off' ? false : st.mount.tracking);
      break;
    case 'ScopeHome':
    case 'ScopeMoveToHorizon':
      st.mount.parked = bool(e.close) ?? st.mount.parked;
      st.mount.eqMode = bool(e.equ_mode) ?? st.mount.eqMode;
      if (state === 'working') st.mount.moving = name === 'ScopeHome' ? 'parking' : 'opening the arm';
      else if (state && TERMINAL_STATES.has(state)) st.mount.moving = undefined;
      break;
    case 'ScopeGoto': {
      const rd = pair(e.cur_ra_dec);
      if (rd) [st.mount.raHours, st.mount.decDeg] = rd;
      if (state === 'working') {
        st.mount.parked = false;
        st.mount.moving = 'goto';
      } else if (state && TERMINAL_STATES.has(state)) st.mount.moving = undefined;
      st.mount.at = at;
      break;
    }
    case 'MountMode':
      st.mount.eqMode = bool(e.equ_mode) ?? st.mount.eqMode;
      break;
    case 'Alert':
      st.alert = { error: str(e.error) ?? str(e.msg) ?? state, code: num(e.code), at };
      break;
    case 'DiskSpace':
      st.storage.freeMB = num(e.freeMB) ?? num(e.free_mb) ?? st.storage.freeMB;
      break;
    default:
      break;
  }
}

function summarize(name: string, e: Obj): string {
  const parts: string[] = [];
  if (str(e.state)) parts.push(e.state);
  if (num(e.stacked_frame) !== undefined) parts.push(`${e.stacked_frame} stacked`);
  if (num(e.dropped_frame)) parts.push(`${e.dropped_frame} dropped`);
  if (str(e.error)) parts.push(`error: ${e.error}`);
  if (num(e.lapse_ms) !== undefined) parts.push(`${(e.lapse_ms / 1000).toFixed(1)} s`);
  if (name === 'FocuserMove' && num(e.position) !== undefined) parts.push(`→ ${e.position}`);
  return parts.join(', ');
}

/**
 * Polar alignment in flight. The firmware's 3PPA steps (calc1…calc3) need not end with a terminal
 * 3PPA event: on fw 9.75 (2026-11-05) the run ended with EqModePA "complete" after a 3PPA "calc3",
 * which then read as running for ever and refused everything after it. So a 3PPA step counts only
 * while no EqModePA has ended after it, and not past POLAR_STALE_MS without a word.
 */
const POLAR_STALE_MS = 10 * 60_000;
export function polarAligning(st: SeestarState, now = Date.now()): boolean {
  const pa = st.ops['EqModePA'];
  if (pa && !TERMINAL_STATES.has(pa.state)) return true;
  const step = st.ops['3PPA'];
  if (!step || TERMINAL_STATES.has(step.state)) return false;
  if (pa && TERMINAL_STATES.has(pa.state) && (pa.at ?? 0) >= (step.at ?? 0)) return false;
  return now - (step.at ?? now) < POLAR_STALE_MS;
}

/** What the scope is busy with, from the operations in flight. */
export function busyWith(st: SeestarState): string | null {
  const running = (op: string) => {
    const o = st.ops[op];
    return !!o && !TERMINAL_STATES.has(o.state);
  };
  if (running('AutoGoto')) return 'goto';
  if (running('ScopeHome')) return 'parking';
  if (running('ScopeMoveToHorizon')) return 'opening the arm';
  if (running('AutoFocus')) return 'autofocus';
  if (polarAligning(st)) return 'polar alignment';
  if (running('DarkLibrary')) return 'dark library';
  if (running('PlateSolve')) return 'plate solving';
  if (st.stack.state && !TERMINAL_STATES.has(st.stack.state) && st.stack.state !== 'idle') return 'stacking';
  return null;
}

export const isStacking = (st: SeestarState): boolean => !!st.stack.state && !TERMINAL_STATES.has(st.stack.state) && st.stack.state !== 'idle';

/** The view of a camera. */
export const viewOf = (st: SeestarState, cam: Camera): ViewState => (cam === 'tele' ? st.view : st.secondView);
