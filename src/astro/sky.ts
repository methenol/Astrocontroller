/**
 * Ephemeris helpers on astronomy-engine. Positions handed to the telescope are
 * J2000 (verified against coordinates the DWARF app recorded on this device).
 */
import * as A from 'astronomy-engine';
import { zonedWallTimeToInstant } from '../util/time.js';

export interface Site {
  lat: number;
  lon: number;
  elev: number;
}

const observer = (s: Site) => new A.Observer(s.lat, s.lon, s.elev);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function altAz(site: Site, raHours: number, decDeg: number, when = new Date()) {
  // Catalog coordinates are J2000; Horizon() wants equator-of-date.
  const t = A.MakeTime(when);
  const eqd = A.RotateVector(A.Rotation_EQJ_EQD(t), A.VectorFromSphere(new A.Spherical(decDeg, raHours * 15, 1), t));
  const sph = A.SphereFromVector(eqd);
  const h = A.Horizon(t, observer(site), sph.lon / 15, sph.lat, 'normal');
  return { altitude: h.altitude, azimuth: h.azimuth };
}

/** The J2000 position at an azimuth and (apparent) altitude: what to GoTo to point there. */
export function raDecFromAltAz(site: Site, azDeg: number, altDeg: number, when = new Date()): { raHours: number; decDeg: number } {
  const t = A.MakeTime(when);
  const hor = A.VectorFromHorizon(new A.Spherical(altDeg, azDeg, 1), t, 'normal');
  const eq = A.EquatorFromVector(A.RotateVector(A.Rotation_HOR_EQJ(t, observer(site)), hor));
  return { raHours: eq.ra, decDeg: eq.dec };
}

export const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;
export type BodyName = (typeof BODIES)[number];

export function bodyByName(name: string): BodyName | null {
  const n = name.trim().toLowerCase();
  return BODIES.find((b) => b.toLowerCase() === n) ?? null;
}

/** J2000 RA/Dec of a solar-system body as seen from the site. */
export function bodyRaDec(site: Site, body: BodyName, when = new Date()) {
  const eq = A.Equator(A.Body[body], A.MakeTime(when), observer(site), false, true);
  return { raHours: eq.ra, decDeg: eq.dec, distanceAu: eq.dist };
}

export interface BodyInfo {
  body: BodyName;
  altitude: number;
  azimuth: number;
  raHoursJ2000: number;
  decDegJ2000: number;
  magnitude?: number;
  phasePercent?: number;
  elongationFromSun?: number;
  nextRise?: string;
  nextSet?: string;
  nextTransit: string;
  transitAltitude: number;
}

export function bodyInfo(site: Site, body: BodyName, when = new Date()): BodyInfo {
  const t = A.MakeTime(when);
  const ofDate = A.Equator(A.Body[body], t, observer(site), true, true);
  const hor = A.Horizon(t, observer(site), ofDate.ra, ofDate.dec, 'normal');
  const j2000 = bodyRaDec(site, body, when);
  const transit = A.SearchHourAngle(A.Body[body], observer(site), 0, t, +1);
  const out: BodyInfo = {
    body,
    altitude: r1(hor.altitude),
    azimuth: r1(hor.azimuth),
    raHoursJ2000: Math.round(j2000.raHours * 1e4) / 1e4,
    decDegJ2000: Math.round(j2000.decDeg * 1e3) / 1e3,
    nextTransit: transit.time.date.toISOString(),
    transitAltitude: r1(transit.hor.altitude),
  };
  if (body !== 'Sun') {
    const ill = A.Illumination(A.Body[body], t);
    out.magnitude = r1(ill.mag);
    out.phasePercent = Math.round(ill.phase_fraction * 100);
    if (body !== 'Moon') out.elongationFromSun = r1(A.AngleFromSun(A.Body[body], t));
  }
  const rise = A.SearchRiseSet(A.Body[body], observer(site), +1, t, 1);
  const set = A.SearchRiseSet(A.Body[body], observer(site), -1, t, 1);
  out.nextRise = rise?.date.toISOString();
  out.nextSet = set?.date.toISOString();
  return out;
}

function sunEvent(site: Site, alt: number, dir: 1 | -1, from: Date) {
  const r = A.SearchAltitude(A.Body.Sun, observer(site), dir, A.MakeTime(from), 2, alt);
  return r ? r.date : null;
}

/** How far back the start of a night in progress is looked for (a polar winter night has no sunset at all). */
const NIGHT_LOOKBACK_MS = 36 * 3600e3;
const SUNSET_ALT = -0.833;
/** Below this the night is under way, and the window reported is the current one, not the next. */
const NIGHT_UNDER_WAY_ALT = -12;

