/**
 * From wide stills to a horizon profile.
 *
 * 1. Evidence per frame. At night settings the camera crushes anything unlit to black: trees,
 *    rooflines and walls in silhouette read 0–5 in every channel, while the sky glow sits at 30+ and
 *    is near neutral. So the darkest channel against the sky level is the first cue, read on each
 *    cell's darker quartile so a branch across part of a cell counts. Three more: a lit structure
 *    is far brighter than the sky at its altitude (and coloured or textured; glow is smooth),
 *    foliage and edges are textured where the sky is smooth, and a verified star (compact, isolated,
 *    well above the noise: JPEG noise makes single-pixel peaks) in an untextured, undarkened block
 *    is sky. The survey compares each cell with the sky at its own altitude (skyByAltitude).
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
/** The darker quartile below this fraction of the sky level is an obstruction (silhouettes measure < 0.15). */
const DARK_RATIO = 0.4;
const DARK_SOFT = 0.1;
/**
 * Brighter than the sky there by LIT_RATIO and coloured or textured: a lit structure (a pale wall
 * under porch lights read 1.5-3× the sky, 2026-10-27, and was missed at the old 1.8× + strongly
 * coloured). Smooth and neutral (what horizon glow looks like) only reaches GLOW_EVIDENCE. Far
 * brighter still: lit, whatever it looks like.
 */
const LIT_RATIO = 1.5;
const LIT_CHROMA = 0.18;
const LIT_EVIDENCE = 0.6;
const GLOW_EVIDENCE = 0.35;
const GLARE_RATIO = 3;
/** Texture (block gradient median, in noise units) above this is foliage or structure. */
const TEXTURE_EDGE = 4;
const TEXTURE_SOFT = 2;
const TEXTURE_EVIDENCE = 0.55;
/** A verified star makes its cell sky when the darker quartile is at least this bright (no silhouette in it). */
const STAR_CLEAR_DARK = 0.7;
const STAR_EVIDENCE = -0.9;
/**
 * Colour: a chromaticity this far from the sky's own (R/(R+G+B), B/(R+G+B)) is a lit structure or
 * plant. Raw, 4 s, at a suburban site (2026-11-05): sky r 0.30 b 0.24, lit wall r 0.44 b 0.11.
 */
const COLOUR_EDGE = 0.04;
const COLOUR_SOFT = 0.05;
const COLOUR_EVIDENCE = 0.75;
/** …on cells at least this bright against the sky (darker ones are the dark cue's, and their colour is noise). */
const COLOUR_MIN_LEVEL = 0.6;
/** Where in a sky frame's darkest-channel distribution the sky level is read. */
const SKY_PERCENTILE = 0.7;
/** Panorama cells. */
export const PANO_STEP = 0.5;
export const PANO_ALT_MIN = -6;
export const PANO_ALT_MAX = 84;
/** Skyline DP: smoothness per row of jump, the jump cost cap (rows), and the weight of sky left under the line. */
const DP_LAMBDA = 0.15;
const DP_JUMP_CAP = 6;
// sky seen under the line (through a tree, under a branch) costs little: the whole canopy is blocked
const DP_SKY_BELOW = 0.25;
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

/**
 * Per-cell statistics of a frame, the raw material of the evidence:
 *   dark     the median of the darkest channel (stars are too few to move it)
 *   darkLow  its 25th percentile: a cell partly covered by a branch or a roof edge reads dark here
 *            even when the sky between the twigs keeps the median up
 *   chroma   how coloured the cell is (lit walls and trees under porch lights are; sky glow less so)
 *   texture  the median gradient (|dx|+|dy| of the luminance) over a block of cells around it:
 *            leaves, branches, roof lines and windows are textured, sky (even bright glow) is smooth.
 *            evidenceOf judges it against the noise of the sky (silhouettes are smoother still:
 *            crushed to black, they have no noise at all, so they cannot be the reference)
 *   stars    verified point sources: compact (more than one pixel, less than a blob), isolated, well
 *            above the local noise. JPEG noise at high gain makes single-pixel peaks that a plain
 *            local-maximum count takes for stars (it fooled sky checks before).
 */
