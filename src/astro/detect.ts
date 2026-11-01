/**
 * How shootable a target actually is tonight: what the sky, the glass and the Moon do to it.
 *
 * The planner used to rank on magnitude, which cannot tell a 20-minute target from a 20-hour
 * one — two objects at mag 11 differ by an order of magnitude in surface brightness, and the
 * Moon was a flat penalty on broadband targets only. This is the detectability judgement
 * Clear Night Coach scores with (its `engine.py`: `BORTLE_SQM`/`detect_bucket`,
 * `moon_sensitivity`/`moonlit_keep`, `conditions_penalty`), ported to this catalog and this rig:
 *
 * - the site's Bortle class shifts the surface-brightness thresholds (a dark site buys faint
 *   targets, a suburban one takes them away) — the whole ladder moves with `PLAN_BORTLE`;
 * - the filter band decides whether Ha/OIII targets are reachable at all: a Ha region shot
 *   bare gets no credit for a narrowband filter the user does not own;
 * - the Moon costs a *fraction of a minute's value* per minute it is up, by class, so a
 *   narrowband target survives a gibbous Moon and a dark nebula does not.
 *
 * Units: `sb` here is mean surface brightness in mag/arcsec², which is what the catalog's column
 * carries. The source engine's own catalog keeps the same quantity 2.5·log10(3600) lower (its
 * column is `mag + 2.5·log10(area)` over the **arcminute** axes): joining the two catalogs on
 * 8 536 shared rows gives a median offset of exactly 8.8934 with σ 0.031. So `SB_AXIS` shifts the
 * borrowed ladder onto this axis rather than comparing the two scales silently. The ladder's
 * numbers are the ones the source engine is tuned with; only the axis is converted.
 */
import type { DsoObject } from './catalog.js';

/** Bortle class → sky brightness (mag/arcsec²); the reference class of the un-shifted thresholds. */
export const BORTLE_SQM: Record<number, number> = {
  1: 22.0, 2: 21.9, 3: 21.8, 4: 21.1, 5: 20.0, 6: 19.2, 7: 18.7, 8: 18.1, 9: 17.5,
};
export const REFERENCE_BORTLE = 5;

/** Source-engine `sb` units − catalog `sb` units: 2.5·log10(3600), measured (see the header). */
const SB_AXIS = 8.8934;
/**
 * Median offset of the measured column from `mag + 2.5·log10(area)` over the arcminute axes
 * (σ 0.54, over the 10 269 rows that carry magnitude and axes): the constant that puts an
 * estimate on the same axis as a measurement.
 */
const SB_ESTIMATE_OFFSET = 9.449;

/** A target brighter than this stands out on its own (mag/arcsec² on the catalog's axis). */
const DETECT_EASY_SB = 12.5 + SB_AXIS;
/** From here a broadband target needs real integration; from HOPELESS it is not a picture tonight. */
const DETECT_FAINT_SB = 14.5 + SB_AXIS;
const DETECT_HOPELESS_SB = 18.75 + SB_AXIS;
/** A faint broadband target fades between NEEDS_INTEG and this instead of falling off a cliff. */
const FAINT_BROADBAND_DETECT = 35;
/** Dark nebulae are contrast targets: above this Bortle class the sky gradient buries them. */
const DRKN_SKIP_BORTLE = 7;

export type Bucket = 'EASY' | 'NEEDS_INTEG' | 'SKIP_TONIGHT' | 'UNKNOWN';

const BUCKET_SCORE: Record<Exclude<Bucket, 'UNKNOWN'>, number> = { EASY: 100, NEEDS_INTEG: 60, SKIP_TONIGHT: 10 };

/** How much of the sky the filter passes: broadband everything, a line filter ~3%.
 * Also what makes narrowband work in moonlight, so the same table serves the Moon model. */
export type BandClass = 'broadband' | 'uhc' | 'duo_wide' | 'duo_tight' | 'line';
export const F_BAND: Record<BandClass, number> = { broadband: 1.0, uhc: 0.25, duo_wide: 0.12, duo_tight: 0.12, line: 0.03 };

/** Emission profile: which lines carry the target's light, hence which glass reaches it. */
export type Emission = 'broadband' | 'Ha_dominant' | 'OIII_dominant';

