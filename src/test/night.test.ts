import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as sky from '../astro/sky.js';
import { config } from '../config.js';
import { findObject } from '../astro/catalog.js';
import { planNight } from '../astro/planner.js';
import { PLAN_DEFAULTS, addTarget, removeTarget, type PlanSettings } from '../night/program.js';
import { setRest, liftRest } from '../astro/rest.js';
import { alternatesAt, daysFromFull, moonFactor, moonRequiredSep, quadrantOf, solveNight, type Block, type Candidate, type Hold } from '../night/solver.js';
import { Journal } from '../night/journal.js';
import { JournalRecorder, type ScopeSnapshot } from '../night/recorder.js';
import { dwarfProbe } from '../drivers/dwarf/journal.js';
import type { Dwarf } from '../drivers/dwarf/device.js';
import type { StreamHub } from '../media/streams.js';
import { learn } from '../night/progress.js';
import { nightOfStamp, planWindow } from '../night/clock.js';
import { PlanService } from '../night/service.js';

const SITE = { lat: 31.5475, lon: -99.3817, elev: 454 };
const NOON = new Date('2026-11-01T18:00:00Z');
const SETTINGS: PlanSettings = { ...PLAN_DEFAULTS, minAltitude: 25, useForecast: false, fillers: false };
const W = planWindow(SITE, NOON, SETTINGS);

function cand(name: string, o: Partial<Candidate> = {}): Candidate {
  const x = findObject(name)!;
  return { key: x.id.toLowerCase(), name: x.id, displayName: name, gotoName: name, raHours: x.raHours, decDeg: x.decDeg, source: 'program', priority: 3, goalMin: 600, collectedMin: 0, moonKeep: 1, ...o };
}

const solve = (candidates: Candidate[], extra: Partial<Parameters<typeof solveNight>[0]> = {}) =>
  solveNight({ site: SITE, start: W.start, end: W.end, candidates, settings: SETTINGS, overheadMin: 8, efficiency: 0.75, ...extra });

const targetBlocks = (r: ReturnType<typeof solveNight>) => r.blocks.filter((b) => b.kind === 'target');

describe('night plan: the Moon rule', () => {
  test('days from full: new is ~14.8, full is 0', () => {
    assert.ok(Math.abs(daysFromFull(0) - 14.77) < 0.05);
    assert.ok(daysFromFull(1) < 0.01);
    assert.ok(Math.abs(daysFromFull(0.5) - 7.38) < 0.1);
  });
  test('the required separation relaxes away from full Moon (Lorentzian)', () => {
    const rule = { distanceDeg: 120, widthDays: 10 };
    assert.equal(moonRequiredSep(rule, 0), 120);
    assert.equal(moonRequiredSep(rule, 10), 60);
    assert.ok(moonRequiredSep(rule, 14) < 45);
  });
  test('a slot is whole beyond the requirement, lost well inside it, and scaled by what the Moon leaves', () => {
    assert.equal(moonFactor(90, 60, 1), 1);
    assert.equal(moonFactor(30, 60, 1), 0);
    assert.ok(moonFactor(48, 60, 1) > 0 && moonFactor(48, 60, 1) < 1);
    assert.equal(moonFactor(90, 60, 0.4), 0.4);
  });
});

