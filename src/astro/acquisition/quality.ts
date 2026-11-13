/**
 * The collection quality engine: the settings a target is collected with are solved from test
 * cohorts shot on that target with this rig, not guessed.
 *
 * After focusing, before the stack, the agent shoots a few short cohorts ("points": one filter,
 * gain and sub length each, FRAMES_PER_POINT subs, never stacked into a dataset — probe.ts). Each
 * is analysed like sub_length (cohort.ts): the sky's level and noise through that filter, the read
 * noise, the background against the range, the share clipped, and the stars' FWHM and roundness.
 * From them this module solves the filter, gain and sub that collect the most SNR per wall hour:
 *
 *   SNR² per hour ∝ e_t² t² / ((e_t + n_sky) t + RN²) × 3600 / cycle(t) × keep × q(t)
 *
 * with n_sky the MEASURED sky noise rate through the filter (rescaled to each moment of the block
 * by the sky model's ratio: the Moon's part by its measured scattering when a moon-down and a
 * moon-up cohort exist), RN the measured read noise, q(t) the stars' quality measured at each sub
 * length (trailing, wind, focus), the background limit from the measured sky level, and the core
 * clipping the subs showed. Only the target's own signal e_t is the model's (one sub cannot
 * measure a faint target), and it is the same factor for every sub length.
 *
 * What it asks for:
 * Everything is per target (and per device and mount): one target's cohorts never settle another's.
 *
 * - needed: no cohorts for this target on this mount within VALID_DAYS (three weeks: stale after that): INITIAL_POINTS_MAX points
 *   around the model's answer (both filters when the program says auto, a second gain where the
 *   gain is settable, the sub lengths either side);
 * - more: the best sub is at the edge of what was tested and a longer (or shorter) one could beat
 *   it, or a point was clouded out next to the best: up to EXTRA_POINTS_MAX more;
 * - refresh: solved, but the block's sky or altitude is far from what the cohorts were shot under
 *   (a moonless measurement for a moonlit block, the target much lower, the season): a few points
 *   around the current answer; the settings meanwhile are the measured ones rescaled.
 */
import type { Site } from '../sky.js';
import { BG_MAX_FRAC, electronRate, subCycle, targetKeep, trailCap, starFwhm, type Recommendation, type SkySlice, type TargetInfo } from './advise.js';
import { findFilter, type Rig } from './devices.js';
import { extinctionFor, skyBrightness, transmission, type MoonGeometry } from './skyglow.js';
import type { QualityConditions, QualitySample } from './store.js';

/** points shot when nothing is measured (the owner's 4–5) */
export const INITIAL_POINTS_MAX = 5;
/** points a set may add when the first ones do not settle it */
export const EXTRA_POINTS_MAX = 3;
/** points a refresh shoots */
export const REFRESH_POINTS_MAX = 3;
/** subs per point: two give a median and show a passing cloud */
export const FRAMES_PER_POINT = 2;
/** cohorts within this many hours of the newest are one set (one sitting) */
export const SET_HOURS = 3;
/**
 * A target's measurements go stale after this many days (the season moves the target's hours and
 * altitude, the sky and the rig change): from then on the planner asks for a new set.
 */
export const VALID_DAYS = 21;
/** the block's sky this many magnitudes from the set's, without a measured Moon to carry it: refresh */
export const REFRESH_SKY_DMAG = 1;
/** the block this many degrees lower or higher than the set on an alt-az head: refresh */
export const REFRESH_ALT_DEG = 30;
/** stars rounder than this are not trailing (acquisition_measure's check rule) */
export const ROUND_MIN = 0.7;
/** clipped beyond stars, % of the frame: the target's core or the sky */
export const CLIPPED_PCT = 0.5;
/** a point within this share of the best is a tie, settled for the shorter sub */
const TIE = 0.97;
/** an untested sub must promise this much over the best tested one before it is worth a point */
const EDGE_GAIN = 1.03;
/** a cohort's sky this far from its filter's median (×) is cloud or haze */
const SKY_OUTLIER = 2;
/** a cohort with fewer than this share of its filter's median star count saw cloud or an obstruction */
const STARS_OUTLIER = 0.3;
const CELL_PX = 4;
const CORE_CLIP_KEEP = 0.8;
const DEFAULT_KEEP = 0.95;
const CLOUD_GAP_S = 300;
const NOMINAL_SB = 22.5;
/** the Moon's measured scattering over the model's is kept within this (a bad cohort, not a calibration) */
const MOON_K_RANGE: [number, number] = [0.2, 5];
/** the cap the measured stars put on the model's trailing limit */
const CAP_FACTOR_RANGE: [number, number] = [0.3, 4];

export interface ProbePoint {
  filter: string;
  gain: number;
  subS: number;
  why: string;
  /** a second try of a point a cloud spoiled */
  retry?: boolean;
}

export type QualityStatus = 'established' | 'needed' | 'more' | 'refresh' | 'unsolvable';

