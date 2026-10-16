import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { FakeHttpApi, dsoSchema } from './fake-http.js';
import { config } from '../config.js';
import { Dwarf } from '../dwarf/device.js';
import { Cmd } from '../dwarf/protocol.js';
import { invalidateParamSchema } from '../dwarf/http.js';

/** captureRawState as the device state read reports it: 3 = stopped but not finished */
const STOPPED = 3;
const RUNNING = 1;

describe('an ended stacking session is finished (go live) before the camera is used again', () => {
  let fake: FakeDwarf;
  let api: FakeHttpApi;
  let dwarf: Dwarf;

  before(() => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.autoSyncTimeLocation = false;
  });

  const deviceState = (captureState: number) =>
    fake.reply(Cmd.TASK_GET_DEVICE_STATE_INFO, { shootingMode: 2, teleCameraStateInfo: { exclusiveState: { captureRawState: { state: captureState } }, hFov: 2.95, vFov: 1.66 } });

  beforeEach(async () => {
    invalidateParamSchema();
    api = await new FakeHttpApi().start();
    api.route('POST /shootingMode/getParamAndSetting', () => ({ data: dsoSchema() }));
    api.route('POST /album/list/mediaInfos', () => ({ data: [{ camId: 0, mediaType: 1, filePath: '/DWARF3/Normal_Photos/t.jpg', fileName: 't.jpg', modificationTime: Math.floor(Date.now() / 1000) }] }));
    config.dwarf.httpPort = api.port;
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    dwarf.state.shootingMode = { id: 2, name: 'DSO' };
    fake.on(Cmd.CAMERA_TELE_PHOTOGRAPH, () => {
      setTimeout(() => void fake.notify('photoState', { state: 0 }), 20);
      return { code: 0 };
    });
    fake.reply(Cmd.ASTRO_GO_LIVE, { code: 0 });
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
    await api.stop();
  });

  test('the device reports the tele capture stopped (as after a controller restart): go live, then the photo; once', async () => {
    deviceState(STOPPED);
    await dwarf.refreshState();
    const item = await dwarf.takePhoto('tele');
    assert.equal(item?.fileName, 't.jpg');
    const live = fake.requestsFor(Cmd.ASTRO_GO_LIVE);
    assert.equal(live.length, 1);
    assert.ok(live[0].t <= fake.requestsFor(Cmd.CAMERA_TELE_PHOTOGRAPH)[0].t);
    deviceState(0);
    await dwarf.refreshState();
    await dwarf.takePhoto('tele');
    assert.equal(fake.requestsFor(Cmd.ASTRO_GO_LIVE).length, 1, 'a finished session is not finished again');
  });

  test('the idle report the go live itself causes is not another ended session', async () => {
    fake.on(Cmd.ASTRO_GO_LIVE, () => {
      void fake.notify('teleStackingState', { state: 0 });
      return new Promise((r) => setTimeout(() => r({ code: 0 }), 50));
    });
    // a stack seen to stop (stopped), which the go live turns idle
    await fake.notify('teleStackingState', { state: 1 });
    await fake.notify('teleStackingState', { state: 3 });
    await new Promise((r) => setTimeout(r, 50));
    await dwarf.takePhoto('tele');
    assert.equal(dwarf.state.stacking.tele.state, 'idle');
    await dwarf.takePhoto('tele');
    assert.equal(fake.requestsFor(Cmd.ASTRO_GO_LIVE).length, 1);
  });

  test('a stack this connection saw stop is finished before the next photo', async () => {
    await fake.notify('teleStackingState', { state: 1 });
    await fake.notify('teleStackingState', { state: 3 });
    await new Promise((r) => setTimeout(r, 50));
    await dwarf.takePhoto('tele');
    assert.equal(fake.requestsFor(Cmd.ASTRO_GO_LIVE).length, 1);
  });

  test('no go live when nothing ended, nor while a capture runs', async () => {
    deviceState(0);
    await dwarf.refreshState();
    await dwarf.takePhoto('tele');
    deviceState(RUNNING);
    await dwarf.refreshState();
    deviceState(0);
    await dwarf.refreshState();
    await dwarf.takePhoto('tele');
    assert.equal(fake.requestsFor(Cmd.ASTRO_GO_LIVE).length, 0);
  });
});

