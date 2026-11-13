/**
 * Star-based focusing with the tele camera: one measured frame (`measureTele`), and a sweep of the
 * focuser around a position that scores every step and ends on the sharpest (`starFocusSweep`).
 * Both are exclusive telescope operations, and both put the camera back the way they found it.
 */
import { decode, type Crop, type FloatImage } from '../images.js';
import { fetchFile } from '../../drivers/dwarf/http.js';
import { logger, errMsg } from '../../log.js';
import { FOCUS_MAX, type Dwarf } from '../../drivers/dwarf/device.js';
import type { StreamHub } from '../streams.js';
import { median, round, sharpnessLine, starSharpness, type StarSharpness } from './sharpness.js';

const log = logger('focus');

export interface FocusDeps {
  dwarf: Dwarf;
  hub: StreamHub;
}

/** The live view restarts this long after the last still, once the camera has settled. */
const LIVE_VIEW_RESTART_MS = 1500;
/**
 * A whole sweep, its verification frame included, ends within this, under the agent's MCP call limit
 * (MCP_TIMEOUT_MS). 2026-10-13 a 17-position sweep with 2 repeats ran 16.5 min (each 6 MB tele still
 * takes ~12 s to download over the telescope's Wi-Fi); 2026-10-16 an 11 min limit cut a night sweep
 * off at 14 of 17 positions (~43 s a position).
 */
const SWEEP_DEADLINE_MS = 30 * 60_000;
/** Each position is measured at most this many times. */
const MAX_REPEATS = 3;
/** A long still pauses the live view for its exposure plus this (readout, save, the view restarting). */
const STILL_OVERHEAD_MS = 25_000;
/** Sweep defaults: centre ± DEFAULT_RANGE focus units in DEFAULT_STEP steps, at most DEFAULT_MAX_POINTS samples. */
/** The owner's fine tune: ±10 focus units at every unit (21 samples). */
const DEFAULT_RANGE = 10;
const DEFAULT_STEP = 1;
const DEFAULT_MAX_POINTS = 25;
const DEFAULT_SETTLE_MS = 700;
/** After an exposure or gain change, the camera takes this long to shoot with the new setting. */
const SETTINGS_SETTLE_MS = 1500;
/** Without a named exposure, a current one up to this is kept (if long enough for the filter); otherwise the filter's measuring exposure is used. */
const SHORT_EXPOSURE_S = 1;
const MEASURE_EXPOSURE_S = 0.5;
/**
 * A narrowband filter passes a few percent of the starlight: 2026-10-13, 0.5 s through the Duo-Band
 * showed a handful of stars in the noise, the 60 "stars" measured were mostly noise blobs, and the
 * reading (13 px HFR) was noise at a focus that was fine. Tracking keeps a few seconds trail-free.
 */
const NARROWBAND_EXPOSURE_S = 4;
const IR_PASS_EXPOSURE_S = 1;
/** Below this a narrowband measurement is noise-dominated. */
const NARROWBAND_MIN_S = 2;

export const isNarrowband = (filter: string) => /duo|band|h-?a\b|oiii/i.test(filter);

/** The exposure that shows enough stars through the tele filter in use. */
export function measureExposureFor(filter: string): number {
  if (isNarrowband(filter)) return NARROWBAND_EXPOSURE_S;
  if (/^astro/i.test(filter.trim())) return IR_PASS_EXPOSURE_S;
  return MEASURE_EXPOSURE_S;
}

/** The measuring exposure: the caller's, else the current one when it is short but long enough for the filter, else the filter's. null = keep the current one. */
function chooseExposure(asked: number | undefined, curSecs: number | null, filter: string): number | null {
  if (asked !== undefined) return asked;
  const want = measureExposureFor(filter);
  if (curSecs !== null && curSecs <= Math.max(SHORT_EXPOSURE_S, want) && curSecs >= want) return null;
  return want;
}

function filterNotes(filter: string, exposureS: number | null, tracking: boolean): string[] {
  const out: string[] = [];
  if (exposureS !== null && isNarrowband(filter) && exposureS < NARROWBAND_MIN_S) {
    out.push(`measuring through the ${filter} filter at ${exposureS}s: too few stars come through, so the reading is mostly noise — use ${NARROWBAND_EXPOSURE_S}s (the default for this filter)`);
  }
  if (exposureS !== null && exposureS > SHORT_EXPOSURE_S && !tracking) {
    out.push(`measuring at ${exposureS}s while the mount is not tracking: star trails add to the HFR`);
  }
  return out;
}