export interface CellStats {
  gw: number;
  gh: number;
  dark: Float32Array;
  darkLow: Float32Array;
  chroma: Float32Array;
  texture: Float32Array;
  stars: Uint8Array;
  /** chromaticity: R/(R+G+B) and B/(R+G+B) of the cell's mean (judged against the sky's own: raw frames are not white-balanced) */
  cr: Float32Array;
  cb: Float32Array;
}

/** Texture blocks: the gradient median is taken over TEX_BLOCK × TEX_BLOCK cells (stars are a few pixels of them). */
const TEX_BLOCK = 3;
/** A star: peak this many σ above the local background, at least this far above it in absolute terms. */
const STAR_SIGMA = 7;
const STAR_MIN_EXCESS = 5 / 255;
/** Pixels above half the peak's excess: more than one (noise) and not a blob. */
const STAR_MIN_PX = 2;
const STAR_MAX_PX = 16;
/** More star cells than CLUSTER_MAX within ±CLUSTER_R cells: a cluster (sparkle on something lit), not stars. */
const CLUSTER_R = 3;
const CLUSTER_MAX = 3;

function percentileOfHist(hist: Uint32Array, n: number, q: number): number {
  let acc = 0;
  let k = 0;
  for (; k < hist.length - 1; k++) {
    acc += hist[k];
    if (acc >= n * q) break;
  }
  const below = acc - hist[k];
  const frac = hist[k] ? (n * q - below) / hist[k] : 0.5;
  return (k + Math.max(0, Math.min(1, frac))) / hist.length;
}

