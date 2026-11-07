/**
 * Sub-length analysis from one light frame and a reference frame, the Deep Sky Detail method
 * (DSD Sub Length Calculator v1.2.0, github.com/deepskydetail/DSD_SubCalc) ported as deterministic
 * arithmetic — the same frames give the same numbers on every run.
 *
 * - Reference (a bias or a dark of the sub's own settings): its level is the offset, its scatter the
 *   read noise — the standard deviation, or MAD × 1.4826 when hot pixels inflate the SD past 2× MAD.
 *   A master of N frames has its read noise averaged down by √N: its scatter × √N is an estimate,
 *   said so. A frame without a reference falls back to the rig's stored read noise.
 * - Light: the background is the channel's pixels within (median − 3 MAD, median + 6 MAD) — stars
 *   and the target's bright structure are above, dead pixels below. Its distribution is fitted with
 *   an exponentially modified Gaussian (mu, sigma, tau) by maximum likelihood (Nelder–Mead on the
 *   negative log-likelihood, started from the method of moments): sigma is the sky's noise through
 *   the sensor, tau the skew that faint nebulosity, gradients and stars' wings add. Broadband frames
 *   take sigma as the sky noise and mu as the sky level; narrowband frames, whose background is
 *   mostly the nebula itself, take √(σ² + τ²) and mu + tau.
 * - Sky noise E1 = √(sky scatter² − read noise²) (gain-independent); E2 = the Poisson noise the
 *   level above the offset implies through e⁻/ADU (a check on the gain and the fit).
 * - The swamp factor is sky noise² / read noise²: how many times the read noise variance the sky
 *   already buries. The minimum sub for a wanted factor scales the measured sub by wanted/measured.
 *   Sub efficiency = sky noise / total noise: the share of the SNR per sub the read noise leaves
 *   (≥ 95% is excellent); the extra integration a lower efficiency costs is 1/efficiency².
 * - The gap factor: the offset-to-background gap in read-noise units (DSD's histogram view).
 *
 * Everything runs on one colour channel: a green phase of the Bayer mosaic by default (the rest of
 * the app's convention), or L (every pixel) / R / G / B as DSD offers.
 */
import type { RawFrame } from './measure.js';
import { greenPhase, pairSigma } from './measure.js';

const MAD_SIGMA = 1.4826;
/** pixels sampled from a channel for its statistics */
const STAT_SAMPLES = 40_000;
/** background pixels the fit runs on (DSD samples 10,000) */
const FIT_SAMPLES = 10_000;
/** DSD's background window around the channel's median, in MADs */
const BG_BELOW_MAD = 3;
const BG_ABOVE_MAD = 6;
/** DSD's sub-efficiency regulariser (ADU²), so a noiseless frame does not divide by zero */
const EFF_EPS = 0.001;
/** a read noise so small the swamp factor is meaningless */
const TINY = 1e-10;
/** DSD's recommendation of the factor: 10 (its slider runs 2–10) */
export const DEFAULT_SWAMP = 10;
/** DSD calls a sub efficiency at or above this excellent */
export const EFFICIENCY_EXCELLENT = 0.95;

export type Channel = 'auto' | 'L' | 'R' | 'G' | 'B';

/** Offsets of a colour's pixels in the 2×2 Bayer cell (DSD's table), read row by row. */
export function bayerOffset(bayer: string | undefined, channel: Exclude<Channel, 'auto' | 'L'>): [number, number] {
  const p = String(bayer ?? 'RGGB').trim().toUpperCase();
  const table: Record<string, Record<'R' | 'G' | 'B', [number, number]>> = {
    RGGB: { R: [0, 0], G: [1, 0], B: [1, 1] },
    BGGR: { R: [1, 1], G: [0, 1], B: [0, 0] },
    GRBG: { R: [1, 0], G: [0, 0], B: [0, 1] },
    GBRG: { R: [0, 1], G: [0, 0], B: [1, 0] },
  };
  return (table[p] ?? table.RGGB)[channel];
}

