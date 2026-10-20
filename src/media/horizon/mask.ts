/**
 * From wide stills to a horizon profile.
 *
 * 1. Evidence per frame. At night settings (2.5 s, gain 60) the camera crushes anything unlit to
 *    black: trees, rooflines and walls in silhouette read 0–5 in every channel, while the sky glow
 *    — clear, hazy or cloudy, at this site and in every library frame looked at — sits at 30+ and is
 *    near neutral. Blue is ~0 even on a porch-lit tree (verified on the 2026-10 library stills). So
 *    the darkest channel, against the sky level measured on frames known to be sky, is the cue: far
 *    below it is an obstruction. A lit wall goes the other way (much brighter than any sky, and
 *    coloured), which is the second, weaker cue. Stars are removed by taking each cell's median.
 * 2. A panorama in true azimuth × altitude (0.5° cells) that every frame is projected into, so the
 *    tilted frames of an EQ survey count the same as level alt-az ones and "down" is the horizon.
 * 3. The skyline: per column, the altitude below which it is obstruction, found by dynamic
 *    programming over all columns at once (the classic skyline-extraction approach: a region term
 *    per column plus a smoothness term between neighbours), wrapping round north. Sky seen under a
 *    branch counts lightly against marking it blocked: a planner that skips a target behind a
 *    see-through tree loses little, one that sends the scope into a branch loses the session.
 * 4. The profile: per 1° of azimuth the highest obstruction, widened by a degree each side and
 *    raised by a margin, null where no frame looked.
 */
import type { FloatImage } from '../image/types.js';
import { cameraGeom, dirToPixel, fromAltAz, type CameraGeom, type Vec } from './geometry.js';

/** Evidence grid width (cells across a frame). */
const GRID_W = 240;
/** Levels of the per-cell darkest-channel median (one per 8-bit value). */
const HIST_BINS = 256;
/** The darkest channel below this fraction of the sky level is an obstruction (silhouettes measure < 0.15). */
const DARK_RATIO = 0.4;
const DARK_SOFT = 0.1;
/** Brighter than the sky by this and coloured: a lit structure. Far brighter still: lit, whatever its colour. */
const LIT_RATIO = 1.8;
const LIT_CHROMA = 0.3;
const LIT_EVIDENCE = 0.6;
const GLARE_RATIO = 3;
/** Where in a sky frame's darkest-channel distribution the sky level is read. */
const SKY_PERCENTILE = 0.7;
/** Panorama cells. */
export const PANO_STEP = 0.5;
export const PANO_ALT_MIN = -6;
export const PANO_ALT_MAX = 84;
/** Skyline DP: smoothness per row of jump, the jump cost cap (rows), and the weight of sky left under the line. */
const DP_LAMBDA = 0.15;
const DP_JUMP_CAP = 6;
const DP_SKY_BELOW = 0.4;
/** An unobserved cell leans this little toward sky, so the line settles on observed evidence. */
const DP_UNSEEN = -0.02;
/** Columns of wrap-around context on each side. */
const DP_WRAP = 60;
/** The frame's outer edge (fraction) is not trusted: vignetting and lens distortion. */
const EDGE = 0.02;

export interface Evidence {
  gw: number;
  gh: number;
  /** +1 obstruction … −1 sky, per cell, row-major */
  data: Float32Array;
}

/** Per cell: the median of the darkest channel (star-free) and the mean colour. */
function cellStats(img: FloatImage): { gw: number; gh: number; dark: Float32Array; chroma: Float32Array } {
  const gw = Math.min(GRID_W, img.width);
  const cell = img.width / gw;
  const gh = Math.max(1, Math.round(img.height / cell));
  const dark = new Float32Array(gw * gh);
  const chroma = new Float32Array(gw * gh);
  const hist = new Uint32Array(HIST_BINS);
  const ch = img.channels;
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor(gy * cell);
    const y1 = Math.min(img.height, Math.floor((gy + 1) * cell));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * cell);
      const x1 = Math.min(img.width, Math.floor((gx + 1) * cell));
      hist.fill(0);
      let n = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * ch;
          const r = img.data[i];
          const g = ch === 3 ? img.data[i + 1] : r;
          const b = ch === 3 ? img.data[i + 2] : r;
          const m = Math.min(r, g, b);
          hist[Math.min(HIST_BINS - 1, Math.floor(m * HIST_BINS))]++;
          sr += r;
          sg += g;
          sb += b;
          n++;
        }
      }
      let acc = 0;
      let k = 0;
      for (; k < HIST_BINS - 1; k++) {
        acc += hist[k];
        if (acc * 2 >= n) break;
      }
      // the bin's position inside it, for a smoother value than the bin edge
      const below = acc - hist[k];
      const frac = hist[k] ? (n / 2 - below) / hist[k] : 0.5;
      const idx = gy * gw + gx;
      dark[idx] = (k + Math.max(0, Math.min(1, frac))) / HIST_BINS;
      const mx = Math.max(sr, sg, sb) / n;
      const mn = Math.min(sr, sg, sb) / n;
      chroma[idx] = (mx - mn) / (mx + 8 / 255);
    }
  }
  return { gw, gh, dark, chroma };
}

