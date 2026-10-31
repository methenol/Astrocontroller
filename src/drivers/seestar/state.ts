/**
 * The Seestar's published state, and the pure reducer that folds its events into it.
 *
 * An operation (AutoGoto, AutoFocus, Stack, ScopeHome, 3PPA…) reports itself several times: inner
 * per-step frames (they carry `page`, or only an error) and the operation's own frame, which carries
 * `lapse_ms` and/or `route`. Only an outer frame in a terminal state ends the operation.
 */
import type { SeestarEvent } from './rpc.js';
import type { LinkHealth } from './rpc.js';
import type { TunnelStatus } from './tunnel.js';

export const TERMINAL_STATES = new Set(['complete', 'fail', 'cancel']);
const RECENT_EVENTS = 60;
/** too frequent and too dull to keep in the recent list */
const QUIET_EVENTS = new Set(['PiStatus', 'Exposure', 'FocuserMove', 'Annotate', 'BalanceSensor', 'GSensorMove']);

export interface OperationState {
  state: string;
  at: number;
  error?: string;
  code?: number;
  /** the operation's own frame (not an inner step) */
  outer: boolean;
  detail?: Record<string, unknown>;
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
  /** the tele field of view in degrees, from the scope's optics (h × v as the image is read) */
  fov: { h: number; v: number } | null;
  mount: { raHours?: number; decDeg?: number; altDeg?: number; azDeg?: number; tracking?: boolean; eqMode?: boolean; parked?: boolean; moving?: string; at?: number };
  view: { state?: string; mode?: string; targetType?: string; stage?: string; target?: string; targetRaDec?: [number, number]; lpFilter?: boolean; gain?: number };
  stack: { state?: string; stacked?: number; dropped?: number; total?: number; lastError?: string; jpg?: string; at?: number };
  focus: { position?: number; maxStep?: number };
  power: { batteryPct?: number; charging?: boolean; chargerStatus?: string; tempC?: number; overTemp?: boolean };
  storage: { freeMB?: number; totalMB?: number };
  /** the last state of every operation event the scope has sent */
  ops: Record<string, OperationState>;
  /** the last alert the scope raised */
  alert?: { error?: string; code?: number; at: number };
  lastEventAt: number | null;
  recent: Array<{ at: number; name: string; state?: string; error?: string; code?: number }>;
  /** what the full device-state read returned last, as the scope sent it */
  deviceState?: Record<string, unknown>;
  /** the polar alignment in progress or last run: its deviation (EqModePA x/y, degrees) and the correction */
  polarAlign?: { running: boolean; startedAt: number; finishedAt?: number; ok?: boolean; xDeg?: number; yDeg?: number; message?: string };
  /** the obstruction survey in progress or last run (survey.ts) */
  horizonSurvey?: { running: boolean; phase: string; startedAt: number; finishedAt?: number; index?: number; total?: number; message?: string; error?: string; maskId?: string };
  /** the star focus sweep in progress or last run */
  focusTune?: { running: boolean; startedAt: number; finishedAt?: number; message: string };
}

export function initialState(connection: 'local' | 'zwo'): SeestarState {
  return { driver: 'seestar', connection, connected: false, released: false, link: null, tunnel: null, device: {}, fov: null, mount: {}, view: {}, stack: {}, focus: {}, power: {}, storage: {}, ops: {}, lastEventAt: null, recent: [] };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : undefined);

/** The operation's own frame, not one of its steps. */
export const isOuter = (e: Record<string, unknown>): boolean => !('page' in e) && ('route' in e || 'lapse_ms' in e);

const RAD = 180 / Math.PI;

/** Field of view in degrees from the optics: chip [width, height] in pixels, pixel pitch, focal length. */
export function fovFromOptics(chip: [number, number] | undefined, pixelUm: number | undefined, focalMm: number | undefined): { h: number; v: number } | null {
  if (!chip || !pixelUm || !focalMm) return null;
  // [width, height] as the frames are read: an S50 Pro reports [2160, 3840] and its FITS have NAXIS1 = 2160
  const [width, height] = chip;
  const deg = (px: number) => 2 * Math.atan((px * pixelUm * 1e-3) / (2 * focalMm)) * RAD;
  return { h: +deg(width).toFixed(3), v: +deg(height).toFixed(3) };
}

