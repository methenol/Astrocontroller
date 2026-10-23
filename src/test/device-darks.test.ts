import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { config } from '../config.js';
import { Dwarf } from '../drivers/dwarf/device.js';
import { Cmd } from '../drivers/dwarf/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DARK = 11021;
const OLD = { name: 'dark_exp_15.000000_gain_60_bin_1_temp_14_stack_20.fits', size: 1000, isDir: false, modifiedAt: 'Oct 03 02:10' };

describe('Dwarf dark masters against the fake telescope', () => {
  let fake: FakeDwarf;
  let dwarf: Dwarf;
  let files: Array<typeof OLD>;
  let listFails: number;

  before(() => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.httpPort = 9;
    config.dwarf.autoSyncTimeLocation = false;
  });

  beforeEach(async () => {
    fake = await new FakeDwarf().start();
    fake.silent(DARK); // fw 1.5.3 never answers it
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 300 } });
    Object.assign(dwarf.darkTiming, { checkEveryMs: 30, listRetryMs: 10, refusalWaitMs: 100 });
    files = [OLD];
    listFails = 0;
    dwarf.listSdDir = async () => {
      if (listFails > 0) {
        listFails--;
        throw new Error('FTP busy');
      }
      return files.map((f) => ({ ...f }));
    };
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
    dwarf.setNdLock(true, 'test');
  });

  afterEach(async () => {
    dwarf.setNdLock(false);
    dwarf.stop();
    await fake.stop();
  });

  // 20 x 15 ms "exposures": the master can exist after 300 ms
  const capture = () => dwarf.captureDarks({ expIndex: 156, gainIndex: 18, binIndex: 0, frames: 20, exposureS: 0.015, gain: 60 });
  const master = { name: 'dark_exp_0.015000_gain_60_bin_1_temp_13_stack_20.fits', size: 2000, isDir: false, modifiedAt: 'Oct 12 05:40' };

  test('refused without the ND lock; nothing is sent', async () => {
    dwarf.setNdLock(false);
    await assert.rejects(capture(), /refused: darks need the ND filter/);
    assert.equal(fake.requestsFor(DARK).length, 0);
  });

  test('the new master appearing ends the capture as done; an older master is not taken for it', async () => {
    files = [OLD, { ...master, modifiedAt: 'Oct 11 01:00' }];
    await capture();
    await sleep(400);
    assert.equal(dwarf.state.darkCapture?.state, 'running', 'the old same-named master is not the new one');
    files = [OLD, master];
    await sleep(200);
    assert.equal(dwarf.state.darkCapture?.state, 'done');
    assert.equal(dwarf.state.darkCapture?.master, master.name);
  });

  test('a folder that cannot be listed: nothing is started (completion could not be recognised)', async () => {
    listFails = 3;
    await assert.rejects(capture(), /could not list .* nothing was started/);
    assert.equal(fake.requestsFor(DARK).length, 0);
    assert.notEqual(dwarf.state.darkCapture?.state, 'running');
  });

  test('a second start while the first is still listing the SD card is refused; one capture is sent', async () => {
    listFails = 1; // the first start waits out a retry
    const first = capture();
    await assert.rejects(capture(), /a dark capture is already running/);
    await first;
    assert.equal(dwarf.state.darkCapture?.state, 'running');
    await sleep(150);
    assert.equal(fake.requestsFor(DARK).length, 1);
  });

  test('the ND lock released while the capture lists the SD card: nothing is started', async () => {
    listFails = 1;
    const started = capture();
    dwarf.setNdLock(false);
    await assert.rejects(started, /ND lock was released while the capture was being prepared/);
    await sleep(150);
    assert.equal(fake.requestsFor(DARK).length, 0);
    assert.notEqual(dwarf.state.darkCapture?.state, 'running');
  });

  test('one failed listing is retried', async () => {
    listFails = 1;
    await capture();
    assert.equal(dwarf.state.darkCapture?.state, 'running');
    await dwarf.stopDarks();
  });

  test('stop ends the capture and its checks', async () => {
    await capture();
    await dwarf.stopDarks();
    assert.equal(dwarf.state.darkCapture?.state, 'stopped');
    files = [OLD, master];
    await sleep(400);
    assert.equal(dwarf.state.darkCapture?.state, 'stopped');
  });

  test('a capture state replaced from elsewhere ends its watchers', async () => {
    const listeners = dwarf.link.listenerCount('notification');
    await capture();
    assert.equal(dwarf.link.listenerCount('notification'), listeners + 1);
    dwarf.state.darkCapture = { state: 'idle' };
    await sleep(500);
    assert.equal(dwarf.link.listenerCount('notification'), listeners, 'the power-off watcher and the poll are gone');
  });

  test('a power-off fails the capture', async () => {
    await capture();
    await fake.notify('powerOff', {});
    await sleep(50);
    assert.equal(dwarf.state.darkCapture?.state, 'failed');
    assert.match(dwarf.state.darkCapture?.error ?? '', /powered off/);
  });

  test('an immediate refusal fails the capture with its code', async () => {
    fake.reply(DARK, { code: -1 });
    await assert.rejects(capture(), /refused the dark capture/);
    assert.equal(dwarf.state.darkCapture?.state, 'failed');
  });

  test('refused while the tele camera is live stacking', async () => {
    dwarf.stacks.startSent('tele');
    await assert.rejects(capture(), /refused: the tele camera is live stacking/);
  });

  test('a running capture owns the tele camera: nothing changes what it shoots, the live view leaves it alone', async () => {
    await capture();
    assert.equal(dwarf.state.darkCapture?.state, 'running');
    assert.equal(dwarf.isBusy(), 'a dark capture');
    await assert.rejects(dwarf.setSetting('tele', 'exposure', 'auto'), /refused: a dark capture is running on the tele camera; changing its exposure/);
    await assert.rejects(dwarf.setShootingMode('Normal'), /refused: a dark capture is running.*changing the shooting mode/);
    await assert.rejects(dwarf.takePhoto('wide'), /refused: taking a photo while the ND filter is fitted/);
    await assert.rejects(dwarf.burst('wide', 5), /refused: a burst while the ND filter is fitted/);
    assert.equal(await dwarf.autoExposureForLiveView('tele'), null);
    await assert.rejects(dwarf.recoverAstroService(), /refused: a dark capture is running; the recovery/);
    await assert.rejects(dwarf.autofocus('astro'), /refused: a dark capture is running on the tele camera; an autofocus/);
    for (const cmd of [Cmd.PARAM_SET_EXPOSURE, Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE, Cmd.TASK_MANAGER_SWITCH_SHOOTING_TECH]) assert.equal(fake.requestsFor(cmd).length, 0);
    await dwarf.stopDarks();
  });
});