/** The pixels of one channel, sampled on a fixed stride (deterministic), as a Float64Array. */
export function channelSample(fr: Pick<RawFrame, 'width' | 'height' | 'data' | 'bayer'>, channel: Channel, target = STAT_SAMPLES): Float64Array {
  const all = channel === 'L';
  const [ox, oy] = channel === 'auto' ? greenPhase(fr.bayer) : all ? [0, 0] : bayerOffset(fr.bayer, channel);
  const cellW = all ? 1 : 2;
  const cols = Math.floor((fr.width - ox) / cellW);
  const rows = Math.floor((fr.height - oy) / cellW);
  const cells = cols * rows;
  const stride = Math.max(1, Math.floor(Math.sqrt(cells / target)));
  const out: number[] = [];
  for (let r = 0; r < rows; r += stride) {
    const y = oy + r * cellW;
    for (let c = 0; c < cols; c += stride) out.push(fr.data[y * fr.width + ox + c * cellW]);
  }
  return Float64Array.from(out);
}

const sorted = (xs: ArrayLike<number>) => Float64Array.from(xs).sort();
const medianOfSorted = (s: Float64Array) => (s.length ? (s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2) : NaN);
export const quantileOfSorted = (s: Float64Array, q: number): number => {
  if (!s.length) return NaN;
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

export interface Scatter {
  median: number;
  mean: number;
  /** standard deviation (ddof 1) */
  sd: number;
  /** median absolute deviation × 1.4826 */
  madSigma: number;
  n: number;
}

/** Robust and plain scatter of a sample. */
export function scatter(xs: ArrayLike<number>): Scatter {
  const s = sorted(xs);
  const n = s.length;
  if (!n) return { median: NaN, mean: NaN, sd: NaN, madSigma: NaN, n: 0 };
  const med = medianOfSorted(s);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (s[i] - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  const dev = new Float64Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(s[i] - med);
  const madSigma = medianOfSorted(dev.sort()) * MAD_SIGMA;
  return { median: med, mean, sd, madSigma, n };
}

/** DSD's read-noise rule: the SD, unless hot pixels push it past twice the MAD — then the MAD. */
export function robustNoise(s: Pick<Scatter, 'sd' | 'madSigma'>): { sigma: number; how: 'sd' | 'mad' } {
  return s.sd > 2 * s.madSigma && s.madSigma > 0 ? { sigma: s.madSigma, how: 'mad' } : { sigma: s.sd, how: 'sd' };
}

// ───────── the ex-Gaussian fit ─────────

/** erfc by the Chebyshev fit of Numerical Recipes (fractional error < 1.2e-7 everywhere). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** The standard normal's cumulative distribution. */
export const normalCdf = (z: number): number => 0.5 * erfc(-z / Math.SQRT2);

export interface ExGaussian {
  mu: number;
  sigma: number;
  tau: number;
  /** √(σ² + τ²) */
  totalSd: number;
  converged: boolean;
  iterations: number;
  /** the fit failed and the plain mean/SD stand in (tau 0) */
  fallback: boolean;
  nll: number;
}

/** Method-of-moments start for the ex-Gaussian (DSD's). */
export function exGaussianMoments(xs: ArrayLike<number>): { mu: number; sigma: number; tau: number } {
  const n = xs.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += xs[i];
  m /= n;
  let k2 = 0;
  let k3 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    k2 += d * d;
    k3 += d * d * d;
  }
  k2 /= Math.max(1, n - 1);
  k3 /= Math.max(1, n - 1);
  const sd = Math.sqrt(k2);
  const tau = k3 > 0 ? Math.cbrt(k3 / 2) : 0.8 * sd;
  const sigma = Math.sqrt(Math.abs(k2 - tau * tau));
  return { mu: m - tau, sigma: sigma > 0 ? sigma : sd * 0.5 || 1, tau: tau > 0 ? tau : 1e-3 };
}

/** The negative log-likelihood of the sample under an ex-Gaussian (DSD's form; invalid parameters score 1e50). */
export function exGaussianNll(xs: ArrayLike<number>, mu: number, sigma: number, tau: number): number {
  if (!(sigma > 0) || !(tau > 0) || !Number.isFinite(mu)) return 1e50;
  const c = mu / tau + (sigma * sigma) / (2 * tau * tau);
  const shift = mu + (sigma * sigma) / tau;
  const lnInvTau = -Math.log(tau);
  let nll = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const phi = normalCdf((x - shift) / sigma);
    if (!(phi > 0)) return 1e50;
    // ln d = −ln τ + c − x/τ + ln Φ
    nll -= lnInvTau + c - x / tau + Math.log(phi);
  }
  return Number.isFinite(nll) ? nll : 1e50;
}

