import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bracketOf,
  calibrationJob,
  convertPosition,
  filterFocusFollower,
  filterOffset,
  noteDevice,
  offsetStatus,
  recordMeasurement,
  referenceFilter,
  shiftBetween,
  startCalibration,
  sweepOrder,
  type CalibrationDriver,
  type OffsetMeasurement,
  type OffsetSweep,
} from '../astro/focus-offsets/index.js';
import type { FocusSample, FocusSweepResult } from '../media/focus.js';
import { solveNight, type Candidate } from '../night/solver.js';
import { PLAN_DEFAULTS, type PlanSettings } from '../night/program.js';
import { planWindow } from '../night/clock.js';
import { findObject } from '../astro/catalog.js';
import { calibrationField } from '../night/calibration.js';
import * as sky from '../astro/sky.js';

let seq = 0;
const meas = (device: string, filter: string, offset: number, o: Partial<OffsetMeasurement> = {}): OffsetMeasurement => ({
  id: `m${seq++}`,
  device,
  at: Date.now() - 1000 * seq,
  night: '2026-11-18',
  filter,
  reference: 'IRCUT',
  offset,
  filterPos: 900 + offset,
  refBefore: 900,
  refAfter: 900,
  refDrift: 0,
  valid: true,
  ...o,
});

describe('focus offsets: the model', () => {
  test('one bracket gives an offset that is not settled; three that agree settle it', () => {
    const dev = 'test-s50:model-1';
    noteDevice(dev, { reference: 'IRCUT', filters: ['IRCUT', 'LP'] });
    recordMeasurement(meas(dev, 'LP', 9.2));
    let st = offsetStatus(dev);
    assert.equal(st.status, 'more');
    assert.equal(st.filters.find((f) => f.filter === 'LP')!.offset, 9.2);
    recordMeasurement(meas(dev, 'LP', 8.8));
    recordMeasurement(meas(dev, 'LP', 9.0));
    st = offsetStatus(dev);
    assert.equal(st.status, 'settled');
    assert.equal(st.filters.find((f) => f.filter === 'LP')!.offset, 9);
  });

  test('a filter never measured makes the device need a calibration; invalid brackets do not count', () => {
    const dev = 'test-s50:model-2';
    noteDevice(dev, { reference: 'IRCUT', filters: ['IRCUT', 'LP'] });
    assert.equal(offsetStatus(dev).status, 'needed');
    recordMeasurement(meas(dev, 'LP', 30, { valid: false, invalidWhy: 'clouded' }));
    const st = offsetStatus(dev);
    assert.equal(st.status, 'needed');
    assert.match(st.filters.find((f) => f.filter === 'LP')!.line, /none valid \(clouded\)/);
  });

  test('an outlier among agreeing brackets is set aside', () => {
    const rows = [7, 7.5, 8, 7.2, 25].map((x) => meas('d', 'Duo-Band', x, { reference: 'VIS' }));
    const f = filterOffset('Duo-Band', 'VIS', rows);
    assert.equal(f.outliers, 1);
    assert.ok(Math.abs(f.offset! - 7.35) < 0.2, `offset ${f.offset}`);
  });

  test('the shift between two filters is the difference of their offsets; unknown filters give none', () => {
    const dev = 'test-dwarf:model-3';
    noteDevice(dev, { reference: 'VIS', filters: ['VIS', 'Astro', 'Duo-Band'] });
    for (const x of [6, 6, 6]) recordMeasurement(meas(dev, 'Duo-Band', x, { reference: 'VIS' }));
    for (const x of [-3, -3, -3]) recordMeasurement(meas(dev, 'Astro', x, { reference: 'VIS' }));
    const st = offsetStatus(dev);
    assert.equal(shiftBetween(st, 'VIS', 'Duo-Band'), 6);
    assert.equal(shiftBetween(st, 'Astro', 'Duo-Band'), 9);
    assert.equal(shiftBetween(st, 'Duo-Band', 'VIS'), -6);
    assert.equal(shiftBetween(st, 'VIS', 'Ha'), null);
    assert.deepEqual(convertPosition(st, 902, 'VIS', 'Duo-Band'), { position: 908, shift: 6 });
  });

  test('the reference is the broadband filter autofocus works in', () => {
    assert.equal(referenceFilter([{ name: 'Astro', band: 'broadband' }, { name: 'Duo-Band', band: 'duo_wide' }, { name: 'VIS', band: 'broadband' }]), 'VIS');
    assert.equal(referenceFilter([{ name: 'IRCUT', band: 'broadband' }, { name: 'LP', band: 'duo_wide' }]), 'IRCUT');
    assert.equal(referenceFilter([{ name: 'Astro', band: 'broadband' }, { name: 'Duo-Band', band: 'duo_wide' }]), 'Astro');
  });

  test('the sweeps bracket every filter with the reference', () => {
    assert.deepEqual(sweepOrder({ reference: 'VIS', filters: ['Astro', 'Duo-Band', 'VIS'] }), ['VIS', 'Astro', 'VIS', 'Duo-Band', 'VIS']);
    assert.deepEqual(sweepOrder({ reference: 'IRCUT', filters: ['IRCUT', 'LP'] }), ['IRCUT', 'LP', 'IRCUT']);
  });
});