export function frameStats(img: FloatImage): CellStats {
  const W = img.width;
  const H = img.height;
  const gw = Math.min(GRID_W, W);
  const cell = W / gw;
  const gh = Math.max(1, Math.round(H / cell));
  const n = gw * gh;
  const dark = new Float32Array(n);
  const darkLow = new Float32Array(n);
  const chroma = new Float32Array(n);
  const cr = new Float32Array(n);
  const cb = new Float32Array(n);
  const ch = img.channels;
  const lum = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += ch) {
    const r = img.data[p];
    const g = ch === 3 ? img.data[p + 1] : r;
    const b = ch === 3 ? img.data[p + 2] : r;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  // the darkest channel after a 3×3 box mean of each channel: noisy frames (RAW subs) would otherwise
  // read dark on noise alone, the minimum of three noisy values sitting below all of them
  const darkest = new Float32Array(W * H);
  {
    const acc = new Float32Array(3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        acc.fill(0);
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const i = (yy * W + xx) * ch;
            acc[0] += img.data[i];
            acc[1] += ch === 3 ? img.data[i + 1] : img.data[i];
            acc[2] += ch === 3 ? img.data[i + 2] : img.data[i];
            n++;
          }
        }
        darkest[y * W + x] = Math.min(acc[0], acc[1], acc[2]) / n;
      }
    }
  }
  const hist = new Uint32Array(HIST_BINS);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor(gy * cell);
    const y1 = Math.min(H, Math.floor((gy + 1) * cell));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * cell);
      const x1 = Math.min(W, Math.floor((gx + 1) * cell));
      hist.fill(0);
      let m = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * ch;
          const r = img.data[i];
          const g = ch === 3 ? img.data[i + 1] : r;
          const b = ch === 3 ? img.data[i + 2] : r;
          hist[Math.min(HIST_BINS - 1, Math.max(0, Math.floor(darkest[y * W + x] * HIST_BINS)))]++;
          sr += r;
          sg += g;
          sb += b;
          m++;
        }
      }
      const idx = gy * gw + gx;
      dark[idx] = percentileOfHist(hist, m, 0.5);
      darkLow[idx] = percentileOfHist(hist, m, 0.25);
      const mx = Math.max(sr, sg, sb) / m;
      const mn = Math.min(sr, sg, sb) / m;
      chroma[idx] = (mx - mn) / (mx + 8 / 255);
      const tot = sr + sg + sb;
      cr[idx] = tot > 0 ? sr / tot : 1 / 3;
      cb[idx] = tot > 0 ? sb / tot : 1 / 3;
    }
  }

  // gradient magnitude (|dx| + |dy| of the luminance), its median per block of cells
  const grad = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      grad[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]);
    }
  }
  const bw = Math.ceil(gw / TEX_BLOCK);
  const bh = Math.ceil(gh / TEX_BLOCK);
  const block = new Float32Array(bw * bh);
  const blockLum = new Float32Array(bw * bh);
  const GBINS = 512;
  const GMAX = 0.25;
  const ghist = new Uint32Array(GBINS);
  const lhist = new Uint32Array(HIST_BINS);
  for (let by = 0; by < bh; by++) {
    const y0 = Math.max(1, Math.floor(by * TEX_BLOCK * cell));
    const y1 = Math.min(H - 1, Math.floor((by + 1) * TEX_BLOCK * cell));
    for (let bx = 0; bx < bw; bx++) {
      const x0 = Math.max(1, Math.floor(bx * TEX_BLOCK * cell));
      const x1 = Math.min(W - 1, Math.floor((bx + 1) * TEX_BLOCK * cell));
      ghist.fill(0);
      lhist.fill(0);
      let m = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          ghist[Math.min(GBINS - 1, Math.floor((grad[y * W + x] / GMAX) * GBINS))]++;
          lhist[Math.min(HIST_BINS - 1, Math.max(0, Math.floor(lum[y * W + x] * HIST_BINS)))]++;
          m++;
        }
      }
      block[by * bw + bx] = m ? percentileOfHist(ghist, m, 0.5) * GMAX : 0;
      blockLum[by * bw + bx] = m ? percentileOfHist(lhist, m, 0.5) : 0;
    }
  }
  const texture = new Float32Array(n);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) texture[gy * gw + gx] = block[Math.floor(gy / TEX_BLOCK) * bw + Math.floor(gx / TEX_BLOCK)];
  }
  // the noise for the star test: the spread of the pixels round their block's median, on the
  // brighter half of the blocks (silhouettes are noise-free black). Not the pixel-to-pixel gradient:
  // JPEG and the camera's denoising smooth the noise into bumps a few pixels wide, which a gradient
  // underestimates and a 7σ cut then takes for stars (2026-11-04: 218 "stars" on a blank ceiling).
  const midLum = median(blockLum);
  const DBINS = 2048;
  const DMAX = 0.25;
  const dhist = new Uint32Array(DBINS);
  let dn = 0;
  for (let y = 1; y < H - 1; y += 3) {
    const by = Math.min(bh - 1, Math.floor(y / cell / TEX_BLOCK));
    for (let x = 1; x < W - 1; x += 3) {
      const b = by * bw + Math.min(bw - 1, Math.floor(x / cell / TEX_BLOCK));
      if (blockLum[b] < midLum) continue;
      dhist[Math.min(DBINS - 1, Math.floor((Math.abs(lum[y * W + x] - blockLum[b]) / DMAX) * DBINS))]++;
      dn++;
    }
  }
  const noise = Math.max(0.5 / 255, dn ? 1.4826 * percentileOfHist(dhist, dn, 0.5) * DMAX : 1 / 255);
  // stars
  const stars = new Uint8Array(n);
  const R = 2;
  const ring = 4;
  for (let y = ring; y < H - ring; y++) {
    for (let x = ring; x < W - ring; x++) {
      const i = y * W + x;
      const v = lum[i];
      const bg = blockLum[Math.min(bh - 1, Math.floor(y / cell / TEX_BLOCK)) * bw + Math.min(bw - 1, Math.floor(x / cell / TEX_BLOCK))];
      const excess = v - bg;
      if (excess < STAR_MIN_EXCESS || excess < STAR_SIGMA * noise) continue;
      let isMax = true;
      let above = 0;
      for (let dy = -R; dy <= R && isMax; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (!dx && !dy) continue;
          const nb = lum[i + dy * W + dx];
          if (nb > v || (nb === v && (dy < 0 || (dy === 0 && dx < 0)))) {
            isMax = false;
            break;
          }
          if (nb - bg > excess * 0.5) above++;
        }
      }
      if (!isMax) continue;
      above++;
      if (above < STAR_MIN_PX || above > STAR_MAX_PX) continue;
      // isolated: the ring around it is back near the background
      let ringHi = 0;
      for (let k = -ring; k <= ring; k++) {
        for (const [dx, dy] of [[k, -ring], [k, ring], [-ring, k], [ring, k]]) if (lum[i + dy * W + dx] - bg > excess * 0.35) ringHi++;
      }
      if (ringHi > 3) continue;
      const gx = Math.min(gw - 1, Math.floor(x / cell));
      const gy = Math.min(gh - 1, Math.floor(y / cell));
      stars[gy * gw + gx] = Math.min(255, stars[gy * gw + gx] + 1);
    }
  }
  // a "star" among many is not one: lit foliage and gravel sparkle in clusters, the sky's stars are
  // sparse (2026-11-05: dozens per patch on porch-lit bushes)
  const dense = new Uint8Array(n);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!stars[gy * gw + gx]) continue;
      let k = 0;
      for (let dy = -CLUSTER_R; dy <= CLUSTER_R; dy++) for (let dx = -CLUSTER_R; dx <= CLUSTER_R; dx++) {
        const yy = gy + dy;
        const xx = gx + dx;
        if (yy >= 0 && yy < gh && xx >= 0 && xx < gw && stars[yy * gw + xx]) k++;
      }
      if (k > CLUSTER_MAX) dense[gy * gw + gx] = 1;
    }
  }
  for (let i = 0; i < n; i++) if (dense[i]) stars[i] = 0;
  return { gw, gh, dark, darkLow, chroma, texture, stars, cr, cb };
}

