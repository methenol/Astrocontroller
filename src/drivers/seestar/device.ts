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

  /** Live view without a target (ContinuousExposure). */
  startView(lpFilter = false): Promise<RpcResponse> {
    return this.call('iscope_start_view', { mode: 'star', lp_filter: lpFilter });
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

  async polarAlign(): Promise<OperationResult> {
    return this.follow('polar alignment', ['3PPA'], () => this.call('start_polar_align', { restart: true, dec_pos_index: 3 }), POLAR_TIMEOUT_MS);
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

  setSetting(settings: Record<string, unknown>): Promise<RpcResponse> {
    return this.call('set_setting', settings);
  }

  async settings(): Promise<unknown> {
    return (await this.call('get_setting')).result;
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
