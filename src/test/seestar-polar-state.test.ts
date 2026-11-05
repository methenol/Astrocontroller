import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, busyWith, initialState, polarAligning } from '../drivers/seestar/model.js';

test('a polar alignment that ends on EqModePA complete after a 3PPA calc3 step is over (fw 9.75, 2026-11-05)', () => {
  const st = initialState('local');
  applyEvent(st, { Event: '3PPA', state: 'calc3', route: [] });
  assert.equal(busyWith(st), 'polar alignment', 'a 3PPA step alone is a run in progress');
  applyEvent(st, { Event: 'EqModePA', state: 'complete', x: -0.49, y: -0.36, route: [] });
  assert.equal(polarAligning(st), false);
  assert.equal(busyWith(st), null);
  // a new run starts again
  applyEvent(st, { Event: 'EqModePA', state: 'working', route: [] });
  assert.equal(busyWith(st), 'polar alignment');
});

test('a 3PPA step nobody followed up for 10 min is not a run', () => {
  const st = initialState('local');
  applyEvent(st, { Event: '3PPA', state: 'calc1', route: [] });
  assert.equal(polarAligning(st, Date.now() + 11 * 60_000), false);
});
