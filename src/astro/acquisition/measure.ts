/**
 * Measurements from a rig's own raw frames: deterministic statistics, no fitting by eye.
 *
 * Every statistic runs on ONE colour phase of the Bayer mosaic (a green one), so the colour filters
 * do not read as noise, and on robust estimators (median, MAD), so stars, hot pixels and satellite
 * trails do not move them.
 *
 * - Noise of one frame: each pixel minus the mean of its four same-colour neighbours (±2 px); for
 *   white noise that residual has 1.25× the variance, and smooth sky or nebula cancels out. It needs
 *   no second frame, so dithering and drift between subs cannot inflate it (a pair difference can).
 * - Noise of a pair (darks): the difference of two frames / √2, which also cancels fixed pattern.
 * - Conversion gain (photon transfer): a light sub's variance is S/K + RN² in ADU, S the sky level
 *   above black, so K = S / (σ² − RN²) electrons per ADU.
 * - Sky: the 20th percentile of the frame above black (a large nebula fills the median), per second,
 *   through K and the optics to mag/arcsec² (advise.ts's electron model run backwards).
 * - Clip level: the frame's maximum when enough pixels sit on it (saturated star cores).
 */
import { readFits } from '../../media/fits.js';
import { median } from '../../util/stats.js';

/** A green phase of the mosaic: offsets of its pixels in each 2×2 cell. */
export function greenPhase(bayer: string | undefined): [number, number] {
  const p = String(bayer ?? '').trim().toUpperCase();
  // the first G in the 2×2 pattern read row by row: RGGB/BGGR → (1,0), GRBG/GBRG → (0,0)
  if (p === 'RGGB' || p === 'BGGR') return [1, 0];
  return [0, 0];
}

export interface RawFrame {
  name: string;
  width: number;
  height: number;
  data: Float32Array;
  header: Record<string, string | number | boolean>;
  bayer?: string;
  exposureS?: number;
  gain?: number;
  tempC?: number;
  /** when the exposure started (ms), from DATE-OBS (start or end, as the camera writes it) */
  at?: number;
  /** J2000 pointing from the header */
  raHours?: number;
  decDeg?: number;
  filter?: string;
  /** a calibration master, not a single exposure */
  master: boolean;
  /** the camera's own bias offset, when it writes one (ZWO's BIAS card) */
  biasAdu?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A raw FITS frame with what its header says about it. */
export function readRaw(buf: Buffer, name: string): RawFrame {
  const f = readFits(buf);
  if (f.rgb) throw new Error(`${name} is a colour (RGB) image, not a raw sub: measurements need the camera's raw mosaic`);
  const h = f.header;
  const date = str(h['DATE-OBS']);
  const at = date ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(date) ? date : `${date}Z`) : NaN;
  const ra = num(h.RA);
  const type = `${str(h.IMAGETYP) ?? ''} ${name}`.toLowerCase();
  return {
    name,
    width: f.width,
    height: f.height,
    data: f.data,
    header: h,
    bayer: str(h.BAYERPAT) ?? f.bayer,
    exposureS: num(h.EXPTIME) ?? num(h.EXPOSURE),
    gain: num(h.GAIN),
    tempC: num(h['CCD-TEMP']) ?? num(h['DET-TEMP']),
    at: Number.isFinite(at) ? at : undefined,
    // ZWO and DWARFLAB both write RA in degrees
    raHours: ra !== undefined ? ra / 15 : undefined,
    decDeg: num(h.DEC),
    filter: str(h.FILTER),
    master: /master|stack_\d+|_stack|ncombine/.test(type) || num(h.NCOMBINE) !== undefined,
    biasAdu: num(h.BIAS),
  };
}

export interface FrameStats {
  name: string;
  /** green-phase level, ADU */
  median: number;
  /** 20th percentile: the sky between the target's structure */
  p20: number;
  /** single-frame noise, ADU (neighbour residual, star-robust) */
  sigma: number;
  max: number;
  atMax: number;
  /** pixels at or above 98% of the clip level, % of the frame */
  saturatedPct: number;
}