export interface QualityAnswer {
  status: QualityStatus;
  /** the settings to collect with (null: nothing measured yet — use the model's meanwhile) */
  settings: { filter: string; gain: number; subS: number } | null;
  /** what to shoot next for this status (empty when established) */
  points: ProbePoint[];
  /** what a re-measurement shoots whenever the agent asks for one (refresh=true), established or not */
  refreshPoints?: ProbePoint[];
  why: string[];
  /** every setting solved, best first */
  table: Array<{ filter: string; gain: number; subS: number; relative: number; tested: boolean; note?: string }>;
  /** the Moon's effect on the sky through the chosen filter: measured scattering and what it costs the block */
  moon: { measuredK: number | null; deltaMagBlock: number | null; basis: string } | null;
  /** the set solved from */
  set: { at: number; points: number; valid: number; invalid: Array<{ filter: string; gain: number; subS: number; why: string }> } | null;
  budget: { used: number; max: number };
}

export interface QualityInput {
  rig: Rig;
  target: TargetInfo;
  site: Site;
  zenithSqm: number;
  /** the program's filter for the target: 'auto' (or empty) to choose, else that filter */
  filterMode?: string;
  /** the moments the settings are for: the block (index.ts slicesFor) */
  slices: SkySlice[];
  /** the model's answer for the block: where the probes are centred */
  model: Pick<Recommendation, 'settings' | 'alternatives'>;
  /** every quality sample of this target on this device */
  samples: QualitySample[];
  cloudFloor?: number;
  keepBySubS?: Record<string, number>;
  /** points of the set already shot, valid or not (the budget) */
  now?: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, x));
const r2 = (n: number) => Math.round(n * 100) / 100;
const same = (a: { filter: string; gain: number; subS: number }, b: { filter: string; gain: number; subS: number }, rig: Rig) =>
  filterName(rig, a.filter) === filterName(rig, b.filter) && (!rig.gainSettable || a.gain === b.gain) && Math.abs(a.subS - b.subS) < 1e-6;
const filterName = (rig: Rig, f: string) => findFilter(rig.filters, f)?.name ?? f;
const pointKey = (p: { filter: string; gain: number; subS: number }, rig: Rig) => `${filterName(rig, p.filter)}|${rig.gainSettable ? p.gain : '-'}|${p.subS}`;

/** The Moon's illuminated share from its phase angle. */
export const moonIllum = (m: MoonGeometry | null | undefined): number | null => (m ? (1 + Math.cos((m.phaseAngleDeg * Math.PI) / 180)) / 2 : null);

/** A sample's conditions as the sky model takes them. */
function condMoon(c: QualityConditions): MoonGeometry | null {
  if (c.moonAltDeg === null || c.moonSepDeg === null || c.moonIllum === null) return null;
  return { altDeg: c.moonAltDeg, sepDeg: c.moonSepDeg, phaseAngleDeg: (Math.acos(clamp(2 * c.moonIllum - 1, [-1, 1])) * 180) / Math.PI } as MoonGeometry;
}

/** The model's sky through a filter at one moment, e⁻/px/s: without the Moon, and the Moon's part. */
export function modelSky(rig: Rig, filter: Rig['filters'][number], zenithSqm: number, o: { altDeg: number; moon: MoonGeometry | null; transparencyIdx?: number }): { moonless: number; moon: number } {
  const k = extinctionFor(o.transparencyIdx);
  const sb = skyBrightness({ zenithSqm, altDeg: o.altDeg, moon: o.moon, k });
  const total = electronRate(rig, sb.sqm, filter.skyFraction);
  const moonless = electronRate(rig, sb.darkSqm, filter.skyFraction);
  return { moonless, moon: Math.max(0, total - moonless) };
}

/** Cohorts of one sitting on this mount, the newest set, within VALID_DAYS. */
export function currentSet(samples: QualitySample[], mount: Rig['mount'], now = Date.now()): QualitySample[] {
  const mine = samples.filter((s) => s.cond.mount === mount && now - s.at < VALID_DAYS * 86400e3).sort((a, b) => a.at - b.at);
  if (!mine.length) return [];
  const newest = mine[mine.length - 1].at;
  return mine.filter((s) => newest - s.at <= SET_HOURS * 3600e3);
}

/** Samples split into sittings: runs with no gap longer than SET_HOURS. */
export function sittings(samples: QualitySample[]): QualitySample[][] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const out: QualitySample[][] = [];
  for (const s of sorted) {
    const cur = out[out.length - 1];
    if (cur && s.at - cur[0].at <= SET_HOURS * 3600e3) cur.push(s);
    else out.push([s]);
  }
  return out;
}

/**
 * The cohorts of a set that saw the sky: a capture that failed, a sky level far from its filter's
 * median (cloud lit by the town, or thick cloud), or most of its filter's stars missing, is a gap.
 */
