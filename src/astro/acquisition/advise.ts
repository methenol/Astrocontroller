/**
 * The acquisition plan for one target on this rig through tonight's sky: which filter, gain and
 * sub length collect the most signal-to-noise per hour of the night, without clipping the sky or
 * the target, and how much integration the target needs.
 *
 * Every (filter, gain, sub) the device offers is scored over the target's window, sampled in time
 * (altitude, airmass, the Moon, the forecast hour), with the CCD equation per Bayer cell:
 *
 *   SNR² per hour  ∝  e_t² t² / ((e_t + e_sky + e_dark) t + RN²)  ×  subs per hour × kept fraction
 *
 * where e_t and e_sky are electrons per pixel per second from the target's surface brightness and
 * the sky's (skyglow.ts), each through the filter. The read noise argues for long subs; the hard
 * limits argue for short ones, per sample of the window:
 *
 * - trailing: alt-az field rotation computed from the pointing (corner trail ≤ max(3 px, ¾ FWHM)),
 *   the unguided-EQ drift budget, and wind on an alt-az head — a sample a sub cannot hold is lost;
 * - the sky background: a sub whose sky fills more than BG_MAX_FRAC of the range is lost (the
 *   moonlit, light-polluted case that eats the dynamic range a star or a core needs);
 * - the target's brightest part: a core predicted to clip costs the candidate a share of its merit;
 * - darks: on a device that refuses a sub without a matching master, only covered pairs.
 *
 * Near-ties go to the safer side: the most headroom, then the shorter sub. Which input a number came
 * from (spec, the scope, a measurement, the forecast) is reported with the answer.
 */
import type { Emission, BandClass } from '../detect.js';
import type { Site } from '../sky.js';
import { findFilter, type Rig } from './devices.js';
import { airmass, extinctionFor, skyBrightness, transmission, type MoonGeometry } from './skyglow.js';

/** Photons s⁻¹ cm⁻² from a mag-0 source across the broadband (the calibration exposure.ts uses). */
const F0 = 879_000;
/** A Bayer cell: the colour resolution of an OSC frame, and the element SNR is quoted for. */
const CELL_PX = 4;
/** The sky may fill this share of the range above black; beyond it a sub is overexposed. */
export const BG_MAX_FRAC = 0.25;
/** A target core at this share of the full well is clipping. */
const CORE_CLIP_FRAC = 0.85;
const CORE_CLIP_KEEP = 0.8;
/** Corner trail allowed per sub, pixels (the Dwarf's ALTAZ-15 at 45°), or this share of the stars' FWHM when larger. */
const TRAIL_BUDGET_PX = 3;
const TRAIL_BUDGET_FWHM = 0.75;
/** Unguided EQ: seconds of tolerable drift × focal length (the planner's long-standing budget). */
const UNGUIDED_EQ_BUDGET = 30_000;
/** Wind on an alt-az head (km/h) and the sub it allows. */
const WIND_CAP_KMH = 15;
const WIND_SUB_S = 10;
/** Rejection when nothing was learned: the scope's own stacker drops a few subs to satellites and gusts. */
const DEFAULT_KEEP = 0.95;
/**
 * Under a forecast below the plan's floor (advisory clouds), a sub survives a passing cloud with
 * probability exp(-(1 - clear) × sub / CLOUD_GAP_S): long subs lose more, so shorter ones (and the
 * gain that suits them) are favoured while the block is still shot.
 */
const CLOUD_GAP_S = 300;
/** Fewer subs than this tonight starve the stacker's statistics (Noise2Noise halves, sigma clipping). */
const MIN_FRAMES = 20;
const FEW_FRAMES_KEEP = 0.9;
/** Candidates within this share of the best are ties, settled for headroom. */
const TIE = 0.97;
/** SNR per Bayer cell at the target's mean surface brightness: a detection, a clean picture, a deep one. */
export const SNR_TIERS = { detect: 3, good: 10, deep: 20 } as const;
/** The goal a target is suggested: the time to a clean picture, within these bounds (minutes). */
const GOAL_MIN_MIN = 60;
const GOAL_MAX_MIN = 1200;
/** Surface brightness assumed for a target with none in the catalog (a faint one, flagged). */
const NOMINAL_SB = 22.5;
/**
 * How much brighter than its catalog mean the brightest arcminutes of a target type are, mag/arcsec².
 * The catalog's galaxy figure is the mean over the whole D25 ellipse (M 31: 23.6), and M 31's inner
 * 2′ measured ~17.5 on the S50 Pro's subs, hence 6. Rough by nature: acquisition_measure action=check
 * reads the real core off the first subs.
 */
