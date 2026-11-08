/**
 * The obstruction survey's solve, shared by the Dwarf and the Seestar: frames (their cell
 * statistics, where they look and how they are turned) → evidence → panorama → skyline → profile,
 * the pictures, and the frames kept on disk so a survey can be solved again later.
 *
 * The sky by altitude. Sky glow is not even: low over a town it can be twice the zenith's, and a
 * single sky level (an anchor's, high up) makes that glow read as a lit obstruction while a pale
 * wall at the same brightness is real. So the sky level each cell is judged against is the sky's at
 * that cell's altitude, measured on the survey's own cells that are certainly sky (a verified star,
 * not darkened, untextured), per band of altitude; below the lowest band with enough of them the
 * lowest band's level holds (glow without stars is not taken as the sky's level).
 *
 * Kept frames. Every survey writes its frames (JPEG) and their geometry under
 * captures/horizon/<id>/ (survey.json): resolveSurvey(id) solves them again with the current
 * evidence, without moving the telescope — a survey of a remote site is an evening's work, and the
 * judgement can improve after it.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../../config.js';
import { describeMask, newMaskId, saveMask, unknownSectors, type HorizonMask } from '../../astro/horizon.js';
import { decode } from '../image/decode.js';
import type { FloatImage } from '../image/types.js';
import { pixelToDir, toAltAz, type CameraGeom, type Vec } from './geometry.js';
import { buildPanorama, evidenceOf, frameStats, profileOf, renderPanorama, skyline, thumbOf, type CellStats, type Evidence, type PanoFrame, type Profile, type Skyline, type Thumb } from './mask.js';

/** A survey frame ready to solve. */
export interface SurveyShot {
  stats: CellStats;
  thumb: Thumb;
  cam: CameraGeom;
  basis: { b: Vec; u: Vec; r: Vec };
}

/** Altitude bands of the sky model, and the certain-sky cells a band needs. */
const BAND_DEG = 3;
const BAND_MIN_CELLS = 40;
/** The model stays within these multiples of the anchor's sky level. */
const SKY_MODEL_RANGE = [0.5, 2.5] as const;
/** Every SAMPLE_STEP-th cell is sampled for the model. */
const SAMPLE_STEP = 2;
/** A frame's own sky: bands of altitude, and the cells and share of a band that must be readable. */
const FRAME_BAND_DEG = 3;
const FRAME_BAND_MIN_CELLS = 20;
const FRAME_BAND_MIN_SHARE = 0.2;
/** Not a silhouette: at least this much of the sky by altitude. */
const FRAME_NOT_DARK = 0.5;
/** Smooth: within this much of the texture of the frame's highest readable band. */
const FRAME_TEXTURE_MARGIN = 1.25;
/** The most a band may differ from the band above it: brightness (a ratio) and chromaticity. */
const FRAME_LEVEL_STEP = 1.35;
const FRAME_COLOUR_STEP = 0.025;

/** Each cell's altitude for a shot (the evidence grid scaled from the frame). */
function cellAltitudes(s: SurveyShot): Float32Array {
  const { gw, gh } = s.stats;
  const alt = new Float32Array(gw * gh);
  const kx = s.cam.width / gw;
  const ky = s.cam.height / gh;
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) alt[gy * gw + gx] = toAltAz(pixelToDir(s.cam, s.basis, (gx + 0.5) * kx, (gy + 0.5) * ky)).alt;
  return alt;
}

export interface SkyModel {
  /** the sky level (darkest channel, 0..1) at an altitude */
  at(altDeg: number): number;
  /** the sky's chromaticity at an altitude (null: no band measured it) */
  colourAt(altDeg: number): { r: number; b: number } | null;
  /** the bands measured: altitude (centre) → level and colour */
  bands: Array<{ alt: number; level: number; r: number; b: number; cells: number }>;
}

