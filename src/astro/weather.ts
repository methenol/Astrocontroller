/**
 * Local weather and observability: Open-Meteo's hourly forecast and 7Timer's seeing and
 * transparency, combined into an hourly 0–100 observability score and tonight's best window.
 * Both providers are fetched with retries under a deadline and the result is cached (weather/service.ts).
 */
import { nightWindow, fmtTime, type Site } from './sky.js';
import { WeatherService, type CurrentWeather, type Forecast } from './weather/service.js';
import { rate, type HourForecast } from './weather/score.js';
import { config } from '../config.js';

export { type HourForecast, type Rating, scoreHour } from './weather/score.js';
export { type Forecast, type CurrentWeather, WeatherService } from './weather/service.js';

/** A night with no darkness known (polar summer) is taken to last this long from now. */
const DEFAULT_NIGHT_MS = 10 * 3600e3;
/** An hour at or above this score is clear enough to belong to the best window. */
const CLEAR_SCORE = 60;

const service = new WeatherService({ units: config.units });

export function forecast(site: Site, tz: string): Promise<Forecast> {
  return service.forecast(site, tz);
}

export interface Window {
  from: string;
  to: string;
  hours: number;
  avgScore: number;
}

export interface Tonight {
  verdict: string;
  averageScore: number;
  bestWindow: Window | null;
  commonIssues: string[];
  current: CurrentWeather;
  darkness: { start: string | null; end: string | null };
  hours: HourForecast[];
  fetchedAt: string;
  ageMin: number;
  stale: boolean;
  staleError?: string;
}

const HOUR_MS = 3600e3;

/** The longest run of clear consecutive hours (the first one on a tie); a missing hour ends a run. */
export function bestWindow(hours: HourForecast[], tz: string): Window | null {
  let best: Window | null = null;
  let run: HourForecast[] = [];
  const at = (h: HourForecast) => new Date(h.time).getTime();
  const close = () => {
    if (run.length && (!best || run.length > best.hours)) {
      const last = run[run.length - 1];
      best = {
        from: run[0].local,
        to: fmtTime(new Date(at(last) + HOUR_MS), tz) ?? '',
        hours: run.length,
        avgScore: Math.round(run.reduce((a, h) => a + h.score, 0) / run.length),
      };
    }
    run = [];
  };
  for (const h of hours) {
    if (run.length && at(h) - at(run[run.length - 1]) > HOUR_MS) close();
    if (h.score >= CLEAR_SCORE) run.push(h);
    else close();
  }
  close();
  return best;
}

/** Tonight's verdict: dark hours with scores, the best contiguous window, and a one-line summary. */
export async function tonight(site: Site, tz: string, weather: Pick<WeatherService, 'forecast'> = service): Promise<Tonight> {
  const f = await weather.forecast(site, tz);
  const w = nightWindow(site);
  const start = w.darkStart ?? new Date();
  const end = w.darkEnd ?? new Date(start.getTime() + DEFAULT_NIGHT_MS);
  const night = f.hours.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= start.getTime() - HOUR_MS && t <= end.getTime();
  });
  const b = bestWindow(night, tz);
  const avg = night.length ? Math.round(night.reduce((a, h) => a + h.score, 0) / night.length) : 0;
  const issues = [...new Set(night.flatMap((h) => h.issues.map((i) => i.replace(/\s*\(.*\)$/, ''))))];
  const verdict = !night.length
    ? 'no forecast for tonight'
    : b
      ? `${rate(avg)} night overall (avg ${avg}/100); best clear window ${b.from} → ${b.to} (${b.hours} h, avg ${b.avgScore})`
      : `poor night (avg ${avg}/100) — no hour with good observability`;
  return {
    verdict,
    averageScore: avg,
    bestWindow: b,
    commonIssues: issues,
    current: f.current,
    darkness: { start: fmtTime(start, tz), end: fmtTime(end, tz) },
    hours: night,
    fetchedAt: f.fetchedAt,
    ageMin: f.ageMin,
    stale: f.stale,
    staleError: f.staleError,
  };
}

/** What the forecast says about one hour, in the terms the planner scores against. */
export interface HourConditions {
  /** observability 0–100 (clouds, rain, wind, dew, transparency, haze) */
  observability: number;
  /** 7Timer seeing index (1 best … 8 worst) when that provider answered */
  seeingIdx?: number;
  /** 7Timer transparency index (1 best … 8 worst) when that provider answered */
  transparencyIdx?: number;
  windKmh?: number;
  gustKmh?: number;
}

/**
 * The hourly forecast as a lookup, for scoring each target against the hours it is actually up:
 * observability, the seeing and transparency indices, and the wind. Null when the forecast
 * cannot be fetched (offline in the field), which leaves the plan geometric.
 */
export async function conditionsAt(site: Site, tz: string): Promise<((t: Date) => HourConditions | undefined) | null> {
  try {
    const { hours } = await forecast(site, tz);
    const byHour = new Map<number, HourConditions>(
      hours.map((h) => [
        Math.floor(new Date(h.time).getTime() / HOUR_MS),
        { observability: h.score, seeingIdx: h.seeingIdx, transparencyIdx: h.transparencyIdx, windKmh: h.windKmh, gustKmh: h.gustKmh },
      ]),
    );
    return (t: Date) => byHour.get(Math.floor(t.getTime() / HOUR_MS));
  } catch {
    return null;
  }
}
