/**
 * Live imagery:
 *  - tele/wide: RTSP (H.265 1080p30) on :554 → ffmpeg → MJPEG frames, on demand.
 *  - stack:     the telescope's own multipart JPEG stream on :8092/mainstream,
 *               which carries the live-stacking result while stacking runs.
 * Each source keeps its latest JPEG for snapshots and fans frames out to
 * browser multipart clients.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import type { Dwarf } from '../dwarf/device.js';

const log = logger('stream');
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** Splits a byte stream into complete JPEG images. */
class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onFrame: (jpeg: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const s = this.buf.indexOf(SOI);
      if (s < 0) {
        this.buf = Buffer.alloc(0);
        return;
      }
      const e = this.buf.indexOf(EOI, s + 2);
      if (e < 0) {
        if (s > 0) this.buf = this.buf.subarray(s);
        if (this.buf.length > 32 * 1024 * 1024) this.buf = Buffer.alloc(0);
        return;
      }
      this.onFrame(Buffer.from(this.buf.subarray(s, e + 2)));
      this.buf = this.buf.subarray(e + 2);
    }
  }
}

export interface Frame {
  jpeg: Buffer;
  at: number;
}

abstract class Source extends EventEmitter {
  latest: Frame | null = null;
  private clients = new Set<Response>();
  private holds = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  running = false;

  constructor(readonly name: string) {
    super();
    this.setMaxListeners(50);
  }

  protected abstract startSource(): void;
  protected abstract stopSource(): void;

  protected frame(jpeg: Buffer): void {
    this.latest = { jpeg, at: Date.now() };
    this.emit('frame', this.latest);
    for (const res of this.clients) {
      if (res.writableNeedDrain) continue; // slow client: drop frame
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n');
    }
  }

  private demand(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.running) {
      this.running = true;
      this.startSource();
    }
  }

  private release(): void {
    if (this.clients.size > 0 || this.holds > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0 && this.holds === 0 && this.running) {
        this.running = false;
        this.stopSource();
      }
    }, 20000);
  }

  /** Keep the source running independently of HTTP viewers (e.g. during stacking). */
  hold(on: boolean): void {
    this.holds = Math.max(0, this.holds + (on ? 1 : -1));
    if (on) this.demand();
    else this.release();
  }

  attach(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'close',
      Pragma: 'no-cache',
    });
    this.clients.add(res);
    if (this.latest) this.frame(this.latest.jpeg);
    this.demand();
    res.on('close', () => {
      this.clients.delete(res);
      this.release();
    });
  }

  /** Latest frame newer than maxAgeMs, waiting for one if needed. */
  async snapshot(maxAgeMs = 3000, timeoutMs = 15000): Promise<Frame> {
    if (this.latest && Date.now() - this.latest.at <= maxAgeMs) return this.latest;
    this.hold(true);
    try {
      return await new Promise<Frame>((resolve, reject) => {
        const t = setTimeout(() => {
          this.off('frame', on);
          if (this.latest) resolve(this.latest);
          else reject(new Error(`no ${this.name} image available (stream not producing frames)`));
        }, timeoutMs);
        const on = (f: Frame) => {
          clearTimeout(t);
          this.off('frame', on);
          resolve(f);
        };
        this.on('frame', on);
      });
    } finally {
      this.hold(false);
    }
  }

  get viewers(): number {
    return this.clients.size;
  }
}

/** RTSP camera → ffmpeg → MJPEG. */
export class CameraSource extends Source {
  private proc: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(
    name: 'tele' | 'wide',
    private readonly channel: number,
    private readonly dwarf: Dwarf,
  ) {
    super(name);
  }

  get url(): string {
    return `rtsp://${config.dwarf.host}:${config.dwarf.rtspPort}/ch${this.channel}/stream0`;
  }

  protected startSource(): void {
    void this.spawnFfmpeg();
  }

