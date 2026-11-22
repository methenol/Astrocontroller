import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeDwarf } from './fake-dwarf.js';
import { config } from '../config.js';
import { Dwarf } from '../drivers/dwarf/device.js';
import { Cmd } from '../drivers/dwarf/protocol.js';
import { PULSE_DEG, PULSE_MAX_HZ } from '../drivers/dwarf/controller/rotation-odometer.js';

before(() => {
  config.dwarf.host = '127.0.0.1';
  config.dwarf.httpPort = 9;
  config.dwarf.autoSyncTimeLocation = false;
});

const countFile = () => path.join(config.paths.data, 'mini-rotation.json');

/**
 * The Dwarf mini's mount as fw 1.1.4.19 drives it (2026-11-21): rotation never reports a position
 * (-14520) and refuses run-to; pitch is un-homed after power-on until a reset; a pulse move turns an
 * axis by pulses × 0.009° (direction=true: rotation up, pitch down), replies at once and runs on for
 * pulses / rate; a second pulse move on the same axis while one runs cancels it.
 */
class FakeMiniMount {
  /** true rotation from power-on, in pulses (+ = direction true) */
  rotationPulses = 0;
  pitch: number;
  pitchHomed = false;
  /** pulse moves sent while one was still running on the same axis */
  overlaps = 0;
  private busyUntil: Record<number, number> = { 1: 0, 2: 0 };
  constructor(fake: FakeDwarf, pitch = 2.5) {
    this.pitch = pitch;
    fake.on(Cmd.STEP_MOTOR_GET_POSITION, (req) => {
      const id = Number(req.data.id);
      if (id === 2 && this.pitchHomed) return { id, code: 0, position: this.pitch };
      return { id, code: -14520 };
    });
    fake.on(Cmd.STEP_MOTOR_RESET, (req) => {
      const id = Number(req.data.id);
      if (id === 1) return { id, code: -14511 };
      this.pitchHomed = true;
      return { id, code: 0 };
    });
    fake.on(Cmd.STEP_MOTOR_RUN_TO, (req) => {
      const id = Number(req.data.id);
      if (id === 1 || !this.pitchHomed) return { id, code: -14520 };
      this.pitch = Number(req.data.endPosition);
      return { id, code: 0 };
    });
    fake.on(Cmd.STEP_MOTOR_RUN_IN_PULSE, (req) => {
      const id = Number(req.data.id);
      const pulses = Number(req.data.pulse);
      const hz = Math.min(Number(req.data.frequency), PULSE_MAX_HZ);
      const now = Date.now();
      if (now < this.busyUntil[id] - 30) this.overlaps++;
      this.busyUntil[id] = now + (pulses / hz) * 1000;
      const sign = req.data.direction ? 1 : -1;
      if (id === 1) this.rotationPulses += sign * pulses;
      else this.pitch = Math.round((this.pitch - sign * pulses * PULSE_DEG) * 1e6) / 1e6;
      return { id };
    });
  }
  get rotationDeg(): number {
    return Math.round(this.rotationPulses * PULSE_DEG * 1000) / 1000;
  }
}