const HA_BUCKET_TABLE: Record<BandClass, [Exclude<Bucket, 'UNKNOWN'>, Exclude<Bucket, 'UNKNOWN'>]> = {
  broadband: ['NEEDS_INTEG', 'SKIP_TONIGHT'],
  uhc: ['NEEDS_INTEG', 'NEEDS_INTEG'],
  duo_wide: ['EASY', 'NEEDS_INTEG'],
  duo_tight: ['EASY', 'NEEDS_INTEG'],
  line: ['EASY', 'NEEDS_INTEG'],
};

const clampBortle = (bortle: number | undefined): number => {
  const b = Math.round(Number(bortle));
  return Number.isFinite(b) ? Math.min(9, Math.max(1, b)) : REFERENCE_BORTLE;
};

/** Tonight's sky brightness for a Bortle class (the reference class when it is not a number). */
export function sqmFor(bortle: number | undefined): number {
  return BORTLE_SQM[clampBortle(bortle)];
}

/** mag/arcsec² the thresholds move for this Bortle class (0 at the reference class). */
export function sbShift(bortle: number | undefined): number {
  return sqmFor(bortle) - sqmFor(REFERENCE_BORTLE);
}

const TIGHT_BRANDS = ['l-extreme', 'l-ultimate', 'nbz'];
const DUO_KEYS = ['dual-band', 'dual band', 'dual narrowband', 'duo', 'tri-band', 'tri band', 'l-enhance'];
const UHC_KEYS = ['uhc'];
const LINE_KEYS = ['h-alpha', 'halpha', 'hα', 'oiii', 'o-iii', 'o iii', 'sii', 's-ii', 's ii'];
/** A named single-line filter is 3–12 nm wide; ≤9 nm on a duo is a tight-band (dual 5 nm class). */
const WIDTH_RE = /(\d+(?:\.\d+)?)\s*nm/g;
const TIGHT_NM = 9;
const LINE_NM_LO = 3;
const LINE_NM_HI = 12;

/**
 * Filter name/bandpass text → class. One classifier for the whole app: the Moon model and the
 * sub-exposure bandpass both read it, and two keyword lists over the same strings drift apart
 * (the source engine learned that the hard way, classing L-eXtreme two ways).
 */
export function classifyFilter(text: string | undefined): BandClass {
  const b = String(text ?? '').toLowerCase();
  const widths = [...b.matchAll(WIDTH_RE)].map((m) => Number(m[1]));
  const duo = DUO_KEYS.some((k) => b.includes(k));
  if (TIGHT_BRANDS.some((k) => b.includes(k))) return 'duo_tight';
  if (duo && widths.some((w) => w <= TIGHT_NM)) return 'duo_tight';
  if (duo) return 'duo_wide';
  if (UHC_KEYS.some((k) => b.includes(k))) return 'uhc';
  if (LINE_KEYS.some((k) => b.includes(k))) return 'line';
  if (widths.some((w) => w >= LINE_NM_LO && w <= LINE_NM_HI)) return 'line';
  if (b.includes('narrow')) return 'uhc';
  return 'broadband';
}

/** What each source catalog says about the light, whichever type code the row carries. */
const SOURCE_EMISSION: Record<string, Emission> = {
  sh2: 'Ha_dominant', rcw: 'Ha_dominant', ced: 'Ha_dominant',
  pn: 'OIII_dominant', green: 'OIII_dominant',
  vdb: 'broadband', ldn: 'broadband', dias: 'broadband', harris: 'broadband', rc3: 'broadband', arp: 'broadband', hcg: 'broadband', aco: 'broadband',
};

/**
 * What carries this target's light. Derived from the catalog's own type code and source
 * membership rather than a hand-curated table: Sharpless/RCW/Cederblad regions and emission
 * nebulae are hydrogen-alpha objects, the planetary and SNR catalogs are oxygen-III objects,
 * and reflection, dark, cluster and galaxy rows are broadband continuum targets.
 */
export function emissionOf(o: Pick<DsoObject, 'type' | 'sources'>): Emission {
  if (o.type === 'RfN' || o.type === 'DrkN') return 'broadband';
  if (o.type === 'PN' || o.type === 'SNR') return 'OIII_dominant';
  if (o.type === 'HII' || o.type === 'EmN' || o.type === 'Neb' || o.type === 'Cl+N') return 'Ha_dominant';
  const declared = (want: Emission) => o.sources.some((k) => SOURCE_EMISSION[k] === want);
  if (declared('OIII_dominant')) return 'OIII_dominant';
  if (declared('Ha_dominant')) return 'Ha_dominant';
  return 'broadband';
}

