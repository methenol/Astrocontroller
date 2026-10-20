import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchExposure, resolveFilter, exposureLabelSeconds, nearest } from '../dwarf/controller/util.js';

const values = [
  { name: '1/100', value: 10 },
  { name: '0.5', value: 20 },
  { name: '15', value: 30 },
];

describe('controller helpers', () => {
  test('an exposure label matches exactly, with or without a seconds suffix', () => {
    assert.equal(matchExposure(values, '15').value, 30);
    assert.equal(matchExposure(values, '15 s').value, 30);
    assert.equal(matchExposure(values, '1/100sec').value, 10);
  });

  test('an exposure between options takes the nearest in log time', () => {
    assert.equal(matchExposure(values, '10').value, 30);
    assert.equal(matchExposure(values, '0.02').value, 10);
  });

  test('a label that is not a time never wins the nearest match', () => {
    assert.equal(matchExposure([{ name: 'Auto', value: 0 }, ...values], '12').value, 30);
    assert.throws(() => matchExposure([{ name: 'Auto', value: 0 }], '12'), /not offered/);
  });

  test('nonsense exposures are refused', () => {
    assert.throws(() => matchExposure(values, 'soon'), /not understood/);
    assert.throws(() => matchExposure(values, '0'), /not understood/);
    assert.throws(() => matchExposure([], '1'), /no exposure options/);
  });

  test('filters by name or digit', () => {
    assert.equal(resolveFilter('Duo-Band'), 2);
    assert.equal(resolveFilter('Ha/OIII'), 2);
    assert.equal(resolveFilter('astro'), 1);
    assert.equal(resolveFilter('VIS'), 0);
    assert.equal(resolveFilter(1), 1);
    assert.throws(() => resolveFilter('red'), /unknown filter/);
  });

  test('label seconds and nearest allowed value', () => {
    assert.equal(exposureLabelSeconds('1/4'), 0.25);
    assert.equal(nearest([100, 200, 400], 260), 200);
    assert.equal(nearest([], 7), 7);
  });
});