/** The last time before `when` the Sun set through `alt`, or null when it did not within the lookback. */
function lastSunset(site: Site, alt: number, when: Date): Date | null {
  let last: Date | null = null;
  let from = new Date(when.getTime() - NIGHT_LOOKBACK_MS);
  for (;;) {
    const r = A.SearchAltitude(A.Body.Sun, observer(site), -1, A.MakeTime(from), (when.getTime() - from.getTime()) / 86400e3, alt);
    if (!r || r.date.getTime() > when.getTime()) return last;
    last = r.date;
    from = new Date(r.date.getTime() + 60e3);
  }
}

/** The dusk→dawn events of the night whose dusk follows `from`. */
function windowFrom(site: Site, from: Date) {
  const sunset = sunEvent(site, SUNSET_ALT, -1, from);
  // The night ends at the sunrise after its sunset: an event past it belongs to a later night. At the
  // edge of a season without astronomical darkness tonight has no -18° dusk while tomorrow has one,
  // and the search would otherwise pair tonight's sunset with tomorrow's darkness.
  const nightEnd = sunEvent(site, SUNSET_ALT, +1, sunset ?? from);
  const tonight = (d: Date | null) => (d && (!nightEnd || d.getTime() <= nightEnd.getTime()) ? d : null);
  const civilDusk = tonight(sunEvent(site, -6, -1, from));
  const nauticalDusk = tonight(sunEvent(site, -12, -1, from));
  const astroDusk = tonight(sunEvent(site, -18, -1, from));
  const base = astroDusk ?? nauticalDusk ?? sunset ?? from;
  const astroDawn = tonight(sunEvent(site, -18, +1, base));
  const nauticalDawn = tonight(sunEvent(site, -12, +1, base));
  const civilDawn = tonight(sunEvent(site, -6, +1, base));
  const sunrise = sunEvent(site, SUNSET_ALT, +1, base);
  // Polar summer: no astronomical darkness — fall back to nautical.
  const darkStart = astroDusk ?? nauticalDusk ?? sunset;
  const darkEnd = astroDawn ?? nauticalDawn ?? sunrise;
  return { sunset, civilDusk, nauticalDusk, astroDusk, astroDawn, nauticalDawn, civilDawn, sunrise, darkStart, darkEnd };
}

/**
 * Tonight's darkness window: the current night while the Sun is down and its darkness has not ended
 * yet (evening twilight included, so the sunset reported is today's), else the next one.
 */
export function nightWindow(site: Site, when = new Date()) {
  // geometric, like the sunset search: with refraction the Sun still reads above the sunset altitude for
  // a minute or so after the search's sunset, and the window would pair tomorrow's sunset (and so its
  // night key) with tonight's dusk
  const sunAlt = sunAltGeometric(site, when);
  if (sunAlt < SUNSET_ALT) {
    const began = lastSunset(site, SUNSET_ALT, when);
    // a polar night without a sunset in the lookback: search the whole lookback
    if (!began && sunAlt < NIGHT_UNDER_WAY_ALT) return windowFrom(site, new Date(when.getTime() - NIGHT_LOOKBACK_MS));
    if (began) {
      const w = windowFrom(site, new Date(began.getTime() - 60e3));
      // morning twilight after the darkness ended: that night is over, the next one is tonight's
      if (!w.darkEnd || w.darkEnd.getTime() > when.getTime()) return w;
    }
  }
  return windowFrom(site, when);
}

function sunAltGeometric(site: Site, when: Date): number {
  const t = A.MakeTime(when);
  const eq = A.Equator(A.Body.Sun, t, observer(site), true, true);
  return A.Horizon(t, observer(site), eq.ra, eq.dec).altitude;
}

export function bodyAlt(site: Site, body: BodyName, when = new Date()): number {
  const t = A.MakeTime(when);
  const eq = A.Equator(A.Body[body], t, observer(site), true, true);
  return A.Horizon(t, observer(site), eq.ra, eq.dec, 'normal').altitude;
}