const MAD_SIGMA = 1.4826;
/** var(x − mean of 4 independent neighbours) = 1.25 var(x) */
const NEIGHBOUR_FACTOR = Math.sqrt(1.25);
/** samples per statistic: plenty for a robust median, and fast on a 8 MP frame */
const TARGET_SAMPLES = 120_000;
/** a cadence needs enough gaps that the dithers are the exception */
const CADENCE_MIN_SUBS = 8;
/** photon transfer needs the sky's shot noise to be at least this share of a sub's variance */
const SHOT_SHARE_MIN = 0.5;
/** a sub whose sky sits this far below the cohort's median was clouded or shot with the light path shut */
const OUTLIER_SKY_SHARE = 0.5;
/** a maximum shared by at least this many pixels is the clip level, not one hot pixel */
const CLIP_MIN_PIXELS = 20;

/** Statistics of one frame's green phase (optionally the central `crop` share of it). */
export function frameStats(fr: RawFrame, o: { crop?: number; clipAdu?: number } = {}): FrameStats {
  const [px, py] = greenPhase(fr.bayer);
  const crop = Math.min(1, Math.max(0.1, o.crop ?? 0.9));
  const x0 = Math.floor((fr.width * (1 - crop)) / 4) * 2 + px;
  const y0 = Math.floor((fr.height * (1 - crop)) / 4) * 2 + py;
  const x1 = fr.width - (x0 - px) - 2;
  const y1 = fr.height - (y0 - py) - 2;
  const cells = ((x1 - x0) / 2) * ((y1 - y0) / 2);
  const step = Math.max(1, Math.floor(Math.sqrt(cells / TARGET_SAMPLES))) * 2;
  const w = fr.width;
  const d = fr.data;
  let max = -Infinity;
  let atMax = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (v > max) {
      max = v;
      atMax = 1;
    } else if (v === max) atMax++;
  }
  const clip = o.clipAdu ?? max;
  let sat = 0;
  const levels: number[] = [];
  const resid: number[] = [];
  for (let y = Math.max(y0, 2 + py); y < Math.min(y1, fr.height - 2); y += step) {
    for (let x = Math.max(x0, 2 + px); x < Math.min(x1, w - 2); x += step) {
      const i = y * w + x;
      const c = d[i];
      levels.push(c);
      const n = (d[i - 2 * w] + d[i + 2 * w] + d[i - 2] + d[i + 2]) / 4;
      // a clipped pixel or neighbour says nothing about the noise
      if (c < clip * 0.98 && n < clip * 0.98) resid.push(c - n);
      else sat++;
    }
  }
  levels.sort((a, b) => a - b);
  const rm = median(resid);
  const sigma = (median(resid.map((r) => Math.abs(r - rm))) * MAD_SIGMA) / NEIGHBOUR_FACTOR;
  return {
    name: fr.name,
    median: levels[levels.length >> 1],
    p20: levels[Math.floor(levels.length * 0.2)],
    sigma,
    max,
    atMax,
    saturatedPct: levels.length ? (sat / levels.length) * 100 : 0,
  };
}

/** Noise of the difference of two frames of the same kind, per frame (ADU): read noise for darks. */
export function pairSigma(a: RawFrame, b: RawFrame): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`${a.name} and ${b.name} differ in size`);
  const [px, py] = greenPhase(a.bayer);
  const step = Math.max(2, Math.floor(Math.sqrt((a.width * a.height) / 4 / TARGET_SAMPLES)) * 2);
  const diff: number[] = [];
  for (let y = py; y < a.height; y += step) for (let x = px; x < a.width; x += step) diff.push(a.data[y * a.width + x] - b.data[y * a.width + x]);
  const m = median(diff);
  return (median(diff.map((v) => Math.abs(v - m))) * MAD_SIGMA) / Math.SQRT2;
}

/** The clip level a set of frames shows: the highest maximum that enough pixels share. */
export function clipLevel(stats: FrameStats[]): number | undefined {
  const clipped = stats.filter((s) => s.atMax >= CLIP_MIN_PIXELS).map((s) => s.max);
  return clipped.length ? Math.max(...clipped) : undefined;
}