export interface NelderMeadResult {
  x: number[];
  fx: number;
  iterations: number;
  converged: boolean;
}

/** Nelder–Mead as SciPy runs it (DSD's optimiser): initial simplex of 5% steps, adaptive to nothing, tolerances on x and f. */
export function nelderMead(f: (x: number[]) => number, x0: number[], o: { maxIter?: number; xatol?: number; fatol?: number } = {}): NelderMeadResult {
  const n = x0.length;
  const maxIter = o.maxIter ?? 2000;
  const xatol = o.xatol ?? 1e-6;
  const fatol = o.fatol ?? 1e-6;
  const simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] = Math.abs(p[i]) > 1e-10 ? p[i] * 1.05 : 0.00025;
    simplex.push(p);
  }
  const fs = simplex.map(f);
  const order = () => {
    const idx = fs.map((_, i) => i).sort((a, b) => fs[a] - fs[b]);
    const s2 = idx.map((i) => simplex[i]);
    const f2 = idx.map((i) => fs[i]);
    for (let i = 0; i <= n; i++) {
      simplex[i] = s2[i];
      fs[i] = f2[i];
    }
  };
  order();
  let it = 0;
  let converged = false;
  while (it < maxIter) {
    let dx = 0;
    for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) dx = Math.max(dx, Math.abs(simplex[i][j] - simplex[0][j]));
    let df = 0;
    for (let i = 1; i <= n; i++) df = Math.max(df, Math.abs(fs[i] - fs[0]));
    if (dx <= xatol && df <= fatol) {
      converged = true;
      break;
    }
    it++;
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const xr = centroid.map((c, j) => 2 * c - worst[j]);
    const fr = f(xr);
    if (fr < fs[0]) {
      const xe = centroid.map((c, j) => 3 * c - 2 * worst[j]);
      const fe = f(xe);
      if (fe < fr) {
        simplex[n] = xe;
        fs[n] = fe;
      } else {
        simplex[n] = xr;
        fs[n] = fr;
      }
    } else if (fr < fs[n - 1]) {
      simplex[n] = xr;
      fs[n] = fr;
    } else {
      // contract toward the centroid, outside when the reflection beat the worst, inside otherwise
      const outside = fr < fs[n];
      const xc = outside ? centroid.map((c, j) => 1.5 * c - 0.5 * worst[j]) : centroid.map((c, j) => 0.5 * c + 0.5 * worst[j]);
      const fc = f(xc);
      if (fc < (outside ? fr : fs[n])) {
        simplex[n] = xc;
        fs[n] = fc;
      } else {
        // shrink toward the best
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          fs[i] = f(simplex[i]);
        }
      }
    }
    order();
  }
  return { x: simplex[0], fx: fs[0], iterations: it, converged };
}

