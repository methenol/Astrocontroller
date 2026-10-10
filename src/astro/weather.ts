/**
 * Local weather and observability.
 *  - Open-Meteo (https://open-meteo.com, free, no key): hourly cloud cover by layer,
 *    humidity, dew point, wind/gusts, precipitation probability, visibility.
 *  - 7Timer! ASTRO (https://www.7timer.info, free, no key): astronomical seeing and
 *    transparency in 3-hour steps.
 * Combined into an hourly 0–100 observability score and tonight's best window.
 * Both providers are fetched with retries under a deadline and the result is cached, so one bad
 * second on a field connection does not take the Tonight tab's weather down with it — see forecast().
 */
import { scheduler } from 'node:timers/promises';
import { logger, errMsg } from '../log.js';
import { bodyAlt, nightWindow, fmtTime, type Site } from './sky.js';

const log = logger('weather');

export interface HourForecast {
  time: string; // ISO UTC
  local: string;
  sunAltitude: number;
  dark: boolean;
  cloudTotal: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  humidity: number;
  temperatureC: number;
  dewPointC: number;
  dewSpreadC: number;
  windKmh: number;
  gustKmh: number;
  precipProbability: number;
  /** expected precipitation in that hour (rain + showers + snow water), mm */
  precipMm: number;
  visibilityKm: number | null;
  seeing?: string;
  transparency?: string;
  score: number;
  rating: 'excellent' | 'good' | 'fair' | 'poor';
  issues: string[];
}

// 7Timer scales (1 best … 8 worst).
const SEEING = ['', '<0.5″', '0.5–0.75″', '0.75–1″', '1–1.25″', '1.25–1.5″', '1.5–2″', '2–2.5″', '>2.5″'];
const TRANSPARENCY = ['', 'excellent', 'very good', 'good', 'above avg', 'average', 'below avg', 'poor', 'very poor'];

export interface Forecast {
  hours: HourForecast[];
  current: Record<string, unknown>;
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
const FRESH_MIN = 15;
/** Past this the numbers are not worth showing: the providers have been unreachable all this time. */
const STALE_HOURS = 12;
/** After a failed refresh, nothing new is attempted for this long (a dead connection is not hurried). */
const RETRY_COOLDOWN_MS = 60e3;

type Data = { hours: HourForecast[]; current: Record<string, unknown> };
/** 7Timer's seeing and transparency, keyed by the UTC hour the 3-hour sample covers. */
type AstroMap = Map<number, { seeing: number; transparency: number }>;
/** 7Timer did not answer: the seeing and transparency columns stay blank, nothing else changes. */
const NO_SEEING: AstroMap = new Map();

let cache: { key: string; at: number; data: Data; err?: string } | null = null;
/**
 * The refresh in flight, for one site. The Tonight tab asks for /weather and /plan at the same
 * moment and both need the forecast, so concurrent callers must share one fetch rather than each
 * one its own — but only callers of the same site, since the location can move under us.
 */
let flight: { key: string; promise: Promise<Forecast> } | null = null;
let nextTryAt = 0;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Worth trying again: a connect stall, a slow provider, or a server that asked for a resend. */
function transient(err: unknown): boolean {
  const e = err as { name?: string; message?: string; cause?: { code?: string }; status?: number };
  if (typeof e?.status === 'number') return e.status === 408 || e.status === 429 || e.status >= 500;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true;
  return /ECONN|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO|EALREADY|ETIMEDOUT|UND_ERR|SOCKET_HANG|FETCH_FAILED|TIMEOUT/i.test(`${e?.cause?.code ?? ''} ${e?.message ?? ''}`);
}

/**
 * GET and parse JSON, retrying.
 *
 * Open-Meteo answers in under a second when the connection is warm, but the first call after a
 * spell of silence can stall in DNS/TCP for tens of seconds and then answer in 0.7 s (measured
 * repeatedly here). One attempt with a 12 s timeout turned every such stall into a blank weather
 * card, which is what made the Tonight tab fail periodically. So: a longer per-attempt budget,
 * three attempts with a short wait between them, and a deadline on the whole call so a caller with
 * nothing cached is not left waiting indefinitely.
 */
async function getJson(url: string, opts: { timeoutMs?: number; attempts?: number; deadlineMs?: number } = {}): Promise<any> {
  const { timeoutMs = 20000, attempts = 3 } = opts;
  const deadline = Date.now() + (opts.deadlineMs ?? 45000);
  const host = new URL(url).host;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const left = deadline - Date.now();
    if (left <= 500) break;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, left)), headers: { 'User-Agent': 'astrocontroller/0.1' } });
      if (!res.ok) throw new HttpError(`HTTP ${res.status} from ${host}`, res.status);
      // Read the body inside the attempt: a connection that stalls after the headers is a failed
      // attempt, not a success.
      return await res.json();
    } catch (err) {
      last = err;
      if (!transient(err) || attempt === attempts) break;
      log.debug(`${host}: attempt ${attempt} failed (${errMsg(err)}); retrying`);
      // Wait out the blip before trying again; a retry in the same millisecond sees the same stall.
      await scheduler.wait(1500 * attempt);
    }
  }
  const why = last instanceof HttpError ? last.message : errMsg(last) || 'no response';
  throw new Error(`${host}: ${why} (attempt ${attempts > 1 ? `of ${attempts}` : '1'})`);
}

