/**
 * The two providers, their answers validated before use:
 *  - Open-Meteo (https://open-meteo.com, free, no key): hourly cloud cover by layer, humidity, dew
 *    point, wind/gusts, precipitation probability, visibility.
 *  - 7Timer! ASTRO (https://www.7timer.info, free, no key): astronomical seeing and transparency
 *    in 3-hour steps.
 */
import { z } from 'zod';
import type { Site } from '../sky.js';
import { getJson, type Fetch } from './http.js';

const HOURLY = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'relative_humidity_2m', 'dew_point_2m', 'temperature_2m', 'wind_speed_10m', 'wind_gusts_10m', 'precipitation_probability', 'precipitation', 'visibility'] as const;
const CURRENT = ['cloud_cover', 'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_gusts_10m', 'precipitation'] as const;

const series = z.array(z.number().nullable());
const OpenMeteoSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    cloud_cover: series,
    cloud_cover_low: series,
    cloud_cover_mid: series,
    cloud_cover_high: series,
    relative_humidity_2m: series,
    dew_point_2m: series,
    temperature_2m: series,
    wind_speed_10m: series,
    wind_gusts_10m: series,
    precipitation_probability: series.optional(),
    precipitation: series.optional(),
    visibility: series.optional(),
  }),
  current: z
    .object({
      time: z.string().optional(),
      cloud_cover: z.number().nullable().optional(),
      temperature_2m: z.number().nullable().optional(),
      relative_humidity_2m: z.number().nullable().optional(),
      dew_point_2m: z.number().nullable().optional(),
      wind_speed_10m: z.number().nullable().optional(),
      wind_gusts_10m: z.number().nullable().optional(),
      precipitation: z.number().nullable().optional(),
    })
    .optional(),
});
export type OpenMeteo = z.infer<typeof OpenMeteoSchema>;

const SevenTimerSchema = z.object({
  init: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{10}$/)),
  dataseries: z.array(z.object({ timepoint: z.number(), seeing: z.number().int(), transparency: z.number().int() }).loose()),
});

/** 7Timer's scales run 1 (best) … 8 (worst); it sends -9999 for a value it does not have. */
const SCALE_MIN = 1;
const SCALE_MAX = 8;
const onScale = (n: number) => n >= SCALE_MIN && n <= SCALE_MAX;

/** 7Timer's seeing and transparency (1 best … 8 worst), keyed by the UTC time the 3-hour sample covers. */
export type AstroMap = Map<number, { seeing: number; transparency: number }>;

const fail = (provider: string, err: z.ZodError) => new Error(`${provider} answered in an unexpected shape: ${err.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

export interface ProviderUrls {
  openMeteo: string;
  sevenTimer: string;
}

export const DEFAULT_URLS: ProviderUrls = {
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  sevenTimer: 'https://www.7timer.info/bin/astro.php',
};

export async function fetchOpenMeteo(site: Site, urls: ProviderUrls, f?: Fetch): Promise<OpenMeteo> {
  const q = new URLSearchParams({
    latitude: String(site.lat),
    longitude: String(site.lon),
    hourly: HOURLY.join(','),
    current: CURRENT.join(','),
    timezone: 'UTC',
    forecast_days: '3',
    past_hours: '2',
  });
  const raw = await getJson(`${urls.openMeteo}?${q}`, { fetch: f });
  const parsed = OpenMeteoSchema.safeParse(raw);
  if (!parsed.success) throw fail('Open-Meteo', parsed.error);
  const n = parsed.data.hourly.time.length;
  for (const k of HOURLY) {
    const s = parsed.data.hourly[k];
    if (s && s.length !== n) throw new Error(`Open-Meteo answered ${s.length} values of ${k} for ${n} hours`);
  }
  return parsed.data;
}

/** 7Timer is best-effort and slow at times: fewer attempts and a short deadline. */
export async function fetchSevenTimer(site: Site, urls: ProviderUrls, f?: Fetch): Promise<AstroMap> {
  const q = new URLSearchParams({ lon: String(site.lon), lat: String(site.lat), ac: '0', unit: 'metric', output: 'json', tzshift: '0' });
  const raw = await getJson(`${urls.sevenTimer}?${q}`, { attempts: 2, timeoutMs: 8000, deadlineMs: 15_000, fetch: f });
  const parsed = SevenTimerSchema.safeParse(raw);
  if (!parsed.success) throw fail('7Timer', parsed.error);
  const init = parsed.data.init; // YYYYMMDDHH (UTC)
  const t0 = Date.UTC(+init.slice(0, 4), +init.slice(4, 6) - 1, +init.slice(6, 8), +init.slice(8, 10));
  const m: AstroMap = new Map();
  // a sample missing either value is left out: the hour then simply has no seeing/transparency
  for (const d of parsed.data.dataseries) if (onScale(d.seeing) && onScale(d.transparency)) m.set(t0 + d.timepoint * 3600e3, { seeing: d.seeing, transparency: d.transparency });
  return m;
}
