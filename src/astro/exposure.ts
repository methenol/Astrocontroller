/**
 * The sub-exposure answer: how long a sub should be on THIS rig under THIS sky, and how many
 * of them fit into the time a target actually has.
 *
 * The planner used to say "6 h up" and leave exposure to whoever pressed Image. Two numbers
 * decide sub length, and both are computable rather than guessable:
 *
 * 1. the camera's read-noise tax. Once the sky's own shot noise over an exposure exceeds
 *    ~5×RN² electrons per pixel, a longer sub buys nothing — it is *sky-limited*. That moment
 *    depends on sky brightness (Bortle), focal ratio and pixel size (aperture cancels: sky flux
 *    per pixel is a focal-ratio property), and on how much of the sky the filter passes.
 * 2. the mount's trailing ceiling. A Dwarf 3 tracks in alt-azimuth, so field rotation — worst
 *    near the zenith — caps a sub long before the sky-limited length for most sites.
 *
 * The shorter of the two is the answer, and the reason for it is worth as much as the number:
 * "30 s because your mount caps it" and "30 s because the sky is bright" call for different
 * responses. This is the model Clear Night Coach's `subexposure.py` ships (its constants and
 * ladder), with the wording and the mount terms written for a Dwarf.
 */
import { F_BAND, sqmFor, type BandClass } from './detect.js';

/** Exposure lengths worth offering; a sub is never an arbitrary number of seconds. */
export const SUB_LADDER = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600];
/** Nothing longer is ever recommended: dithering, plate-solve cycles and patience run out. */
export const SUB_CLAMP_S = 600;
/** Below this a sub is frame management, not a noise win — the floor the advice starts at. */
export const FLOOR_S = 30;
/** Within 2% of a rung, take the rung: a 0.5% shortfall must not buy a 33% jump. */
const SNAP_DOWN = 1.02;
/** Seconds until the sky's shot noise carries k×RN² electrons, past which read noise is noiseless. */
const K_ENOUGH = 5;
/** Read noise of an unknown camera: modern low-noise CMOS to an older sensor/DSLR. */
const RN_UNKNOWN_LO = 1.5;
const RN_UNKNOWN_HI = 3.5;

/**
 * Calibration of the sky-electron formula: F0 folds the quantum efficiency and the throughput
 * of a typical OSC astro camera, ETA the fraction of a pixel's sky area a star's flux effectively
 * occupies, π/4 ÷ 100 the source engine's PSF-disc factor. Verified against the source engine's
 * numbers rather than re-derived. The signal per pixel is collecting area × pixel solid angle, so
 * it is written as (aperture × plate scale)² — the two quantities this app can actually name.
 */
const F0 = 879_000;
const GEOM = (Math.PI / 4) / 100;
const ETA = 0.3;

/** Alt-az field rotation: worst high in the sky, so near-zenith transits get the shorter rung. */
const ROTATION_CAP_NEAR_ZENITH_S = 15;
const ROTATION_CAP_S = 20;
/** Wind above this shakes an alt-az head enough to cap subs; the calm rung equals rotation's. */
const WIND_CAP_KMH = 15;
const WINDY_SUB_CAP_S = 10;
/** Budget unguided equatorials: ~0.1″/s sustained drift puts a 4″ trail on the ladder below. */
const UNGUIDED_EQ_TRAIL_BUDGET = 30_000;
const UNGUIDED_CAP_MIN_S = 15;
const UNGUIDED_CAP_MAX_S = 120;

export type Mount = 'alt-az' | 'eq';

export interface Rig {
  /** arcsec per pixel of the frame being planned for (`plateScaleArcsecPerPx` of the app's lens) */
  plateScaleArcsecPerPx: number;
  /**
   * Clear aperture in mm — the one optics number the app cannot read from the scope. Without it
   * the sky-limited sub length is unknowable and only the mount cap can be answered.
   */
  apertureMm?: number;
  /** Read noise in electrons; omit it and the answer is a range, not a number. */
  readNoise?: number;
  /** What is in the light path (broadband when nothing is). */
  band: BandClass;
  mount: Mount;
  /** Guided equatorials have no trailing cap; everything else does. */
  guided: boolean;
  /** Effective focal length in mm, needed only for the unguided-equatorial cap. */
  effectiveFlMm?: number;
}

