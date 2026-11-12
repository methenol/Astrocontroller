/**
 * The obstruction survey with a Seestar: the scope looks all round itself with the wide camera and
 * the site's horizon mask is built from what it saw, in true azimuth and altitude, with the same
 * panorama, skyline and profile as the Dwarf's survey (media/horizon/mask.ts).
 *
 *  1. Pointing. A GoTo (plate-solved and centred on the tele) to the sky at ANCHOR_ALT syncs the
 *     mount, so its own alt/az reading is the true pointing from then on. Without it a survey is
 *     placed by the compass and level, degrees off.
 *  2. The wide camera. It has its own focuser (second_focuser, 0-1023), and move_focuser moves the
 *     focuser of whichever camera is selected: a tele focus step sent while the wide was selected
 *     moved the wide instead, and wide stills went soft (Starfront, 2026-10-29: stars as faint
 *     rings). The survey puts it at its factory infinity (sharp beyond ~2 m at 6 mm f/5) and checks
 *     the anchor's stars; when they are few it sweeps the focuser around there on the star count.
 *     The sky reference, its exposure and its noise come from the same anchor frame.
 *  3. The sweep: two rings of wide frames (frame centres at RINGS altitudes, every AZ_STEP of
 *     azimuth) by scope_goto, each frame placed by the mount's reported alt/az. A frame's
 *     orientation follows from the mount (verified 2026-11-04 on an S50 Pro in EQ mode: the tilt
 *     axis moves the picture up and down, up toward the celestial pole, right is west), so its
 *     "up" is the mount's pole projected across the field: the celestial pole on the wedge, the
 *     zenith in alt-az. A ring higher up is added where an obstruction ran off the top.
 *  4. The solve (media/horizon/solve.ts, the Dwarf's too: each cell judged against the sky at its
 *     altitude), the mask, the panorama and the evidence pictures; the frames are kept under
 *     captures/horizon/<id>/ so the survey can be solved again later (resolve_obstructions).
 *
 * Night only (the GoTo plate-solves, the evidence needs the night's silhouettes); ~15-25 min.
 */
import { errMsg, logger } from '../../log.js';
import * as sky from '../../astro/sky.js';
import { compass, describeMask, newMaskId, saveMask, unknownSectors, type HorizonMask } from '../../astro/horizon.js';
import type { FloatImage } from '../../media/images.js';
import { cameraGeom, fromAltAz, type Vec } from '../../media/horizon/geometry.js';
import { confirmStars, dropStars, frameStats, hotCells, skyLevelOf, skyTexture, starCount, thumbOf, type CellStats, type PanoFrame } from '../../media/horizon/mask.js';
import { FrameKeeper, keepSolved, skyNotes, solveShots, type SurveyShot } from '../../media/horizon/solve.js';
import type { Seestar } from './device.js';

const log = logger('seestar.horizon');

/** The anchor: a sky position this high, toward the south (north in the southern hemisphere). */
const ANCHOR_ALT = 65;
/**
 * Frame centres: the wide frame is ~31° across and ~54° tall (portrait), so one ring at 22° covers
 * about −5…49° (tilted on the wedge it still spans ±27°), and a ring higher up is added only where
 * an obstruction ran off the top. A RAW frame per pointing takes ~20 s over Wi-Fi, so pointings
 * are kept few.
 */
const RINGS = [22];
const HIGH_RING = 55;
const AZ_STEP = 24;
/** The wide camera's horizontal field (the short side), measured 2026-11-04: 67-70 px/° on the 2160 px frame. */
export const WIDE_HFOV_DEG = 31;
/** Verified stars the anchor's wide frame needs: fewer and the focus is swept; still fewer and the survey stops. */
const ANCHOR_STARS_GOOD = 25;
const ANCHOR_STARS_MIN = 8;
/** The wide focus sweep around the factory position (steps), judged on the verified star count. */
const FOCUS_OFFSETS = [-60, -40, -20, 0, 20, 40, 60];
/**
 * The survey's frames are the wide's RAW subs, not its live JPEGs: in a star view the JPEG is
 * auto-exposed and tone-mapped (exposure, gain and the ISP settings change nothing), and at a
 * light-polluted site a porch-lit wall, a dark window and the sky came out within a few levels of
 * each other (2026-11-05). RAW at 4 s, gain as it is: sky ~256 counts above the black level
 * (σ ~95), the lit wall 2.5× that in its darkest channel and warm, the window darker than the sky.
 * The survey runs at 3 s (the live JPEG's cadence is ~3 s anyway).
 *
 * The JPEGs are still the better source of stars (corrected by the camera, low noise per pixel; in
 * RAW the 7σ cut passed 3 stars where the JPEG had 71): each pointing takes its confirmed stars
 * from two JPEG frames and its evidence (levels, colour, texture) from one RAW frame. The two share
 * the evidence grid (240 cells across either way) and the mount tracks between them.
 */
