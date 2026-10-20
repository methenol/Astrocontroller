/**
 * The site's horizon: how high the obstructions (trees, houses, the roofline over the porch) reach
 * at each compass direction, so the planner only offers what can actually be seen from where the
 * scope stands.
 *
 * A mask is 360 one-degree azimuth bins (true north = 0, east = 90), each the altitude in degrees
 * below which that direction is blocked, or null where nothing was observed. It is made by the
 * obstruction survey (media/horizon/survey.ts) or imported from another planner's horizon file, and
 * kept per site: the scope travels, and a mask from the back yard is wrong in the driveway. The
 * text form is the "azimuth altitude" lines that N.I.N.A., Stellarium, Clear Night Coach and
 * Telescopius read and write, so a mask can go both ways.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';

const log = logger('horizon');

export const BINS = 360;
/** A mask belongs to a site within this distance; further away it is someone else's horizon. */
export const SAME_SITE_KM = 0.3;
/** Masks kept per site (the newest is the one in use). */
const KEEP_PER_SITE = 5;

export interface HorizonMask {
  id: string;
  site: { lat: number; lon: number };
  createdAt: string;
  source: 'survey' | 'import';
  /** altitude (deg) of the obstruction top in each 1° azimuth bin [k, k+1); null = not observed */
  profile: Array<number | null>;
  /** bins whose obstruction reached the top of what the survey photographed: at least this high */
  capped?: number[];
  /** survey details: mount mode, frames, how well the pointing fitted, the panorama picture */
  survey?: {
    mode: string;
    frames: number;
    pointingResidualDeg?: number;
    marginDeg: number;
    panorama?: string;
    notes: string[];
  };
}

const file = () => path.join(config.paths.data, 'horizons.json');

const isMask = (m: unknown): m is HorizonMask => {
  const x = m as HorizonMask;
  return !!x && typeof x.id === 'string' && Array.isArray(x.profile) && x.profile.length === BINS && typeof x.site?.lat === 'number' && typeof x.site?.lon === 'number';
};

/** Every stored mask; a missing or corrupt file is none (planning must never fail on it). */
export function loadMasks(): HorizonMask[] {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(data?.masks) ? data.masks.filter(isMask) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`horizons.json unreadable, no horizon masks in use: ${errMsg(err)}`);
    return [];
  }
}

