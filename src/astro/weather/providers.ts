/**
 * The two providers, their answers validated before use:
 *  - Open-Meteo (https://open-meteo.com, free, no key): hourly cloud cover by layer (the median
 *    across several weather models, see CLOUD_MODELS), humidity, dew
 *    point, wind/gusts, precipitation probability and amount, visibility, and what the night safety
 *    report needs on top: the weather code, showers, snowfall and CAPE.
 *  - 7Timer! ASTRO (https://www.7timer.info, free, no key): astronomical seeing and transparency
 *    in 3-hour steps.
 */
import { z } from 'zod';
import type { Site } from '../sky.js';
import { getJson, type Fetch } from './http.js';
import { logger, errMsg } from '../../log.js';

const log = logger('weather');

const HOURLY = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'relative_humidity_2m', 'dew_point_2m', 'temperature_2m', 'wind_speed_10m', 'wind_gusts_10m', 'precipitation_probability', 'precipitation', 'visibility', 'weather_code', 'showers', 'snowfall', 'cape'] as const;
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
    weather_code: series.optional(),
    showers: series.optional(),
    snowfall: series.optional(),
    cape: series.optional(),
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

/**
 * The models whose cloud cover is combined into the median. Open-Meteo's default ("best_match")
 * is a single model per region — GFS/HRRR over the US — and a single model misses whole cloud
 * decks: on 2026-11-07 over central Florida GFS/HRRR said 0–1 % while ICON, GEM and JMA said
 * 50–90 % and the sky survey showed a lit low-cloud deck. A model without data for the site (or
 * the hour) answers null and is left out of that hour's median.
 */
export const CLOUD_MODELS = ['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless', 'gem_seamless', 'jma_seamless', 'ukmo_seamless'] as const;
const CLOUD_VARS = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'] as const;
type CloudVar = (typeof CLOUD_VARS)[number];

const EnsembleSchema = z.object({ hourly: z.record(z.string(), z.array(z.union([z.number(), z.string(), z.null()]))) });

/** The median of the numbers given, or null when there are none. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Per UTC hour ("2026-10-12T20:00"), the median across CLOUD_MODELS of each cloud layer. */
export type CloudMedians = Map<string, Record<CloudVar, number | null>>;

/** Each hour's cloud cover as the median across CLOUD_MODELS, per layer. */
export function cloudMedians(raw: unknown): CloudMedians {
  const parsed = EnsembleSchema.safeParse(raw);
  if (!parsed.success) throw fail('Open-Meteo (models)', parsed.error);
  const H = parsed.data.hourly;
  const time = H.time ?? [];
  const out: CloudMedians = new Map();
  time.forEach((t, i) => {
    if (typeof t !== 'string') return;
    const row = {} as Record<CloudVar, number | null>;
    for (const v of CLOUD_VARS) {
      const vals = CLOUD_MODELS.map((m) => H[`${v}_${m}`]?.[i]).filter((x): x is number => typeof x === 'number');
      const med = median(vals);
      row[v] = med == null ? null : Math.round(med);
    }
    // each layer's median is taken on its own, so they can disagree with the total's: the total
    // is never less than any one layer
    if (row.cloud_cover != null) row.cloud_cover = Math.max(row.cloud_cover, row.cloud_cover_low ?? 0, row.cloud_cover_mid ?? 0, row.cloud_cover_high ?? 0);
    if (Object.values(row).some((x) => x != null)) out.set(t, row);
  });
  return out;
}

async function fetchCloudMedians(site: Site, urls: ProviderUrls, f?: Fetch): Promise<CloudMedians> {
  const q = new URLSearchParams({
    latitude: String(site.lat),
    longitude: String(site.lon),
    hourly: CLOUD_VARS.join(','),
    models: CLOUD_MODELS.join(','),
    timezone: 'UTC',
    forecast_days: '3',
    past_hours: '2',
  });
  return cloudMedians(await getJson(`${urls.openMeteo}?${q}`, { fetch: f }));
}

/** The hours' and the current cloud cover replaced by the models' medians where there is one. */
function applyMedians(om: OpenMeteo, med: CloudMedians): void {
  const H = om.hourly;
  H.time.forEach((t, i) => {
    const row = med.get(t);
    if (!row) return;
    for (const v of CLOUD_VARS) if (row[v] != null) H[v][i] = row[v];
  });
  // the current value comes from one model only (Open-Meteo answers a single "current" for many
  // models): the median of the hour it falls in stands in for it
  const now = om.current?.time ? med.get(`${om.current.time.slice(0, 13)}:00`)?.cloud_cover : null;
  if (om.current && now != null) om.current.cloud_cover = now;
}

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
  // the cloud medians are asked for alongside; when they cannot be had, the default model's clouds stand
  const medP = fetchCloudMedians(site, urls, f).catch((err: unknown) => {
    log.warn(`cloud cover from several models unavailable (${errMsg(err)}); using Open-Meteo's default model`);
    return null;
  });
  const raw = await getJson(`${urls.openMeteo}?${q}`, { fetch: f });
  const parsed = OpenMeteoSchema.safeParse(raw);
  if (!parsed.success) throw fail('Open-Meteo', parsed.error);
  const n = parsed.data.hourly.time.length;
  for (const k of HOURLY) {
    const s = parsed.data.hourly[k];
    if (s && s.length !== n) throw new Error(`Open-Meteo answered ${s.length} values of ${k} for ${n} hours`);
  }
  const med = await medP;
  if (med) applyMedians(parsed.data, med);
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
