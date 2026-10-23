/**
 * The obstruction survey: the scope looks all round itself with the wide camera and the site's
 * horizon mask is built from what it saw, in true azimuth and altitude, for the planner.
 *
 * Where each still looks comes from the telescope's own plate solving, not from a level or a
 * compass: a few GoTos to sky positions ("anchors") end with the scope exactly on a known azimuth
 * and altitude; re-referencing the motors there (no park: each reset drives back to where it
 * started) gives the motor angles of that direction, and a fit of the mount to the anchors turns
 * any motor pose into a true direction (geometry.ts) — on the alt-az head and on the EQ wedge alike.
 * The anchors' stills are also the sky reference: plate-solved, so certainly sky.
 *
 * Then a sweep: two rings of stills (≈10° and ≈32° altitude, each frame ±13°) all round the
 * mechanical travel, and a ring higher up wherever an obstruction ran off the top. Every still is
 * reduced to obstruction evidence at once (mask.ts) and dropped, the panorama is built, the skyline
 * found, and the mask saved for this site. Night only (plate solving needs stars); ~15–20 min.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import type { Dwarf, HorizonSurvey } from '../../drivers/dwarf/device.js';
import { PITCH_RANGE, ROTATION_RANGE } from '../../drivers/dwarf/controller/motors.js';
import { daylightRefusal } from '../../drivers/dwarf/controller/astro.js';
import * as sky from '../../astro/sky.js';
import { compass, describeMask, newMaskId, saveMask, unknownSectors, type HorizonMask } from '../../astro/horizon.js';
import { loadImage, type FloatImage } from '../images.js';
import type { StreamHub } from '../streams.js';
import { cameraGeom, fitMount, fromAltAz, poseBasis, poseFor, type Anchor, type CameraGeom, type MountModel } from './geometry.js';
import { buildPanorama, frameEvidence, profileOf, renderPanorama, skyline, skyLevelOf, thumbOf, type Evidence, type PanoFrame, type Thumb } from './mask.js';

const log = logger('horizon');

/** Night settings for the stills (sky_check's): silhouettes black, sky glow well above them. */
const EXPOSURE_S = 2.5;
const GAIN = 60;
/** The anchor's sky level (darkest channel, 0..1) is wanted near this; outside the band the exposure is rescaled once. */
const SKY_TARGET = 40 / 255;
const SKY_LOW = 12 / 255;
const SKY_HIGH = 120 / 255;
const EXPOSURE_RANGE = [0.3, 15] as const;
/** Anchors: sky positions this high, tried in this order of azimuth; two at least, a third when the fit is loose. */
const ANCHOR_ALT = 65;
const ANCHOR_AZ = [45, 135, 225, 315, 0, 90, 180, 270];
const MIN_ANCHORS = 2;
const MAX_ANCHORS = 3;
/** Fit residual (RMS, degrees): at or below GOOD no third anchor is needed; above MAX the survey stops. */
const GOOD_FIT_DEG = 1.5;
const MAX_FIT_DEG = 3;
/** Calibrations the survey may run when a GoTo needs one (the motor resets can lose it). */
const MAX_CALIBRATIONS = 3;
/** Sweep rings (frame centre altitude): the wide frame spans ±13°, so these cover −3…45°. Then higher where capped. */
const RINGS = [10, 32];
const HIGH_RINGS = [54, 76];
/** Alt-az: rotation stops (inside the 0–315° travel; the 45° frame covers the rest of the circle). */
const ALTAZ_ROTATIONS = [2, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 313];
/** EQ (and the high rings): frame centres this far apart in azimuth. */
const AZ_STEP = 25;
const MOVE_SPEED_DEG_S = 15;
/** The profile is raised this much above the measured skyline. */
const MARGIN_DEG = 1;
/** The whole survey ends within this (under the agent's 30 min call limit); a sweep cut short keeps what it saw. */
const DEADLINE_MS = 27 * 60_000;
/** Of the time left, keep this for building and saving after the last still. */
const BUILD_RESERVE_MS = 60_000;
const STOPPED = 'the obstruction survey was stopped by request; the scope was left where it stopped';
const HFOV_FALLBACK = 45.06;

