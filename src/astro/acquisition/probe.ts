/**
 * Shooting the collection quality engine's test cohorts (quality.ts) and turning them into
 * samples, as a background job the agent starts after focusing and polls:
 *
 * - each point is shot through the driver's ProbeDriver into a temp folder under
 *   <data>/tmp/quality/<job> — a Seestar's single raw subs off the live view, a Dwarf's short
 *   stack whose subs are copied off the SD card and whose session is then deleted from it — and
 *   the folder is removed when the job ends, whatever happened: nothing lands in the library, no
 *   dataset is left on the scope, and nothing is queued for transfer;
 * - while a job runs `probing()` is true and the journal's recorder ignores the scope's stacks, so
 *   a probe never opens a session, counts as integration or teaches the planner a cadence;
 * - each cohort is analysed (cohort.ts), stored as a sample of THIS target, and after the batch
 *   the target is solved again: when the solve asks for more (the best at the edge of the tested
 *   subs, a clouded point), those are shot too, within the engine's budget;
 * - every valid cohort is ground truth for the rig and the site too: a sky sample (in astronomical
 *   dark with the Moon down and the target high it counts toward the site's measured zenith sky,
 *   the rule acquisition_measure keeps) and a seeing sample (the stars' FWHM against the forecast);
 * - the job ends with the settings to collect with, and one line in the night's journal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import * as sky from '../sky.js';
import type { HourConditions } from '../weather.js';
import { magForRate } from './advise.js';
import { analyzeCohort, type CohortSource } from './cohort.js';
import { deviceKey, recordQuality, recordSeeing, recordSky, recordSubLength, type QualitySample } from './store.js';
import { readRaw, type RawFrame } from './measure.js';
import { skyBrightness, zenithFromMeasured } from './skyglow.js';
import { framesFor, moonIllum, type ProbePoint, type QualityAnswer } from './quality.js';
import { zenithSky, type QualityResult } from './index.js';

const log = logger('quality');

/** What a driver does to shoot one point. */
export interface ProbeShot {
  filter: string;
  gain: number;
  subS: number;
  count: number;
  /** the target the scope is on (the Dwarf's stack folder is named after it) */
  target: string;
  /** write the raw FITS here */
  dir: string;
  signal: AbortSignal;
  progress: (text: string) => void;
}

export interface ProbeDriver {
  /** why the scope cannot shoot test cohorts now (not connected, parked, a stack running), else null */
  busy(): string | null;
  /** shoot `count` raw subs of one point into `dir`; the camera's settings are put back afterwards */
  shoot(o: ProbeShot): Promise<{ files: string[]; how: string; notes: string[] }>;
}

let depth = 0;
/** true while test cohorts are being shot: the journal leaves the scope's stacks alone */
export const probing = (): boolean => depth > 0;

/** Run with the journal told that what the scope stacks now is a probe. */
export async function whileProbing<T>(run: () => Promise<T>): Promise<T> {
  depth++;
  try {
    return await run();
  } finally {
    // the scope's last stack state settles a moment after the stop: keep the journal off it that long
    setTimeout(() => depth--, PROBE_SETTLE_MS).unref?.();
  }
}
const PROBE_SETTLE_MS = 5_000;

export interface QualityJob {
  id: string;
  target: string;
  targetName: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  /** points shot / planned so far */
  done: number;
  planned: number;
  current?: string;
  log: string[];
  answer?: QualityAnswer;
  apply?: string;
  error?: string;
}

let job: (QualityJob & { abort: AbortController }) | null = null;
const finished: QualityJob[] = [];
const KEEP_FINISHED = 10;
/** rounds of "more" after the first batch */
const MAX_ROUNDS = 3;

const view = (j: QualityJob & { abort?: AbortController }): QualityJob => {
  const { abort: _a, ...rest } = j as QualityJob & { abort?: AbortController };
  return { ...rest, log: rest.log.slice(-30) };
};

/** The running job, else the newest finished one (optionally of one target). */
export function qualityJob(target?: string): QualityJob | null {
  if (job && (!target || job.target === target)) return view(job);
  const f = [...finished].reverse().find((x) => !target || x.target === target);
  return f ? view(f) : null;
}

export function cancelQualityJob(): boolean {
  if (!job) return false;
  job.abort.abort();
  return true;
}

