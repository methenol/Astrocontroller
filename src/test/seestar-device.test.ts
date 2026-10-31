import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { Seestar, SeestarOperationError } from '../drivers/seestar/device.js';
import { encodeHeader, IMG_TYPE } from '../drivers/seestar/frames.js';
import { loadDriver, MCP_SERVER_NAMES } from '../drivers/index.js';
import { FakeSeestar, S50_PRO } from './fake-seestar.js';

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const previewFrame = (imageId = 65535) => {
  const px = Buffer.alloc(2 * 2 * 2, 0x40);
  return Buffer.concat([encodeHeader({ imgType: IMG_TYPE.preview, length: px.length, width: 2, height: 2, imageId }), px]);
};

describe('Seestar device', () => {
  let fake: FakeSeestar;
  let scope: Seestar;
  let dir: string;

  beforeEach(async () => {
    fake = new FakeSeestar();
    fake.noHandshakeMethod = true;
    await fake.listen();
    fake.on('get_device_state', () => ({
      result: { device: { name: 'S30', product_model: 'Seestar S30', focal_len: 150, fnumber: 5 }, camera: { chip_size: [1080, 1920], pixel_size_um: 2.9 }, mount: { equ_mode: false, close: true }, focuser: { step: 1500, max_step: 2600 }, ap: { passwd: 'secret' } },
    }));
    fake.on('iscope_get_app_state', () => ({ result: { View: { state: 'idle' } } }));
    fake.on('scope_get_equ_coord', () => ({ result: { ra: 1.5, dec: 30 } }));
    fake.on('scope_get_horiz_coord', () => ({ result: [45, 120] }));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seestar-'));
    scope = new Seestar({ host: '127.0.0.1', connection: 'local', ports: fake.ports, tunnel: null, dataDir: dir, link: { backoffMinMs: 50 } });
  });

  afterEach(async () => {
    await scope.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const connected = async () => {
    scope.start();
    await until(() => scope.state.connected && scope.state.device.model !== undefined);
  };

  test('reads the device on connect (full state, unredacted), with pointing and FOV; both picture sockets open', async () => {
    await connected();
    await until(() => scope.state.mount.altDeg !== undefined);
    assert.equal(scope.state.device.model, 'Seestar S30');
    assert.equal(scope.state.mount.parked, true);
    assert.deepEqual([scope.state.mount.raHours, scope.state.mount.decDeg, scope.state.mount.altDeg, scope.state.mount.azDeg], [1.5, 30, 45, 120]);
    // portrait, as the frames are read: chip_size [1080, 1920] is width × height
    assert.ok(scope.state.fov && Math.abs(scope.state.fov.h - 1.196) < 0.01 && Math.abs(scope.state.fov.v - 2.127) < 0.01);
    assert.deepEqual((scope.state.deviceState as { ap: unknown }).ap, { passwd: 'secret' });
    assert.equal(scope.driver, 'seestar');
    await until(() => scope.images.tele.connected && scope.images.wide.connected);
    // live frames come as JPEG on both cameras (the preview bin is set once a view runs)
    await until(() => fake.calls.filter((c) => c.method === 'set_setting').length >= 2);
    const prepared = fake.calls.filter((c) => c.method === 'set_setting').map((c) => c.params as Record<string, unknown>);
    assert.ok(prepared.some((p) => p.wide_cam === false && (p.preview as { image_transfer_mode?: string })?.image_transfer_mode === 'Jpg'), JSON.stringify(prepared));
    assert.ok(prepared.some((p) => p.wide_cam === true && (p.preview as { image_transfer_mode?: string })?.image_transfer_mode === 'Jpg'), JSON.stringify(prepared));
  });

  test('pushes the time (and location when known) after connecting', async () => {
    await connected();
    await until(() => fake.methods().includes('pi_set_time'));
    const t = fake.calls.find((c) => c.method === 'pi_set_time')!.params as Array<Record<string, unknown>>;
    assert.equal(typeof t[0]!.year, 'number');
    assert.equal(t[0]!.time_zone, config.observer.timezone);
  });

  test('GoTo follows the AutoGoto operation to its own end; a step failing on the way is not the end', async () => {
    await connected();
    fake.on('iscope_start_view', (_p, f) => {
      setTimeout(() => {
        f.event({ Event: 'AutoGoto', state: 'start', route: [] });
        f.event({ Event: 'AutoGoto', state: 'fail', page: 'preview', error: 'solve failed' });
        f.event({ Event: 'AutoGoto', state: 'complete', lapse_ms: 1200, route: [] });
      }, 20);
      return { result: 0 };
    });
    const r = await scope.gotoTarget({ raHours: 5.58, decDeg: -5.39, name: 'M 42' });
    assert.equal(r.goto.state, 'complete');
    assert.equal(r.stacking, 'not requested');
    const call = fake.calls.find((c) => c.method === 'iscope_start_view')!;
    assert.deepEqual(call.params, { mode: 'star', selected_cam: 'View', target_ra_dec: [5.58, -5.39], target_name: 'M 42', lp_filter: false });
    assert.equal(scope.isBusy(), null);
  });

  test("a failed operation throws with the scope's error and code; one operation at a time", async () => {
    await connected();
    fake.on('start_auto_focuse', (_p, f) => {
      setTimeout(() => f.event({ Event: 'AutoFocus', state: 'fail', error: 'no star', code: 279, lapse_ms: 900 }), 50);
      return { result: 0 };
    });
    const first = scope.autofocus();
    await wait(10);
    await assert.rejects(scope.park(), /autofocus is running/);
    await assert.rejects(first, (e: unknown) => e instanceof SeestarOperationError && /no star/.test(e.message) && /code 279/.test(e.message));
  });

  test('polar alignment: the EqModePA deviation becomes pitch and rotate, as the Seestar app shows it', async () => {
    await connected();
    fake.on('start_polar_align', (_p, f) => {
      setTimeout(() => {
        f.event({ Event: 'EqModePA', state: 'working', route: [], x: -3.04, y: 1.02 });
        f.event({ Event: 'EqModePA', state: 'complete', route: [] });
      }, 30);
      return { result: 0 };
    });
    const r = await scope.polarAlign();
    assert.deepEqual(r.deviation, { xDeg: -3.04, yDeg: 1.02 });
    assert.equal(r.correction, 'pitch up 1.0°, rotate 3.0° counter-clockwise');
    assert.equal(scope.state.polarAlign?.ok, true);
    assert.equal(scope.state.polarAlign?.message, r.summary);
  });

  test('polar alignment that completes without a deviation fails and says so', async () => {
    await connected();
    fake.on('start_polar_align', (_p, f) => {
      setTimeout(() => f.event({ Event: 'EqModePA', state: 'complete', route: [] }), 30);
      return { result: 0 };
    });
    await assert.rejects(scope.polarAlign(), /without reporting a deviation/);
    assert.equal(scope.state.polarAlign?.ok, false);
  });

  test('an operation is abandoned when the link drops', async () => {
    await connected();
    fake.on('start_solve', (_p, f) => {
      setTimeout(() => f.kick(), 30);
      return { result: 0 };
    });
    await assert.rejects(scope.plateSolve(), /connection to the Seestar dropped/);
  });

  test('a hand move is the app joystick: the move renewed every 200 ms for the duration, then the stop', async () => {
    await connected();
    const r = await scope.nudge(90, 50, 0.5);
    assert.equal(r.code, 0);
    const moves = fake.calls.filter((c) => c.method === 'scope_speed_move').map((c) => c.params as Record<string, number>);
    assert.ok(moves.length >= 3 && moves.length <= 5, `renewed ${moves.length} times`);
    for (const m of moves.slice(0, -1)) assert.deepEqual(m, { angle: 90, percent: 50, level: 1, dur_sec: 3 });
    assert.deepEqual(moves.at(-1), { angle: 0, percent: 0, level: 0, dur_sec: 3 });
    // a move started over another supersedes it: the first one sends no stop of its own
    fake.calls.length = 0;
    const first = scope.nudge(0, 25, 2);
    await wait(250);
    const second = scope.nudge(180, 25, 0.3);
    assert.equal((await first).result, 'superseded');
    await second;
    const again = fake.calls.filter((c) => c.method === 'scope_speed_move').map((c) => c.params as Record<string, number>);
    assert.equal(again.filter((m) => m.percent === 0).length, 1, 'one stop');
    assert.deepEqual(again.at(-1), { angle: 0, percent: 0, level: 0, dur_sec: 3 });
    assert.ok(again.some((m) => m.angle === 180));
    // wait false: the answer is the first command's, the move goes on and stops by itself
    fake.calls.length = 0;
    const quick = await scope.nudge(270, 10, 0.5, { wait: false });
    assert.equal(quick.code, 0);
    assert.equal(fake.calls.filter((c) => c.method === 'scope_speed_move').length, 1);
    await until(() => fake.calls.some((c) => c.method === 'scope_speed_move' && (c.params as { percent: number }).percent === 0), 2000);
    assert.ok(fake.calls.filter((c) => c.method === 'scope_speed_move').length >= 3);
  });

  test('stop ends the running stage the way the app does and leaves the star view up', async () => {
    await connected();
    fake.calls.length = 0;
    assert.deepEqual(await scope.stopWork(), { stopped: [] });
    assert.equal(fake.calls.filter((c) => c.method === 'iscope_stop_view').length, 0, 'nothing running: the view is left alone');
    fake.event({ Event: 'AutoGoto', state: 'working' });
    await until(() => scope.isBusy() === 'goto');
    const r = await scope.stopWork();
    assert.deepEqual(r.stopped, ['goto']);
    const stops = fake.calls.filter((c) => c.method === 'iscope_stop_view').map((c) => c.params);
    assert.deepEqual(stops, [{ stage: 'AutoGoto' }]);
  });

  test('focuser moves are bounded by the reported range', async () => {
    await connected();
    fake.on('move_focuser', (p) => ({ result: { step: (p as { step: number }).step } }));
    assert.equal(await scope.focusTo(1700), 1700);
    assert.equal(await scope.focusBy(-50), 1650);
    await assert.rejects(scope.focusTo(9999), /outside 0–2600/);
  });

  test('Disconnect releases the scope until Connect, across a restart', async () => {
    await connected();
    await scope.release();
    assert.equal(scope.state.connected, false);
    assert.ok(fs.existsSync(path.join(dir, 'released.json')));
    await until(() => fake.connections === 0);
    await scope.stop();
    const again = new Seestar({ host: '127.0.0.1', connection: 'local', ports: fake.ports, tunnel: null, dataDir: dir });
    again.start();
    await wait(100);
    assert.equal(again.state.released, true);
    assert.equal(again.state.connected, false);
    again.connectLink();
    await until(() => again.state.connected);
    await again.stop();
  });

  test('a stacked image is grabbed from the tele picture socket', async () => {
    await connected();
    const px = Buffer.alloc(2 * 2 * 6, 0x40);
    fake.frames.stacked = Buffer.concat([encodeHeader({ imgType: IMG_TYPE.rawStack, length: px.length, width: 2, height: 2, imageId: 3 }), px]);
    await until(() => scope.images.tele.connected);
    await assert.rejects(scope.grabImage('tele', 'stacked', 500), /no stack is running/);
    fake.event({ Event: 'Stack', state: 'working' });
    fake.event({ Event: 'Stack', state: 'frame_complete', stacked_frame: 2, dropped_frame: 0 });
    await until(() => scope.state.stack.stacked === 2);
    const { image, frame } = await scope.grabImage('tele', 'stacked', 2000);
    assert.equal(frame.header.imageId, 3);
    assert.deepEqual([image.width, image.height, image.channels], [2, 2, 3]);
  });

  test('a view the scope already runs is adopted, never started over, even right after connecting', async () => {
    fake.starSession(true);
    fake.on('get_device_state', () => ({ result: S50_PRO }));
    scope.start();
    await until(() => scope.state.connected);
    const why = await scope.ensureLiveView();
    assert.equal(why, null);
    assert.equal(scope.state.view.mode, 'star');
    assert.equal(scope.exposing, 'tele');
    assert.ok(!fake.methods().includes('iscope_start_view'), `a view was started over the running one: ${fake.methods().join(', ')}`);
  });

  test('a scenery view left running by an earlier session is stopped on connect: this controller never runs one', async () => {
    let view: Record<string, unknown> = { state: 'working', mode: 'scenery', stage: 'RTSP' };
    fake.on('iscope_get_app_state', () => ({ result: { View: view } }));
    fake.on('iscope_stop_view', () => {
      view = { state: 'cancel', mode: 'scenery' };
      return { result: 0 };
    });
    fake.on('get_device_state', () => ({ result: S50_PRO }));
    await connected();
    await until(() => fake.methods().includes('iscope_stop_view'));
    assert.equal(scope.state.view.state, 'cancel');
    assert.ok(!fake.methods().includes('iscope_start_view'), `a view was started: ${fake.methods().join(', ')}`);
    // the live view a viewer asks for is the star view, never scenery, whatever the time of day
    await scope.startView();
    assert.deepEqual(fake.viewStarts().map((p) => p.mode), ['star']);
  });

  test('the readers wait for a view change in flight instead of starting a view of their own', async () => {
    fake.on('get_device_state', () => ({ result: S50_PRO }));
    let view: Record<string, unknown> = { state: 'working', mode: 'scenery', stage: 'RTSP' };
    fake.on('iscope_get_app_state', () => ({ result: { View: view } }));
    fake.on('iscope_stop_view', () => {
      view = { state: 'cancel', mode: 'scenery' };
      return { result: 0 };
    });
    fake.on('iscope_start_view', async (params: unknown) => {
      await wait(150);
      view = { state: 'working', mode: (params as { mode: string }).mode, stage: 'ContinuousExposure' };
      return { result: 0 };
    });
    await connected();
    await until(() => scope.state.view.mode === 'scenery');
    const change = scope.setViewMode('star');
    await wait(30); // the stop has landed, the start is in flight
    const why = await scope.ensureLiveView();
    await change;
    assert.equal(fake.viewStarts().length, 1, `views started: ${JSON.stringify(fake.viewStarts())}`);
    assert.equal(scope.state.view.mode, 'star');
    assert.equal(why, null);
  });
});

describe('Seestar camera selection', () => {
  let fake: FakeSeestar;
  let scope: Seestar;
  let dir: string;

  beforeEach(async () => {
    fake = new FakeSeestar();
    fake.noHandshakeMethod = true;
    await fake.listen();
    fake.on('get_device_state', () => ({ result: S50_PRO }));
    fake.starSession(true);
    fake.frames.preview = previewFrame();
    fake.frames.widePreview = previewFrame();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seestar-cam-'));
    scope = new Seestar({ host: '127.0.0.1', connection: 'local', ports: fake.ports, tunnel: null, dataDir: dir, link: { backoffMinMs: 50 } });
    scope.start();
    await until(() => scope.state.connected && scope.state.view.state === 'working' && fake.bin === 2);
    await until(() => fake.streams.tele, 2000);
  });

  afterEach(async () => {
    await scope.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the selected camera is the one the star session exposes with: a stop + start with selected_cam, and its socket streams', async () => {
    assert.equal(scope.selected, 'tele');
    assert.equal(scope.exposing, 'tele');
    assert.deepEqual(fake.streams, { tele: true, wide: false });
    assert.equal(scope.liveNote('tele'), null);
    assert.match(scope.liveNote('wide')!, /tele camera is selected/);
    await scope.selectCamera('wide', 'test');
    assert.equal(scope.selected, 'wide');
    assert.equal(scope.exposing, 'wide');
    assert.equal(fake.session.selected, 'SecondView');
    assert.deepEqual(fake.viewStarts(), [{ mode: 'star', selected_cam: 'SecondView', lp_filter: false }]);
    await until(() => fake.streams.wide && !fake.streams.tele, 2000);
    assert.equal(scope.liveNote('wide'), null);
    assert.match(scope.liveNote('tele')!, /wide camera is selected/);
    const { frame } = await scope.grabImage('wide', 'preview', 2000);
    assert.equal(frame.header.imageId, 65535);
    await assert.rejects(scope.grabImage('tele', 'preview', 500), /wide camera is selected/);
    // selecting the camera that already exposes changes nothing on the scope
    await scope.selectCamera('wide', 'again');
    assert.equal(fake.viewStarts().length, 1);
  });

  test('the selection is sticky: a hand move with the wide selected leaves the wide exposing', async () => {
    await scope.selectCamera('wide', 'test');
    await scope.nudge(90, 30, 0.3);
    await scope.nudge(0, 30, 0.3, { wait: false });
    await wait(600);
    await scope.refreshState();
    assert.equal(scope.selected, 'wide');
    assert.equal(scope.exposing, 'wide');
    assert.equal(fake.session.selected, 'SecondView');
    assert.equal(fake.viewStarts().length, 1, 'no view restart for a hand move');
    assert.deepEqual(fake.streams, { tele: false, wide: true });
  });

  test('a tool borrows the other camera for a frame and gives the selection back', async () => {
    await scope.selectCamera('wide', 'test');
    const { frame } = await scope.withCamera('tele', 'a test frame', async () => {
      assert.equal(scope.exposing, 'tele');
      assert.equal(scope.selected, 'wide', 'borrowing is not selecting');
      assert.equal(fake.session.selected, 'View');
      await until(() => fake.streams.tele && !fake.streams.wide, 2000);
      return scope.grabImage('tele', 'preview', 2000);
    });
    assert.equal(frame.header.imageId, 65535);
    await until(() => scope.exposing === 'wide', 3000);
    assert.equal(fake.session.selected, 'SecondView');
    assert.deepEqual(
      fake.viewStarts().map((p) => p.selected_cam),
      ['SecondView', 'View', 'SecondView'],
    );
    await until(() => fake.streams.wide && !fake.streams.tele, 2000);
  });

  test('an operation borrows the tele (autofocus) and the wide comes back when it is done', async () => {
    await scope.selectCamera('wide', 'test');
    fake.on('start_auto_focuse', (_p, f) => {
      setTimeout(() => f.event({ Event: 'AutoFocus', state: 'complete', lapse_ms: 10, route: [] }), 80);
      return { result: 0 };
    });
    const r = await scope.autofocus();
    assert.equal(r.state, 'complete');
    const starts = fake.viewStarts().map((p) => p.selected_cam);
    assert.deepEqual(starts.slice(0, 2), ['SecondView', 'View']);
    await until(() => scope.exposing === 'wide', 3000);
    assert.equal(scope.selected, 'wide');
    assert.equal(fake.session.selected, 'SecondView');
  });

  test('a stop during an operation\'s switch to the tele ends it before it starts, and the scope is busy meanwhile', async () => {
    await scope.selectCamera('wide', 'test');
    fake.viewDelayMs = 150;
    let focusStarts = 0;
    fake.on('start_auto_focuse', () => {
      focusStarts++;
      return { result: 0 };
    });
    const af = scope.autofocus();
    af.catch(() => undefined); // it rejects while the stop is still being awaited
    await until(() => scope.isBusy() === 'autofocus', 1000);
    assert.equal(scope.busy, true);
    const { stopped } = await scope.stopWork();
    assert.deepEqual(stopped, ['autofocus']);
    await assert.rejects(af, /autofocus was stopped before it started/);
    assert.equal(focusStarts, 0);
    assert.ok(fake.methods().includes('stop_auto_focuse'));
    await until(() => scope.exposing === 'wide' && scope.isBusy() === null, 3000);
    assert.equal(scope.selected, 'wide');
  });

  test('a GoTo with the wide selected runs on the tele (one start, with the target) and the wide comes back after', async () => {
    await scope.selectCamera('wide', 'test');
    const starts = fake.handlers.get('iscope_start_view')!;
    fake.on('iscope_start_view', async (p, f) => {
      const r = await starts(p, f);
      if ((p as { target_name?: string }).target_name) setTimeout(() => f.event({ Event: 'AutoGoto', state: 'complete', lapse_ms: 100, route: [] }), 60);
      return r;
    });
    const r = await scope.gotoTarget({ raHours: 0.71, decDeg: 41.27, name: 'M 31' });
    assert.equal(r.goto.state, 'complete');
    const gotoStarts = fake.viewStarts().filter((p) => p.target_name);
    assert.equal(gotoStarts.length, 1);
    assert.equal(gotoStarts[0]!.selected_cam, 'View');
    assert.deepEqual(fake.viewStarts().map((p) => p.selected_cam).slice(0, 2), ['SecondView', 'View'], 'no restart before the GoTo start');
    await until(() => scope.exposing === 'wide', 4000);
    assert.equal(scope.selected, 'wide');
  });

  test('a stack owns the view: it runs on the tele and the wide is not selected under it', async () => {
    fake.on('iscope_start_stack', (_p, f) => {
      f.session.stage = 'Stack';
      setTimeout(() => {
        f.event({ Event: 'Stack', state: 'working' });
        f.event({ Event: 'Stack', state: 'frame_complete', stacked_frame: 1, dropped_frame: 0 });
      }, 20);
      return { result: 0 };
    });
    await scope.startStack();
    await until(() => scope.isStacking());
    assert.equal(scope.exposing, 'tele');
    await scope.selectCamera('wide', 'test');
    assert.equal(scope.selected, 'wide');
    assert.equal(scope.exposing, 'tele', 'the stack keeps the tele');
    assert.match(scope.liveNote('wide')!, /tele camera is selected.*stacking|stack/i);
    await assert.rejects(scope.withCamera('wide', 'a test frame', async () => 'no'), /while stacking/);
    assert.equal(fake.viewStarts().length, 0);
    const stopView = fake.handlers.get('iscope_stop_view')!;
    fake.on('iscope_stop_view', (p, f) => {
      if ((p as { stage?: string } | undefined)?.stage !== 'Stack') return stopView(p, f);
      // the stack stage ends, the view goes on exposing
      fake.session.stage = 'ContinuousExposure';
      fake.event({ Event: 'Stack', state: 'cancel', lapse_ms: 10, route: [] });
      return { result: 0 };
    });
    await scope.stopStack();
    await until(() => scope.exposing === 'wide', 4000);
    assert.equal(fake.session.selected, 'SecondView');
  });

  test('the live preview runs at bin 2 and a full-resolution frame takes the camera to bin 1 and back', async () => {
    const bins = () => fake.calls.filter((c) => c.method === 'set_camera_bin').map((c) => c.params);
    assert.deepEqual(bins(), [2], 'connecting set the preview bin');
    await scope.withFullRes('tele', 'a test photo', async () => {
      assert.equal(fake.bin, 1, 'the photo runs at full resolution');
      assert.equal(scope.exposing, 'tele');
    });
    await until(() => fake.bin === 2);
    assert.deepEqual(bins(), [2, 1, 2]);
  });

  test("the video hub selects the camera in the viewer's main view, not a thumbnail", async () => {
    const { SeestarVideoHub } = await import('../drivers/seestar/hub.js');
    const hub = new SeestarVideoHub(scope, () => '127.0.0.1');
    try {
      const off = [hub.tele.subscribe(() => {}), hub.wide.subscribe(() => {})];
      hub.wide.setPrimary('browser', true); // the wide in the main view, the tele a thumbnail
      hub.tele.setPrimary('browser', false);
      await until(() => scope.exposing === 'wide', 5000);
      assert.equal(scope.selected, 'wide');
      await wait(1500); // more hub ticks
      assert.equal(scope.exposing, 'wide', 'the tele thumbnail does not take the camera back');
      assert.match(String(hub.tele.status().note), /wide camera is selected/);
      assert.equal(hub.wide.status().note, null);
      // the main view goes back to the tele
      hub.tele.setPrimary('browser', true);
      hub.wide.setPrimary('browser', false);
      await until(() => scope.exposing === 'tele', 5000);
      assert.equal(scope.selected, 'tele');
      assert.deepEqual(fake.viewStarts().map((p) => p.selected_cam), ['SecondView', 'View']);
      for (const f of off) f();
    } finally {
      hub.shutdown();
    }
  });

  test('live frames reach the camera sources from the picture sockets', async () => {
    const { SeestarVideoHub } = await import('../drivers/seestar/hub.js');
    const hub = new SeestarVideoHub(scope, () => '127.0.0.1');
    try {
      const got: Buffer[] = [];
      const off = hub.tele.subscribe((f) => got.push(f.jpeg));
      await until(() => got.length >= 2, 4000);
      assert.deepEqual(got[0]!.subarray(0, 2), Buffer.from([0xff, 0xd8]));
      off();
    } finally {
      hub.shutdown();
    }
  });
});

describe('driver selection', () => {
  test('the Dwarf stays the default driver; the Seestar driver loads by id', async () => {
    assert.equal(config.telescope.driver, process.env.TELESCOPE_DRIVER || 'dwarf');
    const d = await loadDriver('seestar');
    assert.equal(d.id, 'seestar');
    assert.equal(MCP_SERVER_NAMES.seestar, 'seestar');
    assert.equal(MCP_SERVER_NAMES.dwarf, 'dwarf3');
    assert.equal((await loadDriver('dwarf')).id, 'dwarf');
  });
});

describe('Seestar MCP tools', () => {
  test('register under the seestar server with their schemas', async () => {
    const { registerSeestarTools, seestarMcpSpec } = await import('../drivers/seestar/mcp.js');
    const scope = new Seestar({ host: '127.0.0.1', connection: 'local', tunnel: null, dataDir: os.tmpdir() });
    const names: string[] = [];
    registerSeestarTools(((name: string) => names.push(name)) as never, scope);
    for (const n of ['seestar_status', 'select_camera', 'goto_target', 'start_stacking', 'stop_stacking', 'autofocus', 'get_image', 'plan_targets', 'zwo_devices', 'tunnel_status', 'raw_rpc']) assert.ok(names.includes(n), n);
    assert.equal(new Set(names).size, names.length);
    assert.equal(seestarMcpSpec(scope).name, 'seestar');
  });

  test("the app's shared tools come with them (duty, Stellarium, sky, catalog, library), each name once", async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { seestarMcpSpec } = await import('../drivers/seestar/mcp.js');
    const { DutyLoop } = await import('../agent/duty.js');
    const { seestarDuty } = await import('../drivers/seestar/duty.js');
    const { EventEmitter } = await import('node:events');
    const scope = new Seestar({ host: '127.0.0.1', connection: 'local', tunnel: null, dataDir: os.tmpdir() });
    const agent = Object.assign(new EventEmitter(), { ready: false, busy: false, note() {}, async prompt() {} });
    const duty = new DutyLoop(seestarDuty(scope), agent as never, { tickMs: 0, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duty-')), 'duty.json') });
    try {
      const server = new McpServer({ name: 'test', version: '0' });
      const names: string[] = [];
      const reg = server.registerTool.bind(server);
      server.registerTool = ((name: string, ...rest: never[]) => (names.push(name), reg(name, ...(rest as [never, never])))) as typeof server.registerTool;
      // a name registered twice throws here
      const { seestarMedia } = await import('../drivers/seestar/web.js');
      const media = seestarMedia(scope);
      seestarMcpSpec(scope, duty, media).register(server);
      media.hub.shutdown();
      for (const n of ['duty', 'show_in_stellarium', 'sky_conditions', 'weather_forecast', 'search_catalog', 'rest_target', 'list_library', 'processing_status', 'goto_target', 'plan_targets']) assert.ok(names.includes(n), n);
      // the Seestar's storage, album, camera and focus tools under the Dwarf's names
      for (const n of ['list_device_sessions', 'transfer_session', 'transfer_files', 'list_album', 'view_image', 'analyze_image', 'analyze_subs', 'delete_album_items', 'take_photo', 'video_recording', 'timelapse', 'view_camera', 'stacking_status', 'star_sharpness', 'star_focus', 'dark_frames']) assert.ok(names.includes(n), n);
      // and every other tool the Dwarf's agent has
      for (const n of ['telescope_status', 'telescope_device_info', 'telescope_reconnect', 'sync_time_and_location', 'raw_command', 'device_switches', 'motor_position', 'move_motors', 'motors_home', 'stop_motion', 'stop_goto', 'focus_step', 'focus_position', 'tele_visibility', 'mark_blocked', 'calibrate', 'astro_recover', 'live_stacking', 'polar_alignment', 'track_sun_moon', 'track_object', 'sentry_mode', 'set_shooting_mode', 'get_camera_settings', 'set_camera_setting', 'sky_check', 'map_obstructions']) assert.ok(names.includes(n), n);
    } finally {
      duty.dispose();
    }
  });
});