/** The sky's level by altitude, from the cells that are certainly sky (see the file comment). */
export function skyByAltitude(shots: SurveyShot[], anchorLevel: number, alts = shots.map(cellAltitudes)): SkyModel {
  const per = new Map<number, Array<[number, number, number]>>();
  shots.forEach((s, k) => {
    const { gw, gh, dark, stars, texture, cr, cb } = s.stats;
    // texture against the frame's own sky-like cells: the certain sky is the smooth part
    const tx = Array.from(texture).sort((a, b) => a - b);
    const smooth = tx[Math.floor(tx.length * 0.5)] ?? 0;
    for (let gy = 0; gy < gh; gy += SAMPLE_STEP) {
      for (let gx = 0; gx < gw; gx += SAMPLE_STEP) {
        const i = gy * gw + gx;
        let star = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = gy + dy;
          const xx = gx + dx;
          if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) star += stars[yy * gw + xx];
        }
        // certain sky: a verified star, smooth, and not a silhouette (the high sky is darker than the anchor's, so
        // the test is the median against a low bar, not the darker quartile)
        if (!star || dark[i] < 0.3 * anchorLevel || texture[i] > smooth * 1.5) continue;
        const band = Math.floor(alts[k][i] / BAND_DEG);
        if (alts[k][i] < 0) continue;
        let list = per.get(band);
        if (!list) per.set(band, (list = []));
        list.push([dark[i], cr[i], cb[i]]);
      }
    }
  });
  const bands = [...per.entries()]
    .filter(([, v]) => v.length >= BAND_MIN_CELLS)
    .map(([b, v]) => {
      const mid = (k: 0 | 1 | 2) => v.map((x) => x[k]).sort((x, y) => x - y)[Math.floor(v.length / 2)];
      const level = Math.max(SKY_MODEL_RANGE[0] * anchorLevel, Math.min(SKY_MODEL_RANGE[1] * anchorLevel, mid(0)));
      return { alt: (b + 0.5) * BAND_DEG, level, r: mid(1), b: mid(2), cells: v.length };
    })
    .sort((a, b) => a.alt - b.alt);
  const interp = (alt: number, key: 'level' | 'r' | 'b'): number => {
    if (alt <= bands[0].alt) return bands[0][key];
    const last = bands[bands.length - 1];
    if (alt >= last.alt) return last[key];
    for (let k = 1; k < bands.length; k++) {
      if (alt <= bands[k].alt) {
        const a = bands[k - 1];
        const b = bands[k];
        const t = (alt - a.alt) / (b.alt - a.alt);
        return a[key] + t * (b[key] - a[key]);
      }
    }
    return last[key];
  };
  const at = (alt: number): number => (bands.length ? interp(alt, 'level') : anchorLevel);
  const colourAt = (alt: number) => (bands.length ? { r: interp(alt, 'r'), b: interp(alt, 'b') } : null);
  return { at, colourAt, bands };
}

export interface Solved {
  frames: PanoFrame[];
  evidence: Evidence[];
  sl: Skyline;
  prof: Profile;
  sky: SkyModel;
}

/** Evidence against the sky at each cell's altitude, the panorama, the skyline and the profile. */
/**
 * Hot pixels: a "star" at the same place on the sensor in many frames of different pointings is the
 * camera's (a real star moves across the frames as the scope turns). Those cells are cleared in
 * every frame. Returns how many cells were cleared.
 */
export function clearHotPixels(shots: SurveyShot[]): number {
  if (shots.length < 6) return 0;
  const same = shots.filter((s) => s.stats.gw === shots[0].stats.gw && s.stats.gh === shots[0].stats.gh);
  const count = new Uint16Array(shots[0].stats.stars.length);
  for (const s of same) for (let i = 0; i < count.length; i++) if (s.stats.stars[i]) count[i]++;
  const limit = Math.max(3, Math.ceil(same.length * 0.2));
  let cleared = 0;
  for (let i = 0; i < count.length; i++) {
    if (count[i] < limit) continue;
    cleared++;
    for (const s of same) s.stats.stars[i] = 0;
  }
  return cleared;
}

