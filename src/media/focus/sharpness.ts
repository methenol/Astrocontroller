/**
 * Star sharpness: how tightly starlight is concentrated in a frame.
 *
 * Everything here is flux-weighted, so the number does not move with exposure, gain, cloud
 * brightness, sky glow or the camera's gamma — only with how sharp the stars are.
 *
 * Why half-flux radius and not the Laplacian variance in analyze(): a gradient metric rewards noise
 * and cloud edges and is dominated by whichever part of the frame has the most contrast. A star's
 * flux-weighted radius is a physical measure of its profile: normalised by the star's own flux, so a
 * fainter star, thinner cloud or lower gain does not change it. The reported `score` is 1000 ÷ HFR
 * in arcsec — higher is sharper, and because it is in arcsec it is comparable between a 640-px live
 * frame and a 3840-px still, which pixels are not.
 */
import { crop, imagePlateScale, luminance, type Crop, type FloatImage } from '../images.js';
import { median } from '../../util/stats.js';

export { median };
/** Pixels sampled for the sky map and the global noise. */
const SKY_SAMPLES = 200_000;
const scatter = (a: number[], med: number): number => median(a.map((v) => Math.abs(v - med))) * 1.4826;
export const round = (v: number, d = 3): number => +v.toFixed(d);

/** Inverse sRGB EOTF as a lookup table: 8-bit frames arrive gamma-encoded and flux weighting needs linear light. */
const SRGB_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

// ------------------------------------------------------------------ measurement

/** The centroid is refined at most this many times (it usually settles in two). */
const CENTROID_PASSES = 3;
/** Detections measured at most: the brightest above their local sky, from anywhere in the frame. */
const MAX_SEEDS = 900;
/** Aperture radii the measurement can work with: below, no disc fits; above, the annulus leaves most frames. */
const MIN_APERTURE_PX = 3;
const MAX_APERTURE_PX = 64;

/** Options outside what the measurement can work with are refused, not silently turned into nonsense. */
function checkOptions(o: StarSharpnessOptions): void {
  const bad = (what: string, v: unknown) => {
    throw new Error(`star sharpness: ${what} (got ${String(v)})`);
  };
  if (o.maxStars !== undefined && (!Number.isInteger(o.maxStars) || o.maxStars < 3)) bad('maxStars must be a whole number ≥ 3', o.maxStars);
  if (o.aperturePx !== undefined && (!Number.isFinite(o.aperturePx) || o.aperturePx < MIN_APERTURE_PX || o.aperturePx > MAX_APERTURE_PX)) {
    bad(`aperturePx must be between ${MIN_APERTURE_PX} and ${MAX_APERTURE_PX}`, o.aperturePx);
  }
  if (o.thresholdSigma !== undefined && !(Number.isFinite(o.thresholdSigma) && o.thresholdSigma > 0)) bad('thresholdSigma must be > 0', o.thresholdSigma);
  if (o.minStarSnr !== undefined && !(Number.isFinite(o.minStarSnr) && o.minStarSnr >= 0)) bad('minStarSnr must be ≥ 0', o.minStarSnr);
  if (o.arcsecPerPx !== undefined && !(Number.isFinite(o.arcsecPerPx) && o.arcsecPerPx > 0)) bad('arcsecPerPx must be > 0', o.arcsecPerPx);
}

export interface StarSharpnessOptions {
  /** measure only this region; give every frame of a comparison the same region */
  crop?: Crop;
  /** brightest N stars to average over (default 60) */
  maxStars?: number;
  /** photometric aperture radius; default scales with the frame and widens if the stars overflow it */
  aperturePx?: number;
  /** detection threshold above the local sky in σ (default 5) */
  thresholdSigma?: number;
  /** aperture SNR a star needs to enter the average (default 8) */
  minStarSnr?: number;
  /** override the plate scale (arcsec/px); default comes from the frame's camera and width */
  arcsecPerPx?: number;
}

