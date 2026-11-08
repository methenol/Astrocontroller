/**
 * Night planning: rank the catalog for one window at one site, and say what it would take to
 * photograph each candidate.
 *
 * The score answers four independent questions, weighted the way Clear Night Coach weights its
 * own decision (framing 20%, reach 10%, integration 30%, detectability 15%, appeal 25%):
 *
 * - **framing** — does it fit the tele frame at all;
 * - **reach** — what fraction of tonight it is up, i.e. how much slack there is around it;
 * - **integration** — how many minutes it is worth pointing at, after the Moon (by target and
 *   filter class), alt-az field rotation near the zenith, and the duty cycle of a real session;
 * - **detectability** — whether its surface brightness is above tonight's sky at all;
 * - **appeal** — whether anyone prints the result.
 *
 * Two layers then scale or subtract from that: the forecast, weighted toward the target's own
 * peak hours (the best targets are those whose optimal time coincides with clear sky), and the
 * app's memory — what was suggested recently and what the library already holds.
 *
 * Geometry is sampled every 15 minutes; the catalog is funnelled on a cheap proxy first so the
 * ephemeris is only paid for the ~400 rows that could plausibly make the list.
 */
import { catalog, displayName, gotoLabel, typeGroup, type DsoObject } from './catalog.js';
import { nightWindow, moonState, separationDeg, fmtTime, localDate, bodyAlt, type Site, altAz } from './sky.js';
import { appealScore, conditionsPenalty, detectFor, emissionOf, moonlitKeep, sqmFor, classifyFilter, type BandClass, type Bucket, type Detectability, type Emission } from './detect.js';
import { subPlan, type Rig } from './exposure.js';
import { captureRecords, loadRest, restPenalty, restState, type RestRecord } from './rest.js';
import type { HourConditions } from './weather.js';
import type { Horizon } from './horizon.js';
import { clearsAt } from './sightings.js';

export interface PlanOptions {
  start?: Date;
  end?: Date;
  minAltitude: number;
  types?: string[]; // group names or OpenNGC codes
  maxMagnitude?: number;
  minSizeArcmin?: number;
  maxSizeArcmin?: number;
  /** only targets whose major axis covers at least this percent of the tele frame width */
  minFovPercent?: number;
  limit?: number;
  fovArcmin: { w: number; h: number };
  timezone: string;
  /** the forecast at a moment (weather.conditionsAt); without it, geometry and sky class only */
  conditions?: (t: Date) => HourConditions | undefined;
  /** site sky class 1–9; the reference class (5) when unset */
  bortle?: number;
  /** one glass for every target ('none' = bare sensor); decides moon relief and reachability. Wins over `filters`. */
  filter?: string;
  /** the filters the scope switches between itself: each target is judged through the best of them */
  filters?: string[];
  /** the optics being planned for; sub-exposure advice is omitted when it cannot be computed */
  rig?: Omit<Rig, 'band'>;
  /** apply the target-memory penalties (default true; tests and dry runs pass false) */
  applyRest?: boolean;
  /** judge against this memory instead of the app's own log and library (previews, tests) */
  restRecords?: RestRecord[];
  /** the date the rest log is read against (defaults to today in the observer's zone) */
  today?: string;
  /** the site's obstructions (astro/horizon.ts): a target counts as up only above them too; without one, minAltitude alone */
  horizon?: Horizon;
  /** catalog keys (rest.targetKey) with integration towards a goal: always ranked and always on the list, past the funnel and the limit */
  started?: ReadonlySet<string>;
  /** choose the list to cover the night: the best of every part of it (a block's length, an hour at least) in every quadrant of the sky */
  spanNight?: { blockMin: number };
}

