/**
 * The night safety report: can the telescope stay outside from sunset to sunrise? Each hour is read
 * for what harms the equipment rather than what spoils the image: precipitation of any kind,
 * thunderstorms, gusts that can topple a tripod, cold past the operating range, frost and
 * condensation. Built on the same cached Open-Meteo forecast as the observability score.
 */
import { nightWindow, fmtTime, type Site } from '../sky.js';
import type { Forecast } from './service.js';
import type { HourForecast } from './score.js';
import { isFreezing, isSnow, isThunder, type GuardSettings } from './guard.js';
import { unitFormat, type UnitFormat } from '../../util/units.js';

export type Risk = 'safe' | 'caution' | 'danger';

export interface SafetyHour {
  time: string;
  local: string;
  risk: Risk;
  hazards: Array<{ risk: Exclude<Risk, 'safe'>; text: string }>;
  temperatureC: number;
  dewSpreadC: number;
  humidity: number;
  precipProbability: number;
  precipMm: number;
  gustKmh: number;
  windKmh: number;
  cloudTotal: number;
  weatherCode: number | null;
}

export interface NightSafety {
  verdict: string;
  risk: Risk;
  /** the first hour the equipment should be inside by, when there is one */
  bringInBy: string | null;
  /** the report, one line per subject */
  report: Array<{ subject: string; text: string; risk: Risk }>;
  hours: SafetyHour[];
  night: { from: string | null; to: string | null };
  limits: Pick<GuardSettings, 'gustKmh' | 'probabilityPct' | 'minTempC'>;
  fetchedAt: string;
  ageMin: number;
  stale: boolean;
  staleError?: string;
}

const HOUR_MS = 3600e3;
/** The forecast cannot see past this many hours; a night without a sunrise is taken to last this long. */
const DEFAULT_NIGHT_MS = 12 * HOUR_MS;
/** Gusts at this fraction of the limit already rock a light mount. */
const GUST_CAUTION = 0.7;
/** Hourly precipitation chance under the alarm limit but worth a cover. */
const RAIN_CAUTION_PCT = 20;
/** An hour expecting this much is wet whatever the chance says. */
const RAIN_DANGER_MM = 0.2;
/** CAPE (J/kg) from which showers can grow into thunderstorms, with this much precipitation chance. */
const STORM_CAPE = 1000;
const STORM_CAPE_PCT = 20;
/** Dew-point spread (°C) under which water condenses on anything that cools by radiating to the sky. */
const CONDENSE_SPREAD_C = 1;
const DEW_SPREAD_C = 2.5;
const SATURATED_RH = 97;
/** Visibility (km) under which it is fog: everything outside gets wet. */
const FOG_KM = 1;

/** The hazards of one hour, worst first. */
export function hourHazards(h: HourForecast, s: Pick<GuardSettings, 'gustKmh' | 'probabilityPct' | 'minTempC'>, u: UnitFormat = unitFormat('metric')): SafetyHour['hazards'] {
  const out: SafetyHour['hazards'] = [];
  const code = h.weatherCode ?? null;
  const mm = h.precipMm ?? 0;
  const p = h.precipProbability ?? 0;
  if (isThunder(code)) out.push({ risk: 'danger', text: 'thunderstorm' });
  else if ((h.capeJkg ?? 0) >= STORM_CAPE && p >= STORM_CAPE_PCT) out.push({ risk: 'caution', text: `storms possible (CAPE ${Math.round(h.capeJkg ?? 0)} J/kg, ${p}%)` });
  if (isSnow(code) || (h.snowfallCm ?? 0) > 0) out.push({ risk: 'danger', text: `snow${h.snowfallCm ? ` ${u.snow(h.snowfallCm)}` : ''}` });
  else if (isFreezing(code)) out.push({ risk: 'danger', text: 'freezing rain' });
  else if (p >= s.probabilityPct || mm >= RAIN_DANGER_MM) out.push({ risk: 'danger', text: `${(h.showersMm ?? 0) > 0 ? 'showers' : 'rain'} likely (${p}%${mm > 0 ? `, ${u.precip(mm, 1)}` : ''})` });
  else if (p >= RAIN_CAUTION_PCT || mm > 0) out.push({ risk: 'caution', text: `chance of rain (${p}%${mm > 0 ? `, ${u.precip(mm, 1)}` : ''})` });
  if (h.gustKmh >= s.gustKmh) out.push({ risk: 'danger', text: `gusts ${u.speed(h.gustKmh)}` });
  else if (h.gustKmh >= s.gustKmh * GUST_CAUTION) out.push({ risk: 'caution', text: `gusty ${u.speed(h.gustKmh)}` });
  if (h.temperatureC <= s.minTempC) out.push({ risk: 'danger', text: `${u.temp(h.temperatureC)}, below the ${u.temp(s.minTempC)} limit` });
  else if (h.temperatureC <= 0 && h.dewSpreadC <= DEW_SPREAD_C) out.push({ risk: 'caution', text: `frost (${u.temp(h.temperatureC)})` });
  else if (h.temperatureC <= 0) out.push({ risk: 'caution', text: `below freezing (${u.temp(h.temperatureC)}): batteries drain fast, charging pauses` });
  if (h.visibilityKm !== null && h.visibilityKm < FOG_KM) out.push({ risk: 'caution', text: `fog (visibility ${u.dist(h.visibilityKm)})` });
  else if (h.temperatureC > 0 && (h.dewSpreadC < CONDENSE_SPREAD_C || h.humidity >= SATURATED_RH)) out.push({ risk: 'caution', text: `condensation (RH ${Math.round(h.humidity)}%, spread ${u.tempDelta(h.dewSpreadC)})` });
  return out.sort((a, b) => (a.risk === b.risk ? 0 : a.risk === 'danger' ? -1 : 1));
}

