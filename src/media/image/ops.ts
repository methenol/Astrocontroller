/** Pixel operations: crop, luminance, the display stretch, and JPEG encoding. */
import sharp from 'sharp';
import type { Crop, FloatImage } from './types.js';

/** Pixels sampled for the stretch's statistics. */
const STRETCH_SAMPLES = 200_000;

export function percentile(sorted: Float32Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** Every `step`-th value, sorted. */
export function sampleSorted(values: Float32Array, step: number): Float32Array {
  const n = Math.ceil(values.length / step);
  const s = new Float32Array(n);
  for (let i = 0, j = 0; i < values.length; i += step, j++) s[j] = values[i];
  return s.sort();
}

/** Crop by normalized (0..1) or pixel coordinates; the region is clamped to the frame. */
export function crop(img: FloatImage, c: Crop): FloatImage {
  if (![c.x, c.y, c.width, c.height].every(Number.isFinite) || c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0) {
    throw new Error(`crop needs x, y ≥ 0 and width, height > 0 (got ${c.x}, ${c.y}, ${c.width}×${c.height})`);
  }
  const norm = c.x <= 1 && c.y <= 1 && c.width <= 1 && c.height <= 1;
  const x0 = Math.min(img.width - 1, Math.max(0, Math.floor(norm ? c.x * img.width : c.x)));
  const y0 = Math.min(img.height - 1, Math.max(0, Math.floor(norm ? c.y * img.height : c.y)));
  const w = Math.max(1, Math.min(img.width - x0, Math.round(norm ? c.width * img.width : c.width)));
  const h = Math.max(1, Math.min(img.height - y0, Math.round(norm ? c.height * img.height : c.height)));
  const ch = img.channels;
  const data = new Float32Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * img.width + x0) * ch;
    data.set(img.data.subarray(srcStart, srcStart + w * ch), y * w * ch);
  }
  return { ...img, width: w, height: h, data, frameWidth: img.frameWidth ?? img.width, source: `${img.source} [crop ${x0},${y0} ${w}×${h}]` };
}

/** Luminance plane (the data itself for a mono image). */
export function luminance(img: FloatImage): Float32Array {
  if (img.channels === 1) return img.data;
  const n = img.width * img.height;
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = 0.2126 * img.data[i * 3] + 0.7152 * img.data[i * 3 + 1] + 0.0722 * img.data[i * 3 + 2];
  return l;
}

/** Auto-stretch (midtones transfer, per channel, PixInsight-style STF). */
export function autoStretch(img: FloatImage, strength = 1): FloatImage {
  const ch = img.channels;
  const n = img.width * img.height;
  const out = new Float32Array(img.data.length);
  const step = Math.max(1, Math.floor(n / STRETCH_SAMPLES));
  // the MTF solve below needs a target background strictly between 0 and 1
  const targetBg = Math.min(0.95, Math.max(0.01, 0.2 * (Number.isFinite(strength) ? strength : 1)));
  for (let c = 0; c < ch; c++) {
    const plane = new Float32Array(Math.ceil(n / step));
    for (let i = 0, j = 0; i < n; i += step, j++) plane[j] = img.data[i * ch + c];
    plane.sort();
    const med = percentile(plane, 0.5);
    const dev = new Float32Array(plane.length);
    for (let i = 0; i < plane.length; i++) dev[i] = Math.abs(plane[i] - med);
    dev.sort();
    const mad = percentile(dev, 0.5) * 1.4826;
    // a saturated plane (median at 1) would otherwise divide by zero
    const shadows = Math.min(0.999, Math.max(0, med - 2.8 * mad));
    const span = 1 - shadows;
    const mBg = (med - shadows) / span;
    // Solve MTF midtone m so that mtf(mBg) = targetBg.
    const m = mBg <= 0 || mBg >= 1 ? 0.5 : ((targetBg - 1) * mBg) / ((2 * targetBg - 1) * mBg - targetBg);
    for (let i = 0; i < n; i++) {
      const x = Math.min(1, Math.max(0, (img.data[i * ch + c] - shadows) / span));
      out[i * ch + c] = x === 0 ? 0 : x === 1 ? 1 : ((m - 1) * x) / ((2 * m - 1) * x - m);
    }
  }
  return { ...img, data: out, linear: false };
}

/** Encode for the model / browser, fitted inside maxSize. */
export async function toJpeg(img: FloatImage, maxSize = 1280, quality = 85): Promise<Buffer> {
  const bytes = Buffer.alloc(img.data.length);
  for (let i = 0; i < img.data.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, img.data[i])) * 255);
  let s = sharp(bytes, { raw: { width: img.width, height: img.height, channels: img.channels } });
  if (img.width > maxSize || img.height > maxSize) s = s.resize({ width: maxSize, height: maxSize, fit: 'inside', kernel: 'lanczos3' });
  return s.jpeg({ quality, mozjpeg: true }).toBuffer();
}