export interface PlannedTarget {
  name: string;
  /** what people call it (Messier, Caldwell, then a common name) */
  displayName: string;
  /** the name to give goto_target: also what the scope names the session folder */
  gotoName: string;
  aliases: string[];
  type: string;
  constellation: string;
  sizeArcmin: string;
  magnitude: number | null;
  raHours: number;
  decDeg: number;
  maxAltitude: number;
  bestTime: string | null;
  hoursAboveMin: number;
  visibleFrom: string | null;
  visibleUntil: string | null;
  altitudeNow: number;
  /** compass direction now, 0 = N, 90 = E: two targets with close azimuths sit behind the same obstruction */
  azimuthNow: number;
  /** above the minimum altitude now but behind the site's horizon (its mapped obstructions and tonight's blocked views); null without one */
  obstructedNow: boolean | null;
  /** when an obstructed target comes clear tonight; null when it is not obstructed now or does not clear before the window ends */
  clearsAt: string | null;
  moonSeparationDeg: number;
  framing: string;
  suggestedFilter: string;
  /** hours above the minimum altitude weighted by the forecast (1 clear hour = 1) */
  clearHours: number | null;
  /** forecast quality (0–100) during this target's own best hours (weighted towards its peak) */
  weatherAlignment: number | null;
  /** forecast observability (0–100) at its best time (bestTime = its peak altitude) */
  skyAtBest: number | null;
  /** whether this target is reachable at all under tonight's sky with this glass */
  detectBucket: Bucket;
  detectReason: string;
  /** mean surface brightness in mag/arcsec², null when the catalog and shape cannot support one */
  surfaceBrightness: number | null;
  emission: Emission;
  /** minutes it is actually worth pointing at: above the minimum altitude, moon- and rotation-weighted */
  usableMinutes: number;
  /** of those, how many fall while the Moon is up */
  moonlitMinutes: number;
  /** minutes spent above 75° where an alt-az head's field rotation discounts the time */
  keyholeMinutes: number;
  /** recommended sub length in seconds (null when the rig is unknown) */
  subSeconds: number | null;
  subRangeSeconds: [number, number] | null;
  /** whole subs of that length that fit `usableMinutes` */
  subs: number | null;
  integrationMinutes: number | null;
  exposureAdvice: string | null;
  /** the longest run that is simultaneously up, forecast-clear and moon-workable */
  bestClearFrom: string | null;
  bestClearUntil: string | null;
  bestClearMinutes: number;
  /** points taken off the score by the app's memory of recent suggestions and captures */
  restPenalty: number;
  restReason: string | null;
  /** true when it cannot be shot as it stands: never made the hero, never counted as season evidence */
  gated: boolean;
  /** why it is gated, or null when nothing holds it back */
  gateReason: string | null;
  score: number;
}

export interface NightPlan {
  window: { start: string | null; end: string | null; hours: number };
  moon: { illuminationPercent: number; phase: string };
  minAltitude: number;
  /** the site horizon the visibility was judged against, or null (minimum altitude only) */
  horizon: string | null;
  weather: string;
  candidatesConsidered: number;
  /** the sky and glass every judgement on this plan was made against */
  sky: { bortle: number; sqm: number; filter: string; band: BandClass | 'per-target' };
  /** the target to start with, after the field-rotation guard */
  hero: string | null;
  /** what tonight's sky is actually about, judged on the best-placed targets */
  season: { label: string; evidence: string; counts: Record<string, number> };
  /** well-placed targets the app held back because they are recent or captured */
  resting: Array<{ name: string; displayName: string; penalty: number; reason: string }>;
  targets: PlannedTarget[];
}

const EMISSION_TYPES: readonly string[] = ['HII', 'EmN', 'SNR', 'PN', 'Cl+N'];
/** never offered unless asked for by type: not imaging targets for a 150 mm lens */
const ONLY_ON_REQUEST: readonly string[] = ['*', '**', 'Nova', 'Other', 'DrkN', 'GClstr'];

const BRIGHT_CLASS: Readonly<Record<number, number>> = { 1: 0.55, 2: 0.35, 3: 0.15 };

/** 0–1 from the magnitude, or from the brightness class (Sharpless, Lynds…) when there is none. */
export function brightness(o: DsoObject): number {
  if (o.mag !== undefined) return Math.max(0, Math.min(1, (13 - o.mag) / 9));
  if (o.brightClass !== undefined) return BRIGHT_CLASS[o.brightClass] ?? 0.3;
  return 0.5;
}

export function suggestFilter(o: DsoObject, moonIllum: number): string {
  if (EMISSION_TYPES.includes(o.type)) return 'Duo-Band (emission nebula — strong Hα/OIII signal, cuts moon and light pollution)';
  if (o.type === 'Neb' && moonIllum > 50) return 'Duo-Band (bright moon), otherwise Astro';
  return 'Astro (broadband — galaxies, clusters, reflection nebulae need full spectrum)';
}

export function framing(o: DsoObject, fov: { w: number; h: number }): { text: string; fit: number; mosaic: boolean } {
  const maj = o.majorArcmin ?? 0;
  if (!maj) return { text: 'size unknown', fit: 0.4, mosaic: false };
  const frac = maj / fov.w;
  if (frac > 1.15) return { text: `larger than the tele FOV (${maj}' vs ${fov.w.toFixed(0)}') — consider a mosaic or the wide camera`, fit: 0.5, mosaic: true };
  if (frac >= 0.25) return { text: `fills ${Math.round(frac * 100)}% of the frame width — excellent fit`, fit: 1, mosaic: false };
  if (frac >= 0.08) return { text: `${Math.round(frac * 100)}% of frame width — good, crop afterwards`, fit: 0.7, mosaic: false };
  return { text: `small (${maj}') — only ${Math.round(frac * 100)}% of the frame; will look tiny at 150mm`, fit: 0.25, mosaic: false };
}

