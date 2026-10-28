/**
 * Focus on the stars with the Seestar: one measured frame, and a sweep of the focuser around a
 * position that scores every step on the tele camera's raw preview and ends on the sharpest. The
 * shared measure (media/focus) and the Dwarf's result shape; the Seestar's own focus scale
 * (0 – max_step, about 2600) and frames from the image socket.
 */
import { errMsg, logger } from '../../log.js';
import { fitMinimum, type FocusSample, type FocusSweepResult } from '../../media/focus.js';
import { sharpnessLine, starSharpness, type StarSharpness } from '../../media/focus/sharpness.js';
import type { FloatImage } from '../../media/images.js';
import type { Seestar } from './device.js';
import { NOMINAL_FOV } from './mcp.js';

const log = logger('focus');

const DEFAULT_RANGE = 40;
const DEFAULT_STEP = 10;
const MAX_POINTS = 21;
const SETTLE_MS = 800;
/** a frame exposed before the focuser stopped measures the old position: wait out one more */
const FRAMES_PER_POSITION = 2;
const GRAB_TIMEOUT_MS = 60_000;

export interface SeestarSweepOptions {
  center?: number;
  range?: number;
  step?: number;
  /** leave the focuser on the sharpest position (default true) */
  apply?: boolean;
  onProgress?: (sample: FocusSample, index: number, total: number) => void;
}

/** One raw tele frame, measured. */
export async function measureSeestar(scope: Seestar): Promise<{ sharp: StarSharpness; img: FloatImage }> {
  let frame = await scope.grabImage('tele', 'preview', GRAB_TIMEOUT_MS);
  for (let i = 1; i < FRAMES_PER_POSITION; i++) frame = await scope.grabImage('tele', 'preview', GRAB_TIMEOUT_MS);
  const img = frame.image;
  const fovH = (scope.state.fov ?? NOMINAL_FOV).h;
  return { sharp: starSharpness(img, { arcsecPerPx: (fovH * 3600) / (img.frameWidth ?? img.width) }), img };
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
  // one direction, low to high: the focuser's backlash is the same at every sample
  const positions: number[] = [];
  for (let p = center - range; p <= center + range; p += step) if (p >= 0 && p <= max) positions.push(p);
  if (positions.length < 3) throw new Error(`only ${positions.length} focus position(s) inside 0–${max}: nothing to compare`);
  await scope.ensureLiveView();

  const samples: FocusSample[] = [];
  const measureAt = async (p: number): Promise<FocusSample> => {
    const t0 = Date.now();
    const at = (await scope.focusTo(p)) ?? p;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    try {
      return sampleOf(at, (await measureSeestar(scope)).sharp, (Date.now() - t0) / 1000);
    } catch (e) {
      return { position: at, score: 0, hfrPx: Number.POSITIVE_INFINITY, hfrUncertaintyPx: 0, stars: 0, saturated: 0, seconds: (Date.now() - t0) / 1000, error: errMsg(e) };
    }
  };
  try {
    // the start: where the focuser was, measured from the same side as the sweep
    await scope.focusTo(Math.max(0, positions[0] - step));
    for (const [i, p] of positions.entries()) {
      const s = await measureAt(p);
      samples.push(s);
      o.onProgress?.(s, i, positions.length);
      log.info(`focus sweep ${i + 1}/${positions.length}: ${p} → ${s.error ?? `HFR ${s.hfrPx.toFixed(2)} px (${s.stars} stars)`}`);
    }
  } catch (e) {
    if (origin !== undefined) await scope.focusTo(origin).catch(() => {});
    throw e;
  }
  const good = samples.filter((s) => !s.error && Number.isFinite(s.hfrPx));
  const start = samples.find((s) => s.position === center) ?? samples[Math.floor(samples.length / 2)];
  if (good.length < 3) {
    if (origin !== undefined) await scope.focusTo(origin).catch(() => {});
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
      settings: 'tele raw preview',
      elapsedS: Math.round((Date.now() - startedAt) / 1000),
    };
  }
  const bestIndex = samples.reduce((bi, s, i) => (!s.error && s.hfrPx < samples[bi].hfrPx ? i : bi), samples.findIndex((s) => !s.error));
  const best = samples[bestIndex];
  const fitted = fitMinimum(samples, bestIndex);
  const bestAtEdge = bestIndex === 0 || bestIndex === samples.length - 1;
  const target = o.apply === false ? (origin ?? center) : Math.round(fitted ?? best.position);
  // approached from below like every sample, so the backlash matches the curve
  await scope.focusTo(Math.max(0, target - step));
  const finalPosition = (await scope.focusTo(target)) ?? target;
  const final = await measureAt(finalPosition).catch(() => undefined);
  const startHfr = Number.isFinite(start.hfrPx) ? start.hfrPx : best.hfrPx;
  const improvementPct = Math.round(((startHfr - best.hfrPx) / startHfr) * 100);
  if (bestAtEdge) notes.push('the sharpest position was at the edge of the sweep: the best focus may lie beyond it, run it again centred there');
  const verdict = `${o.apply === false ? 'Measured' : 'Focused'}: sharpest at ${best.position} (HFR ${best.hfrPx.toFixed(2)} px${best.hfrArcsec ? `, ${best.hfrArcsec.toFixed(1)}″` : ''})${fitted ? `, fitted ${fitted.toFixed(0)}` : ''}; the focuser is at ${finalPosition}${final && !final.error ? ` (HFR ${final.hfrPx.toFixed(2)} px)` : ''}.`;
  return { start, samples, best, finalPosition, final, fittedPosition: fitted ?? undefined, bestAtEdge, improvementPct, verdict, notes, settings: 'tele raw preview', elapsedS: Math.round((Date.now() - startedAt) / 1000), arcsecPerPx: best.arcsecPerPx };
}

export { sharpnessLine };