/** The tele filter in use, by name ('' when the scope does not say). */
export const filterOf = async (dwarf: Dwarf): Promise<string> => String(currentOf((await dwarf.cameraSettings('tele').catch(() => null))?.settings.filter) ?? '');
import { stillGainFloor } from './gain-floor.js';

/** A fitted optimum this close to the best sample is the best sample. */
const FIT_MIN_SHIFT = 2;
/** The best sample beats the start by more than this percentage to count as an improvement. */
const IMPROVED_PCT = 5;
/** A verification frame this much softer than the best sample is worth a note. */
const VERIFY_SOFTER = 1.08;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const currentOf = (s: unknown): unknown => (s as { current?: unknown } | undefined)?.current;

// ------------------------------------------------------------------ the shot both measure from

/**
 * The exposure and gain a focus measurement shoots at. The sweep and the single check both resolve,
 * set, shoot and restore through this, so a star_sharpness reading taken after a sweep is the same
 * kind of frame (a full tele still) at the same exposure and gain as the sweep's samples and can be
 * compared with them number for number.
 */
interface Shot {
  filter: string;
  /** the camera's exposure before, in seconds (null = auto or unreported) */
  curSecs: number | null;
  /** the exposure label the camera reported before, handed back afterwards */
  expLabel: string;
  restoreExp: string;
  /** the exposure the stills are taken at (null = the camera's own, unknown) */
  effExp: number | null;
  wantExp: number | null;
  changeExposure: boolean;
  gainNow: unknown;
  gain?: number;
  changeGain: boolean;
  notes: string[];
}

async function resolveShot(dwarf: Dwarf, o: { exposureS?: number; gain?: number }): Promise<Shot> {
  const settings = await dwarf.cameraSettings('tele');
  const expLabel = String(currentOf(settings.settings.exposure) ?? '');
  const gainNow = currentOf(settings.settings.gain);
  // exposureSeconds decodes the device's own live value: null = auto or unreported.
  const curSecs = await dwarf.exposureSeconds('tele').catch(() => null);
  const filter = String(currentOf(settings.settings.filter) ?? '');
  const wantExp = chooseExposure(o.exposureS, curSecs, filter);
  const changeExposure = wantExp !== null && (curSecs === null || Math.abs(curSecs - wantExp) > 0.01);
  const notes: string[] = [];
  // a low imaging gain left by a stack shoots black at these exposures: only a gain the caller names goes below the floor
  const floor = stillGainFloor(wantExp ?? curSecs ?? null);
  const raise = o.gain === undefined && typeof gainNow === 'number' && gainNow < floor;
  if (raise) notes.push(`gain raised from ${gainNow} to ${floor} for this measurement (a short still at the lower gain comes out black); restored afterwards`);
  const gain = raise ? floor : o.gain;
  // never a gain change that cannot be put back
  const changeGain = gain !== undefined && typeof gainNow === 'number' && gainNow !== gain;
  if (o.gain !== undefined && typeof gainNow !== 'number') notes.push(`gain left as it was: the camera has not reported its current gain, so a change could not be restored afterwards`);
  // Hand the camera back exactly what it reported, label and all: whatever it was on is the imaging
  // setting, and a long manual exposure must not come back as auto. Nothing to restore if it never said.
  // ("unknown (not reported since connect)" is a description, not a setting: it cannot be sent back)
  const reported = expLabel !== '' && !expLabel.startsWith('unknown');
  const restoreExp = reported ? expLabel : curSecs !== null ? String(curSecs) : 'auto';
  return { filter, curSecs, expLabel, restoreExp, effExp: wantExp ?? curSecs ?? null, wantExp, changeExposure, gainNow, gain, changeGain, notes };
}

const shotLabel = (s: Shot) =>
  `tele ${s.effExp ?? '?'}s${s.changeGain ? ` gain ${s.gain}` : typeof s.gainNow === 'number' ? ` gain ${s.gainNow}` : ''} (was ${s.expLabel || 'unknown'}${typeof s.gainNow === 'number' ? `, gain ${s.gainNow}` : ''}${s.changeExposure || s.changeGain ? '; restored afterwards' : ''})`;

/** What setShot changed, for restoreShot to put back (filled in as each write is made). */
interface ShotChanges {
  exposure: boolean;
  gain: boolean;
}

