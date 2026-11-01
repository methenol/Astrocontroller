/**
 * What was measured from this unit's own frames, kept across restarts (<data>/acquisition.json):
 *
 * - per device (model id + serial) and gain: conversion gain, read noise, black level, dark current,
 *   and the ADU at which the files clip;
 * - the site's sky: each clear-sky sub cohort's background, turned into the zenith, moonless sky
 *   brightness it implies (the number that replaces PLAN_BORTLE once a few agree);
 * - the stars' FWHM, against the forecast's seeing at the time.
 *
 * The planner reads it through `sensorProfile`, `siteSky` and `siteSeeing`; acquisition_measure writes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { writeFileAtomic } from '../../util/fs.js';
import { median } from '../../util/stats.js';

const log = logger('acquisition');

export interface SensorMeasurement {
  gain: number;
  ePerAdu?: number;
  readNoiseAdu?: number;
  blackAdu?: number;
  /** the exposure the black level was read at (its dark current is in it); 0 or absent: a pure offset */
  blackAtS?: number;
  darkEPerS?: number;
  at: number;
  frames: number;
  how: string;
}

export interface SensorProfile {
  gains: Record<string, SensorMeasurement>;
  blackAdu?: number;
  saturationAdu?: number;
}

export interface SkySample {
  at: number;
  device: string;
  filter: string;
  gain: number;
  subS: number;
  /** background above black, ADU per second, as measured */
  rateAduPerS: number;
  /** sky brightness where the scope pointed, mag/arcsec² */
  sqmThere: number;
  /** the zenith, moonless sky it implies */
  zenithSqm: number;
  altDeg: number;
  moonAltDeg: number;
  /** moon down, the target high, astronomical dark: fit to stand for the site */
  trusted: boolean;
}

export interface SeeingSample {
  at: number;
  device: string;
  fwhmArcsec: number;
  roundness?: number;
  seeingIdx?: number;
  altDeg?: number;
}

interface StoreFile {
  sensors: Record<string, SensorProfile>;
  sky: SkySample[];
  seeing: SeeingSample[];
}

const KEEP_SKY = 300;
const KEEP_SEEING = 300;
/** samples the site's sky needs before it replaces PLAN_BORTLE */
export const SITE_SKY_MIN_SAMPLES = 3;
/** only the last this many days of sky samples stand for the site (seasons, new lights) */
const SITE_SKY_DAYS = 120;

const file = () => path.join(config.paths.data, 'acquisition.json');
let memo: StoreFile | null = null;

function load(): StoreFile {
  if (memo) return memo;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<StoreFile>;
    memo = { sensors: raw.sensors ?? {}, sky: Array.isArray(raw.sky) ? raw.sky : [], seeing: Array.isArray(raw.seeing) ? raw.seeing : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`acquisition.json unreadable, starting empty: ${errMsg(err)}`);
    memo = { sensors: {}, sky: [], seeing: [] };
  }
  return memo;
}

function save(): void {
  const s = load();
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(s, null, 1));
}

/** For tests: forget what was read. */
export function resetStoreCache(): void {
  memo = null;
}

/** The key measurements are kept under: the model, and the unit when its serial is known. */
export const deviceKey = (id: string, serial?: string) => (serial ? `${id}:${serial}` : id);

/** This unit's measured sensor, else the model's (measured on a unit whose serial was not known). */
export function sensorProfile(id: string, serial?: string): SensorProfile | undefined {
  const s = load().sensors;
  return (serial ? s[deviceKey(id, serial)] : undefined) ?? s[id];
}

export function recordSensor(id: string, serial: string | undefined, m: SensorMeasurement, extra: { blackAdu?: number; saturationAdu?: number } = {}): SensorProfile {
  const s = load();
  const key = deviceKey(id, serial);
  const p = (s.sensors[key] ??= { gains: {} });
  const prev = p.gains[String(m.gain)];
  // a measurement without a figure keeps the earlier one's
  p.gains[String(m.gain)] = { ...prev, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) } as SensorMeasurement;
  if (extra.blackAdu !== undefined) p.blackAdu = extra.blackAdu;
  if (extra.saturationAdu !== undefined) p.saturationAdu = Math.max(p.saturationAdu ?? 0, extra.saturationAdu);
  save();
  return p;
}

export function recordSky(sample: SkySample): void {
  const s = load();
  s.sky.push(sample);
  if (s.sky.length > KEEP_SKY) s.sky.splice(0, s.sky.length - KEEP_SKY);
  save();
}

export function recordSeeing(sample: SeeingSample): void {
  const s = load();
  s.seeing.push(sample);
  if (s.seeing.length > KEEP_SEEING) s.seeing.splice(0, s.seeing.length - KEEP_SEEING);
  save();
}

/** The site's measured zenith sky (median of the trusted samples of the last months), or null with too few. */
export function siteSky(now = Date.now()): { sqm: number; samples: number; spread: number } | null {
  const recent = load().sky.filter((x) => x.trusted && now - x.at < SITE_SKY_DAYS * 86400e3).map((x) => x.zenithSqm);
  if (recent.length < SITE_SKY_MIN_SAMPLES) return null;
  const m = median(recent);
  return { sqm: m, samples: recent.length, spread: median(recent.map((x) => Math.abs(x - m))) };
}

/**
 * The FWHM this rig gets at this site: the median of its measured samples, and how it moves with
 * the forecast's seeing index when samples cover more than one index.
 */
export function siteSeeing(device: string): { fwhmArcsec: number; samples: number; byIdx: Record<string, number> } | null {
  const rows = load().seeing.filter((x) => x.device === device || x.device.startsWith(`${device}:`) || device.startsWith(`${x.device}:`));
  if (rows.length < 3) return null;
  const byIdx: Record<string, number> = {};
  for (const idx of new Set(rows.map((r) => r.seeingIdx).filter((i): i is number => i !== undefined))) {
    const v = rows.filter((r) => r.seeingIdx === idx).map((r) => r.fwhmArcsec);
    if (v.length >= 2) byIdx[String(idx)] = Math.round(median(v) * 100) / 100;
  }
  return { fwhmArcsec: median(rows.map((r) => r.fwhmArcsec)), samples: rows.length, byIdx };
}

export function storeView(): StoreFile {
  return load();
}

/** Forget measurements: one gain of a device, a whole device, or the site's sky / seeing samples. */
export function forget(what: { device?: string; gain?: number; sky?: boolean; seeing?: boolean }): string[] {
  const s = load();
  const done: string[] = [];
  if (what.device) {
    for (const key of Object.keys(s.sensors).filter((k) => k === what.device || k.startsWith(`${what.device}:`))) {
      if (what.gain !== undefined) {
        if (delete s.sensors[key].gains[String(what.gain)]) done.push(`${key} gain ${what.gain}`);
      } else {
        delete s.sensors[key];
        done.push(key);
      }
    }
  }
  if (what.sky) {
    done.push(`${s.sky.length} sky samples`);
    s.sky = [];
  }
  if (what.seeing) {
    done.push(`${s.seeing.length} seeing samples`);
    s.seeing = [];
  }
  save();
  return done;
}