describe('a photo the camera never finishes', () => {
  let fake: FakeDwarf;
  let api: FakeHttpApi;
  let dwarf: Dwarf;

  beforeEach(async () => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.autoSyncTimeLocation = false;
    invalidateParamSchema();
    api = await new FakeHttpApi().start();
    api.route('POST /shootingMode/getParamAndSetting', () => ({ data: dsoSchema() }));
    api.route('POST /album/list/mediaInfos', () => ({ data: [] }));
    config.dwarf.httpPort = api.port;
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    dwarf.state.shootingMode = { id: 2, name: 'DSO' };
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
    await api.stop();
  });

  test('no reply, no end of capture and no album entry: a stuck camera, said so (not a null photo)', async () => {
    Object.assign(dwarf.photoTiming, { overheadMs: 300, notifySlackMs: 100 });
    fake.silent(Cmd.CAMERA_TELE_PHOTOGRAPH);
    await assert.rejects(dwarf.takePhoto('tele'), /photo service is stuck.*reboot/);
  });
});

describe('a camera stuck in a photo, as the state reads report it', () => {
  let fake: FakeDwarf;
  let api: FakeHttpApi;
  let dwarf: Dwarf;
  const photoRunning = (running: boolean) =>
    fake.reply(Cmd.TASK_GET_DEVICE_STATE_INFO, { shootingMode: 2, teleCameraStateInfo: { exclusiveState: running ? { photoState: { state: 1 } } : {}, hFov: 2.95, vFov: 1.66 } });

  beforeEach(async () => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.autoSyncTimeLocation = false;
    invalidateParamSchema();
    api = await new FakeHttpApi().start();
    api.route('POST /shootingMode/getParamAndSetting', () => ({ data: dsoSchema() }));
    api.route('POST /album/list/mediaInfos', () => ({ data: [] }));
    config.dwarf.httpPort = api.port;
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    dwarf.state.shootingMode = { id: 2, name: 'DSO' };
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
    await api.stop();
  });

  test('a photo that never finished: published, and the next photo is refused at once without a command', async () => {
    Object.assign(dwarf.photoTiming, { overheadMs: 300, notifySlackMs: 100 });
    fake.silent(Cmd.CAMERA_TELE_PHOTOGRAPH);
    await assert.rejects(dwarf.takePhoto('tele'), /photo service is stuck/);
    assert.ok(dwarf.state.photoStuckSince?.tele);
    const t0 = Date.now();
    await assert.rejects(dwarf.takePhoto('tele'), /photo service is stuck.*reboot/);
    assert.ok(Date.now() - t0 < 200);
    assert.equal(fake.requestsFor(Cmd.CAMERA_TELE_PHOTOGRAPH).length, 1);
    // after the reboot the state read shows no photo running: photos are allowed again
    photoRunning(false);
    await dwarf.refreshState();
    assert.equal(dwarf.state.photoStuckSince?.tele, undefined);
  });

  test('a photo running that is not ours, across state reads a minute apart, is a stuck camera; a short one is not', async () => {
    photoRunning(true);
    await dwarf.refreshState();
    assert.equal(dwarf.state.photoStuckSince?.tele, undefined, 'one read is no proof');
    const { notePhotoState } = await import('../dwarf/controller/photo-watch.js');
    const core = (dwarf as unknown as { core: Parameters<typeof notePhotoState>[0] }).core;
    notePhotoState(core, 'tele', true, Date.now() + 61_000);
    assert.ok(dwarf.state.photoStuckSince?.tele);
  });
});
