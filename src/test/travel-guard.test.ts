import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TravelGuard, type TravelDevice } from '../dwarf/travel-guard.js';
import * as sky from '../astro/sky.js';

const SITE = { lat: 45.5, lon: -122.6, elev: 50 };
const M42 = { raHours: 5.588, decDeg: -5.39 };

/**
 * A stand-in for the telescope: a running stack, and a rotation axis whose angle the test drives
 * (`rotationAt(t)`); readMotorPositions samples it at the simulated time.
 */
function rig(o: { eq?: boolean; rotationAt: (t: number) => number; t0: number; stopFails?: number; target?: string }) {
  let now = o.t0;
  let failsLeft = o.stopFails ?? 0;
  const notes: string[] = [];
  const stops: string[] = [];
  const state: any = {
    bodyMode: o.eq ? 'eq' : 'altaz',
    motors: {},
    stacking: {
      tele: { state: 'running', startedAt: o.t0, target: o.target ?? 'M 42', stackedCount: 10, currentCount: 10 },
      wide: { state: 'idle' },
    },
    travel: undefined,
  };
  const device = {
    state,
    link: { usable: true },
    operation: null,
    async readMotorPositions() {
      state.motors = { rotationDeg: Math.round(o.rotationAt(now) * 100) / 100, pitchDeg: 120, homed: true, updatedAt: now };
      return state.motors;
    },
    location: () => SITE,
    publishState(p: Record<string, unknown>) {
      Object.assign(state, p);
    },
    async stopStacking(cam: string) {
      stops.push(cam);
      if (failsLeft > 0) {
        failsLeft--;
        throw new Error('no reply');
      }
      state.stacking[cam] = { ...state.stacking[cam], state: 'stopped', stoppedAt: now };
    },
  } as unknown as TravelDevice;
  const guard = new TravelGuard(device, (t) => notes.push(t), { now: () => now, lookup: (n) => (n === 'M 42' ? M42 : null) });
  /** run the guard every 15 s of simulated time for `minutes` */
  const run = async (minutes: number) => {
    for (let i = 0; i < minutes * 4; i++) {
      now += 15_000;
      await guard.tick();
    }
  };
  return { guard, notes, stops, state, run, now: () => now };
}

describe('TravelGuard', () => {
  test('EQ (rate fit): notice ahead, then the stack is stopped before the end of the rotation travel', async () => {
    const t0 = Date.UTC(2026, 9, 12, 6, 0);
    // 20° and falling 0.4°/min: the 0° stop in 50 min
    const r = rig({ eq: true, t0, rotationAt: (t) => 20 - ((t - t0) / 60000) * 0.4 });
    await r.run(10);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /reaches the end of the rotation axis \(0°\)/);
    assert.deepEqual(r.stops, []);
    await r.run(40);
    assert.deepEqual(r.stops, ['tele']);
    const stoppedAt = (r.state.stacking.tele.stoppedAt - t0) / 60000;
    assert.ok(stoppedAt >= 43 && stoppedAt < 50, `stopped ${stoppedAt} min in (limit at 50)`);
    assert.match(r.notes.at(-1)!, /STOPPED the tele stack/);
    assert.equal(r.state.travel.stage, 'stopped');
  });

  test('a failed stop is retried a minute later (not left to the firmware\'s limit stop)', async () => {
    const t0 = Date.UTC(2026, 9, 12, 6, 0);
    const r = rig({ eq: true, t0, rotationAt: (t) => 8 - ((t - t0) / 60000) * 0.4, stopFails: 1 });
    await r.run(18);
    assert.equal(r.stops.length, 2, `stops: ${r.stops.length}`);
    assert.ok(r.notes.some((n) => /stop failed/.test(n) && /tries again in a minute/.test(n)));
    assert.equal(r.state.stacking.tele.state, 'stopped');
  });

  test('tele and wide stacking together: both are stopped (the rotation axis carries both)', async () => {
    const t0 = Date.UTC(2026, 9, 12, 6, 0);
    const r = rig({ eq: true, t0, rotationAt: (t) => 10 - ((t - t0) / 60000) * 0.4 });
    r.state.stacking.wide = { state: 'running', startedAt: t0 + 1000, target: 'M 42', stackedCount: 4, currentCount: 4 };
    await r.run(30);
    assert.deepEqual(r.stops.sort(), ['tele', 'wide']);
    assert.equal(r.state.stacking.tele.state, 'stopped');
    assert.equal(r.state.stacking.wide.state, 'stopped');
    assert.match(r.notes.at(-1)!, /STOPPED the tele and wide stack/);
  });

  test('a stack moving away from the ends is left alone', async () => {
    const t0 = Date.UTC(2026, 9, 12, 6, 0);
    const r = rig({ eq: true, t0, rotationAt: (t) => 150 + ((t - t0) / 60000) * 0.25 });
    await r.run(60);
    assert.deepEqual(r.stops, []);
    assert.equal(r.notes.length, 0);
  });

  test('Alt-Az: forecast from the target\'s azimuth, stopped before the 315° end, with when it is reachable again', async () => {
    // start where M 42's azimuth is rising steadily, with the rotation 15° short of the end
    let t0 = Date.UTC(2026, 9, 12, 9, 0);
    const az = (t: number) => sky.altAz(SITE, M42.raHours, M42.decDeg, new Date(t)).azimuth;
    while (az(t0 + 60000) - az(t0) < 0.15) t0 += 5 * 60000;
    const offset = 300 - az(t0);
    const r = rig({ t0, rotationAt: (t) => az(t) + offset });
    await r.run(3);
    assert.equal(r.state.travel?.method, 'azimuth');
    assert.equal(r.state.travel?.limitDeg, 315);
    await r.run(120);
    assert.deepEqual(r.stops, ['tele']);
    const rotAtStop = r.state.motors.rotationDeg;
    assert.ok(rotAtStop < 315 && rotAtStop > 308, `rotation at the stop ${rotAtStop}`);
    assert.match(r.notes[0], /forecast from the target's azimuth/);
    assert.ok(r.state.travel.reachableAgainAt > r.state.travel.limitAt, 'reachable-again time after the limit');
    assert.match(r.notes.at(-1)!, /is back inside the rotation travel from about/);
  });

  test('Alt-Az: with no end reached within the horizon, the forecast names the end tracking is heading for', async () => {
    let t0 = Date.UTC(2026, 9, 12, 9, 0);
    const az = (t: number) => sky.altAz(SITE, M42.raHours, M42.decDeg, new Date(t)).azimuth;
    while (az(t0 + 60000) - az(t0) < 0.15) t0 += 5 * 60000;
    // rising, but far from the 315° end
    const offset = 10 - az(t0);
    const r = rig({ t0, rotationAt: (t) => az(t) + offset });
    await r.run(3);
    assert.equal(r.state.travel?.method, 'azimuth');
    assert.equal(r.state.travel?.minutesToLimit, null);
    assert.equal(r.state.travel?.limitDeg, 315);
    assert.deepEqual(r.stops, []);
  });

  test('the stack ending by itself resets the guard (no stop, nothing stale for the next stack)', async () => {
    const t0 = Date.UTC(2026, 9, 12, 6, 0);
    const r = rig({ eq: true, t0, rotationAt: (t) => 20 - ((t - t0) / 60000) * 0.4 });
    await r.run(10);
    r.state.stacking.tele = { ...r.state.stacking.tele, state: 'stopped' };
    await r.run(1);
    assert.equal(r.state.travel, undefined);
    assert.deepEqual(r.stops, []);
  });
});
