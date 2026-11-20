/**
 * What the measured brackets say: per filter, the offset from the reference filter's best focus,
 * how well it is known, and whether the planner should measure it again.
 *
 * - offset: the median of the valid brackets, after setting aside any more than OUTLIER_MADS robust
 *   deviations from it (a cloud through one sweep, a gust) once there are enough to tell;
 * - spread: the brackets' scatter (1.4826 × MAD; half the range for two), sem = spread / √n;
 * - settled: at least SETTLED_MIN brackets and sem ≤ SETTLED_SEM focus units, or SETTLED_MAX
 *   brackets whatever their scatter (more nights do not make a noisy offset sharper; the scatter is
 *   reported instead);
 * - temperature: with enough brackets over a wide enough range of temperatures, a straight line
 *   offset(T) is fitted; it is used only when it explains most of the scatter (r² ≥ SLOPE_R2), since
 *   a filter offset is expected to be a constant;
 * - refresh: the newest bracket is older than STALE_DAYS (a filter swapped, the tube serviced).
 */
import { median } from '../../util/stats.js';
import { deviceOffsets, type DeviceOffsets, type OffsetMeasurement } from './store.js';

export const SETTLED_MIN = 3;
export const SETTLED_MAX = 6;
/** focus units */
export const SETTLED_SEM = 1.5;
export const STALE_DAYS = 180;
const OUTLIER_MADS = 3.5;
const OUTLIER_MIN_N = 4;
const SLOPE_MIN_N = 5;
const SLOPE_MIN_RANGE_C = 5;
const SLOPE_R2 = 0.6;
const MAD_SIGMA = 1.4826;

export type FilterStatus = 'reference' | 'none' | 'more' | 'settled' | 'refresh';

export interface FilterOffset {
  filter: string;
  reference: string;
  status: FilterStatus;
  /** brackets used (valid, not outliers) */
  n: number;
  /** of all recorded for the filter */
  recorded: number;
  outliers: number;
  /** focus units from the reference's best; null until measured */
  offset: number | null;
  spread: number | null;
  sem: number | null;
  /** focus units per °C, when a temperature line explains the brackets */
  slopePerC: number | null;
  /** the temperature the line is centred on (offset is the line's value there) */
  slopeAtC: number | null;
  lastAt: number | null;
  line: string;
}

