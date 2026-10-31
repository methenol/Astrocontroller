/** A quantitative look at an image: exposure, focus, star quality, tracking. */
import { luminance, percentile, sampleSorted } from './ops.js';
import { median as middle } from '../../util/stats.js';
import { imagePlateScale, type FloatImage } from './types.js';

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

/** Pixels sampled for the background statistics. */
const STATS_SAMPLES = 400_000;
/** The Laplacian (sharpness) runs on a decimation at most this wide. */
const LAPLACIAN_WIDTH = 1000;
/** At most this many stars are measured (the brightest). */
const MAX_STARS = 4000;
/** Pixels sampled for the per-channel means. */
const COLOR_SAMPLES = 200_000;
/** A pixel at or above this is saturated; at or below CLIPPED_BLACK it is clipped. */
const SATURATED = 0.985;
const CLIPPED_BLACK = 0.002;
/** MAD → σ for Gaussian noise. */
const MAD_TO_SIGMA = 1.4826;
/** A star peaks this many σ above the background. */
const STAR_SIGMA = 6;
/** Radius (px) a star is measured in; peaks are local maxima within ±LOCAL_MAX_PX. */
const STAR_RADIUS = 6;
const LOCAL_MAX_PX = 2;
/** Below this HFR a peak is a hot pixel; a disc with more saturated pixels is not measurable. */
const MIN_HFR = 0.5;
const MAX_SATURATED_PX = 30;
/** The medians use the brightest stars only. */
const MEDIAN_STARS = 200;
const BRIGHTEST_LISTED = 8;
/** Fewer stars than this are not enough to judge focus or tracking. */
const MIN_STARS_TO_JUDGE = 5;
/** Median HFR above this means soft stars; roundness below ROUND_MIN means elongated. */
const SOFT_HFR_PX = 3.5;
const ROUND_MIN = 0.7;
const SATURATED_WARN_PCT = 2;

type Star = { x: number; y: number; hfr: number; peak: number; round: number };

/** Strict local maxima above `thresh`, brightest first; ties are broken by scan order so flat (saturated) cores count once. */
function findPeaks(lum: Float32Array, W: number, H: number, thresh: number, margin: number): Array<{ x: number; y: number; v: number }> {
  const peaks: Array<{ x: number; y: number; v: number }> = [];
  for (let y = margin; y < H - margin; y++) {
    for (let x = margin; x < W - margin; x++) {
      const v = lum[y * W + x];
      if (v < thresh) continue;
      let isMax = true;
      for (let dy = -LOCAL_MAX_PX; dy <= LOCAL_MAX_PX && isMax; dy++) {
        for (let dx = -LOCAL_MAX_PX; dx <= LOCAL_MAX_PX; dx++) {
          if (!dx && !dy) continue;
          const nb = lum[(y + dy) * W + x + dx];
          if (nb > v || (nb === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ x, y, v });
    }
  }
  return peaks.sort((p, q) => q.v - p.v);
}

/** HFR and roundness (from second moments) of the star at a peak, or null for a hot pixel, an extended blob or a saturated disc. */
function measureStar(lum: Float32Array, W: number, x: number, y: number, v: number, background: number): Star | null {
  const R = STAR_RADIUS;
  let flux = 0, rf = 0, mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0, satPx = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const r = Math.hypot(dx, dy);
      if (r > R) continue;
      const p = lum[(y + dy) * W + x + dx];
      if (p >= SATURATED) satPx++;
      const f = Math.max(0, p - background);
      flux += f;
      rf += r * f;
      mx += dx * f;
      my += dy * f;
    }
  }
  if (flux <= 0) return null;
  mx /= flux;
  my /= flux;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    if (Math.hypot(dx, dy) > R) continue;
    const f = Math.max(0, lum[(y + dy) * W + x + dx] - background);
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
  if (hfr < MIN_HFR || hfr > R - MIN_HFR || satPx > MAX_SATURATED_PX) return null;
  return { x, y, hfr, peak: v, round: b / a };
}

/**
 * Stars over the whole frame, brightest first (the first MAX_STARS in scan order would measure
 * only the top of a dense field). A peak within STAR_RADIUS of a star already measured is a
 * secondary peak of that star.
 */
function findStars(lum: Float32Array, W: number, H: number, thresh: number, background: number): Star[] {
  const R = STAR_RADIUS;
  const cols = Math.ceil(W / R) + 2;
  const cellOf = (x: number, y: number) => (Math.floor(y / R) + 1) * cols + Math.floor(x / R) + 1;
  const grid = new Map<number, Array<{ x: number; y: number }>>();
  const insideStar = (x: number, y: number) => {
    const c = cellOf(x, y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (grid.get(c + dy * cols + dx)?.some((s) => Math.abs(s.x - x) <= R && Math.abs(s.y - y) <= R)) return true;
    }
    return false;
  };
  const found: Star[] = [];
  for (const { x, y, v } of findPeaks(lum, W, H, thresh, R)) {
    if (found.length >= MAX_STARS) break;
    if (insideStar(x, y)) continue;
    const star = measureStar(lum, W, x, y, v, background);
    if (!star) continue;
    found.push(star);
    const c = cellOf(x, y);
    const list = grid.get(c);
    if (list) list.push({ x, y });
    else grid.set(c, [{ x, y }]);
  }
  return found;
}