/** Defaults of the plan's filters. */
const DEFAULT_MAX_MAG = 11;
const DEFAULT_MIN_SIZE = 4;
const DEFAULT_MAX_SIZE = 600;
const DEFAULT_LIMIT = 15;
/** No darkness known (polar summer): this many hours from the start. */
const DEFAULT_NIGHT_H = 8;
/** A plan covers one night: a longer window is refused (it would also sample the catalog for days). */
const MAX_WINDOW_H = 24;
const MAX_LIMIT = 200;
/** Altitude, Moon and forecast are sampled every this many hours across the window. */
const STEP_H = 0.25;
/** A target up for less than this is not worth a session. */
const MIN_HOURS_UP = 0.75;
/** The Moon is "up" once its upper limb clears the horizon, as the source engine counts it. */
const MOON_HORIZON = -0.8333;
/** An hour at or above this observability belongs to a target's clear window. */
const CLEAR_SCORE = 60;
/** A moonlit minute counts toward the clear window while at least this much of it still works. */
const MOON_WORKABLE_KEEP = 0.5;

/** Score weights: the five questions, adding to 1.0 before the forecast and the memory. */
const W = { framing: 0.2, reach: 0.1, integration: 0.3, detect: 0.15, appeal: 0.25 } as const;
/** Real-session duty cycle: dithering, saving, plate-solving and re-centring eat a quarter. */
const DUTY = 0.75;
/** Minutes of usable integration that earn full marks on the integration term. */
const FULL_NIGHT_MIN = 240;
/** Below this many dark minutes the window is too short to score integration against. */
const SESSION_MIN_GOOD = 30;
/** A short window shifts weight from integration toward "can I get signal at all", up to this. */
const QUICK_SHIFT_MAX = 0.1;
const QUICK_SHIFT_SPAN = 120;
/** With a forecast, the geometric score is scaled by FLOOR + (1 − FLOOR) × alignment. */
const WEATHER_FLOOR = 0.35;
/** A target whose centre is within this fraction of a better one's size is the same field. */
const SAME_FIELD = 0.4;
const FAMOUS = /^[MC] \d+$/;

/** Alt-az field rotation starts costing time above this altitude and is worst by this one. */
const KEYHOLE_START = 75;
const KEYHOLE_FULL = 85;
const KEYHOLE_FLOOR = 0.15;

/** How many rows the cheap funnel keeps before the ephemeris is paid for. */
const FUNNEL_KEEP = 400;
/** Rows further than this from the pole-side reach of the site can never be used. */
const DEC_PREFILTER_MARGIN = 65;
/** A hero that spends this long in the zenith keyhole with too little clean time yields (source engine's guard). */
const HERO_KEYHOLE_CAP_MIN = 60;
const HERO_CLEAN_MIN = 180;
const HERO_KEYHOLE_TOL = 8;

const GALAXY_TYPES: readonly string[] = ['G', 'GPair', 'GTrpl', 'GGroup'];
const CORE_CONSTS: readonly string[] = ['Aql', 'Ara', 'CrA', 'Lup', 'Nor', 'Oph', 'Sco', 'Sct', 'Ser', 'Sgr'];
const MAGELLANIC_CONSTS: readonly string[] = ['Tuc', 'Dor', 'Hyi', 'Men'];
const SEASON_TOP_N = 25;

/** A forecast observability (0–100) as a weight 0–1; no (or an unusable) forecast counts as clear. */
export function clearness(c: HourConditions | undefined): number {
  const obs = c?.observability;
  return obs === undefined || !Number.isFinite(obs) ? 1 : Math.max(0, Math.min(1, obs / 100));
}

/** The alt-az zenith penalty: near the pole of the sky the field rotates too fast to integrate. */
export function keyholeWeight(alt: number, mount: Rig['mount']): number {
  if (mount === 'eq') return 1;
  if (alt < KEYHOLE_START) return 1;
  return Math.max(KEYHOLE_FLOOR, 1 - ((1 - KEYHOLE_FLOOR) * (alt - KEYHOLE_START)) / (KEYHOLE_FULL - KEYHOLE_START));
}

interface Sampled {
  maxAlt: number;
  maxAltAt: Date;
  hoursAboveMin: number;
  firstAbove: Date | null;
  lastAbove: Date | null;
  /** weighted forecast over the hours up (see alignment), and forecast-weighted hours up */
  alignment: number;
  clearHours: number;
  /** minutes worth integrating: above the minimum altitude, duty-cycled, keyhole- and Moon-weighted */
  usableMin: number;
  cleanMin: number;
  moonlitMin: number;
  keyholeMin: number;
  /** longest run that is up, clear enough, and not gutted by the Moon for this target */
  bestFrom: Date | null;
  bestUntil: Date | null;
  bestMin: number;
  /** the seeing and transparency through which its best hours will actually be shot */
  conditions?: HourConditions;
}

/**
 * One pass over the window: visibility, the weather alignment, and what the Moon and the mount
 * leave of the time. Each sample above the minimum altitude (and above the site's mapped
 * obstructions in its direction) is weighted by how well placed the target is then (its altitude
 * above the minimum relative to its own peak, squared, so the hours around the peak dominate), and the forecast is averaged with those weights: 1 = clear at its
 * peak, 0 = clouded out when it matters. Without a forecast the alignment is 1.
 *
 * The Moon is not a penalty here: moonlit minutes are kept at `moonKeep` of their value, which
 * is why a narrowband target is still offered on a gibbous-Moon night and a faint galaxy is not.
 */