async function setShot(dwarf: Dwarf, s: Shot, done: ShotChanges): Promise<void> {
  if (s.changeExposure) {
    done.exposure = true;
    await dwarf.setSetting('tele', 'exposure', s.wantExp!);
  }
  if (s.changeGain) {
    done.gain = true;
    await dwarf.setSetting('tele', 'gain', s.gain!);
  }
  // 2026-11-07: a star_sharpness right after a sweep switched the exposure from auto to 0.5 s (the
  // firmware reset the gain to 160, put back to 120) and took its still 6 ms later: a much fainter
  // frame, HFR 15.7″ against the sweep's 5.3″ at the same focus. The sweep never showed it — its first
  // still comes after a focuser move and a settle. Every still waits for new settings to take hold.
  if (done.exposure || done.gain) await sleep(SETTINGS_SETTLE_MS);
}

async function restoreShot(dwarf: Dwarf, hub: StreamHub, s: Shot, done: ShotChanges, what: string): Promise<void> {
  // gain first: a gain write switches an auto exposure to manual, so the exposure goes back last
  if (done.gain) await dwarf.setSetting('tele', 'gain', s.gainNow as number).catch((e) => log.warn(`could not restore the tele gain: ${errMsg(e)}`));
  if (done.exposure) await dwarf.setSetting('tele', 'exposure', s.restoreExp).catch((e) => log.warn(`could not restore the tele exposure: ${errMsg(e)}`));
  // the stills paused the live view; nudge it back, and never let a stream that died meanwhile take the process down with it
  const cam = hub.camera('tele');
  setTimeout(() => {
    try {
      cam.retryRtsp();
    } catch (e) {
      log.warn(`the live view did not restart after ${what}: ${errMsg(e)}`);
    }
  }, LIVE_VIEW_RESTART_MS).unref();
}

/** One full tele still at the shot's settings, scored. */
async function shootStill(dwarf: Dwarf, hub: StreamHub, s: Shot, crop?: Crop): Promise<{ img: FloatImage; sharp: StarSharpness }> {
  if (s.effExp !== null && s.effExp >= 1) hub.camera('tele').expectPause(s.effExp * 1000 + STILL_OVERHEAD_MS);
  const item = await dwarf.takePhoto('tele');
  if (!item) throw new Error('the tele produced no still for the focus measurement (camera service hung? check telescope_status health)');
  const img = await decode(await fetchFile(item.filePath), `tele focus still ${s.effExp ?? 'current'}s (${item.filePath})`);
  img.capturedAt = item.modificationTime * 1000;
  return { img, sharp: starSharpness(img, { crop }) };
}

/**
 * The exposure and gain of the last sweep that completed, through the filter it ran with: a check
 * without its own exposure or gain shoots at these, so it confirms the sweep in the sweep's terms.
 * Another filter needs its own exposure, so then the check falls back to the filter's default.
 */
let lastSweepShot: { filter: string; exposureS?: number; gain?: number } | null = null;

/**
 * One tele frame, measured for focus: a full tele still taken exactly as a sweep sample is, at the
 * same exposure and gain. Without an exposure or gain named, it uses the last sweep's (through the
 * same filter); failing that, the same default the sweep would choose — the camera goes onto a short
 * exposure when it is not already on one, since a long exposure writes star trails into the reading.
 * The settings are restored afterwards, so a night's imaging settings survive a focus check.
 */
