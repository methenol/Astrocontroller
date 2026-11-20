/**
 * The night plan's focus calibration: whether this device still needs its filter focus offsets
 * measured (astro/focus-offsets), how long the block takes, and the field it is measured on.
 *
 * The field is a bright open cluster as close to the zenith as the catalog has at the block's start:
 * a short focus still through any filter shows plenty of stars there, the air is thinnest straight
 * up (the least seeing and refraction between sweeps), and the altitude barely changes over the
 * block. Clusters near the Moon are passed over.
 */
import * as sky from '../astro/sky.js';
import { catalog, displayName, gotoLabel, type DsoObject } from '../astro/catalog.js';
import { resolveRig, type LiveFacts } from '../astro/acquisition/devices.js';
import { deviceKey } from '../astro/acquisition/store.js';
import { calibrationJob, deviceOffsets, offsetStatus, referenceFilter, sweepOrder, type DeviceOffsetStatus } from '../astro/focus-offsets/index.js';
import type { CalibrationField, SolveInput } from './solver.js';

/** a cluster this bright and this size fills a frame of either scope with stars */
const FIELD_MAX_MAG = 7.5;
const FIELD_MIN_ARCMIN = 4;
const FIELD_MAX_ARCMIN = 90;
/** below this altitude no field is near enough the zenith */
const FIELD_MIN_ALT = 45;
const FIELD_MOON_SEP = 25;
/** minutes one fine sweep takes, per driver (±10 at step 1, re-centred now and then) */
export const SWEEP_MIN: Record<string, number> = { dwarf: 9, seestar: 4 };

let fields: DsoObject[] | null = null;
const candidates = (): DsoObject[] =>
  (fields ??= catalog().filter((o) => o.type === 'OCl' && o.mag !== undefined && o.mag <= FIELD_MAX_MAG && (o.majorArcmin ?? 0) >= FIELD_MIN_ARCMIN && (o.majorArcmin ?? Infinity) <= FIELD_MAX_ARCMIN));

/** The calibration field at a moment: the bright open cluster highest in the sky, clear of the Moon; null when none is near the zenith. */
export function calibrationField(site: sky.Site, t: number): CalibrationField | null {
  const when = new Date(t);
  const moonUp = sky.bodyAlt(site, 'Moon', when) > 0;
  const moon = moonUp ? sky.bodyRaDec(site, 'Moon', when) : null;
  let best: { o: DsoObject; alt: number } | null = null;
  for (const o of candidates()) {
    const alt = sky.altAz(site, o.raHours, o.decDeg, when).altitude;
    if (alt < FIELD_MIN_ALT || (best && alt <= best.alt)) continue;
    if (moon && sky.separationDeg(o.raHours, o.decDeg, moon.raHours, moon.decDeg) < FIELD_MOON_SEP) continue;
    best = { o, alt };
  }
  if (!best) return null;
  return { name: best.o.id, displayName: displayName(best.o), gotoName: gotoLabel(best.o), raHours: best.o.raHours, decDeg: best.o.decDeg, altDeg: Math.round(best.alt * 10) / 10 };
}

export interface CalibrationNeed {
  device: string;
  status: DeviceOffsetStatus;
  minutes: number;
  running: boolean;
  /** why it is (or is not) in tonight's plan */
  why: string;
}

/**
 * Whether tonight's plan gets a calibration block, and how long: while the device's offsets are not
 * settled, once a night (an attempt tonight, whatever came of it, waits for tomorrow), and
 * whatever happens while one runs.
 */
export function calibrationNeed(facts: (Partial<LiveFacts> & { driver: LiveFacts['driver'] }) | null, night: string, overheadMin: number, now = Date.now()): CalibrationNeed | null {
  if (!facts) return null;
  let rig;
  try {
    rig = resolveRig(facts);
  } catch {
    return null;
  }
  const device = deviceKey(rig.spec.id, rig.serial);
  const rec = deviceOffsets(device);
  // the filters as the device record has them (the calibration found them), else as the rig describes them
  const filters = rec?.filters.length ? rec.filters : rig.filters.map((f) => f.name);
  const reference = rec?.reference ?? referenceFilter(rig.filters.filter((f) => filters.includes(f.name)));
  if (!reference || filters.length < 2) return null;
  const status = offsetStatus(device, now, { reference, filters, label: rec?.label });
  const sweeps = sweepOrder({ reference, filters }).length;
  const perSweep = SWEEP_MIN[facts.driver] ?? SWEEP_MIN.dwarf;
  const j = calibrationJob();
  if (j?.status === 'running' && j.device === device) {
    const left = Math.max(10, Math.round(((j.planned - j.done) * perSweep)));
    return { device, status, minutes: left, running: true, why: `running: ${j.done}/${j.planned} sweeps` };
  }
  if (status.status === 'settled') return null;
  const tonight = rec?.attempts.filter((a) => a.night === night) ?? [];
  if (tonight.length) return null;
  return { device, status, minutes: Math.round(overheadMin + sweeps * perSweep), running: false, why: status.line };
}

/** The solver's input for it. */
export function calibrationInput(site: sky.Site, need: CalibrationNeed | null): SolveInput['calibration'] {
  if (!need) return null;
  return { minutes: need.minutes, running: need.running, fieldAt: (t) => calibrationField(site, t) };
}
