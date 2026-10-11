/**
 * Star-based focus for the tele camera.
 *
 * `starSharpness` measures how tightly starlight is concentrated in a frame. Everything it uses is
 * flux-weighted, so the number does not move with exposure, gain, cloud brightness, sky glow or the
 * camera's gamma — only with how sharp the stars are. `starFocusSweep` walks the focuser across a
 * range around a position, scores every step and leaves the focuser on the sharpest one.
 *
 * Why half-flux radius and not the Laplacian variance in analyze(): a gradient metric rewards noise
 * and cloud edges and is dominated by whichever part of the frame has the most contrast. A star's
 * flux-weighted radius is a physical measure of its profile: normalised by the star's own flux, so a
 * fainter star, thinner cloud or lower gain does not change it. The reported `score` is 1000 ÷ HFR
 * in arcsec — higher is sharper, and because it is in arcsec it is comparable between a 640-px live
 * frame and a 3840-px still, which pixels are not.
 */
import { crop, luminance, decode, loadImage, plateScaleArcsecPerPx, type Crop, type FloatImage } from './images.js';
import { fetchFile } from '../dwarf/http.js';
import { logger, errMsg } from '../log.js';
import type { Dwarf } from '../dwarf/device.js';
import type { CameraSource, StreamHub } from './streams.js';

const log = logger('focus');

/** The firmware's focus scale is a three-digit value (manual: "Update Auto Focus Position"). */
const FOCUS_MAX = 1000;

/** One sweep at a time: two of them (the agent and the web UI) fighting over the focuser measure nothing. */
let sweepRunning = false;

