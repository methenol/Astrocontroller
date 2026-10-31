/**
 * The binary picture protocol on the image sockets (4800 tele, 4804 wide).
 *
 * Every picture is an 80-byte header followed by its payload. The header is big-endian:
 *
 *   @0  u16 magic 0x03C3     @2  u16 version      @4  u16 header_size (80)   @6 u32 length
 *   @12 u8 big_endian        @13 u8 img_type      @14 u8 data_type           @15 u8 frame_id
 *   @16 u16 width            @18 u16 height       @20/22/24 u16 hfd x, y, value
 *   @26 u16 can_debayer      @28 u16 image_id (65535 = a live frame)
 *
 * img_type: 0 ack, 1 preview (Bayer GRBG, 16-bit LE, at the camera's bin), 4 JPEG, 5 raw RGB48 stack.
 * Payloads may be ZIP-wrapped (a local file header somewhere in the first bytes). The sockets also
 * carry JSON reply lines (to begin_streaming, get_stacked_img, …) between pictures.
 */
import zlib from 'node:zlib';
import { decode, type FloatImage } from '../../media/images.js';

export const MAGIC = 0x03c3;
export const HEADER_BYTES = 80;
export const LIVE_IMAGE_ID = 65535;
export const IMG_TYPE = { ack: 0, preview: 1, jpegStack: 4, rawStack: 5 } as const;
export const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const MIN_HEADER = 34;
const MAX_PAYLOAD = 200 * 1024 * 1024;
const ZIP_LOCAL = 0x504b0304;

export interface FrameHeader {
  magic: number;
  version: number;
  headerSize: number;
  length: number;
  bigEndian: number;
  imgType: number;
  dataType: number;
  frameId: number;
  width: number;
  height: number;
  hfdX: number;
  hfdY: number;
  hfdValue: number;
  canDebayer: number;
  imageId: number;
}

export interface Frame {
  header: FrameHeader;
  payload: Buffer;
  at: number;
}

export type Camera = 'tele' | 'wide';

export function parseHeader(buf: Buffer): FrameHeader {
  return {
    magic: buf.readUInt16BE(0),
    version: buf.readUInt16BE(2),
    headerSize: buf.readUInt16BE(4),
    length: buf.readUInt32BE(6),
    bigEndian: buf[12]!,
    imgType: buf[13]!,
    dataType: buf[14]!,
    frameId: buf[15]!,
    width: buf.readUInt16BE(16),
    height: buf.readUInt16BE(18),
    hfdX: buf.readUInt16BE(20),
    hfdY: buf.readUInt16BE(22),
    hfdValue: buf.readUInt16BE(24),
    canDebayer: buf.readUInt16BE(26),
    imageId: buf.readUInt16BE(28),
  };
}

export function encodeHeader(h: Partial<FrameHeader> & { length: number; imgType: number }): Buffer {
  const b = Buffer.alloc(h.headerSize ?? HEADER_BYTES);
  b.writeUInt16BE(h.magic ?? MAGIC, 0);
  b.writeUInt16BE(h.version ?? 2, 2);
  b.writeUInt16BE(h.headerSize ?? HEADER_BYTES, 4);
  b.writeUInt32BE(h.length, 6);
  b[12] = h.bigEndian ?? 0;
  b[13] = h.imgType;
  b[14] = h.dataType ?? 3;
  b[15] = h.frameId ?? 0;
  b.writeUInt16BE(h.width ?? 0, 16);
  b.writeUInt16BE(h.height ?? 0, 18);
  b.writeUInt16BE(h.hfdX ?? 0, 20);
  b.writeUInt16BE(h.hfdY ?? 0, 22);
  b.writeUInt16BE(h.hfdValue ?? 0, 24);
  b.writeUInt16BE(h.canDebayer ?? 0, 26);
  b.writeUInt16BE(h.imageId ?? LIVE_IMAGE_ID, 28);
  return b;
}

/** A frame the camera sent on its own, not as the answer to a request. */
export const isLive = (h: FrameHeader): boolean => h.imageId === LIVE_IMAGE_ID || h.imgType === IMG_TYPE.preview;

