/**
 * A fixed target's year at a site: for each week of the coming year, how long it is above the
 * limit (the minimum altitude, raised by the site's obstruction map) during astronomical darkness,
 * and how high it gets then. Rolled up by month, with the season's first and last usable nights
 * and the night it transits in the middle of darkness (its best night, opposition for a DSO).
 * Deterministic: astronomy-engine positions, no forecast and no Moon (they change night to night).
 */
import * as sky from './sky.js';
import type { Horizon } from './horizon.js';

const DAY_MS = 86_400e3;
const SAMPLE_MS = 15 * 60e3;
/** a night with less than this above the limit does not count as usable */
const USABLE_MIN = 60;

export interface SeasonNight {
  /** local date of the evening */
  date: string;
  darkHours: number;
  /** hours above the limit during darkness */
  usableHours: number;
  /** highest altitude during darkness */
  maxAlt: number;
  /** altitude at the middle of darkness */
  midAlt: number | null;
}

export interface SeasonMonth {
  /** Jan … Dec, in order from this month */
  month: string;
  usableHours: number;
  maxAlt: number;
  /** usable nights among the sampled ones */
  usableNights: number;
  nights: number;
}

export interface TargetSeason {
  minAltitude: number;
  horizon: string | null;
  /** the highest it ever gets at this site, at transit */
  transitAltitude: number;
  circumpolar: boolean;
  neverRises: boolean;
  months: SeasonMonth[];
  bestMonths: string[];
  /** the longest run of usable nights over the sampled year, start before end (null = never usable, or all year) */
  seasonStart: string | null;
  seasonEnd: string | null;
  /** tonight is one of the season's nights */
  inSeasonNow: boolean;
  usableAllYear: boolean;
  /** the night it is highest at the middle of darkness */
  bestNight: { date: string; altitude: number; usableHours: number } | null;
  tonight: SeasonNight | null;
  nights: SeasonNight[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** the calendar month: a year of nights from tonight, this month's nights from both ends go together */
const monthLabel = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1];
/** the same date a year earlier */
const yearBefore = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;

export function targetSeason(
  site: sky.Site,
  raHours: number,
  decDeg: number,
  o: { minAltitude: number; tz: string; horizon?: Horizon; from?: Date; days?: number; stepDays?: number },
): TargetSeason {
  const from = o.from ?? new Date();
  const days = o.days ?? 365;
  const stepDays = o.stepDays ?? 7;
  const limit = (az: number) => Math.max(o.minAltitude, o.horizon ? o.horizon.limit(az) : 0);
  const nights: SeasonNight[] = [];
  for (let d = 0; d < days; d += stepDays) {
    const when = new Date(from.getTime() + d * DAY_MS);
    // the night under way (or the next one) at this clock time, d days on
    const w = sky.nightWindow(site, when);
    const date = sky.localDate(w.sunset ?? when, o.tz);
    if (!w.darkStart || !w.darkEnd) {
      nights.push({ date, darkHours: 0, usableHours: 0, maxAlt: r1(Math.max(...[0, 6, 12, 18].map((h) => sky.altAz(site, raHours, decDeg, new Date(when.getTime() + h * 3600e3)).altitude))), midAlt: null });
      continue;
    }
    const a = w.darkStart.getTime();
    const b = w.darkEnd.getTime();
    let above = 0;
    let maxAlt = -90;
    for (let t = a; t < b; t += SAMPLE_MS) {
      const aa = sky.altAz(site, raHours, decDeg, new Date(t));
      if (aa.altitude > maxAlt) maxAlt = aa.altitude;
      if (aa.altitude >= limit(aa.azimuth)) above += Math.min(SAMPLE_MS, b - t);
    }
    const mid = sky.altAz(site, raHours, decDeg, new Date((a + b) / 2)).altitude;
    nights.push({ date, darkHours: r1((b - a) / 3600e3), usableHours: r1(above / 3600e3), maxAlt: r1(maxAlt), midAlt: r1(mid) });
  }

  const byMonth = new Map<string, SeasonMonth>();
  for (const n of nights) {
    const key = monthLabel(n.date);
    const m = byMonth.get(key) ?? { month: key, usableHours: 0, maxAlt: -90, usableNights: 0, nights: 0 };
    m.usableHours += n.usableHours;
    m.maxAlt = Math.max(m.maxAlt, n.maxAlt);
    m.nights++;
    if (n.usableHours * 60 >= USABLE_MIN) m.usableNights++;
    byMonth.set(key, m);
  }
  // a month's hours are per night, averaged over the nights sampled in it
  const months = [...byMonth.values()].map((m) => ({ ...m, usableHours: r1(m.usableHours / m.nights), maxAlt: r1(m.maxAlt) }));
  const peak = Math.max(0, ...months.map((m) => m.usableHours));
  const bestMonths = peak > 0 ? months.filter((m) => m.usableHours >= peak * 0.8).map((m) => m.month) : [];

  const usable = nights.map((n) => n.usableHours * 60 >= USABLE_MIN);
  const usableAllYear = usable.length > 0 && usable.every(Boolean);
  let seasonStart: string | null = null;
  let seasonEnd: string | null = null;
  if (!usableAllYear && usable.some(Boolean)) {
    // the season is the longest run of usable nights, wrapping round the year
    const n = usable.length;
    let best = { start: 0, len: 0 };
    for (let i = 0; i < n; i++) {
      if (!usable[i] || usable[(i - 1 + n) % n]) continue;
      let len = 0;
      while (len < n && usable[(i + len) % n]) len++;
      if (len > best.len) best = { start: i, len };
    }
    // a run that wraps round the sampled year is the one tonight is in: it started a year before its sampled start
    seasonStart = best.start + best.len > n ? yearBefore(nights[best.start].date) : nights[best.start].date;
    seasonEnd = nights[(best.start + best.len - 1) % n].date;
  }
  const withMid = nights.filter((n) => n.midAlt !== null);
  const top = withMid.length ? withMid.reduce((p, n) => (n.midAlt! > p.midAlt! ? n : p)) : null;
  const transitAltitude = r1(90 - Math.abs(site.lat - decDeg));
  return {
    minAltitude: o.minAltitude,
    horizon: o.horizon?.summary ?? null,
    transitAltitude,
    circumpolar: site.lat >= 0 ? decDeg >= 90 - site.lat : decDeg <= -90 - site.lat,
    neverRises: transitAltitude <= 0,
    months,
    bestMonths,
    seasonStart,
    seasonEnd,
    usableAllYear,
    inSeasonNow: usable[0] ?? false,
    bestNight: top && top.midAlt! > 0 ? { date: top.date, altitude: top.midAlt!, usableHours: top.usableHours } : null,
    tonight: nights[0] ?? null,
    nights,
  };
}