const stamp = (entry: { at: number; data: Data; err?: string }): Forecast => {
  const ageMin = Math.round((Date.now() - entry.at) / 60e3);
  return { ...entry.data, fetchedAt: new Date(entry.at).toISOString(), ageMin, stale: ageMin > FRESH_MIN, staleError: entry.err };
};

function scoreHour(h: Omit<HourForecast, 'score' | 'rating' | 'issues'>, transp?: number): { score: number; issues: string[] } {
  const issues: string[] = [];
  // High (cirrus) cloud is often thin; low/mid cloud blocks everything.
  const effCloud = Math.min(100, Math.max(h.cloudLow, h.cloudMid, h.cloudHigh * 0.6, h.cloudTotal * 0.85));
  let score = 100 - effCloud;
  if (effCloud >= 70) issues.push(`cloudy (${h.cloudTotal}%)`);
  else if (effCloud >= 30) issues.push(`partly cloudy (${h.cloudTotal}%, low ${h.cloudLow}% / mid ${h.cloudMid}% / high ${h.cloudHigh}%)`);
  if (h.precipProbability >= 50) {
    score *= 0.2;
    issues.push(`rain likely (${h.precipProbability}%)`);
  } else if (h.precipProbability >= 25) {
    score *= 0.7;
    issues.push(`chance of rain (${h.precipProbability}%)`);
  }
  if (h.gustKmh >= 40) {
    score -= 40;
    issues.push(`strong gusts ${Math.round(h.gustKmh)} km/h — scope will shake`);
  } else if (h.gustKmh >= 25) {
    score -= 15;
    issues.push(`gusty ${Math.round(h.gustKmh)} km/h`);
  }
  if (h.dewSpreadC < 1.5) {
    score -= 10;
    issues.push(`dew/fog risk (dew-point spread ${h.dewSpreadC.toFixed(1)}°C)`);
  } else if (h.dewSpreadC < 3) {
    issues.push(`dew likely on optics (spread ${h.dewSpreadC.toFixed(1)}°C)`);
  }
  if (transp !== undefined && transp >= 6) {
    score -= 10;
    issues.push(`poor transparency`);
  }
  if (h.visibilityKm !== null && h.visibilityKm < 5) {
    score -= 15;
    issues.push(`haze/fog (visibility ${h.visibilityKm.toFixed(1)} km)`);
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), issues };
}