const RAW_EXPOSURE_MS = 3000;
/** The 12-bit sensor's offset in the 16-bit RAW counts (measured 2026-11-05: values step by 64, the shadows sit at 4096). */
const RAW_BLACK = 4096 / 65535;
/**
 * The wide lens's vignetting in RAW (the JPEG path corrects it, RAW does not): the sky's level by
 * distance from the centre (0 = centre, 1 = corner) in 0.1 steps, measured on a sky frame near the
 * zenith (2026-11-05, green channel; red and blue agree within their 64-count steps). Uncorrected,
 * the frame's dim edges read as dark obstructions.
 */
export const WIDE_VIGNETTING = [1, 0.95, 0.9, 0.85, 0.75, 0.7, 0.6, 0.55, 0.5, 0.45];

/** The vignetting at a pixel's distance from the centre (fraction of the half-diagonal), interpolated. */
export function vignetting(r: number): number {
  const t = Math.max(0, Math.min(WIDE_VIGNETTING.length - 1, r * WIDE_VIGNETTING.length - 0.5));
  const k = Math.floor(t);
  const f = t - k;
  return WIDE_VIGNETTING[k] * (1 - f) + (WIDE_VIGNETTING[Math.min(k + 1, WIDE_VIGNETTING.length - 1)] ?? WIDE_VIGNETTING[k]) * f;
}

/** RAW → black level off, flat-fielded (vignetting), times `scale`, clamped to 0..1. */
export function flattenRaw(img: FloatImage, scale: number): FloatImage {
  const { width: W, height: H } = img;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.hypot(cx, cy);
  const data = new Float32Array(img.data.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const g = scale / vignetting(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R);
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) data[o + c] = Math.max(0, Math.min(1, (img.data[o + c] - RAW_BLACK) * g));
    }
  }
  return { ...img, data, linear: false };
}

/** RAW frames are scaled so the anchor's sky (its darker cells) sits here, where the evidence's thresholds were set. */
const SKY_NORM = 40 / 255;
const MARGIN_DEG = 1;
const SUN_DOWN_DEG = -12;
const DEADLINE_MS = 27 * 60_000;
/** over the ZWO tunnel every call takes 10-15 s and a wide frame tens of seconds (2026-11-12) */
const TUNNEL_DEADLINE_MS = 75 * 60_000;
const BUILD_RESERVE_MS = 60_000;
/**
 * Frames from the wide after a move: the first may have been exposing while it moved and is
 * dropped; of the next two, the second is the survey's and the first confirms its stars (a star
 * is found again, noise is not).
 */
const FRAMES_DROPPED_AFTER_MOVE = 1;
const STOPPED = 'the obstruction survey was stopped by request; the scope was left where it stopped';

export interface SeestarSurveyState {
  [k: string]: unknown;
  running: boolean;
  phase: string;
  startedAt: number;
  finishedAt?: number;
  index?: number;
  total?: number;
  message?: string;
  error?: string;
  maskId?: string;
}

export interface SurveyOutcome {
  mask: HorizonMask;
  summary: string;
  notes: string[];
  panoramaJpeg?: Buffer;
}

interface Shot extends SurveyShot {
  alt: number;
  az: number;
  file: string | null;
}

/** A wide frame: the image, and the camera's own JPEG of it when there is one (kept as it is). */
export interface WideFrame {
  image: FloatImage;
  jpeg?: Buffer;
}

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec): Vec => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Where a wide frame looks and how it is turned: pointing b, "up" the mount's pole projected across
 * the field, "right" b × up (west when looking south).
 */
export function frameBasis(azDeg: number, altDeg: number, pole: { az: number; alt: number }): PanoFrame['basis'] {
  const b = fromAltAz(azDeg, altDeg);
  const p = fromAltAz(pole.az, pole.alt);
  let u: Vec = [p[0] - dot(p, b) * b[0], p[1] - dot(p, b) * b[1], p[2] - dot(p, b) * b[2]];
  // pointing at the pole itself: any up will do (the survey never does)
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) u = [0, 0, 1];
  u = unit(u);
  return { b, u, r: cross(b, u) };
}