/** Maximum-likelihood ex-Gaussian of a sample; the plain mean/SD when the fit cannot stand. */
export function fitExGaussian(xs: ArrayLike<number>): ExGaussian {
  const n = xs.length;
  if (n < 10) {
    const s = scatter(xs);
    return { mu: s.mean, sigma: s.sd, tau: 0, totalSd: s.sd, converged: false, iterations: 0, fallback: true, nll: NaN };
  }
  const start = exGaussianMoments(xs);
  const r = nelderMead((p) => exGaussianNll(xs, p[0], Math.exp(p[1]), Math.exp(p[2])), [start.mu, Math.log(start.sigma), Math.log(start.tau)]);
  const mu = r.x[0];
  const sigma = Math.exp(r.x[1]);
  const tau = Math.exp(r.x[2]);
  if (!(r.fx < 1e49) || ![mu, sigma, tau].every(Number.isFinite)) {
    const s = scatter(xs);
    return { mu: s.mean, sigma: s.sd, tau: 0, totalSd: s.sd, converged: false, iterations: r.iterations, fallback: true, nll: r.fx };
  }
  return { mu, sigma, tau, totalSd: Math.hypot(sigma, tau), converged: r.converged, iterations: r.iterations, fallback: false, nll: r.fx };
}

// ───────── the reference frame ─────────

export interface CalibrationName {
  kind: 'dark' | 'bias' | 'flat' | 'light' | 'unknown';
  exposureS?: number;
  gain?: number;
  tempC?: number;
  /** frames in the master; 1 for a single exposure */
  stackCount?: number;
}

/**
 * What a calibration file's name says, for the Dwarf's CALI_FRAME files (whose headers say nothing)
 * and the Seestar's MasterDark_<N>_<exp>s_<T>C_<stamp>.fit.
 */
export function calibrationNameInfo(name: string): CalibrationName {
  const base = name.replace(/^.*[\\/]/, '');
  const dwarf = base.match(/^(dark|bias|flat)_(?:exp_([\d.]+)_)?gain_(\d+)_bin_\d+(?:_(-?\d+)C)?(?:_stack_(\d+))?\.fits?$/i);
  if (dwarf) {
    return {
      kind: dwarf[1].toLowerCase() as CalibrationName['kind'],
      exposureS: dwarf[2] !== undefined ? Number(dwarf[2]) : undefined,
      gain: Number(dwarf[3]),
      tempC: dwarf[4] !== undefined ? Number(dwarf[4]) : undefined,
      stackCount: dwarf[5] !== undefined ? Number(dwarf[5]) : undefined,
    };
  }
  const zwo = base.match(/^Master(Dark|Bias|Flat)_(\d+)_([\d.]+)s(?:_(-?[\d.]+)C)?/i);
  if (zwo) return { kind: zwo[1].toLowerCase() as CalibrationName['kind'], stackCount: Number(zwo[2]), exposureS: Number(zwo[3]), tempC: zwo[4] !== undefined ? Number(zwo[4]) : undefined };
  if (/^(Light|Dark|Bias|Flat)_/i.test(base)) return { kind: base.split('_')[0].toLowerCase() as CalibrationName['kind'] };
  if (/dark/i.test(base)) return { kind: 'dark' };
  if (/bias/i.test(base)) return { kind: 'bias' };
  return { kind: 'unknown' };
}

/** A reference frame's exposure, gain and stack count: the header's, else its name's. */
export function referenceInfo(fr: RawFrame): CalibrationName & { fromName: boolean } {
  const n = calibrationNameInfo(fr.name);
  const hdrStack = [fr.header.STACKCNT, fr.header.NCOMBINE].map(Number).find((v) => Number.isFinite(v) && v > 0);
  return {
    kind: n.kind,
    exposureS: fr.exposureS ?? n.exposureS,
    gain: fr.gain ?? n.gain,
    tempC: fr.tempC ?? n.tempC,
    stackCount: hdrStack ?? n.stackCount ?? (fr.master ? undefined : 1),
    fromName: fr.exposureS === undefined || fr.gain === undefined,
  };
}

/** A reference exposure up to this long is a bias: its scatter is read noise, with no dark current in it. */
export const BIAS_MAX_S = 2;

