import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { FakeHttpApi, dsoSchema } from './fake-http.js';
import { config } from '../config.js';
import { Dwarf } from '../dwarf/device.js';
import { Cmd } from '../dwarf/protocol.js';
import { invalidateParamSchema } from '../dwarf/http.js';

/** the Normal-mode burst count as fw 1.5.3.9 lists it */
const BURST_COUNT = '401';

describe('burst, video and timelapse, which only Normal mode offers', () => {
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
    // DSO mode (2) has no burst count; Normal mode (1) does, 3..1000
    api.route('POST /shootingMode/getParamAndSetting', (req) => {
      const s = dsoSchema();
      if ((req.body as { modeId?: number })?.modeId === 1)
        s.shootingTechSettings[0].generalParams.push(
          { name: 'burstCount', paramId: BURST_COUNT, valueType: 0, minValue: 3, maxValue: 1000 },
          { name: 'timelapseIntervalTime', paramId: '402', valueType: 0, minValue: 0, maxValue: 60 },
        );
      return { data: s };
    });
    config.dwarf.httpPort = api.port;
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    dwarf.state.shootingMode = { id: 2, name: 'DSO' };
    let mode = 2;
    fake.on(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE, (req) => {
      mode = (req.data as { mode: number }).mode;
      return {};
    });
    fake.on(Cmd.TASK_GET_DEVICE_STATE_INFO, () => ({ shootingMode: mode }));
    fake.reply(Cmd.TASK_MANAGER_ENTER_CAMERA, {});
    fake.reply(Cmd.TASK_MANAGER_SWITCH_SHOOTING_TECH, {});
    fake.reply(Cmd.PARAM_SET_GENERAL_INT_PARAM, {});
    fake.on(Cmd.CAMERA_TELE_BURST, (req) => {
      const n = (req.data as { count: number }).count;
      void fake.notify('burstProgress', { completedCount: n, totalCount: n }).then(() => fake.notify('burstState', { state: 0 }));
      return {};
    });
    fake.reply(Cmd.CAMERA_TELE_START_RECORD, {});
    fake.reply(Cmd.CAMERA_TELE_START_TIMELAPSE_PHOTO, {});
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
    await api.stop();
  });

  test('from DSO mode, which has no burst count, the telescope goes to Normal mode first and the count is set there', async () => {
    const r = await dwarf.burst('tele', 4);
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE)[0].data.mode, 1);
    const set = fake.requestsFor(Cmd.PARAM_SET_GENERAL_INT_PARAM)[0].data;
    assert.equal(String(set.paramId), BURST_COUNT);
    assert.equal(set.value, 4);
    assert.match(r, /burst of 4 on tele finished \(4\/4\)/);
    assert.match(r, /switched from DSO mode to Normal mode/);
  });

  test('already in Normal mode: no switch; a count below the telescope minimum is raised to it and said so', async () => {
    await dwarf.setShootingMode('Normal');
    const switches = fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE).length;
    const r = await dwarf.burst('tele', 2);
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE).length, switches);
    assert.doesNotMatch(r, /switched/);
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_GENERAL_INT_PARAM)[0].data.value, 3);
    assert.equal(fake.requestsFor(Cmd.CAMERA_TELE_BURST)[0].data.count, 3);
    assert.match(r, /burst of 3 on tele finished/);
    assert.match(r, /the telescope's burst is 3\.\.1000/);
  });

  test('recording from DSO mode, which offers only stacking, goes to Normal mode first', async () => {
    const r = await dwarf.record('tele', 'start');
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE)[0].data.mode, 1);
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_TECH)[0].data.tech, 4);
    assert.equal(fake.requestsFor(Cmd.CAMERA_TELE_START_RECORD).length, 1);
    assert.match(r, /tele recording started — switched from DSO mode to Normal mode for recording video/);
    assert.equal(dwarf.state.shootingTech.tele, 'video');
    await dwarf.setShootingMode('DSO');
    assert.equal(dwarf.state.shootingTech.tele, 'stacking', 'DSO offers only stacking, so that is the technique after the switch');
    await dwarf.setShootingMode('Normal');
    assert.equal(dwarf.state.shootingTech.tele, undefined, 'Normal offers several; the telescope does not say which');
  });

  test('a timelapse from DSO mode goes to Normal mode first; in Normal mode it does not switch', async () => {
    const r = await dwarf.timelapse('tele', 'start');
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE).length, 1);
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_TECH)[0].data.tech, 5);
    assert.match(r, /tele timelapse started — switched from DSO mode to Normal mode/);
    const again = await dwarf.timelapse('tele', 'start');
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE).length, 1);
    assert.equal(again, 'tele timelapse started');
  });

  test("another mode's setting is set in that mode (the telescope applies every set to the current mode), then the mode is put back", async () => {
    fake.reply(Cmd.PARAM_SET_GAIN, {});
    const r = await dwarf.setSetting('wide', 'gain', 80, 1);
    const seen = fake.requests.filter((q) => q.cmd === Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE || q.cmd === Cmd.PARAM_SET_GAIN).map((q) => (q.cmd === Cmd.PARAM_SET_GAIN ? 'gain' : `mode ${q.data.mode}`));
    assert.deepEqual(seen, ['mode 1', 'gain', 'mode 2']);
    assert.equal(dwarf.state.shootingMode?.id, 2);
    assert.match(r, /wide gain → 80 \(in Normal mode; back in DSO mode\)/);
    await dwarf.setSetting('wide', 'gain', 60, 2);
    assert.equal(fake.requestsFor(Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE).length, 2, 'the current mode named: no switch');
  });
});
