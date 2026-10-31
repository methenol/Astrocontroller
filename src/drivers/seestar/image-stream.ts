/**
 * The Seestar's image sockets: port 4800 (tele) and 4804 (wide) carry binary frames, each a header
 * and a payload, with CRLF JSON replies to the socket's own commands (test_connection,
 * begin_streaming, stop_streaming, get_stacked_img, get_current_img) interleaved between them.
 *
 * Header, big-endian (34 named bytes, then padding up to header_size, observed 80):
 *   0 u16 magic 0x03C3 · 2 u16 version · 4 u16 header_size · 6 u32 payload length · 12 u8 big-endian flag
 *   13 u8 img_type (0 ack, 1 preview, 4 JPEG stack, 5 raw stack) · 14 u8 data_type · 15 u8 frame_id
 *   16 u16 width · 18 u16 height · 20/22/24 u16 hfd x/y/value · 26 u16 can_debayer · 28 u16 image_id
 *
 * Payloads: a JPEG stack (fw 8.46+, already stretched, width/height 0 in the header), a raw stack of
 * 16-bit RGB (h×w×3×2 bytes, or ZIP-wrapped deflate on older firmware), or a preview of 16-bit Bayer
 * (h×w×2 bytes; ZIP-wrapped too on an S50 Pro with firmware 9.75, entry "raw_data"). Pixel words are
 * little-endian, as seestarpy reads them from live scopes.
 */
import net from 'node:net';
import zlib from 'node:zlib';
import { errMsg, logger } from '../../log.js';
import { decode, type FloatImage } from '../../media/images.js';
import { SafeEmitter } from '../../util/events.js';

const log = logger('seestar');

export const MAGIC = 0x03c3;
const NAMED_HEADER_BYTES = 34;
const HEARTBEAT_MS = 4000;
/** a raw 4K stack is ~50 MB and takes ~30 s over Wi-Fi; a tunnel is slower still */
const GRAB_TIMEOUT_MS = 120_000;
/** a begin_streaming the scope answered by closing the socket (its view still starting) is sent again after this */
const EARLY_CLOSE_RETRY_MS = 3000;
/** a live streaming connection that pushes nothing for this long is dropped and dialled again */
const STREAM_SILENCE_MS = 60_000;
const STREAM_MAX_BACKOFF_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const CONNECT_TIMEOUT_MS = 8000;
/** close an image socket nobody has used for this long */
const IDLE_CLOSE_MS = 60_000;
/** larger than any frame a Seestar sends (a 4K raw stack is 49.8 MB) */
const MAX_PAYLOAD_BYTES = 200 * 1024 * 1024;

export const IMG_TYPE = { ack: 0, preview: 1, jpegStack: 4, rawStack: 5 } as const;
/** The start of a JPEG: what an image-socket payload must begin with to be usable as a picture
 *  as it stands, rather than something the firmware wrapped (a 16-bit Bayer sub, a ZIP). */
export const JPEG_SOI = Buffer.from([0xff, 0xd8]);

export interface FrameHeader {
  version: number;
  headerSize: number;
  length: number;
  bigEndian: boolean;
  imgType: number;
  dataType: number;
  frameId: number;
  width: number;
  height: number;
  hfdX: number;
  hfdY: number;
  hfd: number;
  canDebayer: boolean;
  imageId: number;
}

export interface Frame {
  header: FrameHeader;
  payload: Buffer;
  at: number;
}

export function parseHeader(b: Buffer): FrameHeader | null {
  if (b.length < NAMED_HEADER_BYTES || b.readUInt16BE(0) !== MAGIC) return null;
  return {
    version: b.readUInt16BE(2),
    headerSize: b.readUInt16BE(4),
    length: b.readUInt32BE(6),
    bigEndian: b[12] === 1,
    imgType: b[13],
    dataType: b[14],
    frameId: b[15],
    width: b.readUInt16BE(16),
    height: b.readUInt16BE(18),
    hfdX: b.readUInt16BE(20),
    hfdY: b.readUInt16BE(22),
    hfd: b.readUInt16BE(24),
    canDebayer: b.readUInt16BE(26) === 1,
    imageId: b.readUInt16BE(28),
  };
}