export interface ReferenceNoise {
  /** the offset the light is measured above, ADU (the median level across the frames) */
  levelAdu: number;
  /** the frames' scatter by DSD's rule (SD, or MAD past 2× it), median across frames, ADU */
  scatterAdu: number;
  how: 'sd' | 'mad';
  /**
   * The read noise the frames can vouch for, ADU, and how: a bias (or a sub-2 s dark) gives it by
   * DSD's rule; two or more single darks of one exposure by their pair difference (which cancels the
   * fixed pattern); a long dark or a master cannot (dark current and its pattern are in the scatter),
   * so it is null and the caller falls back to the rig's measured or spec read noise.
   */
  readNoiseAdu: number | null;
  readNoiseHow: 'bias frame (DSD rule)' | 'pair difference of darks (dark-current noise included)' | null;
  exposureS?: number;
  gain?: number;
  /** 1 for single frames; the largest master count otherwise */
  stackCount: number;
  frames: string[];
  warnings: string[];
}

/** The offset (and, when the frames can give it, the read noise) from bias or dark frames of one setting. */
export function referenceNoise(frames: RawFrame[], channel: Channel): ReferenceNoise {
  if (!frames.length) throw new Error('no reference frame');
  const levels: number[] = [];
  const scatters: number[] = [];
  const hows: Array<'sd' | 'mad'> = [];
  const warnings: string[] = [];
  const infos = frames.map(referenceInfo);
  for (const [i, fr] of frames.entries()) {
    const s = scatter(channelSample(fr, channel));
    const r = robustNoise(s);
    levels.push(s.median);
    scatters.push(r.sigma);
    hows.push(r.how);
    if (infos[i].kind === 'light') warnings.push(`${fr.name} is named like a light frame`);
    if (infos[i].stackCount === undefined && fr.master) warnings.push(`${fr.name}: a master of an unknown number of frames`);
  }
  const med = (xs: number[]) => Float64Array.from(xs).sort()[xs.length >> 1];
  const stackCount = Math.max(1, ...infos.map((i) => i.stackCount ?? (frames[infos.indexOf(i)].master ? 2 : 1)));
  const exposures = new Set(infos.map((i) => i.exposureS).filter((e): e is number => e !== undefined));
  const exposureS = exposures.size === 1 ? [...exposures][0] : undefined;
  const singles = frames.filter((_, i) => (infos[i].stackCount ?? (frames[i].master ? 2 : 1)) === 1);
  let readNoiseAdu: number | null = null;
  let readNoiseHow: ReferenceNoise['readNoiseHow'] = null;
  const scatterAdu = med(scatters);
  if (singles.length && (infos.every((i) => i.kind === 'bias') || (exposureS !== undefined && exposureS <= BIAS_MAX_S))) {
    readNoiseAdu = scatterAdu;
    readNoiseHow = 'bias frame (DSD rule)';
  } else if (singles.length >= 2 && exposures.size <= 1) {
    const pairs: number[] = [];
    for (let i = 1; i < singles.length; i++) pairs.push(pairSigma(singles[i - 1], singles[i]));
    readNoiseAdu = med(pairs);
    readNoiseHow = 'pair difference of darks (dark-current noise included)';
  } else if (singles.length === 1 && exposureS !== undefined && exposureS > BIAS_MAX_S) {
    warnings.push(`${singles[0].name}: one dark of ${exposureS} s — its scatter (${scatterAdu.toFixed(1)} ADU) holds dark current and its pattern, not read noise alone; a second dark of the same length, or a bias, would measure it`);
  } else if (!singles.length) {
    warnings.push(`a master of ${stackCount} frames gives the offset only: its scatter is the fixed pattern, not read noise`);
  }
  const gains = new Set(infos.map((i) => i.gain).filter((g): g is number => g !== undefined));
  return {
    levelAdu: med(levels),
    scatterAdu,
    how: hows.filter((h) => h === 'mad').length > hows.length / 2 ? 'mad' : 'sd',
    readNoiseAdu,
    readNoiseHow,
    exposureS,
    gain: gains.size === 1 ? [...gains][0] : undefined,
    stackCount,
    frames: frames.map((f) => f.name),
    warnings,
  };
}

// ───────── the analysis ─────────

