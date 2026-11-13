/**
 * One camera's picture socket (4800 for the tele, 4804 for the wide). It is opened with the control
 * link and stays open while connected: the app keeps both sockets alive with a test_connection
 * every 4 s, asks begin_streaming on the camera whose view is live, and never closes a socket to
 * change what it shows.
 *
 *   → { id, method }\r\n                 begin_streaming | stop_streaming | get_stacked_img |
 *                                        get_current_img | test_connection
 *   ← { id, method, code, result }\r\n   JSON reply lines, between pictures
 *   ← picture frame                      live previews (image_id 65535 or type preview), and the
 *                                        answers to get_stacked_img / get_current_img (image_id = id)
 */
import net from 'node:net';
import { SafeEmitter } from '../../util/events.js';
import { errMsg, logger } from '../../log.js';
import { FrameReader, IMG_TYPE, isLive, type Camera, type Frame } from './frames.js';

const log = logger('seestar.image');

const HEARTBEAT_MS = 4_000;
const FIRST_REDIAL_MS = 500;
const REDIAL_MIN_MS = 3_000;
const REDIAL_MAX_MS = 30_000;
/**
 * A begin_streaming the firmware does not act on (sent while the view was still starting, verified
 * 2026-11-04: after a tele -> wide switch the wide pushed nothing until the socket was redialled
 * 90 s later) is sent again (stop + begin) if no live frame came within KICK_MS, up to KICKS times;
 * then the socket is redialled. Once frames flow, a silence of STREAM_SILENCE_MS redials too.
 */
const KICK_MS = 8_000;
/**
 * Over the ZWO tunnel the wide camera's first picture byte came 29 s after begin_streaming
 * (2026-11-12), so the 8 s kicks (stop + begin) and the 24 s redial restarted it every time and no
 * frame ever arrived: the obstruction survey could not get one. There the first kick waits this long.
 */
export const TUNNEL_KICK_MS = 45_000;
/** over the tunnel a frame can be held up past 45 s; a redial throws it away and costs ~30 s to restart */
export const TUNNEL_STREAM_SILENCE_MS = 150_000;
const KICKS = 2;
/**
 * While the stream is paused, a preview grab resumes it for the frame it needs; it stops again this
 * long after the last one, so a run of grabs (a survey, a focus sweep) does not restart it each time.
 */
const PAUSED_GRAB_LINGER_MS = 20_000;
const STREAM_SILENCE_MS = 45_000;
const FIRST_ID = 1;

export type GrabKind = 'stacked' | 'current' | 'preview';

