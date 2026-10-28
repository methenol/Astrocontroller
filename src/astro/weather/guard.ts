/**
 * Rain Guard: a next-hour precipitation alarm for a telescope left outside unattended.
 *
 * It runs in the server, not the browser: a phone that locks or a tab the browser suspends cannot
 * silence it, and an armed guard survives a restart. Every POLL_MS it asks Open-Meteo for the
 * 15-minute forecast at the site and at a ring of points around it, and raises:
 *  - an alarm for precipitation of any kind at the site (rain, showers, snow; the original page read
 *    `rain` only, which leaves out convective showers, the very ones that arrive unannounced), for a
 *    high hourly precipitation chance, for a thunderstorm at the site or in the ring, and for gusts
 *    over the limit;
 *  - a watch when precipitation is forecast in the ring but not at the site: a cell the model
 *    places a few kilometres off is still a cell coming this way;
 *  - a fault alarm when no check has succeeded for FAULT_AFTER_MS: a guard that has silently
 *    stopped looking is worse than none, because the user sleeps trusting it.
 * The alarm sounds until acknowledged; an acknowledged alarm sounds again after SNOOZE_MS while the
 * danger lasts, or at once when a new kind of danger appears.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { z } from 'zod';
import { logger, errMsg } from '../../log.js';
import { writeFileAtomic } from '../../util/fs.js';
import type { Site } from '../sky.js';
import { getJson, type Fetch } from './http.js';
import { unitFormat, type UnitFormat, type Units } from '../../util/units.js';

const log = logger('rain-guard');

export const POLL_MS = 3 * 60e3;
/** After a failed check (which already retried inside getJson) the next one comes sooner. */
const RETRY_MS = 60e3;
/** No successful check for this long while armed sounds the fault alarm. */
export const FAULT_AFTER_MS = 12 * 60e3;
const WATCHDOG_MS = 30e3;
/** An acknowledged alarm whose danger lasts sounds again after this long. */
export const SNOOZE_MS = 20 * 60e3;
const SLOT_S = 15 * 60;
const HOUR_S = 3600;
/** Gusts at this fraction of the limit are a watch. */
const GUST_WATCH = 0.8;
const RING_BEARINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const KM_PER_DEG_LAT = 111.32;
const DEFAULT_URL = 'https://api.open-meteo.com/v1/forecast';

export interface GuardSettings {
  /** minutes ahead the forecast is read */
  lookaheadMin: number;
  /** precipitation (mm per 15 min) that counts as wet */
  thresholdMm: number;
  /** hourly precipitation chance (%) that sounds the alarm even when no amount is forecast */
  probabilityPct: number;
  /** gusts (km/h) that sound the alarm (and mark an hour dangerous in the night report) */
  gustKmh: number;
  /** radius (km) of the ring of points around the site; 0 = the site only */
  ringKm: number;
  /** air temperature (°C) under which the night report calls the cold dangerous */
  minTempC: number;
}

export const GUARD_DEFAULTS: GuardSettings = { lookaheadMin: 60, thresholdMm: 0.01, probabilityPct: 60, gustKmh: 45, ringKm: 20, minTempC: -20 };

export const GuardSettingsSchema = z.object({
  lookaheadMin: z.number().int().min(15).max(180),
  thresholdMm: z.number().min(0.01).max(5),
  probabilityPct: z.number().int().min(10).max(100),
  gustKmh: z.number().min(10).max(150),
  ringKm: z.number().min(0).max(60),
  minTempC: z.number().min(-60).max(10),
});

export type HazardKind = 'rain' | 'snow' | 'storm' | 'wind' | 'fault';
export interface Hazard {
  kind: HazardKind;
  level: 'alarm' | 'watch';
  message: string;
}

/** One 15-minute slot at the site, for the timeline: the period (end − 15 min, end]. */
export interface Slot {
  /** end of the slot, ms */
  end: number;
  mm: number;
  code: number | null;
}

export interface Assessment {
  level: 'clear' | 'watch' | 'alarm';
  hazards: Hazard[];
  slots: Slot[];
  /** forecast precipitation at the site within the lookahead, mm */
  siteMm: number;
  /** highest hourly precipitation chance over the lookahead, % */
  maxProbability: number;
  /** highest gust at the site over the lookahead, km/h */
  maxGustKmh: number;
  /** the grid cell the forecast is for */
  grid: { lat: number; lon: number } | null;
}

