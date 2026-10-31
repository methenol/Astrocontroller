/**
 * The Seestar's live views for the shared web UI (video socket, MJPEG route, snapshots):
 *
 *   tele, wide  the camera's live frames from its picture socket, as the app shows them. Only the
 *               selected camera exposes: the viewer's main view selects the camera (device.ts
 *               keeps the scope on it), the other view says so in its note. Nothing swaps the
 *               camera behind the viewer's back. In a moon/planet view the tele streams RTSP
 *               instead, read by ffmpeg into MJPEG.
 *   stack       the stacked image, asked for as the stack's frames land
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { passthroughFrames } from '../../media/stream/ffmpeg.js';
import { JpegSplitter } from '../../media/stream/jpeg.js';
import { Source } from '../../media/stream/source.js';
import { autoStretch, toJpeg } from '../../media/images.js';
import { displayJpeg } from '../../mcp/tools/common.js';
import type { VideoHub } from '../../web/telescope.js';
import type { Seestar } from './device.js';
import { frameImage, JPEG_SOI, type Camera, type Frame } from './frames.js';
import type { GrabKind } from './image-link.js';

const log = logger('seestar.live');

const TICK_MS = 1000;
const LIVE_VIEW_RETRY_MS = 20_000;
const SELECT_DEBOUNCE_MS = 300;
const RTSP_FIRST_FRAME_MS = config.seestar.connection === 'zwo' ? 30_000 : 15_000;
const RTSP_SILENCE_MS = 90_000;
const RTSP_BACKOFF_MS = 2_000;
const RTSP_KILL_MS = 3_000;
const STACK_POLL_MS = 30_000;
const STACK_GRAB_TIMEOUT_MS = 20_000;
const STACK_MAX_SIZE = 1600;
const RTSP_MODES = new Set(['moon', 'planet']);

/** A camera's live picture. */
export class SeestarCameraSource extends Source {
  private rtsp: ChildProcess | null = null;
  private rtspTimer: NodeJS.Timeout | null = null;
  private rtspFrameAt = 0;
  private rtspStartedAt = 0;
  private rendering = false;
  private readonly onFrame = (f: Frame, kind: GrabKind | null) => {
    if (kind === 'stacked') return;
    if (!this.running && !this.wanted) return;
    void this.show(f);
  };

  constructor(
    readonly camera: Camera,
    private readonly scope: Seestar,
    private readonly host: () => string,
    private readonly onPrimary: (camera: Camera, on: boolean) => void,
  ) {
    super(camera);
    scope.images[camera].on('frame', this.onFrame);
  }

  protected startSource(): void {
    this.refresh();
  }

  protected stopSource(): void {
    this.stopRtsp();
  }

  override setPrimary(viewer: unknown, on: boolean): void {
    const before = this.primary;
    super.setPrimary(viewer, on);
    if (this.primary !== before) this.onPrimary(this.camera, this.primary);
  }

  /** Show a frame a tool took (a photo, a measured frame). */
  offer(jpeg: Buffer): void {
    this.frame(jpeg);
  }

