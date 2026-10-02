/**
 * Ephemeris helpers on astronomy-engine. Positions handed to the telescope are
 * J2000 (verified against coordinates the DWARF app recorded on this device).
 */
import * as A from 'astronomy-engine';
import { timezoneOffsetHours } from '../dwarf/device.js';

export interface Site {
  lat: number;
  lon: number;
  elev: number;
}

const observer = (s: Site) => new A.Observer(s.lat, s.lon, s.elev);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function altAz(site: Site, raHours: number, decDeg: number, when = new Date()) {
  // Catalog coordinates are J2000; Horizon() wants equator-of-date.
  const t = A.MakeTime(when);
  const eqd = A.RotateVector(A.Rotation_EQJ_EQD(t), A.VectorFromSphere(new A.Spherical(decDeg, raHours * 15, 1), t));
  const sph = A.SphereFromVector(eqd);
  const h = A.Horizon(t, observer(site), sph.lon / 15, sph.lat, 'normal');
  return { altitude: h.altitude, azimuth: h.azimuth };
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

export function bodyInfo(site: Site, body: BodyName, when = new Date()) {
  const t = A.MakeTime(when);
  const ofDate = A.Equator(A.Body[body], t, observer(site), true, true);
  const hor = A.Horizon(t, observer(site), ofDate.ra, ofDate.dec, 'normal');
  const j2000 = bodyRaDec(site, body, when);
  const out: Record<string, unknown> = {
    body,
    altitude: r1(hor.altitude),
    azimuth: r1(hor.azimuth),
    raHoursJ2000: Math.round(j2000.raHours * 1e4) / 1e4,
    decDegJ2000: Math.round(j2000.decDeg * 1e3) / 1e3,
  };
  if (body !== 'Sun') {
    const ill = A.Illumination(A.Body[body], t);
    out.magnitude = r1(ill.mag);
    out.phasePercent = Math.round(ill.phase_fraction * 100);
    if (body !== 'Moon') out.elongationFromSun = r1(A.AngleFromSun(A.Body[body], t));
  }
  const rise = A.SearchRiseSet(A.Body[body], observer(site), +1, t, 1);
  const set = A.SearchRiseSet(A.Body[body], observer(site), -1, t, 1);
  const transit = A.SearchHourAngle(A.Body[body], observer(site), 0, t, +1);
  out.nextRise = rise?.date.toISOString();
  out.nextSet = set?.date.toISOString();
  out.nextTransit = transit.time.date.toISOString();
  out.transitAltitude = r1(transit.hor.altitude);
  return out;
}

function sunEvent(site: Site, alt: number, dir: 1 | -1, from: Date) {
  const r = A.SearchAltitude(A.Body.Sun, observer(site), dir, A.MakeTime(from), 2, alt);
  return r ? r.date : null;
}

/** Tonight's darkness window: the next astronomical dusk→dawn (or now if already dark). */
export function nightWindow(site: Site, when = new Date()) {
  const sunAlt = bodyAlt(site, 'Sun', when);
  // If it's currently night, search dusk from 14h earlier so we report the current night.
  const searchFrom = sunAlt < -12 ? new Date(when.getTime() - 14 * 3600e3) : when;
  const sunset = sunEvent(site, -0.833, -1, searchFrom);
  const civilDusk = sunEvent(site, -6, -1, searchFrom);
  const nauticalDusk = sunEvent(site, -12, -1, searchFrom);
  const astroDusk = sunEvent(site, -18, -1, searchFrom);
  const base = astroDusk ?? nauticalDusk ?? sunset ?? when;
  const astroDawn = sunEvent(site, -18, +1, base);
  const nauticalDawn = sunEvent(site, -12, +1, base);
  const civilDawn = sunEvent(site, -6, +1, base);
  const sunrise = sunEvent(site, -0.833, +1, base);
  // Polar summer: no astronomical darkness — fall back to nautical.
  const darkStart = astroDusk ?? nauticalDusk ?? sunset;
  const darkEnd = astroDawn ?? nauticalDawn ?? sunrise;
  return { sunset, civilDusk, nauticalDusk, astroDusk, astroDawn, nauticalDawn, civilDawn, sunrise, darkStart, darkEnd };
}

export function bodyAlt(site: Site, body: BodyName, when = new Date()): number {
  const t = A.MakeTime(when);
  const eq = A.Equator(A.Body[body], t, observer(site), true, true);
  return A.Horizon(t, observer(site), eq.ra, eq.dec, 'normal').altitude;
}

export function moonState(site: Site, when = new Date()) {
  const t = A.MakeTime(when);
  const phaseAngle = A.MoonPhase(t);
  const ill = A.Illumination(A.Body.Moon, t);
  const names = ['new', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full', 'waning gibbous', 'last quarter', 'waning crescent'];
  const phaseName = names[Math.round(phaseAngle / 45) % 8];
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
      minutesAbove += stepMin;
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

export function hoursToHms(h: number): string {
  const x = ((h % 24) + 24) % 24;
  const hh = Math.floor(x);
  const mm = Math.floor((x - hh) * 60);
  const ss = ((x - hh) * 60 - mm) * 60;
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}m${ss.toFixed(1).padStart(4, '0')}s`;
}

export function degToDms(d: number): string {
  const s = d < 0 ? '-' : '+';
  const a = Math.abs(d);
  const dd = Math.floor(a);
  const mm = Math.floor((a - dd) * 60);
  const ss = Math.round(((a - dd) * 60 - mm) * 60);
  return `${s}${String(dd).padStart(2, '0')}°${String(mm).padStart(2, '0')}'${String(ss).padStart(2, '0')}"`;
}

/**
 * Parse a user/agent-supplied time. Strings with an explicit zone are taken
 * as-is; "YYYY-MM-DD" means local noon that day (so "tonight" resolves
 * correctly); naive "YYYY-MM-DDTHH:MM" is local time in the observer's zone.
 */
export function parseLocal(s: string, tz: string): Date {
  const t = s.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) return new Date(t);
  const naive = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T12:00:00` : t.replace(' ', 'T');
  const asUtc = new Date(`${naive}Z`);
  if (Number.isNaN(asUtc.getTime())) throw new Error(`cannot parse time "${s}"`);
  const off = timezoneOffsetHours(tz, asUtc.getTime()) ?? 0;
  return new Date(asUtc.getTime() - off * 3600e3);
}
