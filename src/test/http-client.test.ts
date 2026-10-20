import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHttpApi, dsoSchema } from './fake-http.js';
import { config } from '../config.js';
import { parseBigSafe, getParamSchema, getShootingModes, resolveShootingMode, apiHealth, fileUrl, forgetDevice, getDeviceInfo, buildParamSchema, redactDeviceInfo } from '../dwarf/http.js';
import { call } from '../dwarf/http/client.js';

describe('parseBigSafe', () => {
  test('integers beyond 2^53 become strings; safe numbers, floats and strings are untouched', () => {
    const text = '{"id":12345678901234567890,"neg":-9007199254740993,"ok":9007199254740991,"f":1.5e3,"x":-0.25,"s":"n: 12345678901234567890, \\"q\\" 99999999999999999","a":[1,22222222222222222222]}';
    assert.deepEqual(parseBigSafe(text), {
      id: '12345678901234567890',
      neg: '-9007199254740993',
      ok: 9007199254740991,
      f: 1500,
      x: -0.25,
      s: 'n: 12345678901234567890, "q" 99999999999999999',
      a: [1, '22222222222222222222'],
    });
  });

  test('plain JSON parses as JSON.parse would; bad JSON throws', () => {
    assert.deepEqual(parseBigSafe('[true,null,{"k":"v"}]'), [true, null, { k: 'v' }]);
    assert.throws(() => parseBigSafe('{"a":'));
  });
});

describe('HTTP client against the fake API', () => {
  let api: FakeHttpApi;
  before(() => {
    config.dwarf.host = '127.0.0.1';
  });
  beforeEach(async () => {
    api = await new FakeHttpApi().start();
    config.dwarf.httpPort = api.port;
    forgetDevice();
  });
  afterEach(async () => {
    await api.stop();
  });

  test('a nonzero code, an HTTP error and a non-JSON body are errors', async () => {
    api.route('POST /deviceInfo', () => ({ code: -3 }));
    await assert.rejects(getDeviceInfo(), /returned code -3/);
    api.route('POST /deviceInfo', () => ({ status: 500 }));
    await assert.rejects(getDeviceInfo(), /HTTP 500/);
    api.route('POST /deviceInfo', () => ({ raw: '<html>busy</html>' }));
    await assert.rejects(getDeviceInfo(), /not JSON: <html>/);
  });

  test('timeouts are counted until the API answers again', async () => {
    api.route('GET /slow', () => new Promise((r) => setTimeout(() => r({ data: 1 }), 300)));
    api.route('GET /fast', () => ({ data: 1 }));
    await assert.rejects(call('GET', '/slow', undefined, 50));
    assert.equal(apiHealth().cameraService, 'one recent timeout');
    await assert.rejects(call('GET', '/slow', undefined, 50));
    assert.equal(apiHealth().cameraService, 'NOT RESPONDING');
    assert.equal(apiHealth().lastTimedOut, '/slow');
    assert.equal(await call('GET', '/fast'), 1);
    assert.equal(apiHealth().cameraService, 'ok');
  });

  test('the parameter schema is fetched once for concurrent callers and a failure is not cached', async () => {
    let n = 0;
    api.route('POST /shootingMode/getParamAndSetting', () => (++n === 1 ? { code: -1 } : { data: dsoSchema() }));
    await assert.rejects(getParamSchema(2));
    const [a, b] = await Promise.all([getParamSchema(2), getParamSchema(2)]);
    assert.equal(a, b);
    assert.equal(n, 2);
    assert.equal(a.cameras[0].exp.paramId, '101');
    assert.equal(a.cameras[0].filterType.paramId, '103');
    assert.equal(a.techSettings.stackCount.paramId, '301');
    assert.equal(a.techSettings.stackCount_wide.paramId, '302');
  });

  test('buildParamSchema skips malformed entries', () => {
    const s = buildParamSchema(2, { cameraParams: [null as never, { cameraId: 0, generalParams: [{ nope: 1 } as never, { name: 'gain', paramId: '1', valueType: 1 }] }] });
    assert.deepEqual(Object.keys(s.cameras[0]), ['gain']);
    assert.deepEqual(buildParamSchema(2, null).cameras, {});
  });

  test('shooting modes: aliases resolve; the list is cached per device', async () => {
    assert.equal((await resolveShootingMode('astro')).name, 'DSO');
    assert.equal((await resolveShootingMode(' Deep-Sky ')).name, 'DSO');
    assert.equal((await resolveShootingMode(4)).name, 'Moon');
    await assert.rejects(resolveShootingMode('nope'), /Available: Normal, DSO/);
    await getShootingModes();
    assert.equal(api.requestsFor('/shootingMode/getSupportedShootingModes').length, 1);
    forgetDevice();
    await getShootingModes();
    assert.equal(api.requestsFor('/shootingMode/getSupportedShootingModes').length, 2);
  });

  test('fileUrl encodes each segment and refuses paths that leave the card', () => {
    assert.equal(fileUrl('DWARF3/a b/c#.jpg'), 'http://127.0.0.1/DWARF3/a%20b/c%23.jpg');
    assert.throws(() => fileUrl('/DWARF3/../etc/passwd'), /not a card path/);
    assert.throws(() => fileUrl('/a\nb'), /not a card path/);
  });
});

describe('redactDeviceInfo', () => {
  test('hides the Wi-Fi and device passwords and keeps everything else', () => {
    const info = { deviceName: 'DWARF3', deviceId: 3, sn: 'X1', macAddress: 'aa', staWifiName: 'home', staWifiPwd: 'hunter2', devicePwd: '1234', staIpAddress: '10.0.0.5' };
    const out = redactDeviceInfo(info);
    assert.equal(out.staWifiPwd, '(hidden)');
    assert.equal(out.devicePwd, '(hidden)');
    assert.equal(out.staWifiName, 'home');
    assert.equal(out.staIpAddress, '10.0.0.5');
    assert.ok(!JSON.stringify(out).includes('hunter2'));
  });

  test('an empty password stays empty (nothing to hide)', () => {
    assert.equal(redactDeviceInfo({ deviceName: 'd', deviceId: 1, sn: '', macAddress: '', devicePwd: '' }).devicePwd, '');
  });
});
