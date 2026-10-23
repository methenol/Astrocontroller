import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { config } from '../config.js';
import { Dwarf } from '../drivers/dwarf/device.js';
import { Cmd } from '../drivers/dwarf/protocol.js';

describe('object tracking start', () => {
  let fake: FakeDwarf;
  let dwarf: Dwarf;

  before(() => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.autoSyncTimeLocation = false;
  });

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

  const box = { x: 900, y: 480, w: 120, h: 120 };

  test('a lock that the tracker then loses, answered -14901: an error, not "started" (fw 1.5.3.9, 2026-10-12)', async () => {
    fake.on(Cmd.TRACK_START_TRACK, async () => {
      await fake.notify('wideTrackResult', { x: 896, y: 476, w: 126, h: 119 });
      await fake.notify('wideTrackResult', { x: -100, y: -100 });
      return { code: -14901 };
    });
    await assert.rejects(dwarf.trackObject('wide', box), /could not hold the subject \(.*TRACKER_FAILED/i);
  });

  test('a lock kept (the telescope does not answer while it tracks): started', async () => {
    fake.on(Cmd.TRACK_START_TRACK, () => {
      void fake.notify('wideTrackResult', { x: 896, y: 476, w: 126, h: 119 });
      return undefined;
    });
    await dwarf.trackObject('wide', box);
  });

  test('only "lost" results: no lock', async () => {
    fake.on(Cmd.TRACK_START_TRACK, () => {
      void fake.notify('wideTrackResult', { x: -100, y: -100 });
      return undefined;
    });
    await assert.rejects(dwarf.trackObject('wide', box), /did not report a lock/);
  });

  test('a stop is confirmed by the tracker reporting itself stopped (the telescope never answers the stop)', async () => {
    fake.on(Cmd.TRACK_START_TRACK, () => {
      void fake.notify('normalTrackState', { state: 1, cameraType: 1 });
      void fake.notify('wideTrackResult', { x: 896, y: 476, w: 126, h: 119 });
      return undefined;
    });
    await dwarf.trackObject('wide', box);
    assert.deepEqual(dwarf.state.objectTracking, { camera: 'wide', state: 'running' });
    fake.on(Cmd.TRACK_STOP_TRACK, () => {
      void fake.notify('normalTrackState', { state: 3, cameraType: 1 });
      return undefined;
    });
    const t0 = Date.now();
    await dwarf.stopTracking();
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    assert.equal(dwarf.state.objectTracking?.state, 'stopped');
  });
});
