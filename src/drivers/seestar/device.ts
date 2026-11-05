/**
 * The Seestar as one object: the control link, the two picture sockets, the ZWO tunnel when the
 * scope is remote, the state folded from its replies and events, and every operation the tools and
 * the web UI ask for.
 *
 * Camera selection is explicit and sticky. `selected` is the camera the user (the main live view)
 * or a tool asked for; the scope's star session is kept exposing with that camera, and nothing
 * else changes it. An operation that works from the tele's frames (GoTo, plate solve, autofocus,
 * stacking, polar alignment) borrows the tele for its duration and the selection is put back when
 * it ends; a tool that needs the other camera's frame borrows it the same way (withCamera).
 *
 * The picture sockets stay open from connect to disconnect; begin_streaming follows the exposing
 * camera. Previews are at bin 2 (a 1080×1920 JPEG per exposure, 1 fps on the tele over the tunnel);
 * a tool that asks for full resolution (withFullRes) sets bin 1 for its frames and bin 2 comes back
 * afterwards. An operation is reserved (busy, stoppable) from the moment it is asked for, through
 * its camera switch: stopWork() cancels one that has not started and stops a running one by its
 * label, again once the scope shows it running (a stop that lands before that is ignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import type net from 'node:net';
import { config, observerLocation, requireObserverLocation, type ObserverLocation } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { SafeEmitter } from '../../util/events.js';
import { writeFileAtomic } from '../../util/fs.js';
import { altAz, bodyAlt, bodyRaDec, raDecFromAltAz, separationDeg } from '../../astro/sky.js';
import { correctionText, polarSummary, seestarCorrection } from '../../astro/polar.js';
import type { FloatImage } from '../../media/images.js';
import type { TelescopeDevice } from '../types.js';
import { readKey, type RpcResponse } from './auth.js';
import { SeestarLink, VIEW_TIMEOUT_MS, type LinkOptions, type RequestOptions, type SeestarEvent } from './link.js';
import { SeestarImageLink, type GrabKind } from './image-link.js';
import { frameImage, IMG_TYPE, type Camera, type Frame } from './frames.js';
import { applyAppState, applyDeviceState, applyEvent, busyWith, polarAligning, initialState, isOuter, isStacking, pair, TERMINAL_STATES, VIEW_OF, type SeestarState, type ViewState } from './model.js';
import { ZwoTunnel } from './tunnel.js';

export type { Camera } from './frames.js';

const log = logger('seestar');

const STATE_THROTTLE_MS = 500;
const POLL_MS = 5_000;
const FULL_POLL_MS = 10_000;
const PREVIEW_BIN = 2;
const WORK_BIN = 1;
const PREVIEW_BIN_AFTER_OP_MS = 3_000;
/** how long a stop watches for the operation it stopped to turn up running (and stops it again) */
const STOP_RESEND_WINDOW_MS = 4000;
const LIVE_EXPOSURE_OPTIONS = [500, 1000, 2000];
const NIGHT_CONTINUOUS_MS = 1000;
const NIGHT_GAIN = 100;
const RAW_STILL_TIMEOUT_MS = 90_000;
const GRAB_TIMEOUT_MS = 45_000;
const STOP_VIEW_ON_RELEASE_MS = 8_000;
const GOTO_TIMEOUT_MS = 6 * 60_000;
const AUTOFOCUS_TIMEOUT_MS = 6 * 60_000;
const PARK_TIMEOUT_MS = 3 * 60_000;
const SOLVE_TIMEOUT_MS = 2 * 60_000;
const POLAR_TIMEOUT_MS = 10 * 60_000;
const FOCUS_MOVE_TIMEOUT_MS = 60_000;
const SUN_SLEW_MIN_DEG = 15;
const MOVE_RESEND_MS = 200;
const MOVE_DUR_S = 3;
const MOVE_LEVEL = 1;
/** renewals outstanding at most (a slow link answers late; the firmware keeps moving for dur_sec anyway) */
const MOVE_MAX_INFLIGHT = 2;
/** a nudge with wait false answers by then even when the scope is slow to acknowledge */
const MOVE_ANSWER_MS = 400;
export const NUDGE_MAX_S = 10;
export const NUDGE_MAX_PERCENT = 100;

export interface OperationResult {
  state: string;
  ms: number;
  error?: string;
  code?: number;
  event: SeestarEvent;
}

export interface PolarAlignResult extends OperationResult {
  deviation: { xDeg: number; yDeg: number };
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
  /** tests: a socket factory for the control and picture links, and no tunnel */
  connect?: (host: string, port: number) => net.Socket;
  link?: Partial<Pick<LinkOptions, 'heartbeatMs' | 'silentAfterMs' | 'backoffMinMs'>>;
  tunnel?: ZwoTunnel | null;
  dataDir?: string;
  ports?: { rpc?: number; image?: number; wideImage?: number };
}

export class SeestarOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly result: OperationResult,
  ) {
    super(`${operation} ${result.state}${result.error ? `: ${result.error}` : ''}${result.code !== undefined ? ` (code ${result.code})` : ''}`);
    this.name = 'SeestarOperationError';
  }
}

interface Hold {
  angle: number;
  percent: number;
  until: number;
  press?: string;
  inflight: number;
  timer: NodeJS.Timeout | null;
  first: Promise<RpcResponse> | null;
  done: Promise<RpcResponse>;
  finish: (r: RpcResponse) => void;
  fail: (e: Error) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const OTHER: Record<Camera, Camera> = { tele: 'wide', wide: 'tele' };

export class Seestar extends SafeEmitter implements TelescopeDevice {
  readonly driver = 'seestar' as const;
  readonly link: SeestarLink;
  readonly images: Record<Camera, SeestarImageLink>;
  readonly tunnel: ZwoTunnel | null;
  private readonly st: SeestarState;
  private readonly releasedFile: string;
  private readonly rpcPort: number;
  /** the camera the user or a tool wants exposing; the scope is kept on it */
  private wanted: Camera = 'tele';
  /** an operation or a tool is borrowing a camera: the selection is applied when it is done */
  private borrowed: Camera | null = null;
  private borrowDepth = 0;
  /**
   * The target the last GoTo centred on. A camera switch restarts the view without a target, so
   * the scope forgets the name: the stack's group (its MyWorks folder) is named from this instead.
   */
  private stackTarget: string | null = null;
  /** the pointing changed since the last stack started: the next one starts fresh, not on top of it */
  private pointingChanged = false;
  /** the operation in flight (its label), one at a time */
  operation: string | null = null;
  /** an operation reserved through its camera switch (withTele), before follow() takes it */
  private reservedBy: string | null = null;
  /** stopWork() came while the operation was still being prepared: it must not start */
  private pendingCancel = false;
  private fullRes = 0;
  private stateTimer: NodeJS.Timeout | null = null;
  private statePending = false;
  private poll: NodeJS.Timeout | null = null;
  private lastFullPoll = 0;
  private viewQueue: Promise<unknown> = Promise.resolve();
  private rawQueue: Promise<unknown> = Promise.resolve();
  /** the hand movement running (nudge) */
  private hold: Hold | null = null;
  /** web presses already stopped: their late renewals are ignored */
  private readonly stoppedPresses: string[] = [];
  private started = false;
  private readonly onTunnel = () => this.tunnelChanged();

