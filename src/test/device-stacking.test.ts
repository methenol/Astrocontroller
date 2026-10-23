import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { config } from '../config.js';
import { Dwarf } from '../drivers/dwarf/device.js';
import { DwarfCommandError } from '../drivers/dwarf/link.js';
import { Cmd } from '../drivers/dwarf/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// No HTTP API in these tests: point it at a closed port so camera-schema lookups fail fast.
before(() => {
  config.dwarf.host = '127.0.0.1';
  config.dwarf.httpPort = 9;
  config.dwarf.autoSyncTimeLocation = false;
});

describe('Dwarf live stacking against the fake telescope', () => {
  let fake: FakeDwarf;
  let dwarf: Dwarf;

  beforeEach(async () => {
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    Object.assign(dwarf.stackTiming, { replyMs: 1500, confirmMs: 1500, errorConfirmMs: 800 });
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
  });

  /** fw 1.5.3 behaviour on 2026-10-12 04:33-04:34 (wire log): -11530 without force; with force no reply, but it stacks. */
  function wideLikeTonight() {
    fake.on(Cmd.ASTRO_START_WIDE_CAPTURE_LIVE_STACKING, async (req, f) => {
      if (!req.data.forceStart) return { code: -11530 };
      setTimeout(async () => {
        await f.notify('teleStackingState', { state: 1 });
        await sleep(30);
        await f.notify('teleStackingProgress', { totalCount: 999, updateType: 2, expIndex: 156, gainIndex: 18, targetName: 'C 20', cameraType: 1 });
      }, 80);
      return undefined;
    });
  }

  test('wide start without force: the -11530 refusal is an error with its code', async () => {
    wideLikeTonight();
    await assert.rejects(dwarf.startStacking('wide'), (e: unknown) => e instanceof DwarfCommandError && e.code === -11530);
    assert.equal(dwarf.state.stacking.wide.state, 'idle');
    // the refused start does not lock the exposure for the retry's settings
    assert.equal(dwarf.stackOwnsCamera('wide'), false);
  });

  test('tele start answered with the -11526 overexposure warning but stacking: started, with the warning, without force', async () => {
    fake.on(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING, async (req, f) => {
      assert.equal(req.data.forceStart ?? false, false);
      setTimeout(() => void f.notify('teleStackingState', { state: 1 }), 60);
      return { code: -11526 };
    });
    const r = await dwarf.startStacking('tele', { filterIndex: 1 });
    assert.match(r, /tele live stacking .*started with a WARNING from the telescope: .*11526/);
    assert.equal(dwarf.state.stacking.tele.state, 'running');
    assert.equal(fake.requestsFor(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING).length, 1);
  });

  test('wide forced start with no reply: confirmed from the notifications at once, attributed to the wide camera', async () => {
    wideLikeTonight();
    dwarf.stackTiming.replyMs = 6000;
    const t0 = Date.now();
    const r = await dwarf.startStacking('wide', { force: true });
    const took = Date.now() - t0;
    assert.match(r, /wide live stacking started/);
    // the notifications prove it within 100 ms; then 1.5 s for a reply that may carry a warning code
    assert.ok(took < 2500, `took ${took} ms: must not wait out the 6 s reply timeout`);
    assert.equal(dwarf.state.stacking.wide.state, 'running');
    assert.equal(dwarf.state.stacking.wide.target, 'C 20');
    assert.equal(dwarf.state.stacking.tele.state, 'idle');
  });

  test('exposure and gain changes are refused while the wide stack runs', async () => {
    wideLikeTonight();
    await dwarf.startStacking('wide', { force: true });
    await assert.rejects(dwarf.setSetting('wide', 'exposure', 'auto'), /refused: the wide camera is live stacking/);
    await assert.rejects(dwarf.setSetting('wide', 'gain', 60), /refused/);
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).length, 0);
  });

  test('a shooting-mode switch is refused while a stack runs (it would end the stack)', async () => {
    wideLikeTonight();
    await dwarf.startStacking('wide', { force: true });
    await assert.rejects(dwarf.setShootingMode('Normal'), /refused: the wide camera is live stacking.*changing the shooting mode/);
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE).length, 0);
  });

  test('a stack asked for under the ND lock is refused before the mode or any setting is touched', async () => {
    dwarf.setNdLock(true, 'test');
    try {
      await assert.rejects(dwarf.startStackingWith('tele', { exposure: 15, gain: 80, filter: 'Astro', startedBy: 'ui' }), /refused: live stacking while the ND filter is fitted/);
      for (const cmd of [Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE, Cmd.PARAM_SET_EXPOSURE, Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING]) assert.equal(fake.requestsFor(cmd).length, 0);
      assert.equal(fake.requests.length, 0, `nothing sent: ${fake.requests.map((r) => r.cmd).join(', ')}`);
    } finally {
      dwarf.setNdLock(false);
    }
  });

  test('a start the firmware neither answers nor reports fails with an explanation', async () => {
    fake.silent(Cmd.ASTRO_START_WIDE_CAPTURE_LIVE_STACKING);
    await assert.rejects(dwarf.startStacking('wide'), /neither acknowledged/);
    assert.equal(dwarf.stackOwnsCamera('wide'), false);
  });

  test('tele start acknowledged with code 0 is running at once', async () => {
    fake.reply(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING, { code: 0 });
    const r = await dwarf.startStacking('tele', { filterIndex: 1 });
    assert.match(r, /tele live stacking \(filter Astro/);
    assert.equal(dwarf.state.stacking.tele.state, 'running');
    const req = fake.requestsFor(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING)[0];
    assert.equal(req.data.irIndex, 1);
  });

  test('fast stop answered under another command id: returns on the state notification, not after the timeout', async () => {
    wideLikeTonight();
    await dwarf.startStacking('wide', { force: true });
    // 2026-10-12 05:24:50: 11038 fast stop → reply arrives as the normal wide stop, then states 2, 3
    fake.on(11038, async (_req, f) => {
      setTimeout(async () => {
        await f.notify('teleStackingState', { state: 2 });
        await f.unsolicitedReply(Cmd.ASTRO_STOP_WIDE_CAPTURE_LIVE_STACKING, {});
        await f.notify('teleStackingState', { state: 3 });
      }, 50);
      return undefined;
    });
    const t0 = Date.now();
    await dwarf.stopStacking('wide', true);
    assert.ok(Date.now() - t0 < 2000, `stop took ${Date.now() - t0} ms`);
    assert.equal(dwarf.state.stacking.wide.state, 'stopped');
  });

  test('a lost stop notification is reconciled from the state read (tele not capturing in two reads → ended)', async () => {
    fake.reply(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING, { code: 0 });
    await dwarf.startStacking('tele', { filterIndex: 0 });
    assert.equal(dwarf.state.stacking.tele.state, 'running');
    // still inside the start claim: a state read that does not show the capture yet is not proof
    fake.reply(Cmd.TASK_GET_DEVICE_STATE_INFO, { teleCameraStateInfo: { exclusiveState: {} } });
    await dwarf.refreshState();
    await dwarf.refreshState();
    assert.equal(dwarf.state.stacking.tele.state, 'running');
    // past the claim (as 2 min later): one read is not enough, two are
    dwarf.stacks.startFailed('tele');
    await dwarf.refreshState();
    assert.equal(dwarf.state.stacking.tele.state, 'running');
    await dwarf.refreshState();
    assert.equal(dwarf.state.stacking.tele.state, 'idle');
    // and a read that shows the capture keeps a running stack running
    fake.reply(Cmd.TASK_GET_DEVICE_STATE_INFO, { teleCameraStateInfo: { exclusiveState: { captureRawState: { state: 1 } } } });
    // (progress within 15 s of an end is a straggler and ignored; a state notification starts a stack)
    await fake.notify('teleStackingState', { state: 1 });
    await sleep(50);
    assert.equal(dwarf.state.stacking.tele.state, 'running');
    await dwarf.refreshState();
    await dwarf.refreshState();
    assert.equal(dwarf.state.stacking.tele.state, 'running');
  });
});
