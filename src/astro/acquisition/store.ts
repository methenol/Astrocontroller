/**
 * What was measured from this unit's own frames, kept across restarts (<data>/acquisition.json):
 *
 * - per device (model id + serial) and gain: conversion gain, read noise, black level, dark current,
 *   and the ADU at which the files clip;
 * - the site's sky: each clear-sky sub cohort's background, turned into the zenith, moonless sky
 *   brightness it implies (the number that replaces PLAN_BORTLE once a few agree);
 * - the stars' FWHM, against the forecast's seeing at the time;
 * - sub-length analyses (sublength.ts): per filter, gain and sub, the sky noise a sub really gets
 *   against the read noise — the swamp factor — and the sky-noise rate the plan scales its model by;
 * - the collection quality engine's samples (quality.ts): per target, the test cohorts shot at
 *   chosen filter / gain / sub settings and what each measured, from which it solves the settings.
 *
 * The planner reads it through `sensorProfile`, `siteSky`, `siteSeeing` and `latestSubLength`;
 * acquisition_measure and sub_length write it.
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

export interface SubLengthSample {
  at: number;
  device: string;
  filter: string;
  gain: number;
  subS: number;
  /** the light frame analysed */
  frame: string;
  narrowband: boolean;
  /** the read noise the analysis ran against, ADU, and where it came from */
  readNoiseAdu: number;
  readNoiseSource: string;
  /** the sky's noise in the sub (E1, ex-Gaussian), ADU */
  skyNoiseAdu: number;
  /** the sky's variance per second, ADU²/s: swamp at another sub = this × sub / RN² */
  skyVarAduPerS: number;
  /** the sky above the offset, ADU/s */
  skyAduPerS: number;
  /** sky noise² / read noise² at this sub */
  swamp: number;
  /** sky noise / total noise, 0–1 */
  efficiency: number;
  /**
   * the measured sky variance rate in e²/s over the planner's model sky e⁻/s at the frame's pointing
   * and time: the factor the plan scales its sky-noise term by (null without a pointing)
   */
  skyNoiseScale: number | null;
}

/** The conditions one quality sample was shot under (what its numbers are rescaled from). */
export interface QualityConditions {
  altDeg: number;
  azDeg: number;
  /** the Moon toward the target: its altitude, its separation, its illuminated share (0–1) */
  moonAltDeg: number | null;
  moonSepDeg: number | null;
  moonIllum: number | null;
  sunAltDeg: number | null;
  mount: 'eq' | 'alt-az';
  transparencyIdx?: number;
  observability?: number;
  windKmh?: number;
}

/** One test cohort of the collection quality engine: N subs at one filter, gain and sub length. */
export interface QualitySample {
  id: string;
  at: number;
  device: string;
  /** targetKey of the target */
  target: string;
  targetName: string;
  filter: string;
  gain: number;
  subS: number;
  frames: string[];
  /** a probe the engine shot, or measurements the agent submitted from subs it already had */
  source: 'probe' | 'submitted';
  /** false: cloud, an obstruction, a failed capture — the point is a gap to fill */
  valid: boolean;
  invalidWhy?: string;
  /** sky above the offset, ADU/s, and its noise variance rate, ADU²/s (sub_length's E1) */
  skyAduPerS: number;
  skyVarAduPerS: number;
  readNoiseAdu: number;
  ePerAdu: number;
  swamp: number;
  efficiency: number;
  /** the background in the sub, % of the range above black; pixels clipped beyond stars, % */
  backgroundPct: number;
  clippedPct: number;
  stars: number;
  fwhmArcsec?: number;
  roundness?: number;
  /** the sky through the filter where the scope pointed: measured, and what the model predicts there (with and without the Moon) */
  skyMag: number | null;
  modelSkyMag: number | null;
  modelMoonlessMag: number | null;
  cond: QualityConditions;
  notes?: string[];
}

interface StoreFile {
  sensors: Record<string, SensorProfile>;
  sky: SkySample[];
  seeing: SeeingSample[];
  subLength: SubLengthSample[];
  quality: QualitySample[];
}

const KEEP_SKY = 300;
const KEEP_SEEING = 300;
const KEEP_SUBLENGTH = 200;
const KEEP_QUALITY = 600;
/** a sub-length sample older than this no longer calibrates the plan (lights, seasons, firmware) */
const SUBLENGTH_DAYS = 180;
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
    memo = { sensors: raw.sensors ?? {}, sky: Array.isArray(raw.sky) ? raw.sky : [], seeing: Array.isArray(raw.seeing) ? raw.seeing : [], subLength: Array.isArray(raw.subLength) ? raw.subLength : [], quality: Array.isArray(raw.quality) ? raw.quality : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`acquisition.json unreadable, starting empty: ${errMsg(err)}`);
    memo = { sensors: {}, sky: [], seeing: [], subLength: [], quality: [] };
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

export function recordSubLength(sample: SubLengthSample): void {
  const s = load();
  s.subLength.push(sample);
  if (s.subLength.length > KEEP_SUBLENGTH) s.subLength.splice(0, s.subLength.length - KEEP_SUBLENGTH);
  save();
}

export function recordQuality(sample: QualitySample): void {
  const s = load();
  s.quality.push(sample);
  if (s.quality.length > KEEP_QUALITY) s.quality.splice(0, s.quality.length - KEEP_QUALITY);
  save();
}

/** Every quality sample of a target on a device, oldest first. */
export function qualitySamples(device: string, target: string): QualitySample[] {
  return load()
    .quality.filter((x) => sameDevice(x.device, device) && x.target === target)
    .sort((a, b) => a.at - b.at);
}

/** Forget a target's quality samples on a device (all targets without one); returns how many. */
export function forgetQuality(device: string, target?: string): number {
  const s = load();
  const before = s.quality.length;
  s.quality = s.quality.filter((x) => !(sameDevice(x.device, device) && (target === undefined || x.target === target)));
  save();
  return before - s.quality.length;
}

const sameDevice = (a: string, b: string) => a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);

/** The newest sub-length analysis of this device through a filter at a gain (any sub length), within SUBLENGTH_DAYS. */
export function latestSubLength(device: string, filter: string, gain: number, now = Date.now()): SubLengthSample | undefined {
  const key = (f: string) => f.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rows = load().subLength.filter((x) => sameDevice(x.device, device) && key(x.filter) === key(filter) && x.gain === gain && now - x.at < SUBLENGTH_DAYS * 86400e3);
  return rows.length ? rows.reduce((a, b) => (b.at > a.at ? b : a)) : undefined;
}

/** Every sub-length analysis of a device, newest first. */
export function subLengthSamples(device: string): SubLengthSample[] {
  return load()
    .subLength.filter((x) => sameDevice(x.device, device))
    .sort((a, b) => b.at - a.at);
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
export function forget(what: { device?: string; gain?: number; sky?: boolean; seeing?: boolean; subLength?: boolean }): string[] {
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
  if (what.subLength) {
    const mine = what.device ? s.subLength.filter((x) => sameDevice(x.device, what.device!)) : s.subLength;
    done.push(`${mine.length} sub-length samples`);
    s.subLength = s.subLength.filter((x) => !mine.includes(x));
  }
  save();
  return done;
}