export function validate(set: QualitySample[], rig: Rig): Array<QualitySample & { gapWhy?: string }> {
  const out = set.map((s) => ({ ...s, gapWhy: s.valid ? undefined : (s.invalidWhy ?? 'the capture failed') }));
  const byFilter = new Map<string, typeof out>();
  for (const s of out) {
    const k = filterName(rig, s.filter);
    byFilter.set(k, [...(byFilter.get(k) ?? []), s]);
  }
  for (const group of byFilter.values()) {
    const ok = group.filter((s) => !s.gapWhy);
    if (ok.length >= 3) {
      const m = median(ok.map((s) => s.skyAduPerS));
      for (const s of ok) if (m > 0 && (s.skyAduPerS > SKY_OUTLIER * m || s.skyAduPerS < m / SKY_OUTLIER)) s.gapWhy = `the sky ${r2(s.skyAduPerS / m)}× its filter's median level: cloud or haze`;
    }
    const ok2 = group.filter((s) => !s.gapWhy && s.stars > 0);
    if (ok2.length >= 2) {
      // star counts grow with the sub: compare per √t
      const dens = (s: QualitySample) => s.stars / Math.sqrt(s.subS);
      const m = median(ok2.map(dens));
      for (const s of ok2) if (m > 0 && dens(s) < STARS_OUTLIER * m) s.gapWhy = `${s.stars} stars, under ${Math.round(STARS_OUTLIER * 100)}% of its filter's usual: cloud or an obstruction`;
    }
    for (const s of group) if (!s.gapWhy && s.stars === 0 && s.fwhmArcsec === undefined && group.some((x) => x !== s && x.stars > 10)) s.gapWhy = 'no stars: cloud or an obstruction';
  }
  return out;
}

/** The sub lengths a filter/gain may use (the device's, and on a dark-bound device those with a master). */
function offered(rig: Rig, gain: number): number[] {
  if (!rig.spec.exposure.requiresMatchingDarks || !rig.darks) return rig.subsS;
  return rig.subsS.filter((t) => rig.darks!.some((d) => Math.abs(d.exposureS - t) < 0.01 && (d.gain === undefined || d.gain === gain)));
}

const neighbours = (list: number[], t: number) => {
  const i = list.findIndex((x) => Math.abs(x - t) < 1e-6);
  if (i < 0) {
    const below = list.filter((x) => x < t).pop();
    const above = list.find((x) => x > t);
    return { below, above };
  }
  return { below: i > 0 ? list[i - 1] : undefined, above: i < list.length - 1 ? list[i + 1] : undefined };
};

/** The filters a target may be shot through: the program's, else the rig's deep-sky ones (at most two: the model's best and the next). */
export function probeFilters(rig: Rig, filterMode: string | undefined, model: QualityInput['model']): string[] {
  if (filterMode && filterMode !== 'auto') {
    const f = findFilter(rig.filters, filterMode);
    return [f?.name ?? filterMode];
  }
  const best = filterName(rig, model.settings.filter);
  const alt = model.alternatives.map((a) => filterName(rig, a.filter)).find((n) => n !== best) ?? rig.filters.map((f) => f.name).find((n) => n !== best);
  return alt ? [best, alt] : [best];
}

/** The first points for a target: the model's answer and its neighbours, both filters on auto, a second gain where it is settable. */
export function initialPoints(i: Pick<QualityInput, 'rig' | 'filterMode' | 'model'>, max = INITIAL_POINTS_MAX): ProbePoint[] {
  const { rig, model } = i;
  const filters = probeFilters(rig, i.filterMode, model);
  const f1 = filters[0];
  const g1 = model.settings.gain;
  const subs1 = offered(rig, g1);
  const t1 = subs1.includes(model.settings.subS) ? model.settings.subS : (subs1.find((t) => t >= model.settings.subS) ?? subs1[subs1.length - 1]);
  const pts: ProbePoint[] = [];
  const add = (p: ProbePoint | null) => {
    if (p && p.subS !== undefined && !pts.some((x) => same(x, p, rig)) && pts.length < max) pts.push(p);
  };
  if (t1 === undefined) return [];
  add({ filter: f1, gain: g1, subS: t1, why: "the model's answer" });
  const n1 = neighbours(subs1, t1);
  if (n1.below !== undefined) add({ filter: f1, gain: g1, subS: n1.below, why: 'a shorter sub: the read-noise side' });
  if (n1.above !== undefined) add({ filter: f1, gain: g1, subS: n1.above, why: 'a longer sub: the trailing and background side' });
  else {
    const far = subs1.filter((t) => t < (n1.below ?? t1)).pop();
    if (far !== undefined) add({ filter: f1, gain: g1, subS: far, why: 'the longest on offer is the answer: a second shorter sub fixes the slope' });
  }
  if (filters[1]) {
    const altSub = model.alternatives.find((a) => filterName(rig, a.filter) === filters[1])?.subS ?? t1;
    const subs2 = offered(rig, g1);
    const t2 = subs2.includes(altSub) ? altSub : t1;
    add({ filter: filters[1], gain: g1, subS: t2, why: `the other filter: its sky measured against ${f1}'s` });
  }
  if (rig.gainSettable && rig.gains.length > 1) {
    const gAlt = model.alternatives.find((a) => filterName(rig, a.filter) === f1 && a.gain !== g1)?.gain ?? rig.gains.find((g) => g !== g1 && Math.abs(g - g1) === Math.min(...rig.gains.filter((x) => x !== g1).map((x) => Math.abs(x - g1))));
    if (gAlt !== undefined && offered(rig, gAlt).includes(t1)) add({ filter: f1, gain: gAlt, subS: t1, why: `gain ${gAlt}: its read noise and well against gain ${g1}'s` });
  }
  if (filters[1] && pts.length < max) {
    const subs2 = offered(rig, g1);
    const t2 = pts.find((p) => p.filter === filters[1])?.subS ?? t1;
    const n2 = neighbours(subs2, t2);
    const o = n2.above ?? n2.below;
    if (o !== undefined) add({ filter: filters[1], gain: g1, subS: o, why: `the other filter at a second sub length` });
  }
  for (const t of [n1.above, n1.below].flatMap((x) => (x === undefined ? [] : [neighbours(subs1, x).above, neighbours(subs1, x).below]))) {
    if (pts.length >= max) break;
    if (t !== undefined) add({ filter: f1, gain: g1, subS: t, why: 'a further sub length' });
  }
  // the order they are shot in: one filter at a time, then gain, then sub (fewest wheel and gain changes)
  return pts.sort((a, b) => filters.indexOf(a.filter) - filters.indexOf(b.filter) || a.gain - b.gain || a.subS - b.subS);
}

