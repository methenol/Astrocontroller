/**
 * Filter focus offsets measured on this unit, kept across restarts (<data>/focus-offsets.json).
 *
 * A filter in the converging beam moves the focal plane by about t·(n−1)/n (its glass), plus
 * whatever colour the optics leave at its passband: a constant of the device, the same at any
 * temperature, while the absolute best focus drifts with temperature, dew and the tube. So what is
 * kept is not positions but differences: per device (model id + serial) and filter, the best focus
 * through the filter minus the best focus through the device's reference filter (the broadband one
 * autofocus works best in: the Seestar's IRCUT, the Dwarf's VIS), each measured by bracketing a
 * sweep through the filter between two reference sweeps a few minutes apart (calibrate.ts), so the
 * drift during the measurement cancels.
 *
 * The model (model.ts) reads it; the calibration job and focus_offsets action=forget write it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { writeFileAtomic } from '../../util/fs.js';

const log = logger('focus-offsets');

/** One sweep's answer: where the stars were sharpest through one filter. */
export interface OffsetSweep {
  filter: string;
  /** the middle of the sweep (ms): what the reference is interpolated at */
  at: number;
  /** the fitted minimum of the HFR curve, else the sharpest sample */
  position: number;
  fitted: boolean;
  hfrPx: number;
  stars: number;
  /** samples that measured stars, of those taken */
  goodSamples: number;
  samples: number;
  /** sweeps it took to get the peak inside (re-centred when it was on the edge) */
  sweeps: number;
  bestAtEdge: boolean;
  error?: string;
}

/** One bracket: reference, filter, reference. */
export interface OffsetMeasurement {
  id: string;
  device: string;
  at: number;
  night: string;
  filter: string;
  reference: string;
  /** focus units: best through the filter − best through the reference at the same moment */
  offset: number;
  filterPos: number;
  refBefore: number;
  refAfter: number;
  /** the reference's own drift across the bracket (after − before) */
  refDrift: number;
  tempC?: number;
  altDeg?: number;
  field?: string;
  valid: boolean;
  invalidWhy?: string;
}

export interface CalibrationAttempt {
  id: string;
  at: number;
  endedAt: number;
  night: string;
  /** skipped: the agent passed on tonight's block (clouded, blocked) without sweeping */
  status: 'done' | 'failed' | 'cancelled' | 'skipped';
  /** brackets that gave a valid offset */
  valid: number;
  note: string;
}

export interface DeviceOffsets {
  device: string;
  label?: string;
  reference: string;
  /** the filters the device has (reference included), as the calibration found them */
  filters: string[];
  measurements: OffsetMeasurement[];
  attempts: CalibrationAttempt[];
}

interface FileShape {
  version: 1;
  devices: Record<string, DeviceOffsets>;
}

/** kept per device: plenty for the statistics, and the file stays small */
const KEEP_MEASUREMENTS = 200;
const KEEP_ATTEMPTS = 60;

const file = () => path.join(config.paths.data, 'focus-offsets.json');

let cache: { path: string; data: FileShape } | null = null;

function load(): FileShape {
  const f = file();
  if (cache?.path === f) return cache.data;
  let data: FileShape = { version: 1, devices: {} };
  try {
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<FileShape>;
      if (raw && typeof raw === 'object' && raw.devices && typeof raw.devices === 'object') data = { version: 1, devices: raw.devices };
    }
  } catch (e) {
    log.warn(`${f} not read (starting empty): ${errMsg(e)}`);
  }
  cache = { path: f, data };
  return data;
}

function save(): void {
  const data = load();
  writeFileAtomic(file(), JSON.stringify(data, null, 1));
}

/** A device's record (null when nothing was ever measured on it). */
export function deviceOffsets(device: string): DeviceOffsets | null {
  return load().devices[device] ?? null;
}

export function allDeviceOffsets(): DeviceOffsets[] {
  return Object.values(load().devices);
}

/** Create or update what a device is (its filters and reference) without touching its measurements. */
export function noteDevice(device: string, o: { label?: string; reference: string; filters: string[] }): DeviceOffsets {
  const data = load();
  const cur = data.devices[device];
  const next: DeviceOffsets = { device, label: o.label ?? cur?.label, reference: o.reference, filters: [...o.filters], measurements: cur?.measurements ?? [], attempts: cur?.attempts ?? [] };
  const changed = !cur || cur.reference !== next.reference || cur.label !== next.label || cur.filters.join('|') !== next.filters.join('|');
  data.devices[device] = next;
  if (changed) save();
  return next;
}

export function recordMeasurement(m: OffsetMeasurement): void {
  const data = load();
  const d = data.devices[m.device];
  if (!d) throw new Error(`device ${m.device} is not known to the focus offsets (noteDevice first)`);
  d.measurements.push(m);
  if (d.measurements.length > KEEP_MEASUREMENTS) d.measurements.splice(0, d.measurements.length - KEEP_MEASUREMENTS);
  save();
}

export function recordAttempt(device: string, a: CalibrationAttempt): void {
  const data = load();
  const d = data.devices[device];
  if (!d) return;
  d.attempts.push(a);
  if (d.attempts.length > KEEP_ATTEMPTS) d.attempts.splice(0, d.attempts.length - KEEP_ATTEMPTS);
  save();
}

/** Drop a device's measurements (one filter's, or all); returns how many went. */
export function forgetOffsets(device: string, filter?: string): number {
  const data = load();
  const d = data.devices[device];
  if (!d) return 0;
  const before = d.measurements.length;
  d.measurements = filter ? d.measurements.filter((m) => m.filter !== filter) : [];
  const n = before - d.measurements.length;
  if (n) save();
  return n;
}

/** Tests: read the file again (DATA_DIR changed, or written behind the cache's back). */
export function reloadOffsets(): void {
  cache = null;
}
