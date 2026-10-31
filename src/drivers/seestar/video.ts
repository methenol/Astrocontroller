/**
 * The Seestar's live views for the shared web UI's video socket, MJPEG route and snapshots:
 *
 *   tele, wide  the scope's RTSP streams (SEESTAR_RTSP_PORT / SEESTAR_WIDE_RTSP_PORT, path /stream)
 *               read by ffmpeg into MJPEG, one reader per camera, reopened with backoff 1 → 15 s
 *   stack       the stacked image from the image socket, polled while someone watches
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../../config.js';
import { logger, errMsg } from '../../log.js';
import { passthroughFrames } from '../../media/stream/ffmpeg.js';
import { JpegSplitter } from '../../media/stream/jpeg.js';
import { Source } from '../../media/stream/source.js';
import { autoStretch, toJpeg } from '../../media/images.js';
import { displayJpeg } from '../../mcp/tools/common.js';
import type { VideoHub } from '../../web/telescope.js';
import type { Camera, Seestar } from './device.js';
import { frameImage, IMG_TYPE, JPEG_SOI, type Frame } from './image-stream.js';
import { TERMINAL_STATES } from './state.js';

const log = logger('stream');

const TICK_MS = 1000;
/** No frame for this long while the scope is idle: the reader is reopened. A frame pause during an
 *  operation (goto, plate-solve, capture, focus) is the scope pausing live video, not a dead
 *  connection: the reader stays open and ffmpeg's own socket timeout ends it if the link goes. */
const SILENCE_MS = 90_000;
/** A frame pause this long is worth saying out loud before it could become a reopen. */
const STALL_NOTE_MS = 10_000;
/** a new RTSP connection through the ZWO tunnel takes ~10-20 s to its first frame */
const FIRST_FRAME_MS = config.seestar.connection === 'zwo' ? 30_000 : 15_000;
/** reconnect fast: a dropped stream should be back in seconds, not minutes */
const BACKOFF_BASE_MS = 500;
/** A reader that has never produced a frame is not a dropped stream: the scope is not serving RTSP
 *  at all, which it does from a scenery view only. Retrying those slowly keeps the tunnel's control
 *  link and the other camera free instead of dialling a dead port every few seconds. */
const NEVER_BACKOFF_MS = 20_000;
const MAX_BACKOFF_MS = 5_000;
/** Frames per second each reader decodes while both cameras share the tunnel's one session. */
const GATE_FPS = 5;
/** the rest of the running exposure (up to 30 s) and the transfer, for a wide frame on demand */
const IMAGE_GRAB_MS = 45_000;
/** The wide camera streams only in its own view, so each wide frame pauses the tele's view for
 *  ~15 s: while the wide stream is watched and the scope is idle one is taken this often
 *  (SEESTAR_WIDE_REFRESH_S); a viewer opening the wide stream gets one unless the last is newer than this. */
const WIDE_REFRESH_MS = config.seestar.wideRefreshS * 1000;
const WIDE_OPEN_FRESH_MS = 5 * 60_000;
/** A reader told to stop is killed after this long. */
const KILL_AFTER_MS = 3000;
const STACK_POLL_MS = 5000;
const STACK_GRAB_TIMEOUT_MS = 8000;
const STACK_MAX_SIZE = 1600;
const ERR_TAIL_CHARS = 400;

/**
 * Over ZWO Telescope Network one RTSP stream at a time: both through the one tunnel session starve
 * its control link. The camera wanted most recently (a snapshot, a frame for a tool, a viewer
 * opening it) reads; the other waits.
 */
export class RtspGate {
  private readonly sources = new Set<SeestarCameraSource>();

  add(s: SeestarCameraSource): void {
    this.sources.add(s);
  }

  mayRead(s: SeestarCameraSource): boolean {
    let winner: SeestarCameraSource | null = null;
    for (const c of this.sources) if (c.inDemand && (!winner || c.wantedAt > winner.wantedAt)) winner = c;
    return winner === s;
  }
}

export class SeestarCameraSource extends Source {
  private proc: ChildProcess | null = null;
  private procUrl = '';
  private tickTimer: NodeJS.Timeout | null = null;
  private connectedAt = 0;
  private lastFrameAt = 0;
  private attempts = 0;
  private nextAttemptAt = 0;
  private lastError = '';
  /** when this camera was last asked for (RtspGate) */
  wantedAt = 0;