  constructor(o: SeestarOptions = {}) {
    super();
    this.setMaxListeners(100);
    const cfg = config.seestar;
    const connection = o.connection ?? cfg.connection;
    const host = o.host ?? cfg.host;
    this.rpcPort = o.ports?.rpc ?? cfg.rpcPort;
    this.st = initialState(connection);
    this.releasedFile = path.join(o.dataDir ?? config.paths.data, 'released.json');
    this.link = new SeestarLink({ host, port: this.rpcPort, loadKey: () => readKey(cfg.keyPath), connect: o.connect, ...o.link });
    this.images = {
      tele: new SeestarImageLink(host, o.ports?.image ?? cfg.imagePort, 'tele', o.connect),
      wide: new SeestarImageLink(host, o.ports?.wideImage ?? cfg.wideImagePort, 'wide', o.connect),
    };
    this.tunnel = o.tunnel !== undefined ? o.tunnel : connection === 'zwo' ? this.makeTunnel(host) : null;
    this.st.tunnel = this.tunnel?.status() ?? null;
    this.st.link = this.link.health();
    this.link.on('connected', () => void this.onConnected());
    this.link.on('disconnected', (reason: string) => this.onDisconnected(reason));
    this.link.on('event', (e: SeestarEvent) => this.onEvent(e));
    this.link.on('health', (h) => {
      this.st.link = h;
      this.changed();
    });
    this.link.on('authFailed', (msg: string) => log.error(`the scope refused the handshake: ${msg}`));
    for (const cam of ['tele', 'wide'] as Camera[]) {
      this.images[cam].on('status', () => this.changed());
      this.images[cam].expecting = () => this.exposing === cam && this.viewOf(cam).stage === 'ContinuousExposure';
    }
    this.tunnel?.on('status', this.onTunnel);
    try {
      const saved = JSON.parse(fs.readFileSync(this.releasedFile, 'utf8')) as { released?: boolean };
      this.st.released = !!saved.released;
    } catch {
      /* never released */
    }
  }