export interface SubPlan {
  /** Sky brightness used (mag/arcsec²). */
  sqm: number;
  /** Sky electrons per pixel per second through this band. */
  skyElectronsPerPxS: number;
  /** Seconds until the sky swamps the read-noise tax (null with an unknown read noise). */
  swampS: number | null;
  /** Recommended sub length, or the lower bound of the range when the read noise is unknown. */
  subS: number;
  /** `[lo, hi]` when the camera's read noise is unknown and the two give different rungs. */
  subRangeS: [number, number] | null;
  /** The mount/trailing ceiling that binds, or null when nothing does. */
  capS: number | null;
  capKind: 'rotation' | 'periodic-error' | 'wind' | null;
  /** True when the cap, not the sky, is what sets the length. */
  capBound: boolean;
  readNoise: number | null;
  /** Whole subs of this length that fit the target's usable minutes. */
  subs: number;
  /** Total integration those subs come to, in minutes. */
  integrationMin: number;
  /** The one-line advice to quote. */
  line: string;
}

/**
 * Sky electrons per pixel per second: what the sky deposits in one pixel through one band. It
 * depends on aperture and pixel solid angle only (focal length cancels), which is why the rig is
 * stated as aperture × plate scale.
 */
export function skyElectronRate(sqm: number, plateScaleArcsecPerPx: number, apertureMm: number, band: BandClass): number {
  if (!(plateScaleArcsecPerPx > 0) || !(apertureMm > 0) || !Number.isFinite(sqm)) return 0;
  return F0 * 10 ** (-0.4 * sqm) * GEOM * (plateScaleArcsecPerPx * apertureMm) ** 2 * ETA * F_BAND[band];
}

/** Seconds until the sky's shot noise carries `k`×RN² electrons (the read-noise tax is paid). */
export function swampSeconds(readNoise: number, skyElectronsPerPxS: number, k = K_ENOUGH): number {
  if (!(skyElectronsPerPxS > 0)) return Infinity;
  return (k * readNoise * readNoise) / skyElectronsPerPxS;
}

/** Round an exposure up to the ladder, snapping back within 2%; clamped at the top rung. */
export function ladderRound(seconds: number): { rung: number; clamped: boolean } {
  if (!Number.isFinite(seconds)) return { rung: SUB_CLAMP_S, clamped: true };
  for (const rung of SUB_LADDER) {
    if (seconds <= rung * SNAP_DOWN) return { rung, clamped: seconds > SUB_CLAMP_S };
  }
  return { rung: SUB_CLAMP_S, clamped: true };
}

/** The mount's own trailing ceiling in seconds, and which kind of trailing it is. */
export function mountSubCap(rig: Rig, transitAlt: number): { capS: number | null; capKind: SubPlan['capKind'] } {
  if (rig.mount === 'eq' && rig.guided) return { capS: null, capKind: null };
  if (rig.mount === 'eq') {
    const fl = Number(rig.effectiveFlMm);
    if (!(fl > 0)) return { capS: UNGUIDED_CAP_MIN_S, capKind: 'periodic-error' };
    const budget = UNGUIDED_EQ_TRAIL_BUDGET / fl;
    // rounded DOWN: a ceiling must not be exceeded, and a fine-pixel camera buys no tracking
    const down = SUB_LADDER.filter((r) => r <= budget).pop() ?? SUB_LADDER[0];
    return { capS: Math.min(UNGUIDED_CAP_MAX_S, Math.max(UNGUIDED_CAP_MIN_S, down)), capKind: 'periodic-error' };
  }
  const alt = Number.isFinite(transitAlt) ? transitAlt : 60;
  return { capS: alt >= 80 ? ROTATION_CAP_NEAR_ZENITH_S : ROTATION_CAP_S, capKind: 'rotation' };
}

/** Tonight's wind cap for an alt-az head; an equatorial's wind risk is dropped frames, not trails. */
export function windSubCap(windKmh: number | undefined, mount: Mount): number | null {
  if (mount === 'eq') return null;
  return windKmh !== undefined && Number.isFinite(windKmh) && windKmh >= WIND_CAP_KMH ? WINDY_SUB_CAP_S : null;
}

/**
 * The sub-exposure plan for one target: `usableMin` are the minutes it is worth pointing at
 * (the planner's moon- and weather-weighted figure), and everything else comes from the rig
 * and tonight's sky. Returns null when the frame's plate scale is unusable — a wrong sub length is
 * worse than none, because it is quoted as advice. Without an aperture (PLAN_APERTURE_MM) the
 * sky-limited length is unknowable, so the answer is the mount's own ceiling and the reason why.
 */