const CORE_OFFSET: Record<string, number> = { G: 6, GPair: 6, GTrpl: 6, GGroup: 5, GCl: 4, PN: 1, HII: 3, EmN: 3, Neb: 3, 'Cl+N': 3, RfN: 2, SNR: 1, OCl: 0, DrkN: 0, '*Ass': 0 };
const CORE_OFFSET_DEFAULT = 2;
/** Of an emission target's light, the share a line filter keeps (its lines), by filter class. */
const LINE_KEEP: Record<Exclude<Emission, 'broadband'>, Record<BandClass, number>> = {
  Ha_dominant: { broadband: 1, uhc: 0.8, duo_wide: 0.7, duo_tight: 0.65, line: 0.55 },
  OIII_dominant: { broadband: 1, uhc: 0.85, duo_wide: 0.75, duo_tight: 0.7, line: 0.55 },
};
/** 7Timer seeing index → FWHM, arcsec (the midpoints of its classes). */
const SEEING_ARCSEC = [0.4, 0.62, 0.87, 1.12, 1.37, 1.75, 2.25, 2.75];
const SEEING_NOMINAL_ARCSEC = 2;
/**
 * Focus, tracking, the optics and Bayer interpolation widen a smart telescope's stars to about this
 * many of its own pixels before any seeing: the S50 Pro's subs measured 6.4 px (14.8″) at 2.3″/px under
 * ~1″ seeing (2026-10-27). Measured FWHM (acquisition_measure) replaces this once there are samples.
 */
const SMART_SCOPE_BLUR_PX = 5;
const SIDEREAL_RAD_S = 7.2921e-5;

export interface TargetInfo {
  name: string;
  displayName?: string;
  raHours: number;
  decDeg: number;
  type?: string;
  /** mean surface brightness, mag/arcsec² (null: unknown) */
  sb: number | null;
  sbEstimated?: boolean;
  emission: Emission;
}

/** One moment of the target's window. */
export interface SkySlice {
  at: number;
  altDeg: number;
  azDeg: number;
  moon: MoonGeometry | null;
  seeingIdx?: number;
  transparencyIdx?: number;
  windKmh?: number;
  observability?: number;
}

export interface AdviseInput {
  rig: Rig;
  target: TargetInfo;
  site: Site;
  slices: SkySlice[];
  zenithSqm: number;
  sqmSource: string;
  /** the stars' FWHM this rig measured at this site, arcsec */
  measuredFwhmArcsec?: number;
  /** the owner's settings to hold (any of them) */
  fixed?: { filter?: string; gain?: number; subS?: number };
  /** wall-clock minutes on target tonight (the block, after the switch overhead) */
  usableMin: number;
  /** minutes already integrated on this target */
  collectedMin?: number;
  /** kept share of taken subs, by sub length, learned from the journal */
  keepBySubS?: Record<string, number>;
  /** the plan's forecast floor (0–100): a slice below it is under advisory cloud */
  cloudFloor?: number;
}

export interface Candidate {
  filter: string;
  gain: number;
  subS: number;
  /** SNR² per wall hour per Bayer cell, mean over the window (the score) */
  merit: number;
  /** relative to the best candidate */
  relative?: number;
  /** share of the window this sub holds (trailing, overexposure) */
  heldFrac: number;
  maxBackgroundFrac: number;
  coreClips: boolean;
  frames: number;
  why: string[];
}