describe('Dwarf mini: the rotation count', () => {
  let fake: FakeDwarf;
  let dwarf: Dwarf;
  let mount: FakeMiniMount;

  const connect = async () => {
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    dwarf.state.device = { name: 'DWARF_mini_TEST01', serial: 'DM0001' };
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  };

  beforeEach(async () => {
    fs.rmSync(countFile(), { force: true });
    fake = await new FakeDwarf().start();
    mount = new FakeMiniMount(fake);
    await connect();
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
  });

  test('a just-powered-on mini (pitch without a reference) starts the count at 0°', async () => {
    const p = await dwarf.readMotorPositions();
    assert.equal(p.rotationDeg, 0);
    assert.equal(dwarf.state.motors.rotationCounted, true);
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_GET_POSITION).filter((r) => Number(r.data.id) === 1).length, 0, 'rotation is never asked for its position');
  });

  test('a nudge turns rotation with counted pulse moves, never the joystick; the count matches the mount', async () => {
    await dwarf.readMotorPositions();
    await dwarf.homeMotors();
    await dwarf.nudge(90, 0.3, 900); // right: the view pans right, rotation counts down
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_SERVICE_JOYSTICK).length, 0);
    assert.ok(mount.rotationPulses < 0, 'turned the right way');
    const p = await dwarf.readMotorPositions();
    assert.equal(p.rotationDeg, Math.round(mount.rotationDeg * 100) / 100);
    assert.equal(mount.overlaps, 0, 'no pulse move cut another short');
  });

  test('homing turns the base back to its power-on rotation, the way it came', async () => {
    await dwarf.readMotorPositions();
    await dwarf.homeMotors();
    await dwarf.nudge(270, 0.5, 700);
    await dwarf.nudge(270, 0.5, 700);
    assert.ok(mount.rotationDeg > 5);
    const msg = await dwarf.homeMotors();
    assert.equal(mount.rotationPulses, 0, 'exactly back at the power-on rotation');
    assert.match(msg, /rotation back at its power-on position/);
    assert.equal(mount.pitch, 2.5);
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_RESET).filter((r) => Number(r.data.id) === 1).length, 0, 'never a rotation reset');
    assert.equal(mount.overlaps, 0);
  });

  test('moveTo drives rotation to an angle from power-on; parking returns it to 0°', async () => {
    await dwarf.readMotorPositions();
    await dwarf.homeMotors();
    const msg = await dwarf.moveTo({ rotationDeg: -12.5, pitchDeg: 90 }, 20);
    assert.equal(mount.rotationDeg, -12.501);
    assert.match(msg, /rotation -12\.5\d*° from where it was powered on/);
    await assert.rejects(dwarf.moveTo({ rotationDeg: 400 }), /out of range -360–360°/);
    await dwarf.park();
    assert.equal(mount.rotationPulses, 0);
    assert.equal(mount.pitch, 2.5);
  });

  test('a firmware routine that turns the base makes the count inexact: nothing trusts it after', async () => {
    await dwarf.readMotorPositions();
    await dwarf.homeMotors();
    await dwarf.moveTo({ rotationDeg: 10 }, 20);
    fake.reply(Cmd.ASTRO_START_EQ_SOLVING, { code: -11516 });
    await dwarf.raw(Cmd.ASTRO_START_EQ_SOLVING, { lon: 0, lat: 0 }).catch(() => null);
    const p = await dwarf.readMotorPositions();
    assert.equal(p.rotationDeg, undefined);
    assert.equal(dwarf.state.motors.rotationCounted, false);
    assert.match(String(dwarf.state.motors.rotationUnknown), /since a polar alignment turned the base/);
    await assert.rejects(dwarf.moveTo({ rotationDeg: 0 }), /cannot be driven to: the rotation count is not exact since a polar alignment/);
    const before = mount.rotationPulses;
    const msg = await dwarf.homeMotors();
    assert.equal(mount.rotationPulses, before, 'homing left rotation alone');
    assert.match(msg, /rotation left where it is: the rotation count is not exact since a polar alignment/);
  });

  test('a stop waits for the pulse move running instead of cutting it, so the count stays exact', async () => {
    await dwarf.readMotorPositions();
    await dwarf.homeMotors();
    const move = dwarf.moveTo({ rotationDeg: 60 }, 15).catch((e: Error) => e);
    while (mount.rotationPulses === 0) await new Promise((r) => setTimeout(r, 10));
    await dwarf.stopMotion();
    const r = await move;
    assert.ok(r instanceof Error && /stopped with the base/.test(r.message), String(r));
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_STOP).length, 0, 'no motor stop cut a pulse move');
    const p = await dwarf.readMotorPositions();
    assert.ok(mount.rotationDeg > 0 && mount.rotationDeg < 60);
    assert.equal(p.rotationDeg, Math.round(mount.rotationDeg * 100) / 100);
  });

  test('the count survives a restart of the program while the mini stays on (pitch still referenced)', async () => {
    await dwarf.readMotorPositions();
    await dwarf.homeMotors();
    await dwarf.moveTo({ rotationDeg: 7 }, 20);
    dwarf.stop();
    await connect();
    const p = await dwarf.readMotorPositions();
    assert.equal(p.rotationDeg, 7);
    // a power cycle: pitch loses its reference, the base stands where it is now: zero again
    mount.pitchHomed = false;
    dwarf.stop();
    await connect();
    assert.equal((await dwarf.readMotorPositions()).rotationDeg, 0);
  });
});