const rate = (s: number): HourForecast['rating'] => (s >= 80 ? 'excellent' : s >= 60 ? 'good' : s >= 40 ? 'fair' : 'poor');

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
export async function forecast(site: Site, tz: string): Promise<Forecast> {
  const key = `${site.lat.toFixed(3)},${site.lon.toFixed(3)}`;
  const held = cache && cache.key === key ? cache : null;
  const heldMin = held ? (Date.now() - held.at) / 60e3 : Infinity;
  if (held && heldMin < FRESH_MIN) return stamp(held);
  if (flight && flight.key === key) return flight.promise;
  // After a failed refresh nothing new is attempted for RETRY_COOLDOWN_MS: a duty loop and a phone
  // poll would otherwise each start their own attempt against a connection that is simply down.
  if (held && Date.now() < nextTryAt) return stamp(held);

  const p: Promise<Forecast> = fetchForecast(site, tz).then(
    (data) => {
      if (flight?.promise === p) flight = null;
      nextTryAt = 0;
      cache = { key, at: Date.now(), data };
      return stamp(cache);
    },
    (err) => {
      if (flight?.promise === p) flight = null;
      nextTryAt = Date.now() + RETRY_COOLDOWN_MS;
      const why = errMsg(err);
      if (held && heldMin < STALE_HOURS * 60) {
        log.warn(`forecast refresh failed (${why}); keeping the forecast from ${Math.round(heldMin)} min ago`);
        // Kept on the entry itself: every later read of this copy says why it is not current, not
        // only the one call that happened to be waiting when the refresh gave up.
        held.err = why;
        return stamp(held);
      }
      throw new Error(`weather fetch failed: ${why}${held ? ` (the cached forecast is ${Math.round(heldMin)} min old, past ${STALE_HOURS} h)` : ' (nothing fetched yet this session)'}`);
    },
  );
  flight = { key, promise: p };
  if (held && heldMin < STALE_HOURS * 60) {
    p.catch(() => {});
    return stamp(held);
  }
  return p;
}