export interface Recommendation {
  device: { id: string; name: string; why: string; serial?: string };
  target: { name: string; type?: string; emission: Emission; sb: number | null; sbSource: 'catalog' | 'estimated' | 'nominal' };
  settings: { filter: string; gain: number; gainNote: string; subS: number; frames: number; ditherEverySubs: number };
  apply: string;
  why: string[];
  overexposure: {
    /** worst sky background over the window, % of the range above black (limit BG_MAX_FRAC) */
    backgroundPct: number;
    backgroundAdu: number;
    coreClips: boolean;
    corePct: number | null;
    /** stars brighter than this clip in one sub */
    starSaturationMag: number;
    headroomNote: string;
  };
  integration: {
    tonightFrames: number;
    tonightMin: number;
    snrTonight: number;
    collectedMin: number;
    snrSoFar: number;
    hoursTo: { detect: number; good: number; deep: number };
    suggestedGoalMin: number;
    note: string;
  };
  conditions: {
    sqm: { min: number; max: number; zenith: number; source: string };
    moon: string;
    fwhmArcsec: number;
    fwhmSource: string;
    transparency: string;
    /** the forecast below the floor for part of the window (advisory), null when not */
    clouds: string | null;
    windMaxKmh: number | null;
    caps: string[];
  };
  alternatives: Array<{ filter: string; gain: number; subS: number; relative: number; note: string }>;
  sources: Record<string, string>;
  missing: string[];
}

const areaCm2 = (apertureMm: number) => (Math.PI / 4) * (apertureMm / 10) ** 2;

/** Electrons per pixel per second from a surface of `mag` mag/arcsec² through a share `fraction` of the band. */
export function electronRate(rig: Pick<Rig, 'apertureMm' | 'plateScale' | 'throughput'>, mag: number, fraction: number): number {
  return F0 * 10 ** (-0.4 * mag) * areaCm2(rig.apertureMm) * rig.plateScale ** 2 * rig.throughput * fraction;
}

/** The surface brightness that gives `rate` e⁻/px/s (the inverse of electronRate). */
export function magForRate(rig: Pick<Rig, 'apertureMm' | 'plateScale' | 'throughput'>, rate: number, fraction: number): number {
  return -2.5 * Math.log10(rate / (F0 * areaCm2(rig.apertureMm) * rig.plateScale ** 2 * rig.throughput * fraction));
}

/** The target's share of its own light that passes a filter. */
export function targetKeep(emission: Emission, band: BandClass, skyFraction: number): number {
  return emission === 'broadband' ? skyFraction : LINE_KEEP[emission][band];
}

/** Stars' FWHM on this rig, arcsec: seeing, diffraction, sampling and a smart scope's own blur in quadrature. */
export function starFwhm(rig: Pick<Rig, 'apertureMm' | 'plateScale'>, seeingArcsec: number): number {
  const diffraction = (1.03 * 0.55e-6) / (rig.apertureMm / 1000) * 206_265;
  return Math.sqrt(seeingArcsec ** 2 + diffraction ** 2 + (SMART_SCOPE_BLUR_PX * rig.plateScale) ** 2);
}

/** Alt-az field rotation rate at a pointing, radians per second (0 due east/west, largest on the meridian). */
export function rotationRate(latDeg: number, altDeg: number, azDeg: number): number {
  const r = Math.PI / 180;
  return Math.abs((SIDEREAL_RAD_S * Math.cos(latDeg * r) * Math.cos(azDeg * r)) / Math.cos(Math.min(89.5, altDeg) * r));
}

/** The longest sub a pointing holds before stars trail past the budget, and what limits it (null: nothing). */
export function trailCap(rig: Pick<Rig, 'mount' | 'guided' | 'focalLengthMm' | 'widthPx' | 'heightPx'>, latDeg: number, s: Pick<SkySlice, 'altDeg' | 'azDeg' | 'windKmh'>, fwhmPx: number): { capS: number; kind: string } | null {
  let cap: { capS: number; kind: string } | null = null;
  const take = (capS: number, kind: string) => {
    if (!cap || capS < cap.capS) cap = { capS, kind };
  };
  if (rig.mount === 'alt-az') {
    const corner = 0.5 * Math.hypot(rig.widthPx, rig.heightPx);
    const budget = Math.max(TRAIL_BUDGET_PX, TRAIL_BUDGET_FWHM * fwhmPx);
    take(budget / (rotationRate(latDeg, s.altDeg, s.azDeg) * corner), 'field rotation');
    if (s.windKmh !== undefined && s.windKmh >= WIND_CAP_KMH) take(WIND_SUB_S, 'wind');
  } else if (!rig.guided) {
    take(UNGUIDED_EQ_BUDGET / rig.focalLengthMm, 'unguided tracking');
  }
  return cap;
}

