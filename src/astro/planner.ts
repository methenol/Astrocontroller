import { catalog, displayName, gotoLabel, typeGroup, type DsoObject } from './catalog.js';
import { nightWindow, moonState, separationDeg, fmtTime, type Site, altAz } from './sky.js';

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
  /** forecast observability 0–100 at a moment (weather.observabilityAt); without it, geometry only */
  observability?: (t: Date) => number | undefined;
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
  moonSeparationDeg: number;
  framing: string;
  suggestedFilter: string;
  /** hours above the minimum altitude weighted by the forecast (1 clear hour = 1) */
  clearHours: number | null;
  /** forecast quality (0–100) during this target's own best hours (weighted towards its peak) */
  weatherAlignment: number | null;
  /** forecast observability (0–100) at its best time (bestTime = its peak altitude) */
  skyAtBest: number | null;
  score: number;
}

const EMISSION = new Set(['HII', 'EmN', 'SNR', 'PN', 'Cl+N']);
/** never offered unless asked for by type: not imaging targets for a 150 mm lens */
const ONLY_ON_REQUEST = ['*', '**', 'Nova', 'Other', 'DrkN', 'GClstr'];

const BRIGHT_CLASS: Readonly<Record<number, number>> = { 1: 0.55, 2: 0.35, 3: 0.15 };

/** 0–1 from the magnitude, or from the brightness class (Sharpless, Lynds…) when there is none. */
function brightness(o: DsoObject): number {
  if (o.mag !== undefined) return Math.max(0, Math.min(1, (13 - o.mag) / 9));
  if (o.brightClass !== undefined) return BRIGHT_CLASS[o.brightClass] ?? 0.3;
  return 0.5;
}

export function suggestFilter(o: DsoObject, moonIllum: number): string {
  if (EMISSION.has(o.type)) return 'Duo-Band (emission nebula — strong Hα/OIII signal, cuts moon and light pollution)';
  if (o.type === 'Neb' && moonIllum > 50) return 'Duo-Band (bright moon), otherwise Astro';
  return 'Astro (broadband — galaxies, clusters, reflection nebulae need full spectrum)';
}