export interface SurfaceBrightness {
  sb: number;
  /** True when it was computed from magnitude and axes rather than measured: see `detectFor`. */
  estimated: boolean;
}

/**
 * Mean surface brightness in mag/arcsec² on the catalog's axis, or null when nothing supports
 * one. A measured column always wins; otherwise galaxies and clusters get the mean of their
 * magnitude over their isophotal area (the relation the catalog's own column follows), and
 * nebulae without a magnitude fall back on the catalog's brightness class, which exists for
 * exactly those rows (Sharpless, Lynds, RCW).
 */
export function surfaceBrightness(o: DsoObject): SurfaceBrightness | null {
  if (o.surfaceBrightness !== undefined && Number.isFinite(o.surfaceBrightness)) {
    return { sb: o.surfaceBrightness, estimated: false };
  }
  const { mag, majorArcmin: a, minorArcmin: b } = o;
  const areaArcmin2 = a && a > 0 ? (Math.PI / 4) * a * (b && b > 0 ? b : a) : undefined;
  // The magnitude-over-area relation only means something for objects whose catalog magnitude
  // is integrated photometry. For nebulae the OpenNGC magnitude is a visual estimate, and
  // turning it into a surface brightness has condemned bright objects like M 42 in tests.
  const stellarLike = ['G', 'GPair', 'GTrpl', 'GGroup', 'GCl', 'GClstr', 'OCl', 'Cl+N', '*Ass'].includes(o.type);
  if (mag !== undefined && Number.isFinite(mag) && areaArcmin2 && stellarLike) {
    // The constant puts the estimate on the measured column's axis (see SB_ESTIMATE_OFFSET).
    return { sb: mag + 2.5 * Math.log10(areaArcmin2) + SB_ESTIMATE_OFFSET, estimated: true };
  }
  if (o.brightClass !== undefined && Number.isFinite(o.brightClass)) {
    // 1 bright … 3 faint, placed on the ladder the measured column occupies.
    const byClass: Record<number, number> = { 1: DETECT_EASY_SB + 0.4, 2: (DETECT_EASY_SB + DETECT_FAINT_SB) / 2, 3: DETECT_FAINT_SB + 0.4 };
    const cls = Math.min(3, Math.max(1, Math.round(o.brightClass)));
    return { sb: byClass[cls], estimated: true };
  }
  return null;
}

export interface Detectability {
  sb: number | null;
  sbEstimated: boolean;
  emission: Emission;
  band: BandClass;
  bucket: Bucket;
  /** 0–100 detectability component of the plan score. */
  score: number;
  /** One line saying why, for the Tonight tab and the agent. */
  reason: string;
}

/**
 * The detectability bucket for one target under one sky through one filter.
 *
 * An estimated surface brightness can cost a target its EASY badge but never condemns it: only
 * a measured figure (or a rule that needs no figure, like the dark-nebula sky gate) yields
 * SKIP_TONIGHT. Missing data is UNKNOWN at the neutral score, never a skip — the catalog has
 * surface brightness for 14% of its rows, and silence is not evidence of faintness.
 */