export interface QualityRun {
  driver: ProbeDriver;
  cohort: Omit<CohortSource, 'refCache'>;
  /** the engine's answer now (re-asked after every batch: the samples change it) */
  solve: () => QualityResult;
  target: { key: string; name: string; displayName: string; gotoName: string };
  /** the forecast hour at a moment */
  conditions?: ((at: Date) => HourConditions | undefined) | null;
  /** one line in the night's journal at the end */
  note?: (text: string) => void;
  swamp: number;
  /** the first points (the answer's own when absent) */
  points?: ProbePoint[];
  frames?: number;
}

const tmpRoot = () => path.join(config.paths.data, 'tmp', 'quality');

/** Start shooting a target's test cohorts in the background; throws when one is already running or the scope is busy. */
export function startQualityJob(r: QualityRun): QualityJob {
  if (job) throw new Error(`a quality measurement of ${job.targetName} is already running (${job.done}/${job.planned} points): acquisition_quality action=status, or action=cancel`);
  const busy = r.driver.busy();
  if (busy) throw new Error(`cannot shoot test cohorts now: ${busy}`);
  const first = r.points ?? r.solve().answer.points;
  if (!first.length) throw new Error(`${r.target.displayName}: nothing to measure (the settings are established; force a refresh with points)`);
  const id = `q-${Date.now().toString(36)}`;
  const j: QualityJob & { abort: AbortController } = { id, target: r.target.key, targetName: r.target.displayName, status: 'running', startedAt: Date.now(), done: 0, planned: first.length, log: [], abort: new AbortController() };
  job = j;
  void run(j, r, first).finally(() => {
    j.endedAt = Date.now();
    finished.push(view(j));
    if (finished.length > KEEP_FINISHED) finished.splice(0, finished.length - KEEP_FINISHED);
    if (job === j) job = null;
  });
  return view(j);
}

