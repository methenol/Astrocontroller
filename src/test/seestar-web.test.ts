import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as sky from '../astro/sky.js';
import type { Seestar } from '../drivers/seestar/device.js';
import { initialState } from '../drivers/seestar/model.js';
import { nudgePercent, projectState, seestarWeb } from '../drivers/seestar/web.js';
import { dwarfWeb } from '../drivers/dwarf/web.js';
import { controlRoutes } from '../web/routes/control.js';
import { jsonErrors } from '../web/http.js';
import type { WebContext } from '../web/context.js';
import type { WebTelescope } from '../web/telescope.js';

const SITE = { lat: 45.5, lon: -122.6, elev: 50 };

/** A picture socket that never connects, as the live views see it. */
class StubImages extends EventEmitter {
  connected = false;
  streaming = false;
  constructor(readonly camera: 'tele' | 'wide') {
    super();
  }
  status = () => ({ camera: this.camera, connected: false, streaming: false, liveFrames: 0, lastFrameAt: null, note: null });
}

/** The Seestar's surface the adapter uses, recording the commands it is sent. */
class StubSeestar extends EventEmitter {
  state = initialState('local');
  calls: unknown[][] = [];
  busy: string | null = null;
  selected: 'tele' | 'wide' = 'tele';
  exposing: 'tele' | 'wide' | null = 'tele';
  images = { tele: new StubImages('tele'), wide: new StubImages('wide') };
  link = { wireLines: () => [], usable: true, health: () => ({}) };
  constructor() {
    super();
    this.state.connected = true;
  }
  isBusy = () => this.busy;
  isStacking = () => false;
  viewRunning = () => true;
  liveNote = () => null;
  requireLocation = () => SITE;
  location = () => SITE;
  private rec =
    (name: string, ret: unknown = {}) =>
    async (...a: unknown[]) => {
      this.calls.push([name, ...a]);
      return ret;
    };
  nudge = this.rec('nudge');
  stopMotion = this.rec('stopMotion');
  stopWork = this.rec('stopWork', { stopped: ['autofocus'] });
  readPointing = this.rec('readPointing', {});
  focusBy = this.rec('focusBy', 1234);
  setExposure = this.rec('setExposure');
  setGain = this.rec('setGain');
  park = this.rec('park', { state: 'complete' });
  selectCamera = this.rec('selectCamera');
  gotoTarget = this.rec('gotoTarget', { goto: { state: 'complete', ms: 42_000 }, stacking: 'not requested' });
}

const make = () => {
  const stub = new StubSeestar();
  return { stub, web: seestarWeb(stub as unknown as Seestar) };
};

async function withControl(scope: WebTelescope, fn: (post: (b: unknown, path?: string) => Promise<{ status: number; body: Record<string, unknown> }>, events: string[]) => Promise<void>) {
  const events: string[] = [];
  const ctx = { scope, duty: { event: (t: string) => events.push(t) } } as unknown as WebContext;
  const app = express();
  app.use(express.json());
  app.use('/api', controlRoutes(ctx));
  app.use('/api', scope.routes!());
  app.use(jsonErrors);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    await fn(async (b, path = '/control') => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }, events);
  } finally {
    scope.hub.shutdown();
    await new Promise((r) => server.close(r));
  }
}