export function detectFor(o: DsoObject, opts: { bortle?: number; filter?: string } = {}): Detectability {
  const band = classifyFilter(opts.filter);
  const emission = emissionOf(o);
  const bortle = clampBortle(opts.bortle);
  const shift = sbShift(bortle);
  const measured = surfaceBrightness(o);
  const sb = measured?.sb;
  const estimated = measured?.estimated ?? false;
  const has = sb !== undefined && Number.isFinite(sb);
  const bright = has ? sb! <= DETECT_EASY_SB + shift : false;

  const demote = (bucket: Exclude<Bucket, 'UNKNOWN'>, reason: string): { bucket: Bucket; score: number; reason: string } => {
    if (estimated && bucket === 'EASY') return { bucket: 'NEEDS_INTEG', score: BUCKET_SCORE.NEEDS_INTEG, reason: `${reason} (brightness estimated, not measured)` };
    return { bucket, score: BUCKET_SCORE[bucket], reason };
  };

  if (o.type === 'DrkN') {
    if (bortle >= DRKN_SKIP_BORTLE) {
      return { sb: sb ?? null, sbEstimated: estimated, emission, band, bucket: 'SKIP_TONIGHT', score: BUCKET_SCORE.SKIP_TONIGHT, reason: `a dark nebula is a contrast target and Bortle ${bortle} has no dark enough sky gradient for it` };
    }
    return { sb: sb ?? null, sbEstimated: estimated, emission, band, ...demote('NEEDS_INTEG', 'silhouette work: needs a transparent, moonless sky') };
  }

  if (!has) {
    return { sb: null, sbEstimated: false, emission, band, bucket: 'UNKNOWN', score: BUCKET_SCORE.NEEDS_INTEG, reason: 'no surface brightness or brightness class in the catalog: judged without it' };
  }

  if (emission === 'Ha_dominant') {
    const [b0, b1] = HA_BUCKET_TABLE[band];
    const pick = bright ? b0 : b1;
    const glass = band === 'broadband' ? 'no filter' : `${band} filter`;
    if (pick === 'EASY') return { sb, sbEstimated: estimated, emission, band, ...demote('EASY', `hydrogen-alpha region through ${glass}: the line is isolated, so it comes up quickly`) };
    if (pick === 'NEEDS_INTEG') return { sb, sbEstimated: estimated, emission, band, ...demote('NEEDS_INTEG', `hydrogen-alpha region through ${glass}: workable, but it needs time`) };
    return { sb, sbEstimated: estimated, emission, band, bucket: 'SKIP_TONIGHT', score: BUCKET_SCORE.SKIP_TONIGHT, reason: `faint hydrogen-alpha region with no filter — the sky gradient swamps it; a duo-band or Ha filter is what makes it` };
  }

  if (emission === 'OIII_dominant') {
    if (sb! >= DETECT_HOPELESS_SB + shift) {
      return { sb, sbEstimated: estimated, emission, band, bucket: 'SKIP_TONIGHT', score: BUCKET_SCORE.SKIP_TONIGHT, reason: 'oxygen-III object far below the sky: not a broadband picture from this sky tonight' };
    }
    if (sb! >= DETECT_FAINT_SB + shift) {
      if (band === 'broadband') {
        return { sb, sbEstimated: estimated, emission, band, bucket: 'SKIP_TONIGHT', score: BUCKET_SCORE.SKIP_TONIGHT, reason: 'faint oxygen-III object with no filter: OIII needs a narrowband filter to come through a lit sky' };
      }
      return { sb, sbEstimated: estimated, emission, band, ...demote('NEEDS_INTEG', 'faint oxygen-III object: only the line gets it out of the sky') };
    }
    return { sb, sbEstimated: estimated, emission, band, ...demote(bright ? 'EASY' : 'NEEDS_INTEG', bright ? 'bright oxygen-III object' : 'oxygen-III object with fair surface brightness') };
  }

  // Broadband continuum: galaxies, clusters, reflection nebulae.
  if (sb! >= DETECT_HOPELESS_SB + shift) {
    return { sb, sbEstimated: estimated, emission, band, bucket: 'SKIP_TONIGHT', score: BUCKET_SCORE.SKIP_TONIGHT, reason: `mean surface brightness ${(sb! - SB_AXIS).toFixed(1)} mag/arcsec², ${(sb! - SB_AXIS - sqmFor(bortle)).toFixed(1)} mag below tonight's sky — hours of integration for a faint smudge at this aperture` };
  }
  if (sb! >= DETECT_FAINT_SB + shift) {
    const frac = Math.min(1, Math.max(0, (sb! - (DETECT_FAINT_SB + shift)) / (DETECT_HOPELESS_SB - DETECT_FAINT_SB)));
    const score = Math.round((BUCKET_SCORE.NEEDS_INTEG - (BUCKET_SCORE.NEEDS_INTEG - FAINT_BROADBAND_DETECT) * frac) * 10) / 10;
    if (estimated) return { sb, sbEstimated: true, emission, band, bucket: 'NEEDS_INTEG', score: BUCKET_SCORE.NEEDS_INTEG, reason: 'faint broadband target on an estimated brightness: judge it by its total magnitude' };
    return { sb, sbEstimated: estimated, emission, band, bucket: 'NEEDS_INTEG', score, reason: `faint broadband target, ${(sb! - SB_AXIS - sqmFor(bortle)).toFixed(1)} mag below the sky: integration is the only way to it` };
  }
  return { sb, sbEstimated: estimated, emission, band, ...demote(bright ? 'EASY' : 'NEEDS_INTEG', bright ? 'bright enough to stand above the sky on its own' : 'moderate surface brightness: some integration, no hero time') };
}