describe('focus offsets: a bracket', () => {
  const sw = (filter: string, at: number, position: number, o: Partial<OffsetSweep> = {}): OffsetSweep => ({ filter, at, position, fitted: true, hfrPx: 2, stars: 50, goodSamples: 21, samples: 21, sweeps: 1, bestAtEdge: false, ...o });
  test('a steadily drifting reference is interpolated to the filter sweep', () => {
    // the tube cools: the reference walks 900 → 906 over the bracket; LP sits 9 above it at its moment
    const b = bracketOf(sw('IRCUT', 0, 900), sw('LP', 500, 912), sw('IRCUT', 1000, 906));
    assert.equal(b.offset, 9);
    assert.equal(b.valid, true);
  });
  test('a reference that jumped, or a sweep without its peak, spoils the bracket', () => {
    assert.equal(bracketOf(sw('IRCUT', 0, 900), sw('LP', 500, 912), sw('IRCUT', 1000, 930)).valid, false);
    const edge = bracketOf(sw('IRCUT', 0, 900), sw('LP', 500, 912, { error: 'the peak stayed on the edge' }), sw('IRCUT', 1000, 901));
    assert.equal(edge.valid, false);
    assert.match(edge.invalidWhy!, /LP sweep/);
  });
});

describe('focus offsets: following a filter change', () => {
  const access = (dev: string, o: { blocked?: string; selfMove?: number } = {}) => {
    const st = { pos: 900, moves: [] as number[] };
    const f = filterFocusFollower({
      device: async () => dev,
      position: async () => st.pos,
      moveTo: async (p) => {
        st.moves.push(p);
        st.pos = p;
        return p;
      },
      blocked: () => o.blocked ?? null,
      tempC: () => undefined,
      filterSettleMs: 0,
      focusSettleMs: 0,
    });
    const change = async () => {
      if (o.selfMove) st.pos += o.selfMove;
    };
    return { st, f, change };
  };
  const dev = 'test-s50:follow';
  noteDevice(dev, { reference: 'IRCUT', filters: ['IRCUT', 'LP'] });
  for (const x of [9, 9, 9]) recordMeasurement(meas(dev, 'LP', x));

  test('the focuser moves by the offset after the change, and back again', async () => {
    const a = access(dev);
    const r = await a.f('IRCUT', 'LP', a.change);
    assert.equal(r.moved, true);
    assert.equal(a.st.pos, 909);
    assert.match(r.line!, /900 → 909/);
    await a.f('LP', 'IRCUT', a.change);
    assert.equal(a.st.pos, 900);
  });
  test('not while a stack collects', async () => {
    const a = access(dev, { blocked: 'a stack is collecting' });
    const r = await a.f('IRCUT', 'LP', a.change);
    assert.equal(r.moved, false);
    assert.equal(a.st.pos, 900);
    assert.match(r.line!, /not applied: a stack is collecting/);
  });
  test('a scope that compensates by itself is not shifted twice', async () => {
    const a = access(dev, { selfMove: 8 });
    const r = await a.f('IRCUT', 'LP', a.change);
    assert.equal(r.moved, false);
    assert.equal(a.st.pos, 908);
    assert.match(r.line!, /its own compensation/);
  });
  test('an unmeasured device changes the filter and leaves the focus', async () => {
    let changed = false;
    const a = access('test-s50:never-measured');
    const r = await a.f('IRCUT', 'LP', async () => {
      changed = true;
    });
    assert.equal(changed, true);
    assert.equal(r.moved, false);
    assert.deepEqual(a.st.moves, []);
  });
});