  private makeTunnel(host: string): ZwoTunnel {
    const t = config.seestar.tunnel;
    const a = config.seestar.account;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ SEESTAR_USER: a.user, SEESTAR_PASSWORD: a.password, SEESTAR_SN: a.serial })) if (v) env[k] = v;
    return new ZwoTunnel({
      host,
      port: this.rpcPort,
      command: t.command,
      cwd: t.cwd || undefined,
      readyTimeoutS: t.readyTimeoutS,
      env,
      supervisor: t.control.enabled && !t.command ? { host: t.control.host, port: t.control.port, token: t.control.token || undefined, leaseS: t.control.leaseS } : null,
    });
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.st.released) {
      log.info('the Seestar was released (Disconnect): press Connect to take it again');
      this.changed();
      return;
    }
    this.open();
  }

  private open(): void {
    if (this.tunnel) {
      this.tunnel.start();
      if (this.tunnel.up) this.link.start();
    } else this.link.start();
    if (!this.poll) {
      this.poll = setInterval(() => void this.tick(), POLL_MS);
      this.poll.unref?.();
    }
  }

  private tunnelChanged(): void {
    const t = this.tunnel!;
    this.st.tunnel = t.status();
    if (this.started && !this.st.released && t.up) this.link.start();
    else if (!t.up && this.link.health().connected === false) this.link.stop();
    this.changed();
  }

  /** Shutdown: close every link; the tunnel's session stays with its supervisor for a restart. */
  async stop(): Promise<void> {
    this.started = false;
    this.closeLinks();
    this.tunnel?.stop(false);
    await this.tunnel?.flush(1200);
  }

  /** Disconnect: hand the scope back until connectLink(). */
  async release(): Promise<void> {
    this.st.released = true;
    writeFileAtomic(this.releasedFile, JSON.stringify({ released: true, at: new Date().toISOString() }));
    if (this.link.usable) {
      try {
        if (this.fullRes) await this.call('set_camera_bin', PREVIEW_BIN).catch(() => undefined);
        if (this.viewRunning() && !isStacking(this.st)) await this.call('iscope_stop_view', undefined, { timeoutMs: STOP_VIEW_ON_RELEASE_MS });
      } catch (e) {
        log.warn(`release: ${errMsg(e)}`);
      }
    }
    this.closeLinks();
    this.tunnel?.stop(true);
    this.changed();
    this.emit('released');
  }

  connectLink(): void {
    this.st.released = false;
    try {
      fs.rmSync(this.releasedFile, { force: true });
    } catch {
      /* fine */
    }
    this.started = true;
    this.open();
    this.changed();
  }

  /** Point every link at another host (the tunnel moved). */
  setHost(host: string): void {
    this.link.retarget(host);
    this.images.tele.retarget(host, config.seestar.imagePort);
    this.images.wide.retarget(host, config.seestar.wideImagePort);
  }

  private closeLinks(): void {
    this.stopMoveLoop();
    this.images.tele.close();
    this.images.wide.close();
    this.link.stop();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.st.connected = false;
  }

  private async onConnected(): Promise<void> {
    this.st.connected = true;
    this.st.link = this.link.health();
    this.changed();
    this.images.tele.open();
    this.images.wide.open();
    try {
      await this.refreshState();
      if (this.st.connection === 'zwo') await this.lowRtspQuality();
      await this.prepareLiveFrames();
      if (this.viewRunning() && this.st.view.mode === 'scenery') {
        log.info('stopping the scenery view the scope was left in');
        await this.call('iscope_stop_view', undefined, { timeoutMs: VIEW_TIMEOUT_MS });
        await this.refreshState();
      }
      if (config.seestar.autoSyncTimeLocation && !this.busy) await this.syncTimeLocation().catch((e) => log.warn(`time/location sync: ${errMsg(e)}`));
      await this.applySelection('connected');
      await this.applyBin('connected');
    } catch (e) {
      log.warn(`after connecting: ${errMsg(e)}`);
    }
    this.syncStreams();
    this.changed();
  }

  private onDisconnected(reason: string): void {
    this.st.connected = false;
    this.st.link = this.link.health();
    this.stopMoveLoop();
    log.warn(`control link lost: ${reason}`);
    this.changed();
  }

  private onEvent(e: SeestarEvent): void {
    applyEvent(this.st, e);
    const name = e.Event ?? e.event;
    if (name === 'View' || name === 'SecondView' || name === 'SelectCamera' || name === 'Stack') this.syncStreams();
    // the exposures (re)started on the exposing camera: a begin_streaming sent before this is not
    // acted on (the wide pushed nothing after a camera switch, 2026-11-04), so ask again now
    if (name === 'ContinuousExposure' && e.state === 'working') {
      const route = Array.isArray(e.route) ? (e.route as unknown[]) : [];
      const cam: Camera | null = route.includes('SecondView') ? 'wide' : route.includes('View') ? 'tele' : null;
      if (cam && cam === this.exposing) this.images[cam].restartStream();
    }
    if (name === 'Stack' && e.state && TERMINAL_STATES.has(String(e.state)) && isOuter(e)) setTimeout(() => void this.applySelection('stack ended'), 1000);
    this.emit('event', e);
    if (name) this.emit(name, e);
    this.changed();
  }

  /** The RTSP streams (moon/planet views) at the quality that fits the tunnel. */
  private async lowRtspQuality(): Promise<void> {
    for (const wide of [true, false]) await this.call('set_setting', { wide_cam: wide, preview: { rtsp_quality: 'Smooth' } }, { allowError: true }).catch(() => undefined);
  }

  /** Live frames as JPEG at bin 2 on both cameras, with a live-view exposure that keeps them coming. */
  private async prepareLiveFrames(): Promise<void> {
    for (const cam of ['wide', 'tele'] as Camera[]) await this.setTransferMode(cam, 'Jpg').catch((e) => log.warn(`${cam}: transfer mode: ${errMsg(e)}`));
    const s = (await this.call('get_setting', undefined, { allowError: true }).catch(() => null))?.result as { exp_ms?: { continuous?: number } } | undefined;
    const cont = s?.exp_ms?.continuous;
    if (typeof cont === 'number' && !LIVE_EXPOSURE_OPTIONS.includes(cont)) await this.call('set_setting', { exp_ms: { continuous: 1000 } }).catch((e) => log.warn(`live exposure: ${errMsg(e)}`));
  }

  setTransferMode(camera: Camera, mode: 'Jpg' | 'Raw'): Promise<RpcResponse> {
    return this.call('set_setting', { wide_cam: camera === 'wide', preview: { image_transfer_mode: mode, raw_bin2: mode === 'Jpg' } });
  }

  // ---- state ------------------------------------------------------------------------------------

  get state(): SeestarState {
    return this.st;
  }

  /** Tell the listeners the state changed (coalesced to a few times a second). */
  changed(): void {
    if (this.stateTimer) {
      this.statePending = true;
      return;
    }
    this.emit('state', this.st);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.statePending) {
        this.statePending = false;
        this.changed();
      }
    }, STATE_THROTTLE_MS);
  }

  viewOf(camera: Camera): ViewState {
    return camera === 'tele' ? this.st.view : this.st.secondView;
  }

  /** The camera asked for (sticky: the main live view, or a tool). */
  get selected(): Camera {
    return this.wanted;
  }

  /** The camera the scope exposes with now, as far as it has told. */
  get exposing(): Camera | null {
    if (!this.viewRunning()) return null;
    return this.st.camera ?? this.wanted;
  }

  viewRunning(): boolean {
    const s = this.st.view.state;
    return !!s && !TERMINAL_STATES.has(s) && s !== 'idle';
  }

  /** The camera's picture exposes right now (ContinuousExposure or a stack). */
  liveStage(camera: Camera): boolean {
    if (this.exposing !== camera) return false;
    const stage = this.viewOf(camera).stage;
    return stage === 'ContinuousExposure' || stage === 'Stack' || (!stage && camera === 'tele' && isStacking(this.st));
  }

  isStacking(): boolean {
    return isStacking(this.st);
  }

  /** Why a camera shows no live picture right now, or null when it should. */
  liveNote(camera: Camera): string | null {
    if (this.st.released) return 'disconnected from the Seestar (press Connect)';
    if (!this.st.connected) return this.tunnel && !this.tunnel.up ? `the ZWO tunnel is ${this.st.tunnel?.phase ?? 'down'}${this.st.tunnel?.detail ? ` (${this.st.tunnel.detail})` : ''}` : 'the Seestar is not connected';
    if (!this.viewRunning()) return 'no live view running';
    const mode = this.st.view.mode;
    if (mode && mode !== 'star') return camera === 'tele' ? null : `the ${mode} view uses the tele camera only`;
    const exposing = this.exposing;
    if (exposing !== camera) {
      const why = this.borrowed ? ` for ${this.operation ?? 'a tool'}` : this.isStacking() ? ' (stacking)' : '';
      return `${exposing ?? 'the other'} camera is selected${why}${this.wanted === camera ? '; switching back when it is free' : ' — make this the main view to select it'}`;
    }
    const stage = this.viewOf(camera).stage;
    if (stage && stage !== 'ContinuousExposure' && stage !== 'Stack') return `${this.operation ?? stage} in progress (the picture is the last frame)`;
    const sock = this.images[camera];
    if (!sock.connected) return sock.note ?? `the ${camera} picture socket is reconnecting`;
    return null;
  }

  /** a location set for this session by a tool, over .env OBSERVER_* */
  locationOverride: ObserverLocation | null = null;

  location(): ObserverLocation | null {
    return this.locationOverride ?? observerLocation();
  }

  requireLocation(): ObserverLocation {
    return this.locationOverride ?? requireObserverLocation();
  }

  isBusy(): string | null {
    return this.operation ?? busyWith(this.st) ?? (this.hold ? 'hand movement' : null);
  }

  get busy(): boolean {
    return this.isBusy() !== null;
  }

  async refreshState(): Promise<SeestarState> {
    const dev = await this.call('get_device_state');
    if (dev.result && typeof dev.result === 'object') applyDeviceState(this.st, dev.result as Record<string, unknown>);
    const app = await this.call('iscope_get_app_state', undefined, { allowError: true });
    if (app.result && typeof app.result === 'object') applyAppState(this.st, app.result as Record<string, unknown>);
    const track = await this.call('scope_get_track_state', undefined, { allowError: true });
    if (typeof track.result === 'boolean') this.st.mount.tracking = track.result;
    await this.readPointing().catch(() => undefined);
    this.lastFullPoll = Date.now();
    this.changed();
    return this.st;
  }

  async readPointing(): Promise<SeestarState['mount']> {
    const equ = await this.call('scope_get_equ_coord', undefined, { allowError: true });
    const rd = pairOf(equ.result, 'ra', 'dec');
    if (rd) [this.st.mount.raHours, this.st.mount.decDeg] = rd;
    const hor = await this.call('scope_get_horiz_coord', undefined, { allowError: true });
    const aa = pairOf(hor.result, 'alt', 'az');
    if (aa) [this.st.mount.altDeg, this.st.mount.azDeg] = aa;
    this.st.mount.at = Date.now();
    this.changed();
    return this.st.mount;
  }

  private async tick(): Promise<void> {
    if (!this.link.usable) return;
    try {
      // a hand move skips the full poll: the scope answers one command at a time and its ~1 s
      // get_device_state would hold the move's renewals back
      if (this.hold) await this.readPointing();
      else if (Date.now() - this.lastFullPoll >= FULL_POLL_MS) await this.refreshState();
      else if (this.st.mount.moving) await this.readPointing();
    } catch (e) {
      log.debug(`poll: ${errMsg(e)}`);
    }
  }

  call(method: string, params?: unknown, opts?: RequestOptions): Promise<RpcResponse> {
    return this.link.request(method, params, opts);
  }

  /** Any method, for the raw_rpc tool: errors come back as the reply, not as a throw. */
  raw(method: string, params?: unknown, timeoutMs = 15_000): Promise<RpcResponse> {
    return this.link.request(method, params, { timeoutMs, allowError: true });
  }

  // ---- camera selection -------------------------------------------------------------------------

  /** Select a camera: the scope's star session exposes with it from now on (sticky). */
  async selectCamera(camera: Camera, why = 'selected'): Promise<void> {
    if (this.wanted !== camera) log.info(`${camera} camera ${why}`);
    this.wanted = camera;
    this.changed();
    await this.applySelection(why);
  }

  /**
   * Make the scope expose with the wanted camera, unless something else owns the view: an
   * operation, a borrowed camera, or a stack (its frames are the tele's). Called whenever that
   * owner is done.
   */
  private applySelection(why: string): Promise<void> {
    return this.serial(async () => {
      if (!this.link.usable || this.st.released) return;
      const target = this.borrowed ?? this.wanted;
      if (!this.viewRunning()) return;
      if (this.st.view.mode && this.st.view.mode !== 'star') return;
      if (this.exposing === target) {
        this.syncStreams();
        return;
      }
      if (!this.borrowed && (this.operation || this.isStacking())) return;
      log.info(`switching the live view to the ${target} camera (${why})`);
      await this.restartView(target, this.st.view.lpFilter ?? false);
    });
  }

  /** Stop the running star view and start it again with this camera exposing. */
  private async restartView(camera: Camera, lpFilter: boolean): Promise<void> {
    if (this.viewRunning()) await this.call('iscope_stop_view', undefined, { timeoutMs: VIEW_TIMEOUT_MS }).catch((e) => log.warn(`the view did not stop before the camera change: ${errMsg(e)}`));
    await this.call('iscope_start_view', { mode: 'star', selected_cam: VIEW_OF[camera], lp_filter: lpFilter }, { timeoutMs: VIEW_TIMEOUT_MS });
    this.st.camera = camera;
    this.st.view.state = 'working';
    this.st.view.mode = 'star';
    this.syncStreams();
    await this.refreshState().catch(() => undefined);
    this.st.camera = camera;
    await this.applyBin(`${camera} selected`).catch((e) => log.warn(`camera bin: ${errMsg(e)}`));
    this.syncStreams();
    this.changed();
  }

  /** begin_streaming on the exposing camera's socket, stop_streaming on the other. */
  private syncStreams(): void {
    const live = this.exposing;
    for (const cam of ['tele', 'wide'] as Camera[]) {
      if (cam === live) this.images[cam].startStream();
      else this.images[cam].stopStream();
    }
  }

  /**
   * Run with this camera borrowed (and, unless `select` is false, exposing), then give the
   * selection back. `select: false` is for an operation that starts the view itself (a GoTo).
   */
  async withCamera<T>(camera: Camera, what: string, run: () => Promise<T>, select = true): Promise<T> {
    if (this.borrowed && this.borrowed !== camera) throw new Error(`cannot use the ${camera} camera for ${what}: the ${this.borrowed} camera is in use`);
    if (select && !this.viewRunning()) await this.ensureLiveView();
    this.borrowed = camera;
    this.borrowDepth++;
    try {
      if (select && this.exposing !== camera) {
        if (this.isStacking()) throw new Error(`cannot use the ${camera} camera for ${what} while stacking`);
        await this.applySelection(what);
        if (this.exposing !== camera) throw new Error(`the ${camera} camera could not be selected for ${what}`);
      }
      return await run();
    } finally {
      if (--this.borrowDepth === 0) {
        this.borrowed = null;
        void this.applySelection(`after ${what}`).catch((e) => log.warn(`after ${what}: ${errMsg(e)}`));
      }
    }
  }

  /** A star view without a target, with the selected camera, unless one is running. */
  async ensureLiveView(): Promise<string | null> {
    return this.serial(async () => {
      if (!this.link.usable) throw new Error('the Seestar is not connected');
      if (this.viewRunning()) return null;
      if (this.operation) throw new Error(`no live view: ${this.operation} is running`);
      await this.restartView(this.borrowed ?? this.wanted, false);
      return 'started the live view';
    });
  }

  startView(lpFilter = false, camera: Camera = this.wanted): Promise<void> {
    this.wanted = camera;
    return this.serial(() => this.restartView(camera, lpFilter));
  }

  stopView(): Promise<RpcResponse> {
    return this.serial(async () => {
      const r = await this.call('iscope_stop_view', undefined, { timeoutMs: VIEW_TIMEOUT_MS });
      this.st.view = {};
      this.st.secondView = {};
      this.st.stack = {};
      this.syncStreams();
      this.changed();
      return r;
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const p = this.viewQueue.then(run, run);
    this.viewQueue = p.catch(() => undefined);
    return p;
  }

  // ---- bin --------------------------------------------------------------------------------------

  /** bin 2 for previews, bin 1 while a tool wants full resolution. */
  async applyBin(reason: string): Promise<boolean> {
    if (!this.link.usable || !this.viewRunning()) return false;
    const want = this.fullRes > 0 ? WORK_BIN : PREVIEW_BIN;
    const cur = await this.call('get_camera_bin', undefined, { allowError: true }).catch(() => null);
    if (cur && typeof cur.result === 'number' && cur.result === want) return false;
    await this.call('set_camera_bin', want);
    log.info(`camera bin ${want} (${reason})`);
    return true;
  }

  /** Full-resolution frames from this camera for the duration of `run`. */
  async withFullRes<T>(camera: Camera, what: string, run: () => Promise<T>): Promise<T> {
    this.fullRes++;
    try {
      if (this.fullRes === 1) await this.applyBin(`${what} (${camera})`);
      return await run();
    } finally {
      if (--this.fullRes === 0) setTimeout(() => void this.applyBin(`after ${what}`).catch(() => undefined), 100);
    }
  }

  // ---- operations -------------------------------------------------------------------------------

  private async follow(label: string, events: string[], start: () => Promise<unknown>, timeoutMs: number, accept: (e: SeestarEvent) => boolean = isOuter): Promise<OperationResult> {
    const reserved = this.reservedBy === label && this.operation === label;
    if (this.operation && !reserved) throw new Error(`cannot start ${label}: ${this.operation} is running`);
    if (!this.link.usable) throw new Error(`cannot start ${label}: the Seestar is not connected`);
    if (!reserved) this.pendingCancel = false;
    this.reservedBy = null;
    this.operation = label;
    this.changed();
    const started = Date.now();
    let onEvent: ((e: SeestarEvent) => void) | null = null;
    let onDrop: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      const ended = new Promise<SeestarEvent>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: the Seestar reported no end within ${Math.round(timeoutMs / 60_000)} min`)), timeoutMs);
        onEvent = (e) => {
          const name = e.Event ?? e.event;
          if (name && events.includes(name) && TERMINAL_STATES.has(String(e.state)) && accept(e)) resolve(e);
        };
        onDrop = () => {
          reject(new Error(`${label}: the connection to the Seestar dropped (the scope may still be running it: check the status after reconnecting)`));
        };
        this.link.on('event', onEvent);
        this.link.once('disconnected', onDrop);
      });
      // a start that fails leaves `ended` behind: not an unhandled rejection
      ended.catch(() => undefined);
      if (this.pendingCancel) throw new Error(`${label} was stopped before it started`);
      await start();
      const e = await ended;
      const r: OperationResult = { state: String(e.state), ms: Date.now() - started, error: typeof e.error === 'string' ? e.error : undefined, code: typeof e.code === 'number' ? e.code : undefined, event: e };
      log.info(`${label}: ${r.state} after ${(r.ms / 1000).toFixed(1)} s${r.error ? ` (${r.error})` : ''}`);
      return r;
    } finally {
      if (timer) clearTimeout(timer);
      if (onEvent) this.link.off('event', onEvent);
      if (onDrop) this.link.off('disconnected', onDrop);
      this.operation = null;
      this.pendingCancel = false;
      this.changed();
      if (this.link.usable) {
        void this.refreshState()
          .then(() => this.applySelection(`after ${label}`))
          .catch(() => undefined);
        setTimeout(() => void this.applyBin(`after ${label}`).catch(() => undefined), PREVIEW_BIN_AFTER_OP_MS);
      }
    }
  }

  private static ok(label: string, r: OperationResult): OperationResult {
    if (r.state !== 'complete') throw new SeestarOperationError(label, r);
    return r;
  }

  /** Borrow the tele for an operation that works from its frames (the selection comes back after). */
  private async withTele<T>(what: string, run: () => Promise<T>, select = true): Promise<T> {
    if (this.exposing === 'tele' || !this.viewRunning()) return run();
    // the switch to the tele takes seconds: the operation is reserved through it, so the scope
    // reports busy and a stop lands (follow() takes the reservation over)
    if (this.operation) throw new Error(`cannot start ${what}: ${this.operation} is running`);
    this.operation = what;
    this.reservedBy = what;
    this.pendingCancel = false;
    this.changed();
    try {
      return await this.withCamera('tele', what, run, select);
    } finally {
      if (this.reservedBy === what) this.reservedBy = null;
      if (this.operation === what) {
        this.operation = null;
        this.pendingCancel = false;
        this.changed();
      }
    }
  }

  async syncTimeLocation(loc: ObserverLocation | null = this.location()): Promise<string[]> {
    const done: string[] = [];
    const tz = config.observer.timezone;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    await this.call('pi_set_time', [{ year: +parts.year!, mon: +parts.month!, day: +parts.day!, hour: +parts.hour!, min: +parts.minute!, sec: +parts.second!, time_zone: tz }]);
    done.push(`time ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${tz}`);
    if (loc) {
      await this.call('set_user_location', { lat: loc.lat, lon: loc.lon, force: true });
      done.push(`location ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`);
    }
    return done;
  }

  /** GoTo: slew, plate-solve and centre on the tele (iscope_start_view with a target), then optionally stack. */
  async gotoTarget(g: GotoRequest): Promise<{ goto: OperationResult; stacking: string }> {
    const label = `GoTo ${g.name}`;
    const r = await this.withTele(label, async () =>
      Seestar.ok(
        label,
        await this.follow(
          label,
          ['AutoGoto'],
          () =>
            this.serial(async () => {
              if (this.viewRunning() && this.exposing !== 'tele') await this.call('iscope_stop_view', undefined, { timeoutMs: VIEW_TIMEOUT_MS }).catch(() => undefined);
              this.stackTarget = g.name;
              this.pointingChanged = true;
              const res = await this.call('iscope_start_view', { mode: 'star', selected_cam: VIEW_OF.tele, target_ra_dec: [g.raHours, g.decDeg], target_name: g.name, lp_filter: !!g.lpFilter }, { timeoutMs: VIEW_TIMEOUT_MS });
              this.st.camera = 'tele';
              this.st.view.state = 'working';
              this.st.view.mode = 'star';
              this.st.view.target = g.name;
              this.syncStreams();
              return res;
            }),
          GOTO_TIMEOUT_MS,
        ),
      ),
      false,
    );
    if (!g.stack) return { goto: r, stacking: 'not requested' };
    await sleep(3000);
    await this.refreshState().catch(() => undefined);
    if (this.isStacking()) {
      // the scope's own stack after a GoTo is new and carries the GoTo's name
      this.pointingChanged = false;
      return { goto: r, stacking: 'started by the scope (stack_after_goto)' };
    }
    await this.startStack();
    return { goto: r, stacking: 'started' };
  }

  /** Slew without solving (scope_goto); refused below the horizon or near the Sun. */
  async slewTo(raHours: number, decDeg: number): Promise<OperationResult> {
    const site = this.requireLocation();
    const where = altAz(site, raHours, decDeg);
    if (where.altitude < 0) throw new Error(`refusing to slew below the horizon (altitude ${where.altitude.toFixed(1)}°)`);
    const sun = bodyRaDec(site, 'Sun');
    const sep = separationDeg(raHours, decDeg, sun.raHours, sun.decDeg);
    if (bodyAlt(site, 'Sun') > -1 && sep < SUN_SLEW_MIN_DEG) throw new Error(`refusing to slew ${sep.toFixed(0)}° from the Sun (the limit is ${SUN_SLEW_MIN_DEG}°)`);
    if (this.st.mount.parked) await this.openArm();
    this.stackTarget = null;
    this.pointingChanged = true;
    return Seestar.ok('slew', await this.follow('slew', ['ScopeGoto'], () => this.call('scope_goto', [raHours, decDeg]), GOTO_TIMEOUT_MS, () => true));
  }

  slewAltAz(azDeg: number, altDeg: number): Promise<OperationResult> {
    const p = raDecFromAltAz(this.requireLocation(), azDeg, altDeg);
    return this.slewTo(p.raHours, p.decDeg);
  }

  /** Abort a scope_goto slew (the app's "scope_move none"). */
  abortSlew(): Promise<RpcResponse> {
    return this.call('scope_move', ['none'], { allowError: true });
  }

  /** The selected camera's live exposure (exp_ms.continuous, ms); get_setting answers for the selected camera. */
  async liveExposureMs(camera: Camera): Promise<number | null> {
    if (this.exposing !== camera) return null;
    const s = (await this.call('get_setting', undefined, { allowError: true }))?.result as { exp_ms?: { continuous?: unknown } } | undefined;
    const v = s?.exp_ms?.continuous;
    return typeof v === 'number' ? v : null;
  }

  stopGoto(): Promise<RpcResponse> {
    return this.call('iscope_stop_view', { stage: 'AutoGoto' }, { timeoutMs: VIEW_TIMEOUT_MS });
  }

  /**
   * Stack on the tele's view (restart = drop what is stacked so far). The stack is named after the
   * GoTo's target, and starts fresh after the scope moved: a stack continued across targets files
   * every target under one name ("Unknown" once a camera switch dropped it) and registers the new
   * target's subs against the old one's, so they all fail.
   */
  async startStack(restart = false): Promise<RpcResponse> {
    if (!this.viewRunning()) await this.ensureLiveView();
    if (this.exposing !== 'tele') await this.serial(() => this.restartView('tele', this.st.view.lpFilter ?? false));
    const name = this.stackTarget ?? this.st.view.target;
    if (name) {
      const g = await this.call('set_sequence_setting', [{ group_name: name }], { allowError: true }).catch((e: unknown) => ({ code: -1, error: errMsg(e) }) as RpcResponse);
      if (g.code) log.warn(`the stack could not be named ${name}: ${g.error ?? `code ${g.code}`}`);
    }
    const fresh = restart || this.pointingChanged;
    if (fresh && !restart) log.info(`stacking ${name ?? 'the new pointing'} from scratch: the scope moved since the last stack`);
    const r = await this.call('iscope_start_stack', { restart: fresh });
    this.pointingChanged = false;
    this.st.stack.state = 'working';
    this.st.stack.at = Date.now();
    this.changed();
    return r;
  }

  async stopStack(): Promise<RpcResponse> {
    const r = await this.call('iscope_stop_view', { stage: 'Stack' }, { timeoutMs: VIEW_TIMEOUT_MS });
    if (this.st.stack.state && !TERMINAL_STATES.has(this.st.stack.state)) this.st.stack.state = 'cancel';
    this.changed();
    setTimeout(() => void this.applySelection('stack stopped').catch(() => undefined), 1500);
    return r;
  }

  /** Stop whatever runs: hand movement, GoTo, autofocus, polar alignment, a stack, a non-star view. */
  async stopWork(): Promise<{ stopped: string[] }> {
    const stopped: string[] = [];
    if (this.hold) {
      await this.stopMotion();
      stopped.push('hand movement');
    }
    const running = (op: string) => {
      const o = this.st.ops[op];
      return !!o && !TERMINAL_STATES.has(o.state);
    };
    for (const stage of ['AutoGoto', 'Initialise', 'DarkLibrary']) {
      if (running(stage) || this.st.view.stage === stage) {
        await this.call('iscope_stop_view', { stage }, { timeoutMs: VIEW_TIMEOUT_MS });
        stopped.push(stage === 'AutoGoto' ? 'goto' : stage === 'DarkLibrary' ? 'dark library' : 'initialisation');
      }
    }
    if (running('AutoFocus') || this.st.view.stage === 'AutoFocus') {
      await this.call('stop_auto_focuse');
      stopped.push('autofocus');
    }
    if (polarAligning(this.st)) {
      await this.call('stop_polar_align');
      stopped.push('polar alignment');
    }
    if (this.isStacking() || this.st.view.stage === 'Stack') {
      await this.stopStack();
      stopped.push('stacking');
    }
    if (this.viewRunning() && this.st.view.mode && this.st.view.mode !== 'star') {
      await this.stopView();
      stopped.push(`${this.st.view.mode ?? 'the'} view`);
    }
    // an operation the scope's state does not show yet (being prepared, or just started): stop it by
    // its label, and keep it from starting if it has not
    const op = this.operation;
    if (op) {
      this.pendingCancel = true;
      const by: Record<string, [string | null, unknown, string]> = { autofocus: ['stop_auto_focuse', undefined, 'autofocus'], 'polar alignment': ['stop_polar_align', undefined, 'polar alignment'] };
      const [method, params, name]: [string | null, unknown, string] = by[op] ?? (op.startsWith('GoTo ') ? ['iscope_stop_view', { stage: 'AutoGoto' }, 'goto'] : op === 'slew' ? ['scope_move', ['none'], 'slew'] : [null, undefined, op]);
      if (!stopped.includes(name)) {
        if (method) {
          await this.call(method, params, { allowError: true, timeoutMs: VIEW_TIMEOUT_MS }).catch(() => undefined);
          // a stop that lands before the scope has the operation running does nothing (its start was
          // just acknowledged): when it shows up running within a few seconds, stop it again
          const stages = op === 'autofocus' ? ['AutoFocus'] : op === 'polar alignment' ? ['3PPA', 'EqModePA'] : op === 'slew' ? ['ScopeGoto'] : ['AutoGoto'];
          const end = Date.now() + STOP_RESEND_WINDOW_MS;
          const live = () => (op === 'polar alignment' ? polarAligning(this.st) : stages.some(running));
          while (Date.now() < end && this.operation === op && !live()) await sleep(250);
          if (this.operation === op && live()) await this.call(method, params, { allowError: true, timeoutMs: VIEW_TIMEOUT_MS }).catch(() => undefined);
        }
        stopped.push(name);
      }
    }
    return { stopped };
  }

  /** The live exposure and gain the solver and the autofocus need stars with. */
  private async prepareNightExposure(what: string): Promise<void> {
    const s = (await this.call('get_setting', undefined, { allowError: true }).catch(() => null))?.result as { exp_ms?: { continuous?: number } } | undefined;
    const cont = s?.exp_ms?.continuous;
    if (typeof cont === 'number' && cont < NIGHT_CONTINUOUS_MS) {
      await this.call('set_setting', { exp_ms: { continuous: NIGHT_CONTINUOUS_MS } }).catch((e) => log.warn(`${what}: live exposure: ${errMsg(e)}`));
      await this.call('set_control_value', ['gain', NIGHT_GAIN]).catch((e) => log.warn(`${what}: gain: ${errMsg(e)}`));
    }
  }

  async autofocus(): Promise<OperationResult> {
    return this.withTele('autofocus', async () =>
      Seestar.ok(
        'autofocus',
        await this.follow(
          'autofocus',
          ['AutoFocus'],
          async () => {
            await this.prepareNightExposure('autofocus');
            return this.call('start_auto_focuse');
          },
          AUTOFOCUS_TIMEOUT_MS,
        ),
      ),
    );
  }

  stopAutofocus(): Promise<RpcResponse> {
    return this.call('stop_auto_focuse');
  }

  /**
   * The tele's focuser position. move_focuser and get_focuser_position act on the SELECTED camera's
   * focuser (verified 2026-11-04: with the wide selected, move_focuser moved the wide's
   * second_focuser), so a focuser is only read or moved while its camera exposes.
   */
  async focuserPosition(camera: Camera = 'tele'): Promise<number | null> {
    const read = async () => {
      const r = await this.call('get_focuser_position');
      const n = typeof r.result === 'number' ? r.result : typeof (r.result as { step?: unknown })?.step === 'number' ? (r.result as { step: number }).step : null;
      if (n !== null) this.focusOf(camera).position = n;
      return n;
    };
    return this.focuserDirect(camera) ? read() : this.withCamera(camera, `reading the ${camera} focuser`, read);
  }

  /** The focuser commands reach this camera's focuser now: it exposes, or (no view) the tele, which a stopped view selects. */
  private focuserDirect(camera: Camera): boolean {
    return this.exposing === camera || (!this.viewRunning() && camera === 'tele');
  }

  private focusOf(camera: Camera): SeestarState['focus'] {
    return camera === 'wide' ? this.st.wideFocus : this.st.focus;
  }

  /** Move a camera's focuser (the tele's unless said); the camera is borrowed when it is not the one exposing. */
  async focusTo(step: number, camera: Camera = 'tele'): Promise<number | null> {
    const f = this.focusOf(camera);
    const max = f.maxStep ?? (camera === 'wide' ? 1023 : 2600);
    if (!Number.isFinite(step) || step < 0 || step > max) throw new Error(`${camera} focuser position ${step} is outside 0–${max}`);
    const move = async () => {
      if (!this.focuserDirect(camera)) throw new Error(`the ${camera} camera is not selected, so its focuser cannot be moved`);
      const r = await this.call('move_focuser', { step: Math.round(step), ret_step: true }, { timeoutMs: FOCUS_MOVE_TIMEOUT_MS });
      const n = typeof (r.result as { step?: unknown })?.step === 'number' ? (r.result as { step: number }).step : typeof r.result === 'number' ? r.result : null;
      if (n !== null) f.position = n;
      this.changed();
      return n;
    };
    return this.focuserDirect(camera) ? move() : this.withCamera(camera, `moving the ${camera} focuser`, move);
  }

  async focusBy(delta: number, camera: Camera = 'tele'): Promise<number | null> {
    const cur = this.focusOf(camera).position ?? (await this.focuserPosition(camera));
    if (cur === null) throw new Error(`the ${camera} focuser position is unknown`);
    return this.focusTo(cur + delta, camera);
  }

  /**
   * The wide camera's factory focus (its infinity): get_setting's second_camera.factory_focal_pos
   * (330 on the S50 Pro of 2026-11-04; the app's reset_factory_focal_pos answers 210 "not supported"
   * on fw 9.75). With a 6 mm f/5 lens everything past ~2 m is sharp there.
   */
  async wideFactoryFocus(): Promise<number | null> {
    const s = (await this.call('get_setting', undefined, { allowError: true }).catch(() => null))?.result as { second_camera?: { factory_focal_pos?: unknown; focal_pos?: unknown } } | undefined;
    const v = s?.second_camera?.factory_focal_pos ?? s?.second_camera?.focal_pos;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /** Put the wide camera's focuser back at its factory infinity; returns where it is. */
  async resetWideFocus(): Promise<number | null> {
    const pos = await this.wideFactoryFocus();
    if (pos === null) throw new Error('the Seestar did not report the wide camera\'s factory focus (get_setting second_camera.factory_focal_pos)');
    return this.focusTo(pos, 'wide');
  }

  async park(): Promise<OperationResult> {
    return Seestar.ok('park', await this.follow('park', ['ScopeHome'], () => this.call('scope_park', { equ_mode: this.st.mount.eqMode ?? false }), PARK_TIMEOUT_MS, () => true));
  }

  async openArm(): Promise<OperationResult> {
    return Seestar.ok('move to horizon', await this.follow('move to horizon', ['ScopeMoveToHorizon'], () => this.call('scope_move_to_horizon'), PARK_TIMEOUT_MS, () => true));
  }

  /**
   * Hand movement as the app's joystick: a hold that sends scope_speed_move every 200 ms until its
   * deadline, then the stop (angle 0 right, 90 up, 180 left, 270 down; percent 1 ≈ 0.03°/s, 100 ≈
   * 2.5°/s, close to linear, measured 2026-11-04).
   *
   * The firmware answers its commands one at a time, so a slow one (a view restart, the ~1 s
   * get_device_state) holds the move's reply back: the renewals are sent on their own clock, never
   * waiting for replies (at most MOVE_MAX_INFLIGHT outstanding, so a slow link does not pile them
   * up), and a nudge that repeats the running hold's direction and speed only moves its deadline.
   * That is how the web UI holds an arrow: it renews a lease faster than it runs out, and the move
   * neither stops between renewals nor restarts. `press` names a web press: once it is stopped, a
   * late renewal of it is ignored (the stop can overtake it on the wire).
   *
   * `wait: false` answers at once (the first command is on its way); `wait: true` when the hold ends.
   */
  nudge(angleDeg: number, percent: number, durS: number, { wait = true, press }: { wait?: boolean; press?: string } = {}): Promise<RpcResponse> {
    if (!this.link.usable) return Promise.reject(new Error('cannot move: the Seestar is not connected'));
    if (press && this.stoppedPresses.includes(press)) return Promise.resolve({ code: 0, result: 'stopped' } as RpcResponse);
    const dur = Math.min(NUDGE_MAX_S, Math.max(0.05, durS));
    const pct = Math.min(NUDGE_MAX_PERCENT, Math.max(1, Math.round(percent)));
    const angle = ((Math.round(angleDeg) % 360) + 360) % 360;
    const until = Date.now() + dur * 1000;
    const h = this.hold;
    if (h && h.angle === angle && h.percent === pct && (!press || h.press === press || !h.press)) {
      // a renewal: the same move goes on
      h.until = Math.max(h.until, until);
      h.press = press ?? h.press;
      return wait ? h.done : Promise.resolve({ code: 0, result: 'renewed' } as RpcResponse);
    }
    if (h) this.endHold('superseded');
    const move = { angle, percent: pct, level: MOVE_LEVEL, dur_sec: MOVE_DUR_S };
    let finish!: (r: RpcResponse) => void;
    let fail!: (e: Error) => void;
    const done = new Promise<RpcResponse>((res, rej) => {
      finish = res;
      fail = rej;
    });
    void done.catch(() => undefined);
    const hold: Hold = { angle, percent: pct, until, press, inflight: 0, timer: null, done, finish, fail, first: null };
    this.hold = hold;
    const send = () => {
      hold.inflight++;
      const p = this.call('scope_speed_move', move, { timeoutMs: 10_000 }).finally(() => hold.inflight--);
      p.then((r) => {
        if (r.code && this.hold === hold) {
          this.endHold();
          void this.sendStop().catch(() => undefined);
          hold.fail(new Error(`the Seestar refused the move: ${r.error ?? `code ${r.code}`}`));
        }
      }).catch((e) => {
        if (this.hold !== hold) return;
        this.endHold();
        hold.fail(e instanceof Error ? e : new Error(String(e)));
      });
      return p;
    };
    hold.first = send();
    hold.timer = setInterval(() => {
      if (this.hold !== hold) return;
      if (Date.now() >= hold.until) {
        this.endHold();
        void this.sendStop()
          .then((r) => hold.finish(r))
          .catch((e) => hold.fail(e instanceof Error ? e : new Error(String(e))));
        return;
      }
      if (hold.inflight < MOVE_MAX_INFLIGHT) void send().catch(() => undefined);
    }, MOVE_RESEND_MS);
    this.changed();
    if (wait) return done;
    // the first command is on the wire; a refusal of it still comes back as the answer
    return Promise.race([hold.first, sleep(MOVE_ANSWER_MS).then(() => ({ code: 0, result: 'moving' }) as RpcResponse)]);
  }

  /** End the running hold without a stop of its own (the caller sends what comes next). */
  private endHold(outcome?: 'superseded'): void {
    const h = this.hold;
    if (!h) return;
    if (h.timer) clearInterval(h.timer);
    this.hold = null;
    if (outcome) h.finish({ code: 0, result: outcome } as RpcResponse);
    this.changed();
  }

  private stopMoveLoop(): void {
    this.endHold('superseded');
  }

  private sendStop(): Promise<RpcResponse> {
    return this.call('scope_speed_move', { angle: 0, percent: 0, level: 0, dur_sec: MOVE_DUR_S });
  }

  /** Stop hand movement now; `press` retires that web press, so its late renewals do nothing. */
  stopMotion(press?: string): Promise<RpcResponse> {
    if (press) {
      this.stoppedPresses.push(press);
      if (this.stoppedPresses.length > 32) this.stoppedPresses.shift();
    }
    this.endHold('superseded');
    return this.sendStop();
  }


  async plateSolve(): Promise<OperationResult> {
    return this.withTele('plate solve', async () =>
      Seestar.ok(
        'plate solve',
        await this.follow(
          'plate solve',
          ['PlateSolve'],
          async () => {
            await this.prepareNightExposure('plate solve');
            return this.call('start_solve');
          },
          SOLVE_TIMEOUT_MS,
          () => true,
        ),
      ),
    );
  }

  /** EQ-mode polar alignment as the app runs it; the deviation arrives on EqModePA frames. */
  async polarAlign(): Promise<PolarAlignResult> {
    const startedAt = Date.now();
    const seen: { dev?: { x: number; y: number } } = {};
    const onEvent = (e: SeestarEvent) => {
      if (e.Event === 'EqModePA' && Number.isFinite(e.x) && Number.isFinite(e.y)) seen.dev = { x: e.x as number, y: e.y as number };
    };
    this.link.on('event', onEvent);
    this.st.polarAlign = { running: true, startedAt, message: 'plate-solving near the pole…' };
    this.changed();
    try {
      const r = await this.withTele('polar alignment', async () => Seestar.ok('polar alignment', await this.follow('polar alignment', ['EqModePA', '3PPA'], () => this.call('start_polar_align', { restart: true, dec_pos_index: 3 }), POLAR_TIMEOUT_MS)));
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
      this.link.off('event', onEvent);
      this.changed();
    }
  }

  stopPolarAlign(): Promise<RpcResponse> {
    return this.call('stop_polar_align');
  }

  // ---- settings ---------------------------------------------------------------------------------

  setExposure(o: { stackMs?: number; continuousMs?: number }, camera: Camera = 'tele'): Promise<RpcResponse> {
    const exp: Record<string, number> = {};
    if (o.stackMs !== undefined) exp.stack_l = Math.round(o.stackMs);
    if (o.continuousMs !== undefined) exp.continuous = Math.round(o.continuousMs);
    if (!Object.keys(exp).length) throw new Error('nothing to set');
    return this.call('set_setting', { wide_cam: camera === 'wide', exp_ms: exp });
  }

  setGain(gain: number): Promise<RpcResponse> {
    return this.call('set_control_value', ['gain', Math.round(gain)]);
  }

  setDither(o: { enable: boolean; pix?: number; interval?: number }): Promise<RpcResponse> {
    return this.call('set_setting', { stack_dither: o });
  }

  async setSetting(settings: Record<string, unknown>): Promise<RpcResponse> {
    const { heater_enable, ...rest } = settings;
    let r: RpcResponse | null = null;
    if (typeof heater_enable === 'boolean') r = await this.setHeater(heater_enable);
    if (Object.keys(rest).length || !r) r = await this.call('set_setting', rest);
    return r;
  }

  setHeater(on: boolean, powerPct = 90): Promise<RpcResponse> {
    return this.call('pi_output_set2', { heater: { state: on, value: Math.max(0, Math.min(100, Math.round(powerPct))) } });
  }

  async settings(): Promise<unknown> {
    return (await this.call('get_setting')).result;
  }

  /** The view's mode: star (the astro session), moon or planet (RTSP video of the tele). Never scenery. */
  async setViewMode(mode: 'star' | 'moon' | 'planet'): Promise<RpcResponse> {
    return this.serial(async () => {
      if (this.viewRunning()) await this.call('iscope_stop_view', undefined, { timeoutMs: VIEW_TIMEOUT_MS }).catch(() => undefined);
      const r = await this.call('iscope_start_view', mode === 'star' ? { mode, selected_cam: VIEW_OF[this.wanted], lp_filter: false } : { mode }, { timeoutMs: VIEW_TIMEOUT_MS });
      this.st.view.state = 'working';
      this.st.view.mode = mode;
      this.st.camera = 'tele';
      if (mode === 'star') this.st.camera = this.wanted;
      await this.refreshState().catch(() => undefined);
      if (mode === 'star') await this.applyBin('view started').catch(() => undefined);
      this.syncStreams();
      return r;
    });
  }

  async record(on: boolean): Promise<RpcResponse> {
    if (on && !this.viewRunning()) await this.ensureLiveView();
    return this.call(on ? 'start_record_avi' : 'stop_record_avi', on ? { raw: false } : undefined);
  }

  async level(): Promise<{ tiltDeg: number; x: number; y: number; z: number }> {
    const r = await this.call('get_device_state', { keys: ['balance_sensor'] });
    const d = ((r.result as { balance_sensor?: { data?: Record<string, number> } })?.balance_sensor?.data ?? {}) as Record<string, number>;
    return { tiltDeg: d.angle ?? 0, x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? 0 };
  }

  setLightBrightness(pct: number): Promise<RpcResponse> {
    return this.call('set_setting', { light_brightness: Math.max(0, Math.min(100, Math.round(pct))) });
  }

  power(action: 'shutdown' | 'reboot'): Promise<RpcResponse> {
    return this.call(action === 'shutdown' ? 'pi_shutdown' : 'pi_reboot');
  }

  // ---- pictures ---------------------------------------------------------------------------------

  /**
   * One picture from a camera: its next live preview, the firmware's current frame, or the stack.
   * The camera has to be exposing (selected, in ContinuousExposure or a stack).
   */
  async grabImage(camera: Camera, kind: GrabKind, timeoutMs = GRAB_TIMEOUT_MS): Promise<{ image: FloatImage; frame: Frame }> {
    const sock = this.images[camera];
    if (!sock.connected) throw new Error(sock.note ?? `the ${camera} camera's picture socket is not connected`);
    if (kind === 'stacked') {
      if (camera !== 'tele') throw new Error('stacks are the tele camera\'s');
      if (!this.isStacking() && !this.st.stack.stacked) throw new Error('no stack is running');
      if (!this.st.stack.stacked) throw new Error('no stacked image yet (0 frames stacked)');
    } else if (!this.liveStage(camera)) {
      throw new Error(this.liveNote(camera) ?? `the ${camera} camera is not exposing (${this.viewOf(camera).stage ?? 'no stage'})`);
    }
    const frame = await sock.grab(kind, timeoutMs);
    const image = await frameImage(frame, camera);
    image.camera = camera;
    return { image, frame };
  }

  /**
   * Run with this camera's live frames in RAW (the 16-bit Bayer sub at the set exposure and gain),
   * JPEG again afterwards whatever happens. The wide's live JPEG in a star view is auto-exposed and
   * tone-mapped (exposure, gain and the ISP's manual settings change nothing, the ISP ones answer
   * 207 in star mode; 2026-11-05): walls, windows and sky all came out within a few levels of each
   * other. The RAW frames carry the scene's real contrast.
   */
  async withRawFrames<T>(camera: Camera, run: () => Promise<T>): Promise<T> {
    await this.setTransferMode(camera, 'Raw');
    try {
      return await run();
    } finally {
      await this.setTransferMode(camera, 'Jpg').catch((e) => log.warn(`could not put the ${camera} camera's live frames back to JPEG: ${errMsg(e)}`));
    }
  }

  /** One raw (Bayer) frame: the transfer mode goes to Raw for it and back to JPEG after. */
  grabRaw(camera: Camera, timeoutMs = RAW_STILL_TIMEOUT_MS): Promise<Frame> {
    const run = async (): Promise<Frame> => {
      if (!this.liveStage(camera)) throw new Error(`a raw ${camera} frame needs the ${camera} camera exposing (${this.liveNote(camera) ?? 'it is changing stage'})`);
      await this.setTransferMode(camera, 'Raw');
      try {
        const until = Date.now() + timeoutMs;
        for (let n = 0; n < 3 && Date.now() < until; n++) {
          const f = await this.images[camera].grab('preview', until - Date.now());
          if (f.header.imgType === IMG_TYPE.preview) return f;
        }
        throw new Error(`the ${camera} camera kept sending JPEG frames after the switch to RAW`);
      } finally {
        await this.setTransferMode(camera, 'Jpg').catch((e) => log.warn(`could not put the ${camera} camera's live frames back to JPEG: ${errMsg(e)}`));
      }
    };
    const p = this.rawQueue.then(run, run);
    this.rawQueue = p.catch(() => undefined);
    return p;
  }
}

function pairOf(v: unknown, a: string, b: string): [number, number] | null {
  const p = pair(v);
  if (p) return p;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o[a] === 'number' && typeof o[b] === 'number') return [o[a] as number, o[b] as number];
  }
  return null;
}

export { OTHER as OTHER_CAMERA };
