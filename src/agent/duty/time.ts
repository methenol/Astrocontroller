/** Times for the duty loop: its end time ("until"), the sample interval, and how both are shown. */
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';

/** The sample interval's bounds (duty next_check and the configured interval). */
export const MIN_INTERVAL_S = 30;
export const MAX_INTERVAL_S = 900;
const DAY_MS = 86_400_000;

export const clampInterval = (s: number) => Math.max(MIN_INTERVAL_S, Math.min(MAX_INTERVAL_S, Math.round(Number.isFinite(s) ? s : config.agent.dutyIntervalS)));

export function fmtMin(ms: number): string {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** HH:MM in the observer's timezone. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: config.observer.timezone, hour: '2-digit', minute: '2-digit' });
}

/**
 * A duty's end: 'dawn' (astronomical dawn of the current/next night), 'none'/empty (no end),
 * 'HH:MM' local (its next occurrence), or a local/ISO date-time. Always in the future.
 */
export function parseUntil(v: string | undefined, now: number, site: () => sky.Site): { at: number; label: string } | undefined {
  const s = v?.trim();
  if (!s || s === 'none') return undefined;
  const tz = config.observer.timezone;
  if (s === 'dawn') {
    const w = sky.nightWindow(site(), new Date(now));
    const dawn = w.astroDawn ?? w.darkEnd;
    if (!dawn) throw new Error('no astronomical dawn found for this location');
    if (dawn.getTime() <= now) throw new Error('no astronomical dawn ahead for this location');
    return { at: dawn.getTime(), label: `astronomical dawn ${sky.fmtTime(dawn, tz)}` };
  }
  let at: number;
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const [hh, mm] = [Number(hm[1]), Number(hm[2])];
    if (hh > 23 || mm > 59) throw new Error(`end time "${v}" is not a time of day`);
    // that time today, else tomorrow: both as local wall-clock times, so a DST change between them does not shift it
    const onDay = (ms: number) => sky.parseLocal(`${new Date(ms).toLocaleDateString('en-CA', { timeZone: tz })}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz).getTime();
    const today = onDay(now);
    at = today > now ? today : onDay(now + DAY_MS);
  } else {
    at = sky.parseLocal(s, tz).getTime();
  }
  if (!Number.isFinite(at) || at <= now) throw new Error(`end time "${v}" is not in the future`);
  return { at, label: new Date(at).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }) };
}
