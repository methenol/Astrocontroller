/**
 * Image loading, cropping, stretching and analysis for the agent's vision
 * tools. Everything is normalized into a float image (0..1, 1 or 3 channels).
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { fetchFile } from '../dwarf/http.js';
import { readFits, isFits, superpixel } from './fits.js';
import type { StreamHub } from './streams.js';

export interface FloatImage {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Float32Array; // interleaved, 0..1
  linear: boolean; // raw sensor data that needs a stretch to look right
  source: string;
  camera?: 'tele' | 'wide';
  header?: Record<string, unknown>;
  /** When the pixels were captured (ms epoch), if known. */
  capturedAt?: number;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Plate scale assumptions (full 3840-px sensor width). */
const FOV_DEG = { tele: 2.95, wide: 45.06 };

/** Arcsec per pixel for a frame of this width taken with this lens; the pixel size a star is measured in. */
export const plateScaleArcsecPerPx = (camera: 'tele' | 'wide', widthPx: number): number => (FOV_DEG[camera] * 3600) / widthPx;

function guessCamera(src: string): 'tele' | 'wide' | undefined {
  const s = src.toLowerCase();
  if (s === 'tele' || s.includes('tele') || s.includes('cam_0')) return 'tele';
  if (s === 'wide' || s.includes('wide') || s.includes('cam_1')) return 'wide';
  if (s === 'stack') return 'tele';
  return undefined;
}