/** Fold a get_device_state result into the state. */
export function applyDeviceState(st: SeestarState, r: Record<string, unknown>): void {
  st.deviceState = r;
  const d = obj(r.device);
  if (Object.keys(d).length) {
    st.device = {
      ...st.device,
      name: str(d.name) ?? st.device.name,
      model: str(d.product_model) ?? str(d.user_product_model) ?? st.device.model,
      serial: str(d.sn) ?? st.device.serial,
      firmware: str(d.firmware_ver_string) ?? st.device.firmware,
      firmwareInt: num(d.firmware_ver_int) ?? st.device.firmwareInt,
      focalLengthMm: num(d.focal_len) ?? st.device.focalLengthMm,
      fNumber: num(d.fnumber) ?? st.device.fNumber,
    };
  }
  const cam = obj(r.camera);
  if (Object.keys(cam).length) {
    st.device.chipSize = pair(cam.chip_size) ?? st.device.chipSize;
    st.device.pixelSizeUm = num(cam.pixel_size_um) ?? st.device.pixelSizeUm;
  }
  st.fov = fovFromOptics(st.device.chipSize, st.device.pixelSizeUm, st.device.focalLengthMm) ?? st.fov;
  const m = obj(r.mount);
  if (Object.keys(m).length) {
    st.mount.tracking = bool(m.tracking) ?? st.mount.tracking;
    st.mount.eqMode = bool(m.equ_mode) ?? st.mount.eqMode;
    st.mount.parked = bool(m.close) ?? st.mount.parked;
    st.mount.moving = str(m.move_type) ?? st.mount.moving;
  }
  const f = obj(r.focuser);
  if (Object.keys(f).length) {
    st.focus.position = num(f.step) ?? st.focus.position;
    st.focus.maxStep = num(f.max_step) ?? st.focus.maxStep;
  }
  applyPower(st, obj(r.pi_status));
  const vol = obj(Array.isArray(obj(r.storage).storage_volume) ? obj(r.storage).storage_volume[0] : undefined);
  st.storage.freeMB = num(vol.freeMB) ?? num(vol.free_mb) ?? st.storage.freeMB;
  st.storage.totalMB = num(vol.totalMB) ?? num(vol.total_mb) ?? st.storage.totalMB;
}

function applyPower(st: SeestarState, p: Record<string, any>): void {
  st.power.batteryPct = num(p.battery_capacity) ?? st.power.batteryPct;
  st.power.charging = bool(p.charge_online) ?? st.power.charging;
  st.power.chargerStatus = str(p.charger_status) ?? st.power.chargerStatus;
  st.power.tempC = num(p.temp) ?? st.power.tempC;
  st.power.overTemp = bool(p.is_overtemp) ?? st.power.overTemp;
}

/** Fold iscope_get_app_state's View block (what the scope is doing) into the state. */
export function applyAppState(st: SeestarState, r: Record<string, unknown>): void {
  const v = obj(r.View);
  if (!Object.keys(v).length) return;
  applyView(st, v);
  const stack = obj(v.Stack);
  if (Object.keys(stack).length) {
    st.stack.state = str(stack.state) ?? st.stack.state;
    st.stack.stacked = num(stack.stacked_frame) ?? st.stack.stacked;
    st.stack.dropped = num(stack.dropped_frame) ?? st.stack.dropped;
  }
}

function applyView(st: SeestarState, v: Record<string, any>): void {
  st.view.state = str(v.state) ?? st.view.state;
  st.view.mode = str(v.mode) ?? st.view.mode;
  // solar_sys views say which body: sun, moon or planet
  st.view.targetType = str(v.mode) ? str(v.target_type) : st.view.targetType;
  st.view.stage = str(v.stage) ?? st.view.stage;
  st.view.target = str(v.target_name) ?? st.view.target;
  st.view.targetRaDec = pair(v.target_ra_dec) ?? st.view.targetRaDec;
  st.view.lpFilter = bool(v.lp_filter) ?? st.view.lpFilter;
  st.view.gain = num(v.gain) ?? st.view.gain;
}