export interface SubLengthInput {
  light: RawFrame;
  /** the reference's level and read noise, ADU */
  readNoiseAdu: number;
  levelAdu: number;
  /** e⁻/ADU of the files at this gain */
  ePerAdu: number;
  /** the swamp factor wanted (DSD: 10) */
  swamp?: number;
  /** the light's exposure, s (its header's when absent) */
  durationS?: number;
  channel?: Channel;
  /** a narrowband frame: the background is the nebula, so the skew counts as signal */
  narrowband?: boolean;
}

export interface SubLengthResult {
  frame: string;
  channel: Channel;
  durationS: number;
  narrowband: boolean;
  swampWanted: number;
  reference: { levelAdu: number; readNoiseAdu: number; readNoiseE: number };
  background: {
    /** pixels in the background window, of those sampled */
    pixels: number;
    windowAdu: [number, number];
    median: number;
    madSigma: number;
    /** the sky level the fit gives (mu, or mu + tau for narrowband), ADU */
    levelAdu: number;
    aboveReferenceAdu: number;
    aduPerS: number;
    /** the sky above the offset in electrons per second (through e⁻/ADU) */
    ePerS: number;
  };
  fit: ExGaussian;
  /** E1: from the fitted scatter, gain-independent */
  skyNoiseAdu: number;
  /** E1 read the other way (narrowband ↔ broadband), for a frame whose kind is in doubt */
  skyNoiseOtherReadingAdu: number;
  /** E2: the Poisson noise the level implies through e⁻/ADU */
  skyNoisePoissonAdu: number;
  /** sky noise² / read noise², measured (E1) and by the level (E2) */
  swamp: number;
  swampPoisson: number;
  /** the sub that reaches the wanted factor, s (null: no read noise to swamp) */
  minSubS: number | null;
  minSubPoissonS: number | null;
  /** sky noise / total noise, 0–1 */
  efficiency: number;
  /** 1 / efficiency²: how much longer to integrate for the SNR a read-noise-free sub would give */
  extraIntegration: number;
  /** the offset-to-background gap in read-noise units (DSD's histogram factor) */
  gapFactor: number;
  notes: string[];
}

/** The sub that reaches `swamp` × RN² of sky variance, from a sub whose sky variance was `skyVar`. */
export function minSubFor(swamp: number, readNoiseAdu: number, skyVarAdu2: number, durationS: number): number | null {
  if (skyVarAdu2 < TINY) return null;
  if (readNoiseAdu < TINY) return 0;
  return (swamp * readNoiseAdu ** 2 * durationS) / skyVarAdu2;
}

/** Sub efficiency and its integration cost from sky and read noise (any unit, the same for both). */
export function efficiencyOf(skyNoise: number, readNoise: number): { efficiency: number; extraIntegration: number } {
  const eff = Math.sqrt(EFF_EPS + skyNoise ** 2) / Math.sqrt(EFF_EPS + skyNoise ** 2 + readNoise ** 2);
  return { efficiency: eff, extraIntegration: eff > 0 ? 1 / eff ** 2 : Infinity };
}