/** Builds a header (tests, and the fake scope). */
export function encodeHeader(h: Partial<FrameHeader> & { length: number; imgType: number }): Buffer {
  const b = Buffer.alloc(h.headerSize ?? 80);
  b.writeUInt16BE(MAGIC, 0);
  b.writeUInt16BE(h.version ?? 2, 2);
  b.writeUInt16BE(h.headerSize ?? 80, 4);
  b.writeUInt32BE(h.length, 6);
  b[12] = h.bigEndian ? 1 : 0;
  b[13] = h.imgType;
  b[14] = h.dataType ?? 3;
  b[15] = h.frameId ?? 0;
  b.writeUInt16BE(h.width ?? 0, 16);
  b.writeUInt16BE(h.height ?? 0, 18);
  b.writeUInt16BE(h.hfdX ?? 0, 20);
  b.writeUInt16BE(h.hfdY ?? 0, 22);
  b.writeUInt16BE(h.hfd ?? 0, 24);
  b.writeUInt16BE(h.canDebayer ? 1 : 0, 26);
  b.writeUInt16BE(h.imageId ?? 0, 28);
  return b;
}

/**
 * Splits the socket's byte stream into frames and JSON lines. It resynchronises on the magic
 * number, so stray bytes between frames cost only themselves.
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;
  /** bytes the frame in flight needs in all: chunks are joined only once they are there */
  private need = 0;

  constructor(
    private readonly onFrame: (f: Frame) => void,
    private readonly onJson: (msg: Record<string, unknown>) => void = () => {},
  ) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size < this.need) return;
    this.need = 0;
    this.drain();
  }

  private peek(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.size)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private consume(n: number): void {
    const b = this.peek();
    const rest = b.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
  }

  private drain(): void {
    for (;;) {
      if (this.size < 2) return;
      const b = this.peek();
      if (b[0] === 0x7b /* { */) {
        const nl = b.indexOf(0x0a);
        if (nl < 0) return;
        const line = b.subarray(0, nl).toString('utf8').trim();
        this.consume(nl + 1);
        try {
          const msg: unknown = JSON.parse(line);
          if (msg && typeof msg === 'object' && !Array.isArray(msg)) this.onJson(msg as Record<string, unknown>);
        } catch {
          /* a broken line: skipped */
        }
        continue;
      }
      if (b.readUInt16BE(0) !== MAGIC) {
        // resync: skip to the next magic or JSON start
        let i = 1;
        while (i < b.length - 1 && b[i] !== 0x7b && b.readUInt16BE(i) !== MAGIC) i++;
        this.consume(i);
        continue;
      }
      if (b.length < NAMED_HEADER_BYTES) return;
      const header = parseHeader(b)!;
      if (header.headerSize < NAMED_HEADER_BYTES || header.length > MAX_PAYLOAD_BYTES) {
        log.warn(`image stream: implausible frame header (header ${header.headerSize} B, payload ${header.length} B): resyncing`);
        this.consume(2);
        continue;
      }
      const total = header.headerSize + header.length;
      if (this.size < total) {
        // a large payload in flight: wait for all of it before joining the chunks again
        this.need = total;
        return;
      }
      const frame = this.peek();
      const payload = Buffer.from(frame.subarray(header.headerSize, total));
      this.consume(total);
      this.onFrame({ header, payload, at: Date.now() });
    }
  }
}

const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The pixel bytes of a raw stack: as sent, or out of the streaming ZIP older firmware wraps them in. */
export function rawStackPixels(payload: Buffer, width: number, height: number): Buffer {
  return framePixels(payload, width * height * 3 * 2, `raw stack of ${payload.length} B is neither ${width}×${height} RGB48 (${width * height * 6} B) nor ZIP`);
}

