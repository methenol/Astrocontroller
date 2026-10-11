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

/** A consumer of frames (an HTTP multipart client or a WebSocket video subscriber). */
export type Sink = (frame: Frame) => void;

export abstract class Source extends EventEmitter {
  latest: Frame | null = null;
  /** HTTP multipart clients; `busy` = a frame is still being written to that socket. */
  private clients = new Map<Response, { busy: boolean }>();
  /** Other subscribers (WebSocket video); each handles its own backpressure. */
  private sinks = new Set<Sink>();
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
    for (const [res, st] of this.clients) this.send(res, st, jpeg);
    for (const sink of this.sinks) {
      try {
        sink(this.latest);
      } catch (err) {
        log.debug(`sink error: ${errMsg(err)}`);
      }
    }
  }

  /** Subscribe to frames; keeps the source running until unsubscribed. */
  subscribe(sink: Sink): () => void {
    this.sinks.add(sink);
    if (this.latest) sink(this.latest);
    this.demand();
    return () => {
      if (this.sinks.delete(sink)) this.release();
    };
  }

  /**
   * Write one multipart frame. A client still receiving the previous frame skips this
   * one (slow links drop frames instead of buffering without bound). Busy is tracked
   * with the write callback, which always fires once the data is flushed.
   */
  private send(res: Response, st: { busy: boolean }, jpeg: Buffer): void {
    if (st.busy || res.destroyed || res.writableEnded) return;
    st.busy = true;
    const part = Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from('\r\n')]);
    res.write(part, () => {
      st.busy = false;
    });
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
    if (this.clients.size > 0 || this.sinks.size > 0 || this.holds > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0 && this.sinks.size === 0 && this.holds === 0 && this.running) {
        this.running = false;
        this.stopSource();
      }
    }, 120000);
  }

  forceStop(): void {
    if (this.running) {
      this.running = false;
      this.stopSource();
    }
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
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    const st = { busy: false };
    this.clients.set(res, st);
    // Give this viewer the current picture right away (only to this viewer, keeping its real timestamp).
    if (this.latest) this.send(res, st, this.latest.jpeg);
    this.demand();
    res.on('close', () => {
      this.clients.delete(res);
      this.release();
    });
  }

  /**
   * A frame captured within maxAgeMs, waiting up to timeoutMs for a new one.
   * Never falls back to an older frame: a stale image would look like a frozen
   * camera (e.g. the same picture after panning).
   */
  async snapshot(maxAgeMs = 3000, timeoutMs = 15000): Promise<Frame> {
    if (this.latest && Date.now() - this.latest.at <= maxAgeMs) return this.latest;
    this.hold(true);
    try {
      return await new Promise<Frame>((resolve, reject) => {
        const t = setTimeout(() => {
          this.off('frame', on);
          const age = this.latest ? `last frame was ${Math.round((Date.now() - this.latest.at) / 1000)} s ago` : 'no frames received yet';
          reject(new Error(`no new ${this.name} frame within ${Math.round(timeoutMs / 1000)} s (${age}). ${this.stallHint()}`));
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
    return this.clients.size + this.sinks.size;
  }

  /** Why frames might not be arriving (overridden per source). */
  stallHint(): string {
    return '';
  }

  status() {
    return { running: this.running, viewers: this.viewers, lastFrameAt: this.latest?.at ?? null, note: this.note };
  }

  note: string | null = null;
}

/**
 * RTSP camera → ffmpeg → MJPEG, run by a supervisor that checks its health once a second.
 *
 * What the telescope does (verified on fw 1.5.3, 2026-10-02/03), and what the supervisor does about it:
 *  - It serves very few RTSP sessions, and an abandoned one blocks video for everyone: exactly one
 *    reader per camera, closed with SIGINT (ffmpeg sends TEARDOWN) and SIGKILL after 3 s if it hangs.
 *  - It often goes silent on an open session instead of closing it: after a long-exposure still,
 *    calibration, motion or a mode change. A session with no frame for 8 s (12 s for a new one) is
 *    closed and reopened, with backoff 1 → 15 s; one frame resets everything. Expected pauses (the
 *    mount moving, GoTo / calibration / stacking, a still being taken) are waited out first.
 *  - A long manual exposure (≥ 1 s) stops a camera's video: set back to auto once per episode.
 *  - The tele has no RTSP in DSO mode (it hangs the session and blocks the wide video too): there the
 *    tele view is the telescope's astro preview. Other astro modes are tested: two sessions that never
 *    deliver a frame mark the mode for the tele until the mode changes. Nothing is persisted, and
 *    Normal mode always has video.
 */
type Phase = 'off' | 'connecting' | 'live' | 'backoff' | 'preview' | 'disconnected';

export class CameraSource extends Source {
  /** Where frames come from when the telescope won't serve RTSP (tele in astro modes → :8092). */
  fallback: Source | null = null;
  /** Shooting modes known to have no RTSP for this camera (tele: DSO). */
  noRtspModes = new Set<number>();
  private static readonly STALL_MS = 8000;
  private static readonly FIRST_FRAME_MS = 12000;
  private phase: Phase = 'off';
  private proc: ChildProcess | null = null;
  /** a reader told to stop that has not exited yet: no new one until it has (one session per camera) */
  private closing: ChildProcess | null = null;
  private closingSince = 0;
  private connectedAt = 0;
  private lastFrameAt = 0;
  private attempts = 0;
  private nextAttemptAt = 0;
  private pauseUntil = 0;
  private lastError = '';
  private previewActive = false;
  private onPreviewFrame = (f: Frame) => this.frame(f.jpeg);
  private tickTimer: NodeJS.Timeout | null = null;
  private healedThisEpisode = false;
  /** this mode's tele RTSP probes that never delivered a frame (reset on a mode change) */
  private silentProbes = 0;
  private probedMode: number | null = null;
  private learnedNoRtsp: number | null = null;

  constructor(
    name: 'tele' | 'wide',
    private readonly channel: number,
    readonly dwarf: Dwarf,
  ) {
    super(name);
  }

  get url(): string {
    return `rtsp://${config.dwarf.host}:${config.dwarf.rtspPort}/ch${this.channel}/stream0`;
  }

  // ---------------------------------------------------------------- lifecycle
  protected startSource(): void {
    this.phase = 'connecting';
    this.nextAttemptAt = 0;
    this.tickTimer ??= setInterval(() => this.tick(), 1000);
    this.tick();
  }

  protected stopSource(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.setPreview(false);
    this.stopReader('no viewers');
    this.phase = 'off';
  }

  /** A pause the controller causes on purpose (a long-exposure still): don't count it as a stall. */
  expectPause(ms: number): void {
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms);
  }

  /** Reconnect now (a mode change, the link coming back, or a caller that knows video should resume). */
  retryRtsp(): void {
    this.attempts = 0;
    this.nextAttemptAt = 0;
    this.pauseUntil = 0;
    if (this.proc && Date.now() - this.lastFrameAt > 3000) this.stopReader('reconnect requested');
    if (this.running) this.tick();
  }

  // ---------------------------------------------------------------- supervisor
  private tick(): void {
    if (!this.running) return;
    const now = Date.now();
    const st = this.dwarf.state;
    if (!st.connected) {
      if (this.proc) this.stopReader('telescope disconnected');
      this.setPreview(false);
      this.phase = 'disconnected';
      this.note = 'telescope disconnected; live video resumes when it reconnects';
      this.nextAttemptAt = 0;
      return;
    }
    const mode = st.shootingMode?.id ?? null;
    if (mode !== this.probedMode) {
      this.probedMode = mode;
      this.silentProbes = 0;
      this.learnedNoRtsp = null;
    }
    // tele in a mode without RTSP: the astro preview instead
    // Mode not known yet (just connected): opening the tele RTSP in DSO mode hangs the session, so wait.
    if (this.fallback && mode === null) {
      if (this.proc) this.stopReader('shooting mode unknown');
      this.setPreview(false);
      this.phase = 'backoff';
      this.note = 'waiting for the telescope to report its shooting mode';
      return;
    }
    if (this.fallback && mode !== null && mode !== 1 && (this.noRtspModes.has(mode) || this.learnedNoRtsp === mode)) {
      if (this.proc) this.stopReader(`${st.shootingMode?.name} mode has no tele RTSP`);
      this.setPreview(true);
      this.phase = 'preview';
      this.note = st.stacking.tele.state === 'running' || st.stacking.wide.state === 'running'
        ? `${st.shootingMode?.name ?? 'astro'} mode: showing the live stack preview`
        : `${st.shootingMode?.name ?? 'astro'} mode: the tele shows the stack preview while stacking runs; live video returns in Normal mode`;
      return;
    }
    this.setPreview(false);
    if (!this.proc) {
      if (this.closing) {
        // the previous session is still being torn down; never wait on it for ever
        if (now - this.closingSince < 6000) return;
        log.warn(`${this.name}: previous reader not confirmed gone after ${Math.round((now - this.closingSince) / 1000)} s; continuing`);
        try {
          this.closing.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        this.closing = null;
      }
      // No new session while the telescope runs an operation: it stops the video anyway, and the
      // firmware is better left alone until it is done.
      if (this.dwarf.quietPeriod()) {
        this.phase = 'backoff';
        this.note = 'live video paused while the telescope works; it resumes afterwards';
        return;
      }
      if (now >= this.nextAttemptAt) this.connect();
      else this.phase = 'backoff';
      return;
    }
    // a reader is running: is it delivering?
    const fresh = this.lastFrameAt > this.connectedAt;
    const quiet = now - (fresh ? this.lastFrameAt : this.connectedAt);
    const limit = fresh ? CameraSource.STALL_MS : CameraSource.FIRST_FRAME_MS;
    if (quiet < limit) return;
    // GoTo / calibration / polar alignment take over the cameras for a while (not stacking: that runs for hours)
    const pausing = now < this.pauseUntil || this.dwarf.quietPeriod() || now - this.dwarf.lastMotionAt < 4000;
    if (pausing) {
      this.note = 'live video paused while the telescope works; it resumes afterwards';
      return;
    }
    void this.onSilent(fresh, mode);
  }

  private silentHandling = false;
  private silentSince = 0;
  /** A telescope call during recovery, never allowed to hang the supervisor. */
  private bounded<T>(p: Promise<T>, ms = 6000): Promise<T | null> {
    return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  }
  private async onSilent(hadFrames: boolean, mode: number | null): Promise<void> {
    if (this.silentHandling && Date.now() - this.silentSince < 20000) return;
    this.silentHandling = true;
    this.silentSince = Date.now();
    try {
      const cam = this.name as 'tele' | 'wide';
      // a long manual exposure stops the video in any mode
      if (!this.healedThisEpisode) {
        const exp = await this.bounded(this.dwarf.exposureSeconds(cam));
        if (exp !== null && exp >= 1) {
          this.healedThisEpisode = true;
          await this.bounded(this.dwarf.setSetting(cam, 'exposure', 'auto'));
          log.warn(`${this.name}: no video with a ${exp} s manual exposure set: exposure set to auto (long exposures stop the telescope's live video)`);
          this.note = `${this.name} exposure was set to auto to restore live video`;
        }
      }
      if (!hadFrames && this.fallback && mode !== null && mode !== 1) {
        // the tele in an astro mode: two silent probes and this mode has no tele RTSP (until it changes)
        this.silentProbes++;
        if (this.silentProbes >= 2) {
          this.learnedNoRtsp = mode;
          log.info(`${this.name}: no RTSP video in ${this.dwarf.state.shootingMode?.name ?? 'this'} mode; using the astro preview until the mode changes`);
        }
      }
      this.restart(hadFrames ? 'live video stalled' : 'no video from the new connection');
    } finally {
      this.silentHandling = false;
    }
  }

  private backoffMs(): number {
    return Math.min(1000 * 2 ** Math.max(0, this.attempts - 1), 15000);
  }

  private restart(reason: string): void {
    this.attempts++;
    this.nextAttemptAt = Date.now() + this.backoffMs();
    if (this.attempts === 1) log.info(`${this.name}: ${reason}; reconnecting`);
    else if (this.attempts % 4 === 0) log.warn(`${this.name}: ${reason}; still reconnecting (attempt ${this.attempts}, next in ${Math.round(this.backoffMs() / 1000)} s)${this.lastError ? ` — ${this.lastError}` : ''}`);
    this.note = `${reason}; reconnecting${this.attempts > 1 ? ` (attempt ${this.attempts})` : ''}`;
    this.stopReader(reason);
    // re-arm the camera previews on the telescope before the next attempt
    void this.dwarf.ensureLiveView(true).catch(() => {});
  }

  private setPreview(on: boolean): void {
    if (!this.fallback || on === this.previewActive) return;
    this.previewActive = on;
    if (on) {
      this.fallback.on('frame', this.onPreviewFrame);
      this.fallback.hold(true);
      log.info(`${this.name}: showing the telescope's astro preview (:8092)`);
    } else {
      this.fallback.off('frame', this.onPreviewFrame);
      this.fallback.hold(false);
    }
  }

  // ---------------------------------------------------------------- the reader
  private connect(): void {
    this.phase = 'connecting';
    this.connectedAt = Date.now();
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // Socket timeout 20 s: only a backstop, the supervisor closes a silent session sooner.
      '-rtsp_transport', 'tcp', '-timeout', '20000000',
      // Keep frames decoded with missing references: this feed references missing frames so often
      // that dropping them (-output_corrupt) discarded ~90 % of the video (11.2 MB vs 1.2 MB per 8 s).
      // Grey decoder frames are filtered from agent snapshots instead.
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-i', this.url,
      // No fps filter (it duplicates the last frame with a fresh timestamp whenever the camera
      // pauses, which made old images look current): every real frame passes, rate-limited below.
      // Native 1920×1080 for the agent; browsers get a downscaled copy (video WebSocket).
      '-an', '-fps_mode', 'passthrough',
      '-q:v', '4', '-f', 'mjpeg', 'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let frames = 0;
    let lastEmit = 0;
    const minGap = 1000 / Math.max(1, config.web.liveFps);
    const splitter = new JpegSplitter((jpeg) => {
      if (this.proc !== proc) return;
      frames++;
      const now = Date.now();
      if (this.phase !== 'live') {
        if (this.attempts > 0) log.info(`${this.name}: live video is back`);
        this.phase = 'live';
      }
      this.lastFrameAt = now;
      this.attempts = 0;
      this.healedThisEpisode = false;
      this.silentProbes = 0;
      this.lastError = '';
      this.note = null;
      if (now - lastEmit < minGap) return; // rate-limit by dropping, never duplicating
      lastEmit = now;
      this.frame(jpeg);
    });
    proc.stdout!.on('data', (c: Buffer) => splitter.push(c));
    let errTail = '';
    proc.stderr!.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-400);
    });
    proc.on('error', (err) => log.error(`${this.name}: ffmpeg not available: ${errMsg(err)}`));
    proc.on('exit', (code) => {
      const ended = (proc as ChildProcess & { _stopping?: boolean })._stopping;
      if (this.proc === proc) this.proc = null;
      if (ended || !this.running) return;
      // the reader ended by itself (connection refused, RTSP 454, socket timeout)
      const msg = errTail.split('\n').filter((l) => l && !/POC|RPS|Could not find ref|NALU/.test(l)).pop();
      this.lastError = msg && /454|4XX/.test(msg) ? 'the telescope is not serving this stream right now (RTSP 454)' : (msg ?? `ffmpeg exited (${code})`);
      log.debug(`${this.name} ffmpeg exited (${code})${msg ? `: ${msg}` : ''} after ${frames} frames`);
      if (frames === 0 && this.fallback) {
        const mode = this.dwarf.state.shootingMode?.id ?? null;
        if (mode !== null && mode !== 1 && ++this.silentProbes >= 2) this.learnedNoRtsp = mode;
      }
      this.restart(frames ? 'live video ended' : `could not start live video (${this.lastError})`);
    });
  }

  /** Close the reader cleanly (SIGINT → TEARDOWN), and for good (SIGKILL after 3 s) if it hangs. */
  private stopReader(reason: string): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    (proc as ChildProcess & { _stopping?: boolean })._stopping = true;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    this.closing = proc;
    this.closingSince = Date.now();
    proc.once('exit', () => {
      if (this.closing === proc) this.closing = null;
    });
    log.debug(`${this.name}: closing reader (${reason})`);
    proc.kill('SIGINT');
    const t = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        log.warn(`${this.name}: reader did not stop; killing it`);
        proc.kill('SIGKILL');
      }
    }, 3000);
    proc.once('exit', () => clearTimeout(t));
  }

  stallHint(): string {
    const parts: string[] = [];
    if (this.note) parts.push(this.note);
    if (this.lastError) parts.push(`RTSP: ${this.lastError}`);
    parts.push('Long manual exposures stop this camera\'s live view; the mount moving also pauses frames briefly.');
    return parts.join(' ');
  }

  status() {
    const now = Date.now();
    return {
      ...super.status(),
      phase: this.phase,
      attempts: this.attempts,
      reader: this.proc?.pid ?? null,
      closing: this.closing ? Math.round((now - this.closingSince) / 1000) : null,
      nextAttemptIn: !this.proc && this.nextAttemptAt > now ? Math.round((this.nextAttemptAt - now) / 1000) : 0,
      recovering: this.silentHandling,
    };
  }

  /**
   * A full-resolution (1920×1080) frame from the single live connection. Never opens a
   * second RTSP session (that would block the stream on the telescope).
   */
  async fullResFrame(timeoutMs = 20000): Promise<Buffer> {
    return (await this.snapshot(1500, timeoutMs)).jpeg;
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

  /** Whether the telescope may be contacted now (set by the hub: linked and connected). */
  allowed: () => boolean = () => true;

  /** Drop the current connection; the loop reconnects when allowed. */
  interrupt(): void {
    this.abort?.abort();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    if (!this.allowed()) {
      this.retry = setTimeout(() => void this.connect(), 3000);
      return;
    }
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
    // one loop only: a stop + restart meanwhile started a new one with its own controller
    if (this.running && this.abort === ac) this.retry = setTimeout(() => void this.connect(), 3000);
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

  private lastModeId: number | undefined;

  constructor(readonly dwarf: Dwarf) {
    this.tele = new CameraSource('tele', 0, dwarf);
    this.wide = new CameraSource('wide', 1, dwarf);
    // In DSO/astro modes the telescope serves the tele preview on :8092 instead of RTSP.
    this.tele.fallback = this.stack;
    this.tele.noRtspModes.add(2); // DSO: verified, tele RTSP not served (opening it hangs the session)
    // Milky Way and Star Trail are astro modes like DSO: use the preview, never probe RTSP there.
    this.tele.noRtspModes.add(4);
    this.tele.noRtspModes.add(5);
    this.stack.allowed = () => dwarf.state.connected && !dwarf.state.released;
    // The link coming back: reconnect right away.
    let wasConnected = dwarf.state.connected;
    dwarf.on('state', () => {
      if (dwarf.state.connected && !wasConnected) {
        setTimeout(() => {
          this.tele.retryRtsp();
          this.wide.retryRtsp();
        }, 1500);
      }
      wasConnected = dwarf.state.connected;
    });
    // After a mode change, re-check RTSP right away instead of waiting for the next retry.
    dwarf.on('state', () => {
      const id = dwarf.state.shootingMode?.id;
      if (id !== undefined && id !== this.lastModeId) {
        const changed = this.lastModeId !== undefined;
        this.lastModeId = id;
        if (changed) setTimeout(() => {
          this.tele.retryRtsp();
          this.wide.retryRtsp();
        }, 2000);
      }
    });
    // Keep the stack preview flowing whenever the telescope is stacking.
    dwarf.on('state', () => {
      const active = dwarf.state.stacking.tele.state === 'running' || dwarf.state.stacking.wide.state === 'running';
      if (active !== this.stackHeld) {
        this.stackHeld = active;
        this.stack.hold(active);
      }
    });
  }

  status() {
    return { tele: this.tele.status(), wide: this.wide.status(), stack: this.stack.status() };
  }

  /**
   * The user released the telescope (Disconnect): drop the stack preview now. The camera readers
   * close themselves within a second (their supervisor sees the link down) and stay closed.
   */
  release(): void {
    this.stack.interrupt();
  }

  /** Close all readers cleanly (ffmpeg sends RTSP TEARDOWN) before the process exits. */
  shutdown(): void {
    for (const src of [this.tele, this.wide, this.stack]) src.forceStop();
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
