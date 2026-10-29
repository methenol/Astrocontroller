/**
 * A ZWO Seestar as the rest of the application sees it: the seestar driver's TelescopeDevice.
 *
 *   rpc.ts           the JSON-RPC control link (port 4700): handshake, heartbeat, events
 *   image-stream.ts  the stacked/preview image sockets (4800 tele, 4804 wide)
 *   tunnel.ts        the ZWO Telescope Network transport (seestar-portfwd on loopback)
 *   state.ts         the published state and the event reducer
 *
 * The transport only decides the address: local talks to the scope's own IP, zwo to the tunnel's
 * forwarded ports on 127.0.0.1. Everything above it is the same native protocol.
 *
 * Long operations (GoTo, autofocus, park, polar alignment, plate solve) are started with their
 * command and followed to the operation's own terminal event; one runs at a time.
 *
 * Events: 'state' (SeestarState, throttled), 'event' (SeestarEvent), 'released'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, observerLocation, requireObserverLocation, type ObserverLocation } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { SafeEmitter } from '../../util/events.js';
import { writeFileAtomic } from '../../util/fs.js';
import type { FloatImage } from '../../media/images.js';
import { correctionText, polarSummary, seestarCorrection } from '../../astro/polar.js';
import { altAz, bodyAlt, bodyRaDec, raDecFromAltAz, separationDeg } from '../../astro/sky.js';
import type { TelescopeDevice } from '../types.js';
import { readKey } from './auth.js';
import { frameImage, SeestarImageStream, type Frame, type GrabKind } from './image-stream.js';
import { SeestarRpc, type RequestOptions, type RpcLinkOptions, type RpcResponse, type SeestarEvent } from './rpc.js';
import { applyAppState, applyDeviceState, applyEvent, busyWith, initialState, isOuter, TERMINAL_STATES, type SeestarState } from './state.js';
import { ZwoTunnel } from './tunnel.js';

const log = logger('seestar');

const STATE_POLL_MS = 30_000;
const STATE_THROTTLE_MS = 500;
const GOTO_TIMEOUT_MS = 6 * 60_000;
const AUTOFOCUS_TIMEOUT_MS = 6 * 60_000;
const PARK_TIMEOUT_MS = 3 * 60_000;
const SOLVE_TIMEOUT_MS = 2 * 60_000;
const POLAR_TIMEOUT_MS = 10 * 60_000;
const FOCUS_MOVE_TIMEOUT_MS = 60_000;
/** a live view the scope did not keep is not started again sooner than this */
const LIVE_VIEW_RETRY_MS = 20_000;
/** the Sun above this (degrees) is daytime: the view runs in scenery mode, not star mode */
const SCENERY_SUN_ALT_DEG = -6;
/** a plain slew comes no closer to the Sun than this (the GoTo route's limit) */
const SUN_SLEW_MIN_DEG = 15;
/** the joystick command's own limit */
export const NUDGE_MAX_S = 10;
export const NUDGE_MAX_SPEED = 1500;

export type Camera = 'tele' | 'wide';

export interface OperationResult {
  state: string;
  ms: number;
  error?: string;
  code?: number;
  event: SeestarEvent;
}

export interface PolarAlignResult extends OperationResult {
  /** EqModePA x (horizontal) and y (vertical), degrees */
  deviation: { xDeg: number; yDeg: number };
  /** "pitch up 1.0°, rotate 3.0° clockwise" */
  correction: string;
  summary: string;
}

export interface GotoRequest {
  raHours: number;
  decDeg: number;
  name: string;
  lpFilter?: boolean;
  /** start stacking once the GoTo arrives (unless the scope's stack_after_goto already did) */
  stack?: boolean;
}

export interface SeestarOptions {
  host?: string;
  connection?: 'local' | 'zwo';
  /** tests: socket factory for the control and image links, and no tunnel */
  connect?: RpcLinkOptions['connect'];
  link?: Partial<Pick<RpcLinkOptions, 'heartbeatMs' | 'silentAfterMs' | 'backoffMinMs'>>;
  tunnel?: ZwoTunnel | null;
  dataDir?: string;
}

