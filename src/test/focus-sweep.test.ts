import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { FakeHttpApi, dsoSchema } from './fake-http.js';
import { FakeFocuser } from './fake-focuser.js';
import { config } from '../config.js';
import { Dwarf } from '../drivers/dwarf/device.js';
import { Cmd } from '../drivers/dwarf/protocol.js';
import { invalidateParamSchema } from '../drivers/dwarf/http.js';
import { starFocusSweep, measureTele } from '../media/focus.js';
import type { StreamHub } from '../media/streams.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only what the focus code touches on the tele stream: the still pauses it, then it is reconnected. */
function stubHub(dwarf: Dwarf) {
  const cam = { pauses: 0, retries: 0, expectPause() { this.pauses++; }, retryRtsp() { this.retries++; } };
  return { hub: { dwarf, get: () => cam, camera: () => cam, lastMotionAt: () => 0 } as unknown as StreamHub, cam };
}

describe('star-focus sweep and tele measurement: the camera is handed back as it was', () => {
  let fake: FakeDwarf;
  let api: FakeHttpApi;
  let dwarf: Dwarf;
  let focuser: FakeFocuser | undefined;

  before(() => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.autoSyncTimeLocation = false;
  });

  beforeEach(async () => {
    invalidateParamSchema();
    api = await new FakeHttpApi().start();
    api.route('POST /shootingMode/getParamAndSetting', () => ({ data: dsoSchema() }));
    config.dwarf.httpPort = api.port;
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    Object.assign(dwarf.focusTiming, { stepMs: 2, quietMs: 100, settleMaxMs: 1500 });
    dwarf.state.shootingMode = { id: 2, name: 'DSO' };
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
    // the imaging settings in use: 15 s manual, gain 60
    await fake.notify('intParam', { paramId: 101, mode: 1, value: 156 });
    await fake.notify('intParam', { paramId: 102, mode: 1, value: 60 });
    await sleep(50);
  });

  afterEach(async () => {
    focuser?.stop();
    focuser = undefined;
    dwarf.stop();
    await fake.stop();
    await api.stop();
  });

  test('a sweep whose first still fails puts exposure and gain back, and the error says where the focuser is', async () => {
    focuser = new FakeFocuser(fake, 500);
    fake.reply(Cmd.CAMERA_TELE_PHOTOGRAPH, { code: -1 });
    const { hub, cam } = stubHub(dwarf);
    await assert.rejects(starFocusSweep({ dwarf, hub }, { center: 500, range: 10, step: 5, gain: 100, settleMs: 0 }), /star focus could not measure 500: .* the focuser was returned to its starting position 500/);
    const exp = fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).map((r) => r.data.value);
    assert.deepEqual(exp, [100, 156], 'set to 1/2 s for the stills, then back to 15 s');
    const gain = fake.requestsFor(Cmd.PARAM_SET_GAIN).map((r) => r.data.value);
    assert.deepEqual(gain, [100, 60], 'gain set for the stills, then back');
    assert.equal(dwarf.state.focusTune?.running, false);
    await sleep(1600);
    assert.equal(cam.retries, 1, 'the live view is reconnected');
  });

  test('a sweep on a camera that never reported its exposure puts it back to auto, not to the "unknown" label', async () => {
    focuser = new FakeFocuser(fake, 500);
    dwarf.params.delete('101');
    fake.reply(Cmd.CAMERA_TELE_PHOTOGRAPH, { code: -1 });
    const { hub } = stubHub(dwarf);
    await assert.rejects(starFocusSweep({ dwarf, hub }, { center: 500, range: 10, step: 5, settleMs: 0 }), /star focus could not measure 500/);
    const exp = fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).map((r) => r.data.mode);
    assert.deepEqual(exp, [1, 0], 'set to 1/2 s (manual) for the stills, then back to auto');
  });

  test('a sweep is refused while a tele stack is starting, before anything is changed', async () => {
    focuser = new FakeFocuser(fake, 500);
    dwarf.stacks.startSent('tele');
    const { hub } = stubHub(dwarf);
    await assert.rejects(starFocusSweep({ dwarf, hub }, { center: 500, gain: 100 }), /refused: the tele camera is live stacking/);
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).length + fake.requestsFor(Cmd.PARAM_SET_GAIN).length, 0);
    assert.equal(focuser.steps, 0);
  });

  test('a measurement is refused while a tele stack runs, before its gain is changed', async () => {
    dwarf.stacks.startSent('tele');
    const { hub } = stubHub(dwarf);
    await assert.rejects(measureTele({ dwarf, hub }, { gain: 100 }), /refused: the tele camera is live stacking/);
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_GAIN).length, 0);
  });

  test('a measurement shoots its still only once a changed exposure and gain have taken hold, as a sweep sample does', async () => {
    fake.reply(Cmd.CAMERA_TELE_PHOTOGRAPH, { code: -1 });
    const { hub } = stubHub(dwarf);
    await assert.rejects(measureTele({ dwarf, hub }, { gain: 100 }));
    // by order, not by time: the restore after the refused still can land in the same millisecond
    const at = fake.requests.findIndex((r) => r.cmd === Cmd.CAMERA_TELE_PHOTOGRAPH);
    assert.ok(at >= 0, 'a still was asked for');
    const shot = fake.requests[at];
    const before = fake.requests.slice(0, at).filter((r) => r.cmd === Cmd.PARAM_SET_EXPOSURE || r.cmd === Cmd.PARAM_SET_GAIN);
    assert.ok(before.length, 'the settings were changed before the still');
    const lastSet = before[before.length - 1].t;
    assert.ok(shot.t - lastSet >= 1400, `the still came ${shot.t - lastSet} ms after the last setting`);
    assert.deepEqual(fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).map((r) => r.data.value), [100, 156], 'the same 1/2 s a sweep would use, then back to 15 s');
  });

  test('a measurement whose still fails puts the gain back', async () => {
    fake.reply(Cmd.CAMERA_TELE_PHOTOGRAPH, { code: -1 });
    const { hub } = stubHub(dwarf);
    await assert.rejects(measureTele({ dwarf, hub }, { gain: 100 }));
    assert.deepEqual(fake.requestsFor(Cmd.PARAM_SET_GAIN).map((r) => r.data.value), [100, 60]);
  });
});