export interface SurveyDeps {
  dwarf: Dwarf;
  hub: StreamHub;
}

export interface SurveyOptions {
  /** plate-solve calibrate first, at the current pointing (otherwise only when a GoTo needs it) */
  calibrate?: boolean;
  exposureS?: number;
  gain?: number;
  marginDeg?: number;
}

export interface SurveyResult {
  mask: HorizonMask;
  summary: string;
  notes: string[];
  panoramaJpeg: Buffer;
}

interface Shot {
  evidence: Evidence;
  thumb: Thumb;
  cam: CameraGeom;
  rotationDeg: number;
  pitchDeg: number;
}

let stopRequested = false;

export const surveyRunning = (dwarf: Dwarf) => !!dwarf.state.horizonSurvey?.running;

/** Stop a running survey: the GoTo or calibration it waits on ends at once, the rest at the next step. */
export async function stopSurvey(dwarf: Dwarf): Promise<boolean> {
  if (!surveyRunning(dwarf)) return false;
  stopRequested = true;
  await dwarf.stopGoto().catch((e) => log.warn(`stopping the survey's GoTo: ${errMsg(e)}`));
  await dwarf.stopMotion().catch((e) => log.warn(`stopping the survey's motion: ${errMsg(e)}`));
  return true;
}

/** The wide camera's geometry for a frame of this size: its field from the telescope, the pointing at the tele boresight. */
function wideCamera(dwarf: Dwarf, img: FloatImage): CameraGeom {
  const st = dwarf.state;
  const hfov = st.fov?.wide?.h && st.fov.wide.h > 10 ? st.fov.wide.h : HFOV_FALLBACK;
  // the tele's field inside the wide frame (1920×1080 units): the mount's pointing, ~0.5° off centre
  const t = st.teleInWide;
  const bore = t && t.width > 0 && t.height > 0 ? { x: (t.x + t.width / 2) / 1920, y: (t.y + t.height / 2) / 1080 } : { x: 0.5, y: 0.5 };
  return cameraGeom(img.width, img.height, hfov, bore);
}

/** The axis the mount turns about: the zenith on the alt-az head; on the wedge the polar axis the calibration measured. */
function mountPole(dwarf: Dwarf, lat: number, notes: string[]): { az: number; alt: number } {
  const r = dwarf.state.calibration.result;
  if (dwarf.state.bodyMode === 'eq') {
    if (r && Math.abs(r.altitude - lat) < 15) return { az: r.azimuth, alt: r.altitude };
    notes.push(r ? `the calibration's polar axis (az ${r.azimuth.toFixed(1)}°, alt ${r.altitude.toFixed(1)}°) is far from the pole, so the true pole was used` : 'no polar axis from the calibration, so the true pole was used');
    return { az: lat >= 0 ? 0 : 180, alt: Math.abs(lat) };
  }
  return r && r.altitude > 80 ? { az: r.azimuth, alt: r.altitude } : { az: 0, alt: 90 };
}

/** Sweep poses for a ring: alt-az by rotation stops, EQ (and partial rings) through the fitted mount. */
function ringPoses(model: MountModel, mode: 'eq' | 'altaz', alt: number, azimuths?: number[]): Array<{ rotationDeg: number; pitchDeg: number }> {
  const ranges = { rotation: ROTATION_RANGE, pitch: PITCH_RANGE };
  const out: Array<{ rotationDeg: number; pitchDeg: number }> = [];
  if (mode === 'altaz' && !azimuths) {
    const pitch = alt + 90 - model.pitchOffset;
    if (pitch >= PITCH_RANGE[0] && pitch <= PITCH_RANGE[1]) for (const r of ALTAZ_ROTATIONS) out.push({ rotationDeg: r, pitchDeg: Math.round(pitch * 10) / 10 });
    return out;
  }
  const azs = azimuths ?? Array.from({ length: Math.ceil(360 / AZ_STEP) }, (_, i) => i * AZ_STEP);
  for (const az of azs) {
    const p = poseFor(model, fromAltAz(az, alt), ranges);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.rotationDeg - b.rotationDeg);
}