describe('night plan: the solver', () => {
  test('blocks cover the window in order, without overlap', () => {
    const r = solve([cand('M 31'), cand('M 42'), cand('M 33')]);
    assert.ok(r.blocks.length > 0);
    assert.equal(r.blocks[0].start, W.start.getTime());
    assert.equal(r.blocks[r.blocks.length - 1].end, W.end.getTime());
    for (let i = 1; i < r.blocks.length; i++) assert.equal(r.blocks[i].start, r.blocks[i - 1].end);
  });

  test('a higher priority wins the hours two targets share', () => {
    const lo = solve([cand('M 31', { priority: 1 }), cand('M 33', { priority: 5 })]);
    const m33 = targetBlocks(lo).filter((b) => b.target!.displayName === 'M 33').reduce((a, b) => a + b.expectedMin, 0);
    const m31 = targetBlocks(lo).filter((b) => b.target!.displayName === 'M 31').reduce((a, b) => a + b.expectedMin, 0);
    assert.ok(m33 > m31, `M 33 ${m33} min vs M 31 ${m31} min`);
  });

  test('a target leaves once its goal is met, and a met goal is not scheduled', () => {
    const r = solve([cand('M 31', { goalMin: 60, priority: 5 }), cand('M 33', { goalMin: 600, collectedMin: 600 }), cand('M 42')]);
    const m31 = targetBlocks(r).filter((b) => b.target!.displayName === 'M 31');
    assert.ok(m31.length >= 1);
    assert.ok(m31.reduce((a, b) => a + b.expectedMin, 0) <= 60 + 10 * 0.75);
    assert.equal(targetBlocks(r).filter((b) => b.target!.displayName === 'M 33').length, 0);
    assert.equal(r.outlook.find((o) => o.displayName === 'M 33')!.status, 'complete');
  });

  test('blocks keep the minimum length unless their target runs out', () => {
    const r = solve([cand('M 31'), cand('M 42'), cand('M 33'), cand('M 45'), cand('NGC 7000')]);
    for (const b of targetBlocks(r)) {
      const isLast = b.end === W.end.getTime();
      assert.ok(isLast || b.end - b.start >= SETTINGS.minBlockMin * 60e3, `${b.target!.displayName} ${(b.end - b.start) / 60e3} min`);
    }
  });

  test('a switch costs the overhead, and continuing the running target does not', () => {
    const r = solve([cand('M 31')], { from: new Date(W.start.getTime() + 3600e3), current: { key: 'ngc 224', since: W.start.getTime() } });
    const first = targetBlocks(r)[0];
    assert.equal(first.target!.displayName, 'M 31');
    assert.equal(first.overheadMin, 0);
    const fresh = targetBlocks(solve([cand('M 31')]))[0];
    assert.equal(fresh.overheadMin, 8);
  });

  test('a hold takes the target out, and a pin puts one in', () => {
    const from = W.start.getTime();
    const hold: Hold = { id: 'h', kind: 'skip', target: 'ngc 224', from, until: null, reason: 'test', by: 'user', createdAt: from };
    const r = solve([cand('M 31', { priority: 5 }), cand('M 33')], { holds: [hold] });
    assert.equal(targetBlocks(r).filter((b) => b.target!.displayName === 'M 31').length, 0);
    assert.equal(r.outlook.find((o) => o.displayName === 'M 31')!.status, 'held');
    const pinFrom = W.start.getTime() + 2 * 3600e3;
    const pin: Hold = { id: 'p', kind: 'pin', target: 'ngc 598', from: pinFrom, until: pinFrom + 3600e3, reason: 'test', by: 'user', createdAt: from };
    const p = solve([cand('M 31', { priority: 5 }), cand('M 33', { priority: 1 })], { holds: [pin] });
    const pinned = targetBlocks(p).find((b) => b.pinned);
    assert.ok(pinned);
    assert.equal(pinned!.target!.displayName, 'M 33');
  });

  test('a sky hold keeps the plan out of that quadrant', () => {
    const from = W.start.getTime();
    const hold: Hold = { id: 's', kind: 'sky', quadrant: 'E', from, until: null, reason: 'cloud bank', by: 'agent', createdAt: from };
    const r = solve([cand('M 31'), cand('M 42'), cand('M 33'), cand('M 45')], { holds: [hold] });
    for (const b of targetBlocks(r)) {
      const o = findObject(b.target!.name)!;
      for (let t = b.start + 5 * 60e3; t < b.end; t += 10 * 60e3) assert.notEqual(quadrantOf(sky.altAz(SITE, o.raHours, o.decDeg, new Date(t)).azimuth), 'E', `${b.target!.displayName} at ${new Date(t).toISOString()}`);
    }
  });

  test('alternates come from other quadrants than the block’s own first', () => {
    const r = solve([cand('M 31'), cand('M 42'), cand('M 33'), cand('M 45'), cand('NGC 7000'), cand('IC 1805'), cand('M 74')]);
    const b = targetBlocks(r).find((x) => x.alternates.length >= 2)!;
    assert.ok(b);
    assert.notEqual(b.alternates[0].quadrant, b.quadrant);
    assert.ok(!b.alternates.some((a) => a.key === b.target!.key));
  });

  test('alternates in an hour the forecast puts below the floor: the sky check beats the forecast', () => {
    const cands = [cand('M 31'), cand('M 42'), cand('M 33'), cand('M 45'), cand('NGC 7000')];
    const cloudy = () => ({ observability: 10 }) as never;
    const input = { site: SITE, start: W.start, end: W.end, candidates: cands, settings: { ...SETTINGS, useForecast: true }, overheadMin: 8, efficiency: 0.75, conditions: cloudy };
    const at = new Date(W.start.getTime() + 2 * 3600e3);
    // the forecast below the floor is advisory: targets are still planned, each block says so
    const r = solveNight({ ...input, from: at });
    const tb = r.blocks.filter((b) => b.kind === 'target');
    assert.ok(tb.length > 0, 'targets planned under a cloudy forecast');
    assert.ok(r.blocks.every((b) => b.kind !== 'weather'));
    assert.ok(tb.every((b) => b.clouds && /sky_check/.test(b.clouds.advisory) && /obscured cause=cloud/.test(b.clouds.advisory)));
    assert.ok(r.slots.filter((s) => s.t >= at.getTime()).every((s) => s.cloudy));
    const alts = alternatesAt(input, at);
    assert.ok(alts.length > 0, 'alternates when the sky check found it clear');
    assert.ok(alts.every((a) => /below 35\/100 \(advisory: the sky check decides\)/.test(a.reason)));
    // with a clear forecast there is no advisory
    const clear = alternatesAt({ ...input, conditions: () => ({ observability: 90 }) as never }, at);
    assert.ok(clear.length > 0 && clear.every((a) => !/advisory/.test(a.reason)));
    assert.ok(solveNight({ ...input, from: at, conditions: () => ({ observability: 90 }) as never }).blocks.every((b) => !b.clouds));
  });

  test('cloudy hours yield less, so a program target is not used up before the clear hours', () => {
    const cands = [cand('M 31', { goalMin: 120, priority: 5 })];
    const mid = W.start.getTime() + 3 * 3600e3;
    const cond = (t: Date) => ({ observability: t.getTime() < mid ? 10 : 90 }) as never;
    const r = solveNight({ site: SITE, start: W.start, end: W.end, candidates: cands, settings: { ...SETTINGS, useForecast: true }, overheadMin: 8, efficiency: 0.75, conditions: cond });
    const m31 = r.blocks.filter((b) => b.kind === 'target' && b.target!.displayName === 'M 31');
    assert.ok(m31.some((b) => b.start < mid && b.clouds), 'planned (advisory) under the cloudy hours');
    assert.ok(m31.some((b) => b.end > mid + 3600e3), 'its goal is not used up by the cloudy hours: it carries on into the clear ones');
    const cloudy = m31.find((b) => b.clouds)!;
    assert.ok(cloudy.clouds!.cloudyMin < (cloudy.end - cloudy.start) / 60e3, 'only the cloudy part is flagged');
  });

  test('a target that never clears the limits says so', () => {
    const r = solve([cand('M 31'), cand('M 7')]);
    assert.equal(r.outlook.find((o) => o.displayName === 'M 7')!.status, 'not-up');
  });

  test('a re-plan keeps the night so far as past blocks', () => {
    const first = solve([cand('M 31'), cand('M 42')], { idPrefix: 'a' });
    const from = new Date(W.start.getTime() + 2.5 * 3600e3);
    // whatever ran at the re-plan is taken out from then on, so the night so far stays as it was
    const running = first.blocks.find((b) => b.start <= from.getTime() && b.end > from.getTime())!.target!;
    const skip: Hold = { id: 'k', kind: 'skip', target: running.key, from: from.getTime(), until: null, reason: 'test', by: 'user', createdAt: from.getTime() };
    const again = solve([cand('M 31'), cand('M 42'), cand('M 33')], { from, history: first.blocks, idPrefix: 'b', holds: [skip] });
    assert.ok(again.blocks.some((b) => b.past && b.target?.key === running.key));
    assert.ok(!again.blocks.some((b) => !b.past && b.target?.key === running.key));
    assert.ok(again.blocks.filter((b) => b.past).every((b) => b.end <= from.getTime()));
    assert.equal(again.blocks[0].start, W.start.getTime());
  });

  test('blocks of another night are not kept as history', () => {
    const shift = (b: Block, ms: number): Block => ({ ...b, start: b.start - ms, end: b.end - ms });
    const lastNight = solve([cand('M 31'), cand('M 42')], { idPrefix: 'y' }).blocks.map((b) => shift(b, 86400e3));
    const r = solve([cand('M 31'), cand('M 42')], { history: lastNight, idPrefix: 'z' });
    assert.ok(!r.blocks.some((b) => b.past));
    assert.ok(r.blocks.every((b) => b.start >= W.start.getTime()));
  });
});

