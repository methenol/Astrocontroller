/**
 * The smart telescopes the acquisition planner knows: one JSON file per model. The shipped ones are
 * in devices/ (DEVICES_DIR); the owner adds a model, or corrects a shipped one, by dropping a file
 * with the same schema into <data>/devices/ — a file there with a shipped id replaces that model.
 *
 * A spec is a prior. What the scope reports while connected (its optics, its EQ mode, the gain and
 * the filters it really has) overrides it, and what was measured from this unit's own frames
 * (store.ts) overrides the sensor figures. `resolveRig` folds the three into the one rig the
 * planner computes with, and says where each number came from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { classifyFilter, F_BAND, type BandClass } from '../detect.js';
import { sensorProfile, type SensorMeasurement } from './store.js';

const log = logger('devices');

const pos = z.number().positive();
const Anchor = z.object({ gain: z.number().min(0), value: pos });
const BAND = z.enum(['broadband', 'uhc', 'duo_wide', 'duo_tight', 'line']);

const FilterSchema = z.object({
  /** the name the driver's tools take (IRCUT, LP, Duo-Band…) */
  name: z.string().min(1),
  /** other spellings, PLAN_FILTERS' names among them */
  aliases: z.array(z.string()).default([]),
  band: BAND,
  /** the share of a broadband sky this filter passes; the band's default when omitted */
  skyFraction: z.number().gt(0).max(1).optional(),
  passband: z.string().optional(),
  /** false for glass meant for daytime (a VIS filter that cuts Hα) */
  deepSky: z.boolean().default(true),
});

export const DeviceSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case letters, digits and dashes'),
  name: z.string().min(1),
  maker: z.string().default(''),
  driver: z.enum(['dwarf', 'seestar', 'other']),
  /** lower-case pieces of the model name the scope reports; the longest match wins */
  match: z.array(z.string()).default([]),
  optics: z.object({ apertureMm: pos, focalLengthMm: pos, design: z.string().optional() }),
  /** the wide-angle lens, where the scope has one and its field is known */
  wide: z.object({ focalLengthMm: pos.optional(), hFovDeg: pos, vFovDeg: pos }).optional(),
  sensor: z.object({
    name: z.string(),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    pixelUm: pos,
    bitDepth: z.number().int().min(8).max(16),
    /** the value a saturated pixel has in the raw files */
    dataMaxAdu: pos,
    blackLevelAdu: z.number().min(0).default(0),
    qe: z.number().gt(0).max(1).default(0.8),
    fullWellE: pos,
    /** how e⁻/ADU moves with the gain number: 0.1dB (ZWO: ×10^(−g/200)) or linear (∝ 1/gain) */
    gainUnit: z.enum(['0.1dB', 'linear']),
    /** electrons per ADU of the raw files at a gain; one anchor is enough, more are interpolated */
    ePerAdu: z.array(Anchor).min(1),
    /** read noise in electrons at a gain (interpolated, flat beyond the ends) */
    readNoiseE: z.array(Anchor).min(1),
    darkCurrentEPerS: z.number().min(0).default(0.02),
    bayer: z.string().optional(),
  }),
  gain: z.object({
    /** false when the firmware sets the stack gain itself (the Seestar's app has no gain control) */
    settable: z.boolean(),
    default: z.number().min(0),
    min: z.number().min(0),
    max: z.number().min(0),
    options: z.array(z.number().min(0)).optional(),
  }),
  exposure: z.object({
    altAzS: z.array(pos).min(1),
    eqS: z.array(pos).default([]),
    /** offered in EQ only when the firmware says so (the Seestar's exp_ms.more_exposure) */
    eqExtendedS: z.array(pos).default([]),
    /** the firmware refuses a sub without a dark master of its exposure and gain */
    requiresMatchingDarks: z.boolean().default(false),
    perSubOverheadS: z.number().min(0).default(1),
  }),
  dither: z.object({
    everySubs: z.number().int().positive(),
    /** seconds a dither adds (settling), and subs it discards */
    costS: z.number().min(0).default(0),
    costSubs: z.number().min(0).default(0),
    /** from this sub length the interval is everySubsLong */
    longFromS: pos.optional(),
    everySubsLong: z.number().int().positive().optional(),
  }),
  mount: z.object({ eqCapable: z.boolean().default(false) }),
  /** the mosaic the firmware can run by itself; without it, mosaics are panel-by-panel GoTo */
  mosaic: z
    .object({
      native: z.object({
        maxScaleX: pos,
        maxScaleY: pos,
        requiresEq: z.boolean().default(false),
        /** the protocol's integer per 1× of frame, where the protocol takes integers */
        wireScale: pos.optional(),
        /** true once the scale units have been confirmed on the hardware */
        verified: z.boolean().default(false),
      }),
    })
    .optional(),
  filters: z.array(FilterSchema).min(1),
  sources: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export type DeviceSpec = z.infer<typeof DeviceSpecSchema>;
