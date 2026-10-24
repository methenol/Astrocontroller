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
    assert.ok(scope.state.fov && Math.abs(scope.state.fov.h - 2.13) < 0.01);
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
      seestarMcpSpec(scope, duty).register(server);
      for (const n of ['duty', 'show_in_stellarium', 'sky_conditions', 'weather_forecast', 'search_catalog', 'rest_target', 'list_library', 'processing_status', 'goto_target', 'plan_targets']) assert.ok(names.includes(n), n);
      // the SD-card tools and the Dwarf's wide-camera sky check are the Dwarf's
      for (const n of ['list_device_sessions', 'transfer_session', 'sky_check']) assert.ok(!names.includes(n), n);
    } finally {
      duty.dispose();
    }
  });
});