function median(a: Float32Array): number {
  const v = Array.from(a).sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)] ?? 0;
}

/**
 * The texture of plain sky in a frame (the gradient median of cells near the sky level): what
 * evidenceOf measures texture against. The survey takes it from its sky anchor.
 */
export function skyTexture(s: CellStats, skyLevel: number): number {
  const v: number[] = [];
  for (let i = 0; i < s.dark.length; i++) {
    const r = s.dark[i] / Math.max(skyLevel, 2 / 255);
    if (r > 0.75 && r < 1.35) v.push(s.texture[i]);
  }
  v.sort((a, b) => a - b);
  return Math.max(0.5 / 255, v[Math.floor(v.length * 0.4)] ?? 2 / 255);
}

/**
 * Keep only the stars found again in a second frame of the same pointing (within a cell): the mount
 * tracks, so a star stays where it was, and noise does not repeat. Changes `a` in place.
 */
export function confirmStars(a: CellStats, b: CellStats): CellStats {
  if (a.gw !== b.gw || a.gh !== b.gh) return a;
  const nb = near(b.stars, b.gw, b.gh);
  for (let i = 0; i < a.stars.length; i++) if (a.stars[i] && !nb[i]) a.stars[i] = 0;
  return a;
}

/**
 * Cells where both frames show a "star" at the same place on the sensor although the scope turned
 * between them: hot pixels (they repeat frame after frame, so confirmStars keeps them, and they are
 * sharp whatever the focus, so they would hide a soft camera). Real stars moved with the sky.
 */
export function hotCells(a: CellStats, b: CellStats): Uint8Array {
  const hot = new Uint8Array(a.stars.length);
  if (a.gw !== b.gw || a.gh !== b.gh) return hot;
  const nb = near(b.stars, b.gw, b.gh);
  for (let i = 0; i < hot.length; i++) if (a.stars[i] && nb[i]) hot[i] = 1;
  return near(hot, a.gw, a.gh);
}

/** Clears the stars in the given cells (a hot-pixel map); changes `s` in place. */
export function dropStars(s: CellStats, cells: Uint8Array | null): CellStats {
  if (!cells || cells.length !== s.stars.length) return s;
  for (let i = 0; i < cells.length; i++) if (cells[i]) s.stars[i] = 0;
  return s;
}

/** How many verified stars a frame shows (a sky check that JPEG noise does not pass). */
export function starCount(s: CellStats): number {
  let k = 0;
  for (const v of s.stars) k += v;
  return k;
}

/**
 * The sky level of a frame known to look at sky (an anchor the telescope put on a sky position):
 * the 70th percentile of its cells' darkest channel, so a branch across part of it does not drag
 * the level down. Frames are taken at the survey's fixed exposure, so it carries over to the rest.
 */
export function skyLevelOf(img: FloatImage | CellStats): number {
  const { dark } = 'dark' in img ? img : frameStats(img);
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

/** Stars within a cell of each cell (a star's light can fall either side of a cell edge). */
function near(a: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w) s += a[yy * w + xx];
      }
      o[y * w + x] = Math.min(255, s);
    }
  }
  return o;
}