  constructor(
    readonly camera: Camera,
    private readonly scope: Seestar,
    private readonly host: () => string,
    private readonly gate: RtspGate | null = null,
  ) {
    super(camera);
    gate?.add(this);
  }

  get inDemand(): boolean {
    return this.running;
  }

  override hold(on: boolean): void {
    if (on) {
      this.wantedAt = Date.now();
      // Someone asked for this camera by name (a snapshot, a tool, a viewer): dial now instead of
      // sitting out the backoff a failing connection earned, or the caller's timeout expires first.
      if (!this.proc) {
        this.nextAttemptAt = 0;
        if (this.running) this.tick();
      }
    }
    super.hold(on);
  }

  get url(): string {
    const port = this.camera === 'wide' ? config.seestar.wideRtspPort : config.seestar.rtspPort;
    return `rtsp://${this.host()}:${port}/stream`;
  }

  protected startSource(): void {
    this.nextAttemptAt = 0;
    this.wantedAt = Date.now();
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
      this.tickTimer.unref();
    }
    this.tick();
    if (this.camera === 'wide') void this.refreshWide(WIDE_OPEN_FRESH_MS);
  }

  protected stopSource(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.stopReader();
    this.stopStreaming();
  }

  /**
   * The wide camera streams only in its own view, which the tele's night cannot share: a viewer
   * opening the wide stream gets one fresh frame (the tele's view pauses for it and comes back)
   * instead of whatever old picture was showing. A wide frame on demand is view_camera wide.
   */
  private refreshingWide = false;
  private async refreshWide(maxAgeMs: number): Promise<void> {
    const st = this.scope.state;
    if (this.refreshingWide || !this.running || !st.connected || st.released || this.scope.busy || this.scope.isStacking() || this.scope.wideViewActive) return;
    if (this.latest && Date.now() - this.latest.at < maxAgeMs) return;
    if (st.view.mode !== 'star' || st.view.state !== 'working') return; // no view to pause: a tele viewer starts one
    this.refreshingWide = true;
    try {
      await this.scope.withCameraView('wide', 'the wide live view', () => this.scope.grabImage('wide', 'preview', IMAGE_GRAB_MS));
    } catch (e) {
      this.note = `no wide frame: ${errMsg(e)}`;
    } finally {
      this.refreshingWide = false;
    }
  }

  /** Reconnect now (the address changed, or the link came back). */
  retry(): void {
    this.attempts = 0;
    this.nextAttemptAt = 0;
    this.stopReader();
    if (this.running) this.tick();
  }

  private tick(): void {
    if (!this.running) return;
    const st = this.scope.state;
    if (!st.connected || st.released) {
      this.stopReader();
      this.stopStreaming();
      this.note = 'telescope disconnected; live video resumes when it reconnects';
      this.nextAttemptAt = 0;
      return;
    }
    if (this.proc && this.procUrl !== this.url) this.stopReader();
    if (!this.proc) {
      if (Date.now() >= this.nextAttemptAt) {
        // never ask the scope for a view in the middle of an operation: that is a control command
        // competing with the one running, and the view comes back on its own as soon as it ends
        if (this.scope.busy) this.note = 'the scope is working; live video resumes when it is done';
        else
          void this.scope.ensureVideoView().then(
            (why) => why && (this.note = why),
            (e) => log.warn(`${this.name}: could not get a view for live video: ${errMsg(e)}`),
          );
        // In the star view the scope serves no RTSP at all: the live video is the image socket's
        // continuous stream, every exposure pushed as it completes (dialling a port nobody answers
        // only competes with the telescope's commands). Each camera streams in its own star view:
        // the tele's, or the wide camera's (SecondView) while a wide frame is being taken.
        if (st.view.mode === 'star' || st.view.mode === 'none' || !st.view.mode) {
          const wide = this.scope.wideViewActive;
          if ((this.camera === 'wide') !== wide) {
            this.stopStreaming();
            this.note = this.camera === 'wide'
              ? `the wide camera streams only in its own view: a wide frame is taken ${WIDE_REFRESH_MS ? `every ${Math.round(WIDE_REFRESH_MS / 1000)} s while the scope is idle` : 'when the wide stream is opened'} and by view_camera / take_photo wide; the live view is the tele`
              : "the wide camera's view is running for a wide frame; the tele resumes when it is done";
            if (this.camera === 'wide' && WIDE_REFRESH_MS) void this.refreshWide(WIDE_REFRESH_MS);
          } else if (st.view.mode === 'star' && st.view.state === 'working') {
            this.startStreaming();
            const since = Date.now() - this.lastFrameAt;
            if (this.lastFrameAt && since >= STALL_NOTE_MS * 3 && !this.note) this.note = `no live frame for ${Math.round(since / 1000)} s`;
          } else this.stopStreaming(); // between views: the one being started streams once it runs
          return;
        }
        // a moon or planet view carries RTSP (a video mode); "none" above is the gap between views
        this.stopStreaming();
        this.connect();
      }
      return;
    }
    const fresh = this.lastFrameAt > this.connectedAt;
    const since = Date.now() - (fresh ? this.lastFrameAt : this.connectedAt);
    if (since >= (fresh ? SILENCE_MS : FIRST_FRAME_MS) && !this.scope.busy) {
      this.restart(fresh ? 'live video went silent' : 'no video from the new connection');
    } else if (fresh && since >= STALL_NOTE_MS && !this.note) {
      this.note = `no frames for ${Math.round(since / 1000)} s: the scope pauses live video while it works`;
    }
  }

  private restart(reason: string): void {
    this.attempts++;
    // a stream that was carrying picture is worth dialling again within seconds; one that never
    // produced a frame on this connection is the scope not serving RTSP, so those retries slow down
    // and jitter rather than competing with commands and the other camera every few seconds
    const carried = this.lastFrameAt > this.connectedAt;
    const cap = carried ? MAX_BACKOFF_MS : NEVER_BACKOFF_MS;
    this.nextAttemptAt =
      Date.now() +
      Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempts - 1), cap) +
      Math.floor(Math.random() * 1000);
    if (this.attempts === 1 || this.attempts % 10 === 0) log.info(`${this.name}: ${reason}; reconnecting (attempt ${this.attempts})`);
    this.note = `${reason}; reconnecting${this.attempts > 1 ? ` (attempt ${this.attempts})` : ''}`;
    this.stopReader();
  }

  private connect(): void {
    this.connectedAt = Date.now();
    const url = this.url;
    // the same reader as the Dwarf's: TCP RTSP, low latency, every real frame, rate-limited below
    // Over ZWO Telescope Network both readers share the one tunnel session with the control link, so
    // the preview is throttled — but a 1 fps crawl reads as a frozen picture, and the scope's RTSP
    // encoder only puts out ~10 fps anyway. This is the compromise; `minGap` below caps it again.
    const rate = this.gate ? ['-vf', `fps=${GATE_FPS}`] : passthroughFrames();
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '20000000', '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', url, '-an', ...rate, '-q:v', '4', '-f', 'mjpeg', 'pipe:1'];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.procUrl = url;
    let frames = 0;
    let lastEmit = 0;
    let ended = false;
    const minGap = 1000 / Math.max(1, config.web.liveFps);
    const splitter = new JpegSplitter((jpeg) => {
      if (this.proc !== proc) return;
      frames++;
      const now = Date.now();
      if (this.attempts > 0) log.info(`${this.name}: live video is back`);
      this.lastFrameAt = now;
      this.attempts = 0;
      this.lastError = '';
      this.note = null;
      if (now - lastEmit < minGap) return;
      lastEmit = now;
      this.frame(jpeg);
    });
    proc.stdout!.on('data', (c: Buffer) => splitter.push(c));
    let errTail = '';
    proc.stderr!.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-ERR_TAIL_CHARS);
    });
    const onEnd = (why: string) => {
      if (ended) return;
      ended = true;
      if (this.proc !== proc || !this.running) return;
      this.proc = null;
      this.lastError = errTail.split('\n').filter(Boolean).pop() ?? why;
      log.debug(`${this.name} ffmpeg ended (${why}): ${this.lastError} after ${frames} frames`);
      this.restart(frames ? 'live video ended' : `could not start live video (${this.lastError})`);
    };
    proc.on('error', (err) => {
      log.error(`${this.name}: ffmpeg not available: ${errMsg(err)}`);
      onEnd(`ffmpeg error: ${errMsg(err)}`);
    });
    proc.on('exit', (code, signal) => onEnd(`ffmpeg exited (${code ?? signal})`));
  }

  private streamOn = false;
  private decoding = false;
  private readonly onStreamFrame = (f: Frame) => void this.showFrame(f);

  /** Live frames from this camera's image socket, continuously, until stopStreaming(). */
  private startStreaming(): void {
    if (this.streamOn) return;
    this.streamOn = true;
    const stream = this.scope.streams[this.camera];
    stream.on('frame', this.onStreamFrame);
    stream.startStreaming((note) => {
      if (note) this.note = note;
    });
    log.info(`${this.name}: live video from the image socket (every exposure as it completes)`);
  }

  private stopStreaming(): void {
    if (!this.streamOn) return;
    this.streamOn = false;
    const stream = this.scope.streams[this.camera];
    stream.off('frame', this.onStreamFrame);
    stream.stopStreaming();
  }

  /** A pushed exposure: the 16-bit Bayer sub (ZIP-wrapped on firmware 9.75) debayered and
   *  stretched like the tools' frames; a JPEG (a stack's) goes through as it stands. A frame that
   *  arrives while the previous one is still being converted is skipped: the next one shows. */
  private async showFrame(f: Frame): Promise<void> {
    if (!this.running || !this.streamOn || f.header.imgType !== IMG_TYPE.preview || this.decoding) return;
    this.decoding = true;
    try {
      const jpeg = f.payload.subarray(0, 2).equals(JPEG_SOI) ? f.payload : await toJpeg(autoStretch(await frameImage(f, this.camera)));
      if (!this.running || !this.streamOn) return;
      if (!this.lastFrameAt || Date.now() - this.lastFrameAt > SILENCE_MS) log.info(`${this.name}: live frames are coming from the image socket`);
      this.attempts = 0;
      this.lastError = '';
      this.note = null;
      this.lastFrameAt = Date.now();
      this.frame(jpeg);
    } catch (e) {
      this.note = `a live frame could not be shown: ${errMsg(e)}`;
    } finally {
      this.decoding = false;
    }
  }

  /** One astro-view preview: the newest frame from the image socket, on the same path ffmpeg feeds. */
  /** A frame a tool just took from this camera's image socket: the live preview shows it too. */
  offer(jpeg: Buffer): void {
    this.lastFrameAt = Date.now();
    this.note = null;
    this.frame(jpeg);
  }

  private stopReader(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    kill(proc, 'SIGINT');
    const t = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) kill(proc, 'SIGKILL');
    }, KILL_AFTER_MS);
    t.unref();
    proc.once('exit', () => clearTimeout(t));
  }

  override stallHint(): string {
    return [this.note, this.lastError && `RTSP: ${this.lastError}`, 'The Seestar pushes live frames while a star view runs; one is started for you when the arm is open.'].filter(Boolean).join(' ');
  }
}