export interface SensorResult {
  gain: number;
  frames: number;
  /** offset (bias) level, ADU */
  biasAdu: number;
  /** the exposure biasAdu was read at when it could not be separated from the dark current (0: a pure offset) */
  biasAtS: number;
  /** dark signal per second above the bias, ADU/s (null with one exposure and no bias card) */
  darkAduPerS: number | null;
  readNoiseAdu: number | null;
  how: string[];
  warnings: string[];
}

/**
 * Bias, dark current and read noise from dark frames of one gain (the lens covered: a dark-frame
 * filter, a parked Seestar, the Dwarf's ND cap). Two or more single frames of the shortest exposure
 * give the read noise from their pair differences; a second exposure length, or the camera's BIAS
 * card, separates the offset from the dark current. A master gives the levels but no noise.
 */
export function measureSensor(frames: RawFrame[]): SensorResult {
  if (!frames.length) throw new Error('no frames');
  const gains = new Set(frames.map((f) => f.gain).filter((g) => g !== undefined));
  if (gains.size > 1) throw new Error(`the frames are of several gains (${[...gains].join(', ')}): measure one gain at a time`);
  const gain = frames[0].gain ?? NaN;
  const how: string[] = [];
  const warnings: string[] = [];
  const byExp = new Map<number, RawFrame[]>();
  for (const f of frames) {
    if (f.exposureS === undefined) throw new Error(`${f.name} has no EXPTIME/EXPOSURE in its header`);
    byExp.set(f.exposureS, [...(byExp.get(f.exposureS) ?? []), f]);
  }
  const stats = new Map(frames.map((f) => [f, frameStats(f)]));
  const levels = [...byExp.entries()].map(([t, fs]) => ({ t, level: median(fs.map((f) => stats.get(f)!.median)) })).sort((a, b) => a.t - b.t);
  for (const [f, s] of stats) {
    // a dark's level sits a few noise widths above its offset; a lit frame's hundreds
    if (s.sigma > 0 && (s.median - (f.biasAdu ?? s.p20)) / s.sigma > 50) warnings.push(`${f.name} looks lit (level ${Math.round(s.median)} ADU, noise ${Math.round(s.sigma)}): darks need the light path closed`);
  }
  const biasCard = frames.find((f) => f.biasAdu !== undefined)?.biasAdu;
  let biasAdu: number;
  let biasAtS = 0;
  let darkAduPerS: number | null = null;
  if (levels.length >= 2) {
    // a straight line through the levels of each exposure: offset and dark current
    const n = levels.length;
    const mt = levels.reduce((a, l) => a + l.t, 0) / n;
    const ml = levels.reduce((a, l) => a + l.level, 0) / n;
    const slope = levels.reduce((a, l) => a + (l.t - mt) * (l.level - ml), 0) / levels.reduce((a, l) => a + (l.t - mt) ** 2, 0);
    darkAduPerS = Math.max(0, slope);
    biasAdu = ml - darkAduPerS * mt;
    how.push(`offset and dark current from the levels of ${n} exposure lengths (${levels.map((l) => `${l.t}s: ${Math.round(l.level)}`).join(', ')})`);
  } else if (biasCard !== undefined) {
    biasAdu = biasCard;
    darkAduPerS = Math.max(0, (levels[0].level - biasCard) / levels[0].t);
    how.push(`offset from the camera's BIAS card (${biasCard}); dark current from the ${levels[0].t}s level ${Math.round(levels[0].level)}`);
  } else {
    biasAdu = levels[0].level;
    biasAtS = levels[0].t;
    how.push(`one exposure length (${levels[0].t}s) and no BIAS card: its level ${Math.round(biasAdu)} is taken as the black, dark current included`);
  }
  const singles = (byExp.get(levels[0].t) ?? []).filter((f) => !f.master);
  let readNoiseAdu: number | null = null;
  if (singles.length >= 2) {
    const pairs: number[] = [];
    for (let i = 1; i < singles.length; i++) pairs.push(pairSigma(singles[i - 1], singles[i]));
    const total = median(pairs);
    // the dark current's own shot noise rides on it at long exposures, so this is an upper bound there
    readNoiseAdu = total;
    how.push(`read noise from ${pairs.length} pair difference(s) of ${levels[0].t}s frames: ${total.toFixed(2)} ADU${levels[0].t > 2 ? ' (includes the dark current\'s shot noise: an upper bound; 1–2 s darks are cleaner)' : ''}`);
  } else {
    warnings.push('read noise needs two single dark frames of the same exposure (a master averages the noise away)');
  }
  return { gain, frames: frames.length, biasAdu, biasAtS, darkAduPerS, readNoiseAdu, how, warnings };
}

