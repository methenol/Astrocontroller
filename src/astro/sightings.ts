/**
 * Blocked views seen tonight: where in the sky the tele was pointing, and when, each time
 * tele_visibility found it blocked.
 *
 * A blocked verdict is a fact about the landscape at one altitude and azimuth, not about the
 * target: the sky turns, so the same target rises clear of a tree later (or sinks behind it), and
 * another target passing through that patch is blocked there too. Each sighting therefore raises
 * the site's horizon at that azimuth to just above the altitude that was blocked (obstructions
 * stand on the ground: what is behind them at that altitude is also behind them lower down), and
 * the planner works out from that horizon when each target is clear. A sighting is kept for one
 * night: a verdict caused by cloud or dew must not hold the sky back tomorrow.
 */
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';
import { altAz, type Site } from './sky.js';
import { distanceKm, SAME_SITE_KM, type Horizon } from './horizon.js';

const log = logger('sightings');

/** A sighting holds back its patch of sky this long: one night, not the next. */
const KEEP_HOURS = 16;
/** The blocked altitude plus this: the frame was blocked, so its top edge is at least about this high. */
const ALT_MARGIN_DEG = 1.5;
/** Half the azimuth width a sighting covers at the horizon; it widens with 1/cos(alt), as a frame does. */
const AZ_HALF_DEG = 2;
const AZ_HALF_MAX_DEG = 10;
/** Steps when searching for the time a target clears. */
const CLEAR_STEP_MIN = 5;

export interface Sighting {
  /** ISO time it was found blocked */
  at: string;
  site: { lat: number; lon: number };
  target: string;
  azimuth: number;
  altitude: number;
  reason: string;
}

const file = () => path.join(config.paths.data, 'blocked-sightings.json');

function loadAll(): Sighting[] {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(data) ? data.filter((s) => s && typeof s.at === 'string' && typeof s.azimuth === 'number' && typeof s.altitude === 'number' && typeof s.site?.lat === 'number') : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${file()}: ${errMsg(err)}`);
    return [];
  }
}

const live = (s: Sighting, now: Date) => now.getTime() - Date.parse(s.at) < KEEP_HOURS * 3600e3;

/** The sightings still in force at this site. */
export function sightingsFor(site: { lat: number; lon: number }, now = new Date()): Sighting[] {
  return loadAll().filter((s) => live(s, now) && distanceKm(s.site, site) <= SAME_SITE_KM);
}

/** Remember that the tele was blocked pointing here, now. Expired sightings are dropped as it goes. */
export function recordBlocked(site: { lat: number; lon: number }, target: string, azimuth: number, altitude: number, reason: string, now = new Date()): Sighting {
  const s: Sighting = { at: now.toISOString(), site: { lat: site.lat, lon: site.lon }, target, azimuth: Math.round(azimuth * 10) / 10, altitude: Math.round(altitude * 10) / 10, reason };
  writeFileAtomic(file(), JSON.stringify([...loadAll().filter((x) => live(x, now)), s], null, 1));
  return s;
}

const azDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** The altitude below which the sightings block this azimuth (0 where none covers it). */
export function sightingLimit(sightings: Sighting[], azDeg: number): number {
  let lim = 0;
  for (const s of sightings) {
    const half = Math.min(AZ_HALF_MAX_DEG, AZ_HALF_DEG / Math.max(0.1, Math.cos((s.altitude * Math.PI) / 180)));
    if (azDiff(s.azimuth, azDeg) <= half) lim = Math.max(lim, s.altitude + ALT_MARGIN_DEG);
  }
  return lim;
}

/** The site's horizon raised by tonight's sightings; undefined only when there is neither. */
export function withSightings(base: Horizon | undefined, sightings: Sighting[]): Horizon | undefined {
  if (!sightings.length) return base;
  const n = `${sightings.length} blocked view${sightings.length === 1 ? '' : 's'} seen tonight`;
  return {
    limit: (az) => Math.max(base?.limit(az) ?? 0, sightingLimit(sightings, az)),
    summary: base ? `${base.summary}; ${n}` : n,
  };
}

/**
 * When a target is next clear of the horizon and above the minimum altitude, searching from `from`
 * to `until`: `from` itself when it is clear now, null when it does not clear in that time (it is
 * setting behind the obstruction, or the night ends first).
 */
export function clearsAt(site: Site, raHours: number, decDeg: number, minAlt: number, horizon: Horizon | undefined, from: Date, until: Date): Date | null {
  for (let t = from.getTime(); t <= until.getTime(); t += CLEAR_STEP_MIN * 60e3) {
    const d = new Date(t);
    const aa = altAz(site, raHours, decDeg, d);
    if (aa.altitude >= Math.max(minAlt, horizon?.limit(aa.azimuth) ?? 0)) return d;
  }
  return null;
}
