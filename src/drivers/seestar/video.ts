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
import { displayJpeg } from '../../mcp/tools/common.js';
import type { VideoHub } from '../../web/telescope.js';
import type { Camera, Seestar } from './device.js';
import { TERMINAL_STATES } from './state.js';

const log = logger('stream');

const TICK_MS = 1000;
/** A live session with no frame for this long is reopened. */
const STALL_MS = 10_000;
/** a new RTSP connection through the ZWO tunnel takes ~10-20 s to its first frame */
const FIRST_FRAME_MS = config.seestar.connection === 'zwo' ? 30_000 : STALL_MS;
const BACKOFF_BASE_MS = 1000;
const MAX_BACKOFF_MS = 15_000;
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
    if (on) this.wantedAt = Date.now();
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
  }

  protected stopSource(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.stopReader();
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
      this.note = 'telescope disconnected; live video resumes when it reconnects';
      this.nextAttemptAt = 0;
      return;
    }
    if (this.proc && this.procUrl !== this.url) this.stopReader();
    if (!this.proc) {
      if (Date.now() >= this.nextAttemptAt) {
        void this.scope.ensureLiveView().then(
          (why) => why && (this.note = why),
          (e) => log.warn(`${this.name}: could not start a view for live video: ${errMsg(e)}`),
        );
        this.connect();
      }
      return;
    }
    const fresh = this.lastFrameAt > this.connectedAt;
    if (Date.now() - (fresh ? this.lastFrameAt : this.connectedAt) >= (fresh ? STALL_MS : FIRST_FRAME_MS)) this.restart(fresh ? 'live video stalled' : 'no video from the new connection');
  }

  private restart(reason: string): void {
    this.attempts++;
    this.nextAttemptAt = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempts - 1), MAX_BACKOFF_MS);
    if (this.attempts === 1) log.info(`${this.name}: ${reason}; reconnecting`);
    this.note = `${reason}; reconnecting${this.attempts > 1 ? ` (attempt ${this.attempts})` : ''}`;
    this.stopReader();
  }

  private connect(): void {
    this.connectedAt = Date.now();
    const url = this.url;
    // the same reader as the Dwarf's: TCP RTSP, low latency, every real frame, rate-limited below
    // over ZWO Telescope Network the live view is a 1 frame/s preview: the tunnel's one session carries the control link too
    const rate = this.gate ? ['-vf', 'fps=1'] : passthroughFrames();
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
    return [this.note, this.lastError && `RTSP: ${this.lastError}`, 'The Seestar serves live video while a view runs; one is started for you when the arm is open.'].filter(Boolean).join(' ');
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
