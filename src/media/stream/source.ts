/**
 * A source of live JPEG frames: it keeps the latest one for snapshots, fans frames out to
 * multipart HTTP viewers and other subscribers, and runs only while someone wants it.
 */
import type { Response } from 'express';
import { logger, errMsg } from '../../log.js';
import { SafeEmitter } from '../../util/events.js';

const log = logger('stream');

/** A source nobody watches stops this long after the last viewer left. */
const IDLE_STOP_MS = 120000;

export interface Frame {
  jpeg: Buffer;
  at: number;
}

/** A consumer of frames (a WebSocket video subscriber); each handles its own backpressure. */
export type Sink = (frame: Frame) => void;

export abstract class Source extends SafeEmitter {
  latest: Frame | null = null;
  running = false;
  note: string | null = null;
  /** HTTP multipart clients; `busy` = a frame is still being written to that socket. */
  private readonly clients = new Map<Response, { busy: boolean }>();
  private readonly sinks = new Set<Sink>();
  private holds = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(readonly name: string) {
    super();
    this.setMaxListeners(50);
  }

  protected abstract startSource(): void;
  protected abstract stopSource(): void;

  protected frame(jpeg: Buffer): void {
    const f = { jpeg, at: Date.now() };
    this.latest = f;
    this.emit('frame', f);
    for (const [res, st] of this.clients) this.send(res, st, jpeg);
    for (const sink of this.sinks) this.deliver(sink, f);
  }

  private deliver(sink: Sink, f: Frame): void {
    try {
      sink(f);
    } catch (err) {
      log.debug(`${this.name} sink error: ${errMsg(err)}`);
    }
  }

  /** Subscribe to frames; keeps the source running until unsubscribed. */
  subscribe(sink: Sink): () => void {
    this.sinks.add(sink);
    if (this.latest) this.deliver(sink, this.latest);
    this.demand();
    return () => {
      if (this.sinks.delete(sink)) this.release();
    };
  }

  /**
   * Write one multipart frame. A client still receiving the previous frame skips this one (slow
   * links drop frames instead of buffering without bound). Busy is tracked with the write
   * callback, which always fires once the data is flushed or the socket fails.
   */
  private send(res: Response, st: { busy: boolean }, jpeg: Buffer): void {
    if (st.busy || res.destroyed || res.writableEnded) return;
    st.busy = true;
    const head = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(Buffer.concat([head, jpeg, Buffer.from('\r\n')]), () => {
      st.busy = false;
    });
  }

  private demand(): void {
    this.clearIdle();
    if (!this.running) {
      this.running = true;
      this.startSource();
    }
  }

  private get wanted(): boolean {
    return this.clients.size > 0 || this.sinks.size > 0 || this.holds > 0;
  }

  private release(): void {
    if (this.wanted) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.wanted && this.running) {
        this.running = false;
        this.stopSource();
      }
    }, IDLE_STOP_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Stop now, whoever is watching (process shutdown). */
  forceStop(): void {
    this.clearIdle();
    if (this.running) {
      this.running = false;
      this.stopSource();
    }
  }

  /** Keep the source running independently of viewers (e.g. during stacking). */
  hold(on: boolean): void {
    this.holds = Math.max(0, this.holds + (on ? 1 : -1));
    if (on) this.demand();
    else this.release();
  }

  /** Serve this source to an HTTP client as multipart/x-mixed-replace. */
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
    res.on('error', (e) => log.debug(`${this.name} viewer: ${errMsg(e)}`));
    res.on('close', () => {
      this.clients.delete(res);
      this.release();
    });
    // Give this viewer the current picture right away (only to this viewer, keeping its real timestamp).
    if (this.latest) this.send(res, st, this.latest.jpeg);
    this.demand();
  }

  /**
   * A frame captured within maxAgeMs, waiting up to timeoutMs for a new one. Never falls back to
   * an older frame: a stale image would look like a frozen camera (the same picture after panning).
   */
  async snapshot(maxAgeMs = 3000, timeoutMs = 15000): Promise<Frame> {
    if (this.latest && Date.now() - this.latest.at <= maxAgeMs) return this.latest;
    this.hold(true);
    try {
      return await new Promise<Frame>((resolve, reject) => {
        const onFrame = (f: Frame) => {
          clearTimeout(t);
          this.off('frame', onFrame);
          resolve(f);
        };
        const t = setTimeout(() => {
          this.off('frame', onFrame);
          const age = this.latest ? `last frame was ${Math.round((Date.now() - this.latest.at) / 1000)} s ago` : 'no frames received yet';
          reject(new Error(`no new ${this.name} frame within ${Math.round(timeoutMs / 1000)} s (${age}). ${this.stallHint()}`.trim()));
        }, timeoutMs);
        this.on('frame', onFrame);
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
}