function sample(site: Site, o: DsoObject, start: Date, end: Date, minAlt: number, moonKeep: number, conditions?: (t: Date) => HourConditions | undefined, mount: Rig['mount'] = 'alt-az', horizon?: Horizon): Sampled {
  // each sample stands for the step that follows it, up to the end of the window (the last stands for none);
  // `lim` is the altitude it must clear there: the minimum, or the site's obstruction in its direction when higher
  const pts: Array<{ t: Date; alt: number; lim: number; h: number; moonUp: boolean; c: HourConditions | undefined }> = [];
  for (let t = start.getTime(); t <= end.getTime(); t += STEP_H * 3600e3) {
    const d = new Date(t);
    const aa = altAz(site, o.raHours, o.decDeg, d);
    pts.push({
      t: d,
      alt: aa.altitude,
      lim: horizon ? Math.max(minAlt, horizon.limit(aa.azimuth)) : minAlt,
      h: Math.min(STEP_H, (end.getTime() - t) / 3600e3),
      moonUp: bodyAlt(site, 'Moon', d) >= MOON_HORIZON,
      c: conditions?.(d),
    });
  }
  let maxAlt = -90;
  let maxAltAt = start;
  let up = 0;
  let firstAbove: Date | null = null;
  let lastAbove: Date | null = null;
  for (const p of pts) {
    if (p.alt > maxAlt) {
      maxAlt = p.alt;
      maxAltAt = p.t;
    }
    if (p.alt >= p.lim) {
      up += p.h;
      firstAbove ??= p.t;
      lastAbove = p.t;
    }
  }
  const span = Math.max(1, maxAlt - minAlt);
  let wg = 0;
  let g = 0;
  let clear = 0;
  let usableMin = 0;
  let cleanMin = 0;
  let moonlitMin = 0;
  let keyholeMin = 0;
  let bestFrom: Date | null = null;
  let bestUntil: Date | null = null;
  let bestMin = 0;
  let runFrom: Date | null = null;
  let runMin = 0;
  const closeRun = () => {
    if (runFrom && runMin > bestMin) {
      bestFrom = runFrom;
      bestUntil = runFrom ? new Date(runFrom.getTime() + runMin * 60e3) : null;
      bestMin = runMin;
    }
    runFrom = null;
    runMin = 0;
  };
  for (const p of pts) {
    if (p.alt < p.lim) {
      closeRun();
      continue;
    }
    const w = clearness(p.c);
    const q = ((p.alt - minAlt) / span) ** 2;
    wg += w * q;
    g += q;
    clear += p.h * w;
    const kh = keyholeWeight(p.alt, mount);
    const minutes = p.h * 60 * DUTY;
    keyholeMin += p.alt >= KEYHOLE_START ? minutes : 0;
    if (p.moonUp) {
      moonlitMin += minutes;
      usableMin += minutes * kh * moonKeep;
    } else {
      cleanMin += minutes;
      usableMin += minutes * kh;
    }
    if (w * 100 >= CLEAR_SCORE && (!p.moonUp || moonKeep >= MOON_WORKABLE_KEEP)) {
      runFrom ??= p.t;
      runMin += p.h * 60;
    } else {
      closeRun();
    }
  }
  closeRun();
  return {
    maxAlt: Math.round(maxAlt * 10) / 10,
    maxAltAt,
    hoursAboveMin: Math.round(up * 10) / 10,
    firstAbove,
    lastAbove,
    alignment: conditions && g > 0 ? wg / g : 1,
    clearHours: clear,
    usableMin: Math.round(usableMin),
    cleanMin: Math.round(cleanMin),
    moonlitMin: Math.round(moonlitMin),
    keyholeMin: Math.round(keyholeMin),
    bestFrom,
    bestUntil,
    bestMin: Math.round(bestMin),
    conditions: conditions?.(maxAltAt),
  };
}

/** The dark minutes of the window: what integration is scored against, so a short session is not
 * punished for what the night itself does not offer. */
function darkMinutes(site: Site, start: Date, end: Date): number {
  let min = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += STEP_H * 3600e3) {
    if (bodyAlt(site, 'Sun', new Date(t)) < -18) min += Math.min(STEP_H * 60, (end.getTime() - t) / 60e3);
  }
  return min;
}

/** The glass a plan may use: one fixed filter, or the set the scope switches between itself. */
export interface Glass {
  filters: string[];
  bortle?: number;
  moonStrength: number;
}

/**
 * The filter a target is best shot through, and its detectability through it. A line filter
 * passes only emission light, so continuum targets (galaxies, clusters, reflection nebulae) are
 * judged through the broadband glass alone; emission targets take whichever filter brings them
 * up best, the Moon deciding between equals.
 */
export function chooseGlass(o: DsoObject, glass: Glass): { filter: string; d: Detectability } {
  const { filters, bortle, moonStrength } = glass;
  if (filters.length === 1) return { filter: filters[0], d: detectFor(o, { bortle, filter: filters[0] }) };
  const continuum = emissionOf(o) === 'broadband';
  const broad = filters.filter((f) => classifyFilter(f) === 'broadband');
  const eligible = continuum && broad.length ? broad : filters;
  let best: { filter: string; d: Detectability; value: number } | undefined;
  for (const filter of eligible) {
    const d = detectFor(o, { bortle, filter });
    const value = d.score * (1 + moonlitKeep(d, moonStrength));
    if (!best || value > best.value) best = { filter, d, value };
  }
  return best!;
}