function saveMasks(masks: HorizonMask[]): void {
  writeFileAtomic(file(), JSON.stringify({ masks }, null, 1));
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The mask in use at a site: the newest one made there, or null. */
export function maskFor(site: { lat: number; lon: number } | null | undefined, masks = loadMasks()): HorizonMask | null {
  if (!site) return null;
  const here = masks.filter((m) => distanceKm(m.site, site) <= SAME_SITE_KM);
  here.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return here[0] ?? null;
}

/** Store a mask as the one in use at its site (older ones there are kept as history, a few). */
export function saveMask(mask: HorizonMask): HorizonMask {
  const masks = loadMasks();
  masks.push(mask);
  const here = masks.filter((m) => distanceKm(m.site, mask.site) <= SAME_SITE_KM).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const drop = new Set(here.slice(KEEP_PER_SITE).map((m) => m.id));
  saveMasks(masks.filter((m) => !drop.has(m.id)));
  return mask;
}

/** Forget every mask at this site (the planner goes back to the plain minimum altitude). */
export function clearMasks(site: { lat: number; lon: number }): number {
  const masks = loadMasks();
  const keep = masks.filter((m) => distanceKm(m.site, site) > SAME_SITE_KM);
  saveMasks(keep);
  return masks.length - keep.length;
}

export const newMaskId = () => `hz-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const norm360 = (a: number) => ((a % 360) + 360) % 360;

/**
 * The obstruction altitude toward an azimuth, interpolated between bin centres; 0 where the mask
 * has no observation (nothing known blocks it beyond the planner's own minimum altitude).
 */
export function limitAt(mask: Pick<HorizonMask, 'profile'>, azDeg: number): number {
  const x = norm360(azDeg) - 0.5;
  const i0 = Math.floor(x);
  const f = x - i0;
  const a = mask.profile[(i0 + BINS) % BINS] ?? 0;
  const b = mask.profile[(i0 + 1) % BINS] ?? 0;
  return a + (b - a) * f;
}

/** What the planner needs: the limit at an azimuth, and a line saying where it came from. */
export interface Horizon {
  limit(azDeg: number): number;
  summary: string;
}

export function horizonOf(mask: HorizonMask): Horizon {
  return { limit: (az) => limitAt(mask, az), summary: describeMask(mask) };
}

/** The mask in use at a site as a planner horizon, or undefined when there is none. */
export function horizonFor(site: { lat: number; lon: number } | null | undefined): Horizon | undefined {
  const m = maskFor(site);
  return m ? horizonOf(m) : undefined;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (az: number) => COMPASS[Math.round(norm360(az) / 22.5) % 16];

/**
 * One line for people and the agent: when and how it was made, how much is known, and the worst
 * sectors (eight 45° sectors, each by its highest obstruction).
 */
export function describeMask(m: HorizonMask): string {
  const known = m.profile.filter((v) => v !== null).length;
  const sectors: string[] = [];
  for (let s = 0; s < 8; s++) {
    let hi = -1;
    for (let k = s * 45 - 22; k < s * 45 + 23; k++) hi = Math.max(hi, m.profile[(k + BINS) % BINS] ?? -1);
    sectors.push(hi < 0 ? `${COMPASS[s * 2]} ?` : `${COMPASS[s * 2]} ${Math.round(hi)}°`);
  }
  const when = m.createdAt.slice(0, 16).replace('T', ' ');
  return `site horizon from the ${m.source === 'survey' ? 'obstruction survey' : 'imported horizon'} of ${when} UTC (${known}/360° observed; highest per sector: ${sectors.join(', ')})`;
}

/** Sectors (runs of bins) the survey could not see, as "az–az" text. */
export function unknownSectors(m: Pick<HorizonMask, 'profile'>): string[] {
  const out: string[] = [];
  let start = -1;
  for (let k = 0; k <= BINS; k++) {
    const unknown = k < BINS && m.profile[k] === null;
    if (unknown && start < 0) start = k;
    if (!unknown && start >= 0) {
      out.push(`${start}–${k}°`);
      start = -1;
    }
  }
  return out;
}

// ---- the shared text format

/** "azimuth altitude" lines, one per degree at the bin centres (observed bins only), with a comment header. */
export function toHorizonText(m: HorizonMask): string {
  const lines = [`# Horizon for ${m.site.lat.toFixed(5)}, ${m.site.lon.toFixed(5)} — ${describeMask(m)}`, '# azimuth(deg, 0 = north, 90 = east) altitude(deg)'];
  for (let k = 0; k < BINS; k++) {
    const v = m.profile[k];
    if (v !== null) lines.push(`${k + 0.5} ${Math.round(v * 10) / 10}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Parse "azimuth altitude" pairs (whitespace, comma or semicolon separated; # and ; comments) into
 * 360 bins, interpolating linearly between the given points around the circle, the way N.I.N.A. and
 * Stellarium do. At least two points.
 */
export function parseHorizonText(text: string): Array<number> {
  const pts: Array<[number, number]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const nums = line.split(/[\s,]+/).map(Number);
    if (nums.length < 2 || !nums.slice(0, 2).every(Number.isFinite)) throw new Error(`not an "azimuth altitude" line: "${raw.trim()}"`);
    const [az, alt] = nums;
    if (alt < -5 || alt > 90) throw new Error(`altitude ${alt}° out of range in "${raw.trim()}"`);
    pts.push([norm360(az), Math.max(0, alt)]);
  }
  if (pts.length < 2) throw new Error('a horizon needs at least two "azimuth altitude" points');
  pts.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (let k = 0; k < BINS; k++) {
    const az = k + 0.5;
    let j = pts.findIndex((p) => p[0] > az);
    if (j < 0) j = 0;
    const hi = pts[j];
    const lo = pts[(j - 1 + pts.length) % pts.length];
    const span = norm360(hi[0] - lo[0]) || 360;
    const f = norm360(az - lo[0]) / span;
    out.push(Math.round((lo[1] + (hi[1] - lo[1]) * f) * 10) / 10);
  }
  return out;
}