/**
 * The sky level of a frame known to look at sky (an anchor the telescope put on a sky position):
 * the 70th percentile of its cells' darkest channel, so a branch across part of it does not drag
 * the level down. Frames are taken at the survey's fixed exposure, so it carries over to the rest.
 */
export function skyLevelOf(img: FloatImage): number {
  const { dark } = cellStats(img);
  const v = Array.from(dark).sort((a, b) => a - b);
  return v[Math.floor(v.length * SKY_PERCENTILE)] ?? 0;
}

function blur3(a: Float32Array, w: number, h: number): Float32Array {
  const o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          s += a[yy * w + xx];
          n++;
        }
      }
      o[y * w + x] = s / n;
    }
  }
  return o;
}

/** Obstruction evidence for one frame against the survey's sky level. */
export function frameEvidence(img: FloatImage, skyLevel: number): Evidence {
  const { gw, gh, dark, chroma } = cellStats(img);
  const m = blur3(dark, gw, gh);
  const sky = Math.max(skyLevel, 2 / 255);
  const data = new Float32Array(gw * gh);
  for (let i = 0; i < data.length; i++) {
    const d = m[i] / sky;
    let ev = Math.tanh((DARK_RATIO - d) / DARK_SOFT);
    if (d > LIT_RATIO && chroma[i] > LIT_CHROMA) ev = Math.max(ev, LIT_EVIDENCE);
    if (d > GLARE_RATIO) ev = 1;
    data[i] = ev;
  }
  return { gw, gh, data };
}

// ---- panorama

export interface PanoFrame {
  evidence: Evidence;
  /** the camera in the frame's own pixels (the evidence grid is scaled from it) */
  cam: CameraGeom;
  basis: { b: Vec; u: Vec; r: Vec };
}

export interface Panorama {
  cols: number;
  rows: number;
  /** weighted mean evidence per cell; weight 0 = not observed */
  ev: Float32Array;
  weight: Float32Array;
}

export const panoCols = () => Math.round(360 / PANO_STEP);
export const panoRows = () => Math.round((PANO_ALT_MAX - PANO_ALT_MIN) / PANO_STEP);
/** Centre altitude of a panorama row (row 0 at the top). */
export const rowAlt = (row: number) => PANO_ALT_MAX - (row + 0.5) * PANO_STEP;
export const colAz = (col: number) => (col + 0.5) * PANO_STEP;

/** Project every frame's evidence into one azimuth × altitude grid, frame centres trusted most. */
export function buildPanorama(frames: PanoFrame[]): Panorama {
  const cols = panoCols();
  const rows = panoRows();
  const ev = new Float32Array(cols * rows);
  const weight = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    const alt = rowAlt(row);
    for (let col = 0; col < cols; col++) {
      const v = fromAltAz(colAz(col), alt);
      let s = 0;
      let w = 0;
      for (const f of frames) {
        const p = dirToPixel(f.cam, f.basis, v);
        if (!p) continue;
        const nx = p.x / f.cam.width;
        const ny = p.y / f.cam.height;
        if (nx < EDGE || nx > 1 - EDGE || ny < EDGE || ny > 1 - EDGE) continue;
        const gx = Math.min(f.evidence.gw - 1, Math.floor(nx * f.evidence.gw));
        const gy = Math.min(f.evidence.gh - 1, Math.floor(ny * f.evidence.gh));
        const wt = (1 - (2 * nx - 1) ** 2) * (1 - (2 * ny - 1) ** 2) + 0.02;
        s += wt * f.evidence.data[gy * f.evidence.gw + gx];
        w += wt;
      }
      if (w > 0) {
        ev[row * cols + col] = s / w;
        weight[row * cols + col] = w;
      }
    }
  }
  return { cols, rows, ev, weight };
}

