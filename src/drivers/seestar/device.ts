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

const STATE_POLL_MS = 10_000;
/** While an operation runs the position and the battery must still move: a GoTo is six minutes of
 *  otherwise frozen dashboard, and the duty loop makes its decisions from these numbers. */
const BUSY_POLL_MS = 5_000;
const POLL_TICK_MS = 5_000;
const STATE_THROTTLE_MS = 500;
const GOTO_TIMEOUT_MS = 6 * 60_000;
/** The floor for the live exposure during an operation. The scope picks its own exposures for
 *  autofocus and solving, so this only rescues a camera left on a daytime setting (about a second
 *  at low gain), where a night sky holds no star for it to find and it answers 279 "no star is
 *  detected" / 251 "solve failed": it never raises a setting the agent or an operator chose. */
const NIGHT_CONTINUOUS_MS = 1_000;
/** how long a Disconnect waits for the running view to stop before closing the links anyway */
const STOP_VIEW_ON_RELEASE_MS = 8_000;
const NIGHT_GAIN = 100;
const AUTOFOCUS_TIMEOUT_MS = 6 * 60_000;
const PARK_TIMEOUT_MS = 3 * 60_000;
const SOLVE_TIMEOUT_MS = 2 * 60_000;
const POLAR_TIMEOUT_MS = 10 * 60_000;
const FOCUS_MOVE_TIMEOUT_MS = 60_000;
/** a live view the scope did not keep is not started again sooner than this */
const LIVE_VIEW_RETRY_MS = 20_000;
/** The view the wide camera's frames come from: the star view with the second camera selected
 *  (the app's ViewType WIDE, "SecondView"). Its raw subs arrive on the wide image socket; the tele's
 *  view sleeps meanwhile. */