const num = z.number().nullable();
const PointSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  current: z.object({ time: z.number(), precipitation: num.optional(), weather_code: num.optional(), wind_gusts_10m: num.optional() }).optional(),
  minutely_15: z.object({ time: z.array(z.number()), precipitation: z.array(num), weather_code: z.array(num).optional(), wind_gusts_10m: z.array(num).optional() }).optional(),
  hourly: z.object({ time: z.array(z.number()), precipitation_probability: z.array(num).optional(), weather_code: z.array(num).optional(), wind_gusts_10m: z.array(num).optional() }).optional(),
});
export type Point = z.infer<typeof PointSchema>;
const ResponseSchema = z.union([z.array(PointSchema), PointSchema]);

// WMO weather codes
export const isThunder = (c: number | null | undefined) => c != null && c >= 95 && c <= 99;
export const isSnow = (c: number | null | undefined) => c != null && ((c >= 71 && c <= 77) || c === 85 || c === 86);
export const isFreezing = (c: number | null | undefined) => c === 56 || c === 57 || c === 66 || c === 67;
/** Drizzle, rain, snow, showers and thunderstorms: anything falling (fog, 45/48, is not). */
export const isPrecip = (c: number | null | undefined) => c != null && c >= 51 && c <= 99;

/** The site and the ring around it, as [lat, lon, label]; the site first. */
export function ringPoints(site: Pick<Site, 'lat' | 'lon'>, ringKm: number): Array<[number, number, string]> {
  const pts: Array<[number, number, string]> = [[site.lat, site.lon, 'site']];
  if (ringKm <= 0) return pts;
  const cosLat = Math.max(0.01, Math.cos((site.lat * Math.PI) / 180));
  RING_BEARINGS.forEach((label, i) => {
    const b = (i * 45 * Math.PI) / 180;
    const lat = Math.max(-89.9, Math.min(89.9, site.lat + (ringKm * Math.cos(b)) / KM_PER_DEG_LAT));
    let lon = site.lon + (ringKm * Math.sin(b)) / (KM_PER_DEG_LAT * cosLat);
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    pts.push([lat, lon, label]);
  });
  return pts;
}

export function forecastUrl(points: Array<[number, number, string]>, lookaheadMin: number, base = DEFAULT_URL): string {
  const q = new URLSearchParams({
    latitude: points.map((p) => p[0].toFixed(4)).join(','),
    longitude: points.map((p) => p[1].toFixed(4)).join(','),
    current: 'precipitation,weather_code,wind_gusts_10m',
    minutely_15: 'precipitation,weather_code,wind_gusts_10m',
    hourly: 'precipitation_probability,weather_code,wind_gusts_10m',
    past_minutely_15: '1',
    forecast_minutely_15: String(Math.ceil(lookaheadMin / 15) + 2),
    past_hours: '1',
    forecast_hours: String(Math.ceil(lookaheadMin / 60) + 2),
    timeformat: 'unixtime',
    timezone: 'GMT',
  });
  return `${base}?${q}`;
}