  /** A picture frame from the socket, as JPEG (a raw preview is debayered and stretched). */
  private async show(f: Frame): Promise<void> {
    if (f.payload.subarray(0, 2).equals(JPEG_SOI)) {
      this.frame(f.payload);
      return;
    }
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.frame(await toJpeg(autoStretch(await frameImage(f, this.camera)), 1280, 80));
    } catch (e) {
      log.debug(`${this.camera}: frame not shown: ${errMsg(e)}`);
    } finally {
      this.rendering = false;
    }
  }

  /** The note and the RTSP reader follow the scope's state (called by the hub on every change). */
  refresh(): void {
    const st = this.scope.state;
    const rtspMode = this.camera === 'tele' && st.connected && !st.released && RTSP_MODES.has(st.view.mode ?? '') && this.scope.viewRunning();
    this.note = rtspMode ? (this.rtsp ? (this.rtspFrameAt ? null : `connecting to the ${st.view.mode} video…`) : `${st.view.mode} video starting…`) : this.scope.liveNote(this.camera);
    if (rtspMode && this.running) this.startRtsp();
    else this.stopRtsp();
  }

  override stallHint(): string {
    return this.note ?? `the ${this.camera} camera sends a frame per exposure (up to a few seconds each)`;
  }

  private rtspUrl(): string {
    return `rtsp://${this.host()}:${this.camera === 'wide' ? config.seestar.wideRtspPort : config.seestar.rtspPort}/stream`;
  }

  private startRtsp(): void {
    if (this.rtsp || this.rtspTimer) return;
    const url = this.rtspUrl();
    log.info(`${this.camera}: reading ${url}`);
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', url, '-an', ...passthroughFrames(), '-q:v', '4', '-f', 'mjpeg', 'pipe:1'];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.rtsp = child;
    this.rtspFrameAt = 0;
    this.rtspStartedAt = Date.now();
    const splitter = new JpegSplitter((jpeg: Buffer) => {
      this.rtspFrameAt = Date.now();
      this.note = null;
      this.frame(jpeg);
    });
    child.stdout!.on('data', (c: Buffer) => splitter.push(c));
    let err = '';
    child.stderr!.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-400)));
    child.on('error', (e) => log.warn(`${this.camera}: ffmpeg: ${errMsg(e)}`));
    child.on('exit', (code) => {
      if (this.rtsp !== child) return;
      this.rtsp = null;
      if (err.trim()) log.warn(`${this.camera}: the RTSP reader ended (${code}): ${err.trim().split('\n').pop()}`);
      if (this.running) this.rtspTimer = setTimeout(() => {
        this.rtspTimer = null;
        this.refresh();
      }, RTSP_BACKOFF_MS);
    });
  }

  private stopRtsp(): void {
    if (this.rtspTimer) clearTimeout(this.rtspTimer);
    this.rtspTimer = null;
    const child = this.rtsp;
    if (!child) return;
    this.rtsp = null;
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), RTSP_KILL_MS).unref();
  }

  /** A reader that stalled is restarted. */
  watchRtsp(): void {
    if (!this.rtsp) return;
    const now = Date.now();
    const stalled = this.rtspFrameAt ? now - this.rtspFrameAt > RTSP_SILENCE_MS : now - this.rtspStartedAt > RTSP_FIRST_FRAME_MS;
    if (stalled) {
      log.warn(`${this.camera}: no RTSP frames, restarting the reader`);
      this.stopRtsp();
      this.refresh();
    }
  }

  retarget(): void {
    if (this.rtsp) {
      this.stopRtsp();
      this.refresh();
    }
  }

  shutdown(): void {
    this.scope.images[this.camera].off('frame', this.onFrame);
    this.stopRtsp();
    this.forceStop();
  }
}

/** The stacked image, fetched from the tele's picture socket as the stack grows. */
export class SeestarStackSource extends Source {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly onEvent = (e: { Event?: string; state?: unknown }) => {
    if (this.running && e.Event === 'Stack' && (e.state === 'frame_complete' || e.state === 'working')) void this.poll();
  };

  constructor(private readonly scope: Seestar) {
    super('stack');
    scope.on('event', this.onEvent);
  }

  protected startSource(): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), STACK_POLL_MS);
      this.timer.unref();
    }
    void this.poll();
  }

  protected stopSource(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): void {
    const st = this.scope.state;
    if (!st.connected || st.released) this.note = this.scope.liveNote('tele');
    else if (!this.scope.isStacking()) this.note = st.stack.stacked ? `the last stack (${st.stack.stacked} frames)` : 'no live stack running';
  }

  shutdown(): void {
    this.scope.off('event', this.onEvent);
    this.forceStop();
  }

  private async poll(): Promise<void> {
    const st = this.scope.state;
    if (this.busy || !st.connected || st.released) return;
    if (!this.scope.isStacking() && !st.stack.stacked) return;
    this.busy = true;
    try {
      const { image } = await this.scope.grabImage('tele', 'stacked', STACK_GRAB_TIMEOUT_MS);
      this.note = null;
      this.frame(await displayJpeg(image, STACK_MAX_SIZE));
    } catch (e) {
      this.note = errMsg(e);
    } finally {
      this.busy = false;
    }
  }

  override stallHint(): string {
    return this.note ?? 'The Seestar has a stacked image only while it is stacking.';
  }
}

