/**
 * Measuring the filter focus offsets, as a background job the agent starts on the calibration
 * field (the plan's focus-calibration block) and polls, the same for every driver.
 *
 * The sequence is bracketed: reference, filter A, reference, filter B, reference … — every sweep
 * through a filter sits between two reference sweeps, and its offset is taken against the
 * reference interpolated to the moment of its own sweep, so a focus that drifts steadily (the tube
 * cooling at dusk) cancels out. Each sweep is the driver's own fine star-focus sweep, re-centred
 * on its best position while the peak lies on its edge, and its answer is the fitted minimum of the
 * HFR curve.
 *
 * A bracket is kept only when all three sweeps found their peak inside the range with enough
 * stars, and the two reference sweeps agree to MAX_REF_DRIFT (more is a focus that jumped: a gust,
 * a cloud through one sweep, the scope touched). Each valid bracket is stored as it completes, so
 * a job stopped part way keeps what it measured. Two sweeps in a row without stars end the job: the
 * field is clouded.
 *
 * Filter changes go through the driver's own filter setter, which waits for the wheel to settle
 * and shifts the focuser by the offset known so far (follow.ts): a sweep then starts near the
 * filter's peak instead of the reference's. The offset is computed from the absolute peak
 * positions, so that shift does not enter it.
 */
import { errMsg, logger } from '../../log.js';
import type { FocusSweepResult } from '../../media/focus.js';
import { offsetStatus, type DeviceOffsetStatus } from './model.js';
import { noteDevice, recordAttempt, recordMeasurement, type OffsetMeasurement, type OffsetSweep } from './store.js';

const log = logger('focus-offsets');

/** the two reference sweeps of a bracket may disagree by this much (focus units) */
export const MAX_REF_DRIFT = 12;
/** a sweep needs this many positions with stars to say where its peak is */
const MIN_GOOD_SAMPLES = 5;
/** sweeps re-centred when the peak is on the edge */
const MAX_RECENTRES = 2;
/** consecutive sweeps without stars: the field is clouded */
const MAX_BLANK_SWEEPS = 2;
const KEEP_FINISHED = 10;

export interface CalibrationDevice {
  key: string;
  label: string;
  reference: string;
  /** every filter it has, the reference included (no dark slot) */
  filters: string[];
}

/** What a driver does for the calibration. */
export interface CalibrationDriver {
  driver: 'dwarf' | 'seestar';
  device(): Promise<CalibrationDevice>;
  /** why the scope cannot calibrate now (not connected, parked, stacking, another job), else null */
  busy(): string | null;
  currentFilter(): Promise<string | null>;
  /** change the tele filter, settled, keeping the focus equivalent when the offset is known; a line for the log */
  setFilter(filter: string): Promise<string>;
  /** the driver's fine star-focus sweep around a centre (default the current position), left on the best */
  sweep(o: { center?: number; filter: string }): Promise<FocusSweepResult>;
  tempC(): number | undefined;
  altDeg(): number | undefined;
  /** about how long one sweep takes, minutes */
  sweepMin: number;
}

export interface CalibrationJob {
  id: string;
  device: string;
  label: string;
  field?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  /** sweeps done / planned */
  done: number;
  planned: number;
  aboutMin: number;
  current?: string;
  log: string[];
  sweeps: OffsetSweep[];
  measurements: OffsetMeasurement[];
  result?: DeviceOffsetStatus;
  error?: string;
}

let job: (CalibrationJob & { abort: AbortController }) | null = null;
const finished: CalibrationJob[] = [];

const view = (j: CalibrationJob & { abort?: AbortController }): CalibrationJob => {
  const { abort: _a, ...rest } = j as CalibrationJob & { abort?: AbortController };
  return { ...rest, log: rest.log.slice(-40) };
};

/** The running calibration, else the newest finished one. */
export function calibrationJob(): CalibrationJob | null {
  if (job) return view(job);
  const f = finished.at(-1);
  return f ? view(f) : null;
}

export const calibrating = (): boolean => job !== null;

export function cancelCalibration(): boolean {
  if (!job) return false;
  job.abort.abort();
  return true;
}

/** The order of the sweeps: the reference around every other filter. */
export function sweepOrder(dev: Pick<CalibrationDevice, 'reference' | 'filters'>, only?: string[]): string[] {
  const others = dev.filters.filter((f) => f !== dev.reference && (!only?.length || only.includes(f)));
  const out = [dev.reference];
  for (const f of others) out.push(f, dev.reference);
  return out;
}

export interface CalibrationRun {
  driver: CalibrationDriver;
  /** the night the attempt is filed under */
  night: () => string;
  /** the field the scope is on (for the record) */
  field?: string;
  /** calibrate only these filters (default every one but the reference) */
  filters?: string[];
  /** one line in the night's journal at the end */
  note?: (text: string) => void;
  /** the plan re-solves once the job ends */
  ended?: (j: CalibrationJob) => void;
}

