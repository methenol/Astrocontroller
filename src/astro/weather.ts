/**
 * Local weather and observability.
 *  - Open-Meteo (https://open-meteo.com, free, no key): hourly cloud cover by layer,
 *    humidity, dew point, wind/gusts, precipitation probability, visibility.
 *  - 7Timer! ASTRO (https://www.7timer.info, free, no key): astronomical seeing and
 *    transparency in 3-hour steps.
 * Combined into an hourly 0–100 observability score and tonight's best window.
 */
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

let cache: { key: string; at: number; data: { hours: HourForecast[]; current: Record<string, unknown> } } | null = null;

async function getJson(url: string, timeoutMs = 12000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'astrocontroller/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

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

export async function forecast(site: Site, tz: string): Promise<{ hours: HourForecast[]; current: Record<string, unknown> }> {
  const key = `${site.lat.toFixed(3)},${site.lon.toFixed(3)}`;
  if (cache && cache.key === key && Date.now() - cache.at < 15 * 60e3) return cache.data;

  const hourly = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,dew_point_2m,temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,visibility';
  const om = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${site.lat}&longitude=${site.lon}&hourly=${hourly}&current=cloud_cover,temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_gusts_10m,precipitation&timezone=UTC&forecast_days=3&past_hours=2`,
  );

  // 7Timer is best-effort (it is slow at times).
  const astro = new Map<number, { seeing: number; transparency: number }>();
  try {
    const st = await getJson(`https://www.7timer.info/bin/astro.php?lon=${site.lon}&lat=${site.lat}&ac=0&unit=metric&output=json&tzshift=0`, 15000);
    const init = String(st.init); // YYYYMMDDHH (UTC)
    const t0 = Date.UTC(+init.slice(0, 4), +init.slice(4, 6) - 1, +init.slice(6, 8), +init.slice(8, 10));
    for (const d of st.dataseries ?? []) astro.set(t0 + d.timepoint * 3600e3, { seeing: d.seeing, transparency: d.transparency });
  } catch (err) {
    log.debug(`7timer unavailable: ${errMsg(err)}`);
  }
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
  const data = { hours, current };
  cache = { key, at: Date.now(), data };
  return data;
}

/** Tonight's verdict: dark hours with scores, the best contiguous window, and a one-line summary. */
export async function tonight(site: Site, tz: string) {
  const { hours, current } = await forecast(site, tz);
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
  return { verdict, averageScore: avg, bestWindow: b, commonIssues: issues, current, darkness: { start: fmtTime(start, tz), end: fmtTime(end, tz) }, hours: night };
}