/** Parse Open-Meteo's answer (one object for one point, an array for several) into points. */
export function parsePoints(raw: unknown, expected: number): Point[] {
  const r = ResponseSchema.safeParse(raw);
  if (!r.success) throw new Error(`Open-Meteo answered in an unexpected shape: ${r.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const pts = Array.isArray(r.data) ? r.data : [r.data];
  if (pts.length !== expected) throw new Error(`Open-Meteo answered ${pts.length} locations for ${expected}`);
  if (!pts[0].minutely_15?.time.length) throw new Error('Open-Meteo sent no 15-minute forecast for the site');
  return pts;
}

const clock = (ms: number, tz: string) => {
  try {
    return new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
};
const kindOf = (code: number | null | undefined): 'snow' | 'rain' => (isSnow(code) ? 'snow' : 'rain');
const fallWord = (code: number | null | undefined) => (isSnow(code) ? 'snow' : isFreezing(code) ? 'freezing rain' : 'precipitation');

/**
 * What the forecast says about the next `lookaheadMin` minutes. 15-minute values are sums over the
 * preceding 15 minutes and hourly ones over the preceding hour, so a value belongs to the window
 * when its period overlaps (now, now + lookahead].
 */
export function assess(points: Point[], labels: string[], nowMs: number, s: GuardSettings, tz: string, u: UnitFormat = unitFormat('metric')): Assessment {
  const now = nowMs / 1000;
  const horizon = now + s.lookaheadMin * 60;
  const overlaps = (end: number, len: number) => end > now && end - len < horizon;
  const hazards: Hazard[] = [];
  const add = (h: Hazard) => {
    if (!hazards.some((x) => x.kind === h.kind && x.level === h.level && x.message === h.message)) hazards.push(h);
  };

  const site = points[0];
  const slots: Slot[] = [];
  let siteMm = 0;
  let maxGust = 0;
  let maxProb = 0;

  // ---- at the site
  const cur = site.current;
  if (cur) {
    const mm = Math.max(0, cur.precipitation ?? 0);
    if (mm >= s.thresholdMm || isPrecip(cur.weather_code)) add({ kind: kindOf(cur.weather_code), level: 'alarm', message: `${fallWord(cur.weather_code)} at the telescope now${mm > 0 ? ` (${u.precip(mm)} in the last 15 min)` : ''}` });
    if (isThunder(cur.weather_code)) add({ kind: 'storm', level: 'alarm', message: 'thunderstorm at the telescope now' });
    maxGust = Math.max(maxGust, cur.wind_gusts_10m ?? 0);
  }
  const m = site.minutely_15;
  let firstWet: Slot | null = null;
  let thunderAt: number | null = null;
  if (m) {
    for (let i = 0; i < m.time.length; i++) {
      const end = m.time[i];
      if (!overlaps(end, SLOT_S)) continue;
      const mm = Math.max(0, m.precipitation[i] ?? 0);
      const code = m.weather_code?.[i] ?? null;
      const slot = { end: end * 1000, mm, code };
      slots.push(slot);
      siteMm += mm;
      maxGust = Math.max(maxGust, m.wind_gusts_10m?.[i] ?? 0);
      if (!firstWet && mm >= s.thresholdMm) firstWet = slot;
      if (thunderAt === null && isThunder(code)) thunderAt = end - SLOT_S;
    }
  }
  if (firstWet) {
    const from = Math.max(nowMs, firstWet.end - SLOT_S * 1000);
    add({ kind: kindOf(firstWet.code), level: 'alarm', message: `${fallWord(firstWet.code)} forecast at the telescope from ${clock(from, tz)} (${u.precip(siteMm)} in the next ${s.lookaheadMin} min)` });
  }
  const h = site.hourly;
  if (h) {
    for (let i = 0; i < h.time.length; i++) {
      const end = h.time[i];
      if (!overlaps(end, HOUR_S)) continue;
      const p = h.precipitation_probability?.[i] ?? 0;
      maxProb = Math.max(maxProb, p);
      maxGust = Math.max(maxGust, h.wind_gusts_10m?.[i] ?? 0);
      if (p >= s.probabilityPct) add({ kind: kindOf(h.weather_code?.[i]), level: 'alarm', message: `${Math.round(p)}% chance of ${fallWord(h.weather_code?.[i])} in the hour to ${clock(end * 1000, tz)}` });
      if (thunderAt === null && isThunder(h.weather_code?.[i])) thunderAt = end - HOUR_S;
    }
  }
  if (thunderAt !== null) add({ kind: 'storm', level: 'alarm', message: `thunderstorm forecast at the telescope from ${clock(Math.max(nowMs, thunderAt * 1000), tz)}` });
  if (maxGust >= s.gustKmh) add({ kind: 'wind', level: 'alarm', message: `gusts to ${u.speed(maxGust)} within ${s.lookaheadMin} min (limit ${u.speed(s.gustKmh)})` });
  else if (maxGust >= s.gustKmh * GUST_WATCH) add({ kind: 'wind', level: 'watch', message: `gusts to ${u.speed(maxGust)}, near the ${u.speed(s.gustKmh)} limit` });

  // ---- the ring: a storm there is a storm here (lightning reaches well past the rain); rain is a watch
  const ringWet: string[] = [];
  const ringStorm: string[] = [];
  let ringFirst: number | null = null;
  for (let p = 1; p < points.length; p++) {
    const pt = points[p];
    let wet = isPrecip(pt.current?.weather_code) || (pt.current?.precipitation ?? 0) >= s.thresholdMm;
    let storm = isThunder(pt.current?.weather_code);
    if (wet) ringFirst = Math.min(ringFirst ?? nowMs, nowMs);
    const pm = pt.minutely_15;
    for (let i = 0; pm && i < pm.time.length; i++) {
      if (!overlaps(pm.time[i], SLOT_S)) continue;
      if ((pm.precipitation[i] ?? 0) >= s.thresholdMm) {
        if (!wet) ringFirst = Math.min(ringFirst ?? Infinity, Math.max(nowMs, (pm.time[i] - SLOT_S) * 1000));
        wet = true;
      }
      if (isThunder(pm.weather_code?.[i])) storm = true;
    }
    const ph = pt.hourly;
    for (let i = 0; ph && i < ph.time.length; i++) if (overlaps(ph.time[i], HOUR_S) && isThunder(ph.weather_code?.[i])) storm = true;
    if (wet) ringWet.push(labels[p]);
    if (storm) ringStorm.push(labels[p]);
  }
  if (ringStorm.length) add({ kind: 'storm', level: 'alarm', message: `thunderstorm forecast within ${u.dist(s.ringKm)} (${ringStorm.join(', ')}) in the next ${s.lookaheadMin} min` });
  if (ringWet.length && !hazards.some((x) => x.level === 'alarm' && (x.kind === 'rain' || x.kind === 'snow'))) {
    add({ kind: 'rain', level: 'watch', message: `precipitation forecast ${u.dist(s.ringKm)} ${ringWet.join(', ')}${ringFirst !== null ? ` from ${clock(ringFirst, tz)}` : ''}, not yet at the telescope` });
  }

  const level = hazards.some((x) => x.level === 'alarm') ? 'alarm' : hazards.length ? 'watch' : 'clear';
  return { level, hazards, slots, siteMm: Math.round(siteMm * 100) / 100, maxProbability: Math.round(maxProb), maxGustKmh: Math.round(maxGust), grid: { lat: site.latitude, lon: site.longitude } };
}

export interface Alarm {
  /** when it first sounded, ISO */
  since: string;
  kinds: HazardKind[];
  message: string;
  /** when the user silenced it, ISO; null while it sounds */
  acknowledgedAt: string | null;
}

export interface GuardStatus {
  armed: boolean;
  armedAt: string | null;
  state: 'disarmed' | 'starting' | 'clear' | 'watch' | 'alarm' | 'fault';
  /** the alarm should be sounding on every device that listens */
  sounding: boolean;
  alarm: Alarm | null;
  assessment: Assessment | null;
  /** last successful check, ISO */
  lastCheck: string | null;
  lastAttempt: string | null;
  lastError: string | null;
  nextCheck: string | null;
  site: { lat: number; lon: number } | null;
  settings: GuardSettings;
  pollSec: number;
  faultAfterMin: number;
}

interface Persisted {
  armed: boolean;
  armedAt: string | null;
  settings: GuardSettings;
}

export interface GuardOptions {
  site: () => Site | null;
  tz: () => string;
  /** where the armed state and the settings are kept */
  file?: string;
  fetch?: Fetch;
  now?: () => number;
  url?: string;
  /** how the messages state amounts (metric by default) */
  units?: () => Units;
}

export class RainGuard extends EventEmitter {
  private armed = false;
  private armedAt: number | null = null;
  /** the fault clock starts here: arming, or the restart that resumed an armed guard */
  private watchFrom = 0;
  private settingsV: GuardSettings = { ...GUARD_DEFAULTS };
  private alarm: { since: number; kinds: HazardKind[]; message: string; ackedAt: number | null } | null = null;
  private assessment: Assessment | null = null;
  private lastOk: number | null = null;
  private lastAttempt: number | null = null;
  private lastError: string | null = null;
  private nextAt: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private inFlight: Promise<GuardStatus> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: GuardOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.load();
  }

  get settings(): GuardSettings {
    return this.settingsV;
  }

  /** Resume an armed guard (after a restart). */
  start(): void {
    if (!this.armed) return;
    log.info('rain guard was armed before the restart: monitoring again');
    this.startTimers();
    void this.check();
  }

  status(): GuardStatus {
    const s = this.opts.site();
    const a = this.alarm;
    const faulted = !!a?.kinds.includes('fault');
    const state: GuardStatus['state'] = !this.armed ? 'disarmed' : faulted && a?.kinds.length === 1 ? 'fault' : a ? 'alarm' : !this.assessment ? 'starting' : this.assessment.level === 'watch' ? 'watch' : this.assessment.level === 'alarm' ? 'alarm' : 'clear';
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      armed: this.armed,
      armedAt: iso(this.armedAt),
      state,
      sounding: !!a && a.ackedAt === null,
      alarm: a ? { since: new Date(a.since).toISOString(), kinds: a.kinds, message: a.message, acknowledgedAt: iso(a.ackedAt) } : null,
      assessment: this.assessment,
      lastCheck: iso(this.lastOk),
      lastAttempt: iso(this.lastAttempt),
      lastError: this.lastError,
      nextCheck: this.armed ? iso(this.nextAt) : null,
      site: s ? { lat: s.lat, lon: s.lon } : null,
      settings: this.settingsV,
      pollSec: POLL_MS / 1000,
      faultAfterMin: FAULT_AFTER_MS / 60e3,
    };
  }

  async arm(): Promise<GuardStatus> {
    if (!this.opts.site()) throw new Error('the observer location is unknown: set OBSERVER_LATITUDE/LONGITUDE or connect the telescope');
    if (!this.armed) {
      this.armed = true;
      this.armedAt = this.now();
      this.watchFrom = this.armedAt;
      this.alarm = null;
      this.assessment = null;
      this.save();
      log.info('rain guard armed');
      this.startTimers();
    }
    return this.check();
  }

  disarm(): GuardStatus {
    if (this.armed) log.info('rain guard disarmed');
    this.armed = false;
    this.armedAt = null;
    this.alarm = null;
    this.nextAt = null;
    this.stopTimers();
    this.save();
    return this.changed();
  }

  /** Silence the alarm on every device; it sounds again if the danger outlasts SNOOZE_MS. */
  acknowledge(): GuardStatus {
    if (this.alarm && this.alarm.ackedAt === null) {
      this.alarm.ackedAt = this.now();
      log.info('rain guard alarm acknowledged');
    }
    return this.changed();
  }

  saveSettings(next: Partial<GuardSettings>): GuardStatus {
    this.settingsV = GuardSettingsSchema.parse({ ...this.settingsV, ...next });
    this.save();
    if (this.armed) void this.check();
    return this.changed();
  }

  /** Check now (one at a time: concurrent callers share the check in flight). */
  check(): Promise<GuardStatus> {
    this.inFlight ??= this.runCheck().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  close(): void {
    this.stopTimers();
  }

  private async runCheck(): Promise<GuardStatus> {
    const site = this.opts.site();
    this.lastAttempt = this.now();
    const tz = this.opts.tz();
    try {
      if (!site) throw new Error('the observer location is unknown');
      const pts = ringPoints(site, this.settingsV.ringKm);
      const raw = await getJson(forecastUrl(pts, this.settingsV.lookaheadMin, this.opts.url), { fetch: this.opts.fetch, deadlineMs: 60_000 });
      const a = assess(parsePoints(raw, pts.length), pts.map((p) => p[2]), this.now(), this.settingsV, tz, unitFormat(this.opts.units?.() ?? 'metric'));
      this.assessment = a;
      this.lastOk = this.now();
      this.lastError = null;
      if (this.armed) this.apply(a);
    } catch (err) {
      this.lastError = errMsg(err);
      log.warn(`rain guard check failed: ${this.lastError}`);
      if (this.armed) this.checkFault();
    }
    if (this.armed) this.schedule(this.lastError ? RETRY_MS : POLL_MS);
    return this.changed();
  }

  /** Turn a fresh assessment into the alarm: raise, escalate, re-sound after the snooze, or clear. */
  private apply(a: Assessment): void {
    const now = this.now();
    const danger = a.hazards.filter((h) => h.level === 'alarm');
    const kinds = [...new Set(danger.map((h) => h.kind))];
    const message = danger.map((h) => h.message).join('; ');
    const al = this.alarm;
    if (kinds.length) {
      if (!al) {
        this.alarm = { since: now, kinds, message, ackedAt: null };
        log.warn(`RAIN GUARD ALARM: ${message}`);
        return;
      }
      const fresh = kinds.some((k) => !al.kinds.includes(k));
      if (al.ackedAt !== null && (fresh || now - al.ackedAt >= SNOOZE_MS)) {
        al.ackedAt = null;
        log.warn(`RAIN GUARD ALARM again: ${message}`);
      }
      al.kinds = kinds;
      al.message = message;
      return;
    }
    if (!al) return;
    // A fault ends when checks succeed again; a weather alarm nobody has acknowledged keeps sounding
    // (the user has to learn that rain was coming even if the forecast has since cleared).
    if (al.ackedAt !== null || al.kinds.every((k) => k === 'fault')) {
      this.alarm = null;
      log.info('rain guard: conditions clear, alarm ended');
    } else {
      al.kinds = al.kinds.filter((k) => k !== 'fault');
      if (!al.message.includes('since cleared')) al.message = `${al.message} (the forecast has since cleared)`;
    }
  }

  private checkFault(): void {
    if (!this.armed) return;
    const since = Math.max(this.lastOk ?? 0, this.watchFrom);
    const quiet = this.now() - since;
    if (quiet < FAULT_AFTER_MS) return;
    const message = `no forecast for ${Math.round(quiet / 60e3)} min: the guard cannot see the weather${this.lastError ? ` (${this.lastError})` : ''}`;
    if (!this.alarm) {
      this.alarm = { since: this.now(), kinds: ['fault'], message, ackedAt: null };
      log.error(`RAIN GUARD FAULT: ${message}`);
    } else if (!this.alarm.kinds.includes('fault')) {
      this.alarm.kinds.push('fault');
      this.alarm.message = `${this.alarm.message}; ${message}`;
      this.alarm.ackedAt = null;
    } else if (this.alarm.ackedAt !== null && this.now() - this.alarm.ackedAt >= SNOOZE_MS) {
      this.alarm.ackedAt = null;
    }
  }

  private schedule(ms: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.nextAt = this.now() + ms;
    this.pollTimer = setTimeout(() => void this.check(), ms);
    this.pollTimer.unref();
  }

  private startTimers(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const before = JSON.stringify(this.alarm);
      this.checkFault();
      // a poll timer that never fired (a stalled event loop, a suspended host) is restarted here
      if (this.armed && !this.inFlight && this.nextAt !== null && this.now() > this.nextAt + WATCHDOG_MS) void this.check();
      if (JSON.stringify(this.alarm) !== before) this.changed();
    }, WATCHDOG_MS);
    this.watchdog.unref();
  }

  private stopTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.pollTimer = null;
    this.watchdog = null;
  }

  private changed(): GuardStatus {
    const s = this.status();
    this.emit('state', s);
    return s;
  }

  private load(): void {
    if (!this.opts.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8')) as Partial<Persisted>;
      const settings = GuardSettingsSchema.safeParse({ ...GUARD_DEFAULTS, ...(raw.settings ?? {}) });
      if (settings.success) this.settingsV = settings.data;
      this.armed = raw.armed === true;
      const at = raw.armedAt ? Date.parse(raw.armedAt) : NaN;
      this.armedAt = this.armed ? (Number.isFinite(at) ? at : this.now()) : null;
      this.watchFrom = this.now();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${this.opts.file}: ${errMsg(err)}`);
    }
  }

  private save(): void {
    if (!this.opts.file) return;
    const p: Persisted = { armed: this.armed, armedAt: this.armedAt === null ? null : new Date(this.armedAt).toISOString(), settings: this.settingsV };
    try {
      writeFileAtomic(this.opts.file, `${JSON.stringify(p, null, 2)}\n`);
    } catch (err) {
      log.warn(`could not save the rain guard state: ${errMsg(err)}`);
    }
  }
}
