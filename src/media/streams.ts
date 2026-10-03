/**
 * Live imagery:
 *  - tele/wide: RTSP (H.265 1080p30) on :554 → ffmpeg → MJPEG frames, on demand.
 *  - stack:     the telescope's own multipart JPEG stream on :8092/mainstream,
 *               which carries the live-stacking result while stacking runs.
 * Each source keeps its latest JPEG for snapshots and fans frames out to
 * browser multipart clients.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

/** RTSP camera → ffmpeg → MJPEG. */
export class CameraSource extends Source {
  /** Where frames come from when the telescope won't serve RTSP (tele in astro modes → :8092). */
  fallback: Source | null = null;
  private fallbackActive = false;
  private onFallbackFrame = (f: Frame) => this.frame(f.jpeg);
  private proc: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private lastError = '';

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

  private lastRtspFrameAt = 0;
  private freshness: NodeJS.Timeout | null = null;

  protected startSource(): void {
    void this.spawnFfmpeg();
    // Show whatever the telescope is delivering: if RTSP goes quiet, switch to the fallback feed.
    if (this.fallback) {
      this.freshness ??= setInterval(() => {
        if (!this.running) return;
        if (Date.now() - this.lastRtspFrameAt > 4000) {
          if (!this.fallbackActive) {
            this.enableFallback();
            this.note = 'showing the telescope\'s astro preview (~2 fps): the live tele stream is not available right now';
          }
        }
      }, 1000);
    }
    // No watchdog restarts: the telescope's RTSP server serves very few clients at a time, so
    // every extra/abandoned connection can block video for everyone. One connection, kept open.
    // But explain silence caused by a long manual exposure (verified: that stops the RTSP video).
    this.exposureCheck ??= setInterval(async () => {
      if (!this.running || this.fallbackActive) return;
      const quiet = Date.now() - (this.latest?.at ?? 0) > 6000;
      if (!quiet) return;
      const exp = await this.dwarf.exposureSeconds(this.name as 'tele' | 'wide').catch(() => null);
      if (exp !== null && exp >= 1) this.note = `${this.name} exposure is ${exp}s manual — the telescope stops live video at long exposures; set exposure to auto to resume`;
    }, 3000);
  }

  private exposureCheck: NodeJS.Timeout | null = null;

  private procStartedAt = 0;

  private enableFallback(): void {
    if (!this.fallback || this.fallbackActive) return;
    this.fallbackActive = true;
    this.fallback.on('frame', this.onFallbackFrame);
    this.fallback.hold(true);
    log.info(`${this.name}: telescope is not serving RTSP in this mode; using its astro preview stream (:8092)`);
  }

  private disableFallback(): void {
    if (!this.fallback || !this.fallbackActive) return;
    this.fallbackActive = false;
    this.fallback.off('frame', this.onFallbackFrame);
    this.fallback.hold(false);
  }

  /** Try RTSP again now (e.g. after a shooting-mode change). */
  retryRtsp(): void {
    this.rtspBlockedInMode = null;
    if (!this.running || this.proc || this.spawning) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.failures = 0;
    void this.spawnFfmpeg();
  }

  stallHint(): string {
    const parts: string[] = [];
    if (this.lastError) parts.push(`RTSP: ${this.lastError}`);
    parts.push('Long manual exposures stall this camera\'s live view (set exposure to auto for framing); the mount moving also pauses frames briefly.');
    return parts.join(' ');
  }

  private exposureHealed = false;

  /** True from the moment a spawn starts until its process exits: never two readers per camera. */
  private spawning = false;

  private async spawnFfmpeg(): Promise<void> {
    if (!this.running || this.proc || this.spawning) return;
    this.spawning = true;
    try {
      await this.spawnFfmpegInner();
    } catch (err) {
      this.spawning = false;
      log.warn(`${this.name}: could not start reader: ${errMsg(err)}`);
    }
  }