describe('night plan: fillers', () => {
  const filler = (name: string, o: Partial<Candidate> = {}) => cand(name, { source: 'filler', fillerScore: 60, priority: undefined, goalMin: undefined, collectedMin: undefined, ...o });
  const minutes = (r: ReturnType<typeof solveNight>, name: string) => targetBlocks(r).filter((b) => b.target!.displayName === name).reduce((a, b) => a + b.expectedMin, 0);
  const on = { ...SETTINGS, fillers: true };

  test('a filler in progress goes before a better new one', () => {
    // M 42 and M 45 share their best hours; M 42 is the one started, on a far lower score
    const r = solve([filler('M 42', { fillerScore: 20, goalMin: 600, collectedMin: 100 }), filler('M 45', { fillerScore: 90 })], { settings: on });
    const b = targetBlocks(r).find((x) => x.target!.displayName === 'M 42')!;
    assert.match(b.reason, /in progress \(100 of 600/);
    assert.ok(b.alt!.max >= Math.max(...r.tracks.find((t) => t.displayName === 'M 42')!.alt) - 3, 'collected at the top of its arc');
  });

  test('a filler in progress stops at its goal and the night goes on with a new one', () => {
    const r = solve([filler('M 33', { goalMin: 130, collectedMin: 100 }), filler('M 31')], { settings: on });
    assert.ok(minutes(r, 'M 33') <= 30 + 10 * 0.75, `M 33 ${minutes(r, 'M 33')} min`);
    assert.ok(minutes(r, 'M 31') > 0);
  });

  test('a filler at its goal is an ordinary filler', () => {
    const r = solve([filler('M 33', { fillerScore: 20, goalMin: 100, collectedMin: 100 }), filler('M 31', { fillerScore: 90 })], { settings: on });
    assert.ok(minutes(r, 'M 31') > minutes(r, 'M 33'));
  });

  test('a program target with a goal to meet still beats a filler in progress', () => {
    const r = solve([cand('M 31', { priority: 5 }), filler('M 33', { goalMin: 600, collectedMin: 100 })], { settings: on });
    assert.ok(minutes(r, 'M 31') > minutes(r, 'M 33'));
  });
});

describe('night plan: a program target is collected at its best', () => {
  const filler = (name: string) => cand(name, { source: 'filler', fillerScore: 60, priority: undefined, goalMin: undefined, collectedMin: undefined });
  const on = { ...SETTINGS, fillers: true };
  const blocksOf = (r: ReturnType<typeof solveNight>, name: string) => targetBlocks(r).filter((b) => b.target!.displayName === name);
  const peak = (r: ReturnType<typeof solveNight>, name: string) => Math.max(...r.tracks.find((t) => t.displayName === name)!.alt);

  test('a short need waits for the top of its arc, and fillers take the hours before it', () => {
    const r = solve([cand('M 42', { goalMin: 600, collectedMin: 570 }), filler('M 31')], { settings: on });
    const [b] = blocksOf(r, 'M 42');
    assert.ok(b.alt!.max >= peak(r, 'M 42') - 3, `M 42 at ${b.alt!.max}° of ${peak(r, 'M 42')}°`);
    assert.equal(r.blocks[0].target!.displayName, 'M 31');
  });

  test('two short needs that want the same hours do not collide, and both are collected', () => {
    const r = solve([cand('M 42', { goalMin: 600, collectedMin: 570, priority: 4 }), cand('M 45', { goalMin: 600, collectedMin: 570 }), filler('M 31')], { settings: on });
    assert.ok(blocksOf(r, 'M 42').length && blocksOf(r, 'M 45').length);
    const [a, b] = [blocksOf(r, 'M 42')[0], blocksOf(r, 'M 45')[0]].sort((x, y) => x.start - y.start);
    assert.ok(a.end <= b.start);
  });

  test('a need larger than the night starts as soon as the target is up', () => {
    const r = solve([cand('M 42', { goalMin: 6000 }), filler('M 31')], { settings: on });
    const first = r.tracks.find((t) => t.displayName === 'M 42')!.alt.findIndex((a) => a >= 25);
    const startSlot = Math.round((blocksOf(r, 'M 42')[0].start - W.start.getTime()) / 600e3);
    assert.ok(startSlot <= first + 6, `started at slot ${startSlot}, up from slot ${first}`);
  });
});

describe('the catalog planner: a list that spans the night', () => {
  const opts = { start: W.start, end: W.end, now: NOON, minAltitude: 25, fovArcmin: { w: 177, h: 100 }, timezone: 'America/Chicago', applyRest: false } as const;
  const quadrants = (t: { raHours: number; decDeg: number }[], at: Date) => new Set(t.map((x) => sky.altAz(SITE, x.raHours, x.decDeg, at)).filter((a) => a.altitude >= 25).map((a) => quadrantOf(a.azimuth)));

  test('every hour of the night has targets in at least three quadrants', () => {
    const { targets } = planNight(SITE, { ...opts, limit: 120, spanNight: { blockMin: 45 } });
    for (let t = W.start.getTime() + 30 * 60e3; t < W.end.getTime(); t += 3600e3) {
      const q = quadrants(targets.filter((x) => !x.gated), new Date(t));
      assert.ok(q.size >= 3, `only ${[...q]} at ${new Date(t).toISOString()}`);
    }
  });

  test('a started target stays on the list past the limit', () => {
    const all = planNight(SITE, { ...opts, limit: 200, spanNight: { blockMin: 45 } }).targets;
    const low = all[all.length - 1];
    const key = low.name.trim().toLowerCase();
    const short = planNight(SITE, { ...opts, limit: 8, spanNight: { blockMin: 45 } }).targets;
    assert.ok(!short.some((t) => t.name === low.name), 'not on the short list by its own rank');
    const kept = planNight(SITE, { ...opts, limit: 8, spanNight: { blockMin: 45 }, started: new Set([key]) }).targets;
    assert.ok(kept.some((t) => t.name === low.name));
  });

  test('without spanNight the order is the one the Tonight tab shows: up at the start first', () => {
    const { targets } = planNight(SITE, { ...opts, limit: 20 });
    const up = targets.map((t) => sky.altAz(SITE, t.raHours, t.decDeg, W.start).altitude >= 25);
    assert.ok(up.lastIndexOf(true) < (up.indexOf(false) === -1 ? Infinity : up.length) && up.indexOf(false) === -1 ? true : up.lastIndexOf(true) < up.indexOf(false));
  });
});

describe('night plan: time', () => {
  test('a library stamp before noon belongs to the evening before', () => {
    assert.equal(nightOfStamp('2026-10-28T01:12:00'), '2026-10-27');
    assert.equal(nightOfStamp('2026-10-27T21:12:00'), '2026-10-27');
  });
  test('the window runs from astronomical dusk to dawn by default, with offsets', () => {
    const w = sky.nightWindow(SITE, NOON);
    assert.equal(W.start.getTime(), w.astroDusk!.getTime());
    assert.equal(W.end.getTime(), w.astroDawn!.getTime());
    const o = planWindow(SITE, NOON, { ...SETTINGS, startOffsetMin: -30, windowEnd: '04:00' });
    assert.equal(o.start.getTime(), w.astroDusk!.getTime() - 30 * 60e3);
    assert.equal(sky.fmtTime(o.end, config.observer.timezone)?.slice(-5), '04:00');
  });
});

class FakeProbe extends EventEmitter {
  snap: ScopeSnapshot = { connected: true, goto: { state: 'idle' }, autofocus: { state: 'idle' }, fineFocus: { running: false }, stack: { running: false } };
  snapshot() {
    return structuredClone(this.snap);
  }
  set(f: (s: ScopeSnapshot) => void) {
    f(this.snap);
    this.emit('state');
  }
}

describe('night journal: the recorder', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  const night = sky.localDate(sky.nightWindow(SITE, NOON).sunset!, config.observer.timezone);
  const t0 = W.start.getTime() + 3600e3;

  test('a visit: GoTo, focus, stack, rejections, end', () => {
    const journal = new Journal({ dir: dir() });
    const probe = new FakeProbe();
    let t = t0;
    const rec = new JournalRecorder({ journal, probe, site: () => SITE, now: () => t, settleMs: 0 });
    rec.observe();
    const step = (s: number, f: (x: ScopeSnapshot) => void) => {
      t += s * 1000;
      probe.set(f);
      rec.observe();
    };
    step(1, (x) => (x.goto = { state: 'running', target: 'M 31' }));
    step(95, (x) => (x.goto = { state: 'complete', target: 'M 31' }));
    step(5, (x) => (x.autofocus = { state: 'running' }));
    step(60, (x) => {
      x.autofocus = { state: 'complete' };
      x.focusPosition = 1712;
    });
    step(5, (x) => (x.stack = { running: true, target: 'M 31', stacked: 0, rejected: 0, subS: 10 }));
    step(600, (x) => (x.stack = { ...x.stack, stacked: 55, rejected: 2 }));
    step(30, (x) => (x.stack = { ...x.stack, stacked: 57, rejected: 5 }));
    step(600, (x) => (x.stack = { ...x.stack, stacked: 110, rejected: 6 }));
    step(10, (x) => (x.stack = { ...x.stack, running: false }));
    const s = journal.night(night).sessions;
    assert.equal(s.length, 1);
    const st = s[0].stats;
    assert.equal(st.acquireS, 95);
    assert.equal(st.focusS, 60);
    assert.equal(st.focusPosition, 1712);
    assert.equal(st.stacked, 110);
    assert.equal(st.rejected, 6);
    assert.equal(st.integrationS, 1100);
    assert.ok(st.efficiencyPct! > 80);
    const kinds = s[0].marks.map((m) => m.kind);
    assert.deepEqual(kinds.filter((k) => k !== 'reject'), ['goto-start', 'goto-done', 'focus-start', 'focus-done', 'stack-start', 'stack-end']);
    // 2 then 3 within the burst window are one mark, the 1 ten minutes later another
    assert.deepEqual(s[0].marks.filter((m) => m.kind === 'reject').map((m) => m.n), [5, 1]);
    assert.ok(st.altStart !== undefined && st.moonIllumPct !== undefined);
  });

  describe('the Dwarf probe, on what the telescope really sends (wire log, 2026-11-08, C 34)', () => {
    const rig = () => {
      const st: Record<string, any> = { connected: true, released: false, goto: { state: 'idle' }, tracking: { state: 'idle' }, autofocus: { state: 'idle' }, stacking: { tele: { state: 'idle' } } };
      const journal = new Journal({ dir: dir() });
      let t = t0;
      const dwarf = Object.assign(new EventEmitter(), { state: st }) as unknown as Dwarf;
      const rec = new JournalRecorder({ journal, probe: dwarfProbe(dwarf, null as unknown as StreamHub), site: () => SITE, now: () => t, settleMs: 0 });
      rec.observe();
      const step = (s: number, f: () => void) => {
        t += s * 1000;
        f();
        rec.observe();
      };
      const oneClick = (d: Record<string, unknown>, at = Date.now()) => (st.oneClickGoto = { ...d, at });
      const session = () => journal.night(night).sessions[0];
      return { st, step, oneClick, session, journal };
    };

    test('a one-click GoTo is timed, though it never reports as gotoState', () => {
      const { st, step, oneClick, session, journal } = rig();
      const name = 'M 31';
      step(1, () => oneClick({ astroGotoState: { state: 1, targetName: name } }));
      step(6, () => oneClick({ astroGotoState: { state: 4, targetName: name } }));
      step(10, () => oneClick({ astroGotoState: { state: 3, targetName: name } }));
      // the stage's end, seen before the tracking that follows it, is not the GoTo failing
      assert.ok(!session().marks.some((m) => m.kind === 'goto-failed' || m.kind === 'goto-done'));
      step(0, () => {
        oneClick({ astroTrackingState: { state: 1, targetName: name } });
        st.tracking = { state: 'running', target: name };
      });
      assert.equal(session().target, name);
      assert.equal(session().stats.acquireS, 16);
      assert.equal(journal.summary(night).acquireMin, 0.3, 'a short GoTo does not round away to 0 min');
      assert.equal(session().stats.gotoAttempts, 1);
      assert.deepEqual(session().marks.map((m) => m.kind), ['goto-start', 'goto-done']);
    });

    test('a one-click GoTo that stops without tracking failed', () => {
      const { step, oneClick, session } = rig();
      step(1, () => oneClick({ astroGotoState: { state: 1, targetName: 'M 31' } }));
      step(10, () => oneClick({ astroGotoState: { state: 3, targetName: 'M 31' } }, Date.now() - 5_000));
      assert.deepEqual(session().marks.map((m) => m.kind), ['goto-start', 'goto-failed']);
    });

    test('the integration uses the sub length that only arrives with the progress', () => {
      const { st, step, session } = rig();
      step(1, () => (st.stacking.tele = { state: 'running', target: 'M 31' }));
      assert.equal(session().stats.subS, undefined);
      step(90, () => (st.stacking.tele = { state: 'running', target: 'M 31', currentCount: 1, stackedCount: 1, expIndex: 163 }));
      step(1710, () => (st.stacking.tele = { state: 'running', target: 'M 31', currentCount: 21, stackedCount: 20, expIndex: 163 }));
      assert.equal(session().stats.subS, 90);
      assert.equal(session().stats.integrationS, 1800);
      assert.equal(session().stats.rejected, 1);
    });

    test("the horizon survey's slews are not sessions", () => {
      const { st, step, oneClick, journal } = rig();
      step(1, () => oneClick({ astroGotoState: { state: 1, targetName: 'survey anchor NE' } }));
      step(20, () => {
        oneClick({ astroTrackingState: { state: 1, targetName: 'survey anchor NE' } });
        st.tracking = { state: 'running', target: 'survey anchor NE' };
      });
      assert.equal(journal.night(night).sessions.length, 0);
    });
  });

  test('the next target opens a new session and closes the last one', () => {
    const journal = new Journal({ dir: dir() });
    const probe = new FakeProbe();
    let t = t0;
    const rec = new JournalRecorder({ journal, probe, site: () => SITE, now: () => t, settleMs: 0 });
    rec.observe();
    const at = (s: number, f: (x: ScopeSnapshot) => void) => {
      t += s * 1000;
      probe.set(f);
      rec.observe();
    };
    at(1, (x) => (x.stack = { running: true, target: 'M 31', stacked: 10, rejected: 0, subS: 10 }));
    at(600, (x) => (x.stack = { ...x.stack, running: false, stacked: 60 }));
    at(60, (x) => (x.goto = { state: 'running', target: 'M 33' }));
    const s = journal.night(night).sessions;
    assert.equal(s.length, 2);
    assert.equal(s[0].status, 'done');
    assert.equal(s[1].target, 'M 33');
    assert.equal(rec.active()?.session.target, 'M 33');
  });

  test('notes are kept and show on the active session', () => {
    const journal = new Journal({ dir: dir() });
    const s = journal.openSession(night, { target: 'M 31' });
    const n = journal.addNote(night, { text: 'dew on the lens at 01:00', author: 'user' });
    assert.equal(journal.night(night).notes.length, 1);
    assert.ok(s.marks.some((m) => m.kind === 'note'));
    journal.deleteNote(night, n.id);
    assert.equal(journal.night(night).notes.length, 0);
  });

  test('the overhead and efficiency are learned once there are enough sessions', () => {
    const journal = new Journal({ dir: dir() });
    for (let i = 0; i < 4; i++) {
      const s = journal.openSession(night, { target: `T${i}`, at: t0 });
      s.marks.push({ at: t0, kind: 'goto-start' }, { at: t0 + 6 * 60e3, kind: 'stack-start' });
      s.stats = { stackS: 3600, efficiencyPct: 80 };
    }
    const l = learn(journal);
    assert.equal(l.overheadMin, 6);
    assert.equal(l.efficiency, 0.8);
    assert.equal(learn(new Journal({ dir: dir() })).samples, 0);
  });
});