export function resolveLocalPath(p: string): string {
  const roots = [config.paths.library, config.paths.captures, config.paths.workspace];
  if (path.isAbsolute(p)) {
    const real = path.resolve(p);
    if (roots.some((r) => real.startsWith(path.resolve(r)))) return real;
    throw new Error(`path ${p} is outside the library/captures/workspace folders`);
  }
  for (const r of roots) {
    const full = path.resolve(r, p);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(`file not found: ${p} (looked in library, captures, workspace)`);
}

/**
 * Load an image from: "tele" | "wide" | "stack" (live), "device:<sd path>"
 * (album files incl. FITS), or a local file under the library/captures.
 */
export async function loadImage(source: string, hub: StreamHub, opts: { fullRes?: boolean; exposureS?: number } = {}): Promise<{ img: FloatImage; encoded?: Buffer }> {
  // One-off long-exposure still: set exposure, shoot, restore — the live view keeps its own setting.
  if ((source === 'tele' || source === 'wide') && opts.exposureS !== undefined) {
    const dwarf = hub.dwarf;
    const cam = hub.get(source) as import('./streams.js').CameraSource;
    // the still stops this camera's live video: tell the stream supervisor, and reconnect it after
    cam.expectPause(opts.exposureS * 1000 + 20000);
    const before = await dwarf.exposureSeconds(source).catch(() => null);
    await dwarf.setSetting(source, 'exposure', String(opts.exposureS));
    try {
      const item = await dwarf.takePhoto(source);
      if (!item) throw new Error(`took a ${opts.exposureS}s ${source} photo but could not find it in the album`);
      const img = await decode(await fetchFile(item.filePath), `${source} still ${opts.exposureS}s (${item.filePath})`);
      img.capturedAt = item.modificationTime * 1000;
      return { img };
    } finally {
      // Back to the previous short exposure, or auto: never leave a long manual exposure on a live camera.
      await dwarf.setSetting(source, 'exposure', before === null || before >= 1 ? 'auto' : String(before)).catch(() => {});
      // the telescope tends to stay silent on the open session after a still: reconnect it now
      setTimeout(() => cam.retryRtsp(), 1500);
    }
  }
  let buf: Buffer;
  let label = source;
  if (source === 'tele' || source === 'wide') {
    const cam = hub.get(source) as import('./streams.js').CameraSource;
    // At long manual exposures there is no live stream: take a real still instead.
    const exp = await hub.dwarf.exposureSeconds(source).catch(() => null);
    if (exp !== null && exp >= 1) {
      const item = await hub.dwarf.takePhoto(source);
      if (!item) throw new Error(`took a ${exp}s ${source} photo but could not find it in the album`);
      const img = await decode(await fetchFile(item.filePath), `${source} still ${exp}s (${item.filePath})`);
      img.capturedAt = item.modificationTime * 1000;
      return { img };
    }
    // Let motion blur settle after the mount moves.
    const settleUntil = hub.lastMotionAt() + 1500;
    if (Date.now() < settleUntil) await new Promise((r) => setTimeout(r, settleUntil - Date.now()));
    // Require a frame captured after the mount settled, never an older cached one.
    const grab = async (maxAge: number, timeout: number) => {
      if (opts.fullRes) return { jpeg: await cam.fullResFrame(), at: Date.now() };
      return cam.snapshot(maxAge, timeout);
    };
    let frame = await grab(Math.max(0, Math.min(3000, Date.now() - settleUntil)), 30000);
    // The live stream occasionally carries flat grey placeholder frames; wait for a real one.
    for (let i = 0; i < 4 && (await isFlatJpeg(frame.jpeg)); i++) frame = await grab(0, 10000);
    const img = await decode(frame.jpeg, source);
    img.capturedAt = frame.at;
    return { img, encoded: frame.jpeg };
  } else if (source === 'stack') {
    const f = await hub.stack.snapshot(15000, 30000);
    const img = await decode(f.jpeg, source);
    img.capturedAt = f.at;
    return { img, encoded: f.jpeg };
  } else if (source.startsWith('device:')) {
    const p = source.slice('device:'.length);
    buf = await fetchFile(p.startsWith('/DWARF3') ? p : `/DWARF3${p.startsWith('/') ? '' : '/'}${p}`);
    label = p;
  } else {
    const full = resolveLocalPath(source);
    buf = fs.readFileSync(full);
    label = full;
  }
  const img = await decode(buf, label);
  return { img, encoded: isFits(buf) ? undefined : buf };
}

export async function decode(buf: Buffer, source: string): Promise<FloatImage> {
  const camera = guessCamera(source);
  if (isFits(buf)) {
    const f = readFits(buf);
    let max = 0;
    for (const v of f.data) if (v > max) max = v;
    // the sensor's real range: a DWARF 3 writes 12-bit values (0-4095) into 16-bit FITS, and a
    // faint narrowband sub divided by 65535 sat within 0.003 of black (read as a blank frame)
    const scale = max > 16383 ? 65535 : max > 4095 ? 16383 : max > 255 ? 4095 : max > 1 ? 255 : 1;
    if (f.bayer) {
      const sp = superpixel(f);
      const data = new Float32Array(sp.rgb.length);
      for (let i = 0; i < data.length; i++) data[i] = sp.rgb[i] / scale;
      return { width: sp.width, height: sp.height, channels: 3, data, linear: true, source, camera, header: f.header };
    }
    const data = new Float32Array(f.data.length);
    for (let i = 0; i < data.length; i++) data[i] = f.data[i] / scale;
    return { width: f.width, height: f.height, channels: 1, data, linear: true, source, camera, header: f.header };
  }
  const meta = await sharp(buf, { limitInputPixels: false }).metadata();
  const sixteen = meta.depth === 'ushort';
  const pipeline = sharp(buf, { limitInputPixels: false }).removeAlpha().toColourspace(sixteen ? 'rgb16' : 'srgb');
  const { data, info } = await pipeline.raw({ depth: sixteen ? 'ushort' : 'uchar' }).toBuffer({ resolveWithObject: true });
  const n = info.width * info.height * info.channels;
  const out = new Float32Array(info.width * info.height * 3);
  const src = sixteen ? new Uint16Array(data.buffer, data.byteOffset, n) : data;
  const max = sixteen ? 65535 : 255;
  for (let i = 0, j = 0; i < info.width * info.height; i++, j += info.channels) {
    const g = info.channels === 1;
    out[i * 3] = src[j] / max;
    out[i * 3 + 1] = src[g ? j : j + 1] / max;
    out[i * 3 + 2] = src[g ? j : j + 2] / max;
  }
  // 16-bit PNGs from the telescope are linear stacks.
  return { width: info.width, height: info.height, channels: 3, data: out, linear: sixteen, source, camera };
}

/** Crop by normalized (0..1) or pixel coordinates. */
export function crop(img: FloatImage, c: Crop): FloatImage {
  const norm = c.x <= 1 && c.y <= 1 && c.width <= 1 && c.height <= 1;
  const x0 = Math.max(0, Math.floor(norm ? c.x * img.width : c.x));
  const y0 = Math.max(0, Math.floor(norm ? c.y * img.height : c.y));
  const w = Math.max(1, Math.min(img.width - x0, Math.round(norm ? c.width * img.width : c.width)));
  const h = Math.max(1, Math.min(img.height - y0, Math.round(norm ? c.height * img.height : c.height)));
  const ch = img.channels;
  const data = new Float32Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * img.width + x0) * ch;
    data.set(img.data.subarray(srcStart, srcStart + w * ch), y * w * ch);
  }
  return { ...img, width: w, height: h, data, source: `${img.source} [crop ${x0},${y0} ${w}×${h}]` };
}