const worst = (rs: Risk[]): Risk => (rs.includes('danger') ? 'danger' : rs.includes('caution') ? 'caution' : 'safe');
const hhmm = (local: string) => local.split(', ').pop() ?? local;

/** Consecutive hours sharing a property as "21:00–23:00" runs (each hour ends an hour after it starts). */
function runs(hours: SafetyHour[], pick: (h: SafetyHour) => boolean, tz: string): string[] {
  const out: string[] = [];
  let start: SafetyHour | null = null;
  let last: SafetyHour | null = null;
  const close = () => {
    if (start && last) out.push(`${hhmm(start.local)}–${hhmm(fmtTime(new Date(new Date(last.time).getTime() + HOUR_MS), tz) ?? '')}`);
    start = last = null;
  };
  for (const h of hours) {
    if (pick(h) && last && new Date(h.time).getTime() - new Date(last.time).getTime() <= HOUR_MS) last = h;
    else if (pick(h)) {
      close();
      start = last = h;
    } else close();
  }
  close();
  return out;
}

function maxBy<T>(xs: T[], f: (x: T) => number): T | undefined {
  return xs.reduce<T | undefined>((m, x) => (m === undefined || f(x) > f(m) ? x : m), undefined);
}

/** The report for tonight (or the rest of this night) from a forecast. */
export function nightSafety(f: Forecast, site: Site, tz: string, limits: Pick<GuardSettings, 'gustKmh' | 'probabilityPct' | 'minTempC'>, now = new Date(), u: UnitFormat = unitFormat('metric')): NightSafety {
  const w = nightWindow(site, now);
  const sunset = w.sunset ?? now;
  // a night already under way is reported from the current hour
  const from = new Date(Math.max(sunset.getTime(), Math.floor(now.getTime() / HOUR_MS) * HOUR_MS));
  const to = w.sunrise && w.sunrise > from ? w.sunrise : new Date(from.getTime() + DEFAULT_NIGHT_MS);
  const hours: SafetyHour[] = f.hours
    .filter((h) => {
      const t = new Date(h.time).getTime();
      return t >= from.getTime() && t < to.getTime();
    })
    .map((h) => {
      const hazards = hourHazards(h, limits, u);
      return {
        time: h.time,
        local: h.local,
        risk: worst(hazards.map((x) => x.risk)),
        hazards,
        temperatureC: h.temperatureC,
        dewSpreadC: h.dewSpreadC,
        humidity: h.humidity,
        precipProbability: h.precipProbability,
        precipMm: h.precipMm,
        gustKmh: h.gustKmh,
        windKmh: h.windKmh,
        cloudTotal: h.cloudTotal,
        weatherCode: h.weatherCode ?? null,
      };
    });

  const report: NightSafety['report'] = [];
  const stamp = { fetchedAt: f.fetchedAt, ageMin: f.ageMin, stale: f.stale, staleError: f.staleError };
  const night = { from: fmtTime(from, tz), to: fmtTime(to, tz) };
  if (!hours.length) return { verdict: 'no forecast for tonight', risk: 'caution', bringInBy: null, report, hours, night, limits, ...stamp };

  const has = (h: SafetyHour, word: RegExp) => h.hazards.some((x) => word.test(x.text));
  // precipitation
  const wet = runs(hours, (h) => h.hazards.some((x) => x.risk === 'danger' && /rain|showers|snow/.test(x.text)), tz);
  const maybe = runs(hours, (h) => has(h, /chance of rain/), tz);
  const totalMm = Math.round(hours.reduce((a, h) => a + (h.precipMm ?? 0), 0) * 10) / 10;
  const wettest = maxBy(hours, (h) => h.precipProbability)!;
  report.push({
    subject: 'Precipitation',
    risk: wet.length ? 'danger' : maybe.length ? 'caution' : 'safe',
    text: wet.length
      ? `Expected ${wet.join(', ')} (${u.precip(totalMm, 1)} in all, up to ${wettest.precipProbability}% at ${hhmm(wettest.local)}).`
      : maybe.length
        ? `Small chance ${maybe.join(', ')} (up to ${wettest.precipProbability}%); a cover or the Rain Guard is wise.`
        : `Dry: the chance stays at or under ${wettest.precipProbability}% all night.`,
  });
  // storms
  const thunder = runs(hours, (h) => has(h, /thunderstorm/), tz);
  const unstable = runs(hours, (h) => has(h, /storms possible/), tz);
  if (thunder.length || unstable.length) {
    report.push({ subject: 'Storms', risk: thunder.length ? 'danger' : 'caution', text: thunder.length ? `Thunderstorms forecast ${thunder.join(', ')}.` : `The air is unstable ${unstable.join(', ')}: showers could grow into storms the hourly forecast does not show.` });
  }
  // wind
  const gustiest = maxBy(hours, (h) => h.gustKmh)!;
  const windy = runs(hours, (h) => h.gustKmh >= limits.gustKmh, tz);
  report.push({
    subject: 'Wind',
    risk: windy.length ? 'danger' : gustiest.gustKmh >= limits.gustKmh * GUST_CAUTION ? 'caution' : 'safe',
    text: `${windy.length ? `Gusts over the ${u.speed(limits.gustKmh)} limit ${windy.join(', ')}; strongest` : 'Strongest gust'} ${u.speed(gustiest.gustKmh)} at ${hhmm(gustiest.local)} (wind ${u.speed(gustiest.windKmh)}).`,
  });
  // temperature
  const coldest = maxBy(hours, (h) => -h.temperatureC)!;
  const first = hours[0];
  const last = hours[hours.length - 1];
  report.push({
    subject: 'Temperature',
    risk: coldest.temperatureC <= limits.minTempC ? 'danger' : coldest.temperatureC <= 0 ? 'caution' : 'safe',
    text: `${u.temp(first.temperatureC)} at ${hhmm(first.local)}, low ${u.temp(coldest.temperatureC)} at ${hhmm(coldest.local)}, ${u.temp(last.temperatureC)} by ${hhmm(last.local)}.${coldest.temperatureC <= 0 ? ' Below freezing: batteries lose capacity and charging pauses.' : ''}`,
  });
  // moisture
  const dampest = maxBy(hours, (h) => -h.dewSpreadC)!;
  const damp = runs(hours, (h) => has(h, /condensation|frost|fog/), tz);
  report.push({
    subject: 'Dew & frost',
    risk: damp.length ? 'caution' : 'safe',
    text: damp.length
      ? `${hours.some((h) => has(h, /frost/)) ? 'Frost' : hours.some((h) => has(h, /fog/)) ? 'Fog and condensation' : 'Condensation'} likely ${damp.join(', ')} (dew-point spread down to ${u.tempDelta(dampest.dewSpreadC)}, RH ${Math.round(dampest.humidity)}%): expect water on the optics and the body.`
      : `No condensation expected: the dew-point spread stays at ${u.tempDelta(dampest.dewSpreadC)} or more.`,
  });

  const risk = worst(hours.map((h) => h.risk));
  const firstDanger = hours.find((h) => h.risk === 'danger');
  const dangerWhy = firstDanger?.hazards.filter((x) => x.risk === 'danger').map((x) => x.text).join(', ');
  const cautions = [...new Set(hours.flatMap((h) => h.hazards.filter((x) => x.risk === 'caution').map((x) => x.text.replace(/\s*\(.*\)$/, '').replace(/:.*$/, ''))))];
  const verdict = firstDanger
    ? firstDanger === hours[0]
      ? `Not safe to leave out now: ${dangerWhy}.`
      : `Bring the telescope in by ${hhmm(firstDanger.local)}: ${dangerWhy} from then.`
    : risk === 'caution'
      ? `Safe to leave out, with care: ${cautions.slice(0, 3).join(', ')}.`
      : `Safe to leave out all night (${night.from} → ${night.to}).`;
  return { verdict, risk, bringInBy: firstDanger ? firstDanger.local : null, report, hours, night, limits, ...stamp };
}