export async function measureTele({ dwarf, hub }: FocusDeps, o: { exposureS?: number; gain?: number; crop?: Crop } = {}): Promise<{ sharp: StarSharpness; img: FloatImage; settings: string }> {
  // checked before anything is changed: a refusal half way would leave the gain behind
  dwarf.assertNoOperation('a focus measurement');
  dwarf.assertNoNdLock('a focus measurement');
  dwarf.assertCameraFree('tele', 'a focus measurement');
  return dwarf.exclusive('measuring focus', async () => {
    const filter = await filterOf(dwarf);
    const fromSweep = lastSweepShot && lastSweepShot.filter === filter ? lastSweepShot : null;
    const s = await resolveShot(dwarf, { exposureS: o.exposureS ?? fromSweep?.exposureS, gain: o.gain ?? fromSweep?.gain });
    const done: ShotChanges = { exposure: false, gain: false };
    try {
      await setShot(dwarf, s, done);
      const { img, sharp } = await shootStill(dwarf, hub, s, o.crop);
      const at = Date.now();
      sharp.cautions.push(...s.notes, ...filterNotes(s.filter, s.effExp, dwarf.isTracking()));
      // Every open web UI sees the last reading, not just the one that asked for it.
      dwarf.publishState({ focusTune: { running: false, action: 'measure', startedAt: at, finishedAt: at, position: dwarf.state.focusPosition, message: sharpnessLine(sharp) } });
      const usedSweep = fromSweep && (o.exposureS === undefined || o.gain === undefined) ? ' — the last sweep’s exposure and gain' : '';
      return { img, sharp, settings: `${shotLabel(s)}${usedSweep}` };
    } finally {
      await restoreShot(dwarf, hub, s, done, 'the focus measurement');
    }
  });
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
  /** give up and use what has been measured after this long (default SWEEP_DEADLINE_MS) */
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

/** Options that cannot describe a sweep are refused before the focuser moves. */
export function checkSweepOptions(o: FocusSweepOptions): void {
  const bad = (what: string, v: unknown) => {
    throw new Error(`focus sweep: ${what} (got ${String(v)})`);
  };
  const num = (v: number | undefined) => v === undefined || Number.isFinite(v);
  if (!num(o.center) || (o.center !== undefined && (o.center < 0 || o.center > FOCUS_MAX))) bad(`center must be 0-${FOCUS_MAX}`, o.center);
  if (!num(o.range) || (o.range !== undefined && o.range < 1)) bad('range must be ≥ 1', o.range);
  if (!num(o.step) || (o.step !== undefined && o.step < 1)) bad('step must be ≥ 1', o.step);
  if (o.positions && !o.positions.every(Number.isFinite)) bad('positions must be numbers', o.positions.join(','));
  if (o.exposureS !== undefined && !(Number.isFinite(o.exposureS) && o.exposureS > 0)) bad('exposureS must be > 0', o.exposureS);
  if (o.gain !== undefined && !Number.isFinite(o.gain)) bad('gain must be a number', o.gain);
  if (!num(o.repeats) || (o.repeats !== undefined && o.repeats < 1)) bad('repeats must be ≥ 1', o.repeats);
  if (!num(o.settleMs) || (o.settleMs !== undefined && o.settleMs < 0)) bad('settleMs must be ≥ 0', o.settleMs);
  if (o.maxPoints !== undefined && (!Number.isInteger(o.maxPoints) || o.maxPoints < 3)) bad('maxPoints must be a whole number ≥ 3', o.maxPoints);
  if (!num(o.deadlineMs) || (o.deadlineMs !== undefined && o.deadlineMs <= 0)) bad('deadlineMs must be > 0', o.deadlineMs);
}

/** Positions to sample, alternating outward from the centre so slow thermal drift is symmetric. */
export function sweepPositions(center: number, o: FocusSweepOptions): { positions: number[]; notes: string[] } {
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
  const maxPoints = o.maxPoints ?? DEFAULT_MAX_POINTS;
  let step = Math.max(1, Math.round(o.step ?? DEFAULT_STEP));
  const range = Math.max(step, Math.round(o.range ?? DEFAULT_RANGE));
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
export function fitMinimum(samples: FocusSample[], bestIndex: number): number | null {
  const lo = samples[bestIndex - 1];
  const mid = samples[bestIndex];
  const hi = samples[bestIndex + 1];
  if (!lo || !hi || lo.error || mid.error || hi.error) return null;
  if (!(mid.hfrPx < lo.hfrPx && mid.hfrPx < hi.hfrPx)) return null;
  // The general three-point parabola: the positions are where the focuser actually stopped, and
  // explicit positions can be spaced any way, so equal spacing is not assumed.
  const [x1, x2, x3] = [lo.position, mid.position, hi.position];
  const [y1, y2, y3] = [lo.hfrPx, mid.hfrPx, hi.hfrPx];
  if (!(x1 < x2 && x2 < x3)) return null;
  const s1 = (y2 - y1) / (x2 - x1);
  const s2 = (y3 - y2) / (x3 - x2);
  // curvature: the change of slope across the three points (positive = a minimum)
  const curve = (s2 - s1) / (x3 - x1);
  if (!(curve > 0)) return null;
  const v = (x1 + x2) / 2 - s1 / (2 * curve);
  return Number.isFinite(v) && v > x1 && v < x3 ? v : null;
}

/**
 * Sweep the focuser around a position, score the stars at every step, and end on the sharpest.
 * The camera is put back the way it was found (exposure and gain), the focuser is left either on the
 * best position (`apply`, the default) or back at the centre it was swept around.
 */
export async function starFocusSweep(deps: FocusDeps, o: FocusSweepOptions = {}): Promise<FocusSweepResult> {
  const { dwarf } = deps;
  checkSweepOptions(o);
  const busy = dwarf.isBusy();
  if (busy) throw new Error(`refusing to sweep focus while ${busy} is running — stop it first (a refocus takes the tele camera out of a stack)`);
  dwarf.assertNoNdLock('a star-focus sweep');
  // isBusy() only sees a stack once it runs: one that is starting owns the camera too
  dwarf.assertCameraFree('tele', 'a star-focus sweep');
  // one sweep at a time: the agent and the web UI fighting over the focuser measure nothing
  return dwarf.exclusive('sweeping focus', () => sweep(deps, o));
}

async function sweep(deps: FocusDeps, o: FocusSweepOptions): Promise<FocusSweepResult> {
  const { dwarf, hub } = deps;
  const startedAt = Date.now();
  const notes: string[] = [];

  await dwarf.refreshState().catch(() => {});
  // where the focuser was before the sweep: a sweep that fails goes back there, never stays out of focus
  const origin = dwarf.state.focusPosition;
  let center = o.center ?? origin;
  if (center === undefined) {
    const inf = await dwarf.infinityFocusPosition().catch(() => null);
    if (inf === null) throw new Error('the focuser position is unknown (nothing has reported it — is the telescope connected?) and the stored infinity position did not answer either: press Connect in the web UI, or run focus_position action=get first');
    center = inf;
    notes.push(`focuser position was unknown: swept around the stored infinity position ${inf}`);
  }
  const { positions, notes: posNotes } = sweepPositions(center, o);
  notes.push(...posNotes);
  if (positions.length < 3) throw new Error(`only ${positions.length} position(s) to sample — nothing to compare; give a wider range or more positions`);

  // The same exposure and gain for every sample, or the samples do not measure the same thing;
  // resolved, set and restored exactly as a single star_sharpness check does (resolveShot).
  const shot = await resolveShot(dwarf, o);
  notes.push(...shot.notes);
  const done: ShotChanges = { exposure: false, gain: false };
  const settingsNote = shotLabel(shot);
  notes.push(...filterNotes(shot.filter, shot.effExp, dwarf.isTracking()));

  const deadline = startedAt + (o.deadlineMs ?? SWEEP_DEADLINE_MS);
  const repeats = Math.max(1, Math.min(MAX_REPEATS, Math.round(o.repeats ?? 1)));
  const total = positions.length;
  const samples: FocusSample[] = [];
  let lastPosition = Math.round(center);
  let lastMessage = 'starting';
  const publish = (patch: { total: number; index: number; position: number; best?: { position: number; hfrPx: number; score: number }; message?: string }) => {
    lastPosition = patch.position;
    if (patch.message) lastMessage = patch.message;
    dwarf.publishState({ focusTune: { running: true, action: 'sweep', startedAt, ...patch } });
  };

  const shoot = () => shootStill(dwarf, hub, shot, o.crop);

  const sampleAt = async (position: number): Promise<{ sample: FocusSample; image?: FloatImage }> => {
    const t0 = Date.now();
    const reached = await dwarf.focusTo(position);
    await sleep(o.settleMs ?? DEFAULT_SETTLE_MS);
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
    await setShot(dwarf, shot, done);
    publish({ total, index: 0, position: Math.round(center), message: 'measuring the starting position' });
    for (let i = 0; i < total; i++) {
      let sample: FocusSample;
      try {
        ({ sample } = await sampleAt(positions[i]));
      } catch (err) {
        if (i === 0 || samples.every((s) => s.error)) {
          throw new Error(`star focus could not measure ${positions[i]}: ${errMsg(err)} — check the sky (sky_check) and the camera health`);
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
      // stop while there is still time for the next sample and the verification frame: the
      // positions run outward from the centre, so what is left out is the outermost
      const perSample = (Date.now() - startedAt) / (i + 1);
      if (i + 1 < total && Date.now() + 2 * perSample > deadline) {
        notes.push(`stopped after ${i + 1} of ${total} samples (time limit ${Math.round((o.deadlineMs ?? SWEEP_DEADLINE_MS) / 60000)} min, ~${Math.round(perSample / 1000)} s a position): the outer positions were not sampled`);
        break;
      }
    }

    const measured = samples.filter((s) => !s.error).sort((a, b) => a.position - b.position);
    if (measured.length < 3) {
      throw new Error(`star focus got readings at only ${measured.length} of ${samples.length} positions: ${samples.find((s) => s.error)?.error ?? 'no stars'}`);
    }
    const bestIndex = measured.reduce((bi, s, i) => (s.hfrPx < measured[bi].hfrPx ? i : bi), 0);
    const best = measured[bestIndex];
    // A generated sweep samples the centre first, so that sample says what the focuser's own setting
    // was worth; explicit positions are sorted and may not include it at all.
    const home = Math.round(center);
    const atHome = measured.find((s) => s.position === home);
    const start = atHome ?? samples[0];
    const bestAtEdge = bestIndex === 0 || bestIndex === measured.length - 1;

    let finalPosition = best.position;
    let fittedPosition: number | undefined;
    if (o.refine !== false && !bestAtEdge) {
      const fit = fitMinimum(measured, bestIndex);
      if (fit !== null && Math.abs(fit - best.position) >= FIT_MIN_SHIFT) {
        fittedPosition = Math.round(fit);
        finalPosition = fittedPosition;
        notes.push(`fit through the samples around ${best.position} puts the optimum at ${fittedPosition}`);
      } else if (fit !== null) {
        notes.push(`the fit through the samples around ${best.position} agrees with it (less than one focus step away)`);
      }
    }

    // back where the sweep began, whether or not that position was one of the samples
    if (o.apply === false) finalPosition = home;
    publish({ total, index: total, position: finalPosition, message: o.apply === false ? 'returning to the starting position' : 'settling on the sharpest position' });
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
    if (bestAtEdge) notes.push(`the sharpest sample (${best.position}) was at the edge of the swept range: the true optimum may lie beyond it — run star_focus again with center=${best.position} and the same range and step, until the peak is inside the sweep`);
    if (final && best.hfrPx > 0 && final.hfrPx > best.hfrPx * VERIFY_SOFTER) {
      notes.push(`the verification frame at ${final.position} measured softer (HFR ${final.hfrPx}px) than the sweep sample at ${best.position} (${best.hfrPx}px): the difference is within the frame-to-frame noise of this sky`);
    }
    const verdict = [
      `star focus: best at ${best.position} (median star HFR ${best.hfrArcsec ? `${best.hfrArcsec}″` : `${best.hfrPx}px`}, score ${best.score}, ${best.stars} stars)`,
      improvementPct > IMPROVED_PCT
        ? `sharper than the ${atHome ? 'starting position' : 'first sample'} ${start.position} (HFR ${start.hfrPx}px) by ${improvementPct.toFixed(0)}%`
        : atHome
          ? `the starting position ${start.position} was already as sharp as anything in the swept range`
          : `no sharper than the first sample ${start.position} by more than ${IMPROVED_PCT}%`,
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
    // what the check that follows shoots at, so it confirms this sweep with the same kind of frame
    lastSweepShot = { filter: shot.filter, exposureS: shot.effExp ?? undefined, gain: shot.changeGain ? shot.gain : typeof shot.gainNow === 'number' ? shot.gainNow : undefined };
    // in the log too: a caller that gave up waiting still leaves the outcome on record
    log.info(`${lastMessage} — samples ${samples.map((x) => `${x.position}:${x.error ? 'failed' : `${x.hfrPx}px`}`).join(' ')}`);
    return result;
  } catch (err) {
    // 2026-10-18: a coarse sweep centred on 350 found no stars there and stopped, leaving the tele
    // 220 steps out of focus (a blank view) until someone noticed: go back to where it started
    let back = '';
    if (origin !== undefined) {
      try {
        lastPosition = await dwarf.focusTo(origin);
        back = ` — the focuser was returned to its starting position ${lastPosition}`;
      } catch (e) {
        back = ` — the focuser could NOT be returned to its starting position ${origin} (${errMsg(e)}); it is at ${dwarf.state.focusPosition ?? 'an unknown position'}`;
      }
    }
    lastMessage = `star focus failed: ${errMsg(err)}${back}`;
    throw new Error(`${errMsg(err)}${back}`);
  } finally {
    await restoreShot(dwarf, hub, shot, done, 'the focus sweep');
    dwarf.publishState({ focusTune: { running: false, action: 'sweep', startedAt, finishedAt: Date.now(), position: lastPosition, message: lastMessage } });
  }
}