export interface Skyline {
  /** per panorama column: altitude of the obstruction top (0 when only the true horizon), null when not observed */
  top: Array<number | null>;
  /** per column: the highest altitude any frame saw */
  covered: Array<number | null>;
}

/**
 * The obstruction line over the whole panorama. Below the true horizon counts as obstruction (it
 * is the ground) and unobserved cells say nothing.
 */
export function skyline(p: Panorama): Skyline {
  const { cols, rows } = p;
  const e = (row: number, col: number) => {
    const c = ((col % cols) + cols) % cols;
    if (rowAlt(row) < 0) return 1;
    return p.weight[row * cols + c] > 0 ? p.ev[row * cols + c] : DP_UNSEEN;
  };
  const n = cols + 2 * DP_WRAP;
  const H = rows;
  // per column prefix sums: cost above the line (labelled sky) and below it (labelled obstruction)
  const above = new Float32Array((H + 1) * n);
  const below = new Float32Array((H + 1) * n);
  for (let j = 0; j < n; j++) {
    const col = j - DP_WRAP;
    let sa = 0;
    let sb = 0;
    for (let r = 0; r < H; r++) {
      const v = e(r, col);
      sa += v;
      sb += v > 0 ? -v : -DP_SKY_BELOW * v;
      above[(r + 1) * n + j] = sa;
      below[(r + 1) * n + j] = sb;
    }
  }
  const data = (j: number, b: number) => above[b * n + j] + below[H * n + j] - below[b * n + j];
  let prev = new Float32Array(H + 1);
  let cur = new Float32Array(H + 1);
  const back = new Int32Array(n * (H + 1));
  for (let b = 0; b <= H; b++) prev[b] = data(0, b);
  for (let j = 1; j < n; j++) {
    let gmin = Infinity;
    let garg = 0;
    for (let b = 0; b <= H; b++) {
      if (prev[b] < gmin) {
        gmin = prev[b];
        garg = b;
      }
    }
    for (let b = 0; b <= H; b++) {
      let best = gmin + DP_LAMBDA * DP_JUMP_CAP;
      let arg = garg;
      for (let d = -DP_JUMP_CAP + 1; d < DP_JUMP_CAP; d++) {
        const bb = b + d;
        if (bb < 0 || bb > H) continue;
        const c = prev[bb] + DP_LAMBDA * Math.abs(d);
        if (c < best) {
          best = c;
          arg = bb;
        }
      }
      cur[b] = best + data(j, b);
      back[j * (H + 1) + b] = arg;
    }
    [prev, cur] = [cur, prev];
  }
  let b = 0;
  for (let k = 1; k <= H; k++) if (prev[k] < prev[b]) b = k;
  const line = new Int32Array(n);
  for (let j = n - 1; j >= 0; j--) {
    line[j] = b;
    b = back[j * (H + 1) + b];
  }
  const top: Array<number | null> = [];
  const covered: Array<number | null> = [];
  for (let col = 0; col < cols; col++) {
    let hi: number | null = null;
    for (let r = 0; r < H; r++) {
      if (p.weight[r * cols + col] > 0 && rowAlt(r) >= 0) {
        hi = rowAlt(r) + PANO_STEP / 2;
        break;
      }
    }
    covered.push(hi);
    // the line's row index is the first obstruction row: its top edge is the obstruction's top
    top.push(hi === null ? null : Math.max(0, PANO_ALT_MAX - line[col + DP_WRAP] * PANO_STEP));
  }
  return { top, covered };
}

export interface Profile {
  profile: Array<number | null>;
  /** 1° bins whose obstruction reaches the top of what was photographed */
  capped: number[];
}

/** 1° bins: the highest obstruction in each, widened a degree each side, plus the margin. */
export function profileOf(s: Skyline, marginDeg: number): Profile {
  const per = Math.round(1 / PANO_STEP);
  const raw: Array<number | null> = [];
  const capped: number[] = [];
  for (let k = 0; k < 360; k++) {
    let hi: number | null = null;
    let cap = false;
    for (let c = k * per; c < (k + 1) * per; c++) {
      const t = s.top[c];
      if (t === null) continue;
      hi = Math.max(hi ?? 0, t);
      if (t > 0 && s.covered[c] !== null && t >= s.covered[c]! - 1) cap = true;
    }
    raw.push(hi);
    if (cap) capped.push(k);
  }
  const profile = raw.map((v, k) => {
    if (v === null) return null;
    let hi = v;
    for (const d of [-1, 1]) hi = Math.max(hi, raw[(k + d + 360) % 360] ?? 0);
    return hi > 0 ? Math.min(90, Math.round((hi + marginDeg) * 10) / 10) : 0;
  });
  return { profile, capped };
}