/** One frame's own sky, by altitude. */
export interface FrameSky {
  at(altDeg: number): number;
  colourAt(altDeg: number): { r: number; b: number };
  /** the sky's texture and level in this frame, at the highest band it could read */
  texture: number;
  level: number;
}

const medianOf = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const limited = (v: number, from: number, step: number) => Math.max(from - step, Math.min(from + step, v));

/**
 * The sky as this frame saw it, band by band of altitude. Frames differ from each other far more
 * than one sky by altitude allows, and the sky changes inside a frame too: twilight and town glow
 * brighten toward the horizon, and each still has its own white balance and noise (2026-11-07: whole
 * frames read as obstruction up to 80°; 2026-11-08: a single level per frame flagged the bright low
 * sky). Bands are read from the top of the frame down, on the smooth cells that are not silhouettes.
 * Each band may differ from the one above only by a limited step, which a sky gradient stays within
 * and the edge of a lit wall does not, so a wall cannot become its own reference.
 * Null when no band can be read: the frame is then judged against the sky by altitude.
 */
export function frameSky(s: SurveyShot, alts: Float32Array, model: SkyModel): FrameSky | null {
  const { gw, gh, dark, texture, cr, cb } = s.stats;
  const perBand = new Map<number, number[]>();
  for (let i = 0; i < gw * gh; i++) {
    if (alts[i] < 0) continue;
    const band = Math.floor(alts[i] / FRAME_BAND_DEG);
    let list = perBand.get(band);
    if (!list) perBand.set(band, (list = []));
    list.push(i);
  }
  const bands: Array<{ alt: number; level: number; r: number; b: number }> = [];
  let limit = 0;
  let tex = 0;
  let last: { level: number; r: number; b: number } | null = null;
  for (const key of [...perBand.keys()].sort((x, y) => y - x)) {
    const cells = perBand.get(key)!;
    const alt = (key + 0.5) * FRAME_BAND_DEG;
    const enough = (k: number) => k >= FRAME_BAND_MIN_CELLS && k >= cells.length * FRAME_BAND_MIN_SHARE;
    const bright = cells.filter((i) => dark[i] >= FRAME_NOT_DARK * Math.max(model.at(alts[i]), 2 / 255));
    if (!last) {
      if (!enough(bright.length)) continue;
      tex = medianOf(bright.map((i) => texture[i]));
      limit = tex * FRAME_TEXTURE_MARGIN;
    }
    const clean = bright.filter((i) => texture[i] <= limit);
    if (!enough(clean.length)) {
      if (last) bands.push({ alt, ...last });
      continue;
    }
    const level = medianOf(clean.map((i) => dark[i]));
    const r = medianOf(clean.map((i) => cr[i]));
    const b = medianOf(clean.map((i) => cb[i]));
    const here: { level: number; r: number; b: number } = last
      ? { level: Math.max(last.level / FRAME_LEVEL_STEP, Math.min(last.level * FRAME_LEVEL_STEP, level)), r: limited(r, last.r, FRAME_COLOUR_STEP), b: limited(b, last.b, FRAME_COLOUR_STEP) }
      : { level, r, b };
    last = here;
    bands.push({ alt, ...here });
  }
  if (!bands.length) return null;
  bands.reverse();
  const interp = (alt: number, key: 'level' | 'r' | 'b'): number => {
    if (alt <= bands[0].alt) return bands[0][key];
    for (let k = 1; k < bands.length; k++) {
      if (alt <= bands[k].alt) {
        const t = (alt - bands[k - 1].alt) / (bands[k].alt - bands[k - 1].alt);
        return bands[k - 1][key] + t * (bands[k][key] - bands[k - 1][key]);
      }
    }
    return bands[bands.length - 1][key];
  };
  return {
    at: (alt) => interp(alt, 'level'),
    colourAt: (alt) => ({ r: interp(alt, 'r'), b: interp(alt, 'b') }),
    texture: Math.max(0.5 / 255, tex),
    level: bands[bands.length - 1].level,
  };
}

