import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StackTracker, type CameraName } from '../drivers/dwarf/stacking.js';
import { StackSupervisor } from '../drivers/dwarf/stack-supervisor.js';

function rig(o: { autoStopAfterMs?: number; stopFails?: boolean; canAct?: boolean } = {}) {
  let now = 10_000_000;
  const stacks = new StackTracker(() => now, () => 15);
  const stops: CameraName[] = [];
  const notes: string[] = [];
  let canAct = o.canAct ?? true;
  const device = {
    stacks,
    canAct: () => canAct,
    async stopStacking(cam: CameraName) {
      stops.push(cam);
      if (o.stopFails) throw new Error('no reply');
      stacks.onNotification('teleStackingState', { state: 3 }, now);
    },
  };
  const sup = new StackSupervisor(device, (t) => notes.push(t), { autoStopAfterMs: o.autoStopAfterMs ?? 10 * 60_000, now: () => now });
  sup.start();
  let taken = 0;
  let stacked = 0;
  const frame = (accepted: boolean, cam: CameraName = 'wide') => {
    now += 15_000;
    taken++;
    stacks.onNotification('teleStackingProgress', { currentCount: taken, cameraType: cam === 'wide' ? 1 : undefined, targetName: 'C 20' }, now);
    if (accepted) stacked++;
    stacks.onNotification('teleStackingProgress', { updateType: 1, stackedCount: stacked, cameraType: cam === 'wide' ? 1 : undefined, targetName: 'C 20' }, now + 1000);
  };
  const begin = (cam: CameraName = 'wide') => {
    stacks.startSent(cam);
    stacks.onNotification('teleStackingState', { state: 1 }, now);
  };
  return { stacks, sup, stops, notes, frame, begin, device, adv: (ms: number) => (now += ms), setCanAct: (v: boolean) => (canAct = v) };
}

describe('StackSupervisor', () => {
  test('a stack that rejects everything: the agent is told at once, and the stack is stopped after the grace period', async () => {
    const r = rig();
    r.begin();
    for (let i = 0; i < 20; i++) r.frame(true);
    for (let i = 0; i < 20; i++) r.frame(false);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /COLLECTING NOTHING/);
    assert.match(r.notes[0], /STOPS this stack itself/);
    await r.sup.tick();
    assert.deepEqual(r.stops, []);
    // 10 min of 15 s frames, all rejected
    for (let i = 0; i < 41; i++) r.frame(false);
    await r.sup.tick();
    assert.deepEqual(r.stops, ['wide']);
    assert.match(r.notes[r.notes.length - 1], /STOPPED the wide stack/);
    assert.equal(r.stacks.info.wide.state, 'stopped');
    assert.equal(r.sup.actions.at(-1)?.action, 'stopped');
  });

  test('a passing cloud: frames stack again before the deadline, so no stop', async () => {
    const r = rig();
    r.begin();
    for (let i = 0; i < 20; i++) r.frame(true);
    for (let i = 0; i < 20; i++) r.frame(false);
    for (let i = 0; i < 20; i++) r.frame(true);
    r.adv(11 * 60_000);
    await r.sup.tick();
    assert.deepEqual(r.stops, []);
    assert.match(r.notes.at(-1)!, /stacking again/);
  });

  test('a stalled stack (no frames at all) is stopped too', async () => {
    const r = rig();
    r.begin();
    r.adv(110_000);
    r.stacks.tick();
    assert.match(r.notes[0], /STALLED/);
    r.adv(10 * 60_000);
    r.stacks.tick();
    await r.sup.tick();
    assert.deepEqual(r.stops, ['wide']);
  });

  test('a stall that ends with frames arriving again (some rejected) is not stopped', async () => {
    const r = rig();
    r.begin();
    // a thin-cloud night: about a third of the frames stack
    for (let i = 0; i < 21; i++) r.frame(i % 3 === 0);
    assert.equal(r.stacks.info.wide.health?.verdict, 'degraded');
    r.adv(200_000);
    r.stacks.tick();
    assert.match(r.notes.at(-1) ?? '', /STALLED/);
    for (let i = 0; i < 6; i++) r.frame(i % 3 === 0);
    assert.equal(r.stacks.info.wide.health?.verdict, 'degraded');
    assert.equal(r.sup.alarm('wide'), undefined, 'the stall alarm is over');
    r.adv(11 * 60_000);
    await r.sup.tick();
    assert.deepEqual(r.stops, []);
  });

  test('waits while the controller cannot act, then stops', async () => {
    const r = rig();
    r.begin();
    for (let i = 0; i < 12; i++) r.frame(false);
    r.adv(11 * 60_000);
    r.setCanAct(false);
    await r.sup.tick();
    assert.deepEqual(r.stops, []);
    r.setCanAct(true);
    await r.sup.tick();
    assert.deepEqual(r.stops, ['wide']);
  });

  test('a failed stop is reported and retried a minute later', async () => {
    const r = rig({ stopFails: true });
    r.begin();
    for (let i = 0; i < 12; i++) r.frame(false);
    r.adv(11 * 60_000);
    await r.sup.tick();
    assert.equal(r.stops.length, 1);
    assert.match(r.notes.at(-1)!, /stop failed/);
    await r.sup.tick();
    assert.equal(r.stops.length, 1);
    r.adv(61_000);
    await r.sup.tick();
    assert.equal(r.stops.length, 2);
  });

  test('a stack stopped or restarted by someone else ends the episode without a stop', async () => {
    const r = rig();
    r.begin();
    for (let i = 0; i < 12; i++) r.frame(false);
    r.stacks.onNotification('teleStackingState', { state: 3 }, Date.now());
    r.adv(11 * 60_000);
    await r.sup.tick();
    assert.deepEqual(r.stops, []);
    assert.equal(r.sup.alarm('wide'), undefined);
  });

  test('autoStopAfterMs 0: notify only, never stop', async () => {
    const r = rig({ autoStopAfterMs: 0 });
    r.begin();
    for (let i = 0; i < 12; i++) r.frame(false);
    assert.equal(r.notes.length, 1);
    assert.doesNotMatch(r.notes[0], /STOPS/);
    r.adv(60 * 60_000);
    await r.sup.tick();
    assert.deepEqual(r.stops, []);
  });
  test('with the automatic stop off, an alarm ends with its stack', async () => {
    const r = rig({ autoStopAfterMs: 0 });
    r.begin();
    for (let i = 0; i < 20; i++) r.frame(true);
    for (let i = 0; i < 20; i++) r.frame(false);
    assert.equal(r.sup.alarm('wide')?.verdict, 'rejecting');
    await r.device.stopStacking('wide');
    assert.equal(r.sup.alarm('wide'), undefined, 'a stopped stack has no alarm');
  });
});
