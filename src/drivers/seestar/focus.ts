/**
 * Star focus with the Seestar: one measured tele frame, and a sweep of the focuser around a
 * position that scores every step on full-resolution tele frames and ends on the sharpest. The
 * shared measure (media/focus) and the Dwarf's result shape; the Seestar's own focus scale
 * (0 – max_step, about 2600) and frames from the picture socket.
 */
import { errMsg, logger } from '../../log.js';
import { fitMinimum, type FocusSample, type FocusSweepResult } from '../../media/focus.js';
import { sharpnessLine, starSharpness, type StarSharpness } from '../../media/focus/sharpness.js';
import type { FloatImage } from '../../media/images.js';
import type { Seestar } from './device.js';

const log = logger('seestar.focus');

export const NOMINAL_FOV = { h: 1.2, v: 2.13 };
/** The owner's fine tune: ±10 focus steps at every step (21 samples). */
const DEFAULT_RANGE = 10;
const DEFAULT_STEP = 1;
const MAX_POINTS = 21;
const SETTLE_MS = 800;
const FRAMES_PER_POSITION = 2;
const GRAB_TIMEOUT_MS = 60_000;
/** binned frames in a row before bin 1 is asked for again */
const REBIN_AFTER = 3;
/** a sample this much coarser than the sweep's finest is another bin, not comparable */
const COARSER_THAN = 1.2;

export interface SeestarSweepOptions {
  center?: number;
  range?: number;
  step?: number;
  apply?: boolean;
  /** wait after each focuser move before the frame (default 800 ms) */
  settleMs?: number;
  onProgress?: (sample: FocusSample, index: number, total: number) => void;
}

/**
 * One full-resolution tele frame, measured (the tele is borrowed if the wide is selected). Frames
 * narrower than the sensor are bin-2 previews still in flight after the switch to bin 1 (2026-11-14
 * C 34: the first 2-5 samples of every sweep came back at 4.6″/px; their HFR in px is half a
 * full-res frame's, so they won the sweep and sent it chasing a false edge): they are discarded,
 * bin 1 asked for again while they keep coming, and no measurement is made from one.
 */
export async function measureSeestar(scope: Seestar): Promise<{ sharp: StarSharpness; img: FloatImage }> {
  await scope.ensureLiveView();
  return scope.withCamera('tele', 'a star measurement', () =>
    scope.withFullRes('tele', 'a star measurement', async () => {
      const fullW = scope.state.device.chipSize?.[0];
      const until = Date.now() + GRAB_TIMEOUT_MS;
      let img: FloatImage | undefined;
      let taken = 0;
      let binned = 0;
      while (taken < FRAMES_PER_POSITION) {
        const left = until - Date.now();
        if (left <= 0) throw new Error(`no full-resolution tele frame in ${GRAB_TIMEOUT_MS / 1000} s (${binned} binned frame(s) discarded)`);
        const frame = await scope.grabImage('tele', 'preview', left);
        const w = frame.image.frameWidth ?? frame.image.width;
        if (fullW && w < fullW) {
          binned++;
          if (binned % REBIN_AFTER === 0) await scope.applyBin('binned frames during a star measurement').catch((e) => log.warn(`camera bin: ${errMsg(e)}`));
          continue;
        }
        img = frame.image;
        taken++;
      }
      if (binned) log.info(`star measurement: ${binned} binned frame(s) discarded before the full-resolution one`);
      const fovH = (scope.state.fov ?? NOMINAL_FOV).h;
      return { sharp: starSharpness(img!, { arcsecPerPx: (fovH * 3600) / (img!.frameWidth ?? img!.width) }), img: img! };
    }),
  );
}

function sampleOf(position: number, s: StarSharpness, seconds: number): FocusSample {
  return {
    position,
    score: s.score,
    hfrPx: s.ok ? s.hfrPx : Number.POSITIVE_INFINITY,
    hfrArcsec: s.hfrArcsec,
    arcsecPerPx: s.arcsecPerPx,
    hfrUncertaintyPx: s.hfrUncertaintyPx,
    stars: s.starsUsed,
    saturated: s.saturatedStars,
    seconds,
    ...(s.ok ? {} : { error: s.blocking ?? 'no stars measured' }),
    ...(s.cautions.length ? { cautions: s.cautions } : {}),
  };
}