export function solveShots(shots: SurveyShot[], o: { skyLevel: number; skyTexture?: number; marginDeg: number }): Solved {
  clearHotPixels(shots);
  const alts = shots.map(cellAltitudes);
  const sky = skyByAltitude(shots, o.skyLevel, alts);
  const evidence = shots.map((s, k) => {
    const gw = s.stats.gw;
    const own = frameSky(s, alts[k], sky);
    const altAt = (gx: number, gy: number) => alts[k][gy * gw + gx];
    if (!own) return evidenceOf(s.stats, (gx, gy) => sky.at(altAt(gx, gy)), { skyTexture: o.skyTexture, skyLevel: o.skyLevel, skyColour: (gx, gy) => sky.colourAt(altAt(gx, gy)) });
    return evidenceOf(s.stats, (gx, gy) => own.at(altAt(gx, gy)), { skyTexture: own.texture, skyLevel: own.level, skyColour: (gx, gy) => own.colourAt(altAt(gx, gy)) });
  });
  const frames: PanoFrame[] = shots.map((s, k) => ({ evidence: evidence[k], cam: s.cam, basis: s.basis }));
  const sl = skyline(buildPanorama(frames));
  return { frames, evidence, sl, prof: profileOf(sl, o.marginDeg), sky };
}

async function jpegOf(pic: { width: number; height: number; rgb: Buffer }): Promise<Buffer> {
  return sharp(pic.rgb, { raw: { width: pic.width, height: pic.height, channels: 3 } }).jpeg({ quality: 82 }).toBuffer();
}

/** The surroundings unrolled, with the skyline (red) and the profile (yellow). */
export async function panoramaPicture(shots: SurveyShot[], skyLevel: number, s: Solved): Promise<Buffer> {
  return jpegOf(renderPanorama(shots.map((x) => ({ thumb: x.thumb, cam: x.cam, basis: x.basis })), skyLevel, s.sl, s.prof));
}

/**
 * What the solve judged, unrolled the same way: red obstruction, blue sky (the stronger, the
 * brighter), green where a verified star was found; with the skyline and the profile over it. The
 * picture to look at when a mask misses a tree or blocks open sky.
 */
export async function evidencePicture(shots: SurveyShot[], s: Solved): Promise<Buffer> {
  const thumbs = shots.map((x, k) => {
    const ev = s.evidence[k];
    const rgb = new Float32Array(ev.gw * ev.gh * 3);
    for (let i = 0; i < ev.gw * ev.gh; i++) {
      const v = ev.data[i];
      rgb[i * 3] = v > 0 ? 0.15 + 0.85 * v : 0.05;
      rgb[i * 3 + 1] = x.stats.stars[i] ? 0.9 : 0.05;
      rgb[i * 3 + 2] = v < 0 ? 0.15 - 0.85 * v : 0.05;
    }
    return { thumb: { width: ev.gw, height: ev.gh, rgb }, cam: x.cam, basis: x.basis };
  });
  // renderPanorama brightens by 0.4 / skyLevel and takes the square root: 0.4 shows the colours as they are, softened
  return jpegOf(renderPanorama(thumbs, 0.4, s.sl, s.prof));
}

// ---- kept frames

export interface SurveyRecord {
  id: string;
  driver: 'dwarf' | 'seestar';
  site: { lat: number; lon: number };
  createdAt: string;
  mode: string;
  skyLevel: number;
  skyTexture?: number;
  marginDeg: number;
  pointingResidualDeg?: number;
  notes: string[];
  frames: Array<{
    file: string;
    cam: CameraGeom;
    basis: { b: Vec; u: Vec; r: Vec };
    /** the confirmed star cells (found again in the next frame), on a grid of `grid` cells: a re-solve has one frame and cannot confirm them itself */
    stars?: number[];
    grid?: [number, number];
  }>;
}