function framing(o: DsoObject, fov: { w: number; h: number }): { text: string; fit: number } {
  const maj = o.majorArcmin ?? 0;
  if (!maj) return { text: 'size unknown', fit: 0.4 };
  const frac = maj / fov.w;
  if (frac > 1.15) return { text: `larger than the tele FOV (${maj}' vs ${fov.w.toFixed(0)}') — consider a mosaic or the wide camera`, fit: 0.5 };
  if (frac >= 0.25) return { text: `fills ${Math.round(frac * 100)}% of the frame width — excellent fit`, fit: 1 };
  if (frac >= 0.08) return { text: `${Math.round(frac * 100)}% of frame width — good, crop afterwards`, fit: 0.7 };
  return { text: `small (${maj}') — only ${Math.round(frac * 100)}% of the frame; will look tiny at 150mm`, fit: 0.25 };
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
/** Altitude is sampled every this many hours across the window. */
const STEP_H = 0.25;
/** A target up for less than this is not worth a session. */
const MIN_HOURS_UP = 0.75;
/** Hours above the minimum count up to this many toward the score. */
const HOURS_CAP = 6;
/** The Moon matters to broadband targets brighter than this, within this many degrees. */
const MOON_BRIGHT_PCT = 30;
const MOON_NEAR_DEG = 40;
/** Score weights (they add up to 100 before the bonus and the Moon). */
const W = { hours: 35, altitude: 15, framing: 25, brightness: 20, moon: 25 } as const;
/** With a forecast, the geometric score is scaled by FLOOR + (1 − FLOOR) × alignment. */
const WEATHER_FLOOR = 0.35;
/** A target whose centre is within this fraction of a better one's size is the same field. */
const SAME_FIELD = 0.4;
const FAMOUS = /^[MC] \d+$/;

/** A forecast observability (0–100) as a weight 0–1; no (or an unusable) forecast counts as clear. */
function clearness(obs: number | undefined): number {
  return obs === undefined || !Number.isFinite(obs) ? 1 : Math.max(0, Math.min(1, obs / 100));
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
}

/**
 * One pass over the window: visibility, and the weather alignment — how good the forecast is
 * during THIS target's best hours. Each sample above the minimum altitude is weighted by how well
 * placed the target is then (its altitude above the minimum relative to its own peak, squared, so
 * the hours around the peak dominate), and the forecast is averaged with those weights: 1 = clear
 * at its peak, 0 = clouded out when it matters. Without a forecast the alignment is 1.
 */
function sample(site: Site, o: DsoObject, start: Date, end: Date, minAlt: number, observability?: (t: Date) => number | undefined): Sampled {
  // each sample stands for the step that follows it, up to the end of the window (the last stands for none)
  const pts: Array<{ t: Date; alt: number; h: number }> = [];
  for (let t = start.getTime(); t <= end.getTime(); t += STEP_H * 3600e3) {
    const d = new Date(t);
    pts.push({ t: d, alt: altAz(site, o.raHours, o.decDeg, d).altitude, h: Math.min(STEP_H, (end.getTime() - t) / 3600e3) });
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
    if (p.alt >= minAlt) {
      up += p.h;
      firstAbove ??= p.t;
      lastAbove = p.t;
    }
  }
  const span = Math.max(1, maxAlt - minAlt);
  let wg = 0;
  let g = 0;
  let clear = 0;
  for (const p of pts) {
    if (p.alt < minAlt) continue;
    const w = clearness(observability?.(p.t));
    const q = ((p.alt - minAlt) / span) ** 2;
    wg += w * q;
    g += q;
    clear += p.h * w;
  }
  return {
    maxAlt: Math.round(maxAlt * 10) / 10,
    maxAltAt,
    hoursAboveMin: Math.round(up * 10) / 10,
    firstAbove,
    lastAbove,
    alignment: observability && g > 0 ? wg / g : 1,
    clearHours: clear,
  };
}

export interface NightPlan {
  window: { start: string | null; end: string | null; hours: number };
  moon: { illuminationPercent: number; phase: string };
  minAltitude: number;
  weather: string;
  candidatesConsidered: number;
  targets: PlannedTarget[];
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
  const types = new Set<string>();
  for (const t of opts.types ?? []) for (const code of typeGroup(t) ?? [t]) types.add(code);
  const maxMag = opts.maxMagnitude ?? DEFAULT_MAX_MAG;
  const minSize = Math.max(opts.minSizeArcmin ?? DEFAULT_MIN_SIZE, ((opts.minFovPercent ?? 0) / 100) * opts.fovArcmin.w);
  const maxSize = opts.maxSizeArcmin ?? DEFAULT_MAX_SIZE;
  const limit = Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT));

  const candidates = catalog().filter((o) => {
    if (types.size && !types.has(o.type)) return false;
    if (ONLY_ON_REQUEST.includes(o.type) && !types.has(o.type)) return false;
    const famous = o.aliases.some((a) => FAMOUS.test(a));
    // Bright enough: a magnitude within the limit, or (nebulae have none) a bright or moderate class.
    if (!famous && !(o.mag !== undefined ? o.mag <= maxMag : o.brightClass !== undefined && o.brightClass <= 2)) return false;
    if ((o.majorArcmin ?? 0) < minSize || (o.majorArcmin ?? 0) > maxSize) return false;
    // Quick reject: never rises above min altitude at this latitude.
    return 90 - Math.abs(site.lat - o.decDeg) >= opts.minAltitude;
  });

  const hasWx = !!opts.observability;
  const scored: Array<{ t: PlannedTarget; size: number }> = [];
  for (const o of candidates) {
    const vis = sample(site, o, start, end, opts.minAltitude, opts.observability);
    if (vis.hoursAboveMin < MIN_HOURS_UP) continue;
    const fr = framing(o, opts.fovArcmin);
    const moonSep = separationDeg(o.raHours, o.decDeg, moon.raHours, moon.decDeg);
    const moonPenalty = moon.illuminationPercent > MOON_BRIGHT_PCT && moonSep < MOON_NEAR_DEG && !EMISSION.has(o.type) ? (moon.illuminationPercent / 100) * (1 - moonSep / MOON_NEAR_DEG) * W.moon : 0;
    const bonus = o.aliases.some((a) => FAMOUS.test(a)) ? 5 : o.names.length ? 2 : 0;
    const geometric =
      (Math.min(vis.hoursAboveMin, HOURS_CAP) / HOURS_CAP) * W.hours +
      ((vis.maxAlt - opts.minAltitude) / (90 - opts.minAltitude)) * W.altitude +
      fr.fit * W.framing +
      brightness(o) * W.brightness +
      bonus -
      moonPenalty;
    // The best targets are those whose own optimal time coincides with good weather.
    const score = geometric * (WEATHER_FLOOR + (1 - WEATHER_FLOOR) * vis.alignment);
    const atPeak = opts.observability?.(vis.maxAltAt);
    scored.push({
      size: o.majorArcmin ?? 0,
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
        altitudeNow: Math.round(altAz(site, o.raHours, o.decDeg, now).altitude),
        moonSeparationDeg: Math.round(moonSep),
        framing: fr.text,
        suggestedFilter: suggestFilter(o, moon.illuminationPercent),
        clearHours: hasWx ? Math.round(vis.clearHours * 10) / 10 : null,
        weatherAlignment: hasWx ? Math.round(vis.alignment * 100) : null,
        skyAtBest: atPeak === undefined || !Number.isFinite(atPeak) ? null : Math.round(atPeak),
        score: Math.round(score),
      },
    });
  }
  scored.sort((a, b) => b.t.score - a.t.score);
  // One field, one entry: drop a target whose centre lies inside a better-ranked one that is at
  // least as big (the Maia Nebula inside M 45, a Sharpless region inside an NGC complex).
  const picked: typeof scored = [];
  for (const c of scored) {
    const host = picked.find((p) => p.size >= c.size && separationDeg(p.t.raHours, p.t.decDeg, c.t.raHours, c.t.decDeg) * 60 < p.size * SAME_FIELD);
    if (!host) picked.push(c);
    if (picked.length >= limit) break;
  }
  return {
    window: { start: fmtTime(start, opts.timezone), end: fmtTime(end, opts.timezone), hours: Math.round(((end.getTime() - start.getTime()) / 3600e3) * 10) / 10 },
    moon: { illuminationPercent: moon.illuminationPercent, phase: moon.phase },
    minAltitude: opts.minAltitude,
    weather: hasWx ? "ranked by how well tonight's forecast lines up with each target's best hours" : 'no forecast available: ranked on visibility alone',
    candidatesConsidered: candidates.length,
    targets: picked.map((p) => p.t),
  };
}