export interface LightResult {
  name: string;
  /** far darker than the cohort (cloud, a closed roof): left out of the cohort's figures */
  outlier: boolean;
  exposureS: number;
  /** sky above black, ADU */
  skyAdu: number;
  sigma: number;
  /** e⁻/ADU from this sub's photon transfer (null when the read noise swamps the sky's) */
  ePerAdu: number | null;
  saturatedPct: number;
}

/** The sky level and conversion gain of each light sub, given the black at its exposure and the read noise. */
export function measureLights(frames: RawFrame[], o: { blackAt: (exposureS: number, f: RawFrame) => number; readNoiseAdu: number; clipAdu?: number }): LightResult[] {
  const out = frames.map((f) => {
    if (f.exposureS === undefined) throw new Error(`${f.name} has no EXPTIME/EXPOSURE in its header`);
    const s = frameStats(f, { clipAdu: o.clipAdu });
    const black = o.blackAt(f.exposureS, f);
    const sky = s.p20 - black;
    // the variance of the median level is what the neighbour residual measured; S is that level above black
    const level = s.median - black;
    const shot = s.sigma ** 2 - o.readNoiseAdu ** 2;
    // only where the sky's own shot noise carries most of the variance: else the read noise and the black decide it
    const ePerAdu = level > 0 && shot > SHOT_SHARE_MIN * s.sigma ** 2 ? level / shot : null;
    return { name: f.name, outlier: false, exposureS: f.exposureS, skyAdu: sky, sigma: s.sigma, ePerAdu, saturatedPct: s.saturatedPct };
  });
  const typical = median(out.map((r) => r.skyAdu / r.exposureS));
  for (const r of out) r.outlier = typical > 0 && r.skyAdu / r.exposureS < OUTLIER_SKY_SHARE * typical;
  return out;
}

/**
 * When each sub was taken, from its file name: both makers stamp it as YYYYMMDD-HHMMSS (the Dwarf adds
 * milliseconds). The stamp is the local time of one end of the exposure, the same end for every sub,
 * which is all a cadence needs.
 */
export function stampOfName(name: string): number | undefined {
  const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})?/);
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? +m[7] : 0);
}

/** How a session's subs follow each other: per-sub overhead and what a dither costs, from their timestamps. */
export function cadence(frames: Array<{ at?: number; exposureS?: number }>): { subs: number; overheadS: number; ditherEvery: number | null; ditherCostS: number | null } | null {
  const ts = frames.filter((f) => f.at !== undefined && f.exposureS !== undefined).sort((a, b) => a.at! - b.at!);
  if (ts.length < CADENCE_MIN_SUBS) return null;
  const t = ts[0].exposureS!;
  const gaps = ts.slice(1).map((f, i) => (f.at! - ts[i].at!) / 1000).filter((g) => g > 0 && g < 10 * t + 600);
  const base = median(gaps);
  const isLong = (g: number) => g > base + Math.max(3, 0.2 * t);
  const long = gaps.filter(isLong);
  // the dither interval is the spacing between the long gaps (a count ratio miscounts the ends)
  const at = gaps.map((g, i) => (isLong(g) ? i : -1)).filter((i) => i >= 0);
  const every = at.length >= 2 ? Math.round(median(at.slice(1).map((i, k) => i - at[k]))) : long.length ? Math.round(gaps.length / long.length) : null;
  return {
    subs: ts.length,
    overheadS: Math.max(0, Math.round((base - t) * 10) / 10),
    ditherEvery: every,
    ditherCostS: long.length ? Math.round(median(long.map((g) => g - base))) : null,
  };
}
