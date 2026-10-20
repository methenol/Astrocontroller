/** Hourly observability: the forecast numbers of one hour turned into a 0–100 score and its reasons. */

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
  /** the raw 7Timer indices (1 best … 8 worst) behind those labels, for per-target scoring */
  seeingIdx?: number;
  transparencyIdx?: number;
  score: number;
  rating: Rating;
  issues: string[];
}

export type Rating = 'excellent' | 'good' | 'fair' | 'poor';
export type HourInputs = Omit<HourForecast, 'score' | 'rating' | 'issues' | 'seeing' | 'transparency' | 'seeingIdx' | 'transparencyIdx'>;

// 7Timer scales (1 best … 8 worst).
export const SEEING = ['', '<0.5″', '0.5–0.75″', '0.75–1″', '1–1.25″', '1.25–1.5″', '1.5–2″', '2–2.5″', '>2.5″'];
export const TRANSPARENCY = ['', 'excellent', 'very good', 'good', 'above avg', 'average', 'below avg', 'poor', 'very poor'];

/** High (cirrus) cloud is often thin; low/mid cloud blocks everything. */
const HIGH_CLOUD_WEIGHT = 0.6;
const TOTAL_CLOUD_WEIGHT = 0.85;
/** 7Timer transparency from this value on is poor. */
const POOR_TRANSPARENCY = 6;
/** Effective cloud (%) from which the hour is cloudy, or partly cloudy. */
const CLOUDY = 70;
const PARTLY_CLOUDY = 30;
/** Precipitation probability (%) → what is left of the score. */
const RAIN_LIKELY = { pct: 50, keep: 0.2 } as const;
const RAIN_CHANCE = { pct: 25, keep: 0.7 } as const;
/** Gusts (km/h) → points off: the mount shakes in the first, subs smear in the second. */
const STRONG_GUSTS = { kmh: 40, off: 40 } as const;
const GUSTY = { kmh: 25, off: 15 } as const;
/** Dew-point spread (°C): fog under the first, dew on the optics under the second. */
const FOG_SPREAD_C = 1.5;
const DEW_SPREAD_C = 3;
const FOG_OFF = 10;
const POOR_TRANSPARENCY_OFF = 10;
/** Visibility (km) under which the air is hazy. */
const HAZE_KM = 5;
const HAZE_OFF = 15;

export function scoreHour(h: HourInputs, transparency?: number): { score: number; issues: string[] } {
  const issues: string[] = [];
  const effCloud = Math.min(100, Math.max(h.cloudLow, h.cloudMid, h.cloudHigh * HIGH_CLOUD_WEIGHT, h.cloudTotal * TOTAL_CLOUD_WEIGHT));
  let score = 100 - effCloud;
  if (effCloud >= CLOUDY) issues.push(`cloudy (${h.cloudTotal}%)`);
  else if (effCloud >= PARTLY_CLOUDY) issues.push(`partly cloudy (${h.cloudTotal}%, low ${h.cloudLow}% / mid ${h.cloudMid}% / high ${h.cloudHigh}%)`);
  if (h.precipProbability >= RAIN_LIKELY.pct) {
    score *= RAIN_LIKELY.keep;
    issues.push(`rain likely (${h.precipProbability}%)`);
  } else if (h.precipProbability >= RAIN_CHANCE.pct) {
    score *= RAIN_CHANCE.keep;
    issues.push(`chance of rain (${h.precipProbability}%)`);
  }
  if (h.gustKmh >= STRONG_GUSTS.kmh) {
    score -= STRONG_GUSTS.off;
    issues.push(`strong gusts ${Math.round(h.gustKmh)} km/h — scope will shake`);
  } else if (h.gustKmh >= GUSTY.kmh) {
    score -= GUSTY.off;
    issues.push(`gusty ${Math.round(h.gustKmh)} km/h`);
  }
  if (h.dewSpreadC < FOG_SPREAD_C) {
    score -= FOG_OFF;
    issues.push(`dew/fog risk (dew-point spread ${h.dewSpreadC.toFixed(1)}°C)`);
  } else if (h.dewSpreadC < DEW_SPREAD_C) {
    issues.push(`dew likely on optics (spread ${h.dewSpreadC.toFixed(1)}°C)`);
  }
  if (transparency !== undefined && transparency >= POOR_TRANSPARENCY) {
    score -= POOR_TRANSPARENCY_OFF;
    issues.push(`poor transparency`);
  }
  if (h.visibilityKm !== null && h.visibilityKm < HAZE_KM) {
    score -= HAZE_OFF;
    issues.push(`haze/fog (visibility ${h.visibilityKm.toFixed(1)} km)`);
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), issues };
}

export const rate = (s: number): Rating => (s >= 80 ? 'excellent' : s >= 60 ? 'good' : s >= 40 ? 'fair' : 'poor');
