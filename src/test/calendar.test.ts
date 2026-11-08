import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closeGaps, nightRuns, summarizeWindows } from '../night/calendar.js';
import { queryCatalog } from '../astro/catalog-search.js';

const opts = { minBlockH: 0.75, goalMin: 600, collectedMin: 0, efficiency: 0.75 };
/** `n` nights at `h` hours each. */
const nights = (...spans: Array<[number, number]>) => spans.flatMap(([n, h]) => Array<number>(n).fill(h));

describe('calendar windows', () => {
  test('short breaks do not end a run, but long ones and the year\'s ends do', () => {
    const f = (s: string) => [...s].map((c) => c === '#');
    assert.deepEqual(closeGaps(f('##..##')), f('######'));
    assert.deepEqual(closeGaps(f('##....##'), 3), f('##....##'));
    assert.deepEqual(closeGaps(f('..##..')), f('..##..'));
    assert.deepEqual(nightRuns(f('##..#')), [[0, 1], [4, 4]]);
  });

  test('a target in its best nights with few left is closing, counted from its last optimal night', () => {
    const up = nights([10, 10], [40, 5], [315, 0]);
    const s = summarizeWindows(up, up, opts);
    assert.deepEqual(s.optimal.current, [0, 9]);
    assert.deepEqual(s.collectable.current, [0, 49]);
    assert.equal(s.group, 'closing');
    assert.equal(s.deadline, 9);
  });

  test('a target with a long optimal run is at its peak', () => {
    const up = nights([60, 10], [305, 0]);
    const s = summarizeWindows(up, up, opts);
    assert.equal(s.group, 'peak');
    assert.equal(s.deadline, 59);
  });

  test('a usable target before its best nights is coming up, not closing', () => {
    const up = nights([20, 4], [40, 10], [305, 0]);
    const s = summarizeWindows(up, up, opts);
    assert.equal(s.group, 'opening');
    assert.equal(s.deadline, 20);
  });

  test('a usable target past its best nights is closing', () => {
    const up = nights([20, 4], [300, 0], [45, 10]);
    const s = summarizeWindows(up, up, opts);
    assert.equal(s.group, 'closing');
    assert.equal(s.deadline, 19);
  });

  test('a target out of reach for months is later, and one that never rises has no window', () => {
    assert.equal(summarizeWindows(nights([200, 0], [165, 8]), nights([200, 0], [165, 8]), opts).group, 'later');
    const never = summarizeWindows(nights([365, 0]), nights([365, 0]), opts);
    assert.equal(never.verdict, 'no-window');
    assert.equal(never.deadline, null);
  });

  test('expected hours use the Moon-clear hours, capped per night, and decide the verdict', () => {
    const up = nights([10, 8], [355, 0]);
    // 6 h cap × 0.75 efficiency × 0.5 share × 0.45 clear = 1.0125 h a night
    const s = summarizeWindows(up, up, { ...opts, goalMin: 240 });
    assert.equal(s.expectedTotalH, 10.1);
    assert.equal(s.needH, 4);
    assert.equal(s.verdict, 'on-track');
    assert.equal(summarizeWindows(up, up, { ...opts, goalMin: 480 }).verdict, 'tight');
    assert.equal(summarizeWindows(up, up, opts).verdict, 'tight');
    assert.equal(summarizeWindows(up, up, { ...opts, goalMin: 720 }).verdict, 'short');
    assert.equal(summarizeWindows(up, nights([365, 0]), { ...opts, goalMin: 60 }).verdict, 'short');
  });

  test('a met goal is done, and no goal gives no verdict', () => {
    const up = nights([30, 8], [335, 0]);
    assert.equal(summarizeWindows(up, up, { ...opts, collectedMin: 600 }).verdict, 'done');
    assert.equal(summarizeWindows(up, up, { ...opts, goalMin: 0 }).verdict, 'no-goal');
  });
});

test('a catalog query can be limited to given objects and still applies its filters', () => {
  const ids = new Set(['NGC 224', 'NGC 1976']);
  const all = queryCatalog({ ids, limit: 10 }, null, 'UTC');
  assert.deepEqual(all.items.map((r) => r.id).sort(), ['NGC 1976', 'NGC 224']);
  assert.deepEqual(queryCatalog({ ids, types: ['galaxy'], limit: 10 }, null, 'UTC').items.map((r) => r.id), ['NGC 224']);
});