describe('night plan: the target being worked', () => {
  const hour = 3600e3;
  const twin = (key: string, score: number) => cand('M 31', { key, displayName: key, source: 'filler', fillerScore: score, goalMin: undefined, collectedMin: undefined });
  const slotAfter = (hours: number) => new Date(W.start.getTime() + Math.round(hours * 6) * 600e3);
  /** when a target last stands above the plan's minimum altitude in the window */
  const setsAt = (name: string) => {
    const o = findObject(name)!;
    let last = W.start.getTime();
    for (let t = W.start.getTime(); t < W.end.getTime(); t += 300e3) if (sky.altAz(SITE, o.raHours, o.decDeg, new Date(t)).altitude >= SETTINGS.minAltitude) last = t;
    return last;
  };

  test('a running target with less than a minimum block left stays until it sets (the C 34 case)', () => {
    const sets = setsAt('NGC 7000');
    const from = new Date(sets - 90 * 60e3);
    const r = solve([cand('NGC 7000'), cand('M 42', { priority: 5 })], { from, current: { key: 'ngc 7000', since: from.getTime() - 3 * hour }, lock: { key: 'ngc 7000', until: sets + hour } });
    const first = targetBlocks(r)[0];
    assert.equal(first.target!.displayName, 'NGC 7000');
    assert.ok(first.end >= sets - 600e3, `it left ${(sets - first.end) / 60e3} min before setting`);
  });

  test('the margin protects the running target from a slightly better one, not from a much better one', () => {
    const from = slotAfter(2);
    const current = { key: 'a', since: from.getTime() - 3 * hour };
    assert.equal(targetBlocks(solve([twin('a', 50), twin('b', 55)], { from, current }))[0].target!.key, 'a');
    const beaten = targetBlocks(solve([twin('a', 50), twin('b', 70)], { from, current }))[0];
    assert.equal(beaten.target!.key, 'b');
    assert.equal(beaten.start, from.getTime());
    assert.ok(Number.isFinite(beaten.alt!.start));
  });

  test('the minimum block counts from when the scope went to it', () => {
    const from = slotAfter(2);
    const fresh = targetBlocks(solve([twin('a', 50), twin('b', 90)], { from, current: { key: 'a', since: from.getTime() - 600e3 } }))[0];
    assert.equal(fresh.target!.key, 'a');
    assert.equal(targetBlocks(solve([twin('a', 50), twin('b', 90)], { from, current: { key: 'a', since: from.getTime() - 3 * hour } }))[0].target!.key, 'b');
  });

  test('a locked target holds to the end of the lock against a much better one, then competes (the Sh2-131 case)', () => {
    const from = slotAfter(2);
    const until = slotAfter(3.5).getTime();
    const first = targetBlocks(solve([twin('a', 50), twin('b', 90)], { from, current: { key: 'a', since: from.getTime() - 3 * hour }, lock: { key: 'a', until } }))[0];
    assert.equal(first.target!.key, 'a');
    assert.equal(first.end, until);
  });

  test('a hold on it, or a pin, ends the lock early', () => {
    const from = slotAfter(2);
    const input = { from, current: { key: 'a', since: from.getTime() - 3 * hour }, lock: { key: 'a', until: slotAfter(5).getTime() } };
    const base = { id: 'h', from: from.getTime(), until: null, reason: 'test', by: 'agent' as const, createdAt: from.getTime() };
    assert.equal(targetBlocks(solve([twin('a', 50), twin('b', 40)], { ...input, holds: [{ ...base, kind: 'hold', target: 'a', cause: 'cloud' }] }))[0].target!.key, 'b');
    const pinned = targetBlocks(solve([twin('a', 50), twin('b', 40)], { ...input, holds: [{ ...base, kind: 'pin', target: 'b', until: slotAfter(4).getTime() }] }))[0];
    assert.equal(pinned.target!.key, 'b');
  });

  test('a target at its goal is not held by its lock', () => {
    const from = slotAfter(2);
    const r = solve([cand('M 31', { goalMin: 300, collectedMin: 300 }), cand('M 33')], { from, current: { key: 'ngc 224', since: from.getTime() - hour }, lock: { key: 'ngc 224', until: slotAfter(5).getTime() } });
    assert.equal(targetBlocks(r)[0].target!.displayName, 'M 33');
  });

  test('before the night starts, what the scope is on does not take the first block', () => {
    const r = solve([twin('a', 40), twin('b', 90)], { current: { key: 'a', since: W.start.getTime() - 600e3 } });
    assert.equal(targetBlocks(r)[0].target!.key, 'b');
  });

  test('the next block keeps its target by the margin only, and only in its own time', () => {
    const from = slotAfter(2);
    const end = W.end.getTime();
    assert.equal(targetBlocks(solve([twin('a', 50), twin('b', 55)], { from }))[0].target!.key, 'b');
    assert.equal(targetBlocks(solve([twin('a', 50), twin('b', 55)], { from, incumbent: { key: 'a', start: from.getTime(), end } }))[0].target!.key, 'a');
    assert.equal(targetBlocks(solve([twin('a', 50), twin('b', 70)], { from, incumbent: { key: 'a', start: from.getTime(), end } }))[0].target!.key, 'b');
    assert.equal(targetBlocks(solve([twin('a', 50), twin('b', 55)], { from, incumbent: { key: 'a', start: end - hour, end } }))[0].target!.key, 'b');
  });

  test('the service locks what the scope is on: re-solves plan around it, obscured releases it', async () => {
    const now = Date.parse('2026-11-02T03:30:00Z');
    const night = sky.localDate(new Date(now - 12 * hour), config.observer.timezone);
    const a = addTarget({ name: 'M 33', goalMin: 600, priority: 3 }, night);
    let active: { target: string; startedAt: number } | null = null;
    const svc: PlanService = new PlanService({
      site: () => SITE,
      fovArcmin: () => ({ w: 83, h: 147 }),
      journal: new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lock-j-')) }),
      active: () => (active ? { night: svc.currentNight().night, session: active as never } : null),
      now: () => now,
      conditions: async () => null,
      forecastStamp: async () => null,
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lock-p-')),
    });
    const on = (p: { blocks: Block[] }) => p.blocks.find((b) => b.start <= now && b.end > now)?.target?.displayName;
    await svc.plan();
    active = { target: 'M 33', startedAt: now - 4 * hour };
    assert.equal(on(await svc.replan('a session ended')), 'M 33');
    const b = addTarget({ name: 'M 31', goalMin: 600, priority: 5 }, night);
    try {
      assert.equal(on(await svc.replan('the program changed')), 'M 33');
      assert.equal(on(await svc.replan('the forecast was updated')), 'M 33');
      const out = await svc.obscured('M 33', { cause: 'cloud', by: 'agent' });
      assert.notEqual(out.now.block?.target?.displayName, 'M 33');
    } finally {
      removeTarget(a.id);
      removeTarget(b.id);
    }
  });

  test('sessions without a GoTo mark count towards the switch overhead, and each figure says if it is learned', () => {
    const journal = new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'over-j-')) });
    const night = new Date(Date.now() - 86_400e3).toISOString().slice(0, 10);
    const at = Date.now() - 20 * hour;
    for (let i = 0; i < 3; i++) {
      const s = journal.openSession(night, { target: `M ${i + 1}`, at: at + i * hour });
      s.marks.push({ kind: 'stack-start', at: at + i * hour + 20 * 60e3 });
      journal.closeSession(night, s, 'done', 'test');
    }
    const l = learn(journal);
    assert.equal(l.overheadMin, 20);
    assert.equal(l.overheadLearned, true);
    assert.equal(l.efficiencyLearned, false);
  });
});