/** Splits the socket's bytes into pictures and JSON lines, resynchronising on the magic after garbage. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onFrame: (f: Frame) => void,
    private readonly onJson: (line: string) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      if (this.buf[0] === 0x7b) {
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = this.buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        this.buf = this.buf.subarray(nl + 1);
        if (line.trim()) this.onJson(line);
        continue;
      }
      if (this.buf.readUInt16BE(0) !== MAGIC) {
        const next = this.findMagic(1);
        if (next < 0) {
          this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1));
          return;
        }
        this.buf = this.buf.subarray(next);
        continue;
      }
      if (this.buf.length < MIN_HEADER) return;
      const h = parseHeader(this.buf);
      if (h.headerSize < MIN_HEADER || h.length > MAX_PAYLOAD) {
        this.buf = this.buf.subarray(2);
        continue;
      }
      const total = h.headerSize + h.length;
      if (this.buf.length < total) return;
      const payload = Buffer.from(this.buf.subarray(h.headerSize, total));
      this.buf = this.buf.subarray(total);
      this.onFrame({ header: h, payload, at: Date.now() });
    }
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  private findMagic(from: number): number {
    for (let i = from; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 0x03 && this.buf[i + 1] === 0xc3) return i;
      if (this.buf[i] === 0x7b && (i === 0 || this.buf[i - 1] === 0x0a)) return i;
    }
    return -1;
  }
}

/** The payload's pixels: as sent when the size matches, otherwise unwrapped from a ZIP local entry. */
export function framePixels(payload: Buffer, expected: number, what: string): Buffer {
  if (payload.length === expected) return payload;
  const zip = findZipEntry(payload);
  if (zip) {
    const data = payload.subarray(zip.dataAt);
    let out: Buffer;
    try {
      // method 0 is stored; anything else (8, deflate) inflates. A stored entry too short to hold the frame is inflated anyway
      out = zip.method === 0 && data.length >= expected ? data.subarray(0, expected) : zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (err) {
      throw new Error(`${what}: the ZIP payload cannot be inflated (${(err as Error).message})`);
    }
    if (out.length >= expected) return out.subarray(0, expected);
    throw new Error(`${what}: inflated to ${out.length} bytes, expected ${expected}`);
  }
  throw new Error(`${what}: ${payload.length} bytes is neither ${expected} raw bytes nor a ZIP`);
}

function findZipEntry(payload: Buffer): { dataAt: number; method: number } | null {
  const limit = Math.min(payload.length - 30, 4096);
  for (let i = 0; i <= limit; i++) {
    if (payload.readUInt32BE(i) !== ZIP_LOCAL) continue;
    const method = payload.readUInt16LE(i + 8);
    const nameLen = payload.readUInt16LE(i + 26);
    const extraLen = payload.readUInt16LE(i + 28);
    const dataAt = i + 30 + nameLen + extraLen;
    if (dataAt <= payload.length) return { dataAt, method };
  }
  return null;
}

/** A raw RGB48 stack (w×h×3 u16 LE) as a linear float image. */
export function rawStackPixels(payload: Buffer, w: number, h: number, what: string): Float32Array {
  const px = framePixels(payload, w * h * 6, what);
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < out.length; i++) out[i] = px.readUInt16LE(i * 2) / 65535;
  return out;
}

/** A Bayer GRBG preview debayered 2×2 (superpixel) to a half-size linear colour image. */
export function debayerPreview(payload: Buffer, w: number, h: number, what: string): { width: number; height: number; data: Float32Array } {
  const px = framePixels(payload, w * h * 2, what);
  const ow = w >> 1;
  const oh = h >> 1;
  const out = new Float32Array(ow * oh * 3);
  const row = w * 2;
  for (let y = 0; y < oh; y++) {
    const r0 = y * 2 * row;
    const r1 = r0 + row;
    for (let x = 0; x < ow; x++) {
      const c = x * 4;
      const g0 = px.readUInt16LE(r0 + c);
      const r = px.readUInt16LE(r0 + c + 2);
      const b = px.readUInt16LE(r1 + c);
      const g1 = px.readUInt16LE(r1 + c + 2);
      const o = (y * ow + x) * 3;
      out[o] = r / 65535;
      out[o + 1] = (g0 + g1) / 131070;
      out[o + 2] = b / 65535;
    }
  }
  return { width: ow, height: oh, data: out };
}

/** Any picture frame as a FloatImage: a decoded JPEG, a debayered preview, or a raw stack. */
export async function frameImage(f: Frame, camera: Camera): Promise<FloatImage> {
  const h = f.header;
  const kind = h.imgType === IMG_TYPE.preview ? 'preview' : 'stack';
  const source = `seestar:${camera}:${kind}#${h.imageId}`;
  if (f.payload.subarray(0, 2).equals(JPEG_SOI)) {
    const img = await decode(f.payload, source);
    img.capturedAt = f.at;
    img.header = { imageId: h.imageId, hfd: h.hfdValue };
    return img;
  }
  if (h.imgType === IMG_TYPE.rawStack) {
    return {
      width: h.width,
      height: h.height,
      channels: 3,
      data: rawStackPixels(f.payload, h.width, h.height, 'raw stack'),
      linear: true,
      source,
      capturedAt: f.at,
      header: { imageId: h.imageId, hfd: h.hfdValue },
    };
  }
  if (h.imgType === IMG_TYPE.preview) {
    const d = debayerPreview(f.payload, h.width, h.height, 'preview');
    return {
      width: d.width,
      height: d.height,
      channels: 3,
      data: d.data,
      linear: true,
      source,
      capturedAt: f.at,
      frameWidth: h.width,
      header: { imageId: h.imageId, hfd: h.hfdValue, binned: 2 },
    };
  }
  throw new Error(`unknown picture type ${h.imgType} (${f.payload.length} bytes)`);
}