/** The stacked image, polled from the image socket while someone watches. */
export class SeestarStackSource extends Source {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly scope: Seestar) {
    super('stack');
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

  private async poll(): Promise<void> {
    const st = this.scope.state;
    if (this.busy || !st.connected || st.released) return;
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
  private wasConnected: boolean;
  private stackHeld = false;
  private readonly onState = () => this.follow();

  constructor(
    private readonly scope: Seestar,
    host: () => string,
  ) {
    const gate = config.seestar.connection === 'zwo' ? new RtspGate() : null;
    this.tele = new SeestarCameraSource('tele', scope, host, gate);
    this.wide = new SeestarCameraSource('wide', scope, host, gate);
    this.stack = new SeestarStackSource(scope);
    this.wasConnected = scope.state.connected;
    scope.on('state', this.onState);
  }

  private follow(): void {
    const st = this.scope.state;
    if (st.connected && !this.wasConnected) this.retarget();
    this.wasConnected = st.connected;
    // keep the stacked image coming whenever the scope is stacking
    const stacking = !!st.stack.state && !TERMINAL_STATES.has(st.stack.state) && st.stack.state !== 'idle';
    if (stacking !== this.stackHeld) {
      this.stackHeld = stacking;
      this.stack.hold(stacking);
    }
  }

  get(name: string): Source {
    if (name === 'tele') return this.tele;
    if (name === 'wide') return this.wide;
    if (name === 'stack') return this.stack;
    throw new Error(`unknown stream ${name}`);
  }

  status() {
    return { tele: this.tele.status(), wide: this.wide.status(), stack: this.stack.status() };
  }

  release(): void {
    this.tele.retry();
    this.wide.retry();
  }

  retarget(): void {
    this.tele.retry();
    this.wide.retry();
  }

  shutdown(): void {
    this.scope.off('state', this.onState);
    for (const src of [this.tele, this.wide, this.stack]) src.forceStop();
  }
}

function kill(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    proc.kill(signal);
  } catch {
    /* already gone */
  }
}