// ---- the picture

export interface PanoPicture {
  width: number;
  height: number;
  /** RGB bytes */
  rgb: Buffer;
  /** degrees per pixel */
  step: number;
}

/** A small RGB copy of a frame for the panorama picture. */
export interface Thumb {
  width: number;
  height: number;
  rgb: Float32Array;
}

export function thumbOf(img: FloatImage, width = 360): Thumb {
  const w = Math.min(width, img.width);
  const k = img.width / w;
  const h = Math.max(1, Math.round(img.height / k));
  const rgb = new Float32Array(w * h * 3);
  const ch = img.channels;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * k));
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * k));
      const i = (sy * img.width + sx) * ch;
      for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = img.data[i + (ch === 3 ? c : 0)];
    }
  }
  return { width: w, height: h, rgb };
}

/**
 * The surroundings unrolled: azimuth across (north at the left edge), altitude up, every frame
 * brightened so the sky level sits mid-grey, with the obstruction line (red) and the profile the
 * planner uses (yellow) drawn over it.
 */
export function renderPanorama(frames: Array<{ thumb: Thumb; cam: CameraGeom; basis: PanoFrame['basis'] }>, skyLevel: number, s: Skyline, prof: Profile, step = 0.25): PanoPicture {
  const width = Math.round(360 / step);
  const altMin = PANO_ALT_MIN;
  const altMax = Math.min(PANO_ALT_MAX, 75);
  const height = Math.round((altMax - altMin) / step);
  const rgb = Buffer.alloc(width * height * 3, 24);
  const gain = 0.4 / Math.max(skyLevel, 2 / 255);
  const thumbs = frames.map((f) => ({ ...f, tcam: cameraGeom(f.thumb.width, f.thumb.height, 1, { x: f.cam.cx / f.cam.width, y: f.cam.cy / f.cam.height }), kx: f.thumb.width / f.cam.width }));
  for (const t of thumbs) t.tcam.f = t.cam.f * t.kx;
  for (let y = 0; y < height; y++) {
    const alt = altMax - (y + 0.5) * step;
    for (let x = 0; x < width; x++) {
      const v = fromAltAz((x + 0.5) * step, alt);
      let best: { t: (typeof thumbs)[number]; px: number; py: number; w: number } | null = null;
      for (const t of thumbs) {
        const p = dirToPixel(t.tcam, t.basis, v);
        if (!p || p.x < 0 || p.y < 0 || p.x >= t.thumb.width || p.y >= t.thumb.height) continue;
        const w = (1 - (2 * p.x / t.thumb.width - 1) ** 2) * (1 - (2 * p.y / t.thumb.height - 1) ** 2);
        if (!best || w > best.w) best = { t, px: p.x, py: p.y, w };
      }
      if (!best) continue;
      const i = (Math.floor(best.py) * best.t.thumb.width + Math.floor(best.px)) * 3;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) rgb[o + c] = Math.round(255 * Math.min(1, Math.sqrt(Math.min(1, best.t.thumb.rgb[i + c] * gain))));
    }
  }
  const plot = (az: number, alt: number, col: [number, number, number]) => {
    const x = Math.floor(az / step);
    const y = Math.floor((altMax - alt) / step);
    for (let dy = 0; dy < 2; dy++) {
      const yy = y + dy;
      if (x < 0 || x >= width || yy < 0 || yy >= height) continue;
      const o = (yy * width + x) * 3;
      rgb[o] = col[0];
      rgb[o + 1] = col[1];
      rgb[o + 2] = col[2];
    }
  };
  const per = PANO_STEP / step;
  s.top.forEach((t, col) => {
    if (t === null) return;
    for (let k = 0; k < per; k++) plot(col * PANO_STEP + k * step, t, [255, 40, 40]);
  });
  prof.profile.forEach((v, k) => {
    if (v === null) return;
    for (let a = 0; a < 1; a += step) plot(k + a, v, [255, 220, 0]);
  });
  return { width, height, rgb, step };
}
