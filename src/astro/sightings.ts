/**
 * Blocked views: where in the sky the tele was pointing, and when, each time something on the
 * ground was found blocking it (mark_blocked, night_plan obscured cause=obstruction). A record, not
 * the site's horizon: the planner works from the obstruction map alone (horizon.ts), and a target
 * found blocked is held on its own until its path takes it clear (raisedBy). A BLOCKED
 * tele_visibility is not filed at all: cloud and dew read the same. A record is kept for the night
 * it was seen in (sky.nightWindow), so the file does not grow.
 */
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';
import { altAz, nightWindow, type Site } from './sky.js';
import { distanceKm, SAME_SITE_KM, type Horizon } from './horizon.js';

const log = logger('sightings');

/** Upper bound on a sighting's life whatever the clock says (a stale file, a site far west of its timezone). */
const KEEP_HOURS = 24;
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

/**
 * When the night `now` is in began: the sunset of the planner's night window. After its darkness
 * has ended that window is tonight's, still to come, so nothing seen before it is in force.
 */
export function nightBeganAt(site: { lat: number; lon: number }, now: Date): number {
  const w = nightWindow({ lat: site.lat, lon: site.lon, elev: 0 }, now);
  return (w.sunset ?? w.darkStart)?.getTime() ?? now.getTime() - KEEP_HOURS * 3600e3;
}

const live = (s: Sighting, now: Date, began: number) => {
  const at = Date.parse(s.at);
  return at <= now.getTime() + 60e3 && now.getTime() - at < KEEP_HOURS * 3600e3 && at >= began;
};

/** The sightings still in force at this site: the ones seen in the night `now` is in. */
export function sightingsFor(site: { lat: number; lon: number }, now = new Date()): Sighting[] {
  const began = nightBeganAt(site, now);
  return loadAll().filter((s) => distanceKm(s.site, site) <= SAME_SITE_KM && live(s, now, began));
}

/** Remember that the tele was blocked pointing here, now. Expired sightings are dropped as it goes. */
export function recordBlocked(site: { lat: number; lon: number }, target: string, azimuth: number, altitude: number, reason: string, now = new Date()): Sighting {
  const s: Sighting = { at: now.toISOString(), site: { lat: site.lat, lon: site.lon }, target, azimuth: Math.round(azimuth * 10) / 10, altitude: Math.round(altitude * 10) / 10, reason };
  writeFileAtomic(file(), JSON.stringify([...loadAll().filter((x) => live(x, now, nightBeganAt(x.site, now))), s], null, 1));
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

/** The site's horizon raised by these sightings (for one target's own hold: when its path takes it clear of where it was blocked). */
export function raisedBy(base: Horizon | undefined, sightings: Sighting[]): Horizon {
  return {
    limit: (az) => Math.max(base?.limit(az) ?? 0, sightingLimit(sightings, az)),
    summary: base?.summary ?? 'blocked view',
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