/** Start the calibration in the background; throws when one runs already or the scope is busy. */
export async function startCalibration(r: CalibrationRun): Promise<CalibrationJob> {
  if (job) throw new Error(`a focus calibration is already running (${job.done}/${job.planned} sweeps): focus_offsets action=status, or action=cancel`);
  const busy = r.driver.busy();
  if (busy) throw new Error(`cannot calibrate the focus offsets now: ${busy}`);
  const dev = await r.driver.device();
  if (dev.filters.length < 2) throw new Error(`${dev.label} has one filter (${dev.filters.join(', ') || 'none'}): there is no offset to measure`);
  const unknown = (r.filters ?? []).filter((f) => !dev.filters.includes(f));
  if (unknown.length) throw new Error(`${dev.label} has no filter ${unknown.join(', ')} (it has ${dev.filters.join(', ')})`);
  noteDevice(dev.key, { label: dev.label, reference: dev.reference, filters: dev.filters });
  const order = sweepOrder(dev, r.filters);
  if (order.length < 3) throw new Error('nothing to calibrate: no filter besides the reference');
  const j: CalibrationJob & { abort: AbortController } = {
    id: `fo-${Date.now().toString(36)}`,
    device: dev.key,
    label: dev.label,
    field: r.field,
    status: 'running',
    startedAt: Date.now(),
    done: 0,
    planned: order.length,
    aboutMin: Math.round(order.length * r.driver.sweepMin),
    log: [],
    sweeps: [],
    measurements: [],
    abort: new AbortController(),
  };
  job = j;
  void run(j, r, dev, order).finally(() => {
    j.endedAt = Date.now();
    finished.push(view(j));
    if (finished.length > KEEP_FINISHED) finished.splice(0, finished.length - KEEP_FINISHED);
    if (job === j) job = null;
    try {
      r.ended?.(view(j));
    } catch (e) {
      log.debug(`after the calibration: ${errMsg(e)}`);
    }
  });
  return view(j);
}

/** One sweep, re-centred while its peak is on the edge; its answer as an OffsetSweep. */
async function sweepUntilInside(d: CalibrationDriver, filter: string, signal: AbortSignal, say: (t: string) => void): Promise<OffsetSweep> {
  let center: number | undefined;
  let r: FocusSweepResult | null = null;
  let sweeps = 0;
  const t0 = Date.now();
  for (let i = 0; i <= MAX_RECENTRES; i++) {
    if (signal.aborted) throw new Error('cancelled');
    sweeps++;
    r = await d.sweep({ center, filter });
    if (!r.bestAtEdge) break;
    center = r.best.position;
    if (i < MAX_RECENTRES) say(`${filter}: the peak is on the edge at ${center}: sweeping again around it`);
  }
  const res = r!;
  const good = res.samples.filter((s) => !s.error && Number.isFinite(s.hfrPx)).length;
  const position = res.fittedPosition ?? res.best.position;
  const error = good < MIN_GOOD_SAMPLES ? `${good} of ${res.samples.length} positions measured stars` : res.bestAtEdge ? `the peak stayed on the edge after ${sweeps} sweeps` : undefined;
  return {
    filter,
    at: Math.round((t0 + Date.now()) / 2),
    position: Math.round(position * 10) / 10,
    fitted: res.fittedPosition !== undefined,
    hfrPx: Math.round(res.best.hfrPx * 100) / 100,
    stars: res.best.stars,
    goodSamples: good,
    samples: res.samples.length,
    sweeps,
    bestAtEdge: res.bestAtEdge,
    ...(error ? { error } : {}),
  };
}

/** The bracket's offset: the filter's peak against the reference interpolated to its moment. */
export function bracketOf(before: OffsetSweep, mid: OffsetSweep, after: OffsetSweep): Pick<OffsetMeasurement, 'offset' | 'refBefore' | 'refAfter' | 'refDrift' | 'filterPos' | 'valid' | 'invalidWhy'> {
  const span = after.at - before.at;
  const w = span > 0 ? Math.min(1, Math.max(0, (mid.at - before.at) / span)) : 0.5;
  const ref = before.position + w * (after.position - before.position);
  const drift = after.position - before.position;
  const why = before.error ? `the reference sweep before: ${before.error}` : mid.error ? `the ${mid.filter} sweep: ${mid.error}` : after.error ? `the reference sweep after: ${after.error}` : Math.abs(drift) > MAX_REF_DRIFT ? `the reference moved ${Math.round(drift)} units across the bracket (over ${MAX_REF_DRIFT}): focus jumped` : undefined;
  return { offset: Math.round((mid.position - ref) * 10) / 10, refBefore: before.position, refAfter: after.position, refDrift: Math.round(drift * 10) / 10, filterPos: mid.position, valid: !why, ...(why ? { invalidWhy: why } : {}) };
}