/** An operation ended badly: the scope's error and code, as it sent them. */
export class SeestarOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly result: OperationResult,
  ) {
    super(`${operation} ${result.state}${result.error ? `: ${result.error}` : ''}${result.code !== undefined ? ` (code ${result.code})` : ''}`);
    this.name = 'SeestarOperationError';
  }
}

export class Seestar extends SafeEmitter implements TelescopeDevice {
  readonly driver = 'seestar' as const;
  readonly rpc: SeestarRpc;
  readonly tunnel: ZwoTunnel | null;
  readonly streams: Record<Camera, SeestarImageStream>;
  /** Overrides from the agent/UI for this run (falls back to .env). */
  locationOverride: ObserverLocation | null = null;

  private readonly st: SeestarState;
  private readonly releasedFile: string;
  private host: string;
  private operation: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private started = false;
  private liveViewAt = 0;

  constructor(o: SeestarOptions = {}) {
    super();
    const s = config.seestar;
    const connection = o.connection ?? s.connection;
    this.host = o.host ?? s.host;
    this.st = initialState(connection);
    this.releasedFile = path.join(o.dataDir ?? config.paths.data, 'released.json');
    this.rpc = new SeestarRpc({ host: this.host, port: s.rpcPort, loadKey: () => readKey(s.keyPath), connect: o.connect, ...o.link });
    const connectImage = o.connect ? (h: string, p: number) => o.connect!(h, p) : undefined;
    this.streams = { tele: new SeestarImageStream(this.host, s.imagePort, 'tele', connectImage), wide: new SeestarImageStream(this.host, s.wideImagePort, 'wide', connectImage) };
    this.tunnel =
      o.tunnel !== undefined
        ? o.tunnel
        : connection === 'zwo'
          ? new ZwoTunnel({
              host: this.host,
              port: s.rpcPort,
              command: s.tunnel.command,
              cwd: s.tunnel.cwd,
              readyTimeoutS: s.tunnel.readyTimeoutS,
              env: Object.fromEntries(
                Object.entries({ SEESTAR_USER: s.account.user, SEESTAR_PASSWORD: s.account.password, SEESTAR_SN: s.account.serial }).filter(([, v]) => v),
              ),
            })
          : null;

    this.rpc.on('event', (e: SeestarEvent) => this.onEvent(e));
    this.rpc.on('connected', () => {
      this.syncLink();
      void this.onConnected();
    });
    this.rpc.on('disconnected', () => this.syncLink());
    this.rpc.on('health', () => this.syncLink());
    this.rpc.on('authFailed', (msg: string) => {
      this.st.alert = { error: msg, at: Date.now() };
      this.changed();
    });
    this.tunnel?.on('status', (t) => {
      this.st.tunnel = t;
      this.changed();
    });
    this.st.tunnel = this.tunnel?.status() ?? null;
  }