export interface DeviceOffsetStatus {
  device: string;
  label?: string;
  reference: string;
  filters: FilterOffset[];
  /** needed: a filter never measured; more: not settled; refresh: stale; settled: all known */
  status: 'needed' | 'more' | 'refresh' | 'settled' | 'unknown';
  line: string;
  lastAttempt: DeviceOffsets['attempts'][number] | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${r1(x)}`;

function fitLine(ms: OffsetMeasurement[]): { slope: number; at: number; value: number; r2: number } | null {
  const pts = ms.filter((m) => typeof m.tempC === 'number' && Number.isFinite(m.tempC));
  if (pts.length < SLOPE_MIN_N) return null;
  const ts = pts.map((m) => m.tempC!);
  if (Math.max(...ts) - Math.min(...ts) < SLOPE_MIN_RANGE_C) return null;
  const n = pts.length;
  const mt = ts.reduce((a, b) => a + b, 0) / n;
  const mo = pts.reduce((a, m) => a + m.offset, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const m of pts) {
    sxy += (m.tempC! - mt) * (m.offset - mo);
    sxx += (m.tempC! - mt) ** 2;
    syy += (m.offset - mo) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  const slope = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { slope, at: mt, value: mo, r2 };
}

/** One filter's offset from its brackets. */
export function filterOffset(filter: string, reference: string, all: OffsetMeasurement[], now = Date.now()): FilterOffset {
  if (filter === reference) return { filter, reference, status: 'reference', n: 0, recorded: 0, outliers: 0, offset: 0, spread: 0, sem: 0, slopePerC: null, slopeAtC: null, lastAt: null, line: `${filter}: the reference (offset 0 by definition)` };
  const recorded = all.filter((m) => m.filter === filter && m.reference === reference);
  let valid = recorded.filter((m) => m.valid && Number.isFinite(m.offset));
  let outliers = 0;
  if (valid.length >= OUTLIER_MIN_N) {
    const med = median(valid.map((m) => m.offset));
    const mad = median(valid.map((m) => Math.abs(m.offset - med))) * MAD_SIGMA;
    // a floor under the MAD: with brackets that agree to the unit, one off by two is not an outlier
    const lim = OUTLIER_MADS * Math.max(mad, 1);
    const kept = valid.filter((m) => Math.abs(m.offset - med) <= lim);
    outliers = valid.length - kept.length;
    valid = kept;
  }
  const n = valid.length;
  const lastAt = valid.length ? Math.max(...valid.map((m) => m.at)) : recorded.length ? Math.max(...recorded.map((m) => m.at)) : null;
  if (!n) {
    const why = recorded.length ? `${recorded.length} bracket(s), none valid (${recorded[recorded.length - 1].invalidWhy ?? 'unknown'})` : 'not measured';
    return { filter, reference, status: 'none', n: 0, recorded: recorded.length, outliers, offset: null, spread: null, sem: null, slopePerC: null, slopeAtC: null, lastAt, line: `${filter}: ${why}` };
  }
  const offsets = valid.map((m) => m.offset);
  const med = median(offsets);
  const spread = n === 1 ? null : n === 2 ? Math.abs(offsets[0] - offsets[1]) / 2 : median(offsets.map((x) => Math.abs(x - med))) * MAD_SIGMA;
  // one bracket says nothing about its own scatter; two that agree to the unit are not known to ±0
  const sem = spread === null ? null : Math.max(spread, 0.5) / Math.sqrt(n);
  const line = fitLine(valid);
  const useLine = line && line.r2 >= SLOPE_R2 ? line : null;
  const stale = lastAt !== null && now - lastAt > STALE_DAYS * 86400e3;
  const settled = (n >= SETTLED_MIN && sem !== null && sem <= SETTLED_SEM) || n >= SETTLED_MAX;
  const status: FilterStatus = stale ? 'refresh' : settled ? 'settled' : 'more';
  const offset = useLine ? useLine.value : med;
  const parts = [
    `${filter}: ${signed(offset)} from ${reference}`,
    `${n} bracket${n === 1 ? '' : 's'}${spread !== null ? `, scatter ±${r1(spread)} (±${r1(sem!)} on the mean)` : ''}`,
    outliers ? `${outliers} outlier(s) set aside` : '',
    useLine ? `varies ${signed(useLine.slope)} per °C (r² ${useLine.r2.toFixed(2)}, centred at ${r1(useLine.at)} °C)` : '',
    status === 'settled' ? (sem !== null && sem > SETTLED_SEM ? `settled at ${SETTLED_MAX} brackets, though they scatter` : 'settled') : status === 'refresh' ? `last measured over ${STALE_DAYS} days ago: measure again` : `not settled (${SETTLED_MIN}+ brackets agreeing to ±${SETTLED_SEM} wanted)`,
  ].filter(Boolean);
  return { filter, reference, status, n, recorded: recorded.length, outliers, offset: r1(offset), spread: spread === null ? null : r1(spread), sem: sem === null ? null : r1(sem), slopePerC: useLine ? Math.round(useLine.slope * 100) / 100 : null, slopeAtC: useLine ? r1(useLine.at) : null, lastAt, line: parts.join('; ') };
}

/** A device's offsets, every filter it has. */
export function offsetStatus(device: string, now = Date.now(), known?: Pick<DeviceOffsets, 'reference' | 'filters' | 'label'>): DeviceOffsetStatus {
  const d = deviceOffsets(device);
  const reference = known?.reference ?? d?.reference;
  const filters = known?.filters ?? d?.filters ?? [];
  if (!reference || !filters.length) return { device, label: known?.label ?? d?.label, reference: reference ?? '?', filters: [], status: 'unknown', line: 'the filters of this device are not known yet (focus_offsets action=status with the scope connected)', lastAttempt: d?.attempts.at(-1) ?? null };
  const ms = d?.measurements ?? [];
  const rows = [reference, ...filters.filter((f) => f !== reference)].map((f) => filterOffset(f, reference, ms, now));
  const others = rows.filter((r) => r.status !== 'reference');
  const status: DeviceOffsetStatus['status'] = !others.length ? 'settled' : others.some((r) => r.status === 'none') ? 'needed' : others.some((r) => r.status === 'more') ? 'more' : others.some((r) => r.status === 'refresh') ? 'refresh' : 'settled';
  const lineOf = { needed: 'not measured: a calibration is needed', more: 'measured, not settled: another calibration wanted', refresh: 'stale: measure again', settled: 'settled', unknown: '' }[status];
  return { device, label: known?.label ?? d?.label, reference, filters: rows, status, line: `${lineOf}. ${others.map((r) => r.line).join(' | ')}`, lastAttempt: d?.attempts.at(-1) ?? null };
}

/** A filter's offset at a temperature (the temperature line when one holds), null when unknown. */
export function offsetOf(st: DeviceOffsetStatus, filter: string, tempC?: number): number | null {
  if (filter === st.reference) return 0;
  const f = st.filters.find((x) => x.filter === filter);
  if (!f || f.offset === null) return null;
  if (f.slopePerC !== null && f.slopeAtC !== null && typeof tempC === 'number' && Number.isFinite(tempC)) return f.offset + f.slopePerC * (tempC - f.slopeAtC);
  return f.offset;
}

/** How far the focuser moves to keep the focus equivalent from one filter to another; null when either is unknown. */
export function shiftBetween(st: DeviceOffsetStatus, from: string, to: string, tempC?: number): number | null {
  if (from === to) return 0;
  const a = offsetOf(st, from, tempC);
  const b = offsetOf(st, to, tempC);
  return a === null || b === null ? null : b - a;
}

/** A best-focus position through one filter as the equivalent position through another. */
export function convertPosition(st: DeviceOffsetStatus, position: number, from: string, to: string, tempC?: number): { position: number; shift: number } | null {
  const shift = shiftBetween(st, from, to, tempC);
  return shift === null ? null : { position: Math.round(position + shift), shift: r1(shift) };
}