export const surveyDir = (id: string) => path.join(config.paths.captures, 'horizon', id);

/** Kept frames are at most this long on their long side (a Seestar wide frame is 3840: 2.5 MB each, 90 MB a survey). */
const KEEP_LONG_SIDE = 1920;

/** Keeps a survey's frames on disk as they are taken. */
export class FrameKeeper {
  private n = 0;
  readonly dir: string;
  readonly files: string[] = [];

  constructor(readonly id: string) {
    this.dir = surveyDir(id);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** A frame's JPEG (the camera's own when there is one); returns its file name. Never fails the survey. */
  async keep(img: FloatImage, jpeg?: Buffer): Promise<string | null> {
    const file = `frame-${String(++this.n).padStart(3, '0')}.jpg`;
    try {
      const src = jpeg ? sharp(jpeg) : sharp(Buffer.from(floatToBytes(img)), { raw: { width: img.width, height: img.height, channels: img.channels as 1 | 3 } });
      const big = Math.max(img.width, img.height) > KEEP_LONG_SIDE;
      const buf = jpeg && !big ? jpeg : await src.resize({ width: KEEP_LONG_SIDE, height: KEEP_LONG_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
      fs.writeFileSync(path.join(this.dir, file), buf);
      this.files.push(file);
      return file;
    } catch {
      return null;
    }
  }

  write(rec: SurveyRecord): void {
    fs.writeFileSync(path.join(this.dir, 'survey.json'), JSON.stringify(rec));
  }
}

function floatToBytes(img: FloatImage): Uint8Array {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(img.data[i] * 255)));
  return out;
}

export function loadSurvey(id: string): SurveyRecord {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`"${id}" is not a survey id`);
  const f = path.join(surveyDir(id), 'survey.json');
  if (!fs.existsSync(f)) throw new Error(`survey ${id} kept no frames (only surveys from 2026-11-04 on do)`);
  return JSON.parse(fs.readFileSync(f, 'utf8')) as SurveyRecord;
}

