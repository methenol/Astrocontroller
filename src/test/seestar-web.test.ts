import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import * as sky from '../astro/sky.js';
import type { Seestar } from '../drivers/seestar/device.js';
import { initialState } from '../drivers/seestar/state.js';
import { projectState, seestarWeb } from '../drivers/seestar/web.js';
import { dwarfWeb } from '../drivers/dwarf/web.js';
import { controlRoutes } from '../web/routes/control.js';
import { jsonErrors } from '../web/http.js';
import type { WebContext } from '../web/context.js';
import type { WebTelescope } from '../web/telescope.js';

const SITE = { lat: 45.5, lon: -122.6, elev: 50 };

/** The Seestar's surface the adapter uses, recording the commands it is sent. */
class StubSeestar extends EventEmitter {
  state = initialState('local');
  calls: unknown[][] = [];
  busy: string | null = null;
  constructor() {
    super();
    this.state.connected = true;
  }
  isBusy = () => this.busy;
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
  readPointing = this.rec('readPointing', {});
  focusBy = this.rec('focusBy', 1234);
  setExposure = this.rec('setExposure');
  setGain = this.rec('setGain');
  park = this.rec('park', { state: 'complete' });
  gotoTarget = this.rec('gotoTarget', { goto: { state: 'complete', ms: 42_000 }, stacking: 'not requested' });
}

const make = () => {
  const stub = new StubSeestar();
  return { stub, web: seestarWeb(stub as unknown as Seestar) };
};

async function withControl(scope: WebTelescope, fn: (post: (b: unknown) => Promise<{ status: number; body: Record<string, unknown> }>, events: string[]) => Promise<void>) {
  const events: string[] = [];
  const ctx = { scope, duty: { event: (t: string) => events.push(t) } } as unknown as WebContext;
  const app = express();
  app.use(express.json());
  app.use('/api', controlRoutes(ctx));
  app.use(jsonErrors);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    await fn(async (b) => {
      const res = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }, events);
  } finally {
    scope.hub.shutdown();
    await new Promise((r) => server.close(r));
  }
}

describe('Seestar behind the shared web UI', () => {
  test("its state is published in the UI's field names", () => {
    const st = initialState('local');
    Object.assign(st, { connected: true });
    st.device = { name: 'S50 test', firmware: '6.45' };
    st.power = { batteryPct: 77, charging: true, tempC: 31 };
    st.storage = { freeMB: 20480, totalMB: 51200 };
    st.mount = { eqMode: true, tracking: true };
    st.view = { target: 'M 31', targetRaDec: [0.712, 41.27] };
    st.stack = { state: 'working', stacked: 40, dropped: 2, total: 100 };
    st.focus = { position: 1580 };
    st.ops.AutoGoto = { state: 'complete', at: 1, outer: true };
    const t = projectState(st, 'stacking') as Record<string, any>;
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
    assert.equal(t.focusPosition, 1580);
    assert.deepEqual(t.stacking.tele, { state: 'running', currentCount: 42, stackedCount: 40, totalCount: 100, target: 'M 31' });
    // stacking is shown by the stacking bar, not as a busy operation
    assert.equal(t.operation, undefined);
    assert.equal(t.pointing.target, 'M 31');
    assert.ok(t.fov.tele.h > 0);
    assert.equal(projectState(st, 'autofocus').operation, 'autofocus');
  });

  test('a released Seestar says so; one not connected says it is connecting', () => {
    const st = initialState('local');
    st.released = true;
    assert.equal((projectState(st, null) as any).link.state, 'released');
    st.released = false;
    assert.equal((projectState(st, null) as any).link.state, 'connecting');
  });

  test('a nudge turns the screen angle and speed into the Seestar joystick move, then stops it', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      const r = await post({ action: 'nudge', angle: 0, speed: 0.5, ms: 400 });
      assert.equal(r.status, 200);
      // screen 0 (up) is the Seestar's 90; half speed of 1500; the Seestar moves for whole seconds
      assert.deepEqual(stub.calls[0], ['nudge', 90, 750, 1]);
      assert.equal(stub.calls[1][0], 'stopMotion');
    });
  });

  test('focus, exposure and gain map onto the Seestar commands', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      assert.equal((await post({ action: 'focus', direction: 'near', steps: 20 })).status, 200);
      assert.equal((await post({ action: 'setting', setting: 'exposure', value: '10' })).status, 200);
      assert.equal((await post({ action: 'setting', setting: 'gain', value: 80 })).status, 200);
      assert.deepEqual(stub.calls, [
        ['focusBy', -20],
        ['setExposure', { stackMs: 10_000, continuousMs: 10_000 }],
        ['setGain', 80],
      ]);
    });
  });

  test('a control the Seestar has no equivalent of is refused with 501 and the reason, and nothing is sent', async () => {
    const { stub, web } = make();
    await withControl(web, async (post) => {
      for (const action of ['photo', 'record', 'level', 'rgb']) {
        const r = await post({ action });
        assert.equal(r.status, 501, action);
        assert.match(String(r.body.error), /not available on the ZWO Seestar/);
      }
      const af = await post({ action: 'autofocus', mode: 'astro' });
      assert.equal(af.status, 501);
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
      assert.match(events[0], /GoTo to Jupiter/);
    });
  });

  test('the Dwarf and the Seestar serve the same UI: the Dwarf can do everything, the Seestar says what it cannot', () => {
    const { web } = make();
    const dwarf = dwarfWeb({ state: { fov: {} } } as never, {} as never);
    for (const [k, v] of Object.entries(dwarf.capabilities)) if (k !== 'video') assert.equal(v, true, k);
    assert.deepEqual(Object.keys(web.capabilities).sort(), Object.keys(dwarf.capabilities).sort());
    assert.deepEqual(web.capabilities.video, ['tele', 'wide', 'stack']);
    web.hub.shutdown();
  });
});
