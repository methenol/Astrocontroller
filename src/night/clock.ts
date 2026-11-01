/** Which night a moment belongs to, and the plan's window in it. */
import * as sky from '../astro/sky.js';
import { config } from '../config.js';
import type { PlanSettings } from './program.js';

/** The night a moment belongs to: the local date of its sunset (a 02:00 moment is the evening before's night). */
export function nightKey(site: sky.Site, at: Date, tz = config.observer.timezone): string {
  const w = sky.nightWindow(site, at);
  return sky.localDate(w.sunset ?? w.darkStart ?? at, tz);
}

/** The local date of a library session stamp ("2026-10-28T01:12:00", the scope's wall clock) as a night key: before noon is the previous evening. */
export function nightOfStamp(stamp: string): string | null {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
  if (!m) return null;
  if (Number(m[2]) >= 12) return m[1];
  const d = new Date(`${m[1]}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface PlanWindow {
  night: string;
  start: Date;
  end: Date;
  sunset: Date | null;
  astroDusk: Date | null;
  astroDawn: Date | null;
  sunrise: Date | null;
}

/** "HH:MM" on the evening (≥ 12:00) or the morning after (< 12:00) of a night. */
function clockOnNight(night: string, hm: string, tz: string): Date {
  const [h, m] = hm.split(':').map(Number);
  let date = night;
  if (h < 12) {
    const d = new Date(`${night}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  return sky.parseLocal(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, tz);
}

/**
 * The plan's window for the night `at` belongs to (or the next one, by day): from the settings'
 * start event to its end event, with their offsets. Without astronomical darkness (high summer at
 * high latitude) the dark window falls back to nautical, as nightWindow does.
 */
export function planWindow(site: sky.Site, at: Date, s: Pick<PlanSettings, 'windowStart' | 'windowEnd' | 'startOffsetMin' | 'endOffsetMin'>, tz = config.observer.timezone): PlanWindow {
  const w = sky.nightWindow(site, at);
  const night = sky.localDate(w.sunset ?? w.darkStart ?? at, tz);
  const pick = (v: string, fallback: Date | null): Date | null => {
    switch (v) {
      case 'astro-dusk':
        return w.astroDusk ?? w.darkStart;
      case 'nautical-dusk':
        return w.nauticalDusk ?? w.darkStart;
      case 'sunset':
        return w.sunset;
      case 'astro-dawn':
        return w.astroDawn ?? w.darkEnd;
      case 'nautical-dawn':
        return w.nauticalDawn ?? w.darkEnd;
      case 'sunrise':
        return w.sunrise;
      default:
        return /^\d{1,2}:\d{2}$/.test(v) ? clockOnNight(night, v, tz) : fallback;
    }
  };
  const s0 = pick(s.windowStart, w.darkStart) ?? new Date(at);
  const e0 = pick(s.windowEnd, w.darkEnd) ?? new Date(s0.getTime() + 8 * 3600e3);
  const start = new Date(s0.getTime() + s.startOffsetMin * 60e3);
  let end = new Date(e0.getTime() + s.endOffsetMin * 60e3);
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 3600e3);
  return { night, start, end, sunset: w.sunset, astroDusk: w.astroDusk, astroDawn: w.astroDawn, sunrise: w.sunrise };
}

/** "21:05" in the observer's zone. */
export function hm(at: Date | number | null | undefined, tz = config.observer.timezone): string {
  if (at === null || at === undefined) return '–';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

/** "1 h 20 min", "35 min". */
export function dur(min: number): string {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}