export interface StarSharpness {
  /** false = `score` is not a usable focus reading; read `blocking` */
  ok: boolean;
  /** why there is no reading */
  blocking?: string;
  /** the focus value: 1000 ÷ median star HFR. Higher = sharper. */
  score: number;
  scoreUnit: string;
  /** median half-flux radius; arcsec is the one to compare across resolutions */
  hfrPx: number;
  hfrArcsec?: number;
  /** 1σ on the median HFR from the scatter between the measured stars */
  hfrUncertaintyPx: number;
  /** Gaussian-equivalent FWHM from the second moments */
  fwhmPx: number;
  fwhmArcsec?: number;
  /** minor/major axis of the star profile; 1 = round, below ~0.7 the number also measures tracking */
  roundness: number;
  /** share of a star's flux inside 1.5 px of its centre; defocus spreads it out */
  concentration: number;
  /** median background-subtracted peak of the measured stars */
  peakMedian: number;
  starsUsed: number;
  starsDetected: number;
  saturatedStars: number;
  aperturePx: number;
  arcsecPerPx?: number;
  background: number;
  noiseSigma: number;
  size: string;
  source: string;
  /** caveats that do not invalidate the reading */
  cautions: string[];
}

interface Star {
  x: number;
  y: number;
  flux: number;
  hfr: number;
  fwhm: number;
  axis: number;
  concentration: number;
  peak: number;
  snr: number;
  clipped: boolean;
}

/**
 * Focus quality from the stars in a frame. Live JPEGs, album stills and FITS subframes all work:
 * the flux-weighted moments are computed in linear light, star by star, against a local sky annulus,
 * so nebula glow, vignetting and the camera's tone curve do not move the result.
 */