  /**
   * Shooting modes in which this camera's RTSP proved unavailable (tele in DSO = mode 2, verified
   * 2026-10-02). Opening a session there makes the telescope hang it, which also blocks the other
   * camera's video, so it is never attempted; learned modes are persisted across restarts.
   */
  private rtspBlockedModes = new Set<number>();
  private rtspBlockedInMode: number | null = null; // set when a probe fails in the current mode
  private get blockFile() {
    return path.join(config.paths.data, `rtsp-blocked-${this.name}.json`);
  }
  loadBlockedModes(defaults: number[]): void {
    this.rtspBlockedModes = new Set(defaults);
    try {
      for (const m of JSON.parse(fs.readFileSync(this.blockFile, 'utf8'))) this.rtspBlockedModes.add(Number(m));
    } catch {
      /* none saved yet */
    }
  }
  private rememberBlocked(modeId: number | null): void {
    if (modeId === null) return;
    this.rtspBlockedModes.add(modeId);
    try {
      fs.writeFileSync(this.blockFile, JSON.stringify([...this.rtspBlockedModes]));
    } catch {
      /* best effort */
    }
  }

  private async spawnFfmpegInner(): Promise<void> {
    const modeId = this.dwarf.state.shootingMode?.id ?? null;
    if (this.fallback && modeId !== null && (this.rtspBlockedInMode === modeId || this.rtspBlockedModes.has(modeId))) {
      // Known not to work in this mode: don't open (and possibly hang) an RTSP session.
      this.enableFallback();
      this.note = `${this.dwarf.state.shootingMode?.name ?? 'this'} mode: showing the telescope's astro preview (~2 fps); live video returns in Normal mode`;
      this.spawning = false;
      return;
    }
    if (!this.fallbackActive) this.note = null;
    if (this.failures > 0) {
      await this.dwarf.ensureLiveView(this.failures > 2).catch((e) => log.debug(`live-view wake failed: ${errMsg(e)}`));
    }
    if (!this.running) {
      this.spawning = false;
      return;
    }
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // Socket read timeout 30 s: with long exposures frames arrive slowly, and a short timeout
      // made ffmpeg exit and reconnect over and over, piling up RTSP sessions on the telescope.
      '-rtsp_transport', 'tcp', '-timeout', '60000000',
      // Keep frames decoded with missing references: this feed references missing frames so
      // often that dropping them (-output_corrupt) discarded ~90% of the video (measured 11.2 MB
      // vs 1.2 MB per 8 s). Grey decoder frames are filtered from agent snapshots instead.
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-i', this.url,
      // No fps filter: it duplicates the last frame (with a fresh timestamp) whenever the
      // camera pauses, e.g. while the mount moves, which made old images look current.
      // Every real frame passes through; frame-rate limiting is done below by dropping.
      // Native 1920×1080 so the agent gets full resolution from this single connection;
      // browsers get a downscaled copy (see the video WebSocket).
      '-an', '-fps_mode', 'passthrough',
      '-q:v', '4', '-f', 'mjpeg', 'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const started = Date.now();
    this.procStartedAt = started;
    let gotFrame = false;
    let lastEmit = 0;
    const minGap = 1000 / Math.max(1, config.web.liveFps);
    const splitter = new JpegSplitter((jpeg) => {
      gotFrame = true;
      this.exposureHealed = false;
      this.failures = 0;
      this.lastError = '';
      this.note = null;
      this.lastRtspFrameAt = Date.now();
      if (this.fallbackActive) {
        this.disableFallback();
        log.info(`${this.name}: RTSP stream is back`);
      }
      const now = Date.now();
      if (now - lastEmit < minGap) return; // rate-limit by dropping, never duplicating
      lastEmit = now;
      this.frame(jpeg);
    });
    proc.stdout!.on('data', (c: Buffer) => splitter.push(c));
    if (!this.fallback) {
      // No video at all usually means a long manual exposure is set on this camera (verified:
      // that stops its RTSP video; the telescope's calibration leaves the wide camera at 1 s).
      // Self-heal once: set exposure to auto, then reconnect.
      setTimeout(async () => {
        if (gotFrame || this.proc !== proc || this.exposureHealed) return;
        this.exposureHealed = true;
        try {
          await this.dwarf.setSetting(this.name as 'tele' | 'wide', 'exposure', 'auto');
          log.warn(`${this.name}: no live video for 15 s — set ${this.name} exposure to auto (a long manual exposure stops the telescope's live video) and reconnecting`);
          this.note = `${this.name} exposure was set to auto to restore live video`;
          proc.kill('SIGINT');
        } catch (err) {
          log.debug(`${this.name}: exposure self-heal failed: ${errMsg(err)}`);
        }
      }, 15000);
    }
    if (this.fallback) {
      // If the telescope accepts the session but sends nothing, it isn't serving this camera in
      // this mode; close the session promptly so it can't block the RTSP server for the others.
      setTimeout(() => {
        if (!gotFrame && this.proc === proc) {
          this.rtspBlockedInMode = this.dwarf.state.shootingMode?.id ?? null;
          this.rememberBlocked(this.rtspBlockedInMode);
          log.info(`${this.name}: no RTSP video in ${this.dwarf.state.shootingMode?.name ?? 'this'} mode; using the astro preview until the mode changes`);
          proc.kill('SIGINT');
        }
      }, 10000);
    }
    let errTail = '';
    proc.stderr!.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-400);
    });
    proc.on('error', (err) => log.error(`ffmpeg not available: ${errMsg(err)}`));
    proc.on('exit', (code) => {
      this.proc = null;
      this.spawning = false;
      if (!this.running) return;
      if (!gotFrame || Date.now() - started < 5000) this.failures++;
      const msg = errTail.split('\n').filter((l) => l && !/POC|RPS|Could not find ref|NALU/.test(l)).pop();
      const notServed = !!msg && /454|4XX/.test(msg);
      this.lastError = notServed ? 'the telescope is not serving this stream right now (RTSP 454)' : (msg ?? `ffmpeg exited (${code})`);
      // Re-arm the camera's preview on the telescope before retrying.
      if (notServed) void this.dwarf.ensureLiveView(true).catch((e) => log.debug(`live-view wake failed: ${errMsg(e)}`));
      log.debug(`${this.name} ffmpeg exited (${code})${msg ? `: ${msg}` : ''}`);
      if (this.failures === 3) log.warn(`${this.name} camera RTSP stream unavailable: ${this.lastError}`);
      if ((notServed || this.rtspBlockedInMode !== null) && this.fallback) {
        // Expected in DSO/astro modes: show the telescope's astro preview; RTSP is retried after a mode change.
        if (notServed) {
          this.rtspBlockedInMode = this.dwarf.state.shootingMode?.id ?? null;
          this.rememberBlocked(this.rtspBlockedInMode);
        }
        this.enableFallback();
        this.note = `${this.dwarf.state.shootingMode?.name ?? 'this'} mode: showing the telescope's astro preview (~2 fps); live video returns in Normal mode`;
        return;
      }
      // Repeated immediate failures on a camera without fallback: most often a long manual
      // exposure (the telescope then won't start the stream). Self-heal once, then retry.
      if (!this.fallback && this.failures >= 2 && !this.exposureHealed) {
        this.exposureHealed = true;
        void this.dwarf
          .setSetting(this.name as 'tele' | 'wide', 'exposure', 'auto')
          .then(() => {
            log.warn(`${this.name}: live video would not start — set ${this.name} exposure to auto (long manual exposures stop the telescope's live video)`);
            this.note = `${this.name} exposure was set to auto to restore live video`;
          })
          .catch((e) => log.debug(`${this.name}: exposure self-heal failed: ${errMsg(e)}`));
        this.restartTimer = setTimeout(() => void this.spawnFfmpeg(), 3000);
        return;
      }
      // Back off up to 60 s so a dead stream doesn't turn into a reconnect storm.
      const delay = Math.min(2000 * 2 ** Math.min(this.failures, 5), 60000);
      this.note = this.failures > 0 ? `reconnecting (${this.lastError})` : null;
      this.restartTimer = setTimeout(() => void this.spawnFfmpeg(), delay);
    });
  }

  protected stopSource(): void {
    this.disableFallback();
    if (this.freshness) clearInterval(this.freshness);
    this.freshness = null;
    if (this.exposureCheck) clearInterval(this.exposureCheck);
    this.exposureCheck = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    // SIGINT/SIGTERM let ffmpeg send RTSP TEARDOWN so the telescope frees the session.
    this.proc?.kill('SIGINT');
    this.proc = null;
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

  private lastModeId: number | undefined;

  constructor(readonly dwarf: Dwarf) {
    this.tele = new CameraSource('tele', 0, dwarf);
    this.wide = new CameraSource('wide', 1, dwarf);
    // In DSO/astro modes the telescope serves the tele preview on :8092 instead of RTSP.
    this.tele.fallback = this.stack;
    this.tele.loadBlockedModes([2]); // DSO: verified, tele RTSP not served
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