interface Group {
  filter: Rig['filters'][number];
  gain: number;
  samples: QualitySample[];
  /** sky rescaling: n_sky(moment) = s0 × moonless + k × moon (e⁻/s, without dark current) */
  s0: number;
  moonK: number;
  moonKMeasured: boolean;
  /** measured background ADU per e⁻ of sky noise rate */
  levelPerNoise: number;
  rnE: number;
  darkE: number;
  range: number;
  /** clipped % per tested sub */
  clip: Array<{ t: number; pct: number }>;
  setSkyMag: number | null;
}

/** The quality of stars at each tested sub length, from every valid cohort of the set: 1 sharp and round, 0 trailed. */
function starQuality(valid: QualitySample[]): Array<{ t: number; q: number }> {
  const withStars = valid.filter((s) => s.fwhmArcsec !== undefined && s.stars >= 10);
  if (!withStars.length) return [];
  const ref = Math.min(...withStars.map((s) => s.fwhmArcsec!));
  const byT = new Map<number, number[]>();
  for (const s of withStars) {
    const trailed = s.roundness !== undefined && s.roundness < ROUND_MIN;
    const q = trailed ? 0 : Math.min(1, (ref / s.fwhmArcsec!) ** 2);
    byT.set(s.subS, [...(byT.get(s.subS) ?? []), q]);
  }
  return [...byT.entries()].map(([t, qs]) => ({ t, q: median(qs) })).sort((a, b) => a.t - b.t);
}

/** Piecewise-linear through the tested points, flat beyond them (and said to be beyond). */
function interpAt(pts: Array<{ t: number; v: number }>, t: number): { v: number; beyond: 'below' | 'above' | null } {
  if (!pts.length) return { v: 1, beyond: null };
  if (t < pts[0].t - 1e-6) return { v: pts[0].v, beyond: 'below' };
  const last = pts[pts.length - 1];
  if (t > last.t + 1e-6) return { v: last.v, beyond: 'above' };
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t + 1e-6) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return { v: a.v + f * (b.v - a.v), beyond: null };
    }
  }
  return { v: last.v, beyond: null };
}