const WIDE_CAM = 'SecondView';
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
  /** when the scope's state was last read in full over this connection (0: not yet) */
  private stateReadAt = 0;
  /** view changes in flight (a tool's, a still's): the readers never start a view over one */
  private viewChanging = 0;
  private viewSettled: Promise<void> = Promise.resolve();
  private settleView: (() => void) | null = null;
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
              supervisor: s.tunnel.control.enabled
                ? { host: s.tunnel.control.host, port: s.tunnel.control.port, token: s.tunnel.control.token, leaseS: s.tunnel.control.leaseS }
                : null,
              env: Object.fromEntries(
                Object.entries({ SEESTAR_USER: s.account.user, SEESTAR_PASSWORD: s.account.password, SEESTAR_SN: s.account.serial }).filter(([, v]) => v),
              ),
            })
          : null;

    this.rpc.on('event', (e: SeestarEvent) => this.onEvent(e));
    this.rpc.on('connected', () => {
      this.stateReadAt = 0; // what the scope is doing is unknown again until it is read
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

  private lastStatePollAt = 0;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.st.released = fs.existsSync(this.releasedFile);
    if (this.st.released) log.warn('the Seestar is released (Disconnect): not connecting until Connect is pressed');
    else this.openTransport();
    this.pollTimer = setInterval(() => {
      if (this.rpc.usable) {
        // a read between the operation's own commands is what keeps the position and the battery
        // honest while the scope works; skipping it froze the state for the length of a GoTo
        const every = this.operation ? BUSY_POLL_MS : STATE_POLL_MS;
        if (Date.now() - this.lastStatePollAt >= every) {
          this.lastStatePollAt = Date.now();
          void this.refreshState().catch(() => {});
        }
      }
      this.st.link = this.rpc.health();
    }, POLL_TICK_MS);
    this.pollTimer.unref?.();
    this.syncLink();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.pollTimer = this.emitTimer = null;
    // a shutdown is not a Disconnect: the session stays with the tunnel container, on its lease, for
    // the restart that usually follows
    this.closeTransport(false);
    await this.tunnel?.flush(1200);
  }

  /**
   * Disconnect: close every link, and the ZWO session too, so the official app can have the scope.
   *
   * A preview view left running is stopped first: a scope that keeps exposing after its client has
   * gone reports SHOOTING to the ZWO account, and nobody is watching those frames. A running stack
   * is left alone - it is the night's work, and the official app can pick it up.
   */
  async release(): Promise<void> {
    if (this.rpc.usable && this.viewing() && !this.stacking() && !this.operation) {
      log.info(`Disconnect: stopping the ${this.st.view.mode} view first, so the scope is not left exposing (SHOOTING) for nobody`);
      await Promise.race([this.stopView().catch((e) => log.warn(`Disconnect: the view did not stop: ${errMsg(e)}`)), sleep(STOP_VIEW_ON_RELEASE_MS)]);
    }
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

  private closeTransport(release = true): void {
    this.rpc.stop();
    for (const s of Object.values(this.streams)) s.close();
    this.tunnel?.stop(release);
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
      // A star view found running is adopted: it is the live stream, and the user wants it up the
      // whole time the controller is connected (it is stopped on Disconnect, so a scope is never
      // left "Capturing" by a session that ended). A scenery view is never this controller's and
      // shows nothing useful (the tele's is black): it is stopped.
      if (this.viewing() && this.st.view.mode === 'scenery' && !this.stacking() && !this.isBusy()) {
        log.info('connected with a scenery view running (never this controller\'s): stopping it');
        await this.stopView().catch((e) => log.warn(`the leftover view did not stop: ${errMsg(e)}`));
        await this.refreshState().catch(() => {});
      }
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
    this.stateReadAt = Date.now();
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
    // the live video keeps the scope in a scenery view, where its plate solver cannot work: the
    // imaging camera belongs to the operation, not to the preview
    await this.leaveVideoView(`GoTo ${g.name}`);
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

  /**
   * Live view without a target: the star (astro) view, always. This controller is for
   * astrophotography only: the scenery (daytime) view is never started by it - its tele RTSP is
   * black indoors, its plate solver and stacker do not exist, and a scope left in it shows
   * "Capturing" to the ZWO account for nobody.
   */
  startView(lpFilter = false): Promise<RpcResponse> {
    return this.changingView(async () => {
      const r = await this.call('iscope_start_view', { mode: 'star', lp_filter: lpFilter });
      this.wideView = false;
      await this.refreshState().catch(() => {});
      return r;
    });
  }

  /**
   * A view change with the readers held off. The scope takes seconds over iscope_start_view, and a
   * reader whose RTSP had just ended (the stop that precedes the start) used to ask for a view of
   * its own meanwhile: set_shooting_mode DSO came back "done" with the scope in the scenery view the
   * reader had started over it. Nested changes (a still's stop + start) count as one.
   */
  private async changingView<T>(run: () => Promise<T>): Promise<T> {
    this.liveViewAt = Date.now();
    if (this.viewChanging++ === 0) this.viewSettled = new Promise<void>((r) => (this.settleView = r));
    try {
      return await run();
    } finally {
      this.liveViewAt = Date.now();
      if (--this.viewChanging === 0) this.settleView?.();
    }
  }

  /** The wide camera's view (SecondView) is up: its image socket streams, the tele's sleeps. */
  private wideView = false;

  get wideViewActive(): boolean {
    return this.wideView;
  }

  private viewing(): boolean {
    const v = this.st.view;
    return !!v.state && !TERMINAL_STATES.has(v.state) && v.state !== 'idle' && v.mode !== 'none';
  }

  /** An operation (goto, capture, focus, plate-solve) is running: the live readers keep their hands
   *  off the control link until it finishes, so a command never competes with a stream. */
  get busy(): boolean {
    return this.operation !== null;
  }

  /**
   * The view the scope runs is decided by the work, never by the preview: the star (astro) view,
   * where the plate solver and the stacker live and the image sockets push every exposure. A viewer
   * of the live video gets one started when none is running (the Dwarf's streams are always on); a
   * view that is already running is never changed. Returns why there is no video, or null.
   */
  async ensureLiveView(now = false): Promise<string | null> {
    if (!this.rpc.usable || this.st.released) return 'the telescope is not connected';
    if (this.st.mount.parked) return 'the arm is parked: open it (Home) and live video starts';
    // mid-operation the readers keep their hands off: dialling a port the scope does not serve steals
    // tunnel bandwidth from the command that is running
    if (this.operation) return `${this.operation} is running: live video resumes when it finishes`;
    // right after a (re)connect the view is whatever the scope was left doing: a controller restart
    // during a star view started a scenery view over it, because the readers asked before the
    // first state read had landed
    if (!this.stateReadAt) await this.refreshState().catch(() => {});
    if (this.viewChanging) await this.viewSettled;
    if (this.viewing()) return this.videoNote();
    // the readers' throttle: a view the scope did not keep is not asked for again every tick. A
    // tool that needs a frame now (now=true) starts the view regardless - the stop that preceded
    // its request (a wide frame's, the idle stop) is no reason to wait 45 s for nothing.
    if (!now && Date.now() - this.liveViewAt < LIVE_VIEW_RETRY_MS) return null;
    log.info('starting a star view for the live video');
    await this.startView(false);
    return this.videoNote();
  }

  // ---- the view is the live stream: it runs the whole time the controller is connected --------
  // (a star view is never stopped while the link is up; Disconnect/release stops it)

  private stacking(): boolean {
    return !!this.st.stack.state && !TERMINAL_STATES.has(this.st.stack.state) && this.st.stack.state !== 'idle';
  }

  /** A stack is running: the view is the night's work and is not to be swapped for a wide frame. */
  isStacking(): boolean {
    return this.stacking();
  }

  /**
   * A frame was asked for from the live video. In the star view the scope serves no RTSP at all
   * (firmware 9.75): the readers fill the preview from the image sockets, which push every exposure
   * as it completes. This starts a star view when none runs and says why there is no picture.
   */
  async ensureVideoView(): Promise<string | null> {
    return (await this.ensureLiveView()) ?? this.videoNote();
  }

  /** Why a camera's reader has nothing right now, or null. */
  private videoNote(): string | null {
    return null;
  }

  /**
   * Drop a view that is not the tele's star view before an operation that needs the imaging camera
   * (GoTo, autofocus, stacking): the plate solver works from the tele's star view only. The readers
   * are closed so they cannot promote a view back mid-operation; they resume when it finishes.
   */
  private async leaveVideoView(what: string): Promise<void> {
    if (this.operation || !this.viewing() || (this.st.view.mode === 'star' && !this.wideView)) return;
    for (const s of Object.values(this.streams)) s.close();
    this.liveViewAt = Date.now(); // the readers' own throttle: keep them off the view for a moment
    log.info(`leaving the ${this.wideView ? 'wide camera' : this.st.view.mode ?? ''} view for ${what}: the tele star view is needed`);
    await this.stopView().catch(() => {});
    await this.refreshState().catch(() => {});
  }

  /**
   * Run something that needs a camera's frames, in the view that camera is served from. The tele
   * camera answers in the star view from its image socket; the wide camera's socket streams in the
   * star view with the second camera selected (SecondView), so a wide frame briefly goes there and
   * the tele's star view comes back afterwards. The night belongs to the tele - a single frame never
   * gets to keep the scope elsewhere. The scenery view is never used: this is astrophotography.
   */
  async withCameraView<T>(camera: Camera, what: string, run: () => Promise<T>): Promise<T> {
    if (camera === 'wide' && !this.wideView) return this.withWideView(what, run);
    return run();
  }

  /** A brief star view on the wide camera for its frames, with the tele's star view restored. */
  private async withWideView<T>(what: string, run: () => Promise<T>): Promise<T> {
    if (this.operation) throw new Error(`cannot take ${what}: ${this.operation} is running`);
    if (this.stacking()) throw new Error(`cannot take ${what}: the scope is stacking, and the wide camera's view would stop it`);
    const was = this.st.view.mode;
    log.info(`opening the wide camera's star view for ${what}`);
    await this.changingView(async () => {
      if (this.viewing()) await this.stopView().catch(() => {});
      await this.call('iscope_start_view', { mode: 'star', selected_cam: WIDE_CAM, lp_filter: false });
      this.wideView = true;
      await this.refreshState().catch(() => {});
    });
    try {
      return await run();
    } finally {
      // The scope can be taken by an operation while this is shooting: the agent starts a GoTo, a
      // focus run or a stack, and iscope_stop_view stops whatever the view is doing. Restoring the
      // preview view must never run over a command that belongs to somebody else - it cancels it.
      // Leave the view to the operation; the readers reopen what they need once it has finished.
      if (this.operation) {
        log.info(`leaving the view alone: ${this.operation} took the scope during ${what}`);
      } else {
        await this.changingView(async () => {
          for (const s of Object.values(this.streams)) s.close(); // nothing keeps the view alive behind us
          await this.stopView().catch(() => {});
          this.wideView = false;
          if (was === 'star') await this.call('iscope_start_view', { mode: 'star', lp_filter: false }, { allowError: true });
          await this.refreshState().catch(() => {});
        });
      }
      if (this.operation) await this.refreshState().catch(() => {});
    }
  }

  startStack(restart = false): Promise<RpcResponse> {
    return this.call('iscope_start_stack', { restart });
  }

  stopStack(): Promise<RpcResponse> {
    return this.call('iscope_stop_view', { stage: 'Stack' });
  }

  /** Stop whatever the view is doing: GoTo, live view, stacking. */
  stopView(): Promise<RpcResponse> {
    this.wideView = false;
    return this.changingView(() => this.call('iscope_stop_view'));
  }

  /**
   * The scope autofocuses and plate-solves from the live view. Left on a daytime 1 s exposure it
   * finds no star in a night sky and answers "no star is detected" (279) or "solve failed" (251),
   * which costs the whole imaging sequence: put the camera in night settings before asking it to
   * find anything out there.
   */
  private async prepareNightExposure(what: string): Promise<void> {
    const s = (await this.call('get_setting', undefined, { allowError: true }).catch(() => null))?.result as
      | { exp_ms?: { continuous?: number } }
      | undefined;
    // no answer at all is not a daytime camera: the command that follows reports the real trouble
    if (!s) return;
    const live = s.exp_ms?.continuous ?? 0;
    const gain = this.st.view.gain ?? 0; // the gain travels with the view state, not with the settings
    if (live >= NIGHT_CONTINUOUS_MS && gain >= NIGHT_GAIN) return;
    log.info(`${what}: the live view is at ${live / 1000} s, gain ${gain}; taking it to night settings first`);
    if (live < NIGHT_CONTINUOUS_MS) await this.setExposure({ continuousMs: NIGHT_CONTINUOUS_MS }).catch(() => {});
    if (gain < NIGHT_GAIN) await this.setGain(NIGHT_GAIN).catch(() => {});
    await this.refreshState().catch(() => {});
  }

  async autofocus(): Promise<OperationResult> {
    return Seestar.ok(
      'autofocus',
      await this.follow(
        'autofocus',
        ['AutoFocus'],
        // inside the operation, not before it: the settings read is a command of its own, and the
        // scope must not slip into another operation between preparing the camera and focusing
        async () => {
          await this.prepareNightExposure('autofocus');
          return this.call('start_auto_focuse');
        },
        AUTOFOCUS_TIMEOUT_MS,
      ),
    );
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
    return Seestar.ok(
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
    );
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
   * The view mode: star (deep sky), moon, planet. The Sun is refused: a remote scope cannot tell
   * whether its solar filter is fitted; the scenery (daytime) view is out of scope for an
   * astrophotography controller. "moon" and "planet" are sent by name, never as a bare solar_sys,
   * which the scope takes as the Sun.
   */
  async setViewMode(mode: 'star' | 'moon' | 'planet'): Promise<RpcResponse> {
    if (this.operation) throw new Error(`cannot change the view mode: ${this.operation} is running`);
    return this.changingView(async () => {
      if (this.viewing()) await this.stopView();
      const r = await this.call('iscope_start_view', mode === 'star' ? { mode, lp_filter: false } : { mode });
      this.wideView = false;
      await this.refreshState().catch(() => {});
      return r;
    });
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
    // the image sockets push exposures in the star view only, each camera in its own (the wide
    // camera's is the SecondView, see withCameraView): a wait on the wrong one is a wait for nothing
    if (kind === 'preview' && camera === 'wide' && !this.wideView) {
      throw new Error("a wide raw sub comes from the wide camera's view: ask through take_photo / view_camera wide, which open it for the frame");
    }
    if (kind === 'preview' && camera === 'tele' && this.wideView) {
      throw new Error("the wide camera's view is running and the tele sleeps meanwhile: ask again in a moment");
    }
    if (kind === 'preview' && camera === 'tele' && !this.viewing()) {
      const why = await this.ensureLiveView(true);
      if (why) throw new Error(`a raw sub needs a running star view: ${why}`);
    }
    // get_stacked_img answers with nothing at all while the stack has no frame yet (S50 Pro, fw
    // 9.75): the wait would run to its timeout and say "closed" or "no frame" without the reason
    if (kind === 'stacked' && this.st.stack.stacked === 0 && busyWith(this.st) === 'stacking') {
      throw new Error(`no stacked image yet: 0 frames stacked so far${this.st.stack.dropped ? ` (${this.st.stack.dropped} dropped)` : ''} - the stack is still collecting its first sub; ask again after an exposure or two, or use kind=preview for the live sub`);
    }
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