/** Frame centres covering the capped bins: each centre takes the capped bins within AZ_STEP/2 of it. */
export function cappedAzimuths(capped: number[]): number[] {
  const out: number[] = [];
  const near = (k: number) => out.some((c) => Math.abs(((k + 0.5 - c + 540) % 360) - 180) <= AZ_STEP / 2);
  for (const k of [...capped].sort((a, b) => a - b)) if (!near(k)) out.push((k + 0.5 + AZ_STEP / 2) % 360);
  return out;
}

async function encodePicture(pic: { width: number; height: number; rgb: Buffer }): Promise<Buffer> {
  return sharp(pic.rgb, { raw: { width: pic.width, height: pic.height, channels: 3 } }).jpeg({ quality: 82 }).toBuffer();
}

/** The survey's refusals, checked before anything is sent (a caller starting it in the background answers with them). Returns the site. */
export function assertSurveyAllowed(dwarf: Dwarf) {
  if (surveyRunning(dwarf)) throw new Error('an obstruction survey is already running');
  dwarf.assertNoNdLock('the obstruction survey');
  dwarf.assertNoOperation('the obstruction survey');
  dwarf.assertCameraFree('wide', 'the obstruction survey');
  const loc = dwarf.requireLocation();
  const refusal = daylightRefusal('the obstruction survey (its pointing comes from plate solving)', loc, new Date(), config.observer.timezone);
  if (refusal) throw new Error(refusal);
  return loc;
}

/**
 * Run the survey. One exclusive operation; refused under the ND filter, during another operation,
 * while a stack owns the wide camera, and in daylight. The camera's gain and exposure are put back.
 */