describe('night plan: obstruction holds follow the sky', () => {
  test('rising in the east: held until it clears; setting in the west: out for the night; cloud: for a while', async () => {
    const now = Date.parse('2026-11-02T03:30:00Z');
    const svc = new PlanService({ site: () => SITE, fovArcmin: () => ({ w: 83, h: 147 }), journal: new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'plan-j-')) }), now: () => now, conditions: async () => null, forecastStamp: async () => null, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')) });
    const east = await svc.obscured('M 45', { cause: 'obstruction', by: 'user' });
    assert.ok(east.hold.until && east.hold.until > now, 'east: a time it clears');
    assert.match(east.hold.note ?? '', /rising/);
    const west = await svc.obscured('NGC 7000', { cause: 'obstruction', by: 'user' });
    assert.equal(west.hold.until, null);
    assert.match(west.hold.note ?? '', /setting/);
    const cloud = await svc.obscured('M 31', { cause: 'cloud', by: 'agent' });
    assert.equal(cloud.hold.until, now + 45 * 60e3);
    assert.equal(svc.holds().length, 3);
  });
});

describe('night plan: the target memory', () => {
  const svc = (journal: Journal, now: number) =>
    new PlanService({ site: () => SITE, fovArcmin: () => ({ w: 83, h: 147 }), journal, now: () => now, conditions: async () => null, forecastStamp: async () => null, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mem-')) });

  test("a program target the owner snoozed is held, with when it comes back; lifting it puts it back", async () => {
    const now = Date.parse('2026-11-01T18:00:00Z');
    const today = sky.localDate(new Date(now), config.observer.timezone);
    addTarget({ name: 'M 33', goalMin: 300, priority: 5 }, today);
    setRest('M 33', 'snoozed', today);
    const p = await svc(new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mem-j-')) }), now).plan();
    const o = p.outlook.find((x) => x.displayName === 'M 33')!;
    assert.equal(o.status, 'held');
    assert.match(o.reason, /snoozed until \d{4}-\d{2}-\d{2}/);
    liftRest('M 33');
    const q = await svc(new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mem-j-')) }), now).plan();
    assert.notEqual(q.outlook.find((x) => x.displayName === 'M 33')!.status, 'held');
    removeTarget('M 33');
  });

  test('collecting past the goal rests for the target-rest days from the night the goal was reached', async () => {
    const now = Date.parse('2026-11-01T18:00:00Z');
    const night = sky.localDate(sky.nightWindow(SITE, new Date(now)).sunset!, config.observer.timezone);
    addTarget({ name: 'M 42', goalMin: 60, priority: 3, keepCollecting: true }, night);
    const journal = new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mem-j-')) });
    const yesterday = new Date(Date.parse(`${night}T12:00:00Z`) - 86_400e3).toISOString().slice(0, 10);
    const s = journal.openSession(yesterday, { target: 'M 42', at: now - 86_400e3 });
    s.stats.integrationS = 90 * 60;
    journal.closeSession(yesterday, s, 'done', 'test');
    const p = await svc(journal, now).plan();
    const o = p.outlook.find((x) => x.displayName === 'M 42')!;
    assert.equal(o.status, 'held');
    assert.match(o.reason, new RegExp(`goal met on ${yesterday}: resting until`));
    removeTarget('M 42');
  });
});

describe('night plan: Find targets and the plan agree', () => {
  test("every filler the plan scheduled is in Find targets, first, with its block; the rest are ranked by the plan's own scoring", async () => {
    const now = Date.parse('2026-11-01T18:00:00Z');
    const svc = new PlanService({ site: () => SITE, fovArcmin: () => ({ w: 83, h: 147 }), journal: new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'find-j-')) }), now: () => now, conditions: async () => null, forecastStamp: async () => null, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'find-')) });
    const plan = await svc.plan();
    const fillers = [...new Set(plan.blocks.filter((b) => b.target?.source === 'filler').map((b) => b.target!.key))];
    assert.ok(fillers.length > 0, 'the empty program is filled from the catalog');
    const { targets } = await svc.suggestions({ limit: 40 });
    const keys = targets.map((t) => String(t.name).toLowerCase());
    fillers.forEach((k, i) => assert.equal(keys[i], k, `scheduled filler ${k} at the top of Find targets`));
    for (const t of targets.slice(0, fillers.length)) assert.ok((t.scheduled as unknown[]).length > 0);
    const rest = targets.slice(fillers.length).map((t) => t.planValue as number);
    for (let i = 1; i < rest.length; i++) assert.ok(rest[i - 1] >= rest[i], 'the rest by plan value');
  });
});

