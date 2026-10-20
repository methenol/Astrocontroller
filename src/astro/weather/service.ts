/**
 * The forecast for a site, combined from both providers into hourly scores, and cached so that a
 * bad second on a field connection does not take the Tonight tab's weather down with it.
 */
import { logger, errMsg } from '../../log.js';
import { bodyAlt, fmtTime, type Site } from '../sky.js';
import type { Fetch } from './http.js';
import { DEFAULT_URLS, fetchOpenMeteo, fetchSevenTimer, type AstroMap, type OpenMeteo, type ProviderUrls } from './providers.js';
import { rate, scoreHour, SEEING, TRANSPARENCY, type HourForecast } from './score.js';

const log = logger('weather');

export interface CurrentWeather {
  cloudCover?: number | null;
  temperatureC?: number | null;
  humidity?: number | null;
  dewPointC?: number | null;
  windKmh?: number | null;
  gustKmh?: number | null;
  precipitationMm?: number | null;
  at: string | null;
}

export interface Forecast {
  hours: HourForecast[];
  current: CurrentWeather;
  /** when a fetch from the providers last succeeded (ISO UTC) */
  fetchedAt: string;
  /** minutes since then */
  ageMin: number;
  /** older than FRESH_MIN at the moment it was served: a refresh failed or has not run yet */
  stale: boolean;
  /** why the last refresh failed, when it did */
  staleError?: string;
}

/** A forecast is used as-is for this long; the UI polls faster and gets the cache (see forecast()). */
export const FRESH_MIN = 15;
/** Past this the numbers are not worth showing: the providers have been unreachable all this time. */
export const STALE_HOURS = 12;
/** After a failed refresh, nothing new is attempted for this long (a dead connection is not hurried). */
export const RETRY_COOLDOWN_MS = 60e3;
/** Seeing and transparency are a bonus: tonight's clouds wait this long for them after Open-Meteo answered. */
const SEEING_WAIT_MS = 6000;
/** A 7Timer sample covers the hours within this of its time. */
const SEEING_REACH_MS = 2 * 3600e3;
/** Astronomical darkness: the Sun this far below the horizon. */
const DARK_SUN_ALT = -18;

type Data = { hours: HourForecast[]; current: CurrentWeather };
interface Held {
  key: string;
  at: number;
  data: Data;
  err?: string;
}

/** 7Timer did not answer: the seeing and transparency columns stay blank, nothing else changes. */
const NO_SEEING: AstroMap = new Map();

export interface WeatherOptions {
  fetch?: Fetch;
  urls?: ProviderUrls;
  now?: () => number;
}

export class WeatherService {
  private cache: Held | null = null;
  /**
   * The refresh in flight, for one site. The Tonight tab asks for /weather and /plan at the same
   * moment and both need the forecast, so concurrent callers must share one fetch rather than each
   * one its own — but only callers of the same site, since the location can move under us.
   */
  private flight: { key: string; promise: Promise<Forecast> } | null = null;
  private nextTryAt = 0;
  private readonly urls: ProviderUrls;
  private readonly now: () => number;

  constructor(private readonly opts: WeatherOptions = {}) {
    this.urls = opts.urls ?? DEFAULT_URLS;
    this.now = opts.now ?? Date.now;
  }

  private stamp(entry: Held): Forecast {
    const ageMin = Math.round((this.now() - entry.at) / 60e3);
    return { ...entry.data, fetchedAt: new Date(entry.at).toISOString(), ageMin, stale: ageMin > FRESH_MIN, staleError: entry.err };
  }

  /**
   * The forecast for this site, from the cache when the cache is good enough.
   *
   * Three things keep the Tonight tab from going blank, which is what a single attempt with a short
   * timeout used to do whenever the field connection hiccuped:
   *  - concurrent callers share one refresh (the tab asks for /weather and /plan together);
   *  - a refresh that fails leaves the previous forecast in place — one from an hour ago still says
   *    whether to set up, a blank card says nothing — flagged `stale` so nobody mistakes it for live;
   *  - a forecast past its freshness is served immediately while it is refreshed in the background,
   *    so opening the tab never waits on the network for numbers it already has.
   */
  forecast(site: Site, tz: string): Promise<Forecast> {
    // the hours carry local times: a forecast formatted for another zone is not this one
    const key = `${site.lat.toFixed(3)},${site.lon.toFixed(3)},${tz}`;
    const held = this.cache?.key === key ? this.cache : null;
    const heldMin = held ? (this.now() - held.at) / 60e3 : Infinity;
    const usable = held !== null && heldMin < STALE_HOURS * 60;
    if (held && heldMin < FRESH_MIN) return Promise.resolve(this.stamp(held));
    if (this.flight?.key === key) return usable ? Promise.resolve(this.stamp(held)) : this.flight.promise;
    // After a failed refresh nothing new is attempted for RETRY_COOLDOWN_MS: a duty loop and a phone
    // poll would otherwise each start their own attempt against a connection that is simply down.
    if (usable && this.now() < this.nextTryAt) return Promise.resolve(this.stamp(held));

    const p: Promise<Forecast> = this.fetchForecast(site, tz).then(
      (data) => {
        // a refresh for a site we have since moved away from neither replaces that site's forecast nor its retry timing
        const current = this.flight?.promise === p;
        if (current) {
          this.flight = null;
          this.nextTryAt = 0;
        }
        const entry: Held = { key, at: this.now(), data };
        if (current || !this.cache || this.cache.key === key) this.cache = entry;
        return this.stamp(entry);
      },
      (err: unknown) => {
        if (this.flight?.promise === p) {
          this.flight = null;
          this.nextTryAt = this.now() + RETRY_COOLDOWN_MS;
        }
        const why = errMsg(err);
        if (usable) {
          log.warn(`forecast refresh failed (${why}); keeping the forecast from ${Math.round(heldMin)} min ago`);
          // Kept on the entry itself: every later read of this copy says why it is not current, not
          // only the one call that happened to be waiting when the refresh gave up.
          held.err = why;
          return this.stamp(held);
        }
        throw new Error(`weather fetch failed: ${why}${held ? ` (the cached forecast is ${Math.round(heldMin)} min old, past ${STALE_HOURS} h)` : ' (nothing fetched yet this session)'}`);
      },
    );
    this.flight = { key, promise: p };
    if (usable) {
      p.catch(() => undefined);
      return Promise.resolve(this.stamp(held));
    }
    return p;
  }