async function run(j: CalibrationJob & { abort: AbortController }, r: CalibrationRun, dev: CalibrationDevice, order: string[]): Promise<void> {
  const d = r.driver;
  const say = (t: string) => {
    j.log.push(`${new Date().toISOString().slice(11, 19)} ${t}`);
    log.info(`${dev.label}: ${t}`);
  };
  const original = await d.currentFilter().catch(() => null);
  let blank = 0;
  let lastRef: OffsetSweep | null = null;
  let pending: OffsetSweep | null = null;
  try {
    say(`calibrating ${order.filter((f) => f !== dev.reference).join(', ')} against ${dev.reference}: ${order.length} sweeps (~${j.aboutMin} min)${r.field ? ` on ${r.field}` : ''}`);
    for (const filter of order) {
      if (j.abort.signal.aborted) throw new Error('cancelled');
      j.current = `${filter} sweep (${j.done + 1}/${j.planned})`;
      const cur = await d.currentFilter().catch(() => null);
      if (cur !== filter) say(await d.setFilter(filter));
      const s = await sweepUntilInside(d, filter, j.abort.signal, say);
      // a view restarted under the sweep can put another slot in: then it measured the wrong filter
      const after = await d.currentFilter().catch(() => null);
      if (after && after !== filter && !s.error) s.error = `the filter was ${after}, not ${filter}, at the end of the sweep`;
      j.sweeps.push(s);
      j.done++;
      say(`${filter}: ${s.error ? `no answer (${s.error})` : `best ${s.position}${s.fitted ? ' (fitted)' : ''}, HFR ${s.hfrPx} px, ${s.stars} stars${s.sweeps > 1 ? `, ${s.sweeps} sweeps` : ''}`}`);
      blank = s.goodSamples < MIN_GOOD_SAMPLES ? blank + 1 : 0;
      if (blank >= MAX_BLANK_SWEEPS) throw new Error(`${blank} sweeps in a row without stars: the field is clouded (or the view blocked)`);
      if (filter !== dev.reference) {
        pending = s;
        continue;
      }
      if (lastRef && pending) {
        const b = bracketOf(lastRef, pending, s);
        const m: OffsetMeasurement = { id: `fm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, device: dev.key, at: pending.at, night: r.night(), filter: pending.filter, reference: dev.reference, ...b, tempC: d.tempC(), altDeg: d.altDeg(), field: r.field };
        recordMeasurement(m);
        j.measurements.push(m);
        say(`${m.filter}: offset ${m.offset >= 0 ? '+' : ''}${m.offset} from ${dev.reference}${m.valid ? '' : ` — not kept: ${m.invalidWhy}`} (reference ${m.refBefore} → ${m.refAfter})`);
        pending = null;
      }
      lastRef = s;
    }
    j.current = undefined;
    j.result = offsetStatus(dev.key);
    const valid = j.measurements.filter((m) => m.valid).length;
    j.status = valid ? 'done' : 'failed';
    if (!valid) j.error = `no bracket was valid: ${j.measurements.map((m) => m.invalidWhy).filter(Boolean).join('; ') || 'no bracket completed'}`;
    say(j.status === 'done' ? `done: ${j.result.line}` : `failed: ${j.error}`);
  } catch (e) {
    j.current = undefined;
    j.status = j.abort.signal.aborted ? 'cancelled' : 'failed';
    j.error = errMsg(e);
    j.result = offsetStatus(dev.key);
    say(`${j.status}: ${j.error}`);
  } finally {
    // the filter the night was using, with the focus carried over by the offsets just measured
    if (original && original !== (await d.currentFilter().catch(() => null))) {
      await d
        .setFilter(original)
        .then((t) => say(`back to ${original}: ${t}`))
        .catch((e) => say(`the filter could not be put back to ${original}: ${errMsg(e)}`));
    }
    const valid = j.measurements.filter((m) => m.valid).length;
    const note = `focus offset calibration${r.field ? ` on ${r.field}` : ''}: ${j.status}${valid ? ` — ${j.measurements.filter((m) => m.valid).map((m) => `${m.filter} ${m.offset >= 0 ? '+' : ''}${m.offset}`).join(', ')} from ${dev.reference}` : ''}${j.error ? ` (${j.error})` : ''}`;
    recordAttempt(dev.key, { id: j.id, at: j.startedAt, endedAt: Date.now(), night: r.night(), status: j.status === 'running' ? 'failed' : j.status, valid, note });
    try {
      r.note?.(note);
    } catch {
      /* the journal note is a courtesy */
    }
  }
}