describe('focus offsets: the calibration job', () => {
  /** a scope whose best focus through LP sits 9 above IRCUT's, the tube drifting +0.5 a sweep */
  function fakeScope(key: string, o: { cloudy?: boolean } = {}) {
    const truth: Record<string, number> = { IRCUT: 0, LP: 9 };
    const st = { filter: 'IRCUT', pos: 895, sweeps: 0, base: 900, log: [] as string[] };
    const driver: CalibrationDriver = {
      driver: 'seestar',
      sweepMin: 0.01,
      device: async () => ({ key, label: 'Test S50', reference: 'IRCUT', filters: ['IRCUT', 'LP'] }),
      busy: () => null,
      currentFilter: async () => st.filter,
      setFilter: async (f) => {
        st.log.push(`→${f}`);
        st.filter = f;
        return `wheel → ${f}`;
      },
      sweep: async ({ center }) => {
        st.sweeps++;
        st.base += 0.5;
        const c = Math.round(center ?? st.pos);
        const peak = st.base + truth[st.filter];
        const samples: FocusSample[] = [];
        for (let p = c - 10; p <= c + 10; p++) samples.push({ position: p, score: 100, hfrPx: o.cloudy ? Infinity : 2 + Math.abs(p - peak) * 0.1, hfrUncertaintyPx: 0.05, stars: o.cloudy ? 0 : 40, saturated: 0, seconds: 1, ...(o.cloudy ? { error: 'no stars measured' } : {}) });
        const good = samples.filter((s) => !s.error);
        const best = good.length ? good.reduce((a, b) => (b.hfrPx < a.hfrPx ? b : a)) : samples[10];
        const edge = good.length > 0 && (best === good[0] || best === good[good.length - 1]);
        st.pos = best.position;
        const r: FocusSweepResult = { start: samples[10], samples, best, finalPosition: best.position, fittedPosition: edge || !good.length ? undefined : peak, bestAtEdge: edge, improvementPct: 0, verdict: '', notes: [], settings: '', elapsedS: 1 };
        return r;
      },
      tempC: () => 8,
      altDeg: () => 84,
    };
    return { st, driver };
  }
  const waitDone = async () => {
    for (let i = 0; i < 200 && calibrationJob()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    return calibrationJob()!;
  };

  test('IRCUT, LP, IRCUT: the offset is measured against the drifting reference and stored', async () => {
    const key = 'test-s50:job-1';
    const s = fakeScope(key);
    await startCalibration({ driver: s.driver, night: () => '2026-11-19', field: 'NGC 7789' });
    const j = await waitDone();
    assert.equal(j.status, 'done', j.error);
    assert.equal(j.measurements.length, 1);
    const m = j.measurements[0];
    assert.equal(m.valid, true, m.invalidWhy);
    assert.ok(Math.abs(m.offset - 9) <= 0.6, `offset ${m.offset}`);
    assert.deepEqual(s.st.log, ['→LP', '→IRCUT']);
    assert.equal(s.st.filter, 'IRCUT', 'the wheel is back where it was');
    const st = offsetStatus(key);
    assert.equal(st.status, 'more');
    assert.equal(st.lastAttempt?.night, '2026-11-19');
  });

  test('a peak beyond the sweep is chased by re-centring', async () => {
    const key = 'test-s50:job-2';
    const s = fakeScope(key);
    s.st.pos = 880; // 20 below the peak: the first sweep ends on its edge
    await startCalibration({ driver: s.driver, night: () => '2026-11-19' });
    const j = await waitDone();
    assert.equal(j.status, 'done', j.error);
    assert.ok(j.sweeps[0].sweeps >= 2, 'the first sweep was run again around its edge');
    assert.equal(j.measurements[0].valid, true);
  });

  test('a clouded field ends the job without an offset', async () => {
    const key = 'test-s50:job-3';
    const s = fakeScope(key, { cloudy: true });
    await startCalibration({ driver: s.driver, night: () => '2026-11-19' });
    const j = await waitDone();
    assert.equal(j.status, 'failed');
    assert.match(j.error!, /clouded/);
    assert.equal(offsetStatus(key).status, 'needed');
  });
});

describe('focus offsets: the night plan', () => {
  const SITE = { lat: 31.5475, lon: -99.3817, elev: 454 };
  const NOON = new Date('2026-11-01T18:00:00Z');
  const SETTINGS: PlanSettings = { ...PLAN_DEFAULTS, minAltitude: 25, useForecast: true, fillers: false };
  const W = planWindow(SITE, NOON, SETTINGS);
  const cand = (name: string): Candidate => {
    const x = findObject(name)!;
    return { key: x.id.toLowerCase(), name: x.id, displayName: name, gotoName: name, raHours: x.raHours, decDeg: x.decDeg, source: 'program', priority: 3, goalMin: 600, collectedMin: 0, moonKeep: 1 };
  };
  const field = (t: number) => calibrationField(SITE, t);
  const hour = (h: number) => W.start.getTime() + h * 3600e3;

  test('the calibration field is a bright open cluster near the zenith', () => {
    const f = field(hour(2));
    assert.ok(f, 'a field');
    assert.ok(f!.altDeg >= 60, `alt ${f!.altDeg}`);
    assert.equal(findObject(f!.name)?.type, 'OCl');
  });

  test('it goes in the first stretch that is clear and steady, and the targets go around it', () => {
    // cloud for the first 2 h, then clear; the seeing poor until 3 h, steady after
    const conditions = (t: Date) => ({ observability: t.getTime() < hour(2) ? 10 : 90, seeingIdx: t.getTime() < hour(3) ? 6 : 3 });
    const r = solveNight({ site: SITE, start: W.start, end: W.end, candidates: [cand('M 31'), cand('M 45')], settings: SETTINGS, overheadMin: 8, efficiency: 0.75, conditions, mount: 'eq', calibration: { minutes: 50, fieldAt: field } });
    const cal = r.blocks.filter((b) => b.kind === 'calibration');
    assert.equal(cal.length, 1);
    const c = cal[0];
    assert.ok(c.start >= hour(3) - 10 * 60e3 && c.start <= hour(3) + 10 * 60e3, `starts at the steady seeing (${new Date(c.start).toISOString()})`);
    assert.equal((c.end - c.start) / 60e3, 50);
    assert.match(c.reason, /clear, steady/);
    for (const b of r.blocks.filter((x) => x.kind === 'target')) assert.ok(b.end <= c.start || b.start >= c.end, 'no target block overlaps it');
    const after = r.blocks.find((b) => b.kind === 'target' && b.start === c.end);
    if (after) assert.ok(after.overheadMin > 0, 'the target after it pays its GoTo');
  });

  test('without a steady hour it takes the first clear one; a clouded night has none', () => {
    const mediocre = () => ({ observability: 90, seeingIdx: 6 });
    const r = solveNight({ site: SITE, start: W.start, end: W.end, candidates: [cand('M 31')], settings: SETTINGS, overheadMin: 8, efficiency: 0.75, conditions: mediocre, mount: 'eq', calibration: { minutes: 30, fieldAt: field } });
    const c = r.blocks.find((b) => b.kind === 'calibration')!;
    assert.equal(c.start, W.start.getTime());
    assert.match(c.reason, /none steadier/);
    const clouded = solveNight({ site: SITE, start: W.start, end: W.end, candidates: [cand('M 31')], settings: SETTINGS, overheadMin: 8, efficiency: 0.75, conditions: () => ({ observability: 5 }), mount: 'eq', calibration: { minutes: 30, fieldAt: field } });
    assert.equal(clouded.blocks.filter((b) => b.kind === 'calibration').length, 0);
    assert.ok(clouded.notes.some((n) => /focus calibration due/.test(n)));
    assert.ok(clouded.blocks.some((b) => b.kind === 'target'), 'collection goes on without it');
  });

  test('a calibration under way is placed from now, whatever the sky', () => {
    const from = new Date(hour(4));
    const r = solveNight({ site: SITE, start: W.start, end: W.end, from, candidates: [cand('M 31')], settings: SETTINGS, overheadMin: 8, efficiency: 0.75, conditions: () => ({ observability: 5 }), mount: 'eq', calibration: { minutes: 20, running: true, fieldAt: field } });
    const c = r.blocks.find((b) => b.kind === 'calibration' && !b.past)!;
    assert.equal(c.start, from.getTime());
    assert.ok(c.calibration?.running);
  });

  test('sanity: the zenith field is near the zenith all night', () => {
    for (const h of [0.5, 3, 6, 9]) {
      if (hour(h) >= W.end.getTime()) continue;
      const f = field(hour(h));
      assert.ok(f, `a field at +${h} h`);
      const alt = sky.altAz(SITE, f!.raHours, f!.decDeg, new Date(hour(h))).altitude;
      assert.ok(alt >= 55, `+${h} h: ${f!.displayName} at ${alt.toFixed(0)}°`);
    }
  });
});