function percentile(sorted: Float32Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

function sampleSorted(values: Float32Array, step: number): Float32Array {
  const n = Math.ceil(values.length / step);
  const s = new Float32Array(n);
  for (let i = 0, j = 0; i < values.length; i += step, j++) s[j] = values[i];
  return s.sort();
}

/** Luminance plane. */
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
  const step = Math.max(1, Math.floor(n / 200000));
  for (let c = 0; c < ch; c++) {
    const plane = new Float32Array(Math.ceil(n / step));
    for (let i = 0, j = 0; i < n; i += step, j++) plane[j] = img.data[i * ch + c];
    plane.sort();
    const med = percentile(plane, 0.5);
    const dev = new Float32Array(plane.length);
    for (let i = 0; i < plane.length; i++) dev[i] = Math.abs(plane[i] - med);
    dev.sort();
    const mad = percentile(dev, 0.5) * 1.4826;
    const shadows = Math.max(0, med - 2.8 * mad);
    const hi = 1;
    const targetBg = 0.2 * strength;
    const mBg = (med - shadows) / (hi - shadows);
    // Solve MTF midtone m so that mtf(mBg) = targetBg.
    const m = mBg <= 0 ? 0.5 : ((targetBg - 1) * mBg) / ((2 * targetBg - 1) * mBg - targetBg);
    for (let i = 0; i < n; i++) {
      let x = (img.data[i * ch + c] - shadows) / (hi - shadows);
      x = Math.min(1, Math.max(0, x));
      out[i * ch + c] = x === 0 ? 0 : x === 1 ? 1 : ((m - 1) * x) / ((2 * m - 1) * x - m);
    }
  }
  return { ...img, data: out, linear: false };
}

/** Encode for the model / browser. */
export async function toJpeg(img: FloatImage, maxSize = 1280, quality = 85): Promise<Buffer> {
  const bytes = Buffer.alloc(img.data.length);
  for (let i = 0; i < img.data.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, img.data[i])) * 255);
  let s = sharp(bytes, { raw: { width: img.width, height: img.height, channels: img.channels } });
  if (img.width > maxSize || img.height > maxSize) s = s.resize({ width: maxSize, height: maxSize, fit: 'inside', kernel: 'lanczos3' });
  return s.jpeg({ quality, mozjpeg: true }).toBuffer();
}

export interface Analysis {
  source: string;
  size: string;
  channels: number;
  linearData: boolean;
  plateScaleArcsecPerPx?: number;
  stats: Record<string, number>;
  colorMeans?: { r: number; g: number; b: number };
  saturatedPercent: number;
  clippedBlackPercent: number;
  sharpness: number;
  stars: {
    count: number;
    medianHfrPx?: number;
    medianFwhmArcsec?: number;
    medianRoundness?: number;
    brightest?: Array<{ x: number; y: number; hfr: number; peak: number }>;
  };
  assessment: string[];
}

