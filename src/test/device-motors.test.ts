import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { config } from '../config.js';
import { Dwarf } from '../dwarf/device.js';
import { Cmd } from '../dwarf/protocol.js';

before(() => {
  config.dwarf.host = '127.0.0.1';
  config.dwarf.httpPort = 9;
  config.dwarf.autoSyncTimeLocation = false;
});

type Axis = 1 | 2;

/**
 * The two axes as fw 1.5.3 drives them (2026-10-04..12): un-homed after power-on (position reads
 * answer -14520); a reset finds the reference switch and drives the axis back to where it started;
 * run-to moves and answers when the motion ends; the firmware's time limit (-14511) can end a
 * reset or a move early with the axis part of the way.
 */
class FakeMount {
  pos: Record<Axis, number>;
  homed: Record<Axis, boolean> = { 1: false, 2: false };
  /** replies -14511 to the first N resets / moves of an axis */
  resetOvertime: Record<Axis, number> = { 1: 0, 2: 0 };
  runOvertime: Record<Axis, number> = { 1: 0, 2: 0 };
  /** the pitch reference after a reset (a wrong one, as after a power-off mid-reset) */
  pitchAfterReset?: number;
  /** called when a reset arrives (before it is answered) */
  onReset?: (id: Axis) => Promise<void> | void;
  constructor(fake: FakeDwarf, start: { rotation: number; pitch: number }) {
    this.pos = { 1: start.rotation, 2: start.pitch };
    fake.on(Cmd.STEP_MOTOR_GET_POSITION, (req) => {
      const id = Number(req.data.id) as Axis;
      return this.homed[id] ? { id, code: 0, position: this.pos[id] } : { id, code: -14520 };
    });
    fake.on(Cmd.STEP_MOTOR_RESET, async (req) => {
      const id = Number(req.data.id) as Axis;
      await this.onReset?.(id);
      if (this.resetOvertime[id] > 0) {
        this.resetOvertime[id]--;
        return { id, code: -14511 };
      }
      this.homed[id] = true;
      if (id === 2 && this.pitchAfterReset !== undefined) this.pos[2] = this.pitchAfterReset;
      return { id, code: 0 };
    });
    fake.on(Cmd.STEP_MOTOR_RUN_TO, (req) => {
      const id = Number(req.data.id) as Axis;
      const end = Number(req.data.endPosition);
      if (!this.homed[id]) return { id, code: -14520 };
      if (this.runOvertime[id] > 0) {
        this.runOvertime[id]--;
        this.pos[id] = (this.pos[id] + end) / 2;
        return { id, code: -14511 };
      }
      this.pos[id] = end;
      return { id, code: 0 };
    });
  }
}