export function subPlan(opts: { rig: Rig; bortle?: number; transitAlt: number; usableMin: number; moonUp?: boolean; windKmh?: number }): SubPlan | null {
  const { rig } = opts;
  if (!(rig.plateScaleArcsecPerPx > 0)) return null;
  const sqm = sqmFor(opts.bortle);
  const apertureMm = Number(rig.apertureMm);
  const eSky = skyElectronRate(sqm, rig.plateScaleArcsecPerPx, apertureMm, rig.band);

  const mount = mountSubCap(rig, opts.transitAlt);
  const wind = windSubCap(opts.windKmh, rig.mount);
  let capS = mount.capS;
  let capKind = mount.capKind;
  if (wind !== null && (capS === null || wind < capS)) {
    capS = wind;
    capKind = 'wind';
  }

  const usableSec = Math.max(0, opts.usableMin * 60);
  const rn = Number.isFinite(Number(rig.readNoise)) && Number(rig.readNoise) > 0 ? Number(rig.readNoise) : null;
  const base = { sqm, skyElectronsPerPxS: Math.round(eSky * 1000) / 1000, capS, capKind, readNoise: rn };
  const fit = (subS: number) => {
    const subs = subS > 0 ? Math.floor(usableSec / subS) : 0;
    return { subs, integrationMin: Math.round((subs * subS) / 60) };
  };

  if (!(eSky > 0)) {
    // No aperture configured: the sky term is unknowable, so only the mount's ceiling is honest.
    const shown = capS === null ? FLOOR_S : Math.max(1, Math.min(capS, FLOOR_S));
    return {
      ...base,
      ...fit(shown),
      swampS: null,
      subS: shown,
      subRangeS: null,
      capBound: capS !== null,
      line: capS === null
        ? `${shown}s subs as a starting point: the sky-limited length needs the aperture of the lens — set PLAN_APERTURE_MM and the plan will say whether that is enough.`
        : `${shown}s subs: ${capKind === 'wind' ? "tonight's wind caps them" : capKind === 'rotation' ? 'alt-az field rotation trails the corners beyond this' : 'unguided tracking trails the stars beyond this'} — whether the sky rewards more needs the aperture of the lens: set PLAN_APERTURE_MM.`,
    };
  }

  if (rn !== null) {
    const swamp = swampSeconds(rn, eSky);
    const { rung, clamped } = ladderRound(swamp);
    const shown = capS === null ? Math.max(FLOOR_S, rung) : Math.max(1, Math.min(capS, Math.max(FLOOR_S, rung)));
    const capBound = capS !== null && rung > capS;
    return {
      ...base,
      ...fit(shown),
      swampS: Math.round(swamp),
      subS: shown,
      subRangeS: null,
      capBound,
      line: capBound
        ? `${shown}s subs: ${capKind === 'wind' ? `tonight's wind (${Math.round(opts.windKmh!)} km/h) is the limit` : capKind === 'rotation' ? 'alt-az field rotation trails the corners beyond this' : 'unguided tracking trails the stars beyond this'} — the sky would reward ${rung}s, so make it up in frame count, not length${opts.moonUp ? ', and moonlight keeps these on the safe side' : ''}.`
        : clamped
          ? `${shown}s subs — sky-limited; longer buys nothing but files${opts.moonUp ? ', and the Moon keeps these on the safe side' : ''}.`
          : `${shown}s subs are sky-limited at your site: the sky's own noise already carries the read-noise tax, so longer buys nothing — add frames instead${opts.moonUp ? '; moonlight keeps these on the safe side' : ''}.`,
    };
  }

  // Unknown read noise: two honest answers rather than one invented one.
  const lo = Math.max(FLOOR_S, ladderRound(swampSeconds(RN_UNKNOWN_LO, eSky)).rung);
  const hi = Math.max(FLOOR_S, ladderRound(swampSeconds(RN_UNKNOWN_HI, eSky)).rung);
  const shown = capS === null ? lo : Math.max(1, Math.min(capS, lo));
  // The mount is the binding constraint when even a noisy sensor would want more than it can hold.
  const capBound = capS !== null && capS < hi;
  const capText = capKind === 'wind'
    ? `tonight's wind (${Math.round(opts.windKmh!)} km/h) is the limit`
    : capKind === 'rotation' ? 'alt-az field rotation trails the corners beyond this' : 'unguided tracking trails the stars beyond this';
  const range = lo === hi ? `${lo}s is enough` : `${lo}–${hi}s are enough`;
  return {
    ...base,
    ...fit(shown),
    swampS: null,
    subS: shown,
    subRangeS: capBound ? null : [lo, hi],
    capBound,
    line: capBound
      ? `${shown}s subs: ${capText} — a low-noise camera would be content with ${lo}s and an older sensor would want ${hi}s, which this mount cannot hold, so make it up in frame count, not length. Set PLAN_READ_NOISE_E for one number.`
      : `${range} tonight (modern low-noise sensor to older sensor — the sky, not the camera, is the limit). Set PLAN_READ_NOISE_E for a single number${opts.moonUp ? '; moonlight keeps these on the safe side' : ''}.`,
  };
}