/** Quantitative look at an image: exposure, focus, star quality, tracking. */
export function analyze(img: FloatImage, cameraHint?: 'tele' | 'wide'): Analysis {
  const lum = luminance(img);
  const n = lum.length;
  const step = Math.max(1, Math.floor(n / 400000));
  const sorted = sampleSorted(lum, step);
  const median = percentile(sorted, 0.5);
  const devs = new Float32Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) devs[i] = Math.abs(sorted[i] - median);
  devs.sort();
  // 8-bit sources can't resolve noise below one grey level; without this floor a flat
  // frame (σ≈0) turns every quantisation bump into a "star".
  const sigma = Math.max(img.linear ? 1e-6 : 1.5 / 255, percentile(devs, 0.5) * 1.4826);
  // Blank: nothing stands out. Linear data (raw subs, stacks) is judged against its own noise,
  // since a faint narrowband sub is legitimately low-contrast; display images by a fixed range.
  const range = percentile(sorted, 0.999) - percentile(sorted, 0.01);
  const flat = img.linear ? range < 10 * sigma : range < 0.025;
  let sum = 0;
  let sat = 0;
  let black = 0;
  for (let i = 0; i < n; i++) {
    const v = lum[i];
    sum += v;
    if (v >= 0.985) sat++;
    if (v <= 0.002) black++;
  }
  const mean = sum / n;

  // Sharpness: variance of the Laplacian (on a ≤1000px-wide decimation).
  const dec = Math.max(1, Math.floor(img.width / 1000));
  let lapSum = 0;
  let lapSq = 0;
  let lapN = 0;
  for (let y = dec; y < img.height - dec; y += dec) {
    for (let x = dec; x < img.width - dec; x += dec) {
      const c = lum[y * img.width + x];
      const l = lum[y * img.width + x - dec] + lum[y * img.width + x + dec] + lum[(y - dec) * img.width + x] + lum[(y + dec) * img.width + x] - 4 * c;
      lapSum += l;
      lapSq += l * l;
      lapN++;
    }
  }
  const sharpness = lapN ? (lapSq / lapN - (lapSum / lapN) ** 2) * 1e4 : 0;

  // Stars: local maxima above background + 6σ, measured with HFR and moments.
  const thresh = median + 6 * sigma;
  const R = 6;
  const found: Array<{ x: number; y: number; hfr: number; peak: number; round: number }> = [];
  const W = img.width;
  for (let y = R; y < img.height - R && found.length < 4000; y++) {
    for (let x = R; x < W - R; x++) {
      const v = lum[y * W + x];
      if (v < thresh) continue;
      let isMax = true;
      // Strict maximum, with ties broken by scan order so flat (saturated) cores count once.
      for (let dy = -2; dy <= 2 && isMax; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const n = lum[(y + dy) * W + x + dx];
          if (n > v || (n === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      let flux = 0, rf = 0, mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0, satPx = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const r = Math.hypot(dx, dy);
          if (r > R) continue;
          const p = lum[(y + dy) * W + x + dx];
          if (p >= 0.985) satPx++;
          const f = Math.max(0, p - median);
          flux += f;
          rf += r * f;
          mx += dx * f;
          my += dy * f;
        }
      }
      if (flux <= 0) continue;
      mx /= flux;
      my /= flux;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (Math.hypot(dx, dy) > R) continue;
        const f = Math.max(0, lum[(y + dy) * W + x + dx] - median);
        mxx += (dx - mx) ** 2 * f;
        myy += (dy - my) ** 2 * f;
        mxy += (dx - mx) * (dy - my) * f;
      }
      mxx /= flux; myy /= flux; mxy /= flux;
      const tr = mxx + myy;
      const det = Math.sqrt(Math.max(0, (mxx - myy) ** 2 + 4 * mxy * mxy));
      const a = Math.sqrt(Math.max(1e-6, (tr + det) / 2));
      const b = Math.sqrt(Math.max(1e-6, (tr - det) / 2));
      const hfr = rf / flux;
      if (hfr < 0.5 || hfr > R - 0.5 || satPx > 30) continue; // hot pixel, extended blob, or saturated disc
      found.push({ x, y, hfr, peak: v, round: b / a });
      x += R;
    }
  }
  if (flat) found.length = 0; // no real detections on a blank frame
  found.sort((p, q) => q.peak - p.peak);
  const med = (arr: number[]) => (arr.length ? [...arr].sort((p, q) => p - q)[Math.floor(arr.length / 2)] : undefined);
  const camera = cameraHint ?? img.camera;
  const plate = camera ? plateScaleArcsecPerPx(camera, img.width) : undefined;
  const medHfr = med(found.slice(0, 200).map((s) => s.hfr));
  const medRound = med(found.slice(0, 200).map((s) => s.round));

  const colorMeans = img.channels === 3 ? (() => {
    let r = 0, g = 0, b = 0;
    const st = Math.max(1, Math.floor(n / 200000));
    let k = 0;
    for (let i = 0; i < n; i += st, k++) { r += img.data[i * 3]; g += img.data[i * 3 + 1]; b += img.data[i * 3 + 2]; }
    return { r: +(r / k).toFixed(4), g: +(g / k).toFixed(4), b: +(b / k).toFixed(4) };
  })() : undefined;

  const assessment: string[] = [];
  if (flat) {
    assessment.push('FLAT/BLANK FRAME: almost no tonal variation — a camera placeholder frame, a covered lens, or a featureless view. This is NOT a valid sky/cloud reading; take a still (take_photo or exposure_s) and analyse that instead.');
  }
  const satPct = (sat / n) * 100;
  if (satPct > 2) assessment.push(`${satPct.toFixed(1)}% of pixels are saturated — reduce exposure or gain`);
  if (!img.linear && median < 0.03 && satPct < 0.1) assessment.push('image is very dark — increase exposure/gain if this is a daytime or lunar shot');
  if (!img.linear && median > 0.6) assessment.push('background is bright — possible overexposure, twilight, or light pollution');
  if (found.length >= 5 && medHfr !== undefined) {
    if (medHfr > 3.5) assessment.push(`stars are soft (median HFR ${medHfr.toFixed(2)} px) — refocus (astro autofocus)`);
    else assessment.push(`stars look focused (median HFR ${medHfr.toFixed(2)} px)`);
    if (medRound !== undefined && medRound < 0.7) assessment.push(`stars are elongated (roundness ${medRound.toFixed(2)}) — tracking error, wind, or field rotation; shorten exposure`);
  } else if (found.length < 5 && img.linear) {
    assessment.push('few or no stars detected — clouds, dew, obstruction, wrong pointing, or very short exposure');
  }
  return {
    source: img.source,
    size: `${img.width}×${img.height}`,
    channels: img.channels,
    linearData: img.linear,
    plateScaleArcsecPerPx: plate ? +plate.toFixed(2) : undefined,
    stats: {
      mean: +mean.toFixed(5),
      median: +median.toFixed(5),
      noiseSigma: +sigma.toFixed(6),
      p01: +percentile(sorted, 0.01).toFixed(5),
      p99: +percentile(sorted, 0.99).toFixed(5),
      p999: +percentile(sorted, 0.999).toFixed(5),
      max: +sorted[sorted.length - 1].toFixed(5),
      snrBackground: +(median / sigma).toFixed(2),
    },
    colorMeans,
    saturatedPercent: +satPct.toFixed(3),
    clippedBlackPercent: +((black / n) * 100).toFixed(3),
    sharpness: +sharpness.toFixed(3),
    stars: {
      count: found.length,
      medianHfrPx: medHfr !== undefined ? +medHfr.toFixed(2) : undefined,
      medianFwhmArcsec: medHfr !== undefined && plate ? +(medHfr * 2 * plate).toFixed(1) : undefined,
      medianRoundness: medRound !== undefined ? +medRound.toFixed(2) : undefined,
      brightest: found.slice(0, 8).map((s) => ({ x: s.x, y: s.y, hfr: +s.hfr.toFixed(2), peak: +s.peak.toFixed(3) })),
    },
    assessment,
  };
}

/**
 * True for frames that aren't a real picture: a blank placeholder (almost no tonal range), or
 * the uniform mid-grey, colourless mush the H.265 decoder emits while references are missing
 * (after motion or at stream start). Dark night-sky frames are not flagged (low mean).
 */
async function isFlatJpeg(jpeg: Buffer): Promise<boolean> {
  const { data, info } = await sharp(jpeg).resize(160, 90, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const lum: number[] = [];
  let chroma = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    lum.push(0.299 * r + 0.587 * g + 0.114 * b);
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  lum.sort((a, b) => a - b);
  const range = lum[Math.floor(n * 0.99)] - lum[Math.floor(n * 0.01)];
  const mean = lum.reduce((a, b) => a + b, 0) / n;
  if (range < 7) return true; // blank placeholder
  const greyMush = mean > 90 && mean < 190 && range < 40 && chroma / n < 6;
  return greyMush;
}