describe('night plan: capture settings per block', () => {
  test("with the scope's facts every target block carries the acquisition planner's settings, in the device's own filter names", async () => {
    const now = Date.parse('2026-11-01T18:00:00Z');
    const svc = new PlanService({
      site: () => SITE,
      fovArcmin: () => ({ w: 83, h: 147 }),
      journal: new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'acq-j-')) }),
      now: () => now,
      conditions: async () => null,
      forecastStamp: async () => null,
      facts: async () => ({ driver: 'seestar', model: 'Seestar S50 Pro', eqMode: true, gain: 200 }),
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'acq-')),
    });
    const plan = await svc.plan();
    const blocks = plan.blocks.filter((b) => b.kind === 'target' && !b.past);
    assert.ok(blocks.length > 0);
    for (const b of blocks) {
      const a = b.target!.advice?.acquisition;
      assert.ok(a, `${b.target!.displayName} has capture settings`);
      assert.ok(['IRCUT', 'LP'].includes(a.filter) && a.filter === b.target!.filter, `${a.filter} is the block's filter`);
      assert.ok([2, 5, 10, 20, 30, 60].includes(a.subS) && a.gain === 200);
      assert.ok(a.backgroundPct <= 25);
      assert.match(a.apply, /^set_camera_setting setting=exposure value=\d+; goto_target … lp_filter=(true|false)/);
    }
    const { targets } = await svc.suggestions({ limit: 5 });
    assert.ok(targets.some((t) => (t.capture as { subS: number } | null)?.subS), 'Find targets carries capture settings too');
  });
});