export type DeviceFilter = z.infer<typeof FilterSchema>;

/** What a driver can say about its scope while connected; every field optional. */
export interface LiveFacts {
  driver: 'dwarf' | 'seestar';
  model?: string;
  serial?: string;
  focalLengthMm?: number;
  apertureMm?: number;
  pixelUm?: number;
  /** [width, height] of the sensor */
  chip?: [number, number];
  eqMode?: boolean;
  /** the gain the stack runs at now */
  gain?: number;
  gainRange?: [number, number];
  gainOptions?: number[];
  /** sub lengths the device offers now (a Dwarf reads them from its parameter schema) */
  exposureOptionsS?: number[];
  /** Seestar: 90/120 s offered in EQ */
  moreExposure?: boolean;
  /** the filter names the wheel holds */
  filterSlots?: string[];
  /** dark masters on the device, when it needs matching ones */
  darks?: Array<{ exposureS: number; gain?: number }>;
}

let cache: { at: number; specs: Map<string, DeviceSpec & { file: string; user: boolean }>; errors: string[] } | null = null;
const CACHE_MS = 30_000;

export const userDevicesDir = () => path.join(config.paths.data, 'devices');

function readDir(dir: string, user: boolean, into: Map<string, DeviceSpec & { file: string; user: boolean }>, errors: string[]): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const parsed = DeviceSpecSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) {
        errors.push(`${file}: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        continue;
      }
      into.set(parsed.data.id, { ...parsed.data, file, user });
    } catch (err) {
      errors.push(`${file}: ${errMsg(err)}`);
    }
  }
}

/** Every known model: the shipped files, then the owner's (which replace a shipped id). */
export function loadDevices(force = false): { specs: Array<DeviceSpec & { file: string; user: boolean }>; errors: string[] } {
  if (force || !cache || Date.now() - cache.at > CACHE_MS) {
    const specs = new Map<string, DeviceSpec & { file: string; user: boolean }>();
    const errors: string[] = [];
    readDir(config.paths.devices, false, specs, errors);
    readDir(userDevicesDir(), true, specs, errors);
    for (const e of errors) log.warn(`device spec skipped: ${e}`);
    cache = { at: Date.now(), specs, errors };
  }
  return { specs: [...cache.specs.values()], errors: cache.errors };
}

export function deviceById(id: string): (DeviceSpec & { file: string; user: boolean }) | undefined {
  return loadDevices().specs.find((s) => s.id === id.trim().toLowerCase());
}

const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();

/**
 * Which model this is: PLAN_DEVICE when set, else the longest `match` piece found in the model name
 * the scope reports, else the model of the driver whose optics (focal length, sensor) fit what the
 * scope reports, else the driver's first model. `why` says which.
 */
export function pickDevice(facts: Partial<LiveFacts> & { driver: LiveFacts['driver'] }): { spec: DeviceSpec; why: string } {
  const { specs } = loadDevices();
  if (!specs.length) throw new Error(`no device spec files in ${config.paths.devices} or ${userDevicesDir()}`);
  if (config.plan.device) {
    const s = deviceById(config.plan.device);
    if (s) return { spec: s, why: 'PLAN_DEVICE' };
    log.warn(`PLAN_DEVICE=${config.plan.device} names no device spec; picking one from the scope`);
  }
  const ofDriver = specs.filter((s) => s.driver === facts.driver);
  if (facts.model) {
    const model = norm(facts.model);
    let best: { spec: DeviceSpec; len: number } | null = null;
    for (const s of ofDriver) {
      for (const m of s.match) {
        const piece = norm(m);
        if (piece && model.includes(piece) && (!best || piece.length > best.len)) best = { spec: s, len: piece.length };
      }
    }
    if (best) return { spec: best.spec, why: `the scope reports "${facts.model}"` };
  }
  if (facts.focalLengthMm || facts.chip) {
    const fits = ofDriver.filter((s) => {
      const fl = !facts.focalLengthMm || Math.abs(s.optics.focalLengthMm - facts.focalLengthMm) <= 5;
      const chip = !facts.chip || Math.max(...facts.chip) === Math.max(s.sensor.widthPx, s.sensor.heightPx);
      return fl && chip;
    });
    if (fits.length) return { spec: fits[0], why: `its optics (${facts.focalLengthMm ?? '?'} mm, ${facts.chip?.join('×') ?? '?'} px) match` };
  }
  const fallback = ofDriver[0] ?? specs[0];
  return { spec: fallback, why: `no model reported: the ${facts.driver} driver's first spec` };
}

/** Linear interpolation over anchors, flat beyond the ends. */
export function interp(anchors: Array<{ gain: number; value: number }>, gain: number): number {
  const a = [...anchors].sort((x, y) => x.gain - y.gain);
  if (gain <= a[0].gain) return a[0].value;
  for (let i = 1; i < a.length; i++) {
    if (gain <= a[i].gain) {
      const f = (gain - a[i - 1].gain) / (a[i].gain - a[i - 1].gain);
      return a[i - 1].value + f * (a[i].value - a[i - 1].value);
    }
  }
  return a[a.length - 1].value;
}

export type Source = 'measured' | 'device' | 'spec' | 'env';

/** A sensor at one gain: what the noise and headroom model needs, with where each number came from. */
export interface SensorAtGain {
  gain: number;
  ePerAdu: number;
  readNoiseE: number;
  blackAdu: number;
  /** ADU of a saturated pixel in the files */
  saturationAdu: number;
  /** electrons a pixel holds before it clips: the ADC's range or the well, whichever is less */
  fullWellE: number;
  darkCurrentEPerS: number;
  source: { ePerAdu: Source; readNoise: Source; black: Source; saturation: Source };
}

export interface Rig {
  spec: DeviceSpec;
  why: string;
  serial?: string;
  apertureMm: number;
  focalLengthMm: number;
  pixelUm: number;
  widthPx: number;
  heightPx: number;
  plateScale: number;
  fovDeg: { w: number; h: number };
  /** QE × optics transmission: electrons per V-band photon on a pixel */
  throughput: number;
  mount: 'eq' | 'alt-az';
  guided: boolean;
  gains: number[];
  gainSettable: boolean;
  /** sub lengths on offer in this mount mode */
  subsS: number[];
  filters: Array<DeviceFilter & { skyFraction: number }>;
  darks?: LiveFacts['darks'];
  sensorAt(gain: number): SensorAtGain;
  sources: { optics: Source; mount: Source; gain: Source; exposures: Source; filters: Source };
  /** what a measurement would sharpen */
  missing: string[];
}

/**
 * Electrons per V-band photon a pixel gets: QE × the optics' transmission. Each Bayer pixel sees about
 * a V-band's width of spectrum through its own colour, so the V-band zero point applies per pixel
 * as is. Checked against the S50 Pro's own subs (2026-10-27, 95% Moon 43° from M 31): the sky came
 * out within 1.6× of Krisciunas & Schaefer's and M 31's nucleus at ~16.3 mag/arcsec².
 */
const OPTICS_TRANSMISSION = 0.85;

/** The filter slot matching a name (its name or an alias, ignoring case and punctuation). */
export function findFilter<T extends DeviceFilter>(filters: T[], name: string | undefined): T | undefined {
  if (!name) return undefined;
  const want = filterKey(name);
  return filters.find((f) => filterKey(f.name) === want || f.aliases.some((a) => filterKey(a) === want));
}

const filterKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * One name for a filter, whichever device or record named it: the spec filter it is the name or an
 * alias of ("dual band" → "duoband", "IR-cut" → "ircut"), a label with a note in brackets as its
 * first part (the Dwarf's "Duo-Band (Ha/OIII)"), else the name itself without case or punctuation.
 */
export function filterId(name: string): string {
  const all = loadDevices().specs.flatMap((s) => s.filters);
  for (const n of [name, name.replace(/\s*\(.*\)\s*$/, '')]) {
    const want = filterKey(n);
    const f = all.find((x) => filterKey(x.name) === want) ?? all.find((x) => x.aliases.some((a) => filterKey(a) === want));
    if (f) return filterKey(f.name);
  }
  return filterKey(name);
}

/** Whether two records name the same filter; two that name none count as the same. */
export function sameFilter(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return !a && !b;
  return filterId(a) === filterId(b);
}

/**
 * The rig the planner computes with: the spec, the scope's own report on top, this unit's
 * measurements on top of that, and the owner's .env values (PLAN_APERTURE_MM, PLAN_MOUNT,
 * PLAN_GUIDED, PLAN_READ_NOISE_E) where they set them.
 */
export function resolveRig(facts: Partial<LiveFacts> & { driver: LiveFacts['driver'] }): Rig {
  const { spec, why } = pickDevice(facts);
  const missing: string[] = [];
  const envAperture = config.plan.apertureMm;
  const apertureMm = envAperture ?? facts.apertureMm ?? spec.optics.apertureMm;
  const focalLengthMm = facts.focalLengthMm ?? spec.optics.focalLengthMm;
  const pixelUm = facts.pixelUm ?? spec.sensor.pixelUm;
  const [wPx, hPx] = facts.chip ? [Math.max(...facts.chip), Math.min(...facts.chip)] : [spec.sensor.widthPx, spec.sensor.heightPx];
  const plateScale = (206.265 * pixelUm) / focalLengthMm;
  const fovDeg = { w: (wPx * plateScale) / 3600, h: (hPx * plateScale) / 3600 };
  const throughput = OPTICS_TRANSMISSION * spec.sensor.qe;

  const mount: Rig['mount'] = facts.eqMode !== undefined ? (facts.eqMode ? 'eq' : 'alt-az') : config.plan.mount;
  const guided = mount === 'eq' && config.plan.guided;

  // the gains a stack may run at: the device's list, or the firmware's own when it sets it
  let gains: number[];
  let gainSource: Source = 'spec';
  if (!spec.gain.settable) {
    gains = [facts.gain ?? spec.gain.default];
    gainSource = facts.gain !== undefined ? 'device' : 'spec';
  } else {
    const [lo, hi] = facts.gainRange ?? [spec.gain.min, spec.gain.max];
    const list = facts.gainOptions?.length ? facts.gainOptions : spec.gain.options ?? [spec.gain.default];
    gains = [...new Set(list.filter((g) => g >= lo && g <= hi))].sort((a, b) => a - b);
    if (!gains.length) gains = [Math.min(hi, Math.max(lo, spec.gain.default))];
    gainSource = facts.gainOptions?.length || facts.gainRange ? 'device' : 'spec';
  }

  let subsS: number[];
  let expSource: Source = 'spec';
  if (facts.exposureOptionsS?.length) {
    // the device's own list, cut to what this mount mode allows
    const ceiling = Math.max(...(mount === 'eq' ? [...spec.exposure.eqS, ...spec.exposure.eqExtendedS] : spec.exposure.altAzS));
    subsS = facts.exposureOptionsS.filter((s) => s >= 1 && s <= ceiling);
    expSource = 'device';
  } else {
    subsS = mount === 'eq' ? [...spec.exposure.eqS, ...(facts.moreExposure ? spec.exposure.eqExtendedS : [])] : spec.exposure.altAzS;
    if (mount === 'eq' && !spec.exposure.eqS.length) subsS = spec.exposure.altAzS;
    if (facts.moreExposure !== undefined) expSource = 'device';
  }
  subsS = [...new Set(subsS)].sort((a, b) => a - b);

  // the filters the wheel holds, as the spec describes them (a slot the spec does not know is classified by name)
  let filters = spec.filters;
  let filterSource: Source = 'spec';
  if (facts.filterSlots?.length) {
    const known = facts.filterSlots.map((slot) => findFilter(spec.filters, slot) ?? { name: slot, aliases: [], band: classifyFilter(slot), deepSky: !/dark|solar|sun/i.test(slot) });
    filters = known.filter((f) => !/^dark$/i.test(f.name));
    filterSource = 'device';
  }
  const withFraction = filters.map((f) => ({ ...f, skyFraction: f.skyFraction ?? F_BAND[f.band as BandClass] }));

  const measured = sensorProfile(spec.id, facts.serial);
  const sensorAt = (gain: number): SensorAtGain => {
    const m: SensorMeasurement | undefined = measured?.gains[String(gain)];
    let ePerAdu: number;
    let eSource: Source = 'spec';
    if (m?.ePerAdu) {
      ePerAdu = m.ePerAdu;
      eSource = 'measured';
    } else {
      // the nearest measured gain carried along the sensor's gain law, else the spec's anchors
      const near = measured ? Object.values(measured.gains).filter((x) => x.ePerAdu).sort((a, b) => Math.abs(a.gain - gain) - Math.abs(b.gain - gain))[0] : undefined;
      const anchors = near ? [{ gain: near.gain, value: near.ePerAdu! }] : spec.sensor.ePerAdu;
      if (near) eSource = 'measured';
      const nearest = [...anchors].sort((a, b) => Math.abs(a.gain - gain) - Math.abs(b.gain - gain))[0];
      ePerAdu = anchors.length > 1 && gain >= Math.min(...anchors.map((a) => a.gain)) && gain <= Math.max(...anchors.map((a) => a.gain))
        ? interp(anchors, gain)
        : spec.sensor.gainUnit === '0.1dB'
          ? nearest.value * 10 ** ((nearest.gain - gain) / 200)
          : (nearest.value * nearest.gain) / Math.max(1, gain);
    }
    let readNoiseE = interp(spec.sensor.readNoiseE, gain);
    let rnSource: Source = 'spec';
    if (m?.readNoiseAdu !== undefined) {
      readNoiseE = m.readNoiseAdu * ePerAdu;
      rnSource = 'measured';
    } else if (config.plan.readNoiseE !== null && gain === (facts.gain ?? spec.gain.default)) {
      readNoiseE = config.plan.readNoiseE;
      rnSource = 'env';
    }
    const blackAdu = m?.blackAdu ?? measured?.blackAdu ?? spec.sensor.blackLevelAdu;
    const saturationAdu = measured?.saturationAdu ?? spec.sensor.dataMaxAdu;
    const fullWellE = Math.min(spec.sensor.fullWellE, Math.max(1, saturationAdu - blackAdu) * ePerAdu);
    return {
      gain,
      ePerAdu,
      readNoiseE,
      blackAdu,
      saturationAdu,
      fullWellE,
      darkCurrentEPerS: m?.darkEPerS ?? spec.sensor.darkCurrentEPerS,
      source: { ePerAdu: eSource, readNoise: rnSource, black: m?.blackAdu !== undefined || measured?.blackAdu !== undefined ? 'measured' : 'spec', saturation: measured?.saturationAdu !== undefined ? 'measured' : 'spec' },
    };
  };
  const g0 = sensorAt(gains[0]);
  if (g0.source.ePerAdu !== 'measured') missing.push('conversion gain (e⁻/ADU): acquisition_measure action=sky on a session of clear-sky subs');
  if (g0.source.readNoise === 'spec') missing.push('read noise and black level: acquisition_measure action=sensor on dark frames');
  if (spec.exposure.requiresMatchingDarks && !facts.darks) missing.push('the dark masters on the device (to offer only covered exposure/gain pairs)');

  return {
    spec,
    why,
    serial: facts.serial,
    apertureMm,
    focalLengthMm,
    pixelUm,
    widthPx: wPx,
    heightPx: hPx,
    plateScale,
    fovDeg,
    throughput,
    mount,
    guided,
    gains,
    gainSettable: spec.gain.settable,
    subsS,
    filters: withFraction.filter((f) => f.deepSky),
    darks: facts.darks,
    sensorAt,
    sources: {
      optics: envAperture ? 'env' : facts.focalLengthMm ? 'device' : 'spec',
      mount: facts.eqMode !== undefined ? 'device' : 'env',
      gain: gainSource,
      exposures: expSource,
      filters: filterSource,
    },
    missing,
  };
}

/** A filter of the rig by name, else the first broadband one. */
export function rigFilter(rig: Rig, name: string | undefined): Rig['filters'][number] {
  return findFilter(rig.filters, name) ?? rig.filters.find((f) => f.band === 'broadband') ?? rig.filters[0];
}
