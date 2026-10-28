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
const CONNECT_TIMEOUT_MS = 8000;
/** close an image socket nobody has used for this long */
const IDLE_CLOSE_MS = 60_000;
/** larger than any frame a Seestar sends (a 4K raw stack is 49.8 MB) */
const MAX_PAYLOAD_BYTES = 200 * 1024 * 1024;

export const IMG_TYPE = { ack: 0, preview: 1, jpegStack: 4, rawStack: 5 } as const;

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
    // one Bayer sub: binned 2×2 to luminance, which needs no knowledge of the pattern and keeps star shapes
    const w = h.width >> 1;
    const ht = h.height >> 1;
    // ZIP-wrapped on an S50 Pro with firmware 9.75 (entry "raw_data")
    const payload = framePixels(f.payload, h.width * h.height * 2, `preview of ${f.payload.length} B is neither ${h.width}×${h.height}×2 nor ZIP`);
    const data = new Float32Array(w * ht);
    for (let y = 0; y < ht; y++) {
      const r0 = 2 * y * h.width;
      const r1 = r0 + h.width;
      for (let x = 0; x < w; x++) {
        const c = 2 * x;
        data[y * w + x] = (payload.readUInt16LE((r0 + c) * 2) + payload.readUInt16LE((r0 + c + 1) * 2) + payload.readUInt16LE((r1 + c) * 2) + payload.readUInt16LE((r1 + c + 1) * 2)) / (4 * U16);
      }
    }
    return { width: w, height: ht, channels: 1, data, linear: true, source, capturedAt: f.at, frameWidth: w, header: { imageId: h.imageId, hfd: h.hfd, binned: 2 } };
  }
  throw new Error(`frame type ${h.imgType} carries no image`);
}

export type GrabKind = 'stacked' | 'preview';

const wanted = (kind: GrabKind, t: number) => (kind === 'stacked' ? t === IMG_TYPE.jpegStack || t === IMG_TYPE.rawStack : t === IMG_TYPE.preview);

/**
 * One image socket, opened on demand and closed when idle. Events: 'frame' (Frame) for every image
 * frame (acks dropped), so a live view can follow begin_streaming.
 */
export class SeestarImageStream extends SafeEmitter {
  private sock: net.Socket | null = null;
  private opening: Promise<net.Socket> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private streaming = false;
  last: Frame | null = null;

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

  /** The next stacked (or preview) frame, requested from the scope. */
  async grab(kind: GrabKind, timeoutMs = GRAB_TIMEOUT_MS): Promise<Frame> {
    const sock = await this.connect();
    this.touch();
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
      const timer = setTimeout(() => done(new Error(`no ${kind} frame from the Seestar within ${Math.round(timeoutMs / 1000)} s (is it viewing or stacking?)`)), timeoutMs);
      this.on('frame', onFrame);
      sock.once('close', onClose);
      this.command(kind === 'stacked' ? 'get_stacked_img' : 'get_current_img');
    });
  }

  /** begin_streaming / stop_streaming: preview frames pushed as 'frame' events. */
  async setStreaming(on: boolean): Promise<void> {
    if (on) {
      await this.connect();
      this.streaming = true;
      this.command('begin_streaming');
    } else if (this.sock) {
      this.command('stop_streaming');
      this.streaming = false;
      this.touch();
    }
  }

  close(): void {
    this.streaming = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.heartbeat = this.idleTimer = null;
    this.sock?.destroy();
    this.sock = null;
    this.opening = null;
  }

  private command(method: string): void {
    this.sock?.write(`${JSON.stringify({ id: this.nextId++, method })}\r\n`);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.streaming) this.close();
      else this.touch();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this.opening) return this.opening;
    this.opening = new Promise<net.Socket>((resolve, reject) => {
      const sock = this.connectFn(this.host, this.port);
      sock.setNoDelay?.(true);
      sock.setKeepAlive?.(true, 10_000);
      const reader = new FrameReader((f) => {
        if (f.header.imgType === IMG_TYPE.ack) return;
        this.last = f;
        this.emit('frame', f);
      });
      const timer = setTimeout(() => sock.destroy(new Error(`no answer from the image socket ${this.host}:${this.port}`)), CONNECT_TIMEOUT_MS);
      sock.on('data', (c: Buffer) => reader.push(c));
      sock.once('connect', () => {
        clearTimeout(timer);
        this.sock = sock;
        this.opening = null;
        this.heartbeat = setInterval(() => this.command('test_connection'), HEARTBEAT_MS);
        this.heartbeat.unref?.();
        resolve(sock);
      });
      sock.on('error', (e) => {
        log.debug(`image socket ${this.port}: ${errMsg(e)}`);
        if (this.opening) {
          clearTimeout(timer);
          this.opening = null;
          reject(new Error(`could not open the Seestar image socket ${this.host}:${this.port}: ${errMsg(e)}`));
        }
      });
      sock.on('close', () => {
        if (this.sock === sock) {
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = null;
          this.sock = null;
        }
      });
    });
    return this.opening;
  }
}