describe('Seestar behind the shared web UI', () => {
  test("its state is published in the UI's field names, with the camera the UI chose and the one exposing", () => {
    const stub = new StubSeestar();
    const st = stub.state;
    st.device = { name: 'S50 test', firmware: '6.45' };
    st.power = { batteryPct: 77, charging: true, tempC: 31 };
    st.storage = { freeMB: 20480, totalMB: 51200 };
    st.mount = { eqMode: true, tracking: true };
    st.view = { target: 'M 31', targetRaDec: [0.712, 41.27] };
    st.stack = { state: 'working', stacked: 40, dropped: 2, total: 100 };
    st.focus = { position: 1580 };
    st.ops.AutoGoto = { state: 'complete', at: 1, outer: true };
    stub.busy = 'stacking';
    stub.selected = 'wide';
    const t = projectState(stub as unknown as Seestar) as Record<string, any>;
    assert.equal(t.connected, true);
    assert.equal(t.link.state, 'connected');
    assert.equal(t.device.name, 'S50 test');
    assert.equal(t.battery, 77);
    assert.equal(t.charging, true);
    assert.equal(t.temperatureC, 31);
    assert.deepEqual(t.storage, { availableGB: 20, totalGB: 50 });
    assert.equal(t.bodyMode, 'eq');
    assert.deepEqual(t.goto, { state: 'done', target: 'M 31' });
    assert.equal(t.tracking.state, 'running');
    // the focus readout is the main view's camera's focuser (each camera has its own)
    assert.deepEqual((t as any).focusPositions, { tele: 1580, wide: undefined });
    assert.deepEqual(t.stacking.tele, { state: 'running', currentCount: 42, stackedCount: 40, totalCount: 100, target: 'M 31' });
    // stacking is shown by the stacking bar, not as a busy operation
    assert.equal(t.operation, undefined);
    assert.equal(t.pointing.target, 'M 31');
    assert.ok(t.fov.tele.h > 0);
    assert.deepEqual(t.camera, { selected: 'wide', exposing: 'tele' });
    stub.busy = 'autofocus';
    assert.equal((projectState(stub as unknown as Seestar) as any).operation, 'autofocus');
  });

  test('a released Seestar says so; one not connected says it is connecting', () => {
    const stub = new StubSeestar();
    stub.state.connected = false;
    stub.state.released = true;
    assert.equal((projectState(stub as unknown as Seestar) as any).link.state, 'released');
    stub.state.released = false;
    assert.equal((projectState(stub as unknown as Seestar) as any).link.state, 'connecting');
  });

  test('a nudge turns the screen angle into the joystick move and the slider into the camera\'s speed curve, answered at once', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      // tele in the main view: the slider runs 1-30% (a fine nudge for framing)
      (stub as any).selected = 'tele';
      const r = await post({ action: 'nudge', angle: 0, speed: 0.05, ms: 400, press: 'p1' });
      assert.equal(r.status, 200);
      // screen 0 (up) is the Seestar's 90; the bottom of the slider is the slowest percent
      assert.deepEqual(stub.calls[0], ['nudge', 90, 1, 0.4, { wait: false, press: 'p1' }]);
      assert.equal(r.body.camera, 'tele');
      await post({ action: 'nudge', angle: 90, speed: 1, ms: 5000 });
      assert.deepEqual(stub.calls[1], ['nudge', 0, 30, 5, { wait: false, press: undefined }]);
      // wide: 5-100% (panning)
      (stub as any).selected = 'wide';
      await post({ action: 'nudge', angle: 180, speed: 1, ms: 1500 });
      assert.deepEqual(stub.calls[2], ['nudge', -90, 100, 1.5, { wait: false, press: undefined }]);
      await post({ action: 'nudge', angle: 180, speed: 0.05, ms: 1500 });
      assert.equal(stub.calls[3][2], 5);
    });
    // the curve is exponential and monotonic in between
    let last = 0;
    for (let s = 0.05; s <= 1.0001; s += 0.05) {
      const p = nudgePercent(s, 'wide');
      assert.ok(p >= last, `monotonic at ${s}`);
      last = p;
    }
    assert.equal(nudgePercent(0.525, 'tele'), Math.round(Math.sqrt(30)));
  });

  test('a press\'s release stops only that hand movement', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      const r = await post({ action: 'stop', press: 'p1' });
      assert.deepEqual(r.body, { ok: true, stopped: ['hand movement'] });
      assert.deepEqual(stub.calls, [['stopMotion', 'p1']]);
    });
  });

  test('the stop button ends whatever runs (stopWork) and the hand movement', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      const r = await post({ action: 'stop' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, stopped: ['autofocus'] });
      assert.deepEqual(stub.calls.map((c) => c[0]), ['stopWork', 'stopMotion']);
    });
  });

  test('focus, exposure and gain map onto the Seestar commands', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      assert.equal((await post({ action: 'focus', direction: 'near', steps: 20 })).status, 200);
      assert.equal((await post({ action: 'setting', setting: 'exposure', value: '10' })).status, 200);
      assert.equal((await post({ action: 'setting', setting: 'gain', value: 80 })).status, 200);
      assert.deepEqual(stub.calls, [
        ['focusBy', -20, 'tele'],
        ['setExposure', { stackMs: 10_000 }],
        ['setGain', 80],
      ]);
    });
  });

  test('the camera is chosen through its own route', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      const r = await post({ camera: 'wide' }, '/seestar/camera');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(stub.calls, [['selectCamera', 'wide', 'chosen in the web UI']]);
      assert.deepEqual(r.body, { selected: 'tele', exposing: 'tele' });
      assert.equal((await post({ camera: 'both' }, '/seestar/camera')).status, 400);
    });
  });

  test('a control the Seestar has no equivalent of is refused with 501 and the reason, and nothing is sent', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      for (const body of [{ action: 'record', camera: 'wide', on: true }, { action: 'mode', mode: 'Panorama' }, { action: 'mode', mode: 'Star Trail' }]) {
        const r = await post(body);
        assert.equal(r.status, 501, JSON.stringify(body));
        assert.match(String(r.body.error), /not available on the ZWO Seestar/);
      }
      // the Sun is refused outright, remotely
      const sun = await post({ action: 'mode', mode: 'Sun' });
      assert.notEqual(sun.status, 200);
      assert.match(String(sun.body.error), /solar filter/);
      assert.deepEqual(stub.calls, []);
    });
  });

  test('a GoTo to a planet sends its position now; the shared route checks the altitude first', async () => {
    const { stub, web } = make();
    const alt = sky.bodyAlt(SITE, 'Jupiter');
    await withControl(web, async (post, events) => {
      const r = await post({ action: 'goto_sky', name: 'Jupiter', raHours: 1, decDeg: 1 });
      if (alt < 5) {
        assert.equal(r.status, 400);
        assert.deepEqual(stub.calls, []);
        return;
      }
      assert.equal(r.status, 200);
      const [name, req] = stub.calls[0] as [string, { raHours: number; decDeg: number; name: string }];
      assert.equal(name, 'gotoTarget');
      const now = sky.bodyRaDec(SITE, 'Jupiter');
      assert.ok(Math.abs(req.raHours - now.raHours) < 0.01 && Math.abs(req.decDeg - now.decDeg) < 0.1);
      assert.match(events[0]!, /GoTo to Jupiter/);
    });
  });

  test('the Dwarf and the Seestar serve the same UI: the Dwarf can do everything, the Seestar says what it cannot', () => {
    const { web } = make();
    const dwarf = dwarfWeb({ state: { fov: {} } } as never, {} as never);
    for (const [k, v] of Object.entries(dwarf.capabilities)) if (k !== 'video') assert.equal(v, true, k);
    // singleView is a layout hint (one camera exposes at a time), not a feature the Dwarf lacks
    assert.deepEqual(Object.keys(web.capabilities).filter((k) => k !== 'singleView').sort(), Object.keys(dwarf.capabilities).sort());
    assert.equal(web.capabilities.singleView, true);
    assert.deepEqual(web.capabilities.video, ['tele', 'wide', 'stack']);
    // parity: the Seestar does everything the Dwarf does
    for (const [k, v] of Object.entries(web.capabilities)) if (k !== 'video') assert.equal(v, true, k);
    web.hub.shutdown();
  });
});