/**
 * Obstruction evidence for one frame, +1 obstruction … −1 sky per cell, against the sky level: one
 * number (the anchor's), or per cell (the survey's sky by altitude, so the glow low over a town is
 * compared with the sky down there and not with the zenith's).
 *
 *   dark     the darker quartile far below the sky: a silhouette, or a cell partly covered by one
 *   bright   far brighter than the sky there: a lit wall or a light. Coloured or textured adds to it;
 *            smooth, neutral and only moderately bright counts less (that is what glow looks like)
 *   texture  leaves, branches, edges and windows, which the sky never shows
 *   stars    a verified star in a cell the dark cue does not claim, and the block is smooth: sky.
 *            A star seen through a gap in a tree does not clear the tree (the block is textured).
 */
export function evidenceOf(
  s: CellStats,
  sky: number | ((gx: number, gy: number) => number),
  o: { skyTexture?: number; skyLevel?: number; skyColour?: (gx: number, gy: number) => { r: number; b: number } | null } = {},
): Evidence {
  const { gw, gh } = s;
  // the sky's own texture: given (the survey's anchor, at its sky level), or read off this frame; it
  // grows with the sky's brightness (photon noise), so a brighter sky is allowed more
  const refLevel = o.skyLevel ?? (typeof sky === 'number' ? sky : median(s.dark));
  const tex0 = o.skyTexture ?? skyTexture(s, refLevel);
  const lo = blur3(s.darkLow, gw, gh);
  const md = blur3(s.dark, gw, gh);
  const st = near(s.stars, gw, gh);
  const cr = o.skyColour ? blur3(s.cr, gw, gh) : null;
  const cb = o.skyColour ? blur3(s.cb, gw, gh) : null;
  const data = new Float32Array(gw * gh);
  const skyAt = typeof sky === 'number' ? () => sky : sky;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      const ref = Math.max(skyAt(gx, gy), 2 / 255);
      const d = lo[i] / ref;
      const b = md[i] / ref;
      const t = s.texture[i] / (tex0 * Math.sqrt(Math.max(0.5, Math.min(4, ref / Math.max(refLevel, 2 / 255)))));
      let ev = Math.tanh((DARK_RATIO - d) / DARK_SOFT);
      // bright: a light or a lit wall; smooth neutral glow only counts when it is very bright
      if (b > LIT_RATIO) {
        const strength = Math.min(1, (b - LIT_RATIO) / (GLARE_RATIO - LIT_RATIO));
        const looksBuilt = s.chroma[i] > LIT_CHROMA || t > TEXTURE_EDGE;
        ev = Math.max(ev, looksBuilt ? LIT_EVIDENCE + (1 - LIT_EVIDENCE) * strength : GLOW_EVIDENCE * strength);
      }
      if (b > GLARE_RATIO) ev = 1;
      // colour: away from the sky's own colour at that altitude (a lit wall, a lit tree). Only on cells
      // bright enough for their colour to mean something
      if (cr && cb && b > COLOUR_MIN_LEVEL) {
        const c = o.skyColour!(gx, gy);
        if (c) {
          const dc = Math.hypot(cr[i] - c.r, cb[i] - c.b);
          if (dc > COLOUR_EDGE) ev = Math.max(ev, Math.min(COLOUR_EVIDENCE, ((dc - COLOUR_EDGE) / COLOUR_SOFT) * COLOUR_EVIDENCE));
        }
      }
      // texture: foliage and structure (not the dark cue's own silhouettes, which are smooth black)
      if (t > TEXTURE_EDGE && d > DARK_RATIO) ev = Math.max(ev, Math.min(TEXTURE_EVIDENCE, ((t - TEXTURE_EDGE) / TEXTURE_SOFT) * TEXTURE_EVIDENCE));
      // stars: sky, where nothing dark or textured claims the cell
      if (st[i] > 0 && d > STAR_CLEAR_DARK && t < TEXTURE_EDGE && b < LIT_RATIO && ev < COLOUR_EVIDENCE * 0.5) ev = Math.min(ev, STAR_EVIDENCE);
      data[i] = ev;
    }
  }
  return { gw, gh, data };
}

/** Obstruction evidence for one frame against the survey's sky level. */
export function frameEvidence(img: FloatImage, skyLevel: number): Evidence {
  return evidenceOf(frameStats(img), skyLevel);
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