  private async spawnFfmpeg(): Promise<void> {
    if (!this.running || this.proc) return;
    if (this.failures > 0) {
      await this.dwarf.ensureLiveView(this.failures > 2).catch((e) => log.debug(`live-view wake failed: ${errMsg(e)}`));
    }
    if (!this.running) return;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp', '-timeout', '5000000',
      // Drop frames decoded with missing references (otherwise grey mush after motion/start).
      '-fflags', 'nobuffer', '-flags', 'low_delay-output_corrupt',
      '-i', this.url,
      '-an', '-vf', `fps=${config.web.liveFps},scale=${config.web.liveWidth}:-2`,
      '-q:v', '5', '-f', 'mjpeg', 'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const started = Date.now();
    let gotFrame = false;
    const splitter = new JpegSplitter((jpeg) => {
      gotFrame = true;
      this.failures = 0;
      this.frame(jpeg);
    });
    proc.stdout!.on('data', (c: Buffer) => splitter.push(c));
    let errTail = '';
    proc.stderr!.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-400);
    });
    proc.on('error', (err) => log.error(`ffmpeg not available: ${errMsg(err)}`));
    proc.on('exit', (code) => {
      this.proc = null;
      if (!this.running) return;
      if (!gotFrame || Date.now() - started < 5000) this.failures++;
      const msg = errTail.split('\n').filter((l) => l && !/POC|RPS|Could not find ref/.test(l)).pop();
      log.debug(`${this.name} ffmpeg exited (${code})${msg ? `: ${msg}` : ''}`);
      if (this.failures === 3) log.warn(`${this.name} camera RTSP stream unavailable (${this.url}); retrying`);
      const delay = Math.min(1000 * 2 ** Math.min(this.failures, 4), 15000);
      this.restartTimer = setTimeout(() => void this.spawnFfmpeg(), delay);
    });
  }

  protected stopSource(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }

  /** One full-resolution (1920×1080) frame straight from RTSP. */
  fullResFrame(timeoutMs = 20000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '5000000', '-flags', '-output_corrupt', '-i', this.url, '-an', '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', 'pipe:1'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        reject(new Error(`${this.name} full-resolution grab timed out`));
      }, timeoutMs);
      p.stdout!.on('data', (c: Buffer) => chunks.push(c));
      p.on('exit', () => {
        clearTimeout(t);
        const buf = Buffer.concat(chunks);
        if (buf.length > 1000) resolve(buf);
        else reject(new Error(`could not read a frame from ${this.url}`));
      });
    });
  }
}

/** The telescope's own multipart JPEG stream of the live stack. */
export class StackSource extends Source {
  private abort: AbortController | null = null;
  private retry: NodeJS.Timeout | null = null;

  constructor() {
    super('stack');
  }

  protected startSource(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const ac = new AbortController();
    this.abort = ac;
    try {
      const res = await fetch(`http://${config.dwarf.host}:${config.dwarf.stackPort}/mainstream`, { signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const splitter = new JpegSplitter((jpeg) => this.frame(jpeg));
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) splitter.push(Buffer.from(chunk));
    } catch (err) {
      if (!ac.signal.aborted) log.debug(`stack stream: ${errMsg(err)}`);
    }
    if (this.running && !ac.signal.aborted) this.retry = setTimeout(() => void this.connect(), 3000);
  }

  protected stopSource(): void {
    if (this.retry) clearTimeout(this.retry);
    this.abort?.abort();
    this.abort = null;
  }
}

export class StreamHub {
  readonly tele: CameraSource;
  readonly wide: CameraSource;
  readonly stack = new StackSource();
  private stackHeld = false;

  constructor(private readonly dwarf: Dwarf) {
    this.tele = new CameraSource('tele', 0, dwarf);
    this.wide = new CameraSource('wide', 1, dwarf);
    // Keep the stack preview flowing whenever the telescope is stacking.
    dwarf.on('state', () => {
      const active = dwarf.state.stacking.tele.state === 'running' || dwarf.state.stacking.wide.state === 'running';
      if (active !== this.stackHeld) {
        this.stackHeld = active;
        this.stack.hold(active);
      }
    });
  }

  lastMotionAt(): number {
    return this.dwarf.lastMotionAt;
  }

  get(name: string): CameraSource | StackSource {
    if (name === 'tele') return this.tele;
    if (name === 'wide') return this.wide;
    if (name === 'stack') return this.stack;
    throw new Error(`unknown stream ${name}`);
  }
}