/** The pixel bytes of a frame: as sent when they are the expected size, else out of the ZIP that wraps them. */
export function framePixels(payload: Buffer, expected: number, what: string): Buffer {
  // size first: the ZIP signature turns up by chance in about one uncompressed frame in a hundred
  if (expected > 0 && payload.length === expected) return payload;
  const at = payload.indexOf(ZIP_LOCAL);
  if (at < 0) throw new Error(what);
  const nameLen = payload.readUInt16LE(at + 26);
  const extraLen = payload.readUInt16LE(at + 28);
  const data = payload.subarray(at + 30 + nameLen + extraLen);
  const out = zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (expected > 0 && out.length < expected) throw new Error(`ZIP frame inflated to ${out.length} B, expected ${expected} B`);
  return expected > 0 ? out.subarray(0, expected) : out;
}

const U16 = 65535;

/**
 * A frame as an image the analysis tools take. Raw data stays linear; a JPEG stack is already stretched.
 * `camera` is left unset: the media layer reads it as a Dwarf lens and would apply the Dwarf plate scale.
 */
export async function frameImage(f: Frame, camera: 'tele' | 'wide'): Promise<FloatImage> {
  const { header: h, payload } = f;
  const source = `seestar:${camera}:${h.imgType === IMG_TYPE.preview ? 'preview' : 'stack'}#${h.imageId}`;
  if (h.imgType === IMG_TYPE.jpegStack) {
    const img = await decode(payload, `${source}.jpg`);
    return { ...img, source, linear: false, capturedAt: f.at };
  }
  if (h.imgType === IMG_TYPE.rawStack) {
    const px = rawStackPixels(payload, h.width, h.height);
    const n = h.width * h.height * 3;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = px.readUInt16LE(i * 2) / U16;
    return { width: h.width, height: h.height, channels: 3, data, linear: true, source, capturedAt: f.at, header: { imageId: h.imageId, hfd: h.hfd } };
  }
  if (h.imgType === IMG_TYPE.preview) {
    // One Bayer sub, debayered 2×2 superpixel to half-resolution colour (both S50 Pro cameras report
    // the GRBG pattern, "GR"): the stills and previews come out in colour, as the app shows them,
    // and the binning keeps star shapes. Position 0 of each cell is G, 1 is R, 2 is B, 3 is G.
    const w = h.width >> 1;
    const ht = h.height >> 1;
    // ZIP-wrapped on an S50 Pro with firmware 9.75 (entry "raw_data")
    const payload = framePixels(f.payload, h.width * h.height * 2, `preview of ${f.payload.length} B is neither ${h.width}×${h.height}×2 nor ZIP`);
    const data = new Float32Array(w * ht * 3);
    for (let y = 0; y < ht; y++) {
      const r0 = 2 * y * h.width;
      const r1 = r0 + h.width;
      for (let x = 0; x < w; x++) {
        const c = 2 * x;
        const o = (y * w + x) * 3;
        data[o] = payload.readUInt16LE((r0 + c + 1) * 2) / U16;
        data[o + 1] = (payload.readUInt16LE((r0 + c) * 2) + payload.readUInt16LE((r1 + c + 1) * 2)) / (2 * U16);
        data[o + 2] = payload.readUInt16LE((r1 + c) * 2) / U16;
      }
    }
    return { width: w, height: ht, channels: 3, data, linear: true, source, capturedAt: f.at, frameWidth: w, header: { imageId: h.imageId, hfd: h.hfd, binned: 2 } };
  }
  throw new Error(`frame type ${h.imgType} carries no image`);
}

export type GrabKind = 'stacked' | 'preview';

const wanted = (kind: GrabKind, t: number) => (kind === 'stacked' ? t === IMG_TYPE.jpegStack || t === IMG_TYPE.rawStack : t === IMG_TYPE.preview);