describe('Dwarf motors against a fake mount', () => {
  let fake: FakeDwarf;
  let dwarf: Dwarf;

  beforeEach(async () => {
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
  });

  const motorCmds = () => fake.requests.filter((r) => [Cmd.STEP_MOTOR_RESET, Cmd.STEP_MOTOR_RUN_TO, Cmd.STEP_MOTOR_SERVICE_JOYSTICK].includes(r.cmd));

  test('homing: pitch reset, rotation reset, then parked at rotation 159° / pitch 2.5°', async () => {
    const m = new FakeMount(fake, { rotation: 80, pitch: 120 });
    const r = await dwarf.homeMotors();
    assert.match(r, /homed: rotation 159° .* pitch 2\.5°/);
    const resets = fake.requestsFor(Cmd.STEP_MOTOR_RESET).map((x) => Number(x.data.id));
    assert.deepEqual(resets, [2, 1]);
    assert.deepEqual([m.pos[1], m.pos[2]], [159, 2.5]);
  });

  test('a reset ended by the firmware\'s time limit is repeated and noted', async () => {
    const m = new FakeMount(fake, { rotation: 80, pitch: 120 });
    m.resetOvertime[1] = 1;
    const r = await dwarf.homeMotors();
    assert.match(r, /rotation needed 2 resets \(stopped at the firmware's time limit/);
    assert.equal(m.pos[1], 159);
  });

  test('a wrong reference after a reset (outside the travel) stops homing before any move', async () => {
    const m = new FakeMount(fake, { rotation: 80, pitch: 120 });
    m.pitchAfterReset = 323;
    await assert.rejects(dwarf.homeMotors(), /pitch reports 323° after its reset, outside its 0–195° travel/);
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_RUN_TO).length, 0);
  });

  test('a power-off during homing stops it; nothing more is sent', async () => {
    const m = new FakeMount(fake, { rotation: 80, pitch: 120 });
    m.onReset = async (id) => {
      if (id === 2) await fake.notify('powerOff', {});
    };
    await assert.rejects(dwarf.homeMotors(), /homing stopped: the telescope powered off/);
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_RESET).length, 1);
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_RUN_TO).length, 0);
  });

  test('moveTo: an out-of-range target moves nothing', async () => {
    new FakeMount(fake, { rotation: 80, pitch: 120 });
    await assert.rejects(dwarf.moveTo({ pitchDeg: 200 }), /out of range .* Nothing was moved/);
    await assert.rejects(dwarf.moveTo({ rotationDeg: 330 }), /out of range .* Nothing was moved/);
    assert.equal(motorCmds().length, 0);
  });

  test('moveTo on un-homed axes homes first, then moves', async () => {
    const m = new FakeMount(fake, { rotation: 80, pitch: 120 });
    const r = await dwarf.moveTo({ rotationDeg: 200, pitchDeg: 150 }, 20);
    assert.match(r, /homed first; now at rotation 200°, pitch 150°/);
    assert.deepEqual([m.pos[1], m.pos[2]], [200, 150]);
  });

  test('a move ended early by the time limit continues from the measured position', async () => {
    const m = new FakeMount(fake, { rotation: 100, pitch: 100 });
    m.homed = { 1: true, 2: true };
    m.runOvertime[2] = 1;
    const r = await dwarf.moveTo({ pitchDeg: 160 }, 20);
    assert.match(r, /pitch 160°/);
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_RUN_TO).length, 2);
  });

  test('motion is refused while a stack runs or is starting (homing, moves and slews)', async () => {
    const m = new FakeMount(fake, { rotation: 100, pitch: 100 });
    m.homed = { 1: true, 2: true };
    dwarf.stacks.startSent('wide');
    await assert.rejects(dwarf.moveTo({ pitchDeg: 160 }), /refused: the wide camera is live stacking/);
    await assert.rejects(dwarf.homeMotors(), /refused: the wide camera is live stacking/);
    await assert.rejects(dwarf.nudge(0, 0.3, 500), /refused: the wide camera is live stacking/);
    assert.equal(motorCmds().length, 0);
  });

  test('a stop ends a running slew at once, not after its full duration', async () => {
    const joystick = () => fake.requestsFor(Cmd.STEP_MOTOR_SERVICE_JOYSTICK).length;
    const started = Date.now();
    const slew = dwarf.nudge(0, 0.3, 20_000);
    while (joystick() === 0) await new Promise((r) => setTimeout(r, 10));
    await dwarf.stopMotion();
    await slew;
    const sent = joystick();
    assert.ok(Date.now() - started < 5000, 'the 20 s slew returned soon after the stop');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(joystick(), sent, 'no joystick vector after the stop');
  });

  test('a newer slew takes over: the older one stops sending and does not stop the newer', async () => {
    const first = dwarf.nudge(0, 0.3, 20_000);
    while (fake.requestsFor(Cmd.STEP_MOTOR_SERVICE_JOYSTICK).length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = dwarf.nudge(90, 0.3, 400);
    await first;
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP).length, 0, 'the superseded slew sent no stop');
    await second;
    assert.equal(fake.requestsFor(Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP).length, 1);
  });
});