async function fetchForecast(site: Site, tz: string): Promise<Data> {
  const hourly = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,dew_point_2m,temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation,visibility';

  // 7Timer is best-effort (it is slow at times) and was awaited after Open-Meteo, so a laggy
  // seeing/transparency server added its whole wait to every forecast. Started here instead, and
  // its failure costs nothing but the seeing and transparency columns.
  const astroP: Promise<AstroMap> = getJson(`https://www.7timer.info/bin/astro.php?lon=${site.lon}&lat=${site.lat}&ac=0&unit=metric&output=json&tzshift=0`, { attempts: 2, timeoutMs: 8000, deadlineMs: 15000 })
    .then((st) => {
      const init = String(st.init); // YYYYMMDDHH (UTC)
      const t0 = Date.UTC(+init.slice(0, 4), +init.slice(4, 6) - 1, +init.slice(6, 8), +init.slice(8, 10));
      const m: AstroMap = new Map();
      for (const d of st.dataseries ?? []) m.set(t0 + d.timepoint * 3600e3, { seeing: d.seeing, transparency: d.transparency });
      return m;
    })
    .catch((err) => {
      log.debug(`7timer unavailable: ${errMsg(err)}`);
      return NO_SEEING;
    });

  const om = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${site.lat}&longitude=${site.lon}&hourly=${hourly}&current=cloud_cover,temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_gusts_10m,precipitation&timezone=UTC&forecast_days=3&past_hours=2`,
  );
  // Seeing and transparency are a bonus on the card's tooltips: hold tonight's clouds for them,
  // but only for so long.
  const astro = await Promise.race([astroP, scheduler.wait(6000).then(() => NO_SEEING)]);
  const astroAt = (t: number) => {
    let best: { seeing: number; transparency: number } | undefined;
    let bestD = Infinity;
    for (const [k, v] of astro) {
      const d = Math.abs(k - t);
      if (d < bestD && d <= 2 * 3600e3) {
        bestD = d;
        best = v;
      }
    }
    return best;
  };

  const H = om.hourly;
  const hours: HourForecast[] = [];
  for (let i = 0; i < H.time.length; i++) {
    const t = new Date(`${H.time[i]}Z`);
    const sunAlt = bodyAlt(site, 'Sun', t);
    const temp = H.temperature_2m[i];
    const dew = H.dew_point_2m[i];
    const base = {
      time: t.toISOString(),
      local: fmtTime(t, tz) ?? '',
      sunAltitude: Math.round(sunAlt),
      dark: sunAlt < -18,
      cloudTotal: H.cloud_cover[i],
      cloudLow: H.cloud_cover_low[i],
      cloudMid: H.cloud_cover_mid[i],
      cloudHigh: H.cloud_cover_high[i],
      humidity: H.relative_humidity_2m[i],
      temperatureC: temp,
      dewPointC: dew,
      dewSpreadC: Math.round((temp - dew) * 10) / 10,
      windKmh: H.wind_speed_10m[i],
      gustKmh: H.wind_gusts_10m[i],
      precipProbability: H.precipitation_probability[i] ?? 0,
      precipMm: H.precipitation?.[i] ?? 0,
      visibilityKm: H.visibility?.[i] != null ? H.visibility[i] / 1000 : null,
    };
    const a = astroAt(t.getTime());
    const { score, issues } = scoreHour(base, a?.transparency);
    hours.push({ ...base, seeing: a ? SEEING[a.seeing] : undefined, transparency: a ? TRANSPARENCY[a.transparency] : undefined, score, rating: rate(score), issues });
  }
  const c = om.current ?? {};
  const current = {
    cloudCover: c.cloud_cover,
    temperatureC: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    dewPointC: c.dew_point_2m,
    windKmh: c.wind_speed_10m,
    gustKmh: c.wind_gusts_10m,
    precipitationMm: c.precipitation,
    at: c.time ? fmtTime(new Date(`${c.time}Z`), tz) : null,
  };
  return { hours, current };
}

/** Tonight's verdict: dark hours with scores, the best contiguous window, and a one-line summary. */
export async function tonight(site: Site, tz: string) {
  const f = await forecast(site, tz);
  const { hours, current } = f;
  const w = nightWindow(site);
  const start = w.darkStart ?? new Date();
  const end = w.darkEnd ?? new Date(start.getTime() + 10 * 3600e3);
  const night = hours.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= start.getTime() - 3600e3 && t <= end.getTime();
  });
  let best: { from: string; to: string; hours: number; avgScore: number } | null = null;
  let run: HourForecast[] = [];
  const flush = () => {
    if (run.length && (!best || run.length > best.hours)) {
      best = { from: run[0].local, to: fmtTime(new Date(new Date(run[run.length - 1].time).getTime() + 3600e3), tz) ?? '', hours: run.length, avgScore: Math.round(run.reduce((a, h) => a + h.score, 0) / run.length) };
    }
    run = [];
  };
  for (const h of night) {
    if (h.score >= 60) run.push(h);
    else flush();
  }
  flush();
  const avg = night.length ? Math.round(night.reduce((a, h) => a + h.score, 0) / night.length) : 0;
  const issues = [...new Set(night.flatMap((h) => h.issues.map((i) => i.replace(/\s*\(.*\)$/, ''))))];
  const b = best as { from: string; to: string; hours: number; avgScore: number } | null;
  const verdict = !night.length
    ? 'no forecast for tonight'
    : b
      ? `${rate(avg)} night overall (avg ${avg}/100); best clear window ${b.from} → ${b.to} (${b.hours} h, avg ${b.avgScore})`
      : `poor night (avg ${avg}/100) — no hour with good observability`;
  return { verdict, averageScore: avg, bestWindow: b, commonIssues: issues, current, darkness: { start: fmtTime(start, tz), end: fmtTime(end, tz) }, hours: night, fetchedAt: f.fetchedAt, ageMin: f.ageMin, stale: f.stale, staleError: f.staleError };
}

/**
 * Forecast observability (0–100) at any moment, from the hourly forecast (the hour it falls in),
 * for ranking targets by clear time. Null when the forecast cannot be fetched (offline in the field).
 */
export async function observabilityAt(site: Site, tz: string): Promise<((t: Date) => number | undefined) | null> {
  try {
    const { hours } = await forecast(site, tz);
    const byHour = new Map(hours.map((h) => [Math.floor(new Date(h.time).getTime() / 3600e3), h.score]));
    return (t: Date) => byHour.get(Math.floor(t.getTime() / 3600e3));
  } catch {
    return null;
  }
}
