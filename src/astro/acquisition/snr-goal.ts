/**
 * A goal given as a signal-to-noise ratio instead of hours: how much integration a target needs on
 * this rig for the owner's SNR, so the program, the fillers and the target rest can all be asked
 * for "SNR 30" and still schedule, count and rest in minutes.
 *
 * The SNR is the acquisition planner's (advise.ts): per Bayer cell at the target's mean surface
 * brightness, through the filter the planner would choose (or the one the owner fixed). It grows
 * with the square root of the integration, so one rate per target answers every goal:
 *
 *   minutes = (SNR wanted / SNR after one minute)²
 *
 * The rate is taken under a standard night — the site's own dark, moonless zenith sky, the target
 * within 1½ h of its transit, an average clear atmosphere — not tonight's: the goal is a property of
 * the target and the rig, and must not jump with the Moon or the forecast. Minutes collected under a
 * bright Moon count the same as dark ones; the estimate is a planning figure, and the stack itself
 * says what was really reached.
 */
import { config } from '../../config.js';
import { findObject } from '../catalog.js';
import type { Site } from '../sky.js';
import { restSettings } from '../rest.js';
import { advise, SNR_TIERS, type SkySlice } from './advise.js';
import { resolveRig, type LiveFacts } from './devices.js';
import { deviceKey, latestSubLength } from './store.js';
import { targetInfo, zenithSky } from './index.js';

/**
 * What an SNR goal buys, on this app's own scale (advise.ts SNR_TIERS: 3 a detection, 10 a clean
 * picture, 20 a deep one). `max: null` is open-ended. The integration a level costs is relative to
 * Clean's start, since the time goes with SNR²: twice the SNR is four times the hours.
 */
export const SNR_GOAL_LEVELS: ReadonlyArray<{ label: string; min: number; max: number | null; note: string }> = [
  { label: 'Detection', min: SNR_TIERS.detect, max: 5, note: 'the target shows, noisy: enough to frame it and judge it' },
  { label: 'Acceptable', min: 5, max: SNR_TIERS.good, note: 'a usable picture with visible noise' },
  { label: 'Clean', min: SNR_TIERS.good, max: 15, note: "a clean picture (the planner's own goal suggestion)" },
  { label: 'Very clean', min: 15, max: SNR_TIERS.deep, note: 'smooth, room for stretching' },
  { label: 'Deep', min: SNR_TIERS.deep, max: 30, note: 'faint outer structure comes through' },
  { label: 'Ultra-deep', min: 30, max: null, note: 'the faintest detail; very long projects' },
];
export const SNR_GOAL_DEFAULT = SNR_TIERS.good;
export const SNR_GOAL_MIN = 1;
export const SNR_GOAL_MAX = 500;
/** The longest goal an SNR may turn into, minutes (the program's own ceiling). */
export const SNR_GOAL_CAP_MIN = 100_000;

export type GoalMode = 'time' | 'snr';

const times = (snr: number) => {
  const x = (snr / SNR_TIERS.good) ** 2;
  return x >= 10 ? `${Math.round(x)}` : `${Math.round(x * 100) / 100}`;
};
/** A level's integration relative to Clean, e.g. "1–2.25× the time to Clean". */
export const levelIntegration = (l: (typeof SNR_GOAL_LEVELS)[number]): string => (l.max === null ? `${times(l.min)}× or more` : `${times(l.min)}–${times(l.max)}×`) + ' the time to Clean';
const levelRange = (l: (typeof SNR_GOAL_LEVELS)[number]) => (l.max === null ? `${l.min}+` : `${l.min}–${l.max}`);

/** The chart as one line per level, for a tooltip or a tool description. */
export const snrChartText = (): string =>
  SNR_GOAL_LEVELS.map((l) => `${l.label}: SNR ${levelRange(l)}, ${levelIntegration(l)} (${l.note})`).join('\n') +
  '\nSNR per colour cell at the target\'s mean surface brightness on this rig; the hours go with SNR², so twice the SNR takes four times as long.';

/** The level an SNR falls in (below the first: "below detection"; above the last: the last). */
export function snrLevel(snr: number): string {
  if (!(snr >= SNR_GOAL_LEVELS[0].min)) return 'below detection';
  let label = SNR_GOAL_LEVELS[0].label;
  for (const l of SNR_GOAL_LEVELS) if (snr >= l.min) label = l.label;
  return label;
}

/** The hour angles the standard night samples, hours either side of the transit. */
const HALF_SPAN_H = 1.5;
const STEP_H = 0.25;
/** A target that never climbs above this cannot be collected, so has no rate. */
const MIN_ALT_DEG = 10;
const MEMO_MS = 60 * 60_000;

export interface SnrRate {
  /** SNR per Bayer cell after one minute of integration */
  snrPerSqrtMin: number;
  filter: string;
  subS: number;
  device: string;
  /** how the rate was made, for the owner and the agent */
  basis: string;
}

type Facts = Partial<LiveFacts> & { driver: LiveFacts['driver'] };
let lastFacts: Facts | null = null;
const memo = new Map<string, { at: number; rate: SnrRate | null }>();

/** What the scope last said about itself (the plan service passes it on), so goals use this unit's rig. */
export function noteRigFacts(facts: Facts | null | undefined): void {
  if (facts) lastFacts = facts;
}