export function starSharpness(img: FloatImage, o: StarSharpnessOptions = {}): StarSharpness {
  checkOptions(o);
  const im = o.crop ? crop(img, o.crop) : img;
  const W = im.width;
  const H = im.height;
  const n = W * H;
  // Detection runs on the plain luminance plane: a local maximum is a local maximum in gamma or in
  // linear light, so the expensive linearisation only happens inside the star apertures.
  const lum = luminance(im);
  const cautions: string[] = [];

  // ---- sky map and global noise: strided sample → block medians → 3×3 median filter ----------
  const stride = Math.max(1, Math.floor(Math.sqrt(n / SKY_SAMPLES)));
  const block = Math.min(96, Math.max(48, Math.floor(Math.min(W, H) / 8)));
  const bw = Math.max(1, Math.ceil(W / block));
  const bh = Math.max(1, Math.ceil(H / block));
  const raw = new Float32Array(bw * bh);
  const sky = new Float32Array(bw * bh);
  const cell: number[] = [];
  const resid: number[] = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      cell.length = 0;
      for (let y = by * block; y < Math.min(H, (by + 1) * block); y += stride) {
        for (let x = bx * block; x < Math.min(W, (bx + 1) * block); x += stride) cell.push(lum[y * W + x]);
      }
      const m = median(cell);
      raw[by * bw + bx] = m;
      for (const v of cell) resid.push(v - m);
    }
  }
  // The median filter drops the blocks a bright star or a nebula core sits in.
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      cell.length = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = by + dy;
        const xx = bx + dx;
        if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) cell.push(raw[yy * bw + xx]);
      }
      sky[by * bw + bx] = median(cell);
    }
  }
  resid.sort((a, b) => a - b);
  const pct = (p: number) => resid[Math.min(resid.length - 1, Math.max(0, Math.floor(p * (resid.length - 1))))];
  // Detection runs on the gamma-encoded plane, where one code of an 8-bit frame is 1/255: with a
  // smaller floor every quantisation step of a frame whose sky sits on one code would be a detection.
  const sigma = Math.max(im.linear ? 1e-6 : 1 / 255, scatter(resid, 0));
  const bg = pct(0.5);
  // A crop is pixels of the same sky, so the plate scale comes from the frame it was cut from, never
  // from the crop: the same sky must give the same arcsec reading whichever window you measure.
  const arcsecPerPx = o.arcsecPerPx ?? (img.camera ? imagePlateScale(img, img.camera) : undefined);

  const describe = (over: Partial<StarSharpness>): StarSharpness => ({
    ok: false,
    score: 0,
    scoreUnit: '',
    hfrPx: 0,
    hfrUncertaintyPx: 0,
    fwhmPx: 0,
    roundness: 0,
    concentration: 0,
    peakMedian: 0,
    starsUsed: 0,
    starsDetected: 0,
    saturatedStars: 0,
    aperturePx: 0,
    background: round(bg, 5),
    noiseSigma: round(sigma, 6),
    arcsecPerPx: arcsecPerPx ? round(arcsecPerPx, 3) : undefined,
    size: `${W}×${H}`,
    source: im.source,
    cautions,
    ...over,
  });
  if (W < 48 || H < 48) return describe({ blocking: `the region is too small to measure (${W}×${H})` });
  // A frame with no tonal range at all is a placeholder or a covered lens, not a sky frame. The
  // threshold is an absolute amount of structure, deliberately not a multiple of the noise σ: a
  // badly defocused field has its light spread into broad low-contrast bumps, which pushes the block
  // residuals (that is where σ comes from) up until a σ-multiple threshold calls it blank — exactly
  // the frame the start of a focus sweep begins with.
  const range = pct(0.999) - pct(0.01);
  if (range < (im.linear ? 0.002 : 0.02)) {
    return describe({ blocking: `blank/flat frame: no tonal range (brightest-to-darkest ${round(range, 4)}) — a camera placeholder, a covered lens or a featureless view, not a sky frame` });
  }

  // ---- detection -----------------------------------------------------------------------------
  const k = o.thresholdSigma ?? 5;
  const satLevel = im.linear ? 0.999 : 0.985;
  const chan = im.channels;
  const lin8 = (v: number): number => SRGB_LINEAR[Math.max(0, Math.min(255, Math.round(v * 255)))];
  const linAt = (px: number): number => {
    if (im.linear) return lum[px];
    if (chan === 1) return lin8(im.data[px]);
    const j = px * 3;
    return 0.2126 * lin8(im.data[j]) + 0.7152 * lin8(im.data[j + 1]) + 0.0722 * lin8(im.data[j + 2]);
  };
  const R0 = Math.round(o.aperturePx ?? Math.max(8, Math.min(16, Math.round(Math.min(W, H) / 34))));
  const margin = Math.max(4, Math.ceil(R0 * 2.2));
  let seeds: Array<{ x: number; y: number; above: number }> = [];
  for (let y = margin; y < H - margin; y++) {
    for (let x = margin; x < W - margin; x++) {
      const v = lum[y * W + x];
      const above = v - sky[Math.min(bh - 1, (y / block) | 0) * bw + Math.min(bw - 1, (x / block) | 0)];
      if (above < k * sigma) continue;
      let peak = true;
      // Strict maximum, ties broken by scan order so a clipped flat core counts once.
      for (let dy = -2; dy <= 2 && peak; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const nb = lum[(y + dy) * W + x + dx];
          if (nb > v || (nb === v && (dy < 0 || (dy === 0 && dx < 0)))) {
            peak = false;
            break;
          }
        }
      }
      if (!peak) continue;
      seeds.push({ x, y, above });
      x += 2;
    }
  }
  // A dense field has more peaks than are worth measuring: keep the brightest, wherever they are
  // (stopping the scan at a count would measure only the top of the frame).
  const detected = seeds.length;
  if (seeds.length > MAX_SEEDS) seeds = seeds.sort((a, b) => b.above - a.above).slice(0, MAX_SEEDS);
  if (seeds.length < 3) {
    return describe({
      starsDetected: detected,
      blocking: `only ${detected} point${detected === 1 ? '' : 's'} above ${k}σ of the sky — no usable stars: clouds, dew, daylight, a covered lens, wrong pointing, or an exposure far too short`,
    });
  }

  // ---- per-star photometry --------------------------------------------------------------------
  const measureStar = (x: number, y: number, R: number): Star | null => {
    const outer = Math.max(R + 2, Math.round(R * 2.1));
    // the whole annulus has to be inside the frame, or the local sky and the flux are both wrong
    if (x < outer || y < outer || x >= W - outer || y >= H - outer) return null;
    const ring: number[] = [];
    let satPx = 0;
    for (let dy = -outer; dy <= outer; dy++) {
      for (let dx = -outer; dx <= outer; dx++) {
        const r = Math.hypot(dx, dy);
        if (r >= R * 1.4 && r <= outer) ring.push(linAt((y + dy) * W + x + dx));
        if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2 && lum[(y + dy) * W + x + dx] >= satLevel) satPx++;
      }
    }
    if (ring.length < 12) return null;
    const local = median(ring);
    const ringSigma = Math.max(1e-7, scatter(ring, local));
    // Flux-weighted centroid inside the aperture, refined up to CENTROID_PASSES times.
    let cx = 0;
    let cy = 0;
    let flux = 0;
    for (let pass = 0; pass < CENTROID_PASSES; pass++) {
      let mx = 0;
      let my = 0;
      flux = 0;
      for (let dy = -R; dy <= R; dy++) {
        const dy0 = dy - cy;
        for (let dx = -R; dx <= R; dx++) {
          const dx0 = dx - cx;
          if (dx0 * dx0 + dy0 * dy0 > R * R) continue;
          const f = linAt((y + dy) * W + x + dx) - local;
          if (f <= 0) continue;
          flux += f;
          mx += dx0 * f;
          my += dy0 * f;
        }
      }
      if (flux <= 0) return null;
      const shiftX = mx / flux;
      const shiftY = my / flux;
      cx += shiftX;
      cy += shiftY;
      if (Math.hypot(shiftX, shiftY) < 0.01) break;
    }
    flux = 0;
    let wr = 0;
    let wxx = 0;
    let wyy = 0;
    let wxy = 0;
    let core = 0;
    let peak = 0;
    for (let dy = -R; dy <= R; dy++) {
      const dy0 = dy - cy;
      for (let dx = -R; dx <= R; dx++) {
        const dx0 = dx - cx;
        const r2 = dx0 * dx0 + dy0 * dy0;
        if (r2 > R * R) continue;
        const v = linAt((y + dy) * W + x + dx);
        const f = v - local;
        if (f <= 0) continue;
        const r = Math.sqrt(r2);
        flux += f;
        wr += r * f;
        wxx += dx0 * dx0 * f;
        wyy += dy0 * dy0 * f;
        wxy += dx0 * dy0 * f;
        if (r <= 1.5) core += f;
        if (f > peak) peak = f;
      }
    }
    if (flux <= 0) return null;
    const mxx = wxx / flux;
    const myy = wyy / flux;
    const mxy = wxy / flux;
    const trace = mxx + myy;
    const spread = Math.sqrt(Math.max(0, (mxx - myy) ** 2 + 4 * mxy * mxy));
    const major = Math.max(1e-6, (trace + spread) / 2);
    const minor = Math.max(1e-6, (trace - spread) / 2);
    return {
      x,
      y,
      flux,
      hfr: wr / flux,
      fwhm: 2.3548 * Math.sqrt(trace / 2),
      axis: Math.sqrt(minor / major),
      concentration: core / flux,
      peak,
      snr: flux / (ringSigma * Math.sqrt(Math.PI * R * R)),
      // two neighbouring pixels at the ceiling is a flat core; one can be a single bright pixel
      clipped: satPx >= 2,
    };
  };

  const minSnr = o.minStarSnr ?? 8;
  const pick = (R: number) => {
    const measured: Star[] = [];
    for (const s of seeds) {
      const m = measureStar(s.x, s.y, R);
      if (!m) continue;
      if (m.snr < minSnr) continue;
      if (m.hfr < 0.35) continue; // a hot pixel or a dead-line spike has no disc around it
      measured.push(m);
    }
    measured.sort((a, b) => b.flux - a.flux);
    const kept: Star[] = [];
    const clipped: Star[] = [];
    const cap = o.maxStars ?? 60;
    for (const m of measured) {
      // Isolated stars only: a neighbour inside the aperture contaminates both fluxes.
      const crowds = (q: Star) => Math.hypot(q.x - m.x, q.y - m.y) < 2 * R;
      if (kept.some(crowds) || clipped.some(crowds)) continue;
      if (m.clipped ? clipped.length < cap : kept.length < cap) (m.clipped ? clipped : kept).push(m);
    }
    return { kept, clipped };
  };

  let R = R0;
  let { kept, clipped } = pick(R);
  let saturated = clipped.length;
  if (kept.length < 3 && clipped.length >= 3) {
    kept = clipped;
    clipped = [];
    cautions.push('every star measured has a clipped core: the HFR below is biased small — shorten the exposure before trusting it');
  }
  if (kept.length < 3) {
    return describe({
      starsDetected: detected,
      saturatedStars: clipped.length,
      aperturePx: R,
      blocking: `${detected} detections but only ${kept.length} measurable star${kept.length === 1 ? '' : 's'} (SNR ≥ ${minSnr}, clean core, inside the ${R}px aperture) — no focus reading`,
    });
  }
  // The aperture is sized by the stars, not by the frame: converge onto ~2.6 × the median HFR and
  // re-measure. A rule based on the frame size would give a different number at 640 px than at
  // 3840 px, or in a crop of the same sky, and would bury a sharp frame's disc in sky and noise; this
  // still opens to 32 px when the scope is nowhere near focus.
  for (let pass = 0; pass < 3; pass++) {
    const want = Math.max(5, Math.min(32, Math.ceil(2.6 * median(kept.map((s) => s.hfr)))));
    if (Math.abs(want - R) <= 1.5) break;
    // the aperture reported is the one the kept stars were measured with
    const again = pick(want);
    if (again.kept.length < 3) break;
    R = want;
    kept = again.kept;
    clipped = again.clipped;
    saturated = clipped.length;
  }
  if (R >= 20) cautions.push(`the star discs are wide enough to need a ${R}px aperture: the scope is far from focus, so differences between samples are large`);

  const list = kept.map((s) => s.hfr);
  const hfrPx = median(list);
  const sd = scatter(list, hfrPx);
  const hfrUncertaintyPx = list.length > 2 ? (1.2533 * sd) / Math.sqrt(list.length) : sd;
  const fwhmPx = median(kept.map((s) => s.fwhm));
  const roundness = median(kept.map((s) => s.axis));
  const concentration = median(kept.map((s) => s.concentration));
  const peakMedian = median(kept.map((s) => s.peak));
  const hfrArcsec = arcsecPerPx ? hfrPx * arcsecPerPx : undefined;
  const score = hfrArcsec ? 1000 / hfrArcsec : 1000 / hfrPx;

  if (arcsecPerPx && arcsecPerPx > 3.5) {
    cautions.push(`this frame is ${round(arcsecPerPx, 1)}″/px: star discs are under 2 px wide, so the reading is coarse — measure a full-resolution still for a number you can act on`);
  }
  if (roundness < 0.7) cautions.push(`stars are elongated (axis ratio ${round(roundness, 2)}): the reading mixes tracking/trailing into focus — a shorter exposure separates them`);
  if (clipped.length && clipped.length >= kept.length * 0.25) cautions.push(`${clipped.length} bright stars have clipped cores and were excluded: shorten the exposure to use them`);
  if (hfrUncertaintyPx > 0.08 * hfrPx) cautions.push(`the stars disagree (median HFR ${round(hfrPx, 2)} ± ${round(hfrUncertaintyPx, 2)} px): few bright stars or a noisy frame — do not act on differences smaller than that`);

  return {
    ok: true,
    score: Math.round(score),
    scoreUnit: hfrArcsec ? '1000 ÷ median star HFR in arcseconds' : '1000 ÷ median star HFR in pixels (no plate scale for this frame)',
    hfrPx: round(hfrPx, 2),
    hfrArcsec: hfrArcsec ? round(hfrArcsec, 2) : undefined,
    hfrUncertaintyPx: round(hfrUncertaintyPx, 2),
    fwhmPx: round(fwhmPx, 2),
    fwhmArcsec: arcsecPerPx ? round(fwhmPx * arcsecPerPx, 2) : undefined,
    roundness: round(roundness, 2),
    concentration: round(concentration, 3),
    peakMedian: round(peakMedian, 5),
    starsUsed: kept.length,
    starsDetected: detected,
    saturatedStars: saturated,
    aperturePx: R,
    background: round(bg, 5),
    noiseSigma: round(sigma, 6),
    arcsecPerPx: arcsecPerPx ? round(arcsecPerPx, 3) : undefined,
    size: `${W}×${H}`,
    source: im.source,
    cautions,
  };
}

/** One plain-language line for a reading: what the web UI shows, and what a log line wants. */
export function sharpnessLine(m: StarSharpness): string {
  if (!m.ok) return `no star sharpness reading: ${m.blocking}`;
  const size = m.hfrArcsec ? `${m.hfrPx}px = ${m.hfrArcsec}″` : `${m.hfrPx}px`;
  return `star sharpness ${m.score}: median HFR ${size} ±${m.hfrUncertaintyPx}px from ${m.starsUsed} of ${m.starsDetected} detections${m.cautions.length ? ` · ${m.cautions[0]}` : ''}`;
}