/** The solve: groups by filter and gain, every offered sub scored over the block, and what more would settle it. */
export function solveQuality(i: QualityInput): QualityAnswer {
  const { rig, target, site, zenithSqm } = i;
  const now = i.now ?? Date.now();
  const set = currentSet(i.samples, rig.mount, now);
  const maxPoints = INITIAL_POINTS_MAX + EXTRA_POINTS_MAX;
  if (!set.length) {
    const points = initialPoints(i);
    return {
      status: points.length ? 'needed' : 'unsolvable',
      settings: null,
      points,
      why: [points.length ? `not measured on this target${rig.mount === 'eq' ? ' in EQ' : ' in alt-az'} within ${VALID_DAYS} days: ${points.length} test cohorts of ${FRAMES_PER_POINT} subs settle the filter, gain and sub` : 'no sub length on offer to test (no dark masters?)'],
      table: [],
      moon: null,
      set: null,
      budget: { used: 0, max: INITIAL_POINTS_MAX },
    };
  }
  const checked = validate(set, rig);
  const valid = checked.filter((s) => !s.gapWhy);
  const invalid = checked.filter((s) => s.gapWhy);
  const wantedFilters = probeFilters(rig, i.filterMode, i.model);
  // the same target's moon-down and moon-up cohorts (any set within VALID_DAYS) calibrate the Moon's part
  // (each sitting validated on its own: another night's sky is not this one's cloud)
  const history = sittings(i.samples.filter((s) => now - s.at < VALID_DAYS * 86400e3 && s.cond.mount === rig.mount)).flatMap((x) => validate(x, rig)).filter((s) => !s.gapWhy);
  const groups: Group[] = [];
  for (const fName of wantedFilters) {
    const f = findFilter(rig.filters, fName);
    if (!f) continue;
    const gains = [...new Set(valid.filter((s) => filterName(rig, s.filter) === f.name).map((s) => s.gain))];
    for (const gain of gains) {
      const gs = valid.filter((s) => filterName(rig, s.filter) === f.name && (!rig.gainSettable || s.gain === gain));
      if (!gs.length) continue;
      const sensor = rig.sensorAt(gain);
      const darkE = sensor.darkCurrentEPerS;
      const noiseE = (s: QualitySample) => Math.max(1e-6, s.skyVarAduPerS * s.ePerAdu ** 2 - darkE);
      const models = (s: QualitySample) => modelSky(rig, f, zenithSqm, { altDeg: s.cond.altDeg, moon: condMoon(s.cond), transparencyIdx: s.cond.transparencyIdx });
      const hist = history.filter((s) => filterName(rig, s.filter) === f.name && (!rig.gainSettable || s.gain === gain));
      const dark = hist.filter((s) => { const m = models(s); return m.moon < 0.1 * m.moonless; });
      const lit = hist.filter((s) => { const m = models(s); return m.moon >= 0.5 * m.moonless; });
      let s0: number;
      let moonK: number;
      let moonKMeasured = false;
      if (dark.length) {
        s0 = median(dark.map((s) => noiseE(s) / models(s).moonless));
        if (lit.length) {
          moonK = clamp(median(lit.map((s) => { const m = models(s); return (noiseE(s) - s0 * m.moonless) / m.moon; })), MOON_K_RANGE);
          moonKMeasured = true;
        } else moonK = s0;
      } else {
        s0 = median(gs.map((s) => { const m = models(s); return noiseE(s) / (m.moonless + m.moon); }));
        moonK = s0;
      }
      const levelPerNoise = median(gs.map((s) => (s.skyAduPerS > 0 ? s.skyAduPerS / noiseE(s) : 1 / Math.max(1e-6, s.ePerAdu))));
      const rnE = median(gs.map((s) => s.readNoiseAdu * s.ePerAdu));
      const clip = [...new Map(gs.map((s) => [s.subS, median(gs.filter((x) => x.subS === s.subS).map((x) => x.clippedPct))])).entries()].map(([t, pct]) => ({ t, pct })).sort((a, b) => a.t - b.t);
      const mags = gs.map((s) => s.skyMag).filter((m): m is number => m !== null && Number.isFinite(m));
      groups.push({ filter: f, gain, samples: gs, s0, moonK, moonKMeasured, levelPerNoise, rnE, darkE, range: Math.max(1, sensor.saturationAdu - sensor.blackAdu), clip, setSkyMag: mags.length ? median(mags) : null });
    }
  }

  const used = set.length;
  const testedKeys = new Set(set.map((s) => pointKey(s, rig)));
  const retried = new Set(set.filter((s) => set.filter((x) => pointKey(x, rig) === pointKey(s, rig)).length > 1).map((s) => pointKey(s, rig)));

  // the stars: tested quality per sub, and how the measured trailing compares with the model's cap at the set's pointing
  const sq = starQuality(valid);
  const fwhmMeasured = valid.map((s) => s.fwhmArcsec).filter((x): x is number => x !== undefined);
  const fwhmPx = (fwhmMeasured.length ? Math.min(...fwhmMeasured) : starFwhm(rig, 2)) / rig.plateScale;
  const ref = valid[valid.length - 1] ?? set[set.length - 1];
  const capProbe = trailCap(rig, site.lat, { altDeg: ref.cond.altDeg, azDeg: ref.cond.azDeg, windKmh: ref.cond.windKmh }, fwhmPx)?.capS ?? Infinity;
  let capFactor = 1;
  if (Number.isFinite(capProbe) && sq.length) {
    const pass = sq.filter((p) => p.q >= 0.8).map((p) => p.t);
    const fail = sq.filter((p) => p.q < 0.5).map((p) => p.t);
    if (pass.length && Math.max(...pass) > capProbe) capFactor = Math.max(...pass) / capProbe;
    if (fail.length && Math.min(...fail) < capProbe) capFactor = (Math.min(...fail) / capProbe) * 0.95;
    capFactor = clamp(capFactor, CAP_FACTOR_RANGE);
  }

  // per slice of the block: the model sky (moonless, Moon), the target's light, the trailing cap
  const sb = target.sb !== null && Number.isFinite(target.sb) ? (target.sb as number) : NOMINAL_SB;
  const slices = i.slices.length ? i.slices : [{ at: now, altDeg: ref.cond.altDeg, azDeg: ref.cond.azDeg, moon: condMoon(ref.cond), transparencyIdx: ref.cond.transparencyIdx, windKmh: ref.cond.windKmh, observability: ref.cond.observability } as SkySlice];
  type Scored = { g: Group; t: number; merit: number; tested: boolean; beyond: 'below' | 'above' | null; note: string[] };
  const scored: Scored[] = [];
  for (const g of groups) {
    const keepT = targetKeep(target.emission, g.filter.band, g.filter.skyFraction);
    const sliceData = slices.map((s) => {
      const k = extinctionFor(s.transparencyIdx);
      const m = modelSky(rig, g.filter, zenithSqm, { altDeg: s.altDeg, moon: s.moon, transparencyIdx: s.transparencyIdx });
      const nSky = g.s0 * m.moonless + g.moonK * m.moon;
      const cap = trailCap(rig, site.lat, s, fwhmPx);
      const cloudy = i.cloudFloor !== undefined && s.observability !== undefined && s.observability < i.cloudFloor;
      return { nSky, eT: electronRate(rig, sb, keepT) * transmission(s.altDeg, k), capS: cap ? cap.capS * capFactor : Infinity, cloudLoss: cloudy ? 1 - Math.min(1, s.observability! / 100) : 0 };
    });
    const tested = new Set(g.samples.map((s) => s.subS));
    for (const t of offered(rig, g.gain)) {
      const note: string[] = [];
      const { cycleS } = subCycle(rig, t);
      const keep = i.keepBySubS?.[String(t)] ?? DEFAULT_KEEP;
      const q = interpAt(sq.map((p) => ({ t: p.t, v: p.q })), t);
      let clipPct = interpAt(g.clip.map((c) => ({ t: c.t, v: c.pct })), t);
      if (clipPct.beyond === 'above' && g.clip.length) clipPct = { v: (g.clip[g.clip.length - 1].pct * t) / g.clip[g.clip.length - 1].t, beyond: 'above' };
      let sum = 0;
      let lostBg = 0;
      let lostTrail = 0;
      for (const s of sliceData) {
        const bgFrac = (g.levelPerNoise * s.nSky * t) / g.range;
        if (bgFrac > BG_MAX_FRAC) {
          lostBg++;
          continue;
        }
        if (t > s.capS * 1.02) {
          lostTrail++;
          continue;
        }
        const noise2 = (s.eT + s.nSky + g.darkE) * t + g.rnE ** 2;
        const survive = s.cloudLoss ? Math.exp((-s.cloudLoss * t) / CLOUD_GAP_S) : 1;
        sum += ((CELL_PX * (s.eT * t) ** 2) / noise2) * (3600 / cycleS) * keep * survive;
      }
      let merit = (sum / sliceData.length) * q.v;
      if (q.v < 0.99) note.push(`stars ${Math.round(q.v * 100)}% of the sharpest${q.beyond ? ' (beyond the tested subs)' : ''}`);
      if (clipPct.v > CLIPPED_PCT) {
        merit *= CORE_CLIP_KEEP;
        note.push(`${r2(clipPct.v)}% clipped`);
      }
      if (lostBg) note.push(`sky over ${BG_MAX_FRAC * 100}% of the range for ${Math.round((lostBg / sliceData.length) * 100)}% of the block`);
      if (lostTrail) note.push(`trails for ${Math.round((lostTrail / sliceData.length) * 100)}% of the block`);
      scored.push({ g, t, merit, tested: tested.has(t), beyond: interpAt([...tested].sort((a, b) => a - b).map((x) => ({ t: x, v: 0 })), t).beyond, note });
    }
  }

  const invalidList = invalid.map((s) => ({ filter: s.filter, gain: s.gain, subS: s.subS, why: s.gapWhy! }));
  const setInfo = { at: set[set.length - 1].at, points: set.length, valid: valid.length, invalid: invalidList };
  const budgetLeft = maxPoints - used;
  if (!scored.length || scored.every((c) => c.merit <= 0)) {
    // nothing usable: every cohort was a gap — shoot the model's points again, once
    const again = initialPoints(i).filter((p) => !retried.has(pointKey(p, rig))).slice(0, Math.max(0, budgetLeft)).map((p) => ({ ...p, retry: true, why: `again: ${invalidList.find((x) => same(x, p, rig))?.why ?? 'no usable cohort'}` }));
    return { status: again.length ? 'more' : 'unsolvable', settings: null, points: again, why: [`no cohort of the set saw the sky (${invalidList.map((x) => `${x.filter} ${x.subS}s: ${x.why}`).join('; ') || 'none valid'})`], table: [], moon: null, set: setInfo, budget: { used, max: maxPoints } };
  }

  // the best: measured merit, near-ties to the shorter sub (more frames, less to lose to a gust or a cloud)
  const best0 = Math.max(...scored.map((c) => c.merit));
  const pool = scored.filter((c) => c.merit >= TIE * best0).sort((a, b) => Number(b.tested) - Number(a.tested) || a.t - b.t);
  const best = pool[0];
  const table = [...scored]
    .sort((a, b) => b.merit - a.merit)
    .map((c) => ({ filter: c.g.filter.name, gain: c.g.gain, subS: c.t, relative: r2(c.merit / best0), tested: c.tested, note: c.note.join('; ') || undefined }));

  // what would settle it
  const more: ProbePoint[] = [];
  const addMore = (p: ProbePoint) => {
    if (more.length >= budgetLeft) return;
    if (more.some((x) => same(x, p, rig))) return;
    const k = pointKey(p, rig);
    if (testedKeys.has(k) && !(p.retry && !retried.has(k))) return;
    more.push(p);
  };
  const bestGroup = scored.filter((c) => c.g === best.g);
  const testedT = [...new Set(best.g.samples.map((s) => s.subS))].sort((a, b) => a - b);
  // the edge of the chart: the best is the longest (or shortest) tested and an untested one beyond promises more
  const beyondUp = bestGroup.filter((c) => !c.tested && c.t > testedT[testedT.length - 1]).sort((a, b) => a.t - b.t)[0];
  const beyondDown = bestGroup.filter((c) => !c.tested && c.t < testedT[0]).sort((a, b) => b.t - a.t)[0];
  if (!best.tested && best.beyond) addMore({ filter: best.g.filter.name, gain: best.g.gain, subS: best.t, why: `the best sub (${best.t}s) is ${best.beyond === 'above' ? 'longer' : 'shorter'} than any tested: measure it` });
  else if (best.t === testedT[testedT.length - 1] && beyondUp && beyondUp.merit >= best.merit / EDGE_GAIN) addMore({ filter: best.g.filter.name, gain: best.g.gain, subS: beyondUp.t, why: `the best is the longest tested (${best.t}s): ${beyondUp.t}s may beat it` });
  else if (best.t === testedT[0] && beyondDown && beyondDown.merit >= best.merit / EDGE_GAIN) addMore({ filter: best.g.filter.name, gain: best.g.gain, subS: beyondDown.t, why: `the best is the shortest tested (${best.t}s): ${beyondDown.t}s may beat it` });
  // between two tested subs with an untested one in the middle that scores near the best
  const inside = bestGroup.filter((c) => !c.tested && !c.beyond && c.merit >= best.merit && c !== best)[0];
  if (inside) addMore({ filter: inside.g.filter.name, gain: inside.g.gain, subS: inside.t, why: `${inside.t}s, between the tested subs, scores as well: measure it` });
  // a gap next to the best: the clouded point once more
  for (const s of invalid) {
    const near = filterName(rig, s.filter) === best.g.filter.name && (!rig.gainSettable || s.gain === best.g.gain) && Math.abs(Math.log(s.subS / best.t)) <= Math.log(2.01);
    const otherFilterMissing = !groups.some((g) => g.filter.name === filterName(rig, s.filter));
    if (near || otherFilterMissing) addMore({ filter: filterName(rig, s.filter), gain: s.gain, subS: s.subS, retry: true, why: `again: ${s.gapWhy}` });
  }
  // a filter of the program never measured in this set (auto)
  for (const fName of wantedFilters) {
    if (!set.some((s) => filterName(rig, s.filter) === fName)) addMore({ filter: fName, gain: best.g.gain, subS: best.t, why: `${fName} not measured in this set` });
  }

  // the Moon: measured scattering, and what it does to the block through the chosen filter
  const bm = slices.map((s) => modelSky(rig, best.g.filter, zenithSqm, { altDeg: s.altDeg, moon: s.moon, transparencyIdx: s.transparencyIdx }));
  const blockMoonless = mean(bm.map((m) => best.g.s0 * m.moonless));
  const blockTotal = mean(bm.map((m) => best.g.s0 * m.moonless + best.g.moonK * m.moon));
  const deltaMagBlock = blockMoonless > 0 && blockTotal > blockMoonless * 1.001 ? r2(-2.5 * Math.log10(blockTotal / blockMoonless)) : 0;
  const moon = { measuredK: best.g.moonKMeasured ? r2(best.g.moonK / best.g.s0) : null, deltaMagBlock, basis: best.g.moonKMeasured ? `the Moon's light through ${best.g.filter.name} measured on this target (moon-down and moon-up cohorts): ${r2(best.g.moonK / best.g.s0)}× the model's scattering` : `the model's moonlight scaled by this set's measured sky (no moon-down/moon-up pair yet)` };

  // refresh: the block far from what the set saw
  const why: string[] = [];
  const setSky = mean(best.g.samples.map((s) => { const m = modelSky(rig, best.g.filter, zenithSqm, { altDeg: s.cond.altDeg, moon: condMoon(s.cond), transparencyIdx: s.cond.transparencyIdx }); return best.g.s0 * m.moonless + best.g.moonK * m.moon; }));
  const dMag = setSky > 0 && blockTotal > 0 ? -2.5 * Math.log10(blockTotal / setSky) : 0;
  const setAlt = mean(best.g.samples.map((s) => s.cond.altDeg));
  const blockAlt = mean(slices.map((s) => s.altDeg));
  const refresh: string[] = [];
  const setMoonUp = best.g.samples.some((s) => (s.cond.moonAltDeg ?? -90) > 0);
  const blockMoonUp = slices.some((s) => (s.moon?.altDeg ?? -90) > 0);
  if (Math.abs(dMag) > REFRESH_SKY_DMAG && !(best.g.moonKMeasured && setMoonUp !== blockMoonUp)) refresh.push(`the block's sky through ${best.g.filter.name} is ${r2(Math.abs(dMag))} mag ${dMag < 0 ? 'brighter' : 'darker'} than when measured${blockMoonUp && !setMoonUp ? ' (the Moon is up now)' : ''}`);
  if (rig.mount === 'alt-az' && Math.abs(blockAlt - setAlt) > REFRESH_ALT_DEG) refresh.push(`the target is ${Math.round(Math.abs(blockAlt - setAlt))}° ${blockAlt < setAlt ? 'lower' : 'higher'} than when measured`);

  why.push(`measured: ${valid.length} cohort(s) of ${new Date(setInfo.at).toISOString().slice(0, 16).replace('T', ' ')} UTC${invalid.length ? `, ${invalid.length} spoiled (${invalidList.map((x) => `${x.filter} ${x.subS}s`).join(', ')})` : ''}`);
  why.push(`${best.g.filter.name}${rig.gainSettable ? ` gain ${best.g.gain}` : ''} ${best.t}s: the most SNR per hour from the measured sky (${best.g.setSkyMag !== null ? `${r2(best.g.setSkyMag)} mag/arcsec² there` : 'its level'}), read noise ${r2(best.g.rnE)} e⁻ and stars${best.tested ? '' : ' (interpolated between tested subs)'}`);
  const otherF = table.find((r) => r.filter !== best.g.filter.name);
  if (otherF) why.push(`${otherF.filter}: ${Math.round(otherF.relative * 100)}% of the rate at its best (${otherF.subS}s)`);
  if (capFactor !== 1) why.push(`the stars held ${capFactor > 1 ? 'longer' : 'less long'} than the model's trailing limit (×${r2(capFactor)})`);
  if (moon.deltaMagBlock) why.push(`the Moon brightens the block's sky by ${Math.abs(moon.deltaMagBlock)} mag through ${best.g.filter.name} (${moon.basis})`);
  if (more.length) why.push(`not settled: ${more.map((p) => p.why).join('; ')}`);
  if (refresh.length && !more.length) why.push(`measure again when convenient: ${refresh.join('; ')}`);

  let status: QualityStatus = 'established';
  let points: ProbePoint[] = [];
  if (more.length) {
    status = 'more';
    points = more;
  }
  // the points a re-measurement shoots: the current answer and its neighbour toward the new sky, and the other filter on auto
  const n = neighbours(offered(rig, best.g.gain), best.t);
  const refreshPoints: ProbePoint[] = [
    { filter: best.g.filter.name, gain: best.g.gain, subS: best.t, why: 'the current answer under the sky now' },
    ...(dMag < 0 && n.below !== undefined ? [{ filter: best.g.filter.name, gain: best.g.gain, subS: n.below, why: 'a brighter sky: a shorter sub' }] : n.above !== undefined ? [{ filter: best.g.filter.name, gain: best.g.gain, subS: n.above, why: 'a longer sub' }] : []),
    ...(wantedFilters.length > 1 ? [{ filter: wantedFilters.find((f) => f !== best.g.filter.name)!, gain: best.g.gain, subS: best.t, why: 'the other filter under the sky now' }] : []),
  ].slice(0, REFRESH_POINTS_MAX);
  if (status === 'established' && refresh.length) {
    status = 'refresh';
    points = refreshPoints;
  } else if (budgetLeft <= 0 && (beyondUp || beyondDown) && !best.tested) {
    why.push('the point budget is spent: the best is extrapolated');
  }
  return { status, settings: { filter: best.g.filter.name, gain: best.g.gain, subS: best.t }, points, refreshPoints, why, table: table.slice(0, 12), moon, set: setInfo, budget: { used, max: status === 'refresh' ? used + REFRESH_POINTS_MAX : maxPoints } };
}

/** Seconds a list of points takes to shoot, roughly: their subs, the per-sub overhead, and a settings change each. */
export function pointsDurationS(rig: Rig, points: ProbePoint[], frames = FRAMES_PER_POINT, switchS = rig.spec.driver === 'dwarf' ? 45 : 15): number {
  return points.reduce((a, p) => a + frames * (p.subS + rig.spec.exposure.perSubOverheadS) + switchS + p.subS, 0);
}