export class SeestarVideoHub implements VideoHub {
  readonly tele: SeestarCameraSource;
  readonly wide: SeestarCameraSource;
  readonly stack: SeestarStackSource;
  private tick: NodeJS.Timeout | null = null;
  private liveViewAskedAt = 0;
  private selectTimer: NodeJS.Timeout | null = null;
  private stackHeld = false;
  private readonly onState = () => this.follow();

  constructor(
    private readonly scope: Seestar,
    host: () => string,
  ) {
    const onPrimary = (camera: Camera, on: boolean) => this.primaryChanged(camera, on);
    this.tele = new SeestarCameraSource('tele', scope, host, onPrimary);
    this.wide = new SeestarCameraSource('wide', scope, host, onPrimary);
    this.stack = new SeestarStackSource(scope);
    scope.on('state', this.onState);
    this.tick = setInterval(() => this.follow(true), TICK_MS);
    this.tick.unref();
  }

  camera(camera: Camera): SeestarCameraSource {
    return camera === 'wide' ? this.wide : this.tele;
  }

  get(name: string): Source {
    if (name === 'tele') return this.tele;
    if (name === 'wide') return this.wide;
    if (name === 'stack') return this.stack;
    throw new Error(`no such video source: ${name}`);
  }

  status(): Record<string, unknown> {
    return { tele: this.tele.status(), wide: this.wide.status(), stack: this.stack.status(), selected: this.scope.selected, exposing: this.scope.exposing };
  }

  /** The viewer's main view changed: the scope follows it (debounced against a quick flip). */
  private primaryChanged(camera: Camera, on: boolean): void {
    if (!on) return;
    if (this.selectTimer) clearTimeout(this.selectTimer);
    this.selectTimer = setTimeout(() => {
      this.selectTimer = null;
      const want: Camera | null = this.wide.primary && !this.tele.primary ? 'wide' : this.tele.primary && !this.wide.primary ? 'tele' : camera;
      if (want && want !== this.scope.selected) void this.scope.selectCamera(want, 'is the main view').catch((e) => log.warn(`selecting the ${want} camera: ${errMsg(e)}`));
    }, SELECT_DEBOUNCE_MS);
  }

  /** Keep the sources' notes, the RTSP readers, the live view and the stack hold in step with the scope. */
  private follow(fromTick = false): void {
    const st = this.scope.state;
    this.tele.refresh();
    this.wide.refresh();
    this.stack.refresh();
    if (fromTick) {
      this.tele.watchRtsp();
      this.wide.watchRtsp();
    }
    const stacking = this.scope.isStacking() && st.connected && !st.released;
    if (stacking !== this.stackHeld) {
      this.stackHeld = stacking;
      this.stack.hold(stacking);
    }
    const watched = this.tele.wanted || this.wide.wanted;
    if (watched && st.connected && !st.released && !this.scope.viewRunning() && !this.scope.busy && Date.now() - this.liveViewAskedAt > LIVE_VIEW_RETRY_MS) {
      this.liveViewAskedAt = Date.now();
      void this.scope.ensureLiveView().catch((e) => log.warn(`live view: ${errMsg(e)}`));
    }
  }

  /** Disconnect: the readers stop; the viewers see the note. */
  release(): void {
    this.tele.forceStop();
    this.wide.forceStop();
    this.stack.forceStop();
    this.follow();
  }

  retarget(): void {
    this.tele.retarget();
    this.wide.retarget();
  }

  shutdown(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.selectTimer) clearTimeout(this.selectTimer);
    this.scope.off('state', this.onState);
    this.tele.shutdown();
    this.wide.shutdown();
    this.stack.shutdown();
  }
}
