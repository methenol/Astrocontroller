import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { Seestar, SeestarOperationError } from '../drivers/seestar/device.js';
import { encodeHeader, IMG_TYPE } from '../drivers/seestar/image-stream.js';
import { loadDriver, MCP_SERVER_NAMES } from '../drivers/index.js';
import { FakeSeestar } from './fake-seestar.js';

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
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
    const connect = (_h: string, p: number) => net.connect({ host: '127.0.0.1', port: p === config.seestar.rpcPort ? fake.port : fake.imagePort });
    scope = new Seestar({ host: '127.0.0.1', connection: 'local', connect, tunnel: null, dataDir: dir, link: { backoffMinMs: 50 } });
  });

  afterEach(async () => {
    scope.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const connected = async () => {
    scope.start();
    await until(() => scope.state.connected && scope.state.device.model !== undefined);
  };

  test('reads the device on connect (full state, unredacted), with pointing and FOV', async () => {
    await connected();
    await until(() => scope.state.mount.altDeg !== undefined);
    assert.equal(scope.state.device.model, 'Seestar S30');
    assert.equal(scope.state.mount.parked, true);
    assert.deepEqual([scope.state.mount.raHours, scope.state.mount.decDeg, scope.state.mount.altDeg, scope.state.mount.azDeg], [1.5, 30, 45, 120]);
    // portrait, as the frames are read: chip_size [1080, 1920] is width × height
    assert.ok(scope.state.fov && Math.abs(scope.state.fov.h - 1.196) < 0.01 && Math.abs(scope.state.fov.v - 2.127) < 0.01);
    assert.deepEqual((scope.state.deviceState as { ap: unknown }).ap, { passwd: 'secret' });
    assert.equal(scope.driver, 'seestar');
  });

  test('pushes the time (and location when known) after connecting', async () => {
    await connected();
    await until(() => fake.methods().includes('pi_set_time'));
    const t = fake.calls.find((c) => c.method === 'pi_set_time')!.params as Array<Record<string, unknown>>;
    assert.equal(typeof t[0].year, 'number');
    assert.equal(t[0].time_zone, config.observer.timezone);
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
    assert.deepEqual(call.params, { mode: 'star', target_ra_dec: [5.58, -5.39], target_name: 'M 42', lp_filter: false });
    assert.equal(scope.isBusy(), null);
  });

  test('a failed operation throws with the scope\'s error and code; one operation at a time', async () => {
    await connected();
    fake.on('start_auto_focuse', (_p, f) => {
      setTimeout(() => f.event({ Event: 'AutoFocus', state: 'fail', error: 'no star', code: 279, lapse_ms: 900 }), 50);
      return { result: 0 };
    });
    const first = scope.autofocus();
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

  test('focuser moves are bounded by the reported range', async () => {
    await connected();
    fake.on('move_focuser', (p) => ({ result: { step: (p as { step: number }).step } }));
    assert.equal(await scope.focusTo(1700), 1700);
    assert.equal(await scope.focusBy(-50), 1650);
    await assert.rejects(scope.focusTo(9999), /outside 0–2600/);
    assert.throws(() => scope.nudge(90, 5000, 2), /speed/);
  });

  test('Disconnect releases the scope until Connect, across a restart', async () => {
    await connected();
    scope.release();
    assert.equal(scope.state.connected, false);
    assert.ok(fs.existsSync(path.join(dir, 'released.json')));
    await until(() => fake.connections === 0);
    scope.stop();
    const again = new Seestar({ host: '127.0.0.1', connection: 'local', tunnel: null, dataDir: dir, connect: (_h, p) => net.connect({ host: '127.0.0.1', port: p === config.seestar.rpcPort ? fake.port : fake.imagePort }) });
    again.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(again.state.released, true);
    assert.equal(again.state.connected, false);
    again.connectLink();
    await until(() => again.state.connected);
    again.stop();
  });

  test('a stacked image is grabbed from the image port', async () => {
    await connected();
    const px = Buffer.alloc(2 * 2 * 6, 0x40);
    fake.frames.stacked = Buffer.concat([encodeHeader({ imgType: IMG_TYPE.rawStack, length: px.length, width: 2, height: 2, imageId: 3 }), px]);
    const { image, frame } = await scope.grabImage('tele', 'stacked', 2000);
    assert.equal(frame.header.imageId, 3);
    assert.deepEqual([image.width, image.height, image.channels], [2, 2, 3]);
  });

  test('a view the scope already runs is left alone by the readers, even right after connecting', async () => {
    // a controller restart during a star view started a scenery view over it: the readers asked for
    // a view before the first state read had landed, and an unread state looks like no view at all
    fake.on('iscope_get_app_state', () => ({ result: { View: { state: 'working', mode: 'star', stage: 'ContinuousExposure' } } }));
    fake.on('get_device_state', () => ({ result: { device: { name: 'S50 Pro', product_model: 'Seestar S50 Pro', focal_len: 260 }, camera: { chip_size: [2160, 3840], pixel_size_um: 2.9 }, mount: { equ_mode: true, close: false }, focuser: { step: 1000, max_step: 2600 } } }));
    scope.start();
    await until(() => scope.state.connected);
    const why = await scope.ensureLiveView();
    assert.equal(why, null);
    assert.equal(scope.state.view.mode, 'star');
    assert.ok(!fake.methods().includes('iscope_start_view'), `a view was started over the running one: ${fake.methods().join(', ')}`);
  });

  test('a scenery view left running by an earlier session is stopped on connect: this controller never runs one', async () => {
    let view: Record<string, unknown> = { state: 'working', mode: 'scenery', stage: 'RTSP' };
    fake.on('iscope_get_app_state', () => ({ result: { View: view } }));
    fake.on('iscope_stop_view', () => {
      view = { state: 'cancel', mode: 'scenery' };
      return { result: 0 };
    });
    fake.on('get_device_state', () => ({ result: { device: { name: 'S50 Pro', product_model: 'Seestar S50 Pro', focal_len: 260 }, camera: { chip_size: [2160, 3840], pixel_size_um: 2.9 }, mount: { equ_mode: true, close: false }, focuser: { step: 1000, max_step: 2600 } } }));
    await connected();
    await until(() => fake.methods().includes('iscope_stop_view'));
    assert.equal(scope.state.view.state, 'cancel');
    assert.ok(!fake.methods().includes('iscope_start_view'), `a view was started: ${fake.methods().join(', ')}`);
    // the live view a viewer asks for is the star view, never scenery, whatever the time of day
    await scope.startView();
    const starts = fake.calls.filter((c) => c.method === 'iscope_start_view').map((c) => c.params as { mode: string });
    assert.deepEqual(starts.map((p) => p.mode), ['star']);
  });

  test("a wide frame comes from the wide camera's star view (SecondView), and the tele's star view comes back", async () => {
    let view: Record<string, unknown> = { state: 'working', mode: 'star', stage: 'ContinuousExposure' };
    fake.on('iscope_get_app_state', () => ({ result: { View: view } }));
    fake.on('iscope_stop_view', () => {
      view = { state: 'cancel', mode: 'star' };
      return { result: 0 };
    });
    fake.on('iscope_start_view', (params: unknown) => {
      view = { state: 'working', mode: (params as { mode: string }).mode, stage: 'ContinuousExposure' };
      return { result: 0 };
    });
    await connected(); // the star view found running is adopted (it is the live stream) and comes back after the wide frame
    await until(() => scope.state.view.state === 'working');
    const px = Buffer.alloc(2 * 2 * 2, 0x40);
    fake.frames.preview = Buffer.concat([encodeHeader({ imgType: IMG_TYPE.preview, length: px.length, width: 2, height: 2, imageId: 7 }), px]);
    assert.equal(scope.wideViewActive, false);
    await assert.rejects(scope.grabImage('wide', 'preview', 500), /wide camera's view/);
    const { frame } = await scope.withCameraView('wide', 'a test frame', async () => {
      assert.equal(scope.wideViewActive, true);
      return scope.grabImage('wide', 'preview', 2000);
    });
    assert.equal(frame.header.imageId, 7);
    assert.equal(scope.wideViewActive, false);
    const starts = fake.calls.filter((c) => c.method === 'iscope_start_view').map((c) => c.params as { mode: string; selected_cam?: string });
    assert.deepEqual(starts, [
      { mode: 'star', selected_cam: 'SecondView', lp_filter: false },
      { mode: 'star', lp_filter: false },
    ]);
    assert.equal(scope.state.view.mode, 'star');
  });
  test('the readers wait for a view change in flight instead of starting a view of their own', async () => {
    // iscope_start_view takes the scope seconds; a reader whose RTSP had just ended asked for a
    // view meanwhile, and set_shooting_mode DSO ended with the scenery view it started on top
    fake.on('get_device_state', () => ({ result: { device: { name: 'S50 Pro', product_model: 'Seestar S50 Pro', focal_len: 260 }, camera: { chip_size: [2160, 3840], pixel_size_um: 2.9 }, mount: { equ_mode: true, close: false }, focuser: { step: 1000, max_step: 2600 } } }));
    let view: Record<string, unknown> = { state: 'working', mode: 'scenery', stage: 'RTSP' };
    fake.on('iscope_get_app_state', () => ({ result: { View: view } }));
    fake.on('iscope_stop_view', () => {
      view = { state: 'cancel', mode: 'scenery' };
      return { result: 0 };
    });
    fake.on('iscope_start_view', async (params: unknown) => {
      await new Promise((r) => setTimeout(r, 150));
      view = { state: 'working', mode: (params as { mode: string }).mode, stage: 'ContinuousExposure' };
      return { result: 0 };
    });
    await connected();
    await until(() => scope.state.view.mode === 'scenery');
    const change = scope.setViewMode('star');
    await new Promise((r) => setTimeout(r, 30)); // the stop has landed, the start is in flight
    const why = await scope.ensureLiveView();
    await change;
    const starts = fake.calls.filter((c) => c.method === 'iscope_start_view');
    assert.equal(starts.length, 1, `views started: ${JSON.stringify(starts.map((c) => c.params))}`);
    assert.equal(scope.state.view.mode, 'star');
    assert.equal(why, null);
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

describe('Seestar view precedence', () => {
  let fake: FakeSeestar;
  let scope: Seestar;

  beforeEach(async () => {
    fake = new FakeSeestar();
    fake.noHandshakeMethod = true;
    await fake.listen();
    fake.on('get_device_state', () => ({ result: { device: { name: 'S50 Pro' }, mount: { equ_mode: false, close: true } } }));
    fake.on('iscope_get_app_state', () => ({ result: { View: { state: 'idle' } } }));
    const connect = (_h: string, p: number) => net.connect({ host: '127.0.0.1', port: p === config.seestar.rpcPort ? fake.port : fake.imagePort });
    scope = new Seestar({ host: '127.0.0.1', connection: 'local', connect, tunnel: null, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'seestar-view-')), link: { backoffMinMs: 50 } });
    scope.start();
    await until(() => scope.state.connected);
  });

  afterEach(async () => {
    scope.stop();
    await fake.close();
  });

  test('a wide still never stops an operation that took the scope while it was shooting', async () => {
    // The wide camera's video runs in the Normal view only, and leaving that view is a stop_view -
    // which stops whatever the view is doing. An agent that starts a focus run (a GoTo, a stack)
    // while a still is being taken must not have it cancelled by the preview being put back.
    let focus: Promise<unknown> | null = null;
    const shot = await scope.withCameraView('wide', 'a test frame', async () => {
      focus = scope.autofocus();
      await new Promise((r) => setTimeout(r, 150)); // the focus command is in flight by now
      return 'shot';
    });
    assert.equal(shot, 'shot');
    assert.ok(fake.methods().includes('iscope_start_view'), 'the wide camera is served from the Normal view');
    assert.ok(fake.methods().includes('start_auto_focuse'), 'the focus run started while the still was open');
    fake.event({ Event: 'AutoFocus', state: 'complete', lapse_ms: 10 });
    await focus;
    assert.ok(!fake.methods().includes('iscope_stop_view'), `the preview stopped the operation: ${fake.methods().join(', ')}`);
  });
});


describe('Seestar MCP tools', () => {
  test('register under the seestar server with their schemas', async () => {
    const { registerSeestarTools, seestarMcpSpec } = await import('../drivers/seestar/mcp.js');
    const scope = new Seestar({ host: '127.0.0.1', connection: 'local', tunnel: null, dataDir: os.tmpdir() });
    const names: string[] = [];
    registerSeestarTools(((name: string) => names.push(name)) as never, scope);
    for (const n of ['seestar_status', 'goto_target', 'start_stacking', 'stop_stacking', 'autofocus', 'get_image', 'plan_targets', 'zwo_devices', 'tunnel_status', 'raw_rpc']) assert.ok(names.includes(n), n);
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