describe('Dwarf mini: rotation from where it points (EQ wedge)', () => {
  // the user's site; zero = the meridian, rotation = −HA × 15°
  const site = { lat: 28.7977, lon: -81.701, elev: 30 };
  const when = new Date('2026-11-22T03:00:00Z');
  const tmp = () => path.join(config.paths.data, `rot-${Math.random().toString(36).slice(2)}.json`);

  test('a target on the meridian is rotation 0°; east of it counts up, west counts down, 15° per hour', async () => {
    const { rotationForPointing } = await import('../drivers/dwarf/controller/rotation-odometer.js');
    const { hourAngle } = await import('../astro/sky.js');
    // a target on the meridian now: RA = the local sidereal time (J2000 near enough at Dec 0 for the check)
    const ra = (((hourAngle(site, 0, 0, when) % 24) + 24) % 24); // HA of RA 0 = LST − 0
    assert.ok(Math.abs(rotationForPointing(site, ra, 0, false, when)) < 0.5);
    const east2h = rotationForPointing(site, (ra + 2) % 24, 0, false, when);
    const west3h = rotationForPointing(site, (ra + 21) % 24, 0, false, when);
    assert.ok(Math.abs(east2h - 30) < 0.5, `east 2 h: ${east2h}`);
    assert.ok(Math.abs(west3h + 45) < 0.5, `west 3 h: ${west3h}`);
    assert.ok(Math.abs(rotationForPointing(site, ra, 60, true, when) - 180) < 0.5 || Math.abs(rotationForPointing(site, ra, 60, true, when) + 180) < 0.5, 'far side of the pole: +180°');
  });

  test('while tracking, the angle follows the hour angle (15.04°/h); when tracking ends the count goes on from there', async () => {
    const { RotationOdometer } = await import('../drivers/dwarf/controller/rotation-odometer.js');
    const o = new RotationOdometer(tmp());
    o.powerOn();
    const a0 = o.pointedAt(site, 5.5, -5.4, 120, 'M42', when);
    const later = new Date(when.getTime() + 3600_000);
    const a1 = o.angle(site, later)!;
    const d = ((a0 - a1 + 540) % 360) - 180;
    assert.ok(Math.abs(d - 15.04) < 0.05, `turned ${d}° in an hour`);
    // a counted nudge while tracking moves the tracked position with it
    o.add(2);
    assert.ok(Math.abs(((o.angle(site, later)! - a1 + 540) % 360) - 180 - 2) < 0.01);
    o.stopFollowing(site, later);
    assert.equal(o.following(), undefined);
    assert.ok(Math.abs(o.angle(site)! - (a1 + 2)) < 0.01, 'frozen where tracking ended');
    // a firmware routine loses it; the next GoTo gives it back
    o.lose('a polar alignment');
    assert.equal(o.angle(site), undefined);
    assert.equal(typeof o.pointedAt(site, 5.5, -5.4, 120, 'M42', when), 'number');
    assert.notEqual(o.angle(site, when), undefined);
  });

  test('the side of the pole: pitch past 180° is the far side; unknown pitch picks the side nearer the power-on rotation', async () => {
    const { RotationOdometer, rotationForPointing } = await import('../drivers/dwarf/controller/rotation-odometer.js');
    const o = new RotationOdometer(tmp());
    o.powerOn();
    o.pointedAt(site, 2, 70, 200, 'far', when);
    assert.equal(o.following()?.flipped, true);
    o.pointedAt(site, 2, 20, undefined, 'low', when);
    assert.equal(o.following()?.flipped, false, 'below 45° declination only the near side reaches');
    o.pointedAt(site, 2, 70, undefined, 'high', when);
    const near = Math.abs(rotationForPointing(site, 2, 70, false, when));
    assert.equal(o.following()?.flipped, Math.abs(rotationForPointing(site, 2, 70, true, when)) < near);
  });
});