/** Quantitative look at an image: exposure, focus, star quality, tracking. */
/**
 * `plateScaleArcsecPerPx` is the scale of this image's pixels when the caller knows it (a Seestar's
 * optics); without it the lens table of FOV_DEG (the Dwarf's lenses) stands in.
 */
export function analyze(img: FloatImage, cameraHint?: 'tele' | 'wide', plateScaleArcsecPerPx?: number): Analysis {
  const lum = luminance(img);
  const n = lum.length;
  const step = Math.max(1, Math.floor(n / STATS_SAMPLES));
  const sorted = sampleSorted(lum, step);
  const median = percentile(sorted, 0.5);
  const devs = new Float32Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) devs[i] = Math.abs(sorted[i] - median);
  devs.sort();
  // 8-bit sources can't resolve noise below one grey level; without this floor a flat
  // frame (σ≈0) turns every quantisation bump into a "star".
  const sigma = Math.max(img.linear ? 1e-6 : 1.5 / 255, percentile(devs, 0.5) * MAD_TO_SIGMA);
  // Blank: nothing stands out. Linear data (raw subs, stacks) is judged against its own noise,
  // since a faint narrowband sub is legitimately low-contrast; display images by a fixed range.
  const range = percentile(sorted, 0.999) - percentile(sorted, 0.01);
  const flat = img.linear ? range < 10 * sigma : range < 0.025;
  let sum = 0;
  let sat = 0;
  let black = 0;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = lum[i];
    sum += v;
    if (v > max) max = v;
    if (v >= SATURATED) sat++;
    if (v <= CLIPPED_BLACK) black++;
  }
  const mean = sum / n;

  // Sharpness: variance of the Laplacian (on a ≤1000px-wide decimation).
  const dec = Math.max(1, Math.floor(img.width / LAPLACIAN_WIDTH));
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

  // Stars: local maxima above background + 6σ, measured with HFR and moments (none on a blank frame).
  const found = flat ? [] : findStars(lum, img.width, img.height, median + STAR_SIGMA * sigma, median);
  const med = (arr: number[]) => (arr.length ? middle(arr) : undefined);
  const camera = cameraHint ?? img.camera;
  const plate = plateScaleArcsecPerPx ?? (camera ? imagePlateScale(img, camera) : undefined);
  const medHfr = med(found.slice(0, MEDIAN_STARS).map((s) => s.hfr));
  const medRound = med(found.slice(0, MEDIAN_STARS).map((s) => s.round));

  const colorMeans = img.channels === 3 ? (() => {
    let r = 0, g = 0, b = 0;
    const st = Math.max(1, Math.floor(n / COLOR_SAMPLES));
    let k = 0;
    for (let i = 0; i < n; i += st, k++) { r += img.data[i * 3]; g += img.data[i * 3 + 1]; b += img.data[i * 3 + 2]; }
    return { r: +(r / k).toFixed(4), g: +(g / k).toFixed(4), b: +(b / k).toFixed(4) };
  })() : undefined;

  const assessment: string[] = [];
  if (flat) {
    assessment.push('FLAT/BLANK FRAME: almost no tonal variation — a camera placeholder frame, a covered lens, or a featureless view. This is NOT a valid sky/cloud reading; take a still (take_photo or exposure_s) and analyse that instead.');
  }
  const satPct = (sat / n) * 100;
  if (satPct > SATURATED_WARN_PCT) assessment.push(`${satPct.toFixed(1)}% of pixels are saturated — reduce exposure or gain`);
  if (!img.linear && median < 0.03 && satPct < 0.1) assessment.push('image is very dark — increase exposure/gain if this is a daytime or lunar shot');
  if (!img.linear && median > 0.6) assessment.push('background is bright — possible overexposure, twilight, or light pollution');
  if (found.length >= MIN_STARS_TO_JUDGE && medHfr !== undefined) {
    if (medHfr > SOFT_HFR_PX) assessment.push(`stars are soft (median HFR ${medHfr.toFixed(2)} px) — refocus (astro autofocus)`);
    else assessment.push(`stars look focused (median HFR ${medHfr.toFixed(2)} px)`);
    if (medRound !== undefined && medRound < ROUND_MIN) assessment.push(`stars are elongated (roundness ${medRound.toFixed(2)}) — tracking error, wind, or field rotation; shorten exposure`);
  } else if (found.length < MIN_STARS_TO_JUDGE && img.linear) {
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
      max: +max.toFixed(5),
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
      brightest: found.slice(0, BRIGHTEST_LISTED).map((s) => ({ x: s.x, y: s.y, hfr: +s.hfr.toFixed(2), peak: +s.peak.toFixed(3) })),
    },
    assessment,
  };
}
