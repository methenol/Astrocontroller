/** FITS, PNG and JPEG bytes into a FloatImage, and telling a real frame from a decoder placeholder. */
import sharp from 'sharp';
import { readFits, isFits, superpixel } from '../fits.js';
import { guessCamera, type FloatImage } from './types.js';

/** Panoramas included, no real image comes near this; it keeps a crafted file from exhausting memory. */
const MAX_INPUT_PIXELS = 400_000_000;
/** isFlatJpeg works on a thumbnail this size. */
const FLAT_W = 160;
const FLAT_H = 90;

/**
 * The full scale of FITS data from its largest value: a DWARF 3 writes 12-bit values (0-4095)
 * into 16-bit FITS, and a faint narrowband sub divided by 65535 sat within 0.003 of black (read as
 * a blank frame).
 */
function fitsScale(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > max && data[i] !== Infinity) max = data[i];
  return max > 16383 ? 65535 : max > 4095 ? 16383 : max > 255 ? 4095 : max > 1 ? 255 : 1;
}

/**
 * Physical FITS values into 0..1. Float masters carry NaN/±Inf for dead or masked pixels and go
 * below zero after bias subtraction; left in, they poison every median, the stretch and the JPEG.
 */
function normalized(values: Float32Array, scale: number): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] / scale;
    out[i] = v > 0 ? (v < 1 ? v : 1) : 0; // NaN fails v > 0 and lands at 0
  }
  return out;
}

export async function decode(buf: Buffer, source: string): Promise<FloatImage> {
  const camera = guessCamera(source);
  if (isFits(buf)) {
    const f = readFits(buf);
    const scale = fitsScale(f.data);
    // a frame under 2×2 has no complete Bayer cell: read it as mono rather than as an empty image
    if (f.bayer && f.width >= 2 && f.height >= 2) {
      const sp = superpixel(f);
      return { width: sp.width, height: sp.height, channels: 3, data: normalized(sp.rgb, scale), linear: true, source, camera, header: f.header };
    }
    return { width: f.width, height: f.height, channels: 1, data: normalized(f.data, scale), linear: true, source, camera, header: f.header };
  }
  const meta = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const sixteen = meta.depth === 'ushort';
  const { data, info } = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
    .removeAlpha()
    .toColourspace(sixteen ? 'rgb16' : 'srgb')
    .raw({ depth: sixteen ? 'ushort' : 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  const n = px * info.channels;
  // a Uint16Array view needs an even byte offset; copy when the buffer does not have one
  const src = sixteen ? (data.byteOffset % 2 ? new Uint16Array(Uint8Array.from(data).buffer, 0, n) : new Uint16Array(data.buffer, data.byteOffset, n)) : data;
  const max = sixteen ? 65535 : 255;
  const grey = info.channels === 1;
  const out = new Float32Array(px * 3);
  for (let i = 0, j = 0; i < px; i++, j += info.channels) {
    out[i * 3] = src[j] / max;
    out[i * 3 + 1] = src[grey ? j : j + 1] / max;
    out[i * 3 + 2] = src[grey ? j : j + 2] / max;
  }
  // 16-bit PNGs from the telescope are linear stacks.
  return { width: info.width, height: info.height, channels: 3, data: out, linear: sixteen, source, camera };
}

/**
 * True for frames that aren't a real picture: a blank placeholder (almost no tonal range), or
 * the uniform mid-grey, colourless mush the H.265 decoder emits while references are missing
 * (after motion or at stream start). Dark night-sky frames are not flagged (low mean).
 */
export async function isFlatJpeg(jpeg: Buffer): Promise<boolean> {
  const { data, info } = await sharp(jpeg).resize(FLAT_W, FLAT_H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const ch = info.channels;
  const lum = new Float32Array(n);
  let chroma = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * ch];
    const g = data[i * ch + (ch > 1 ? 1 : 0)];
    const b = data[i * ch + (ch > 2 ? 2 : 0)];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += lum[i];
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  lum.sort();
  const range = lum[Math.floor(n * 0.99)] - lum[Math.floor(n * 0.01)];
  const mean = sum / n;
  if (range < 7) return true; // blank placeholder
  return mean > 90 && mean < 190 && range < 40 && chroma / n < 6; // decoder grey mush
}