/**
 * One image socket, opened on demand and closed when idle. Events: 'frame' (Frame) for every image
 * frame (acks dropped), from whichever connection it arrived on.
 *
 * Two ways to get a frame, after what the scope does with each command (S50 Pro, firmware 9.75):
 *
 *   get_stacked_img  - the stack as it stands. Fine to poll. Nothing at all comes back while the
 *                      stack has no frame yet, so the caller checks the stack count first.
 *   get_current_img  - the frame the firmware has CACHED. In a star view that is the one preview it
 *                      kept when the view started (image id 65535): the same pixels come back for
 *                      as long as the view runs, however many exposures the camera has made since.
 *                      A night of "identical HFR every hour" and byte-identical photos came from it.
 *   begin_streaming  - every exposure as it completes, pushed until stop_streaming. This is the
 *                      app's own live view and the only command that yields the frame the camera is
 *                      exposing NOW. A pushed frame is the full 16-bit sub (16.6 MB for the tele
 *                      camera, unwrapped), so streaming is switched on for one frame and off again:
 *                      left on through 1 s exposures it would push 16 MB/s down a tunnel.
 *
 * So a 'preview' grab is begin_streaming → the next pushed frame → stop_streaming, on a connection
 * of its own that is dropped with it: exposures the scope queued behind the stop would otherwise
 * arrive as the next grab's "fresh" frame. Callers that want a frame at the same time share the one
 * being exposed. Stacked grabs use a separate, kept connection, so a live grab finishing never pulls
 * the socket out from under a get_stacked_img that is waiting on it (it did: "closed before a
 * stacked frame came" every time the video reader's grab landed).
 */
export class SeestarImageStream extends SafeEmitter {
  /** the kept connection, for get_stacked_img */
  private sock: net.Socket | null = null;
  private opening: Promise<net.Socket> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  /** the live frame being waited for, shared by everyone who asks for one meanwhile */
  private live: Promise<Frame> | null = null;
  private liveSock: net.Socket | null = null;
  /** stacked grabs waiting on the kept connection */
  private pending = 0;
  last: Frame | null = null;
  /** continuous live streaming (the UI's video): wanted, its socket, and where to say how it goes */
  private streamWanted = false;
  private streamSock: net.Socket | null = null;
  private streamNote: ((note: string | null) => void) | null = null;

  constructor(
    private host: string,
    private port: number,
    readonly camera: 'tele' | 'wide',
    private readonly connectFn: (host: string, port: number) => net.Socket = (h, p) => net.connect({ host: h, port: p }),
  ) {
    super();
  }

  retarget(host: string, port = this.port): void {
    this.host = host;
    this.port = port;
    this.close();
  }

  /**
   * A frame from the scope: the stack as it stands, or the next exposure the camera completes
   * (see above). A preview takes the rest of the running exposure plus the transfer, so the
   * timeout has to cover the exposure length.
   */
  grab(kind: GrabKind, timeoutMs = GRAB_TIMEOUT_MS): Promise<Frame> {
    if (kind === 'stacked') return this.stackedFrame(timeoutMs);
    if (this.live) return this.live;
    // while the live video streams continuously, a preview is simply the next frame it pushes
    const live = (this.streamWanted ? this.nextStreamed(timeoutMs) : this.liveFrame(timeoutMs)).finally(() => {
      if (this.live === live) this.live = null;
    });
    this.live = live;
    return live;
  }

  private async stackedFrame(timeoutMs: number): Promise<Frame> {
    const sock = await this.connect();
    this.pending++;
    this.touch();
    try {
      return await this.request(sock, 'get_stacked_img', 'stacked', timeoutMs);
    } catch (e) {
      // A socket that answered nothing, or died partway through a 50 MB frame, leaves its reader
      // still waiting for the rest of that frame: every later grab on the same socket would then
      // time out as well, which is how one hiccup turned into permanent "no frame". Drop it, so the
      // next request dials a clean socket.
      if (this.sock === sock) this.close();
      throw e;
    } finally {
      this.pending--;
    }
  }