/** Moon sensitivity: how much of a moonlit minute is still worth integrating. */
const MOON_SENS_BY_CLASS: Record<BandClass, number> = { broadband: 0, uhc: 0.5, duo_wide: 0.45, duo_tight: 0.3, line: 0.3 };
const MOON_SENS_BRIGHT = 0.45;
const MOON_SENS_FAINT = 0.95;

/**
 * How strongly the Moon hurts this target (0 = irrelevant, 1 = the sky is the noise).
 * A line filter rejects the continuum the Moon adds, so it stays workable in a gibbous Moon;
 * a faint broadband target and a dark nebula are essentially moonlight-intolerant.
 */
export function moonSensitivity(d: Detectability): number {
  if (d.band !== 'broadband') return MOON_SENS_BY_CLASS[d.band];
  if (d.emission !== 'broadband') return MOON_SENS_BY_CLASS.uhc;
  if (d.bucket === 'EASY') return MOON_SENS_BRIGHT;
  return MOON_SENS_FAINT;
}

/**
 * Fraction of a moonlit minute's value retained tonight, 0–1. `moonStrength` is the Moon's
 * illumination fraction (0–1); a new Moon keeps every minute, a full one keeps almost none of a
 * faint broadband minute and most of a narrowband one.
 */
export function moonlitKeep(d: Detectability, moonStrength: number): number {
  const strength = Number.isFinite(moonStrength) ? Math.min(1, Math.max(0, moonStrength)) : 0;
  return Math.max(0, 1 - moonSensitivity(d) * strength);
}

/** How much a target's appearance depends on the atmosphere: gears and galaxies, not emission. */
const SEEING_SENS: Record<string, number> = {
  PN: 1.0, G: 1.0, GPair: 1.0, GTrpl: 1.0, GGroup: 1.0,
  GCl: 0.7,
  OCl: 0.3,
  HII: 0.1, EmN: 0.1, RfN: 0.1, SNR: 0.1, Neb: 0.1, 'Cl+N': 0.2, DrkN: 0.2,
};
const SEEING_SENS_DEFAULT = 0.4;
/** 0–1: how much a target type's result depends on the seeing (galaxies and planetaries most, emission least). */
export const seeingSensitivity = (type: string | undefined): number => (type ? (SEEING_SENS[type] ?? SEEING_SENS_DEFAULT) : SEEING_SENS_DEFAULT);
const SEEING_MAX_PEN = 8;
const TRANS_MAX_PEN = 10;
/** 7Timer scales: 1 best … 8 worst. The ramp starts at GOOD and is fully on at BAD. */
const SEEING_GOOD = 4;
const SEEING_BAD = 7;
const TRANS_GOOD = 3;
const TRANS_BAD = 7;

const ramp = (idx: number, good: number, bad: number): number => Math.min(1, Math.max(0, (idx - good) / (bad - good)));

/**
 * Demerit for tonight's seeing and transparency against what THIS target needs (7Timer
 * indices, 1 best … 8 worst). Poor seeing costs a planetary nebula or a galaxy its sharpness
 * and barely touches an emission nebula; poor transparency costs a faint target far more than
 * one that is already above the sky.
 */
export function conditionsPenalty(o: Pick<DsoObject, 'type'>, bucket: Bucket, seeingIdx?: number, transparencyIdx?: number): number {
  let pen = 0;
  if (seeingIdx !== undefined && Number.isFinite(seeingIdx)) pen += SEEING_MAX_PEN * ramp(seeingIdx, SEEING_GOOD, SEEING_BAD) * (SEEING_SENS[o.type] ?? SEEING_SENS_DEFAULT);
  if (transparencyIdx !== undefined && Number.isFinite(transparencyIdx)) pen += TRANS_MAX_PEN * ramp(transparencyIdx, TRANS_GOOD, TRANS_BAD) * (bucket === 'EASY' ? 0.2 : 1.0);
  return pen;
}

/** What people photograph, roughly: the type's pull independent of tonight's geometry. */
const TYPE_APPEAL: Record<string, number> = {
  G: 100, GPair: 100, GTrpl: 100, GGroup: 100,
  PN: 100, HII: 100, EmN: 100, RfN: 100, SNR: 100, Neb: 100, 'Cl+N': 100,
  GCl: 80, DrkN: 70,
  OCl: 15,
};
const DEFAULT_APPEAL = 60;

export const appealScore = (type: string): number => TYPE_APPEAL[type] ?? DEFAULT_APPEAL;