  private async fetchForecast(site: Site, tz: string): Promise<Data> {
    // 7Timer is best-effort (it is slow at times) and was awaited after Open-Meteo, so a laggy
    // seeing/transparency server added its whole wait to every forecast. Started here instead, and
    // its failure costs nothing but the seeing and transparency columns.
    const astroP = fetchSevenTimer(site, this.urls, this.opts.fetch).catch((err: unknown) => {
      log.debug(`7timer unavailable: ${errMsg(err)}`);
      return NO_SEEING;
    });
    const om = await fetchOpenMeteo(site, this.urls, this.opts.fetch);
    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<AstroMap>((resolve) => {
      timer = setTimeout(() => resolve(NO_SEEING), SEEING_WAIT_MS);
      timer.unref();
    });
    const astro = await Promise.race([astroP, giveUp]);
    clearTimeout(timer);
    return combine(site, tz, om, astro);
  }
}

/** The nearest 7Timer sample within SEEING_REACH_MS of t. */
function astroAt(astro: AstroMap, t: number): { seeing: number; transparency: number } | undefined {
  let best: { seeing: number; transparency: number } | undefined;
  let bestD = Infinity;
  for (const [k, v] of astro) {
    const d = Math.abs(k - t);
    if (d < bestD && d <= SEEING_REACH_MS) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

/** Open-Meteo's zone-less UTC time ("2026-10-12T20:00") in local time, or null when it is not a time. */
function utcTime(s: string, tz: string): string | null {
  const d = new Date(`${s}Z`);
  return Number.isNaN(d.getTime()) ? null : fmtTime(d, tz);
}

/** Both providers' answers as scored hours; an hour without cloud, temperature or dew point is left out. */
export function combine(site: Site, tz: string, om: OpenMeteo, astro: AstroMap): Data {
  const H = om.hourly;
  const hours: HourForecast[] = [];
  for (let i = 0; i < H.time.length; i++) {
    const cloudTotal = H.cloud_cover[i];
    const temp = H.temperature_2m[i];
    const dew = H.dew_point_2m[i];
    if (cloudTotal == null || temp == null || dew == null) continue;
    const t = new Date(`${H.time[i]}Z`);
    if (Number.isNaN(t.getTime())) continue;
    const sunAlt = bodyAlt(site, 'Sun', t);
    const vis = H.visibility?.[i];
    const base = {
      time: t.toISOString(),
      local: fmtTime(t, tz) ?? '',
      sunAltitude: Math.round(sunAlt),
      dark: sunAlt < DARK_SUN_ALT,
      cloudTotal,
      cloudLow: H.cloud_cover_low[i] ?? 0,
      cloudMid: H.cloud_cover_mid[i] ?? 0,
      cloudHigh: H.cloud_cover_high[i] ?? 0,
      humidity: H.relative_humidity_2m[i] ?? 0,
      temperatureC: temp,
      dewPointC: dew,
      dewSpreadC: Math.round((temp - dew) * 10) / 10,
      windKmh: H.wind_speed_10m[i] ?? 0,
      gustKmh: H.wind_gusts_10m[i] ?? 0,
      precipProbability: H.precipitation_probability?.[i] ?? 0,
      precipMm: H.precipitation?.[i] ?? 0,
      visibilityKm: vis != null ? vis / 1000 : null,
    };
    const a = astroAt(astro, t.getTime());
    const { score, issues } = scoreHour(base, a?.transparency);
    hours.push({ ...base, seeing: a ? SEEING[a.seeing] : undefined, transparency: a ? TRANSPARENCY[a.transparency] : undefined, seeingIdx: a?.seeing, transparencyIdx: a?.transparency, score, rating: rate(score), issues });
  }
  const c = om.current ?? {};
  const current: CurrentWeather = {
    cloudCover: c.cloud_cover,
    temperatureC: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    dewPointC: c.dew_point_2m,
    windKmh: c.wind_speed_10m,
    gustKmh: c.wind_gusts_10m,
    precipitationMm: c.precipitation,
    at: c.time ? utcTime(c.time, tz) : null,
  };
  return { hours, current };
}