  // ---- lifecycle -----------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    this.st.released = fs.existsSync(this.releasedFile);
    if (this.st.released) log.warn('the Seestar is released (Disconnect): not connecting until Connect is pressed');
    else this.openTransport();
    this.pollTimer = setInterval(() => {
      if (this.rpc.usable && !this.operation) void this.refreshState().catch(() => {});
      this.st.link = this.rpc.health();
    }, STATE_POLL_MS);
    this.pollTimer.unref?.();
    this.syncLink();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.pollTimer = this.emitTimer = null;
    this.closeTransport();
  }

  /** Disconnect: close every link, and the ZWO session too, so the official app can have the scope. */
  release(): void {
    try {
      writeFileAtomic(this.releasedFile, JSON.stringify({ since: Date.now() }));
    } catch (e) {
      log.warn(`could not record the release in ${this.releasedFile} (a restart reconnects): ${errMsg(e)}`);
    }
    this.st.released = true;
    this.closeTransport();
    this.syncLink();
    log.info('Seestar released by the user: links closed until Connect');
    this.emit('released');
  }

  connectLink(): void {
    try {
      fs.rmSync(this.releasedFile, { force: true });
    } catch (e) {
      log.warn(`could not clear the release in ${this.releasedFile}: ${errMsg(e)}`);
    }
    this.st.released = false;
    log.info('connecting to the Seestar (Connect pressed)');
    this.openTransport();
    this.syncLink();
  }

  setHost(host: string): void {
    log.info(`Seestar address set to ${host}`);
    this.host = host;
    this.st.device = {};
    this.st.deviceState = undefined;
    this.rpc.retarget(host);
    for (const s of Object.values(this.streams)) s.retarget(host);
    this.changed();
  }

  private openTransport(): void {
    this.tunnel?.start();
    this.rpc.start();
  }

  private closeTransport(): void {
    this.rpc.stop();
    for (const s of Object.values(this.streams)) s.close();
    this.tunnel?.stop();
  }

  private syncLink(): void {
    this.st.connected = this.rpc.usable;
    this.st.link = this.rpc.health();
    this.changed();
  }

  private async onConnected(): Promise<void> {
    if (config.seestar.connection === 'zwo') await this.lowRtspQuality().catch((e) => log.warn(`could not lower the live video quality: ${errMsg(e)}`));
    try {
      await this.refreshState();
      if (this.isBusy()) {
        log.info(`connected while the Seestar is ${this.isBusy()}: time and location not pushed`);
        return;
      }
      if (config.seestar.autoSyncTimeLocation) await this.syncTimeLocation().catch((e) => log.warn(`time/location sync failed: ${errMsg(e)}`));
    } catch (e) {
      log.warn(`post-connect refresh failed: ${errMsg(e)}`);
    }
  }

  /**
   * Over ZWO Telescope Network the live video is a preview: HighQuality RTSP (1080×1920) through the
   * tunnel's one session starves its control link within a minute, "Smooth" (360×640) does not.
   * Stills and stacks are unaffected. wide_cam picks the camera a preview setting is for, as the
   * Seestar app does (setPreviewForBothCameras): the wide one first, then the tele, leaving wide_cam
   * false as it was.
   */
  private async lowRtspQuality(): Promise<void> {
    type Preview = { preview?: { rtsp_quality?: string } };
    const s = (await this.settings()) as (Preview & { second_camera?: Preview }) | undefined;
    if (s?.preview?.rtsp_quality === 'Smooth' && s?.second_camera?.preview?.rtsp_quality === 'Smooth') return;
    await this.call('set_setting', { wide_cam: true, preview: { rtsp_quality: 'Smooth' } });
    await this.call('set_setting', { wide_cam: false, preview: { rtsp_quality: 'Smooth' } });
    log.info('live video quality set to Smooth (360×640) on both cameras for ZWO Telescope Network');
  }

  // ---- state ---------------------------------------------------------------

  get state(): SeestarState {
    return this.st;
  }

  /** Throttled 'state' broadcast. */
  changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('state', this.st);
    }, STATE_THROTTLE_MS);
    this.emitTimer.unref?.();
  }

  private onEvent(e: SeestarEvent): void {
    applyEvent(this.st, e);
    if (e.Event === 'Alert') log.warn(`Seestar alert: ${String(e.error ?? '')} (code ${String(e.code ?? '?')})`);
    this.emit('event', e);
    this.changed();
  }

  location(): ObserverLocation | null {
    return this.locationOverride ?? observerLocation();
  }

  requireLocation(): ObserverLocation {
    return this.locationOverride ?? requireObserverLocation();
  }

  isBusy(): string | null {
    return this.operation ?? busyWith(this.st);
  }

  /** Read the device and app state and the pointing. */
  async refreshState(): Promise<SeestarState> {
    const dev = await this.call('get_device_state');
    if (dev.result && typeof dev.result === 'object') applyDeviceState(this.st, dev.result as Record<string, unknown>);
    const app = await this.call('iscope_get_app_state', undefined, { allowError: true });
    if (app.code === 0 && app.result && typeof app.result === 'object') applyAppState(this.st, app.result as Record<string, unknown>);
    await this.readPointing().catch(() => {});
    this.changed();
    return this.st;
  }

  async readPointing(): Promise<SeestarState['mount']> {
    const equ = await this.call('scope_get_equ_coord', undefined, { allowError: true });
    const e = pairOf(equ.result, 'ra', 'dec');
    if (e) [this.st.mount.raHours, this.st.mount.decDeg] = e;
    const hor = await this.call('scope_get_horiz_coord', undefined, { allowError: true });
    const h = pairOf(hor.result, 'alt', 'az');
    if (h) [this.st.mount.altDeg, this.st.mount.azDeg] = h;
    this.st.mount.at = Date.now();
    this.changed();
    return this.st.mount;
  }

  // ---- commands ------------------------------------------------------------

  /** One command; a non-zero code throws (SeestarRpcError) unless allowError. */
  call(method: string, params?: unknown, opts?: RequestOptions): Promise<RpcResponse> {
    return this.rpc.request(method, params, opts);
  }

  /** Escape hatch: any method, the reply as the scope sent it. */
  raw(method: string, params?: unknown, timeoutMs = 15_000): Promise<RpcResponse> {
    return this.rpc.request(method, params, { timeoutMs, allowError: true });
  }

  /**
   * Start an operation and follow it to its own terminal event. The listener is attached before the
   * command is sent, so an operation that ends at once is not missed.
   */
  private async follow(label: string, events: string[], start: () => Promise<unknown>, timeoutMs: number, accept: (e: SeestarEvent) => boolean = isOuter): Promise<OperationResult> {
    if (this.operation) throw new Error(`cannot start ${label}: ${this.operation} is running`);
    if (!this.rpc.usable) throw new Error(`cannot start ${label}: the Seestar is not connected`);
    this.operation = label;
    this.changed();
    const started = Date.now();
    let onEvent: ((e: SeestarEvent) => void) | null = null;
    let onDrop: (() => void) | null = null;
    try {
      const ended = new Promise<SeestarEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: the Seestar reported no end within ${Math.round(timeoutMs / 60_000)} min`)), timeoutMs);
        onEvent = (e) => {
          if (events.includes(e.Event) && TERMINAL_STATES.has(String(e.state)) && accept(e)) {
            clearTimeout(timer);
            resolve(e);
          }
        };
        onDrop = () => {
          clearTimeout(timer);
          reject(new Error(`${label}: the connection to the Seestar dropped (the scope may still be running it: check seestar_status after reconnecting)`));
        };
        this.rpc.on('event', onEvent);
        this.rpc.once('disconnected', onDrop);
      });
      await start();
      const e = await ended;
      const r: OperationResult = { state: String(e.state), ms: Date.now() - started, error: typeof e.error === 'string' ? e.error : undefined, code: typeof e.code === 'number' ? e.code : undefined, event: e };
      log.info(`${label}: ${r.state} after ${(r.ms / 1000).toFixed(1)} s${r.error ? ` (${r.error})` : ''}`);
      return r;
    } finally {
      if (onEvent) this.rpc.off('event', onEvent);
      if (onDrop) this.rpc.off('disconnected', onDrop);
      this.operation = null;
      this.changed();
      // the events do not carry everything an operation changed (the arm leaving park, the view stopping)
      if (this.rpc.usable) void this.refreshState().catch(() => {});
    }
  }

  private static ok(label: string, r: OperationResult): OperationResult {
    if (r.state !== 'complete') throw new SeestarOperationError(label, r);
    return r;
  }

  /** Push the host's clock and the observer location (the scope plans and solves with them). */
  async syncTimeLocation(loc: ObserverLocation | null = this.location()): Promise<string[]> {
    const done: string[] = [];
    const tz = config.observer.timezone;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    await this.call('pi_set_time', [{ year: +parts.year, mon: +parts.month, day: +parts.day, hour: +parts.hour, min: +parts.minute, sec: +parts.second, time_zone: tz }]);
    done.push(`time ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${tz}`);
    if (loc) {
      await this.call('set_user_location', { lat: loc.lat, lon: loc.lon, force: true });
      done.push(`location ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`);
    }
    return done;
  }

  /** GoTo a sky position: slew, plate-solve and centre (iscope_start_view with a target), then optionally stack. */
  async gotoTarget(g: GotoRequest): Promise<{ goto: OperationResult; stacking: string }> {
    const r = Seestar.ok(
      `GoTo ${g.name}`,
      await this.follow(
        `GoTo ${g.name}`,
        ['AutoGoto'],
        () => this.call('iscope_start_view', { mode: 'star', target_ra_dec: [g.raHours, g.decDeg], target_name: g.name, lp_filter: !!g.lpFilter }),
        GOTO_TIMEOUT_MS,
      ),
    );
    if (!g.stack) return { goto: r, stacking: 'not requested' };
    // stack_after_goto (on by default) has the scope start the stack by itself
    await sleep(3000);
    await this.refreshState().catch(() => {});
    if (this.st.stack.state && !TERMINAL_STATES.has(this.st.stack.state)) return { goto: r, stacking: 'started by the scope (stack_after_goto)' };
    await this.startStack();
    return { goto: r, stacking: 'started' };
  }

  /**
   * Slew to a sky position without plate solving or centring (scope_goto), followed to the scope's
   * ScopeGoto end. Refused within SUN_SLEW_MIN_DEG of the Sun and below the horizon.
   */
  async slewTo(raHours: number, decDeg: number): Promise<OperationResult> {
    const site = this.requireLocation();
    const where = altAz(site, raHours, decDeg);
    if (where.altitude < 0) throw new Error(`refusing to slew below the horizon (altitude ${where.altitude.toFixed(1)}°)`);
    const sun = bodyRaDec(site, 'Sun');
    const sep = separationDeg(raHours, decDeg, sun.raHours, sun.decDeg);
    if (bodyAlt(site, 'Sun') > -1 && sep < SUN_SLEW_MIN_DEG) throw new Error(`refusing to slew ${sep.toFixed(0)}° from the Sun (the limit is ${SUN_SLEW_MIN_DEG}°)`);
    if (this.st.mount.parked) await this.openArm();
    return Seestar.ok('slew', await this.follow('slew', ['ScopeGoto'], () => this.call('scope_goto', [raHours, decDeg]), GOTO_TIMEOUT_MS, () => true));
  }

  /** Slew to an azimuth and altitude (true, degrees) now. */
  slewAltAz(azDeg: number, altDeg: number): Promise<OperationResult> {
    const p = raDecFromAltAz(this.requireLocation(), azDeg, altDeg);
    return this.slewTo(p.raHours, p.decDeg);
  }

  /** Live view without a target: star mode at night, scenery while the Sun is up. */
  startView(lpFilter = false, mode: 'star' | 'scenery' = this.viewMode()): Promise<RpcResponse> {
    return this.call('iscope_start_view', mode === 'star' ? { mode, lp_filter: lpFilter } : { mode });
  }

  private viewMode(): 'star' | 'scenery' {
    const site = this.location();
    return site && bodyAlt(site, 'Sun') > SCENERY_SUN_ALT_DEG ? 'scenery' : 'star';
  }

  private viewing(): boolean {
    const v = this.st.view;
    return !!v.state && !TERMINAL_STATES.has(v.state) && v.state !== 'idle' && v.mode !== 'none';
  }

  /**
   * The RTSP streams carry video only while the scope runs a view. A viewer of the live video gets
   * one started (the Dwarf's streams are always on), unless the arm is parked or the scope is busy.
   * Returns why there is no video when it does not start one, or null.
   */
  async ensureLiveView(): Promise<string | null> {
    if (!this.rpc.usable || this.st.released) return 'the telescope is not connected';
    if (this.st.mount.parked) return 'the arm is parked: open it (Home) and live video starts';
    if (this.viewing() || this.operation) return null;
    if (Date.now() - this.liveViewAt < LIVE_VIEW_RETRY_MS) return null;
    this.liveViewAt = Date.now();
    // the RTSP streams are served in a scenery view only (firmware 9.75: a star view refuses them)
    log.info('starting a scenery view for the live video');
    await this.startView(false, 'scenery');
    await this.refreshState().catch(() => {});
    return null;
  }

  /**
   * A frame was asked for from the RTSP video: a star view that is not stacking and runs no
   * operation becomes a scenery view, the only mode the scope serves RTSP in.
   */
  async ensureVideoView(): Promise<void> {
    await this.ensureLiveView();
    const stacking = !!this.st.stack.state && !TERMINAL_STATES.has(this.st.stack.state) && this.st.stack.state !== 'idle';
    if (this.operation || stacking || this.st.view.mode !== 'star' || !this.viewing()) return;
    log.info('switching the star view to scenery: the scope serves RTSP video only there');
    await this.setViewMode('scenery');
  }

  startStack(restart = false): Promise<RpcResponse> {
    return this.call('iscope_start_stack', { restart });
  }

  stopStack(): Promise<RpcResponse> {
    return this.call('iscope_stop_view', { stage: 'Stack' });
  }

  /** Stop whatever the view is doing: GoTo, live view, stacking. */
  stopView(): Promise<RpcResponse> {
    return this.call('iscope_stop_view');
  }

  async autofocus(): Promise<OperationResult> {
    return Seestar.ok('autofocus', await this.follow('autofocus', ['AutoFocus'], () => this.call('start_auto_focuse'), AUTOFOCUS_TIMEOUT_MS));
  }

  stopAutofocus(): Promise<RpcResponse> {
    return this.call('stop_auto_focuse');
  }

  async focuserPosition(): Promise<number | null> {
    const r = await this.call('get_focuser_position');
    const p = typeof r.result === 'number' ? r.result : typeof (r.result as { step?: unknown })?.step === 'number' ? (r.result as { step: number }).step : null;
    if (p !== null) this.st.focus.position = p;
    this.changed();
    return p;
  }

  /** Move the focuser to a step and return where it ended. */
  async focusTo(step: number): Promise<number | null> {
    const max = this.st.focus.maxStep;
    if (!Number.isInteger(step) || step < 0 || (max !== undefined && step > max)) throw new Error(`focuser step ${step} is outside 0–${max ?? '?'}`);
    const r = await this.call('move_focuser', { step, ret_step: true }, { timeoutMs: FOCUS_MOVE_TIMEOUT_MS });
    const at = typeof (r.result as { step?: unknown })?.step === 'number' ? (r.result as { step: number }).step : null;
    if (at !== null) this.st.focus.position = at;
    this.changed();
    return at ?? (await this.focuserPosition());
  }

  async focusBy(delta: number): Promise<number | null> {
    const now = this.st.focus.position ?? (await this.focuserPosition());
    if (now === null || now === undefined) throw new Error('the focuser position is unknown');
    return this.focusTo(now + Math.round(delta));
  }

  /** Park (close the arm), keeping the mount mode it is in. */
  async park(): Promise<OperationResult> {
    return Seestar.ok('park', await this.follow('park', ['ScopeHome'], () => this.call('scope_park', { equ_mode: this.st.mount.eqMode ?? false }), PARK_TIMEOUT_MS, () => true));
  }

  /** Raise the arm to the horizon position (out of park). */
  async openArm(): Promise<OperationResult> {
    return Seestar.ok('move to horizon', await this.follow('move to horizon', ['ScopeMoveToHorizon'], () => this.call('scope_move_to_horizon'), PARK_TIMEOUT_MS, () => true));
  }

  /** Joystick move: angle 0 right, 90 up, 180 left, 270 down; speed in 15″ steps per second (240 ≈ 1°/s). */
  nudge(angleDeg: number, speed: number, durS: number): Promise<RpcResponse> {
    if (!(speed >= 0 && speed <= NUDGE_MAX_SPEED)) throw new Error(`speed must be 0–${NUDGE_MAX_SPEED}`);
    if (!(durS > 0 && durS <= NUDGE_MAX_S)) throw new Error(`duration must be 0–${NUDGE_MAX_S} s`);
    return this.call('scope_speed_move', { speed: Math.round(speed), angle: Math.round(((angleDeg % 360) + 360) % 360), dur_sec: Math.round(durS) });
  }

  stopMotion(): Promise<RpcResponse> {
    return this.call('scope_speed_move', { speed: 0, angle: 0, dur_sec: 1 });
  }

  /** Plate-solve the current view; the solved position and field. */
  async plateSolve(): Promise<OperationResult> {
    return Seestar.ok('plate solve', await this.follow('plate solve', ['PlateSolve'], () => this.call('start_solve'), SOLVE_TIMEOUT_MS, () => true));
  }

  /**
   * EQ-mode polar alignment, as the Seestar app's EQ screen runs it: start_polar_align, then the
   * deviation arrives as x/y (degrees) on EqModePA frames. The correction is worded in astro/polar.ts;
   * progress and the outcome are published as state.polarAlign for the web page.
   */
  async polarAlign(): Promise<PolarAlignResult> {
    const startedAt = Date.now();
    const seen: { dev?: { x: number; y: number } } = {};
    const onEvent = (e: SeestarEvent) => {
      if (e.Event === 'EqModePA' && Number.isFinite(e.x) && Number.isFinite(e.y)) seen.dev = { x: e.x as number, y: e.y as number };
    };
    this.rpc.on('event', onEvent);
    this.st.polarAlign = { running: true, startedAt, message: 'plate-solving near the pole…' };
    this.changed();
    try {
      const r = Seestar.ok('polar alignment', await this.follow('polar alignment', ['EqModePA', '3PPA'], () => this.call('start_polar_align', { restart: true, dec_pos_index: 3 }), POLAR_TIMEOUT_MS));
      const d = seen.dev;
      if (!d) throw new Error('polar alignment completed without reporting a deviation (no EqModePA x/y)');
      const fix = seestarCorrection(d.x, d.y);
      const summary = polarSummary(fix);
      this.st.polarAlign = { running: false, startedAt, finishedAt: Date.now(), ok: true, xDeg: d.x, yDeg: d.y, message: summary };
      return { ...r, deviation: { xDeg: d.x, yDeg: d.y }, correction: correctionText(fix), summary };
    } catch (e) {
      this.st.polarAlign = { running: false, startedAt, finishedAt: Date.now(), ok: false, message: `polar alignment failed: ${errMsg(e)}` };
      throw e;
    } finally {
      this.rpc.off('event', onEvent);
      this.changed();
    }
  }

  stopPolarAlign(): Promise<RpcResponse> {
    return this.call('stop_polar_align');
  }

  /** Stack sub length (ms) and/or live-view exposure (ms). */
  setExposure(o: { stackMs?: number; continuousMs?: number }): Promise<RpcResponse> {
    const exp: Record<string, number> = {};
    if (o.stackMs !== undefined) exp.stack_l = Math.round(o.stackMs);
    if (o.continuousMs !== undefined) exp.continuous = Math.round(o.continuousMs);
    return this.call('set_setting', { exp_ms: exp });
  }

  setGain(gain: number): Promise<RpcResponse> {
    return this.call('set_control_value', ['gain', Math.round(gain)]);
  }

  setDither(o: { enable: boolean; pix?: number; interval?: number }): Promise<RpcResponse> {
    return this.call('set_setting', { stack_dither: o });
  }

  /**
   * set_setting, except heater_enable: get_setting reports it but set_setting refuses it (code 109
   * on firmware 9.75), so the dew heater goes through pi_output_set2.
   */
  async setSetting(settings: Record<string, unknown>): Promise<RpcResponse> {
    const { heater_enable, ...rest } = settings;
    let r: RpcResponse | undefined;
    if (heater_enable !== undefined) r = await this.setHeater(Boolean(heater_enable));
    if (Object.keys(rest).length || !r) r = await this.call('set_setting', rest);
    return r;
  }

  /** The dew heater, at powerPct (the Seestar app's default 90) when on. */
  setHeater(on: boolean, powerPct = 90): Promise<RpcResponse> {
    return this.call('pi_output_set2', { heater: { state: on, value: Math.max(0, Math.min(100, Math.round(powerPct))) } });
  }

  async settings(): Promise<unknown> {
    return (await this.call('get_setting')).result;
  }

  /**
   * The view mode: scenery (daytime), star (deep sky), moon, planet. The Sun is refused: a remote
   * scope cannot tell whether its solar filter is fitted. "moon" and "planet" are sent by name,
   * never as a bare solar_sys, which the scope takes as the Sun.
   */
  async setViewMode(mode: 'scenery' | 'star' | 'moon' | 'planet'): Promise<RpcResponse> {
    if (this.operation) throw new Error(`cannot change the view mode: ${this.operation} is running`);
    if (this.viewing()) await this.stopView();
    const r = await this.call('iscope_start_view', mode === 'star' ? { mode, lp_filter: false } : { mode });
    this.liveViewAt = Date.now();
    await this.refreshState().catch(() => {});
    return r;
  }

  /** Record the tele camera's video to the scope's storage (MyWorks/Scenery_video, …). */
  async record(on: boolean): Promise<RpcResponse> {
    if (on && this.st.mount.parked) throw new Error('the arm is parked: open it (Home) to record');
    if (on && !this.viewing()) await this.startView();
    return this.call(on ? 'start_record_avi' : 'stop_record_avi', on ? { raw: false } : undefined);
  }

  /** The tilt sensor: angle from level (on an EQ wedge, about 90° minus the latitude it is set for). */
  async level(): Promise<{ tiltDeg: number; x: number; y: number; z: number }> {
    const r = await this.call('get_device_state', { keys: ['balance_sensor'] });
    const d = (r.result as { balance_sensor?: { data?: Record<string, number> } })?.balance_sensor?.data;
    if (!d || typeof d.angle !== 'number') throw new Error('the Seestar reported no tilt reading');
    return { tiltDeg: d.angle, x: d.x, y: d.y, z: d.z };
  }

  /** The scope's indicator light, 0 (off: kind to a shared observatory) to 100. */
  setLightBrightness(pct: number): Promise<RpcResponse> {
    return this.call('set_setting', { light_brightness: Math.max(0, Math.min(100, Math.round(pct))) });
  }

  power(action: 'shutdown' | 'reboot'): Promise<RpcResponse> {
    return this.call(action === 'shutdown' ? 'pi_shutdown' : 'pi_reboot');
  }

  // ---- images --------------------------------------------------------------

  /** The current stacked image (or one live sub) from the image socket. */
  async grabImage(camera: Camera, kind: GrabKind, timeoutMs?: number): Promise<{ image: FloatImage; frame: Frame }> {
    const frame = await this.streams[camera].grab(kind, timeoutMs);
    return { image: await frameImage(frame, camera), frame };
  }
}

function pairOf(v: unknown, a: string, b: string): [number, number] | null {
  if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number') return [v[0], v[1]];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o[a] === 'number' && typeof o[b] === 'number') return [o[a] as number, o[b] as number];
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