interface Waiter {
  id: number | null;
  kind: GrabKind;
  resolve: (f: Frame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ImageLinkStatus {
  camera: Camera;
  connected: boolean;
  streaming: boolean;
  liveFrames: number;
  lastFrameAt: number | null;
  note: string | null;
  /** the viewer paused the live stream (to save bandwidth); preview grabs still get their frames */
  paused: boolean;
}

/** Does a frame of this type answer a grab of this kind? */
function answers(kind: GrabKind, imgType: number): boolean {
  if (kind === 'stacked') return imgType === IMG_TYPE.jpegStack || imgType === IMG_TYPE.rawStack;
  return imgType === IMG_TYPE.preview || imgType === IMG_TYPE.jpegStack;
}

export class SeestarImageLink extends SafeEmitter {
  private socket: net.Socket | null = null;
  private wanted = false;
  private isConnected = false;
  private wantStream = false;
  private isStreaming = false;
  private nextId = FIRST_ID;
  private readonly waiters: Waiter[] = [];
  private readonly reader: FrameReader;
  private heartbeat: NodeJS.Timeout | null = null;
  private silence: NodeJS.Timeout | null = null;
  private kick: NodeJS.Timeout | null = null;
  private kicks = 0;
  /**
   * Whether live frames should be arriving now (the camera's view in ContinuousExposure): the
   * watchdogs act only then; during a GoTo, an autofocus or a stack's long subs they wait.
   */
  expecting: () => boolean = () => true;
  /** a live frame came since the last begin_streaming */
  private flowing = false;
  /** picture bytes arrived since the kick was last armed: a frame is on its way, do not restart it */
  private gotBytes = false;
  /**
   * The live stream is paused from the web UI: no begin_streaming while nothing needs a frame. A
   * preview grab (an agent's or a tool's) resumes it until PAUSED_GRAB_LINGER_MS after the last one.
   */
  private paused = false;
  private linger: NodeJS.Timeout | null = null;
  private redial: NodeJS.Timeout | null = null;
  private redialMs = FIRST_REDIAL_MS;
  private _note: string | null = null;
  last: Frame | null = null;
  lastLive: Frame | null = null;
  liveFrames = 0;

  constructor(
    private host: string,
    private port: number,
    readonly camera: Camera,
    private readonly connectFn: (host: string, port: number) => net.Socket = (h, p) => net.connect({ host: h, port: p }),
    /** how long after begin_streaming the first kick waits (longer over the ZWO tunnel) */
    private readonly kickMs = KICK_MS,
    /** how long a flowing stream may go without a frame before the socket is redialled */
    private readonly streamSilenceMs = STREAM_SILENCE_MS,
  ) {
    super();
    this.setMaxListeners(50);
    this.reader = new FrameReader(
      (f) => this.onFrame(f),
      (line) => this.onJson(line),
    );
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get streaming(): boolean {
    return this.isStreaming;
  }

  get note(): string | null {
    return this._note;
  }

  status(): ImageLinkStatus {
    return { camera: this.camera, connected: this.isConnected, streaming: this.isStreaming, liveFrames: this.liveFrames, lastFrameAt: this.last?.at ?? null, note: this._note, paused: this.paused };
  }

  open(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.redialMs = FIRST_REDIAL_MS;
    this.dial();
  }

  close(): void {
    this.wanted = false;
    this.wantStream = false;
    if (this.redial) clearTimeout(this.redial);
    this.redial = null;
    this.drop('closed', false);
  }

  retarget(host: string, port: number): void {
    if (host === this.host && port === this.port) return;
    this.host = host;
    this.port = port;
    if (this.wanted) {
      this.drop('retargeted', true);
    }
  }

  /** Ask the camera for live frames; remembered across redials. */
  startStream(): void {
    this.wantStream = true;
    this.apply();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Pause (or resume) the live stream; grabs keep working. */
  setPaused(on: boolean): void {
    if (on === this.paused) return;
    this.paused = on;
    this.apply();
    this.changed();
  }

  private get previewWanted(): boolean {
    return this.waiters.some((w) => w.id === null);
  }

  /** Start or stop the stream to match `wantStream`, the pause and the grabs waiting for a frame. */
  private apply(): void {
    if (!this.isConnected) return;
    if (this.wantStream && (!this.paused || this.previewWanted)) {
      if (this.linger) clearTimeout(this.linger);
      this.linger = null;
      if (this.isStreaming) return;
      this.isStreaming = true;
      this.kicks = 0;
      this.begin();
      this.changed();
      return;
    }
    if (!this.isStreaming) return;
    if (!this.wantStream) {
      this.halt();
      return;
    }
    this.linger ??= setTimeout(() => {
      this.linger = null;
      if (this.isConnected && this.isStreaming && this.paused && !this.previewWanted) this.halt();
    }, PAUSED_GRAB_LINGER_MS);
  }

  private halt(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    this.isStreaming = false;
    this.write('stop_streaming');
    this.disarmSilence();
    this.disarmKick();
    this.changed();
  }

  /**
   * The camera's view just started exposing: ask for the stream again (stop + begin), since a
   * begin_streaming that arrived before the exposures started is not acted on.
   */
  restartStream(): void {
    this.wantStream = true;
    if (!this.isConnected) return;
    if (this.paused && !this.previewWanted) {
      this.apply();
      return;
    }
    if (this.isStreaming) this.write('stop_streaming');
    this.isStreaming = true;
    this.kicks = 0;
    this.begin();
    this.changed();
  }

  private begin(): void {
    this.flowing = false;
    this.write('begin_streaming');
    this.armSilence();
    this.armKick();
  }

  private armKick(): void {
    if (this.kick) clearTimeout(this.kick);
    this.gotBytes = false;
    this.kick = setTimeout(() => {
      this.kick = null;
      if (!this.isStreaming || this.flowing || !this.isConnected) return;
      if (!this.expecting() || this.gotBytes) {
        this.armKick();
        return;
      }
      if (this.kicks >= KICKS) {
        this.drop(`no live frames ${Math.round((this.kickMs * (KICKS + 1)) / 1000)} s after begin_streaming`, true);
        return;
      }
      this.kicks++;
      log.info(`${this.camera}: no live frame ${Math.round(this.kickMs / 1000)} s after begin_streaming, asking again (${this.kicks}/${KICKS})`);
      this.write('stop_streaming');
      this.begin();
    }, this.kickMs);
  }

  private disarmKick(): void {
    if (this.kick) clearTimeout(this.kick);
    this.kick = null;
  }

  stopStream(): void {
    this.wantStream = false;
    this.apply();
  }

  /**
   * One picture: the current stack (get_stacked_img), the firmware's current frame (get_current_img,
   * the picture the app shows when the stream is paused), or the next live preview.
   */
  grab(kind: GrabKind, timeoutMs: number): Promise<Frame> {
    if (!this.isConnected) return Promise.reject(new Error(`the ${this.camera} camera's picture socket is not connected`));
    return new Promise<Frame>((resolve, reject) => {
      const id = kind === 'preview' ? null : this.nextId++;
      const w: Waiter = {
        id,
        kind,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.forget(w);
          reject(new Error(`no ${kind === 'stacked' ? 'stacked image' : 'frame'} from the ${this.camera} camera in ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs),
      };
      this.waiters.push(w);
      if (id === null) this.apply();
      if (id !== null) this.write(kind === 'stacked' ? 'get_stacked_img' : 'get_current_img', id);
    });
  }

  private dial(): void {
    if (!this.wanted || this.socket) return;
    let socket: net.Socket;
    try {
      socket = this.connectFn(this.host, this.port);
    } catch (err) {
      this._note = errMsg(err);
      this.scheduleRedial();
      return;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.on('connect', () => {
      if (this.socket !== socket) return;
      this.isConnected = true;
      this._note = null;
      this.redialMs = FIRST_REDIAL_MS;
      this.reader.reset();
      this.heartbeat = setInterval(() => this.write('test_connection'), HEARTBEAT_MS);
      log.info(`${this.camera} picture socket connected (${this.host}:${this.port})`);
      this.apply();
      this.changed();
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      try {
        this.reader.push(chunk);
      } catch (err) {
        log.warn(`${this.camera} picture socket: ${errMsg(err)}`);
        this.reader.reset();
      }
      // a picture is part-way in (heartbeat replies do not count): the stream is not silent,
      // whatever its pace over the tunnel, and restarting it would throw the picture away
      if (this.reader.receiving) {
        this.gotBytes = true;
        if (this.silence) this.armSilence();
      }
    });
    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.drop(errMsg(err), true);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.drop('closed by the Seestar', true);
    });
  }

  private write(method: string, id = this.nextId++): void {
    const s = this.socket;
    if (!s || !this.isConnected) return;
    s.write(JSON.stringify({ id, method }) + '\r\n');
  }

  private onFrame(f: Frame): void {
    this.last = f;
    let kind: GrabKind | null = null;
    // an ack carries the request's id but no picture: the picture follows (or nothing does)
    if (f.header.imgType === IMG_TYPE.ack) {
      this.emit('frame', f, null);
      return;
    }
    // an answer carries the request's id. Everything else that comes while streaming is a pushed
    // live frame: the app's 65535 id, or (Jpg transfer mode, firmware 9.75) a JPEG stamped with its
    // own running id; a live frame answers every id-less preview waiter
    const byId = f.header.imageId !== 65535 ? this.waiters.find((w) => w.id === f.header.imageId) : undefined;
    const live = !byId && (isLive(f.header) || this.isStreaming);
    if (live) {
      this.liveFrames++;
      this.lastLive = f;
      if (this.isStreaming) {
        this.flowing = true;
        this.kicks = 0;
        this.disarmKick();
        this.armSilence();
      }
    }
    if (byId) {
      kind = byId.kind;
      this.forget(byId);
      clearTimeout(byId.timer);
      byId.resolve(f);
    } else if (live) {
      for (const w of this.waiters.filter((w) => w.id === null)) {
        this.forget(w);
        clearTimeout(w.timer);
        w.resolve(f);
      }
    } else {
      const byType = this.waiters.find((w) => w.id !== null && answers(w.kind, f.header.imgType));
      if (byType) {
        kind = byType.kind;
        this.forget(byType);
        clearTimeout(byType.timer);
        byType.resolve(f);
      }
    }
    this.emit('frame', f, kind);
  }

  private onJson(line: string): void {
    let msg: { id?: number; method?: string; code?: number; result?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'test_connection') return;
    if (typeof msg.code === 'number' && msg.code !== 0 && typeof msg.id === 'number') {
      const w = this.waiters.find((x) => x.id === msg.id);
      if (w) {
        this.forget(w);
        clearTimeout(w.timer);
        w.reject(new Error(`${msg.method ?? 'request'} on the ${this.camera} camera failed: code ${msg.code}`));
      }
    }
  }

  private forget(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
    if (w.id === null) this.apply();
  }

  private armSilence(): void {
    this.disarmSilence();
    this.silence = setTimeout(() => {
      this.silence = null;
      if (!this.expecting()) this.armSilence();
      else this.drop(`no live frames for ${this.streamSilenceMs / 1000} s`, true);
    }, this.streamSilenceMs);
  }

  private disarmSilence(): void {
    if (this.silence) clearTimeout(this.silence);
    this.silence = null;
  }

  private drop(reason: string, redial: boolean): void {
    const socket = this.socket;
    this.socket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.disarmSilence();
    this.disarmKick();
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    const was = this.isConnected;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      if (was && this.isStreaming) {
        try {
          socket.write(JSON.stringify({ id: this.nextId++, method: 'stop_streaming' }) + '\r\n');
        } catch {
          /* closing anyway */
        }
      }
      socket.destroy();
    }
    this.isConnected = false;
    this.isStreaming = false;
    // replies die with the connection; a wait for the next live frame carries over
    for (const w of [...this.waiters]) {
      if (w.id === null) continue;
      this.forget(w);
      clearTimeout(w.timer);
      w.reject(new Error(`the ${this.camera} camera's picture socket closed (${reason})`));
    }
    if (was) {
      log.warn(`${this.camera} picture socket dropped: ${reason}`);
      this._note = reason === 'closed' ? null : `picture socket dropped: ${reason}`;
    }
    this.changed();
    if (redial && this.wanted) this.scheduleRedial();
  }

  private scheduleRedial(): void {
    if (!this.wanted || this.redial || this.socket) return;
    const delay = this.redialMs;
    this.redialMs = Math.min(REDIAL_MAX_MS, Math.max(REDIAL_MIN_MS, this.redialMs * 2));
    this.redial = setTimeout(() => {
      this.redial = null;
      this.dial();
    }, delay);
  }

  private changed(): void {
    this.emit('status', this.status());
  }
}