export async function seestarFocusSweep(scope: Seestar, o: SeestarSweepOptions = {}): Promise<FocusSweepResult> {
  const busy = scope.isBusy();
  if (busy) throw new Error(`refusing to sweep focus while ${busy} is running — stop it first`);
  if (scope.state.mount.parked) throw new Error('the arm is parked: open it and point at stars first');
  const startedAt = Date.now();
  const notes: string[] = [];
  const max = scope.state.focus.maxStep ?? 2600;
  const origin = (await scope.focuserPosition()) ?? undefined;
  const center = Math.round(o.center ?? origin ?? NaN);
  if (!Number.isFinite(center)) throw new Error('the focuser position is unknown');
  const step = Math.max(1, Math.round(o.step ?? DEFAULT_STEP));
  let range = Math.max(step, Math.round(o.range ?? DEFAULT_RANGE));
  if ((2 * range) / step + 1 > MAX_POINTS) {
    range = Math.floor((MAX_POINTS - 1) / 2) * step;
    notes.push(`range narrowed to ±${range} to keep the sweep under ${MAX_POINTS} samples`);
  }
  const positions: number[] = [];
  for (let p = center - range; p <= center + range; p += step) if (p >= 0 && p <= max) positions.push(p);
  if (positions.length < 3) throw new Error(`only ${positions.length} focus position(s) inside 0–${max}: nothing to compare`);
  await scope.ensureLiveView();

  const samples: FocusSample[] = [];
  const measureAt = async (p: number): Promise<FocusSample> => {
    const t0 = Date.now();
    const at = (await scope.focusTo(p)) ?? p;
    await new Promise((r) => setTimeout(r, o.settleMs ?? SETTLE_MS));
    try {
      return sampleOf(at, (await measureSeestar(scope)).sharp, (Date.now() - t0) / 1000);
    } catch (e) {
      return { position: at, score: 0, hfrPx: Number.POSITIVE_INFINITY, hfrUncertaintyPx: 0, stars: 0, saturated: 0, seconds: (Date.now() - t0) / 1000, error: errMsg(e) };
    }
  };
  try {
    await scope.withCamera('tele', 'the focus sweep', () =>
      scope.withFullRes('tele', 'the focus sweep', async () => {
        await scope.focusTo(Math.max(0, positions[0]! - step));
        for (const [i, p] of positions.entries()) {
          const s = await measureAt(p);
          samples.push(s);
          o.onProgress?.(s, i, positions.length);
          log.info(`focus sweep ${i + 1}/${positions.length}: ${p} → ${s.error ?? `HFR ${s.hfrPx.toFixed(2)} px (${s.stars} stars)`}`);
        }
      }),
    );
  } catch (e) {
    if (origin !== undefined) await scope.focusTo(origin).catch(() => undefined);
    throw e;
  }
  // HFR is in pixels: only samples at one plate scale compare. Any that is coarser than the finest
  // (a binned frame that got through) is set aside rather than allowed to win the sweep.
  const scales = samples.filter((s) => !s.error && s.arcsecPerPx).map((s) => s.arcsecPerPx!);
  const finest = scales.length ? Math.min(...scales) : undefined;
  let coarse = 0;
  if (finest) for (const s of samples) {
    if (!s.error && s.arcsecPerPx && s.arcsecPerPx > finest * COARSER_THAN) {
      s.error = `a ${s.arcsecPerPx.toFixed(1)}″/px (binned) frame, not comparable with the ${finest.toFixed(1)}″/px ones: left out`;
      coarse++;
    }
  }
  if (coarse) notes.push(`${coarse} sample(s) came from binned frames and were left out of the fit`);
  const good = samples.filter((s) => !s.error && Number.isFinite(s.hfrPx));
  const start = samples.find((s) => s.position === center) ?? samples[Math.floor(samples.length / 2)]!;
  if (good.length < 3) {
    if (origin !== undefined) await scope.focusTo(origin).catch(() => undefined);
    const why = samples.find((s) => s.error)?.error ?? 'too few stars';
    return {
      start,
      samples,
      best: start,
      finalPosition: origin ?? center,
      bestAtEdge: false,
      improvementPct: 0,
      verdict: `No focus could be judged: ${good.length} of ${samples.length} positions showed measurable stars (${why}). The focuser is back at ${origin ?? center}.`,
      notes,
      settings: 'tele full-resolution frames',
      elapsedS: Math.round((Date.now() - startedAt) / 1000),
    };
  }
  const bestIndex = samples.reduce((bi, s, i) => (!s.error && s.hfrPx < samples[bi]!.hfrPx ? i : bi), samples.findIndex((s) => !s.error));
  const best = samples[bestIndex]!;
  const fitted = fitMinimum(samples, bestIndex);
  // the edge of what was measured: a peak next to left-out samples has nothing beyond it either
  const firstGood = samples.findIndex((s) => !s.error);
  const lastGood = samples.length - 1 - [...samples].reverse().findIndex((s) => !s.error);
  const bestAtEdge = bestIndex === firstGood || bestIndex === lastGood;
  const target = o.apply === false ? (origin ?? center) : Math.round(fitted ?? best.position);
  await scope.focusTo(Math.max(0, target - step));
  const finalPosition = (await scope.focusTo(target)) ?? target;
  const final = await measureAt(finalPosition).catch(() => undefined);
  const startHfr = Number.isFinite(start.hfrPx) ? start.hfrPx : best.hfrPx;
  const improvementPct = Math.round(((startHfr - best.hfrPx) / startHfr) * 100);
  if (bestAtEdge) notes.push(`PEAK AT THE EDGE: the sharpest position (${best.position}) is at the edge of the sweep, so the best focus may lie beyond it: run star_focus again with center=${best.position} and the same range and step, until the peak is inside the sweep`);
  const verdict = `${o.apply === false ? 'Measured' : 'Focused'}: sharpest at ${best.position} (HFR ${best.hfrPx.toFixed(2)} px${best.hfrArcsec ? `, ${best.hfrArcsec.toFixed(1)}″` : ''})${fitted ? `, fitted ${fitted.toFixed(0)}` : ''}; the focuser is at ${finalPosition}${final && !final.error ? ` (HFR ${final.hfrPx.toFixed(2)} px)` : ''}.`;
  return { start, samples, best, finalPosition, final, fittedPosition: fitted ?? undefined, bestAtEdge, improvementPct, verdict, notes, settings: 'tele full-resolution frames', elapsedS: Math.round((Date.now() - startedAt) / 1000), arcsecPerPx: best.arcsecPerPx };
}

export { sharpnessLine };
