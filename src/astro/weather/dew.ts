/**
 * Dew risk for the dew heater's Auto mode: is there any chance of dew on the optics in the hour
 * under way or the next one?
 *
 * Deliberately generous. A heater left on costs a little power; a heater left off when dew forms
 * costs the night (and a fogged lens takes an hour to clear even once the heater is on). The
 * optics radiate to a clear sky and run several degrees below the air, so dew forms on them well
 * before the air reaches its dew point: the spread threshold here is wider than the score's
 * "dew likely" one (score.ts), and high humidity or fog alone is enough.
 */
import type { CurrentWeather } from './service.js';
import type { HourForecast } from './score.js';
import { unitFormat, type UnitFormat } from '../../util/units.js';

/** Air within this of its dew point (°C) can put dew on optics cooling to the sky. */
export const DEW_AUTO_SPREAD_C = 5;
/** Relative humidity (%) at which dew is possible whatever the spread says. */
export const DEW_AUTO_HUMIDITY = 85;
const HOUR_MS = 3600e3;
const isFog = (c: number | null | undefined) => c === 45 || c === 48;

export interface DewRisk {
  /** true when dew is possible, or when the forecast cannot say (the heater goes on either way) */
  risk: boolean;
  /** why, for the UI and the log */
  reason: string;
}

interface Reading {
  label: string;
  spread: number | null;
  humidity: number | null;
  code?: number | null;
}

function judge(r: Reading, u: UnitFormat): string | null {
  if (isFog(r.code)) return `fog forecast ${r.label}`;
  if (r.spread != null && r.spread <= DEW_AUTO_SPREAD_C) return `dew-point spread ${u.tempDelta(r.spread)} ${r.label}`;
  if (r.humidity != null && r.humidity >= DEW_AUTO_HUMIDITY) return `humidity ${Math.round(r.humidity)}% ${r.label}`;
  return null;
}

/**
 * The dew risk over the hour under way and the next one, from the hourly forecast and the current
 * conditions. With neither of those hours in the forecast the answer is a risk: not knowing is not
 * a reason to leave the heater off.
 */
export function dewRisk(hours: HourForecast[], current: CurrentWeather | null, now: number, u: UnitFormat = unitFormat('metric')): DewRisk {
  const readings: Reading[] = [];
  if (current && current.temperatureC != null && current.dewPointC != null) {
    readings.push({ label: 'now', spread: current.temperatureC - current.dewPointC, humidity: current.humidity ?? null });
  } else if (current?.humidity != null) {
    readings.push({ label: 'now', spread: null, humidity: current.humidity });
  }
  // an hourly value is the instant at the top of its hour: the hour under way is bracketed by the
  // sample at its start and the one at its end, the next hour by that one and the one after
  const near = hours.filter((h) => {
    const t = Date.parse(h.time);
    return t > now - HOUR_MS && t <= now + 2 * HOUR_MS;
  });
  for (const h of near) readings.push({ label: `at ${h.local}`, spread: h.dewSpreadC, humidity: h.humidity, code: h.weatherCode });
  if (!near.length) return { risk: true, reason: 'the forecast has no hours for now: on to be safe' };
  for (const r of readings) {
    const why = judge(r, u);
    if (why) return { risk: true, reason: why };
  }
  const minSpread = Math.min(...readings.map((r) => r.spread ?? Infinity));
  return { risk: false, reason: `no dew risk this hour or next (smallest dew-point spread ${u.tempDelta(Math.round(minSpread * 10) / 10)})` };
}