export async function surveyObstructions({ dwarf, hub }: SurveyDeps, o: SurveyOptions = {}): Promise<SurveyResult> {
  const loc = assertSurveyAllowed(dwarf);

  const startedAt = Date.now();
  const deadline = startedAt + DEADLINE_MS;
  const mode: 'eq' | 'altaz' = dwarf.state.bodyMode === 'eq' ? 'eq' : 'altaz';
  const margin = o.marginDeg ?? MARGIN_DEG;
  const gain = o.gain ?? GAIN;
  let exposure = o.exposureS ?? EXPOSURE_S;
  const notes: string[] = [];
  let phase = 'starting';
  const progress = (patch: Partial<HorizonSurvey> = {}) => dwarf.publishState({ horizonSurvey: { running: true, phase, startedAt, ...patch } });
  const checkStop = () => {
    if (stopRequested) throw new Error(STOPPED);
  };
  stopRequested = false;
  progress({ message: 'starting' });

  try {
    const result = await dwarf.exclusive('mapping site obstructions', async () => {
      // camera: night settings for the run, the previous ones back afterwards (as sky_check)
      const settings = await dwarf.cameraSettings('wide');
      const prevGain = (settings.settings.gain as { current?: unknown } | undefined)?.current;
      const restoreErrors: string[] = [];
      await dwarf.setSetting('wide', 'gain', gain);
      try {
        const shoot = async () => {
          checkStop();
          const { img } = await loadImage('wide', hub, { exposureS: exposure });
          return img;
        };
        const shots: Shot[] = [];
        const keep = (img: FloatImage, level: number, pos: { rotationDeg: number; pitchDeg: number }) => {
          shots.push({ evidence: frameEvidence(img, level), thumb: thumbOf(img), cam: wideCamera(dwarf, img), ...pos });
        };

        // ---- anchors
        let calibrations = 0;
        const calibrate = async (why: string) => {
          if (calibrations >= MAX_CALIBRATIONS) throw new Error(`a GoTo needs a calibration and the survey has already run ${MAX_CALIBRATIONS} (${why})`);
          calibrations++;
          phase = 'calibrating';
          progress({ message: `plate-solve calibration (${why})` });
          await dwarf.calibrate();
        };
        if (o.calibrate) await calibrate('asked for');
        const anchors: Anchor[] = [];
        let skyLevel: number | null = null;
        let fit: ReturnType<typeof fitMount> | null = null;
        let pole = mountPole(dwarf, loc.lat, notes);
        // EQ: one-click GoTos, which plate-solve and refine at the anchor. A plain GoTo on the wedge can end
        // far off (2026-10-21: SE and SW at 65° read rotation 131.3° and 300.5°, one-click 141.6° and 176.9°,
        // the 35° their hour angles differ by).
        const oneClick = mode === 'eq';
        for (const az of ANCHOR_AZ) {
          if (anchors.length >= MAX_ANCHORS || (anchors.length >= MIN_ANCHORS && fit && fit.residualDeg <= GOOD_FIT_DEG)) break;
          checkStop();
          if (Date.now() > deadline - 15 * 60_000) {
            notes.push('the anchors took too long to try more of them');
            break;
          }
          phase = 'anchor';
          progress({ index: anchors.length + 1, total: MIN_ANCHORS, message: `GoTo the ${compass(az)} sky at ${ANCHOR_ALT}° to fix the pointing` });
          const label = `survey anchor ${compass(az)}`;
          let target = sky.raDecFromAltAz(loc, az, ANCHOR_ALT);
          try {
            try {
              await dwarf.gotoRaDec(target.raHours, target.decDeg, label, oneClick);
            } catch (e) {
              if (stopRequested) throw e;
              // no calibration yet, or lost with the last anchor's motor resets: calibrate where the scope looks (the last anchor's sky)
              await calibrate(`the GoTo said: ${errMsg(e)}`);
              pole = mountPole(dwarf, loc.lat, notes);
              phase = 'anchor';
              target = sky.raDecFromAltAz(loc, az, ANCHOR_ALT);
              await dwarf.gotoRaDec(target.raHours, target.decDeg, label, oneClick);
            }
          } catch (e) {
            if (stopRequested) throw new Error(STOPPED);
            notes.push(`anchor ${compass(az)} failed: ${errMsg(e)}`);
            log.warn(`survey anchor ${compass(az)} failed: ${errMsg(e)}`);
            continue;
          }
          checkStop();
          // the scope tracks the target until the reset stops it (or, EQ, the read): that instant is where it points
          let stopAt = new Date();
          let pos;
          if (mode === 'eq') {
            // On the wedge the motors keep their reference through the GoTo and its tracking (2026-10-21:
            // read at once after it, the pose agreeing with the Moon's to ~1°), while a reset does not
            // reliably drive back to where it started (the same sky read rotation 256.9° then 1.6°) and
            // moves the reference from under the telescope's own EQ alignment. So: read, no reset.
            pos = await dwarf.readMotorPositions();
          } else try {
            progress({ message: `re-referencing the motors at the ${compass(az)} anchor` });
            pos = await dwarf.rereferenceMotors();
          } catch (e) {
            if (stopRequested || !/stopped at its reference switch/.test(errMsg(e))) throw e;
            // the pose is lost: GoTo the anchor again and re-reference once more
            notes.push(`anchor ${compass(az)}: ${errMsg(e)}; went to it again`);
            log.warn(`survey anchor ${compass(az)}: ${errMsg(e)}; going to it again`);
            try {
              target = sky.raDecFromAltAz(loc, az, ANCHOR_ALT);
              await dwarf.gotoRaDec(target.raHours, target.decDeg, label, false);
              checkStop();
              stopAt = new Date();
              pos = await dwarf.rereferenceMotors();
            } catch (e2) {
              if (stopRequested) throw new Error(STOPPED);
              notes.push(`anchor ${compass(az)} failed again: ${errMsg(e2)}`);
              log.warn(`survey anchor ${compass(az)} failed again: ${errMsg(e2)}`);
              continue;
            }
          }
          if (pos.rotationDeg === undefined || pos.pitchDeg === undefined) {
            notes.push(`anchor ${compass(az)}: no motor position after the reset`);
            continue;
          }
          const where = sky.altAz(loc, target.raHours, target.decDeg, stopAt);
          anchors.push({ rotationDeg: pos.rotationDeg, pitchDeg: pos.pitchDeg, az: where.azimuth, alt: where.altitude });
          log.info(`survey anchor ${compass(az)}: rotation ${pos.rotationDeg}°, pitch ${pos.pitchDeg}° = az ${where.azimuth.toFixed(2)}°, alt ${where.altitude.toFixed(2)}°`);
          // the sky reference, from the first anchor; one exposure correction when it is far off
          let img = await shoot();
          if (skyLevel === null) {
            let level = skyLevelOf(img);
            if (level < SKY_LOW || level > SKY_HIGH) {
              const before = exposure;
              exposure = Math.round(Math.max(EXPOSURE_RANGE[0], Math.min(EXPOSURE_RANGE[1], (exposure * SKY_TARGET) / Math.max(level, 1 / 255))) * 10) / 10;
              if (exposure !== before) {
                notes.push(`the sky read ${Math.round(level * 255)}/255 at ${before}s, so the stills were taken at ${exposure}s`);
                img = await shoot();
                level = skyLevelOf(img);
              }
            }
            skyLevel = level;
          }
          keep(img, skyLevel, pos as { rotationDeg: number; pitchDeg: number });
          fit = fitMount(pole, anchors);
        }
        if (!anchors.length || !fit || skyLevel === null) {
          throw new Error(`no anchor worked, so the survey has no true pointing and nothing was swept. ${notes.join('; ')}. Point the scope at clear sky (sky_check), calibrate, and run it again.`);
        }
        if (fit.residualDeg > MAX_FIT_DEG) {
          throw new Error(
            `the anchors disagree by ${fit.residualDeg.toFixed(1)}° (the mount is not level, or a motor reset did not return to where it started), so a mask would be misplaced; nothing was swept. Anchors: ${anchors.map((a) => `rot ${a.rotationDeg} pitch ${a.pitchDeg} → az ${a.az.toFixed(1)} alt ${a.alt.toFixed(1)}`).join('; ')}`,
          );
        }
        if (anchors.length === 1) notes.push('only one anchor worked: the pointing is fitted but not cross-checked');
        const model = fit.model;
        log.info(`survey mount fit: λ0 ${model.lambda0.toFixed(2)}°, sense ${model.sense}, pitch offset ${model.pitchOffset.toFixed(2)}°, residual ${fit.residualDeg.toFixed(2)}° over ${anchors.length} anchor(s)`);

        // ---- sweep
        const sweep = async (poses: Array<{ rotationDeg: number; pitchDeg: number }>, what: string) => {
          for (let i = 0; i < poses.length; i++) {
            checkStop();
            if (Date.now() > deadline - BUILD_RESERVE_MS) {
              notes.push(`time limit: ${what} stopped after ${i} of ${poses.length} stills`);
              return false;
            }
            phase = 'sweep';
            progress({ index: i + 1, total: poses.length, message: `${what}: still ${i + 1} of ${poses.length}` });
            await dwarf.moveTo(poses[i], MOVE_SPEED_DEG_S);
            const pos = await dwarf.readMotorPositions();
            const at = pos.rotationDeg !== undefined && pos.pitchDeg !== undefined ? { rotationDeg: pos.rotationDeg, pitchDeg: pos.pitchDeg } : poses[i];
            keep(await shoot(), skyLevel!, at);
          }
          return true;
        };
        // one pass per ring, alternating direction so the rotation does not unwind between rings
        let finished = true;
        for (const [k, alt] of RINGS.entries()) {
          const poses = ringPoses(model, mode, alt);
          if (k % 2) poses.reverse();
          if (!(finished = await sweep(poses, `ring at ${alt}°`))) break;
        }
        const build = () => {
          const frames: PanoFrame[] = shots.map((s) => ({ evidence: s.evidence, cam: s.cam, basis: poseBasis(model, s.rotationDeg, s.pitchDeg) }));
          const sl = skyline(buildPanorama(frames));
          return { frames, sl, prof: profileOf(sl, margin) };
        };
        let built = build();
        // higher where an obstruction ran off the top of what was photographed
        for (const alt of HIGH_RINGS) {
          if (!finished || !built.prof.capped.length) break;
          const poses = ringPoses(model, mode, alt, cappedAzimuths(built.prof.capped));
          if (!poses.length) break;
          phase = 'build';
          progress({ message: `obstructions reach the top of the frames in ${built.prof.capped.length} directions: looking higher` });
          finished = await sweep(poses, `higher ring at ${alt}°`);
          built = build();
        }

        // ---- the mask
        phase = 'build';
        progress({ message: 'building the horizon mask' });
        const id = newMaskId();
        const pic = renderPanorama(
          shots.map((s, i) => ({ thumb: s.thumb, cam: s.cam, basis: built.frames[i].basis })),
          skyLevel,
          built.sl,
          built.prof,
        );
        const panoramaJpeg = await encodePicture(pic);
        const rel = path.join('horizon', `${id}.jpg`);
        fs.mkdirSync(path.join(config.paths.captures, 'horizon'), { recursive: true });
        fs.writeFileSync(path.join(config.paths.captures, rel), panoramaJpeg);
        if (built.prof.capped.length) notes.push(`${built.prof.capped.length} directions are blocked to at least the top of what was photographed (marked "capped"): taller than the mask says there`);
        const mask: HorizonMask = {
          id,
          site: { lat: loc.lat, lon: loc.lon },
          createdAt: new Date().toISOString(),
          source: 'survey',
          profile: built.prof.profile,
          capped: built.prof.capped,
          survey: { mode, frames: shots.length, pointingResidualDeg: Math.round(fit.residualDeg * 100) / 100, marginDeg: margin, panorama: rel, notes },
        };
        const unknown = unknownSectors(mask);
        if (unknown.length) notes.push(`not observed (no limit applied there): ${unknown.join(', ')}`);
        saveMask(mask);

        // back up to the first anchor's sky
        phase = 'returning';
        progress({ message: 'returning to the first anchor' });
        await dwarf.moveTo({ rotationDeg: anchors[0].rotationDeg, pitchDeg: anchors[0].pitchDeg }, MOVE_SPEED_DEG_S).catch((e) => notes.push(`could not return to the first anchor: ${errMsg(e)}`));
        if (mode === 'altaz') notes.push('the motor resets may have cleared the plate-solve calibration: use a one-click GoTo (or calibrate) for the next target');
        return { mask, summary: describeMask(mask), notes, panoramaJpeg };
      } finally {
        if (typeof prevGain === 'number') await dwarf.setSetting('wide', 'gain', prevGain).catch((e) => restoreErrors.push(`gain: ${errMsg(e)}`));
        if (restoreErrors.length) notes.push(`the wide gain was NOT restored (${restoreErrors.join('; ')}): set it back to ${String(prevGain)}`);
      }
    });
    dwarf.publishState({ horizonSurvey: { running: false, phase: 'done', startedAt, finishedAt: Date.now(), message: result.summary, maskId: result.mask.id } });
    return result;
  } catch (err) {
    const msg = errMsg(err);
    dwarf.publishState({ horizonSurvey: { running: false, phase, startedAt, finishedAt: Date.now(), error: msg } });
    throw err;
  } finally {
    stopRequested = false;
  }
}
