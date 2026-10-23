import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { FakeHttpApi, dsoSchema } from './fake-http.js';
import { config } from '../config.js';
import { Dwarf } from '../drivers/dwarf/device.js';
import { Cmd } from '../drivers/dwarf/protocol.js';
import { invalidateParamSchema } from '../drivers/dwarf/http.js';

/** tele exposure and gain ids in the fake schema */
const EXP = 101;
const GAIN = 102;

describe('camera settings as the telescope applies them', () => {
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
    api.route('POST /shootingMode/getParamAndSetting', () => {
      const s = dsoSchema();
      // as fw 1.5.3.9 lists it in astro mode: the full gain list, but 40-240 accepted on the tele
      Object.assign(s.cameraParams[0].generalParams[1], { values: [0, 20, 40, 60, 80, 100], range: [{ minValue: 40, maxValue: 240, techId: 0 }] });
      return { data: s };
    });
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

  test('a gain below the range the mode accepts goes to the nearest accepted value, not to a listed one outside it', async () => {
    fake.reply(Cmd.PARAM_SET_GAIN, {});
    const r = await dwarf.setSetting('tele', 'gain', 20);
    assert.equal(fake.requestsFor(Cmd.PARAM_SET_GAIN)[0].data.value, 40);
    assert.match(r, /tele gain → 40 \(nearest allowed to 20\)/);
  });

  test('a manual gain that the telescope answers by putting an auto exposure back to manual: said so', async () => {
    await fake.notify('intParam', { paramId: EXP, value: 75 }); // auto
    await new Promise((r) => setTimeout(r, 30));
    fake.on(Cmd.PARAM_SET_GAIN, () => {
      // fw 1.5.3.9: the exposure echo (now manual) and the gain echo come before the reply
      void fake.notify('intParam', { paramId: EXP, mode: 1, value: 75 });
      void fake.notify('intParam', { paramId: GAIN, mode: 1, value: 80 });
      return new Promise((r) => setTimeout(() => r({}), 50));
    });
    const r = await dwarf.setSetting('tele', 'gain', 80);
    assert.match(r, /gain → 80/);
    assert.match(r, /put back to auto/, "the caller is told a second command went out on their behalf");
    const exposure = fake.requestsFor(Cmd.PARAM_SET_EXPOSURE);
    assert.deepEqual(exposure.map((e) => e.data.mode), [0], 'the auto exposure the gain clobbered is put back, not left at the short value auto had picked');
  });

  test('no note when the exposure was manual already', async () => {
    await fake.notify('intParam', { paramId: EXP, mode: 1, value: 156 });
    await new Promise((r) => setTimeout(r, 30));
    fake.reply(Cmd.PARAM_SET_GAIN, {});
    const r = await dwarf.setSetting('tele', 'gain', 60);
    assert.doesNotMatch(r, /put back to auto/);
    assert.deepEqual(fake.requestsFor(Cmd.PARAM_SET_EXPOSURE), [], 'a manual exposure that the gain left alone needs no restore');
  });
});