const MOON_PHASES = ['new', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full', 'waning gibbous', 'last quarter', 'waning crescent'] as const;

export function moonState(site: Site, when = new Date()) {
  const t = A.MakeTime(when);
  const phaseAngle = A.MoonPhase(t);
  const ill = A.Illumination(A.Body.Moon, t);
  const phaseName = MOON_PHASES[Math.round(phaseAngle / 45) % MOON_PHASES.length];
  const pos = bodyRaDec(site, 'Moon', when);
  return {
    illuminationPercent: Math.round(ill.phase_fraction * 100),
    phase: phaseName,
    altitude: r1(bodyAlt(site, 'Moon', when)),
    raHours: pos.raHours,
    decDeg: pos.decDeg,
    nextRise: A.SearchRiseSet(A.Body.Moon, observer(site), +1, t, 1)?.date.toISOString(),
    nextSet: A.SearchRiseSet(A.Body.Moon, observer(site), -1, t, 1)?.date.toISOString(),
  };
}

/** Angular separation in degrees between two J2000 positions. */
export function separationDeg(ra1H: number, dec1: number, ra2H: number, dec2: number): number {
  const d2r = Math.PI / 180;
  const a1 = ra1H * 15 * d2r;
  const a2 = ra2H * 15 * d2r;
  const c = Math.sin(dec1 * d2r) * Math.sin(dec2 * d2r) + Math.cos(dec1 * d2r) * Math.cos(dec2 * d2r) * Math.cos(a1 - a2);
  return Math.acos(Math.min(1, Math.max(-1, c))) / d2r;
}

/** Sample a target's altitude across a window. */
export function visibility(site: Site, raHours: number, decDeg: number, start: Date, end: Date, minAlt: number, stepMin = 10) {
  if (!(stepMin > 0) || !Number.isFinite(stepMin)) throw new Error(`visibility step must be a positive number of minutes, not ${stepMin}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('visibility needs a valid start and end time');
  let maxAlt = -90;
  let maxAt = start;
  let minutesAbove = 0;
  let firstAbove: Date | null = null;
  let lastAbove: Date | null = null;
  for (let t = start.getTime(); t <= end.getTime(); t += stepMin * 60e3) {
    const d = new Date(t);
    const { altitude } = altAz(site, raHours, decDeg, d);
    if (altitude > maxAlt) {
      maxAlt = altitude;
      maxAt = d;
    }
    if (altitude >= minAlt) {
      // each sample stands for the step that follows it, up to the end of the window (the last stands for none)
      minutesAbove += Math.min(stepMin, (end.getTime() - t) / 60e3);
      firstAbove ??= d;
      lastAbove = d;
    }
  }
  return { maxAlt: r1(maxAlt), maxAltAt: maxAt, hoursAboveMin: r1(minutesAbove / 60), firstAbove, lastAbove };
}

export function fmtTime(d: Date | null | undefined, tz: string): string | null {
  if (!d) return null;
  return d.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** The observer's local calendar date as YYYY-MM-DD: what day-keyed memory is filed under. */
export function localDate(when: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(when);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Right ascension as 00h00m00.0s. Rounded once, in tenths of a second, so 59.95 s carries into the minute. */
export function hoursToHms(h: number): string {
  const tenths = Math.round((((h % 24) + 24) % 24) * 36_000) % (24 * 36_000);
  const hh = Math.floor(tenths / 36_000);
  const mm = Math.floor((tenths % 36_000) / 600);
  const ss = (tenths % 600) / 10;
  return `${pad2(hh)}h${pad2(mm)}m${ss.toFixed(1).padStart(4, '0')}s`;
}

/** Declination as ±00°00'00". Rounded once, in whole seconds, so 59.6" carries into the minute. */
export function degToDms(d: number): string {
  const sign = d < 0 ? '-' : '+';
  const total = Math.round(Math.abs(d) * 3600);
  const dd = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${sign}${pad2(dd)}°${pad2(mm)}'${pad2(ss)}"`;
}

/**
 * Parse a user/agent-supplied time. Strings with an explicit zone are taken
 * as-is; "YYYY-MM-DD" means local noon that day (so "tonight" resolves
 * correctly); naive "YYYY-MM-DDTHH:MM" is local time in the observer's zone.
 */
export function parseLocal(s: string, tz: string): Date {
  const t = s.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) throw new Error(`cannot parse time "${s}"`);
    return d;
  }
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(t)) throw new Error(`cannot parse time "${s}" (use YYYY-MM-DD, YYYY-MM-DDTHH:MM, or an ISO time with a zone)`);
  const naive = t.length === 10 ? `${t}T12:00:00` : t.replace(' ', 'T');
  const asUtc = new Date(`${naive}Z`);
  // Date rolls impossible dates over (Feb 30 → Mar 2): the date must survive the round trip
  if (Number.isNaN(asUtc.getTime()) || asUtc.toISOString().slice(0, 16) !== naive.slice(0, 16).padEnd(16, '0')) throw new Error(`cannot parse time "${s}"`);
  return new Date(zonedWallTimeToInstant(asUtc.getTime(), tz));
}