const median = (a: number[]): number => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);
const scatter = (a: number[], med: number): number => median(a.map((v) => Math.abs(v - med))) * 1.4826;
const round = (v: number, d = 3): number => +v.toFixed(d);

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
  const im = o.crop ? crop(img, o.crop) : img;
  const W = im.width;
  const H = im.height;
  const n = W * H;
  // Detection runs on the plain luminance plane: a local maximum is a local maximum in gamma or in
  // linear light, so the expensive linearisation only happens inside the star apertures.
  const lum = luminance(im);
  const cautions: string[] = [];

  // ---- sky map and global noise: strided sample → block medians → 3×3 median filter ----------
  const stride = Math.max(1, Math.floor(Math.sqrt(n / 200000)));
  const block = Math.max(24, Math.min(96, Math.max(48, Math.floor(Math.min(W, H) / 8))));
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
  // One code of an 8-bit frame near black is ~0.0003 linear; with no floor every quantisation step
  // in a synthetic-perfect frame would become a detection.
  const sigma = Math.max(im.linear ? 1e-6 : 2e-4, scatter(resid, 0));
  const bg = pct(0.5);
  // A crop is pixels of the same sky, so the plate scale comes from the frame it was cut from, never
  // from the crop: the same sky must give the same arcsec reading whichever window you measure.
  const arcsecPerPx = o.arcsecPerPx ?? (img.camera ? plateScaleArcsecPerPx(img.camera, img.width) : undefined);

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
  const linAt = (px: number): number => {
    if (im.linear) return lum[px];
    if (chan === 1) return SRGB_LINEAR[Math.max(0, Math.min(255, Math.round(im.data[px] * 255)))];
    const j = px * 3;
    return 0.2126 * SRGB_LINEAR[Math.round(im.data[j] * 255)] + 0.7152 * SRGB_LINEAR[Math.round(im.data[j + 1] * 255)] + 0.0722 * SRGB_LINEAR[Math.round(im.data[j + 2] * 255)];
  };
  const R0 = Math.round(o.aperturePx ?? Math.max(8, Math.min(16, Math.round(Math.min(W, H) / 34))));
  const margin = Math.max(4, Math.ceil(R0 * 2.2));
  const seeds: Array<{ x: number; y: number }> = [];
  for (let y = margin; y < H - margin && seeds.length < 900; y++) {
    for (let x = margin; x < W - margin; x++) {
      const v = lum[y * W + x];
      if (v < sky[Math.min(bh - 1, (y / block) | 0) * bw + Math.min(bw - 1, (x / block) | 0)] + k * sigma) continue;
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
      seeds.push({ x, y });
      x += 2;
    }
  }
  if (seeds.length < 3) {
    return describe({
      starsDetected: seeds.length,
      blocking: `only ${seeds.length} point${seeds.length === 1 ? '' : 's'} above ${k}σ of the sky — no usable stars: clouds, dew, daylight, a covered lens, wrong pointing, or an exposure far too short`,
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
    // Flux-weighted centroid inside the aperture, iterated twice.
    let cx = 0;
    let cy = 0;
    let flux = 0;
    for (let pass = 0; pass < 3; pass++) {
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
    // Isolated stars only: a neighbour inside the aperture contaminates both fluxes.
    const kept: Star[] = [];
    const clipped: Star[] = [];
    const cap = o.maxStars ?? 60;
    for (const m of measured) {
      // Isolated stars only: a neighbour inside the aperture contaminates both fluxes.
      if ([...kept, ...clipped].some((q) => Math.hypot(q.x - m.x, q.y - m.y) < 2 * R)) continue;
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
      starsDetected: seeds.length,
      saturatedStars: clipped.length,
      aperturePx: R,
      blocking: `${seeds.length} detections but only ${kept.length} measurable star${kept.length === 1 ? '' : 's'} (SNR ≥ ${minSnr}, clean core, inside the ${R}px aperture) — no focus reading`,
    });
  }
  // The aperture is sized by the stars, not by the frame: converge onto ~2.6 × the median HFR and
  // re-measure. A rule based on the frame size would give a different number at 640 px than at
  // 3840 px, or in a crop of the same sky, and would bury a sharp frame's disc in sky and noise; this
  // still opens to 32 px when the scope is nowhere near focus.
  for (let pass = 0; pass < 3; pass++) {
    const want = Math.max(5, Math.min(32, Math.ceil(2.6 * median(kept.map((s) => s.hfr)))));
    if (Math.abs(want - R) <= 1.5) break;
    R = want;
    const again = pick(R);
    if (again.kept.length < 3) break;
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
    starsDetected: seeds.length,
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

/**
 * One tele frame, measured for focus. Unless the caller names an exposure, the camera goes onto a
 * short one when it is not already on one: a long exposure writes star trails into the reading, and
 * in DSO mode there is no live view to grab anyway. The setting is restored afterwards, so a night's
 * imaging settings survive a focus check.
 */
export async function measureTele(deps: { dwarf: Dwarf; hub: StreamHub }, o: { exposureS?: number; gain?: number; crop?: Crop } = {}): Promise<{ sharp: StarSharpness; img: FloatImage; settings: string }> {
  const { dwarf, hub } = deps;
  const curSecs = await dwarf.exposureSeconds('tele').catch(() => null);
  const want = o.exposureS ?? (curSecs !== null && curSecs <= 1 ? undefined : 0.5);
  let gainBack: number | undefined;
  if (o.gain !== undefined) {
    const cur = ((await dwarf.cameraSettings('tele')).settings.gain as { current?: unknown } | undefined)?.current;
    if (typeof cur === 'number' && cur !== o.gain) {
      await dwarf.setSetting('tele', 'gain', o.gain);
      gainBack = cur;
    }
  }
  try {
    const { img } = await loadImage('tele', hub, { exposureS: want });
    const startedAt = Date.now();
    const sharp = starSharpness(img, { crop: o.crop });
    // Every open web UI sees the last reading, not just the one that asked for it.
    dwarf.publishState({ focusTune: { running: false, action: 'measure', startedAt, finishedAt: startedAt, position: dwarf.state.focusPosition, message: sharpnessLine(sharp) } });
    const settings = `tele ${want !== undefined ? `${want}s` : curSecs !== null ? `${curSecs}s (already set)` : 'auto (unchanged)'}${gainBack !== undefined ? `, gain ${o.gain} (was ${gainBack})` : ''}`;
    return { img, sharp, settings };
  } finally {
    if (gainBack !== undefined) await dwarf.setSetting('tele', 'gain', gainBack).catch((e) => log.warn(`could not restore the tele gain: ${errMsg(e)}`));
  }
}

/** One plain-language line for a reading: what the web UI shows, and what a log line wants. */
export function sharpnessLine(m: StarSharpness): string {
  if (!m.ok) return `no star sharpness reading: ${m.blocking}`;
  const size = m.hfrArcsec ? `${m.hfrPx}px = ${m.hfrArcsec}″` : `${m.hfrPx}px`;
  return `star sharpness ${m.score}: median HFR ${size} ±${m.hfrUncertaintyPx}px from ${m.starsUsed} of ${m.starsDetected} detections${m.cautions.length ? ` · ${m.cautions[0]}` : ''}`;
}

// ------------------------------------------------------------------ sweep

export interface FocusSweepOptions {
  /** position to centre the sweep on (default the focuser's current position) */
  center?: number;
  /** focus units to cover on each side of the centre (default 30) */
  range?: number;
  /** focus units between samples (default 5) */
  step?: number;
  /** explicit positions instead of centre ± range */
  positions?: number[];
  /** exposure for the measurement stills; default the camera's current one when ≤ 1 s, else 0.5 s */
  exposureS?: number;
  /** gain for the measurement stills; default unchanged */
  gain?: number;
  /** measure only this region of every frame */
  crop?: Crop;
  /** frames averaged (median HFR) per position, 1-3 (default 1) */
  repeats?: number;
  /** leave the focuser on the sharpest position (default true); false puts it back at the centre the sweep was run around */
  apply?: boolean;
  /** refine between samples by fitting the curve around the minimum (default true) */
  refine?: boolean;
  /** settling after each move, ms (default 700) */
  settleMs?: number;
  /** hard cap on the number of samples (default 25) */
  maxPoints?: number;
  /** give up and use what has been measured after this long (default 15 min) */
  deadlineMs?: number;
  onProgress?: (sample: FocusSample, index: number, total: number) => void;
}

export interface FocusSample {
  position: number;
  score: number;
  hfrPx: number;
  hfrArcsec?: number;
  arcsecPerPx?: number;
  hfrUncertaintyPx: number;
  stars: number;
  saturated: number;
  seconds: number;
  error?: string;
  cautions?: string[];
}

export interface FocusSweepResult {
  start: FocusSample;
  samples: FocusSample[];
  best: FocusSample;
  /** where the focuser was left, and what it measures there now */
  finalPosition: number;
  final?: FocusSample;
  fittedPosition?: number;
  /** the sharpest sample was the first or last one: the optimum may lie outside the range swept */
  bestAtEdge: boolean;
  /** percent the median HFR tightened from the start sample to the best one (negative = it grew) */
  improvementPct: number;
  verdict: string;
  notes: string[];
  settings: string;
  elapsedS: number;
  arcsecPerPx?: number;
  /** the verification frame at the final position, for the caller to show */
  finalImage?: FloatImage;
}

/** Positions to sample, alternating outward from the centre so slow thermal drift is symmetric. */
function sweepPositions(center: number, o: FocusSweepOptions): { positions: number[]; notes: string[] } {
  const notes: string[] = [];
  const clamp = (p: number) => (p < 0 || p > FOCUS_MAX ? null : Math.round(p));
  if (o.positions?.length) {
    const out: number[] = [];
    for (const p of o.positions) {
      const c = clamp(Number(p));
      if (c === null) notes.push(`position ${p} dropped (the focus scale runs 0-${FOCUS_MAX})`);
      else if (!out.includes(c)) out.push(c);
    }
    out.sort((a, b) => a - b);
    return { positions: out, notes };
  }
  const maxPoints = o.maxPoints ?? 25;
  let step = Math.max(1, Math.round(o.step ?? 5));
  const range = Math.max(step, Math.round(o.range ?? 30));
  const maxSteps = Math.max(1, Math.floor((maxPoints - 1) / 2));
  if (Math.ceil(range / step) > maxSteps) {
    const widened = Math.ceil(range / maxSteps);
    notes.push(`step widened from ${step} to ${widened} to keep the sweep under ${maxPoints} samples`);
    step = widened;
  }
  const positions = [Math.round(center)];
  for (let d = step; d <= range + 0.5; d += step) {
    for (const p of [center - d, center + d]) {
      const c = clamp(p);
      if (c !== null && !positions.includes(c)) positions.push(c);
    }
  }
  return { positions, notes };
}

/**
 * Vertex of the parabola through the three samples around the sharpest one. Returns null unless the
 * middle sample is a strict minimum and the vertex falls between its neighbours.
 */
function fitMinimum(samples: FocusSample[], bestIndex: number): number | null {
  const lo = samples[bestIndex - 1];
  const mid = samples[bestIndex];
  const hi = samples[bestIndex + 1];
  if (!lo || !hi || lo.error || mid.error || hi.error) return null;
  if (!(mid.hfrPx < lo.hfrPx && mid.hfrPx < hi.hfrPx)) return null;
  const denom = lo.hfrPx - 2 * mid.hfrPx + hi.hfrPx;
  if (!(denom > 0)) return null;
  const d = (lo.hfrPx - hi.hfrPx) / (2 * denom);
  if (!Number.isFinite(d) || Math.abs(d) > 1) return null;
  const v = mid.position + d * ((hi.position - lo.position) / 2);
  return v > lo.position && v < hi.position ? v : null;
}

/**
 * Sweep the focuser around a position, score the stars at every step, and end on the sharpest.
 * The camera is put back the way it was found (exposure and gain), the focuser is left either on the
 * best position (`apply`, the default) or back at the centre it was swept around.
 */
export async function starFocusSweep(deps: { dwarf: Dwarf; hub: StreamHub }, o: FocusSweepOptions = {}): Promise<FocusSweepResult> {
  const { dwarf } = deps;
  if (sweepRunning) throw new Error('a star-focus sweep is already running (the agent or the web UI started one); wait for it to finish');
  const busy = dwarf.isBusy();
  if (busy) throw new Error(`refusing to sweep focus while ${busy} is running — stop it first (a refocus takes the tele camera out of a stack)`);
  dwarf.assertNoNdLock('a star-focus sweep');
  sweepRunning = true;
  try {
    return await dwarf.exclusive('sweeping focus', () => sweep(deps, o));
  } finally {
    sweepRunning = false;
  }
}

async function sweep(deps: { dwarf: Dwarf; hub: StreamHub }, o: FocusSweepOptions): Promise<FocusSweepResult> {
  const { dwarf, hub } = deps;
  const startedAt = Date.now();
  const notes: string[] = [];

  await dwarf.refreshState().catch(() => {});
  let center = o.center ?? dwarf.state.focusPosition;
  if (center === undefined) {
    const inf = await dwarf.infinityFocusPosition().catch(() => null);
    if (inf === null) throw new Error('the focuser position is unknown (nothing has reported it — is the telescope connected?) and the stored infinity position did not answer either: press Connect in the web UI, or run focus_position action=get first');
    center = inf;
    notes.push(`focuser position was unknown: swept around the stored infinity position ${inf}`);
  }
  const { positions, notes: posNotes } = sweepPositions(center, o);
  notes.push(...posNotes);
  if (positions.length < 3) throw new Error(`only ${positions.length} position(s) to sample — nothing to compare; give a wider range or more positions`);

  // The same exposure and gain for every sample, or the samples do not measure the same thing.
  const settings = await dwarf.cameraSettings('tele');
  const expLabel = String((settings.settings.exposure as { current?: unknown } | undefined)?.current ?? '');
  const gainNow = (settings.settings.gain as { current?: unknown } | undefined)?.current;
  // exposureSeconds decodes the device's own live value: null = auto or unreported.
  const curSecs = await dwarf.exposureSeconds('tele').catch(() => null);
  const wantExp = o.exposureS ?? (curSecs !== null && curSecs <= 1 ? null : 0.5);
  let exposureSet = false;
  if (wantExp !== null && (curSecs === null || Math.abs(curSecs - wantExp) > 0.01)) {
    await dwarf.setSetting('tele', 'exposure', wantExp);
    exposureSet = true;
  }
  const effExp = wantExp ?? curSecs ?? null;
  let gainSet = false;
  if (o.gain !== undefined && Number(gainNow) !== o.gain) {
    await dwarf.setSetting('tele', 'gain', o.gain);
    gainSet = true;
  }
  // Hand the camera back exactly what it reported, label and all: whatever it was on is the imaging
  // setting, and a long manual exposure must not come back as auto. Nothing to restore if it never said.
  const restoreExp = expLabel || (curSecs !== null ? String(curSecs) : 'auto');
  const settingsNote = `tele ${effExp ?? '?'}s${gainSet ? ` gain ${o.gain}` : ''} (was ${expLabel || 'unknown'}${typeof gainNow === 'number' ? `, gain ${gainNow}` : ''}${exposureSet ? `; restored afterwards to ${restoreExp}` : ''})`;
  if (effExp !== null && effExp > 1) notes.push(`measuring at ${effExp}s exposure: star trails add to the HFR unless the mount is tracking — a 0.2-0.5s exposure measures focus alone`);

  const cam = hub.get('tele') as CameraSource;
  const deadline = startedAt + (o.deadlineMs ?? 900000);
  const repeats = Math.max(1, Math.min(3, Math.round(o.repeats ?? 1)));
  const total = positions.length;
  const samples: FocusSample[] = [];
  let lastPosition = Math.round(center);
  let lastMessage = 'starting';
  const publish = (patch: { total: number; index: number; position: number; best?: { position: number; hfrPx: number; score: number }; message?: string }) => {
    lastPosition = patch.position;
    if (patch.message) lastMessage = patch.message;
    dwarf.publishState({ focusTune: { running: true, action: 'sweep', startedAt, ...patch } });
  };

  const shoot = async (): Promise<{ img: FloatImage; sharp: StarSharpness }> => {
    if (effExp !== null && effExp >= 1) cam.expectPause(effExp * 1000 + 25000);
    const item = await dwarf.takePhoto('tele');
    if (!item) throw new Error('the tele produced no still for the focus measurement (camera service hung? check telescope_status health)');
    const img = await decode(await fetchFile(item.filePath), `tele focus still ${effExp ?? 'current'}s (${item.filePath})`);
    img.capturedAt = item.modificationTime * 1000;
    return { img, sharp: starSharpness(img, { crop: o.crop }) };
  };

  const sampleAt = async (position: number): Promise<{ sample: FocusSample; image?: FloatImage }> => {
    const t0 = Date.now();
    const reached = await dwarf.focusTo(position);
    await new Promise((r) => setTimeout(r, o.settleMs ?? 700));
    const frames: StarSharpness[] = [];
    let image: FloatImage | undefined;
    for (let i = 0; i < repeats; i++) {
      const { img, sharp } = await shoot();
      image = img;
      frames.push(sharp);
    }
    const usable = frames.filter((f) => f.ok);
    if (!usable.length) throw new Error(frames[0]?.blocking ?? 'the frame gave no focus reading');
    const hfrPx = median(usable.map((f) => f.hfrPx));
    const hfrArcsec = usable[0].hfrArcsec !== undefined ? median(usable.map((f) => f.hfrArcsec!)) : undefined;
    const sample: FocusSample = {
      position: reached,
      score: Math.round(1000 / (hfrArcsec ?? hfrPx)),
      hfrPx: round(hfrPx, 2),
      hfrArcsec: hfrArcsec !== undefined ? round(hfrArcsec, 2) : undefined,
      arcsecPerPx: usable[0].arcsecPerPx,
      hfrUncertaintyPx: round(median(usable.map((f) => f.hfrUncertaintyPx)), 2),
      stars: Math.max(...usable.map((f) => f.starsUsed)),
      saturated: Math.max(...usable.map((f) => f.saturatedStars)),
      seconds: +((Date.now() - t0) / 1000).toFixed(1),
      cautions: [...new Set(usable.flatMap((f) => f.cautions))],
    };
    return { sample, image };
  };

  try {
    publish({ total, index: 0, position: Math.round(center), message: 'measuring the starting position' });
    for (let i = 0; i < total; i++) {
      let sample: FocusSample;
      try {
        ({ sample } = await sampleAt(positions[i]));
      } catch (err) {
        if (i === 0 || samples.every((s) => s.error)) {
          throw new Error(`star focus could not measure ${positions[i]}: ${errMsg(err)} — the focuser was left there; check the sky (sky_check) and the camera health`);
        }
        sample = { position: positions[i], score: 0, hfrPx: 0, hfrUncertaintyPx: 0, stars: 0, saturated: 0, seconds: 0, error: errMsg(err) };
      }
      samples.push(sample);
      const ok = samples.filter((s) => !s.error);
      const bestSoFar = ok.reduce((a, b) => (b.hfrPx < a.hfrPx ? b : a));
      publish({
        total,
        index: i + 1,
        position: sample.position,
        best: { position: bestSoFar.position, hfrPx: bestSoFar.hfrPx, score: bestSoFar.score },
        message: sample.error ? `sample ${i + 1}/${total} failed: ${sample.error}` : `sample ${i + 1}/${total}: HFR ${sample.hfrPx}px (best ${bestSoFar.hfrPx}px at ${bestSoFar.position})`,
      });
      o.onProgress?.(sample, i + 1, total);
      if (i + 1 < total && Date.now() > deadline) {
        notes.push(`stopped after ${i + 1} of ${total} samples (time limit)`);
        break;
      }
    }

    const measured = samples.filter((s) => !s.error).sort((a, b) => a.position - b.position);
    if (measured.length < 3) {
      throw new Error(`star focus got readings at only ${measured.length} of ${samples.length} positions: ${samples.find((s) => s.error)?.error ?? 'no stars'}`);
    }
    const bestIndex = measured.reduce((bi, s, i) => (s.hfrPx < measured[bi].hfrPx ? i : bi), 0);
    const best = measured[bestIndex];
    // positions[0] was the centre, so the first sample says what the focuser's own setting was worth
    const start = samples[0];
    const bestAtEdge = bestIndex === 0 || bestIndex === measured.length - 1;

    let finalPosition = best.position;
    let fittedPosition: number | undefined;
    if (o.refine !== false && !bestAtEdge) {
      const fit = fitMinimum(measured, bestIndex);
      if (fit !== null && Math.abs(fit - best.position) >= 2) {
        fittedPosition = Math.round(fit);
        finalPosition = fittedPosition;
        notes.push(`fit through the samples around ${best.position} puts the optimum at ${fittedPosition}`);
      } else if (fit !== null) {
        notes.push(`the fit through the samples around ${best.position} agrees with it (less than one focus step away)`);
      }
    }

    publish({ total, index: total, position: finalPosition, message: o.apply === false ? 'returning to the starting position' : 'settling on the sharpest position' });
    if (o.apply === false) finalPosition = start.position;
    let final: FocusSample | undefined;
    let finalImage: FloatImage | undefined;
    try {
      const done = await sampleAt(finalPosition);
      final = done.sample;
      finalImage = done.image;
      finalPosition = done.sample.position;
    } catch (err) {
      notes.push(`the verification frame at ${finalPosition} failed: ${errMsg(err)}`);
    }

    const improvementPct = start.hfrPx > 0 && best.hfrPx > 0 ? (100 * (start.hfrPx - best.hfrPx)) / start.hfrPx : 0;
    if (bestAtEdge) notes.push(`the sharpest sample (${best.position}) was at the edge of the swept range: the true optimum may lie beyond it — sweep again centred there with a wider range`);
    if (final && best.hfrPx > 0 && final.hfrPx > best.hfrPx * 1.08) {
      notes.push(`the verification frame at ${final.position} measured softer (HFR ${final.hfrPx}px) than the sweep sample at ${best.position} (${best.hfrPx}px): the difference is within the frame-to-frame noise of this sky`);
    }
    const verdict = [
      `star focus: best at ${best.position} (median star HFR ${best.hfrArcsec ? `${best.hfrArcsec}″` : `${best.hfrPx}px`}, score ${best.score}, ${best.stars} stars)`,
      improvementPct > 5
        ? `sharper than the starting position ${start.position} (HFR ${start.hfrPx}px) by ${improvementPct.toFixed(0)}%`
        : `the starting position ${start.position} was already as sharp as anything in the swept range`,
      fittedPosition !== undefined ? `left the focuser at ${finalPosition} from a fit through the samples around the minimum` : `left the focuser at ${finalPosition}`,
    ].join('; ');

    const result: FocusSweepResult = {
      start,
      samples,
      best,
      finalPosition,
      final,
      fittedPosition,
      bestAtEdge,
      improvementPct: +improvementPct.toFixed(1),
      verdict,
      notes,
      settings: settingsNote,
      elapsedS: +((Date.now() - startedAt) / 1000).toFixed(1),
      arcsecPerPx: best.arcsecPerPx,
      finalImage,
    };
    lastPosition = result.finalPosition;
    lastMessage = [result.verdict, ...result.notes].join(' — ');
    return result;
  } catch (err) {
    lastMessage = `star focus failed: ${errMsg(err)}`;
    throw err;
  } finally {
    if (exposureSet) await dwarf.setSetting('tele', 'exposure', restoreExp).catch((e) => log.warn(`could not restore the tele exposure: ${errMsg(e)}`));
    // the stills paused the live view; nudge it back, and never let a stream that died meanwhile take the process down with it
    setTimeout(() => { try { cam.retryRtsp(); } catch (e) { log.warn(`the live view did not restart after the focus sweep: ${errMsg(e)}`); } }, 1500);
    dwarf.publishState({ focusTune: { running: false, action: 'sweep', startedAt, finishedAt: Date.now(), position: lastPosition, message: lastMessage } });
    sweepRunning = false;
  }
}