async function run(j: QualityJob & { abort: AbortController }, r: QualityRun, first: ProbePoint[]): Promise<void> {
  const dir = path.join(tmpRoot(), j.id);
  const say = (t: string) => {
    j.log.push(`${new Date().toISOString().slice(11, 19)} ${t}`);
    log.info(`${j.targetName}: ${t}`);
  };
  const refCache = new Map<string, RawFrame>();
  try {
    fs.mkdirSync(dir, { recursive: true });
    await whileProbing(async () => {
      let batch = first;
      for (let round = 0; round <= MAX_ROUNDS && batch.length; round++) {
        for (const p of batch) {
          if (j.abort.signal.aborted) throw new Error('cancelled');
          j.current = `${p.filter}${r.cohort.rig.gainSettable ? ` gain ${p.gain}` : ''} ${p.subS}s (${p.why})`;
          say(`point ${j.done + 1}/${j.planned}: ${j.current}`);
          await shootPoint(r, p, path.join(dir, `p${j.done + 1}`), j.abort.signal, refCache, say);
          j.done++;
        }
        const res = r.solve();
        j.answer = res.answer;
        j.apply = res.measured?.apply ?? undefined;
        if (res.answer.status !== 'more') break;
        batch = res.answer.points;
        j.planned += batch.length;
        say(`not settled: ${batch.map((p) => p.why).join('; ')}`);
      }
    });
    j.current = undefined;
    const a = j.answer;
    if (!a?.settings) {
      j.status = 'failed';
      j.error = a?.why.join('; ') ?? 'no answer';
      say(`no settings: ${j.error}`);
    } else {
      j.status = 'done';
      say(`settled: ${a.settings.filter}${r.cohort.rig.gainSettable ? ` gain ${a.settings.gain}` : ''} ${a.settings.subS}s`);
    }
    r.note?.(`quality measurement of ${j.targetName}: ${j.done} test cohorts${a?.settings ? ` → ${a.settings.filter}${r.cohort.rig.gainSettable ? ` gain ${a.settings.gain}` : ''} ${a.settings.subS}s` : ' — not settled'}${a?.set?.invalid.length ? ` (${a.set.invalid.length} spoiled by cloud)` : ''}`);
  } catch (e) {
    j.current = undefined;
    j.status = j.abort.signal.aborted ? 'cancelled' : 'failed';
    j.error = errMsg(e);
    say(`${j.status}: ${j.error}`);
    try {
      j.answer = r.solve().answer;
    } catch {
      /* the answer stays the last one */
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Shoot one point, analyse it, store it as a sample of the target (a failed shot is stored as a gap). */
async function shootPoint(r: QualityRun, p: ProbePoint, dir: string, signal: AbortSignal, refCache: Map<string, RawFrame>, say: (t: string) => void): Promise<QualitySample> {
  const { rig } = r.cohort;
  const devKey = deviceKey(rig.spec.id, rig.serial);
  const base = { id: `qs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, device: devKey, target: r.target.key, targetName: r.target.displayName, filter: p.filter, gain: p.gain, subS: p.subS, source: 'probe' as const };
  const gap = (why: string): QualitySample => {
    const s: QualitySample = { ...base, at: Date.now(), frames: [], valid: false, invalidWhy: why, skyAduPerS: 0, skyVarAduPerS: 0, readNoiseAdu: 0, ePerAdu: 0, swamp: 0, efficiency: 0, backgroundPct: 0, clippedPct: 0, stars: 0, skyMag: null, modelSkyMag: null, modelMoonlessMag: null, cond: condNow(r, null) };
    recordQuality(s);
    say(`gap: ${why}`);
    return s;
  };
  fs.mkdirSync(dir, { recursive: true });
  let shot: Awaited<ReturnType<ProbeDriver['shoot']>>;
  try {
    shot = await r.driver.shoot({ filter: p.filter, gain: p.gain, subS: p.subS, count: r.frames ?? framesFor(p.subS), target: r.target.gotoName, dir, signal, progress: say });
  } catch (e) {
    // the scope refused or failed to shoot: that says nothing about the sky, so it is no sample (a
    // gap is for cloud) — the job stops with the device's reason rather than retrying the same refusal
    if (signal.aborted) throw e;
    throw new Error(`the scope could not shoot ${p.filter} ${p.subS}s: ${errMsg(e)}`);
  }
  for (const n of shot.notes) say(n);
  if (!shot.files.length) throw new Error(`the scope returned no raw sub for ${p.filter} ${p.subS}s (${shot.how})`);
  const bytes = shot.files.map((f) => fs.readFileSync(f));
  const frames = bytes.map((b, i) => {
    const fr = readRaw(b, path.basename(shot.files[i]));
    // what the point was shot at stands when a header is silent
    return { ...fr, exposureS: fr.exposureS ?? p.subS, gain: fr.gain ?? p.gain, filter: fr.filter ?? p.filter };
  });
  try {
    const c = await analyzeCohort({ ...r.cohort, refCache }, frames, bytes, { swamp: r.swamp, stars: true, durationS: p.subS });
    recordSubLength(c.sample);
    const eSky = Math.max(1e-9, c.res.background.ePerS - c.sensor.darkCurrentEPerS);
    let modelMoonless: number | null = null;
    if (c.pos && c.pos.altitude > 0) modelMoonless = skyBrightness({ zenithSqm: zenithSky().sqm, altDeg: c.pos.altitude, moon: null }).sqm;
    const s: QualitySample = {
      ...base,
      filter: c.filter.name,
      at: c.at.getTime(),
      frames: c.frames,
      valid: c.res.background.aboveReferenceAdu > 0,
      invalidWhy: c.res.background.aboveReferenceAdu > 0 ? undefined : 'the background is not above the offset: a dark frame or a shut light path',
      skyAduPerS: c.sample.skyAduPerS,
      skyVarAduPerS: c.sample.skyVarAduPerS,
      readNoiseAdu: c.sample.readNoiseAdu,
      ePerAdu: c.sensor.ePerAdu,
      swamp: c.sample.swamp,
      efficiency: c.sample.efficiency,
      backgroundPct: c.backgroundPct,
      clippedPct: c.clippedPct,
      stars: c.stars?.count ?? 0,
      fwhmArcsec: c.stars?.fwhmArcsec,
      roundness: c.stars?.roundness,
      skyMag: Number.isFinite(eSky) ? Math.round(magForRate(rig, eSky, c.filter.skyFraction) * 100) / 100 : null,
      modelSkyMag: c.model?.sqm ?? null,
      modelMoonlessMag: modelMoonless !== null ? Math.round(modelMoonless * 100) / 100 : null,
      cond: condNow(r, c),
      notes: c.notes.slice(0, 6),
    };
    recordQuality(s);
    if (s.valid) groundTruth(r, c, s, eSky);
    say(`${s.filter} ${s.subS}s: sky ${s.skyMag ?? '?'} mag/arcsec², swamp ${s.swamp}, background ${s.backgroundPct}%, ${s.stars} stars${s.fwhmArcsec ? ` FWHM ${s.fwhmArcsec.toFixed(1)}″` : ''}${s.roundness ? ` round ${s.roundness.toFixed(2)}` : ''}${s.valid ? '' : ` — gap: ${s.invalidWhy}`}`);
    return s;
  } catch (e) {
    return gap(`the analysis failed: ${errMsg(e)}`);
  }
}

/** a sky cohort stands for the site only in astronomical dark, with the Moon down and the target this high (acquisition_measure's rule) */
const TRUSTED_SUN_ALT = -18;
const TRUSTED_MOON_ALT = -3;
const TRUSTED_ALT = 35;

/** A valid cohort as the rig's and the site's own measurements: the sky there (and the zenith it implies) and the stars' FWHM. */
function groundTruth(r: QualityRun, c: Awaited<ReturnType<typeof analyzeCohort>>, s: QualitySample, eSky: number): void {
  const devKey = s.device;
  try {
    if (c.pos && c.pos.altitude > 0 && s.skyMag !== null) {
      const moonDown = (c.moon?.altDeg ?? -90) < TRUSTED_MOON_ALT;
      const zenith = moonDown ? zenithFromMeasured({ sqmThere: s.skyMag, altDeg: c.pos.altitude, moon: c.moon }) : null;
      const trusted = zenith !== null && (c.sunAltDeg ?? 0) < TRUSTED_SUN_ALT && moonDown && c.pos.altitude >= TRUSTED_ALT;
      recordSky({ at: s.at, device: devKey, filter: s.filter, gain: s.gain, subS: s.subS, rateAduPerS: Math.round((eSky / Math.max(1e-9, s.ePerAdu)) * 100) / 100, sqmThere: s.skyMag, zenithSqm: zenith !== null ? Math.round(zenith * 100) / 100 : NaN, altDeg: Math.round(c.pos.altitude), moonAltDeg: Math.round(c.moon?.altDeg ?? -90), trusted });
    }
    if (s.fwhmArcsec && s.stars >= 10 && (s.roundness === undefined || s.roundness >= 0.7)) recordSeeing({ at: s.at, device: devKey, fwhmArcsec: s.fwhmArcsec, roundness: s.roundness, seeingIdx: r.conditions?.(new Date(s.at))?.seeingIdx, altDeg: c.pos ? Math.round(c.pos.altitude) : undefined });
  } catch (e) {
    log.debug(`ground truth from ${s.filter} ${s.subS}s: ${errMsg(e)}`);
  }
}

/** The conditions of a cohort: its pointing and Moon from the analysis, else where the target is now. */
function condNow(r: QualityRun, c: Awaited<ReturnType<typeof analyzeCohort>> | null): QualitySample['cond'] {
  const site = r.cohort.site;
  const at = c?.at ?? new Date();
  const res = r.solve();
  const t = res.slices[0];
  const pos = c?.pos ?? (t ? { altitude: t.altDeg, azimuth: t.azDeg } : { altitude: 45, azimuth: 180 });
  const moon = c?.moon ?? t?.moon ?? null;
  const h = r.conditions?.(at);
  let sunAlt: number | null = c?.sunAltDeg ?? null;
  if (sunAlt === null) {
    try {
      sunAlt = sky.bodyAlt(site, 'Sun', at);
    } catch {
      sunAlt = null;
    }
  }
  return {
    altDeg: Math.round(pos.altitude * 10) / 10,
    azDeg: Math.round(pos.azimuth * 10) / 10,
    moonAltDeg: moon ? Math.round(moon.altDeg * 10) / 10 : null,
    moonSepDeg: moon ? Math.round(moon.sepDeg * 10) / 10 : null,
    moonIllum: moon ? Math.round((moonIllum(moon) ?? 0) * 1000) / 1000 : null,
    sunAltDeg: sunAlt !== null ? Math.round(sunAlt * 10) / 10 : null,
    mount: r.cohort.rig.mount,
    transparencyIdx: h?.transparencyIdx,
    observability: h?.observability,
    windKmh: h?.windKmh,
  };
}

/** Remove what a job left behind if the process died mid-run. */
export function cleanQualityTmp(): void {
  try {
    if (!job) fs.rmSync(tmpRoot(), { recursive: true, force: true });
  } catch (e) {
    log.debug(`quality tmp: ${errMsg(e)}`);
  }
}