/** Fold one event into the state. Pure apart from `st`. */
export function applyEvent(st: SeestarState, e: SeestarEvent): void {
  st.lastEventAt = e.at;
  const name = e.Event;
  const state = str(e.state);
  if (state !== undefined) {
    const { Event: _n, state: _s, at: _a, error, code, ...detail } = e;
    const op: OperationState = { state, at: e.at, error: str(error), code: num(code), outer: isOuter(e), detail };
    // a step that ended is not the operation ending: keep it beside the operation (its error is the useful part)
    if (TERMINAL_STATES.has(state) && !op.outer && st.ops[name] && !TERMINAL_STATES.has(st.ops[name].state)) st.ops[`${name}.step`] = op;
    else st.ops[name] = op;
  }
  if (!QUIET_EVENTS.has(name)) {
    st.recent.push({ at: e.at, name, state, error: str(e.error), code: num(e.code) });
    if (st.recent.length > RECENT_EVENTS) st.recent.splice(0, st.recent.length - RECENT_EVENTS);
  }
  switch (name) {
    case 'PiStatus':
      applyPower(st, e);
      break;
    case 'View':
      applyView(st, e);
      break;
    case 'Stack':
      if (state !== 'frame_complete') st.stack.state = state ?? st.stack.state;
      st.stack.stacked = num(e.stacked_frame) ?? st.stack.stacked;
      st.stack.dropped = num(e.dropped_frame) ?? st.stack.dropped;
      st.stack.total = num(e.total_frame) ?? st.stack.total;
      if (str(e.error)) st.stack.lastError = str(e.error);
      st.stack.jpg = str(e.jpg_name) ?? st.stack.jpg;
      st.stack.at = e.at;
      break;
    case 'FocuserMove':
      st.focus.position = num(e.position) ?? num(e.step) ?? st.focus.position;
      break;
    case 'ScopeTrack':
      st.mount.tracking = bool(e.tracking) ?? st.mount.tracking;
      break;
    case 'ScopeHome':
    case 'ScopeMoveToHorizon':
      // the arm is parked when the firmware says so (mount.close): the app takes `close` from the
      // event when it carries one and keeps what it had otherwise; the event's name alone does
      // not tell (a ScopeHome without `close` is not "closed", 2026-10-30 the arm was open)
      st.mount.parked = bool(e.close) ?? st.mount.parked;
      if (bool(e.equ_mode) !== undefined) st.mount.eqMode = bool(e.equ_mode);
      break;
    case 'ScopeGoto':
      st.mount.parked = false;
      if (pair(e.cur_ra_dec)) [st.mount.raHours, st.mount.decDeg] = pair(e.cur_ra_dec)!;
      break;
    case 'MountMode':
      st.mount.eqMode = bool(e.equ_mode) ?? st.mount.eqMode;
      break;
    case 'Alert':
      st.alert = { error: str(e.error), code: num(e.code), at: e.at };
      break;
    case 'DiskSpace':
      st.storage.freeMB = num(e.freeMB) ?? num(e.free_mb) ?? st.storage.freeMB;
      break;
  }
}

/** What the scope is busy with, from the operations still running. */
export function busyWith(st: SeestarState): string | null {
  const running = (n: string) => {
    const o = st.ops[n];
    return o && !TERMINAL_STATES.has(o.state) && o.state !== 'off' && o.state !== 'idle';
  };
  if (running('AutoGoto')) return 'goto';
  if (running('ScopeHome')) return 'parking';
  if (running('ScopeMoveToHorizon')) return 'opening the arm';
  if (running('AutoFocus')) return 'autofocus';
  if (running('3PPA')) return 'polar alignment';
  if (running('DarkLibrary')) return 'dark library';
  if (st.stack.state && !TERMINAL_STATES.has(st.stack.state) && st.stack.state !== 'idle') return 'stacking';
  return null;
}