/** DSD's analysis of one light frame against a reference. */
export function analyzeSubLength(input: SubLengthInput): SubLengthResult {
  const channel = input.channel ?? 'auto';
  const swamp = input.swamp ?? DEFAULT_SWAMP;
  const fr = input.light;
  const durationS = input.durationS ?? fr.exposureS;
  if (!durationS || !(durationS > 0)) throw new Error(`${fr.name}: no exposure time (EXPTIME) — give duration_s`);
  const rn = input.readNoiseAdu;
  const notes: string[] = [];

  const all = channelSample(fr, channel);
  const s = scatter(all);
  const lo = s.median - BG_BELOW_MAD * s.madSigma;
  const hi = s.median + BG_ABOVE_MAD * s.madSigma;
  const bg: number[] = [];
  for (let i = 0; i < all.length; i++) if (all[i] > lo && all[i] < hi) bg.push(all[i]);
  if (bg.length < 100) throw new Error(`${fr.name}: only ${bg.length} background pixels in the window (${lo.toFixed(1)}–${hi.toFixed(1)} ADU): a flat or clipped frame, not a sky`);
  // the fit runs on an even thinning of the window, DSD's sample size
  const step = Math.max(1, Math.floor(bg.length / FIT_SAMPLES));
  const sample = new Float64Array(Math.ceil(bg.length / step));
  for (let i = 0, j = 0; i < bg.length; i += step, j++) sample[j] = bg[i];
  const fit = fitExGaussian(sample);
  if (fit.fallback) notes.push('the ex-Gaussian fit did not stand: the plain mean and standard deviation are used');
  else if (!fit.converged) notes.push('the fit stopped at its iteration limit');

  const narrowband = !!input.narrowband;
  const level = narrowband ? fit.mu + fit.tau : fit.mu;
  const totalSky = narrowband ? fit.totalSd : fit.sigma;
  const above = level - input.levelAdu;
  if (above <= 0) notes.push(`the background (${level.toFixed(1)} ADU) is not above the reference level (${input.levelAdu.toFixed(1)}): the reference is not this gain's, or the frame is a dark`);
  const skyNoise = Math.sqrt(Math.max(0, totalSky ** 2 - rn ** 2));
  const otherSky = narrowband ? fit.sigma : fit.totalSd;
  if (totalSky <= rn) notes.push('the background scatter is no wider than the read noise: the sky adds nothing measurable at this sub');
  const ePerAdu = input.ePerAdu;
  const skyNoisePoisson = above > 0 && ePerAdu > 0 ? Math.sqrt(above * ePerAdu) / ePerAdu : 0;
  const swampE1 = rn > TINY ? skyNoise ** 2 / rn ** 2 : Infinity;
  const swampE2 = rn > TINY ? skyNoisePoisson ** 2 / rn ** 2 : Infinity;
  const eff = efficiencyOf(skyNoise, rn);
  // the gap: offset + 3 RN up to the 1% quantile of the background (broadband), or offset to the level (narrowband)
  const sortedBg = Float64Array.from(bg).sort();
  const gapLo = narrowband ? input.levelAdu : input.levelAdu + 3 * rn;
  const gapHi = narrowband ? level : quantileOfSorted(sortedBg, 0.01);
  const gapFactor = rn > TINY ? (gapHi - gapLo) / rn : Infinity;
  return {
    frame: fr.name,
    channel,
    durationS,
    narrowband,
    swampWanted: swamp,
    reference: { levelAdu: input.levelAdu, readNoiseAdu: rn, readNoiseE: rn * ePerAdu },
    background: {
      pixels: bg.length,
      windowAdu: [lo, hi],
      median: s.median,
      madSigma: s.madSigma,
      levelAdu: level,
      aboveReferenceAdu: above,
      aduPerS: above / durationS,
      ePerS: (above * ePerAdu) / durationS,
    },
    fit,
    skyNoiseAdu: skyNoise,
    skyNoiseOtherReadingAdu: Math.sqrt(Math.max(0, otherSky ** 2 - rn ** 2)),
    skyNoisePoissonAdu: skyNoisePoisson,
    swamp: swampE1,
    swampPoisson: swampE2,
    minSubS: minSubFor(swamp, rn, skyNoise ** 2, durationS),
    minSubPoissonS: minSubFor(swamp, rn, skyNoisePoisson ** 2, durationS),
    efficiency: eff.efficiency,
    extraIntegration: eff.extraIntegration,
    gapFactor,
    notes,
  };
}

/** The swamp factor a sub of `subS` reaches, from a sub's measured sky variance per second. */
export function swampAt(skyVarAduPerS: number, readNoiseAdu: number, subS: number): number {
  return readNoiseAdu > TINY ? (skyVarAduPerS * subS) / readNoiseAdu ** 2 : Infinity;
}

/** How DSD reads a sub efficiency. */
export function efficiencyVerdict(efficiency: number): string {
  if (efficiency >= EFFICIENCY_EXCELLENT) return 'excellent: the read noise is paid';
  if (efficiency >= 0.9) return 'good: the read noise costs under a quarter more integration';
  if (efficiency >= 0.8) return 'fair: longer subs would save real integration time';
  return 'poor: read-noise limited — the sub is far too short for this sky';
}
