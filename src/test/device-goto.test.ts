import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { FakeHttpApi } from './fake-http.js';
import { config } from '../config.js';
import { Dwarf, AstroServiceHungError } from '../dwarf/device.js';
import { daylightRefusal } from '../dwarf/controller/astro.js';
import { DwarfCommandError } from '../dwarf/link.js';
import { Cmd } from '../dwarf/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 2026-10-13 00:00 and 2026-10-12 13:00 in Portland (45.5 N, 122.6 W, PDT) */
const NIGHT = new Date('2026-10-13T07:00:00Z');
const NOON = new Date('2026-10-12T20:00:00Z');
const MOTOR_CMDS = [Cmd.STEP_MOTOR_RUN_TO, Cmd.STEP_MOTOR_RESET, Cmd.STEP_MOTOR_SERVICE_JOYSTICK];

describe('Dwarf GoTo and calibration against the fake telescope', () => {
  let fake: FakeDwarf;
  let api: FakeHttpApi;
  let dwarf: Dwarf;

  before(() => {
    config.dwarf.host = '127.0.0.1';
    config.dwarf.autoSyncTimeLocation = false;
  });

  beforeEach(async () => {
    api = await new FakeHttpApi().start();
    config.dwarf.httpPort = api.port;
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    Object.assign(dwarf.astroTiming, { calibrationMs: 3000, gotoMs: 3000, silentMs: 400, gotoEndGraceMs: 200, calibrationEndGraceMs: 100, now: () => NIGHT });
    dwarf.locationOverride = { lat: 45.5, lon: -122.6, elev: 50 };
    // already in DSO mode: no mode switch in these tests
    dwarf.state.shootingMode = { id: 2, name: 'DSO' };
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    dwarf.stop();
    await fake.stop();
    await api.stop();
  });

  /** fw 1.5.3, 2026-10-04 M 31: stages as oneClickGotoState notifications, tracking, and never an allEnd reply. */
  function oneClickLikeM31() {
    fake.on(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, (_req, f) => {
      setTimeout(async () => {
        await f.notify('oneClickGotoState', { astroCalibrationState: { state: 1 } });
        await sleep(20);
        await f.notify('oneClickGotoState', { astroCalibrationState: { state: 4 } });
        await sleep(20);
        await f.notify('oneClickGotoState', { astroGotoState: { state: 1 } });
        await sleep(20);
        await f.notify('oneClickGotoState', { astroTrackingState: { state: 1, targetName: 'M 31' } });
      }, 30);
      return undefined;
    });
  }

  test('one-click GoTo completes on tracking without the allEnd reply, and lists its stages', async () => {
    oneClickLikeM31();
    const r = await dwarf.gotoRaDec(0.712, 41.27, 'M 31', true);
    assert.match(r, /one-click GoTo M 31 complete/);
    assert.match(r, /Calibration running → Calibration plate_solving → Goto running → Tracking running/);
    const req = fake.requestsFor(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO)[0];
    assert.equal(req.data.targetName, 'M 31');
    assert.equal(req.data.shootingMode, 2);
  });

  test('a hung astro service (nothing at all) fails after the silence limit, sends the stop and names the fix', async () => {
    fake.silent(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO);
    const t0 = Date.now();
    await assert.rejects(dwarf.gotoRaDec(5.58, -5.39, 'M 42', true), (e: unknown) => e instanceof AstroServiceHungError && /power-cycle/.test((e as Error).message));
    const took = Date.now() - t0;
    assert.ok(took < 1500, `took ${took} ms: must end at the silence limit, not the overall timeout`);
    await fake.nextRequest(Cmd.ASTRO_STOP_ONE_CLICK_GOTO, 1000);
  });

  test('a routine that is reporting is not cut off by the silence limit', async () => {
    fake.on(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, (_req, f) => {
      setTimeout(() => void f.notify('oneClickGotoState', { astroCalibrationState: { state: 1 } }), 50);
      setTimeout(() => void f.notify('oneClickGotoState', { astroTrackingState: { state: 1 } }), 900);
      return undefined;
    });
    const r = await dwarf.gotoRaDec(5.58, -5.39, 'M 42', true);
    assert.match(r, /complete/);
  });

  test('an error reply fails at once with its code', async () => {
    fake.reply(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, { step: 1, code: -11501 });
    await assert.rejects(dwarf.gotoRaDec(5.58, -5.39, 'M 42', true), (e: unknown) => e instanceof DwarfCommandError && e.code === -11501);
  });

  test('tracking left over from the previous target is not taken as this GoTo reaching its target', async () => {
    // tracking the previous target (reported before this GoTo started)
    await fake.notify('trackingState', { state: 1, targetName: 'M 31' });
    await sleep(50);
    assert.equal(dwarf.isTracking(), true);
    // the new GoTo is acknowledged but never gets anywhere
    fake.reply(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, { step: 1, code: 0 });
    dwarf.astroTiming.gotoMs = 800;
    await assert.rejects(dwarf.gotoRaDec(5.58, -5.39, 'M 42', true), /timed out .* without reaching tracking/);
  });

  test('GoTo on a calibration: hung service fails at the silence limit and sends the GoTo stop', async () => {
    fake.silent(Cmd.ASTRO_START_GOTO_DSO);
    await assert.rejects(dwarf.gotoRaDec(5.58, -5.39, 'M 42', false), AstroServiceHungError);
    await fake.nextRequest(Cmd.ASTRO_STOP_GOTO, 1000);
  });

  test('GoTo on a calibration: the GoTo state ending without tracking is a failure', async () => {
    fake.on(Cmd.ASTRO_START_GOTO_DSO, (_req, f) => {
      setTimeout(async () => {
        await f.notify('gotoState', { state: 1, targetName: 'M 42' });
        await sleep(30);
        await f.notify('gotoState', { state: 3, targetName: 'M 42' });
      }, 30);
      return undefined;
    });
    await assert.rejects(dwarf.gotoRaDec(5.58, -5.39, 'M 42', false), /ended without tracking/);
  });

  test('GoTo on a calibration: RA is sent in degrees, complete on tracking', async () => {
    fake.on(Cmd.ASTRO_START_GOTO_DSO, (_req, f) => {
      setTimeout(async () => {
        await f.notify('gotoState', { state: 1 });
        await f.notify('trackingState', { state: 1, targetName: 'M 42' });
      }, 30);
      return undefined;
    });
    assert.match(await dwarf.gotoRaDec(5.5, -5.39, 'M 42', false), /now tracking M 42/);
    assert.equal(fake.requestsFor(Cmd.ASTRO_START_GOTO_DSO)[0].data.ra, 82.5);
  });

  test('stop_goto ends a running GoTo at once', async () => {
    fake.on(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, (_req, f) => {
      setTimeout(() => void f.notify('oneClickGotoState', { astroCalibrationState: { state: 1 } }), 20);
      return undefined;
    });
    dwarf.astroTiming.silentMs = 5000;
    const p = dwarf.gotoRaDec(5.58, -5.39, 'M 42', true);
    await sleep(150);
    await dwarf.stopGoto();
    await assert.rejects(p, /stopped by request/);
  });

  test('a dropped link ends the GoTo with an explanation (no 10-minute "busy GoTo")', async () => {
    fake.on(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, (_req, f) => {
      setTimeout(() => void f.notify('oneClickGotoState', { astroCalibrationState: { state: 1 } }), 20);
      return undefined;
    });
    dwarf.astroTiming.silentMs = 5000;
    const p = dwarf.withPointingRecovery('GoTo', () => dwarf.gotoRaDec(5.58, -5.39, 'M 42', true));
    await sleep(150);
    fake.dropClient();
    await assert.rejects(p, /connection closed during the operation|No pointing recovery/);
    assert.equal(dwarf.operation, null);
  });

  test('a hung astro service gets no recovery moves (pointing recovery stands down)', async () => {
    fake.reply(Cmd.STEP_MOTOR_GET_POSITION, { id: 1, position: 120, code: 0 });
    fake.silent(Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO);
    await assert.rejects(dwarf.withPointingRecovery('GoTo', () => dwarf.gotoRaDec(5.58, -5.39, 'M 42', true)), AstroServiceHungError);
    await sleep(100);
    for (const cmd of MOTOR_CMDS) assert.equal(fake.requestsFor(cmd).length, 0, `motor command ${cmd} sent`);
    assert.equal(fake.requestsFor(Cmd.ASTRO_STOP_CALIBRATION).length, 0);
    assert.equal(dwarf.operation, null);
  });

  test('GoTo, calibration and Sun/Moon tracking are refused under a running stack; nothing is sent', async () => {
    dwarf.stacks.startSent('tele');
    const slews = [Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, Cmd.ASTRO_START_GOTO_DSO, Cmd.ASTRO_START_CALIBRATION, Cmd.ASTRO_START_TRACK_SPECIAL_TARGET];
    await assert.rejects(dwarf.gotoRaDec(0.712, 41.27, 'M 31', true), /refused: the tele camera is live stacking/);
    await assert.rejects(dwarf.gotoRaDec(0.712, 41.27, 'M 31', false), /refused: the tele camera is live stacking/);
    await assert.rejects(dwarf.calibrate(), /refused: the tele camera is live stacking/);
    await assert.rejects(dwarf.trackSunMoon('moon', 'start'), /refused: the tele camera is live stacking/);
    assert.equal(fake.requests.filter((r) => slews.includes(r.cmd)).length, 0);
  });

  test('with the Sun up, calibration, one-click GoTos and polar alignment refuse before anything is sent', async () => {
    dwarf.astroTiming.now = () => NOON;
    const sent = () => fake.requests.length;
    const before = sent();
    await assert.rejects(dwarf.calibrate(), /calibration plate-solves the stars, and the Sun is up \(altitude \d+\.\d°\): it cannot succeed until after sunset \(civil dusk [^)]*\d\d:\d\d\)\. Nothing was moved\./);
    await assert.rejects(dwarf.gotoRaDec(0.7123, 41.27, 'M 31', true), /one-click GoTo to M 31 plate-solves the stars, and the Sun is up/);
    await assert.rejects(dwarf.gotoSolarSystem('moon', true), /Sun is up .* use track_sun_moon/);
    await assert.rejects(dwarf.measurePolarAlignment(), /polar alignment plate-solves the stars/);
    assert.equal(sent(), before, 'nothing sent to the telescope');
    // through the pointing recovery (as the MCP tools and the UI call it): the refusal as is, no moves
    await assert.rejects(dwarf.withPointingRecovery('calibration', () => dwarf.calibrate()), (e: Error) => /Nothing was moved\.$/.test(e.message));
    for (const cmd of MOTOR_CMDS) assert.equal(fake.requestsFor(cmd).length, 0, `motor command ${cmd} sent`);
  });

  test('the daylight refusal is null after sunset and names civil dusk by day', () => {
    const site = { lat: 45.5, lon: -122.6, elev: 50 };
    assert.equal(daylightRefusal('calibration', site, NIGHT, 'America/Los_Angeles'), null);
    assert.match(daylightRefusal('calibration', site, NOON, 'America/Los_Angeles') ?? '', /\(civil dusk Oct 12, 18:59\)/);
  });

  test('calibration completes on its result', async () => {
    fake.on(Cmd.ASTRO_START_CALIBRATION, (_req, f) => {
      setTimeout(async () => {
        await f.notify('calibrationState', { state: 1, plateSolvingTimes: 0 });
        await f.notify('calibrationState', { state: 4, plateSolvingTimes: 1 });
        await f.notify('calibrationResult', { azi: 181.25, alt: 44.5 });
      }, 30);
      return undefined;
    });
    const r = await dwarf.calibrate();
    assert.match(r, /calibration complete .*azimuth 181\.25°, altitude 44\.50°/);
  });

  test('calibration whose state ends without a result fails with the plate-solve count', async () => {
    fake.on(Cmd.ASTRO_START_CALIBRATION, (_req, f) => {
      setTimeout(async () => {
        await f.notify('calibrationState', { state: 1, plateSolvingTimes: 0 });
        await f.notify('calibrationState', { state: 4, plateSolvingTimes: 3 });
        await f.notify('calibrationState', { state: 3, plateSolvingTimes: 3 });
      }, 30);
      return undefined;
    });
    await assert.rejects(dwarf.calibrate(), /ended without a result after 3 plate solve/);
  });
  test('polar alignment: the result arrives in the reply', async () => {
    fake.on(Cmd.ASTRO_START_EQ_SOLVING, async (_req, f) => {
      await f.notify('eqSolvingState', { state: 1 });
      await sleep(50);
      return { code: 0, aziErr: 1.25, altErr: -0.5 };
    });
    assert.deepEqual(await dwarf.measurePolarAlignment(), { azimuthErrorDeg: 1.25, altitudeErrorDeg: -0.5 });
    assert.equal(dwarf.state.eqSolving.result?.azimuthErrorDeg, 1.25);
  });

  test('polar alignment: a bare acknowledgement of the start is not a perfect result', async () => {
    fake.on(Cmd.ASTRO_START_EQ_SOLVING, (_req, f) => {
      setTimeout(async () => {
        await f.notify('eqSolvingState', { state: 1 });
        await f.notify('eqSolvingState', { state: 3 });
      }, 20);
      return { code: 0 };
    });
    await assert.rejects(dwarf.measurePolarAlignment(), /ended \(state stopped\) without a result/);
  });

  test('polar alignment that the telescope ignores fails at the silence limit and is stopped', async () => {
    fake.silent(Cmd.ASTRO_START_EQ_SOLVING);
    await assert.rejects(dwarf.measurePolarAlignment(), AstroServiceHungError);
    await fake.nextRequest(Cmd.ASTRO_STOP_EQ_SOLVING, 1000);
  });

  test('polar alignment whose solve ends without a result fails with the reason', async () => {
    fake.on(Cmd.ASTRO_START_EQ_SOLVING, (_req, f) => {
      setTimeout(async () => {
        await f.notify('eqSolvingState', { state: 1 });
        await f.notify('eqSolvingState', { state: 3 });
      }, 20);
      return undefined;
    });
    await assert.rejects(dwarf.measurePolarAlignment(), /ended \(state stopped\) without a result/);
  });

  test('astro recovery is refused at once when the telescope is not executing commands', async () => {
    const offline = new Dwarf({ host: '127.0.0.1', port: 9, linkTiming: { requestTimeoutMs: 1000 } });
    const t0 = Date.now();
    await assert.rejects(offline.recoverAstroService(), /refused: the telescope is not executing commands/);
    assert.ok(Date.now() - t0 < 500);
    offline.stop();
  });
});
