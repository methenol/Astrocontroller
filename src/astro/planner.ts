import { catalog, displayName, gotoLabel, TYPE_GROUPS, type DsoObject } from './catalog.js';
import { visibility, nightWindow, moonState, separationDeg, fmtTime, type Site, altAz } from './sky.js';

export interface PlanOptions {
  start?: Date;
  end?: Date;
  minAltitude: number;
  types?: string[]; // group names or OpenNGC codes
  maxMagnitude?: number;
  minSizeArcmin?: number;
  maxSizeArcmin?: number;
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

/** 0–1 from the magnitude, or from the brightness class (Sharpless, Lynds…) when there is none. */
function brightness(o: DsoObject): number {
  if (o.mag !== undefined) return Math.max(0, Math.min(1, (13 - o.mag) / 9));
  if (o.brightClass !== undefined) return ({ 1: 0.55, 2: 0.35, 3: 0.15 } as Record<number, number>)[o.brightClass] ?? 0.3;
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

export function planNight(site: Site, opts: PlanOptions) {
  const now = new Date();
  const win = nightWindow(site, now);
  const start = opts.start ?? (win.darkStart && win.darkStart > now ? win.darkStart : now);
  const end = opts.end ?? win.darkEnd ?? new Date(start.getTime() + 8 * 3600e3);
  const moon = moonState(site, new Date((start.getTime() + end.getTime()) / 2));
  const types = new Set<string>();
  for (const t of opts.types ?? []) for (const code of TYPE_GROUPS[t.toLowerCase()] ?? [t]) types.add(code);
  const maxMag = opts.maxMagnitude ?? 11;
  const minSize = opts.minSizeArcmin ?? 4;
  const maxSize = opts.maxSizeArcmin ?? 600;

  const candidates = catalog().filter((o) => {
    if (types.size && !types.has(o.type)) return false;
    if (ONLY_ON_REQUEST.includes(o.type) && !types.has(o.type)) return false;
    const famous = o.aliases.some((a) => /^M \d+$/.test(a) || /^C \d+$/.test(a));
    // Bright enough: a magnitude within the limit, or (nebulae have none) a bright or moderate class.
    if (!famous && !(o.mag !== undefined ? o.mag <= maxMag : o.brightClass !== undefined && o.brightClass <= 2)) return false;
    if ((o.majorArcmin ?? 0) < minSize || (o.majorArcmin ?? 0) > maxSize) return false;
    // Quick reject: never rises above min altitude at this latitude.
    return 90 - Math.abs(site.lat - o.decDeg) >= opts.minAltitude;
  });

  const out: PlannedTarget[] = [];
  for (const o of candidates) {
    const vis = visibility(site, o.raHours, o.decDeg, start, end, opts.minAltitude, 15);
    if (vis.hoursAboveMin < 0.75) continue;
    const fr = framing(o, opts.fovArcmin);
    const moonSep = separationDeg(o.raHours, o.decDeg, moon.raHours, moon.decDeg);
    const moonPenalty = moon.illuminationPercent > 30 && moonSep < 40 && !EMISSION.has(o.type) ? (moon.illuminationPercent / 100) * (1 - moonSep / 40) * 25 : 0;
    const famous = o.aliases.some((a) => /^M \d+$/.test(a) || /^C \d+$/.test(a)) ? 5 : o.names.length ? 2 : 0;
    // Weather alignment: how good the forecast is during THIS target's best hours. Each 15 min
    // above the minimum altitude is weighted by how well placed the target is then (its altitude
    // above the minimum relative to its own peak, squared, so the hours around the peak dominate),
    // and the forecast is averaged with those weights: 1 = clear at its peak, 0 = clouded out
    // when it matters. The geometric score is then scaled by it, so the best targets are those
    // whose own optimal time coincides with good weather. Without a forecast the factor is 1.
    let wg = 0;
    let g = 0;
    let clear = 0;
    let wPeak: number | undefined;
    const stepH = 0.25;
    const span = Math.max(1, vis.maxAlt - opts.minAltitude);
    for (let t = start.getTime(); t <= end.getTime(); t += stepH * 3600e3) {
      const d = new Date(t);
      const alt = altAz(site, o.raHours, o.decDeg, d).altitude;
      if (alt < opts.minAltitude) continue;
      const obs = opts.observability?.(d);
      const w = obs === undefined ? 1 : obs / 100;
      const q = ((alt - opts.minAltitude) / span) ** 2;
      wg += w * q;
      g += q;
      clear += stepH * w;
    }
    if (opts.observability) {
      const o2 = opts.observability(vis.maxAltAt);
      wPeak = o2 === undefined ? undefined : o2 / 100;
    }
    const hasWx = !!opts.observability;
    const alignment = hasWx && g > 0 ? wg / g : 1;
    const geometric =
      (Math.min(vis.hoursAboveMin, 6) / 6) * 35 +
      ((vis.maxAlt - opts.minAltitude) / (90 - opts.minAltitude)) * 15 +
      fr.fit * 25 +
      brightness(o) * 20 +
      famous -
      moonPenalty;
    const score = geometric * (0.35 + 0.65 * alignment);
    out.push({
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
      clearHours: hasWx ? Math.round(clear * 10) / 10 : null,
      weatherAlignment: hasWx ? Math.round(alignment * 100) : null,
      skyAtBest: wPeak === undefined ? null : Math.round(wPeak * 100),
      score: Math.round(score),
    });
  }
  out.sort((a, b) => b.score - a.score);
  // One field, one entry: drop a target whose centre lies inside a better-ranked one that is at
  // least as big (the Maia Nebula inside M 45, a Sharpless region inside an NGC complex).
  const picked: PlannedTarget[] = [];
  const size = (t: PlannedTarget) => Number(t.sizeArcmin.split('×')[0]) || 0;
  for (const t of out) {
    const host = picked.find((p) => size(p) >= size(t) && separationDeg(p.raHours, p.decDeg, t.raHours, t.decDeg) * 60 < size(p) * 0.4);
    if (!host) picked.push(t);
    if (picked.length >= (opts.limit ?? 15)) break;
  }
  return {
    window: { start: fmtTime(start, opts.timezone), end: fmtTime(end, opts.timezone), hours: Math.round(((end.getTime() - start.getTime()) / 3600e3) * 10) / 10 },
    moon: { illuminationPercent: moon.illuminationPercent, phase: moon.phase },
    minAltitude: opts.minAltitude,
    weather: opts.observability ? 'ranked by how well tonight\'s forecast lines up with each target\'s best hours' : 'no forecast available: ranked on visibility alone',
    candidatesConsidered: candidates.length,
    targets: picked,
  };
}