/** The axis the Seestar turns about: the celestial pole on the wedge (EQ mode), the zenith in alt-az. */
export function mountPole(eqMode: boolean, latDeg: number): { az: number; alt: number } {
  if (!eqMode) return { az: 0, alt: 90 };
  return latDeg >= 0 ? { az: 0, alt: latDeg } : { az: 180, alt: -latDeg };
}

export class SeestarSurvey {
  private stopping = false;
  private running = false;

  constructor(
    private readonly scope: Seestar,
    /** the next wide frame (the live JPEG) */
    private readonly wideFrame: () => Promise<WideFrame>,
    /** one RAW wide frame, exposed after the call (linear, half-size colour); without it the JPEGs are used */
    private readonly rawFrame?: () => Promise<FloatImage>,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  private publish(s: SeestarSurveyState): void {
    this.scope.state.horizonSurvey = s;
    this.scope.changed();
  }

  assertAllowed(o: { rehearsal?: boolean } = {}): void {
    if (this.running) throw new Error('the obstruction survey is already running');
    const busy = this.scope.isBusy();
    if (busy) throw new Error(`refused: ${busy} is running`);
    if (!this.scope.state.connected) throw new Error('the Seestar is not connected');
    if (this.scope.isStacking()) throw new Error('refused: the Seestar is stacking (stop the stack first)');
    const site = this.scope.requireLocation();
    const sun = sky.bodyAlt(site, 'Sun');
    if (sun > SUN_DOWN_DEG && !o.rehearsal) throw new Error(`the obstruction survey needs a dark sky (the Sun is at ${sun.toFixed(0)}°; it must be below ${SUN_DOWN_DEG}°)`);
  }

  /** Stop at the next step; a slew in progress is aborted. */
  stop(): boolean {
    if (!this.running) return false;
    this.stopping = true;
    void this.scope.abortSlew().catch(() => undefined);
    return true;
  }

  /**
   * `rehearsal`: everything but the sky — no dark-sky check, no plate-solved anchor (the mount's
   * own pointing is used), no star requirement, and the mask is NOT saved (the planner is not
   * touched); the frames and pictures are kept. For checking the mechanics indoors or by day.
   */
  async run(o: { marginDeg?: number; rehearsal?: boolean } = {}): Promise<SurveyOutcome> {
    this.assertAllowed(o);
    this.running = true;
    this.stopping = false;
    const startedAt = Date.now();
    const deadline = startedAt + (this.scope.state.connection === 'zwo' ? TUNNEL_DEADLINE_MS : DEADLINE_MS);
    const notes: string[] = [];
    const site = this.scope.requireLocation();
    const margin = o.marginDeg ?? MARGIN_DEG;
    const id = newMaskId();
    let phase = 'anchor';
    const progress = (patch: Partial<SeestarSurveyState> = {}) => this.publish({ running: true, phase, startedAt, ...patch });
    const checkStop = () => {
      if (this.stopping) throw new Error(STOPPED);
    };
    if (o.rehearsal) notes.push('REHEARSAL: no plate-solved anchor, no star check, and this mask was not saved for the site');
    try {
      // ---- 1. the pointing, from a plate-solved GoTo
      const anchorAz = site.lat >= 0 ? 180 : 0;
      if (o.rehearsal) {
        progress({ message: `rehearsal: slewing (no plate solve) to the ${compass(anchorAz)} sky at ${ANCHOR_ALT}°` });
        await this.scope.slewAltAz(anchorAz, ANCHOR_ALT);
      } else {
      progress({ message: `GoTo the ${compass(anchorAz)} sky at ${ANCHOR_ALT}°: the telescope plate-solves there and the mount's pointing is true from then on` });
      const target = sky.raDecFromAltAz(site, anchorAz, ANCHOR_ALT);
      try {
        await this.scope.gotoTarget({ raHours: target.raHours, decDeg: target.decDeg, name: 'Obstruction survey anchor' });
      } catch (e) {
        checkStop();
        throw new Error(`the anchor GoTo did not plate-solve (${errMsg(e)}): the survey has no true pointing, so nothing was mapped. It needs a clear sky above ${ANCHOR_ALT}° (roof open, no cloud).`);
      }
      }
      checkStop();
      // the scope's own stack_after_goto may have started a stack: the sweep moves the scope
      await this.scope.refreshState().catch(() => undefined);
      if (this.scope.isStacking()) {
        await this.scope.stopStack().catch((e) => notes.push(`could not stop the stack the GoTo started: ${errMsg(e)}`));
        await new Promise((r) => setTimeout(r, 2000));
      }

      const outcome = await this.scope.withCamera('wide', 'the obstruction survey', async () => {
        // ---- 2. the wide camera: focus, exposure, the sky reference
        phase = 'focus';
        const restore: Array<() => Promise<unknown>> = [];
        try {
          progress({ message: 'checking the wide camera\'s focus and exposure on the anchor\'s stars' });
          await this.scope.refreshState().catch(() => undefined);
          const factory = await this.scope.wideFactoryFocus().catch(() => null);
          const was = this.scope.state.wideFocus.position;
          if (factory !== null && was !== undefined && Math.abs(was - factory) > 3) {
            notes.push(`the wide camera's focuser was at ${was}, away from its factory infinity ${factory}: moved it back (its stills were out of focus)`);
            log.warn(`survey: wide focuser at ${was}, factory ${factory}: moving it back`);
          }
          if (factory !== null) await this.scope.focusTo(factory, 'wide');
          // the survey's exposure (the RAW frames'; the JPEG is auto-exposed whatever it is), put back after
          const cont = await this.scope.liveExposureMs('wide').catch(() => null);
          if (this.rawFrame) {
            await this.scope.setExposure({ continuousMs: RAW_EXPOSURE_MS }, 'wide');
            if (cont !== null) restore.push(() => this.scope.setExposure({ continuousMs: cont }, 'wide'));
            notes.push(`frames: the wide camera's RAW subs at ${RAW_EXPOSURE_MS / 1000} s for the evidence (its live JPEG is auto-exposed and flattens the scene), its JPEGs for the stars`);
          }
          let scale: number | null = null;
          /** RAW → the black level off, scaled so the anchor's sky reads SKY_NORM (a JPEG frame is left as it is) */
          const norm = (img: FloatImage): FloatImage => {
            if (!img.linear) return img;
            if (scale === null) {
              const flat = flattenRaw(img, 1);
              const v: number[] = [];
              for (let i = 0; i < flat.data.length; i += 3 * 37) v.push(Math.min(flat.data[i], flat.data[i + 1], flat.data[i + 2]));
              v.sort((a, b) => a - b);
              const sky = v[Math.floor(v.length * 0.3)] ?? 0;
              scale = SKY_NORM / Math.max(64 / 65535, sky);
              log.info(`survey: RAW sky ${(sky * 65535).toFixed(0)} counts above black, scale ${scale.toFixed(1)}`);
            }
            return flattenRaw(img, scale);
          };
          /** cells of the sensor's hot pixels (found at the anchor), cleared from every frame */
          let hot: Uint8Array | null = null;
          /** A settled frame and its statistics, its stars confirmed by the frame before it. */
          const fresh = async (): Promise<WideFrame & { stats: CellStats }> => {
            for (let k = 0; k < FRAMES_DROPPED_AFTER_MOVE; k++) {
              checkStop();
              await this.wideFrame();
            }
            checkStop();
            const before = frameStats((await this.wideFrame()).image);
            checkStop();
            const f = await this.wideFrame();
            return { image: f.image, jpeg: f.jpeg, stats: dropStars(confirmStars(frameStats(f.image), before), hot) };
          };
          /**
           * The pointing's frame for the evidence: a RAW frame (flat-fielded and scaled), its stars the
           * JPEGs' (`stars`, confirmed); without RAW, the JPEG frame itself.
           */
          const evidenceFrame = async (jpeg: WideFrame & { stats: CellStats }): Promise<WideFrame & { stats: CellStats }> => {
            if (!this.rawFrame) return jpeg;
            checkStop();
            const image = norm(await this.rawFrame());
            const stats = frameStats(image);
            if (stats.gw === jpeg.stats.gw && stats.gh === jpeg.stats.gh) stats.stars.set(jpeg.stats.stars);
            else stats.stars.fill(0);
            return { image, stats };
          };
          let anchor = await fresh();
          let anchorStats = anchor.stats;
          // hot pixels: turn the scope ~1.5° and see which "stars" stayed on the same pixels
          {
            const before = starCount(anchorStats);
            await this.scope.nudge(90, 50, 1.1);
            const moved = await fresh();
            hot = hotCells(anchorStats, moved.stats);
            dropStars(anchorStats, hot);
            const n = hot.reduce((a, v) => a + v, 0);
            log.info(`survey: ${before} confirmed stars at the anchor, ${before - starCount(anchorStats)} of them hot pixels (${n} cells masked)`);
            // the nudged frame is a sky frame too, and the anchor frame from now on
            anchor = moved;
            anchorStats = dropStars(moved.stats, hot);
          }
          let level = skyLevelOf(anchorStats);
          let stars = starCount(anchorStats);
          log.info(`survey anchor (wide): ${stars} verified stars, sky ${(level * 255).toFixed(1)}/255, focuser ${this.scope.state.wideFocus.position ?? '?'}`);
          if (stars < ANCHOR_STARS_GOOD && factory !== null && !o.rehearsal) {
            // soft or faint: sweep the focuser round the factory position on the star count
            let best = { pos: factory, stars, stats: anchorStats, img: anchor };
            // stopped (or failed) in the middle of the sweep: the focuser goes back where it was
            restore.push(async () => {
              if (!sweptFocus) await this.scope.focusTo(factory, 'wide');
            });
            let sweptFocus = false;
            for (const off of FOCUS_OFFSETS) {
              if (!off) continue;
              checkStop();
              const pos = Math.max(0, Math.min(this.scope.state.wideFocus.maxStep ?? 1023, factory + off));
              progress({ message: `focusing the wide camera on the stars: ${pos} (${best.stars} stars at ${best.pos} so far)` });
              await this.scope.focusTo(pos, 'wide');
              const img = await fresh();
              const st = img.stats;
              const n = starCount(st);
              if (n > best.stars) best = { pos, stars: n, stats: st, img };
            }
            await this.scope.focusTo(best.pos, 'wide');
            sweptFocus = true;
            if (best.pos !== factory) notes.push(`the wide focus was best at ${best.pos} (${best.stars} stars; ${stars} at the factory ${factory})`);
            ({ stars, stats: anchorStats, img: anchor } = best);
            level = skyLevelOf(anchorStats);
          }
          if (stars < ANCHOR_STARS_MIN && !o.rehearsal) {
            throw new Error(`the wide camera shows ${stars} stars at the anchor (at least ${ANCHOR_STARS_MIN} are needed): cloud, dew on the lens, or the roof is closing. Nothing was mapped.`);
          }
          // the sky reference from the anchor's RAW frame (the scale for every RAW frame is set by it)
          const anchorRaw = await evidenceFrame({ ...anchor, stats: anchorStats });
          anchor = anchorRaw;
          anchorStats = anchorRaw.stats;
          level = skyLevelOf(anchorStats);
          const texture = skyTexture(anchorStats, level);
          const pole = mountPole(!!this.scope.state.mount.eqMode, site.lat);
          const keeper = new FrameKeeper(id);
          const shots: Shot[] = [];
          const shotOf = async (f: WideFrame, stats: CellStats): Promise<Shot> => {
            const p = await this.scope.readPointing();
            if (p.azDeg === undefined || p.altDeg === undefined) throw new Error('the Seestar did not report where it points');
            const img = f.image;
            return { stats, thumb: thumbOf(img), cam: cameraGeom(img.width, img.height, WIDE_HFOV_DEG), basis: frameBasis(p.azDeg, p.altDeg, pole), alt: p.altDeg, az: p.azDeg, file: await keeper.keep(img, f.jpeg) };
          };
          const shoot = async (): Promise<Shot> => {
            const f = await evidenceFrame(await fresh());
            return shotOf(f, f.stats);
          };
          // the anchor frame is a sky frame of the survey too
          shots.push(await shotOf(anchor, anchorStats));

          // ---- 3. the sweep
          const sweep = async (poses: Array<{ az: number; alt: number }>, what: string) => {
            for (let i = 0; i < poses.length; i++) {
              checkStop();
              if (Date.now() > deadline - BUILD_RESERVE_MS) {
                notes.push(`time limit: ${what} stopped after ${i} of ${poses.length} frames`);
                return false;
              }
              phase = 'sweep';
              const { az, alt } = poses[i];
              progress({ index: i + 1, total: poses.length, message: `${what}: frame ${i + 1} of ${poses.length} (az ${az}°, alt ${alt}°)` });
              // a refused slew (fw 9.75 answered "fail to operate" 207 once in a ring, 2026-11-04) is tried once more
              let moved = false;
              for (let attempt = 0; attempt < 2 && !moved; attempt++) {
                try {
                  if (attempt) await new Promise((r) => setTimeout(r, 2000));
                  await this.scope.slewAltAz(az, alt);
                  moved = true;
                } catch (e) {
                  checkStop();
                  if (attempt) {
                    notes.push(`az ${az}° alt ${alt}°: ${errMsg(e)}`);
                    log.warn(`survey: az ${az}° alt ${alt}°: ${errMsg(e)}`);
                  }
                }
              }
              if (!moved) continue;
              shots.push(await shoot());
            }
            return true;
          };
          const ring = (alt: number, azs?: number[]) => (azs ?? Array.from({ length: 360 / AZ_STEP }, (_, i) => i * AZ_STEP)).map((az) => ({ az, alt }));
          let finished = true;
          for (const [k, alt] of RINGS.entries()) {
            const poses = ring(alt);
            // the second ring the other way round: the mount does not unwind between them
            if (k % 2) poses.reverse();
            if (!(finished = await sweep(poses, `ring at ${alt}°`))) break;
          }
          const build = () => solveShots(shots, { skyLevel: level, skyTexture: texture, marginDeg: margin });
          phase = 'build';
          let built = build();
          if (finished && built.prof.capped.length) {
            const azs = cappedAzimuths(built.prof.capped);
            progress({ message: `obstructions reach the top of the frames in ${built.prof.capped.length} directions: looking higher` });
            finished = await sweep(ring(HIGH_RING, azs), `higher ring at ${HIGH_RING}°`);
            built = build();
          }

          // ---- 4. the mask
          phase = 'build';
          progress({ message: 'building the horizon mask' });
          const mode = this.scope.state.mount.eqMode ? 'seestar-eq' : 'seestar-altaz';
          notes.push(...skyNotes(built.sky, level));
          const { panorama: rel, panoramaJpeg } = await keepSolved(keeper, { id, driver: 'seestar', site: { lat: site.lat, lon: site.lon }, createdAt: new Date().toISOString(), mode, skyLevel: level, skyTexture: texture, marginDeg: margin, notes }, shots, shots.map((x) => x.file), built);
          if (built.prof.capped.length) notes.push(`${built.prof.capped.length} directions are blocked to at least the top of what was photographed (marked "capped"): taller than the mask says there`);
          notes.push(`pointing from the plate-solved anchor; frames placed by the mount's alt/az (${this.scope.state.mount.eqMode ? 'EQ: up toward the celestial pole' : 'alt-az: up toward the zenith'}); the wide camera's centre can sit up to ~1° from the tele's, inside the ${margin}° margin`);
          const mask: HorizonMask = {
            id,
            site: { lat: site.lat, lon: site.lon },
            createdAt: new Date().toISOString(),
            source: 'survey',
            profile: built.prof.profile,
            capped: built.prof.capped,
            survey: { mode, frames: shots.length, pointingResidualDeg: 0, marginDeg: margin, panorama: rel, notes },
          };
          const unknown = unknownSectors(mask);
          if (unknown.length) notes.push(`not observed (no limit applied there): ${unknown.join(', ')}`);
          if (!o.rehearsal) saveMask(mask);
          return { mask, summary: describeMask(mask), notes, panoramaJpeg };
        } finally {
          for (const r of restore) await r().catch((e) => notes.push(`could not restore a camera setting: ${errMsg(e)}`));
        }
      });
      this.publish({ running: false, phase: 'done', startedAt, finishedAt: Date.now(), message: outcome.summary, maskId: outcome.mask.id });
      return outcome;
    } catch (e) {
      const msg = this.stopping ? STOPPED : errMsg(e);
      this.publish({ running: false, phase, startedAt, finishedAt: Date.now(), error: msg });
      throw this.stopping ? new Error(STOPPED) : e;
    } finally {
      this.running = false;
      this.stopping = false;
    }
  }
}

/** Frame centres covering the capped 1° bins, AZ_STEP apart. */
export function cappedAzimuths(capped: number[]): number[] {
  const out: number[] = [];
  const near = (k: number) => out.some((c) => Math.abs(((k + 0.5 - c + 540) % 360) - 180) <= AZ_STEP / 2);
  for (const k of [...capped].sort((a, b) => a - b)) if (!near(k)) out.push(Math.round((k + 0.5 + AZ_STEP / 2) % 360));
  return out;
}