const rigFacts = (): Facts => lastFacts ?? { driver: config.telescope.driver };

/** The target's path within HALF_SPAN_H of its transit, with the Moon down and no forecast. */
function standardSlices(site: Site, decDeg: number): SkySlice[] {
  const r = Math.PI / 180;
  const lat = site.lat * r;
  const dec = decDeg * r;
  const out: SkySlice[] = [];
  for (let h = -HALF_SPAN_H; h <= HALF_SPAN_H + 1e-9; h += STEP_H) {
    const ha = h * 15 * r;
    const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / r;
    if (alt < MIN_ALT_DEG) continue;
    const az = (Math.atan2(-Math.cos(dec) * Math.sin(ha), Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(ha)) / r + 360) % 360;
    out.push({ at: Math.round(h * 3600e3), altDeg: alt, azDeg: az, moon: null });
  }
  return out;
}

/**
 * The SNR rate of a target on this rig under the standard night, or null when it cannot be said:
 * the target never clears MIN_ALT_DEG here, or the planner has nothing to shoot it with.
 */
export function snrRate(site: Site, t: { name: string; raHours?: number; decDeg?: number }, filter?: string): SnrRate | null {
  const facts = rigFacts();
  let rig;
  let info;
  try {
    rig = resolveRig(facts);
    const custom = t.raHours !== undefined && t.decDeg !== undefined ? { raHours: t.raHours, decDeg: t.decDeg } : undefined;
    info = targetInfo(t.name, custom);
  } catch {
    return null;
  }
  const zen = zenithSky();
  const fixed = filter && filter !== 'auto' ? filter : undefined;
  const key = [rig.spec.id, rig.serial ?? '', rig.mount, zen.sqm.toFixed(2), fixed ?? 'auto', info.name, info.raHours.toFixed(3), info.decDeg.toFixed(2), site.lat.toFixed(1)].join('|');
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.rate;
  let rate: SnrRate | null = null;
  const slices = standardSlices(site, info.decDeg);
  if (slices.length) {
    try {
      const rec = advise({
        rig,
        target: info,
        site,
        slices,
        zenithSqm: zen.sqm,
        sqmSource: zen.source,
        fixed: fixed ? { filter: fixed } : undefined,
        usableMin: slices.length * STEP_H * 60,
        swampFactor: config.plan.swampFactor,
        subLength: (f, gain) => latestSubLength(deviceKey(rig.spec.id, rig.serial), f, gain),
      });
      const per = rec.integration.snrPerSqrtMin;
      if (Number.isFinite(per) && per > 0) {
        const sb = rec.target.sb === null ? 'no catalog surface brightness (judged faint)' : `${rec.target.sb} mag/arcsec² (${rec.target.sbSource})`;
        rate = {
          snrPerSqrtMin: per,
          filter: rec.settings.filter,
          subS: rec.settings.subS,
          device: rec.device.name,
          basis: `${rec.device.name} through ${rec.settings.filter} at ${rec.settings.subS}s, a dark moonless ${Math.round(zen.sqm * 100) / 100} mag/arcsec² sky near transit; target ${sb}`,
        };
      }
    } catch {
      rate = null;
    }
  }
  memo.set(key, { at: Date.now(), rate });
  return rate;
}

/** Integration minutes to an SNR at a rate (whole minutes, within the program's ceiling). */
export function minutesForSnr(rate: Pick<SnrRate, 'snrPerSqrtMin'>, snr: number): number {
  const min = (snr / rate.snrPerSqrtMin) ** 2;
  return Math.max(1, Math.min(SNR_GOAL_CAP_MIN, Math.ceil(min)));
}

/** The SNR a number of integration minutes reaches at a rate. */
export function snrAfter(rate: Pick<SnrRate, 'snrPerSqrtMin'>, minutes: number): number {
  return Math.round(rate.snrPerSqrtMin * Math.sqrt(Math.max(0, minutes)) * 10) / 10;
}

/** The goal in minutes for an SNR on a target, with the rate it came from (null: no rate, keep the time goal). */
export function goalForSnr(site: Site, t: { name: string; raHours?: number; decDeg?: number }, snr: number, filter?: string): { goalMin: number; rate: SnrRate } | null {
  const rate = snrRate(site, t, filter);
  return rate ? { goalMin: minutesForSnr(rate, snr), rate } : null;
}

/**
 * The general integration goal for a target outside the program (fillers, the target rest, the
 * calendar): the owner's minutes, or, in SNR mode, the minutes this target needs for their SNR.
 * A target with no rate (a custom name the catalog does not know) falls back to the minutes.
 */
export function generalGoalMin(site: Site | null | undefined, name: string, pos?: { raHours: number; decDeg: number }): number {
  const s = restSettings();
  if (s.goalMode !== 'snr' || !site) return s.integrationTargetMin;
  const known = pos ?? (findObject(name) ? undefined : null);
  if (known === null) return s.integrationTargetMin;
  return goalForSnr(site, { name, ...known }, s.snrTarget)?.goalMin ?? s.integrationTargetMin;
}

/** For tests: forget the memo and the rig. */
export function resetSnrGoals(): void {
  memo.clear();
  lastFacts = null;
}