/**
 * The proxy a row is ranked on before any ephemeris is computed: transit altitude stands in for
 * integration time, framing, detectability and appeal are computed from the row alone. It only
 * has to be good enough to keep the rows the real score would rank near the top inside
 * `FUNNEL_KEEP`; the hard gates already ran in the catalog filter.
 */
function cheapScore(o: DsoObject, site: Site, fov: { w: number; h: number }, glass: Glass): number {
  const fr = framing(o, fov);
  const transit = 90 - Math.abs(site.lat - o.decDeg);
  const { d } = chooseGlass(o, glass);
  const detect = d.bucket === 'UNKNOWN' ? brightness(o) * 100 : d.score;
  const integration = Math.max(0, Math.min(1, (transit - 40) / 35)) * 100;
  return W.framing * fr.fit * 100 + W.integration * integration + W.detect * detect + W.appeal * appealScore(o.type);
}

/**
 * What tonight's sky is about, judged on the best-placed rows rather than on the calendar: the
 * Milky Way core, the Magellanic Clouds, a galaxy field, or a mix. The source engine tells its
 * user this before the list; it is the one sentence that explains why tonight's list looks like
 * it does, and it is read off the objects themselves so it cannot drift from the plan.
 */
function seasonCall(rows: Array<{ code: string; constellation: string; quality: number }>): NightPlan['season'] {
  const top = [...rows].sort((a, b) => b.quality - a.quality).slice(0, SEASON_TOP_N);
  const n = top.length;
  if (!n) return { label: '—', evidence: 'no well-placed targets to judge', counts: {} };
  const galaxies = top.filter((r) => GALAXY_TYPES.includes(r.code)).length;
  const core = top.filter((r) => CORE_CONSTS.includes(r.constellation) && !GALAXY_TYPES.includes(r.code)).length;
  const magellanic = top.filter((r) => MAGELLANIC_CONSTS.includes(r.constellation) && !GALAXY_TYPES.includes(r.code)).length;
  const counts = { core, magellanic, galaxies, sampled: n };
  if (core / n >= 0.4) return { label: 'Milky Way core', evidence: `${core} of tonight's best ${n} ride the core — nebulae and clusters in Sagittarius/Scorpius country`, counts };
  if (magellanic / n >= 0.25) return { label: 'Magellanic', evidence: `${magellanic} of tonight's best ${n} live in the Clouds`, counts };
  if (galaxies / n >= 0.5) return { label: 'Galaxy season', evidence: `${galaxies} of tonight's best ${n} are galaxies — the deep-sky fields own the night`, counts };
  return { label: 'Mixed sky', evidence: `no single sky dominates tonight's best ${n}: ${galaxies} galaxies, ${core} core objects, ${magellanic} Magellanic`, counts };
}

/**
 * The target to start with. An alt-az mount loses its zenith: a hero that only gets its time
 * above 75° is a target you will watch trail, so when it is nearly all keyhole time and it is
 * not clearly ahead, the best non-keyhole-bound row within a few points takes the slot.
 */
function pickHero(shootable: PlannedTarget[]): PlannedTarget | null {
  const hero = shootable[0];
  if (!hero) return null;
  if (!(hero.keyholeMinutes >= HERO_KEYHOLE_CAP_MIN && hero.usableMinutes - hero.keyholeMinutes < HERO_CLEAN_MIN)) return hero;
  return shootable.find((r) => r.keyholeMinutes < HERO_KEYHOLE_CAP_MIN && hero.score - r.score <= HERO_KEYHOLE_TOL) ?? hero;
}

