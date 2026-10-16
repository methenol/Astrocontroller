import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { FakeHttpApi, dsoSchema } from './fake-http.js';
import { config } from '../config.js';
import { Dwarf } from '../dwarf/device.js';
import { DwarfCommandError } from '../dwarf/link.js';
import { Cmd } from '../dwarf/protocol.js';
import { invalidateParamSchema } from '../dwarf/http.js';

describe('Dwarf stack start with settings (agent and web UI path)', () => {
  let fake: FakeDwarf;
  let api: FakeHttpApi;
  let dwarf: Dwarf;

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
    Object.assign(dwarf.stackTiming, { replyMs: 1000, confirmMs: 1000, errorConfirmMs: 500 });
    Object.assign(dwarf.stackRestartTiming, { settleMs: 400, retryMs: 100 });
    dwarf.state.shootingMode = { id: 2, name: 'DSO' };
    fake.reply(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING, { code: 0 });
    fake.reply(Cmd.ASTRO_START_WIDE_CAPTURE_LIVE_STACKING, { code: 0 });
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
    await api.stop();
  });

  test('settings and start, in order, with the matching exposure index', async () => {
    const r = await dwarf.startStackingWith('tele', { exposure: 15, gain: 60, frames: 200, startedBy: 'agent' });
    assert.match(r, /tele exposure → 15s/);
    assert.match(r, /tele gain → 60/);
    assert.match(r, /stackCount → 200/);
    assert.match(r, /tele live stacking/);
    const exp = fake.requestsFor(Cmd.PARAM_SET_EXPOSURE)[0];
    assert.equal(exp.data.value, 156);
    const start = fake.requestsFor(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING)[0];
    assert.ok(start.t >= exp.t);
    assert.equal(dwarf.stackControl.tele.startedBy, 'agent');
  });

  test('right after a stop: waits out the settle time before sending settings', async () => {
    // a tele stack that has just ended (as reported over the wire)
    await fake.notify('teleStackingState', { state: 1 });
    await fake.notify('teleStackingState', { state: 3 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dwarf.state.stacking.tele.state, 'stopped');
    const t0 = dwarf.state.stacking.tele.stoppedAt!;
    await dwarf.startStackingWith('tele', { exposure: 15, startedBy: 'agent' });
    const first = fake.requestsFor(Cmd.PARAM_SET_EXPOSURE)[0];
    assert.ok(first.t - t0 >= 350, `exposure sent ${first.t - t0} ms after the stop`);
  });

  test('after a stack ended, the next start first finishes it with go live (once), then sends settings and the start', async () => {
    await fake.notify('wideStackingState', { state: 1 });
    await fake.notify('wideStackingState', { state: 3 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dwarf.state.stacking.wide.state, 'stopped');
    await dwarf.startStackingWith('wide', { exposure: 15, startedBy: 'agent' });
    const live = fake.requestsFor(Cmd.ASTRO_WIDE_GO_LIVE);
    assert.equal(live.length, 1);
    assert.ok(live[0].t <= fake.requestsFor(Cmd.PARAM_SET_EXPOSURE)[0].t);
    assert.ok(live[0].t <= fake.requestsFor(Cmd.ASTRO_START_WIDE_CAPTURE_LIVE_STACKING)[0].t);
    assert.equal(fake.requestsFor(Cmd.ASTRO_GO_LIVE).length, 0, 'the tele camera is left alone');
  });

  test('no go live before a first stack', async () => {
    await dwarf.startStackingWith('tele', { exposure: 15, startedBy: 'agent' });
    assert.equal(fake.requestsFor(Cmd.ASTRO_GO_LIVE).length, 0);
  });

  test('a -1 from the still-closing stack is retried once, then the start goes on', async () => {
    let n = 0;
    fake.on(Cmd.PARAM_SET_EXPOSURE, () => (++n === 1 ? { code: -1 } : { code: 0 }));
    const r = await dwarf.startStackingWith('tele', { exposure: 15, startedBy: 'agent' });
    assert.equal(n, 2);
    assert.match(r, /tele live stacking/);
  });

  test('a -1 that persists fails with its code and sends no start', async () => {
    fake.reply(Cmd.PARAM_SET_EXPOSURE, { code: -1 });
    await assert.rejects(dwarf.startStackingWith('tele', { exposure: 15, startedBy: 'agent' }), (e: unknown) => e instanceof DwarfCommandError && e.code === -1);
    assert.equal(fake.requestsFor(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING).length, 0);
  });

  test('a start already under way is refused before anything is sent', async () => {
    dwarf.stacks.startSent('tele');
    await assert.rejects(dwarf.startStackingWith('tele', { exposure: 15, startedBy: 'ui' }), /already live stacking or starting/);
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).length, 0);
  });

  test('the filter set is the filter the stack starts with (Ha → Duo-Band, index 2)', async () => {
    await dwarf.startStackingWith('tele', { filter: 'Ha', startedBy: 'agent' });
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_GENERAL_INT_PARAM)[0].data.value, 2);
    assert.equal(fake.requestsFor(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING)[0].data.irIndex, 2);
  });

  test('wide: a filter is reported as not applicable, and the wide stack count is the wide one', async () => {
    const r = await dwarf.startStackingWith('wide', { filter: 'Astro', frames: 120, startedBy: 'ui' });
    assert.match(r, /filter Astro not applied/);
    const ints = fake.requestsFor(Cmd.PARAM_SET_GENERAL_INT_PARAM);
    assert.equal(ints.length, 1);
    assert.equal(String(ints[0].data.paramId), '302');
    assert.equal(ints[0].data.value, 120);
  });
  test('live-video heal: a camera left at a long manual exposure is set back to auto when no stack wants it', async () => {
    await fake.notify('intParam', { paramId: 101, mode: 1, value: 156 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await dwarf.autoExposureForLiveView('tele'), 15);
    const set = fake.requestsFor(Cmd.PARAM_SET_EXPOSURE);
    assert.equal(set.length, 1);
    assert.equal(set[0].data.mode ?? 0, 0);
  });

  test('live-video heal never undercuts a stack being prepared (exposure set, start not yet sent)', async () => {
    dwarf.stackRestartTiming.settleMs = 0;
    // the exposure command is answered slowly, as over the 2026-10-12 link
    fake.on(Cmd.PARAM_SET_EXPOSURE, async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { code: 0 };
    });
    await fake.notify('intParam', { paramId: 101, mode: 1, value: 156 });
    await new Promise((r) => setTimeout(r, 50));
    const start = dwarf.startStackingWith('tele', { exposure: 15, startedBy: 'agent' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await dwarf.autoExposureForLiveView('tele'), null);
    await start;
    assert.equal(await dwarf.autoExposureForLiveView('tele'), null, 'the running stack owns it');
    const autos = fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).filter((r) => Number(r.data.mode ?? 0) === 0);
    assert.equal(autos.length, 0);
  });
  test('a second start while the first is still being prepared is refused; one start is sent', async () => {
    dwarf.stackRestartTiming.settleMs = 0;
    fake.on(Cmd.PARAM_SET_EXPOSURE, async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { code: 0 };
    });
    const first = dwarf.startStackingWith('tele', { exposure: 15, startedBy: 'agent' });
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(dwarf.startStackingWith('tele', { exposure: 10, startedBy: 'ui' }), /already live stacking or starting/);
    await first;
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_EXPOSURE).length, 1);
    assert.equal(fake.requestsFor(Cmd.ASTRO_START_CAPTURE_RAW_LIVE_STACKING).length, 1);
  });

  test('while a stack is being prepared, nothing else may change that camera (its own settings go through)', async () => {
    dwarf.stackRestartTiming.settleMs = 0;
    fake.on(Cmd.PARAM_SET_EXPOSURE, async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { code: 0 };
    });
    const start = dwarf.startStackingWith('tele', { exposure: 15, gain: 60, startedBy: 'agent' });
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(dwarf.setSetting('tele', 'gain', 100), /refused: the tele camera is live stacking \(or a stack on it is starting\)/);
    await assert.rejects(dwarf.setSetting('tele', 'filter', 'Astro'), /refused: the tele camera/);
    await assert.rejects(dwarf.takePhoto('tele'), /refused: the tele camera/);
    await assert.rejects(dwarf.focusTo(500), /refused: the tele camera is live stacking/);
    // the other camera is free
    await dwarf.setSetting('wide', 'gain', 80);
    await start;
    const gains = fake.requestsFor(Cmd.PARAM_SET_GAIN).map((r) => [String(r.data.paramId), r.data.value]);
    assert.deepEqual(gains, [['202', 80], ['102', 60]]);
    assert.equal(fake.requestsFor(Cmd.CAMERA_TELE_PHOTOGRAPH).length, 0);
  });
});