  /** The next preview the live stream pushes. */
  private nextStreamed(timeoutMs: number): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const done = (err: Error | null, f?: Frame) => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        if (err) reject(err);
        else resolve(f!);
      };
      const onFrame = (f: Frame) => wanted('preview', f.header.imgType) && done(null, f);
      const timer = setTimeout(() => done(new Error(`no preview frame from the Seestar's live stream within ${Math.round(timeoutMs / 1000)} s (is a view running, and is the exposure shorter than that?)`)), timeoutMs);
      this.on('frame', onFrame);
    });
  }

  /**
   * Continuous live streaming: begin_streaming on a connection of its own, every exposure the camera
   * completes pushed to the 'frame' event as it arrives, until stopStreaming(). The connection is
   * dialled again whenever it closes while streaming is wanted (the scope closes it when its view
   * ends or is still starting), with a backoff while nothing comes. One such stream per camera.
   */
  startStreaming(onNote: (note: string | null) => void = () => {}): void {
    this.streamNote = onNote;
    if (this.streamWanted) return;
    this.streamWanted = true;
    void this.runStreaming();
  }

  stopStreaming(): void {
    this.streamWanted = false;
    this.streamNote = null;
    this.endStreamSock();
  }

  get streaming(): boolean {
    return this.streamWanted;
  }

  private endStreamSock(): void {
    const sock = this.streamSock;
    this.streamSock = null;
    if (!sock || sock.destroyed) return;
    sock.write(`${JSON.stringify({ id: this.nextId++, method: 'stop_streaming' })}\r\n`, () => sock.end());
    const t = setTimeout(() => sock.destroy(), 2000);
    t.unref?.();
    sock.once('close', () => clearTimeout(t));
  }

  private async runStreaming(): Promise<void> {
    let quiet = 0; // connections in a row that pushed no frame
    while (this.streamWanted) {
      let frames = 0;
      try {
        const sock = await this.dial();
        if (!this.streamWanted) {
          sock.destroy();
          break;
        }
        this.streamSock = sock;
        let silence = setTimeout(() => sock.destroy(new Error(`nothing pushed for ${STREAM_SILENCE_MS / 1000} s`)), STREAM_SILENCE_MS);
        silence.unref?.();
        const onFrame = (f: Frame) => {
          if (!wanted('preview', f.header.imgType)) return;
          frames++;
          quiet = 0;
          this.streamNote?.(null);
          clearTimeout(silence);
          silence = setTimeout(() => sock.destroy(new Error(`nothing pushed for ${STREAM_SILENCE_MS / 1000} s`)), STREAM_SILENCE_MS);
          silence.unref?.();
        };
        this.on('frame', onFrame);
        sock.write(`${JSON.stringify({ id: this.nextId++, method: 'begin_streaming' })}\r\n`);
        await new Promise<void>((resolve) => sock.once('close', () => resolve()));
        clearTimeout(silence);
        this.off('frame', onFrame);
        if (this.streamSock === sock) this.streamSock = null;
      } catch (e) {
        this.streamNote?.(`no live frames: ${errMsg(e)}`);
      }
      if (!this.streamWanted) break;
      if (!frames) quiet++;
      const wait = frames ? EARLY_CLOSE_RETRY_MS : Math.min(EARLY_CLOSE_RETRY_MS * 2 ** quiet, STREAM_MAX_BACKOFF_MS);
      log.info(`image socket ${this.port}: live streaming ended after ${frames} frame(s); dialling again in ${wait / 1000} s`);
      if (!frames) this.streamNote?.(`the ${this.camera} camera pushed no frame on its image socket; asking again in ${wait / 1000} s`);
      await sleep(wait);
    }
  }

  private async liveFrame(timeoutMs: number): Promise<Frame> {
    // The scope closes the image socket on a begin_streaming sent while its view is still starting
    // (the seconds after iscope_start_view): that is not a dead port, so the request is dialled
    // again a moment later, within the caller's time.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      try {
        return await this.liveFrameOnce(left);
      } catch (e) {
        if (!/closed before/.test(errMsg(e)) || deadline - Date.now() < EARLY_CLOSE_RETRY_MS * 3) throw e;
        log.info(`image socket ${this.port}: closed before a frame (the view is starting?); asking again in ${EARLY_CLOSE_RETRY_MS / 1000} s`);
        await new Promise((r) => setTimeout(r, EARLY_CLOSE_RETRY_MS));
      }
    }
  }

  private async liveFrameOnce(timeoutMs: number): Promise<Frame> {
    const sock = await this.dial();
    this.liveSock = sock;
    try {
      return await this.request(sock, 'begin_streaming', 'preview', timeoutMs);
    } finally {
      // stop, and let the connection go with its queue: the next grab dials a fresh one
      if (this.liveSock === sock) this.liveSock = null;
      if (!sock.destroyed) {
        sock.write(`${JSON.stringify({ id: this.nextId++, method: 'stop_streaming' })}\r\n`, () => sock.end());
        const t = setTimeout(() => sock.destroy(), 2000);
        t.unref?.();
        sock.once('close', () => clearTimeout(t));
      }
    }
  }

  /** `method` sent on `sock`, the next `kind` frame (from any connection) resolved. */
  private request(sock: net.Socket, method: 'get_stacked_img' | 'begin_streaming', kind: GrabKind, timeoutMs: number): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const done = (err: Error | null, f?: Frame) => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        sock.off('close', onClose);
        if (err) reject(err);
        else resolve(f!);
      };
      const onFrame = (f: Frame) => wanted(kind, f.header.imgType) && done(null, f);
      const onClose = () => done(new Error(`the image socket ${this.host}:${this.port} closed before a ${kind} frame came`));
      const timer = setTimeout(() => done(new Error(`no ${kind} frame from the Seestar within ${Math.round(timeoutMs / 1000)} s (${kind === 'stacked' ? 'is it stacking?' : 'is a view running, and is the exposure shorter than that?'})`)), timeoutMs);
      this.on('frame', onFrame);
      sock.once('close', onClose);
      sock.write(`${JSON.stringify({ id: this.nextId++, method })}\r\n`);
    });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.heartbeat = this.idleTimer = null;
    this.sock?.destroy();
    this.sock = null;
    this.opening = null;
    this.liveSock?.destroy();
    this.liveSock = null;
    // the live stream's socket goes too; the streaming loop dials again if streaming is still wanted
    this.streamSock?.destroy();
    this.streamSock = null;
  }

  /** Close the kept connection once nobody has used it for a while - never under a waiting grab
   *  (a stacked frame takes longer than the idle time to arrive during a 60 s sub). */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending) this.touch();
      else this.close();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  /** The kept connection, dialled when there is none. */
  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this.opening) return this.opening;
    this.opening = this.dial().then(
      (sock) => {
        this.sock = sock;
        this.opening = null;
        const heartbeat = setInterval(() => sock.write(`${JSON.stringify({ id: this.nextId++, method: 'test_connection' })}\r\n`), HEARTBEAT_MS);
        heartbeat.unref?.();
        this.heartbeat = heartbeat;
        sock.on('close', () => {
          clearInterval(heartbeat);
          if (this.heartbeat === heartbeat) this.heartbeat = null;
          if (this.sock === sock) this.sock = null;
        });
        return sock;
      },
      (e) => {
        this.opening = null;
        throw e;
      },
    );
    return this.opening;
  }

  /** A new connection to the image port, its frames fed to the 'frame' event. */
  private dial(): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const sock = this.connectFn(this.host, this.port);
      sock.setNoDelay?.(true);
      sock.setKeepAlive?.(true, 10_000);
      const reader = new FrameReader((f) => {
        if (f.header.imgType === IMG_TYPE.ack) return;
        this.last = f;
        this.emit('frame', f);
      });
      let up = false;
      const timer = setTimeout(() => sock.destroy(new Error(`no answer from the image socket ${this.host}:${this.port}`)), CONNECT_TIMEOUT_MS);
      sock.on('data', (c: Buffer) => reader.push(c));
      sock.once('connect', () => {
        clearTimeout(timer);
        up = true;
        resolve(sock);
      });
      sock.on('error', (e) => {
        log.debug(`image socket ${this.port}: ${errMsg(e)}`);
        if (!up) {
          clearTimeout(timer);
          reject(new Error(`could not open the Seestar image socket ${this.host}:${this.port}: ${errMsg(e)}`));
        }
      });
    });
  }
}