export function planNight(site: Site, opts: PlanOptions & { now?: Date }): NightPlan {
  const now = opts.now ?? new Date();
  const win = nightWindow(site, now);
  const start = opts.start ?? (win.darkStart && win.darkStart > now ? win.darkStart : now);
  const end = opts.end ?? (win.darkEnd && win.darkEnd > start ? win.darkEnd : new Date(start.getTime() + DEFAULT_NIGHT_H * 3600e3));
  if (!(end.getTime() > start.getTime())) throw new Error(`the planning window must end after it starts (${start.toISOString()} → ${end.toISOString()})`);
  if (end.getTime() - start.getTime() > MAX_WINDOW_H * 3600e3) throw new Error(`the planning window is one night, at most ${MAX_WINDOW_H} h (${start.toISOString()} → ${end.toISOString()})`);
  if (!(opts.minAltitude >= 0 && opts.minAltitude < 90)) throw new Error(`minAltitude must be from 0 to below 90° (got ${opts.minAltitude})`);
  if (!(opts.fovArcmin.w > 0 && opts.fovArcmin.h > 0)) throw new Error(`the field of view must be positive (got ${opts.fovArcmin.w}×${opts.fovArcmin.h}')`);
  if (opts.minFovPercent !== undefined && !(opts.minFovPercent >= 0 && opts.minFovPercent <= 100)) throw new Error(`minFovPercent must be from 0 to 100 (got ${opts.minFovPercent})`);
  if (opts.limit !== undefined && !(opts.limit >= 1)) throw new Error(`limit must be at least 1 (got ${opts.limit})`);

  const moon = moonState(site, new Date((start.getTime() + end.getTime()) / 2));
  const moonStrength = moon.illuminationPercent / 100;
  const bortle = opts.bortle;
  const glass: Glass = { filters: opts.filter ? [opts.filter] : opts.filters?.length ? opts.filters : ['none'], bortle, moonStrength };
  const perTarget = glass.filters.length > 1;
  const filter = perTarget ? `${glass.filters.join(' / ')} (best per target)` : glass.filters[0];
  const band = perTarget ? ('per-target' as const) : classifyFilter(filter);
  const mount = opts.rig?.mount ?? 'alt-az';
  const hasWx = !!opts.conditions;

  const types = new Set<string>();
  for (const t of opts.types ?? []) for (const code of typeGroup(t) ?? [t]) types.add(code);
  const maxMag = opts.maxMagnitude ?? DEFAULT_MAX_MAG;
  const minSize = Math.max(opts.minSizeArcmin ?? DEFAULT_MIN_SIZE, ((opts.minFovPercent ?? 0) / 100) * opts.fovArcmin.w);
  const maxSize = opts.maxSizeArcmin ?? DEFAULT_MAX_SIZE;
  const limit = Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT));

  // Cheap funnel: only rows that can ever reach the sky, then only the ones a no-ephemeris
  // proxy puts near the top. The ephemeris is the expensive part; it is paid for ~400 rows.
  const isStarted = (id: string) => opts.started?.has(id.trim().toLowerCase()) ?? false;
  const reachable = catalog().filter((o) => {
    if (Math.abs(site.lat - o.decDeg) > DEC_PREFILTER_MARGIN) return false;
    if (types.size && !types.has(o.type)) return false;
    if (ONLY_ON_REQUEST.includes(o.type) && !types.has(o.type)) return false;
    const famous = o.aliases.some((a) => FAMOUS.test(a));
    // Bright enough: a magnitude within the limit, or (nebulae have none) a bright or moderate class.
    // A target already being collected passes the default brightness floor; a magnitude the owner set still applies.
    const startedPass = opts.maxMagnitude === undefined && isStarted(o.id);
    if (!famous && !startedPass && !(o.mag !== undefined ? o.mag <= maxMag : o.brightClass !== undefined && o.brightClass <= 2)) return false;
    if ((o.majorArcmin ?? 0) < minSize || (o.majorArcmin ?? 0) > maxSize) return false;
    return 90 - Math.abs(site.lat - o.decDeg) >= opts.minAltitude;
  });
  const funnel: Array<{ proxy: number; o: DsoObject }> = [];
  for (const o of reachable) funnel.push({ proxy: cheapScore(o, site, opts.fovArcmin, glass), o });
  funnel.sort((a, b) => b.proxy - a.proxy);
  const candidates = [...funnel.slice(0, FUNNEL_KEEP), ...funnel.slice(FUNNEL_KEEP).filter((f) => isStarted(f.o.id))].map((f) => f.o);

  // What the window's own darkness allows: integration is scored against this, so a two-hour
  // session before dawn is judged on what was on offer, not against a full night.
  const darkMin = darkMinutes(site, start, end);
  const fullMarksMin = Math.max(SESSION_MIN_GOOD, Math.min(FULL_NIGHT_MIN, darkMin * DUTY));
  // A short window buys no integration, so shift that weight toward "can I see it at all".
  const quickShift = QUICK_SHIFT_MAX * Math.max(0, Math.min(1, (FULL_NIGHT_MIN - darkMin) / QUICK_SHIFT_SPAN));
  const weights = { ...W, integration: Math.max(0, W.integration - quickShift), detect: W.detect + quickShift };

  const today = opts.today ?? localDate(now, opts.timezone);
  const restRecords: RestRecord[] = opts.applyRest === false ? [] : (opts.restRecords ?? [...captureRecords(today), ...loadRest()]);

  const scored: Array<{ t: PlannedTarget; size: number; quality: number; code: string; constellation: string }> = [];
  for (const o of candidates) {
    const { filter: glassUsed, d } = chooseGlass(o, glass);
    const keep = moonlitKeep(d.bucket === 'UNKNOWN' ? { ...d, bucket: brightness(o) >= 0.55 ? 'EASY' : 'NEEDS_INTEG' } : d, moonStrength);
    const vis = sample(site, o, start, end, opts.minAltitude, keep, opts.conditions, mount, opts.horizon);
    if (vis.hoursAboveMin < MIN_HOURS_UP) continue;

    const fr = framing(o, opts.fovArcmin);
    const moonSep = separationDeg(o.raHours, o.decDeg, moon.raHours, moon.decDeg);
    const detect = d.bucket === 'UNKNOWN' ? Math.round(brightness(o) * 100) : d.score;
    const appeal = Math.min(100, appealScore(o.type) + (o.aliases.some((a) => FAMOUS.test(a)) ? 8 : o.names.length ? 4 : 0));
    const integration = 100 * Math.min(vis.usableMin / fullMarksMin, 1);
    const reach = 100 * Math.min(vis.hoursAboveMin / Math.max(2, (end.getTime() - start.getTime()) / 3600e3), 1);
    const geometric =
      weights.framing * fr.fit * 100 +
      weights.reach * reach +
      weights.integration * integration +
      weights.detect * detect +
      weights.appeal * appeal;
    // The best targets are those whose own optimal time coincides with good weather.
    let score = geometric * (WEATHER_FLOOR + (1 - WEATHER_FLOOR) * vis.alignment);
    const pen = restRecords.length ? restPenalty(o.id, today, restRecords) : 0;
    const state = restRecords.length ? restState(o.id, today, restRecords) : null;
    score -= conditionsPenalty(o, d.bucket, vis.conditions?.seeingIdx, vis.conditions?.transparencyIdx);
    score -= pen;
    // A row can be on the list and still not be shootable: framing it cannot solve, or a sky and
    // glass that cannot bring it up. Those are ranked, explained, and never made the hero.
    const gate = fr.mosaic
      ? 'larger than this camera can frame without a mosaic'
      : fr.fit <= 0.25
        ? 'too small to be worth this frame'
        : d.bucket === 'SKIP_TONIGHT'
          ? `not reachable through tonight's sky and glass: ${d.reason}`
          : null;
    const gated = gate !== null;
    const exposure = opts.rig
      ? subPlan({ rig: { ...opts.rig, band: d.band }, bortle, transitAlt: vis.maxAlt, usableMin: vis.usableMin, moonUp: vis.moonlitMin > 0, windKmh: vis.conditions?.windKmh })
      : null;
    const atPeak = opts.conditions?.(vis.maxAltAt);

    scored.push({
      quality: score,
      size: o.majorArcmin ?? 0,
      code: o.type,
      constellation: o.constellation,
      t: {
        name: o.id,
        displayName: displayName(o),
        gotoName: gotoLabel(o),
        aliases: o.aliases.slice(0, 4),
        type: o.typeName,
        constellation: o.constellation,
        sizeArcmin: o.majorArcmin ? `${o.majorArcmin}×${o.minorArcmin ?? o.majorArcmin}` : '?',
        magnitude: o.mag ?? null,
        raHours: Math.round(o.raHours * 1e4) / 1e4,
        decDeg: Math.round(o.decDeg * 1e3) / 1e3,
        maxAltitude: vis.maxAlt,
        bestTime: fmtTime(vis.maxAltAt, opts.timezone),
        hoursAboveMin: vis.hoursAboveMin,
        visibleFrom: fmtTime(vis.firstAbove, opts.timezone),
        visibleUntil: fmtTime(vis.lastAbove, opts.timezone),
        ...(({ altitude, azimuth }) => {
          const obstructed = opts.horizon ? altitude >= opts.minAltitude && altitude < opts.horizon.limit(azimuth) : null;
          return {
            altitudeNow: Math.round(altitude),
            azimuthNow: Math.round(azimuth),
            obstructedNow: obstructed,
            clearsAt: obstructed ? fmtTime(clearsAt(site, o.raHours, o.decDeg, opts.minAltitude, opts.horizon, now, end), opts.timezone) : null,
          };
        })(altAz(site, o.raHours, o.decDeg, now)),
        moonSeparationDeg: Math.round(moonSep),
        framing: fr.text,
        suggestedFilter: perTarget ? `${glassUsed} (${d.reason})` : suggestFilter(o, moon.illuminationPercent),
        clearHours: hasWx ? Math.round(vis.clearHours * 10) / 10 : null,
        weatherAlignment: hasWx ? Math.round(vis.alignment * 100) : null,
        skyAtBest: atPeak?.observability === undefined || !Number.isFinite(atPeak.observability) ? null : Math.round(atPeak.observability),
        detectBucket: d.bucket,
        detectReason: d.reason,
        surfaceBrightness: d.sb === null ? null : Math.round(d.sb * 100) / 100,
        emission: d.emission,
        usableMinutes: vis.usableMin,
        moonlitMinutes: vis.moonlitMin,
        keyholeMinutes: vis.keyholeMin,
        subSeconds: exposure?.subS ?? null,
        subRangeSeconds: exposure?.subRangeS ?? null,
        subs: exposure?.subs ?? null,
        integrationMinutes: exposure?.integrationMin ?? null,
        exposureAdvice: exposure?.line ?? null,
        bestClearFrom: vis.bestFrom ? fmtTime(vis.bestFrom, opts.timezone) : null,
        bestClearUntil: vis.bestUntil ? fmtTime(vis.bestUntil, opts.timezone) : null,
        bestClearMinutes: vis.bestMin,
        gated,
        gateReason: gate,
        restPenalty: pen,
        restReason: state ? `${state.kind}${state.until ? ` until ${state.until}` : ''}${state.daysAgo ? `, ${state.daysAgo} d ago` : ''}` : null,
        score: Math.round(Math.max(0, score)),
      },
    });
  }

  // Up at the window's start first (now, once it is dark): a target already above the minimum
  // altitude outranks one still rising toward it, so the first rows can be shot the moment the
  // plan is read. Quality orders each group.
  const clears = (raHours: number, decDeg: number, when: Date) => {
    const { altitude, azimuth } = altAz(site, raHours, decDeg, when);
    return altitude >= Math.max(opts.minAltitude, opts.horizon?.limit(azimuth) ?? 0);
  };
  const upAtStart = new Map(scored.map((s) => [s, clears(s.t.raHours, s.t.decDeg, start) ? 1 : 0]));
  scored.sort((a, b) => upAtStart.get(b)! - upAtStart.get(a)! || b.quality - a.quality);
  // One field, one entry: drop a target whose centre lies inside a better-ranked one that is at
  // least as big (the Maia Nebula inside M 45, a Sharpless region inside an NGC complex).
  const picked: typeof scored = [];
  const take = (c: (typeof scored)[number]) => {
    if (picked.includes(c)) return false;
    if (picked.some((p) => p.size >= c.size && separationDeg(p.t.raHours, p.t.decDeg, c.t.raHours, c.t.decDeg) * 60 < p.size * SAME_FIELD)) return false;
    picked.push(c);
    return true;
  };
  if (opts.spanNight) {
    // Targets already being collected stay on the list whatever their rank; they do not use up the limit.
    for (const c of scored) if (isStarted(c.t.name)) take(c);
    const room = limit + picked.length;
    const byQuality = scored.filter((s) => !s.t.gated).sort((a, b) => b.quality - a.quality);
    const bandMs = Math.max(60, opts.spanNight.blockMin) * 60e3;
    // One list per part of the night and quadrant of the sky, best first: a plan needs something usable
    // in every hour, and an alternate in another direction when cloud or an obstruction takes one out.
    const cells: Array<typeof scored> = [];
    for (let t = start.getTime(); t < end.getTime(); t += bandMs) {
      const bandEnd = Math.min(t + bandMs, end.getTime());
      const band: Array<typeof scored> = [[], [], [], []];
      for (const s of byQuality) {
        if (![t, (t + bandEnd) / 2, bandEnd].every((at) => clears(s.t.raHours, s.t.decDeg, new Date(at)))) continue;
        const az = altAz(site, s.t.raHours, s.t.decDeg, new Date((t + bandEnd) / 2)).azimuth;
        band[Math.floor((((az + 45) % 360) + 360) % 360 / 90)].push(s);
      }
      cells.push(...band);
    }
    // Round-robin over the cells until the list is full, so no hour or direction is crowded out.
    const next = cells.map(() => 0);
    let progressed = true;
    while (progressed && picked.length < room) {
      progressed = false;
      for (let i = 0; i < cells.length && picked.length < room; i++) {
        while (next[i] < cells[i].length) {
          progressed = true;
          if (take(cells[i][next[i]++])) break;
        }
      }
    }
    picked.sort((a, b) => b.quality - a.quality);
  } else {
    for (const c of scored) {
      take(c);
      if (picked.length >= limit) break;
    }
  }

  const shootable = picked.filter((p) => !p.t.gated).map((p) => p.t);
  const hero = pickHero(shootable);
  // What the memory held back: well-placed rows that a capture or a recent suggestion pushed out
  // of the list. Named here so the agent can say "M 31 is resting until the 12th" instead of
  // silently not offering it.
  const resting: NightPlan['resting'] = [];
  if (restRecords.length) {
    const shown = new Set(picked);
    for (const p of scored) {
      if (shown.has(p) || p.t.restPenalty < 10) continue;
      resting.push({ name: p.t.gotoName, displayName: p.t.displayName, penalty: p.t.restPenalty, reason: p.t.restReason ?? '' });
      if (resting.length >= 5) break;
    }
  }

  return {
    window: { start: fmtTime(start, opts.timezone), end: fmtTime(end, opts.timezone), hours: Math.round(((end.getTime() - start.getTime()) / 3600e3) * 10) / 10 },
    moon: { illuminationPercent: moon.illuminationPercent, phase: moon.phase },
    minAltitude: opts.minAltitude,
    horizon: opts.horizon?.summary ?? null,
    weather: hasWx ? "ranked by how well tonight's forecast lines up with each target's best hours" : 'no forecast available: ranked on visibility and sky class alone',
    candidatesConsidered: candidates.length,
    hero: hero?.displayName ?? null,
    season: seasonCall(picked.filter((p) => !p.t.gated)),
    sky: { bortle: bortle ?? 5, sqm: sqmFor(bortle), filter, band },
    resting,
    targets: picked.map((p) => p.t),
  };
}

export type { Detectability };