/** Seconds of the night one sub costs: its exposure, the per-sub overhead, and its share of the dithers. */
export function subCycle(rig: Pick<Rig, 'spec'>, subS: number): { cycleS: number; ditherEvery: number } {
  const ex = rig.spec.exposure;
  const d = rig.spec.dither;
  const every = d.longFromS !== undefined && d.everySubsLong && subS >= d.longFromS ? d.everySubsLong : d.everySubs;
  const one = subS + ex.perSubOverheadS;
  return { cycleS: one + (d.costS + d.costSubs * one) / every, ditherEvery: every };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function darkCovered(rig: Rig, subS: number, gain: number): boolean {
  if (!rig.spec.exposure.requiresMatchingDarks || !rig.darks) return true;
  return rig.darks.some((d) => Math.abs(d.exposureS - subS) < 0.01 && (d.gain === undefined || d.gain === gain));
}

/** The plan. Throws only on an empty window; a target nothing can be shot of gets the least-bad answer and says so. */
export function advise(input: AdviseInput): Recommendation {
  const { rig, target, site } = input;
  if (!input.slices.length) throw new Error(`no moment of the window has ${target.name} up`);
  const slices = input.slices;
  const sbKnown = target.sb !== null && Number.isFinite(target.sb);
  const sb = sbKnown ? (target.sb as number) : NOMINAL_SB;
  const sbSource: Recommendation['target']['sbSource'] = !sbKnown ? 'nominal' : target.sbEstimated ? 'estimated' : 'catalog';
  const coreSb = sbKnown ? sb - (target.type ? (CORE_OFFSET[target.type] ?? CORE_OFFSET_DEFAULT) : CORE_OFFSET_DEFAULT) : null;

  // the stars: this rig's measured FWHM at this site, else the forecast's seeing through the optics
  const seeingIdxs = slices.map((s) => s.seeingIdx).filter((x): x is number => x !== undefined);
  const forecastSeeing = seeingIdxs.length ? SEEING_ARCSEC[Math.min(8, Math.max(1, Math.round(mean(seeingIdxs)))) - 1] : undefined;
  const fwhmArcsec = input.measuredFwhmArcsec ?? starFwhm(rig, forecastSeeing ?? SEEING_NOMINAL_ARCSEC);
  const fwhmSource = input.measuredFwhmArcsec ? 'measured on this rig' : forecastSeeing !== undefined ? `forecast seeing ${forecastSeeing}″ through the optics (a smart scope's own blur dominates: measure it)` : "nominal 2″ seeing through the optics (a smart scope's own blur dominates: measure it)";
  const fwhmPx = fwhmArcsec / rig.plateScale;

  // per slice: the sky where the target is, the air in front of it, the trailing cap
  const sliceSky = slices.map((s) => {
    const k = extinctionFor(s.transparencyIdx);
    const sky = skyBrightness({ zenithSqm: input.zenithSqm, altDeg: s.altDeg, moon: s.moon, k });
    const cloudy = input.cloudFloor !== undefined && s.observability !== undefined && s.observability < input.cloudFloor;
    return { ...s, k, sqm: sky.sqm, moonFraction: sky.moonFraction, trans: transmission(s.altDeg, k), cap: trailCap(rig, site.lat, s, fwhmPx), cloudLoss: cloudy ? 1 - Math.min(1, s.observability! / 100) : 0 };
  });

  const fixedFilter = input.fixed?.filter ? findFilter(rig.filters, input.fixed.filter) : undefined;
  if (input.fixed?.filter && !fixedFilter) throw new Error(`${rig.spec.name} has no filter "${input.fixed.filter}" (it has ${rig.filters.map((f) => f.name).join(', ')})`);
  const filters = fixedFilter ? [fixedFilter] : rig.filters;
  const gains = input.fixed?.gain !== undefined ? [input.fixed.gain] : rig.gains;
  const subs = input.fixed?.subS !== undefined ? [input.fixed.subS] : rig.subsS;
  const usableS = Math.max(0, input.usableMin * 60);

  const candidates: Array<Candidate & { detail: { eSky: number[]; eT: number[]; sensor: ReturnType<Rig['sensorAt']>; keep: number; duty: number; ditherEvery: number; corePct: number | null; bgAdu: number } }> = [];
  for (const f of filters) {
    const keepT = targetKeep(target.emission, f.band, f.skyFraction);
    for (const gain of gains) {
      const sensor = rig.sensorAt(gain);
      for (const t of subs) {
        const why: string[] = [];
        if (!darkCovered(rig, t, gain)) continue;
        const { cycleS, ditherEvery } = subCycle(rig, t);
        const keep = input.keepBySubS?.[String(t)] ?? DEFAULT_KEEP;
        const duty = t / cycleS;
        const range = sensor.saturationAdu - sensor.blackAdu;
        let sum = 0;
        let held = 0;
        let maxBg = 0;
        let maxBgAdu = 0;
        let coreMax = 0;
        const eSkyAll: number[] = [];
        const eTAll: number[] = [];
        for (const s of sliceSky) {
          const eSky = electronRate(rig, s.sqm, f.skyFraction);
          const eT = electronRate(rig, sb, keepT) * s.trans;
          eSkyAll.push(eSky);
          eTAll.push(eT);
          const bgAdu = ((eSky + sensor.darkCurrentEPerS) * t) / sensor.ePerAdu;
          const bgFrac = bgAdu / range;
          maxBg = Math.max(maxBg, bgFrac);
          maxBgAdu = Math.max(maxBgAdu, bgAdu);
          if (coreSb !== null) coreMax = Math.max(coreMax, ((electronRate(rig, coreSb, keepT) * s.trans + eSky) * t) / sensor.fullWellE);
          const trailed = s.cap !== null && t > s.cap.capS * 1.02;
          if (trailed || bgFrac > BG_MAX_FRAC) continue;
          held++;
          const noise2 = (eT + eSky + sensor.darkCurrentEPerS) * t + sensor.readNoiseE ** 2;
          // SNR² per wall hour per Bayer cell
          // a passing cloud ruins the sub it crosses: the longer the sub, the likelier
          const survive = s.cloudLoss ? Math.exp((-s.cloudLoss * t) / CLOUD_GAP_S) : 1;
          sum += ((CELL_PX * (eT * t) ** 2) / noise2) * (3600 / cycleS) * keep * survive;
        }
        const heldFrac = held / sliceSky.length;
        let merit = sum / sliceSky.length;
        const coreClips = coreSb !== null && coreMax >= CORE_CLIP_FRAC;
        if (coreClips) {
          merit *= CORE_CLIP_KEEP;
          why.push(`the target's brightest part clips at ${t}s`);
        }
        const frames = Math.floor((usableS * heldFrac) / cycleS);
        if (usableS > 0 && frames < MIN_FRAMES) merit *= FEW_FRAMES_KEEP;
        if (maxBg > BG_MAX_FRAC) why.push(`the sky fills ${Math.round(maxBg * 100)}% of the range at its brightest`);
        candidates.push({ filter: f.name, gain, subS: t, merit, heldFrac, maxBackgroundFrac: maxBg, coreClips, frames, why, detail: { eSky: eSkyAll, eT: eTAll, sensor, keep, duty, ditherEvery, corePct: coreSb !== null ? Math.round(coreMax * 100) : null, bgAdu: maxBgAdu } });
      }
    }
  }
  if (!candidates.length) throw new Error(`no exposure/gain pair of ${rig.spec.name} has a dark master on the device: take darks first (dark_frames)`);

  const bestMerit = Math.max(...candidates.map((c) => c.merit));
  for (const c of candidates) c.relative = bestMerit > 0 ? c.merit / bestMerit : 0;
  // among near-ties: the most headroom (lowest background, no core clipping, the largest well), then the shorter sub
  const ties = candidates.filter((c) => bestMerit > 0 && c.merit >= TIE * bestMerit);
  const pool = ties.length ? ties : [...candidates].sort((a, b) => b.heldFrac - a.heldFrac || a.subS - b.subS).slice(0, 1);
  pool.sort((a, b) => Number(a.coreClips) - Number(b.coreClips) || b.detail.sensor.fullWellE - a.detail.sensor.fullWellE || a.subS - b.subS);
  const best = pool[0];
  const d = best.detail;
  const sensor = d.sensor;
  const f = filters.find((x) => x.name === best.filter)!;

  // integration: time to each SNR tier at the window's mean rates
  const eT = mean(d.eT);
  const eSky = mean(d.eSky);
  const perExposureS = (snr: number) => (snr ** 2 * (eT + eSky + sensor.darkCurrentEPerS + sensor.readNoiseE ** 2 / best.subS)) / (CELL_PX * eT ** 2);
  const wallH = (snr: number) => (eT > 0 ? perExposureS(snr) / (d.duty * d.keep) / 3600 : Infinity);
  const snrFor = (exposureS: number) => (eT > 0 && exposureS > 0 ? Math.sqrt((exposureS * CELL_PX * eT ** 2) / (eT + eSky + sensor.darkCurrentEPerS + sensor.readNoiseE ** 2 / best.subS)) : 0);
  const clear = mean(slices.map((s) => (s.observability !== undefined ? Math.min(1, s.observability / 100) : 1)));
  const tonightExpS = best.frames * best.subS * d.keep * clear;
  const collectedMin = input.collectedMin ?? 0;
  const goodWallMin = wallH(SNR_TIERS.good) * 60;
  const suggestedGoalMin = Number.isFinite(goodWallMin) ? Math.min(GOAL_MAX_MIN, Math.max(GOAL_MIN_MIN, Math.round(goodWallMin / 30) * 30)) : GOAL_MAX_MIN;

  // stars: the magnitude whose peak pixel reaches the well in one sub
  const meanTrans = mean(sliceSky.map((s) => s.trans));
  const peakFrac = Math.min(0.5, 1 / (1.133 * Math.max(1, fwhmPx) ** 2));
  const starRoom = sensor.fullWellE - (eSky + sensor.darkCurrentEPerS) * best.subS;
  const starSat = -2.5 * Math.log10(Math.max(1, starRoom) / (peakFrac * best.subS * F0 * areaCm2(rig.apertureMm) * rig.throughput * f.skyFraction * meanTrans));

  const sqms = sliceSky.map((s) => s.sqm);
  const moonUp = sliceSky.filter((s) => s.moon && s.moon.altDeg > 0);
  const moonLine = moonUp.length
    ? `up for ${Math.round((moonUp.length / sliceSky.length) * 100)}% of the window, ${Math.round(Math.min(...moonUp.map((s) => s.moon!.sepDeg)))}° away at the closest, brightening the sky by up to ${r1(Math.max(...sliceSky.map((s) => skyBrightness({ zenithSqm: input.zenithSqm, altDeg: s.altDeg, moon: null, k: s.k }).sqm - s.sqm)))} mag`
    : 'down for the whole window';
  // per kind: the range of the cap over the window, and where it was tightest
  const caps = [...new Set(sliceSky.filter((s) => s.cap).map((s) => s.cap!.kind))].map((kind) => {
    const of = sliceSky.filter((s) => s.cap?.kind === kind);
    const tight = of.reduce((a, b) => (b.cap!.capS < a.cap!.capS ? b : a));
    const lo = Math.floor(tight.cap!.capS);
    const hi = Math.floor(Math.max(...of.map((s) => s.cap!.capS)));
    return lo === hi ? `${kind} ≤ ${lo}s` : `${kind} ≤ ${lo}s (at ${Math.round(tight.altDeg)}° alt) … ${hi > 3600 ? 'none' : `${hi}s`}`;
  });

  // why this one: what bound it
  const why: string[] = [];
  const longer = candidates.filter((c) => c.filter === best.filter && c.gain === best.gain && c.subS > best.subS).sort((a, b) => a.subS - b.subS)[0];
  const swampS = (5 * sensor.readNoiseE ** 2) / Math.max(1e-9, eSky + sensor.darkCurrentEPerS);
  if (longer) {
    if (longer.heldFrac < best.heldFrac) why.push(`${longer.subS}s subs would lose ${Math.round((1 - longer.heldFrac) * 100)}% of the window (${longer.maxBackgroundFrac > BG_MAX_FRAC ? 'sky background over the limit' : caps.length ? 'trailing' : 'limits'})`);
    else if (longer.coreClips && !best.coreClips) why.push(`${longer.subS}s would clip the target's brightest part`);
    else why.push(`longer subs gain under 3%: the sky's own noise already carries the read noise from ~${Math.max(1, Math.round(swampS))}s (the sky is ${r1(mean(sqms))} mag/arcsec² through ${best.filter})`);
  } else if (swampS > best.subS * 1.5) {
    why.push(`read-noise limited: the sky would need ~${Math.round(swampS)}s to bury the read noise, longer than this device offers in ${rig.mount === 'eq' ? 'EQ' : 'alt-az'} mode — the longest sub it can hold is the best`);
  } else {
    why.push(`the longest sub on offer, and sky-limited from ~${Math.max(1, Math.round(swampS))}s`);
  }
  if (!fixedFilter && filters.length > 1) {
    const other = candidates.filter((c) => c.filter !== best.filter).sort((a, b) => b.merit - a.merit)[0];
    if (other) {
      const ratio = best.merit / Math.max(1e-12, other.merit);
      const lead = ratio >= 1.5 ? `${r1(ratio)}× the signal-to-noise rate` : ratio >= 1.03 ? `${Math.round((ratio - 1) * 100)}% faster to the same SNR` : 'about the same rate, with more headroom';
      why.push(`${best.filter} over ${other.filter}: ${lead} (${target.emission === 'broadband' ? 'a continuum target: a line filter cuts it as hard as the sky' : `an ${target.emission === 'Ha_dominant' ? 'Hα' : 'OIII'} target: ${f.band === 'broadband' ? 'its lines are not worth the sky a narrow filter would cut' : `the filter keeps its lines and cuts ${Math.round((1 - f.skyFraction) * 100)}% of the sky`}`}${moonUp.length ? ', under moonlight' : ''})`);
    }
  }
  if (!rig.gainSettable) why.push(`gain ${best.gain} is the firmware's stack gain`);
  else if (gains.length > 1) {
    const sameOther = candidates.filter((c) => c.filter === best.filter && c.subS === best.subS && c.gain !== best.gain).sort((a, b) => b.merit - a.merit)[0];
    if (sameOther) why.push(`gain ${best.gain}: read noise ${r2(sensor.readNoiseE)} e⁻ and a ${Math.round(sensor.fullWellE)} e⁻ well (gain ${sameOther.gain} would give ${Math.round((sameOther.merit / Math.max(1e-12, best.merit)) * 100)}% of the rate)`);
  }
  why.push(...best.why);
  const cloudySlices = sliceSky.filter((s) => s.cloudLoss > 0);
  const cloudLine = cloudySlices.length
    ? `forecast below ${input.cloudFloor}/100 for ${Math.round((cloudySlices.length / sliceSky.length) * 100)}% of the window (advisory): weighed for subs lost to passing cloud, so the sub is ${best.subS}s${rig.gainSettable ? ` at gain ${best.gain}` : ''}; check the sky first and expect rejected frames`
    : null;
  if (cloudLine) why.unshift(cloudLine);
  if (sbSource === 'nominal') why.push(`no surface brightness in the catalog: judged as a faint ${NOMINAL_SB} mag/arcsec² target`);

  const bgPct = Math.round(best.maxBackgroundFrac * 1000) / 10;
  const headroomNote = best.coreClips
    ? `the brightest part (estimated ~${r1(coreSb!)} mag/arcsec²) reaches ${d.corePct}% of the well even at ${best.subS}s: it will clip; no shorter sub collects as well${pool.some((c) => !c.coreClips) ? '' : ' — accept it or ask the owner (no mixed-exposure stacks)'}`
    : `sky at most ${bgPct}% of the range (limit ${BG_MAX_FRAC * 100}%)${d.corePct !== null ? `, the brightest part ~${d.corePct}% of the well (estimated from its type: check the first subs)` : ''}; stars brighter than ~mag ${r1(starSat)} clip, as stars do`;

  const alternatives = [...candidates]
    .filter((c) => c !== best)
    .sort((a, b) => b.merit - a.merit)
    .filter((c, i, arr) => arr.findIndex((x) => x.filter === c.filter && x.subS === c.subS) === i)
    .slice(0, 4)
    .map((c) => ({ filter: c.filter, gain: c.gain, subS: c.subS, relative: r2(c.relative ?? 0), note: c.why.join('; ') || (c.heldFrac < 1 ? `holds ${Math.round(c.heldFrac * 100)}% of the window` : c.subS < best.subS ? 'shorter: more frames, more read noise' : '') }));

  const apply = applyLine(rig, best.filter, best.gain, best.subS, best.frames);
  const transIdx = slices.map((s) => s.transparencyIdx).filter((x): x is number => x !== undefined);
  const winds = slices.map((s) => s.windKmh).filter((x): x is number => x !== undefined);

  return {
    device: { id: rig.spec.id, name: rig.spec.name, why: rig.why, serial: rig.serial },
    target: { name: target.displayName ?? target.name, type: target.type, emission: target.emission, sb: sbKnown ? r2(sb) : null, sbSource },
    settings: { filter: best.filter, gain: best.gain, gainNote: rig.gainSettable ? 'set it' : 'the firmware sets it', subS: best.subS, frames: best.frames, ditherEverySubs: d.ditherEvery },
    apply,
    why,
    overexposure: {
      backgroundPct: bgPct,
      backgroundAdu: Math.round(d.bgAdu),
      coreClips: best.coreClips,
      corePct: d.corePct,
      starSaturationMag: r1(starSat),
      headroomNote,
    },
    integration: {
      tonightFrames: best.frames,
      tonightMin: Math.round(tonightExpS / 60),
      snrTonight: r1(snrFor(tonightExpS)),
      collectedMin,
      snrSoFar: r1(snrFor(collectedMin * 60 + tonightExpS)),
      hoursTo: { detect: r1(wallH(SNR_TIERS.detect)), good: r1(wallH(SNR_TIERS.good)), deep: r1(wallH(SNR_TIERS.deep)) },
      suggestedGoalMin,
      note: `SNR per Bayer cell at the target's mean surface brightness after the night's ${Math.round(tonightExpS / 60)} min${clear < 0.99 ? ` (${Math.round(clear * 100)}% clear)` : ''}; ${SNR_TIERS.good} is a clean picture, ${SNR_TIERS.deep} a deep one. Hours are wall-clock at this sub's cadence and keep rate.`,
    },
    conditions: {
      sqm: { min: r2(Math.min(...sqms)), max: r2(Math.max(...sqms)), zenith: r2(input.zenithSqm), source: input.sqmSource },
      moon: moonLine,
      fwhmArcsec: r1(fwhmArcsec),
      fwhmSource,
      transparency: transIdx.length ? `7Timer ${Math.min(...transIdx)}–${Math.max(...transIdx)} (extinction ${r2(extinctionFor(Math.max(...transIdx)))} mag/airmass at worst, airmass ${r2(Math.min(...slices.map((s) => airmass(s.altDeg))))}–${r2(Math.max(...slices.map((s) => airmass(s.altDeg))))})` : 'no forecast: an average clear night',
      clouds: cloudLine,
      windMaxKmh: winds.length ? Math.round(Math.max(...winds)) : null,
      caps,
    },
    alternatives,
    sources: {
      sensor: `e⁻/ADU ${r2(sensor.ePerAdu * 1000) / 1000} (${sensor.source.ePerAdu}), read noise ${r2(sensor.readNoiseE)} e⁻ (${sensor.source.readNoise}), black ${Math.round(sensor.blackAdu)} ADU (${sensor.source.black}), clip at ${Math.round(sensor.saturationAdu)} ADU (${sensor.source.saturation})`,
      optics: `${rig.apertureMm} mm, ${rig.focalLengthMm} mm, ${r2(rig.plateScale)}″/px (${rig.sources.optics})`,
      mount: `${rig.mount}${rig.guided ? ', guided' : ''} (${rig.sources.mount === 'device' ? 'the scope says' : 'PLAN_MOUNT'})`,
      exposures: `${rig.subsS.join('/')} s (${rig.sources.exposures})`,
      filters: `${rig.filters.map((x) => x.name).join(', ')} (${rig.sources.filters})`,
    },
    missing: rig.missing,
  };
}

/** How the agent applies the settings, in the running driver's tool calls. */
export function applyLine(rig: Rig, filter: string, gain: number, subS: number, frames: number): string {
  if (rig.spec.driver === 'seestar') {
    const lp = (findFilter(rig.filters, filter)?.band ?? 'broadband') !== 'broadband';
    return `set_camera_setting setting=exposure value=${subS}; goto_target … lp_filter=${lp}${rig.gainSettable ? `; set_gain gain=${gain}` : ''}; then start_stacking`;
  }
  return `live_stacking action=start exposure=${subS} gain=${gain} filter=${filter} frames=${Math.min(999, Math.max(1, frames || 999))}`;
}
