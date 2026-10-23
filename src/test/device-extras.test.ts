import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { config } from '../config.js';
import { Dwarf } from '../drivers/dwarf/device.js';
import { Cmd } from '../drivers/dwarf/protocol.js';
import { commandInfo, moduleIdFor } from '../drivers/dwarf/wire/index.js';

/**
 * The six device switches the official SDK never registered. What is under test is the recovered part:
 * the command ids, the `DEVICE` module the packet must carry, the single `state` field the APK's beans
 * put on the wire, and the payload schemas that report a switch back — none of which the SDK's tables
 * or generated classes supply.
 */

const ANTI_TANGLE = commandInfo('CMD_DEVICE_ANTI_TANGLE').id;
const NOTIFY_ANTI_TANGLE = commandInfo('CMD_NOTIFY_ANTI_TANGLE_STATE').id;
const NOTIFY_ATTITUDE = commandInfo('CMD_NOTIFY_DEVICE_ATTITUDE').id;
const DEVICE_MODULE = moduleIdFor('DEVICE');

describe('the device switches the SDK never registered', () => {
  let fake: FakeDwarf;
  let dwarf: Dwarf;

  before(() => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.httpPort = 9;
    config.dwarf.autoSyncTimeLocation = false;
  });

  beforeEach(async () => {
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 300 } });
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
    dwarf.setNdLock(true, 'test');
  });

  afterEach(async () => {
    dwarf.setNdLock(false);
    dwarf.stop();
    await fake.stop();
  });

  /** The device applies the switch and reports it as its command arrives — reporting on a timer would
   * race the agent's own round trip, and a report delivered before the controller started listening is
   * simply lost, which is exactly what the code under test must not be punished for. */
  const thenReports = (requestCmd: number, notifyCmd: number, state: number) => {
    fake.on(requestCmd, async (_req, f) => {
      await f.notify(notifyCmd, { state });
      // and the device owes no reply: the APK's WsCmd declares no response payload for the switches
      return undefined;
    });
  };

  test('anti-tangle goes to the DEVICE module with the one state field the APK sends', async () => {
    thenReports(ANTI_TANGLE, NOTIFY_ANTI_TANGLE, 1);
    const seen = fake.nextRequest(ANTI_TANGLE);
    const result = await dwarf.extras.setAntiTangle(true);

    const req = await seen;
    assert.equal(req.data.state, 1, 'DeviceSwitchState.fromEnabled(true) is 1');
    assert.deepEqual(Object.keys(req.data), ['state'], 'the APK sends no other field');
    assert.equal(req.moduleId, DEVICE_MODULE, 'the SDK encoder left MODULE_NONE on every command it never registered, which routes to the wrong service');
    assert.deepEqual(result, { code: 0, confirmed: true });
    assert.equal(dwarf.state.switches?.antiTangle, true, 'the device report reaches the state model');
  });

  test('turning it off sends state 0, and it is the report of 0 that confirms it', async () => {
    const seen = fake.nextRequest(ANTI_TANGLE);
    thenReports(ANTI_TANGLE, NOTIFY_ANTI_TANGLE, 0);
    const result = await dwarf.extras.setAntiTangle(false);

    assert.equal((await seen).data.state, 0);
    assert.equal(result.confirmed, true);
    assert.equal(dwarf.state.switches?.antiTangle, false);
  });

  test('a switch whose report never arrives is confirmed: false, and the state is not written', async () => {
    // The APK never waits for a reply here either, so the honest answer about a silent device is
    // "sent, not seen". Reporting it as set would let the UI show a switch that never moved.
    const result = await dwarf.extras.setAntiTangle(true);
    assert.equal(result.code, 0, 'nothing answered, which is what the device owes this command');
    assert.equal(result.confirmed, false);
    assert.equal(dwarf.state.switches?.antiTangle, undefined);
  });

  test('a report that contradicts the request does not confirm it', async () => {
    thenReports(ANTI_TANGLE, NOTIFY_ANTI_TANGLE, 0); // asked for on, the device says off
    const result = await dwarf.extras.setAntiTangle(true);
    assert.equal(result.confirmed, false, 'an opposite report is not agreement');
    assert.equal(dwarf.state.switches?.antiTangle, false, 'and the state carries what the device said, not what was asked');
  });

  test('the state read carries the switches and focus encoders the SDK schema does not model', async () => {
    // The SDK's generated ResGetDeviceStateInfo declares one field and its DeviceStateInfo declares
    // none, so on the SDK's schema every value below decodes to nothing.
    fake.reply(Cmd.TASK_GET_DEVICE_STATE_INFO, {
      code: 0,
      deviceStateInfo: {
        antiTangle: { state: 1 },
        lensDefog: { state: 1 },
        autoCooling: { state: 0 },
        autoShutdown: { state: 1 },
        powerSound: { state: 1 },
        shootingDoNotDisturb: { state: 0 },
      },
      wideFocusMotorStateInfo: { focusPosition: { pos: 45 } },
      guideFocusMotorStateInfo: { focusPosition: { pos: 6 } },
    });

    await dwarf.refreshState();

    assert.deepEqual(dwarf.state.switches, { antiTangle: true, lensDefog: true, autoCooling: false, autoShutdown: true, powerSound: true, doNotDisturb: false });
    assert.equal(dwarf.state.wideFocusPosition, 45, 'the wide focus encoder position, which the SDK could not report');
    assert.equal(dwarf.state.guideFocusPosition, 6, 'nor the guide focus encoder position');
  });

  test('the device attitude notification is named and decoded from the recovered catalogue', async () => {
    const seen = dwarf.link.waitFor((n) => n.name === 'deviceAttitude', 2000);
    await fake.notify(NOTIFY_ATTITUDE, { pitch: 12.5, yaw: 180, roll: -3 });
    const n = await seen;

    assert.equal(n.data.pitch, 12.5, 'decoded against the APK descriptor rather than left as raw bytes');
    assert.equal(dwarf.state.attitude?.pitchDeg, 12.5);
    assert.equal(dwarf.state.attitude?.yawDeg, 180);
    assert.equal(dwarf.state.attitude?.rollDeg, -3);
  });
});