/** The kept surveys, newest first. */
export function listSurveys(): Array<{ id: string; createdAt: string; driver: string; frames: number }> {
  const root = path.join(config.paths.captures, 'horizon');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'survey.json')))
    .map((d) => {
      const r = loadSurvey(d);
      return { id: r.id, createdAt: r.createdAt, driver: r.driver, frames: r.frames.length };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Solve a kept survey again with the current evidence; the new mask is saved for its site (the newest is the one in use). */
export async function resolveSurvey(id: string, o: { marginDeg?: number } = {}): Promise<{ mask: HorizonMask; summary: string; notes: string[]; panoramaJpeg: Buffer }> {
  const rec = loadSurvey(id);
  const shots: SurveyShot[] = [];
  for (const f of rec.frames) {
    const buf = fs.readFileSync(path.join(surveyDir(id), f.file));
    const img = await decode(buf, f.file);
    // the frame may have been kept at another size than the geometry was measured on
    const k = img.width / f.cam.width;
    const cam: CameraGeom = { width: img.width, height: img.height, f: f.cam.f * k, cx: f.cam.cx * k, cy: f.cam.cy * k };
    const stats = frameStats(img);
    if (f.stars && f.grid && f.grid[0] === stats.gw && f.grid[1] === stats.gh) {
      stats.stars.fill(0);
      for (const i of f.stars) if (i >= 0 && i < stats.stars.length) stats.stars[i] = 1;
    }
    shots.push({ stats, thumb: thumbOf(img), cam, basis: f.basis });
  }
  const margin = o.marginDeg ?? rec.marginDeg;
  const solved = solveShots(shots, { skyLevel: rec.skyLevel, skyTexture: rec.skyTexture, marginDeg: margin });
  const newId = newMaskId();
  const dir = surveyDir(id);
  const panoramaJpeg = await panoramaPicture(shots, rec.skyLevel, solved);
  fs.writeFileSync(path.join(dir, `${newId}.jpg`), panoramaJpeg);
  fs.writeFileSync(path.join(dir, `${newId}-evidence.jpg`), await evidencePicture(shots, solved));
  const notes = [`solved again from the ${shots.length} frames kept by survey ${id} (${rec.createdAt})`, ...skyNotes(solved.sky, rec.skyLevel), ...rec.notes.filter((n) => !/^sky by altitude|^solved again/.test(n))];
  const mask: HorizonMask = {
    id: newId,
    site: rec.site,
    createdAt: new Date().toISOString(),
    source: 'survey',
    profile: solved.prof.profile,
    capped: solved.prof.capped,
    survey: { mode: rec.mode, frames: shots.length, pointingResidualDeg: rec.pointingResidualDeg, marginDeg: margin, panorama: path.join('horizon', id, `${newId}.jpg`), notes },
  };
  const unknown = unknownSectors(mask);
  if (unknown.length) notes.push(`not observed (no limit applied there): ${unknown.join(', ')}`);
  saveMask(mask);
  return { mask, summary: describeMask(mask), notes, panoramaJpeg };
}

/** The kept survey a mask was solved from (its panorama lives in that survey's folder), or null. */
export function surveyIdOf(m: HorizonMask): string | null {
  const id = /^horizon[\\/]([^\\/]+)[\\/]/.exec(m.survey?.panorama ?? '')?.[1];
  return id && fs.existsSync(path.join(surveyDir(id), 'survey.json')) ? id : null;
}

/** The evidence picture beside a mask's panorama (relative to captures), when there is one. */
export function evidencePathOf(m: HorizonMask): string | null {
  const p = m.survey?.panorama?.replace(/\.jpg$/, '-evidence.jpg');
  return p && fs.existsSync(path.join(config.paths.captures, p)) ? p : null;
}

/** The sky model in a line, for the notes. */
export function skyNotes(sky: SkyModel, anchorLevel: number): string[] {
  if (!sky.bands.length) return ['sky by altitude: no band had enough certain sky (stars), so every cell was judged against the anchor\'s sky'];
  const lo = sky.bands[0];
  const hi = sky.bands[sky.bands.length - 1];
  return [`sky by altitude: ${(lo.level / anchorLevel).toFixed(2)}× the anchor's at ${lo.alt.toFixed(0)}°, ${(hi.level / anchorLevel).toFixed(2)}× at ${hi.alt.toFixed(0)}° (${sky.bands.length} bands with stars)`];
}

/** Writes the survey's record and pictures beside its frames; returns the panorama's path (relative to captures). */
export async function keepSolved(keeper: FrameKeeper, rec: Omit<SurveyRecord, 'frames'>, shots: SurveyShot[], files: Array<string | null>, solved: Solved): Promise<{ panorama: string; panoramaJpeg: Buffer }> {
  const starCells = (st: CellStats) => {
    const out: number[] = [];
    for (let i = 0; i < st.stars.length; i++) if (st.stars[i]) out.push(i);
    return out;
  };
  const frames = shots
    .map((s, k) => ({ file: files[k], cam: s.cam, basis: s.basis, stars: starCells(s.stats), grid: [s.stats.gw, s.stats.gh] as [number, number] }))
    .flatMap((f): SurveyRecord['frames'] => (f.file ? [{ ...f, file: f.file }] : []));
  keeper.write({ ...rec, frames });
  const panoramaJpeg = await panoramaPicture(shots, rec.skyLevel, solved);
  fs.writeFileSync(path.join(keeper.dir, `${rec.id}.jpg`), panoramaJpeg);
  fs.writeFileSync(path.join(keeper.dir, `${rec.id}-evidence.jpg`), await evidencePicture(shots, solved));
  return { panorama: path.join('horizon', rec.id, `${rec.id}.jpg`), panoramaJpeg };
}
