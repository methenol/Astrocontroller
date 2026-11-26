import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dewRisk, DEW_AUTO_SPREAD_C } from '../astro/weather/dew.js';
import type { HourForecast } from '../astro/weather/score.js';
import type { Forecast } from '../astro/weather/service.js';
import { DewAuto } from '../web/dew-auto.js';
import { dwarfParked } from '../drivers/dwarf/web.js';
import { controlRoutes } from '../web/routes/control.js';
import { jsonErrors } from '../web/http.js';
import type { WebContext } from '../web/context.js';
import type { SwitchView, WebTelescope } from '../web/telescope.js';

const NOW = Date.UTC(2026, 10, 26, 22, 20); // 22:20 UTC
const HOUR = 3600e3;
const top = (i: number) => new Date(Math.floor(NOW / HOUR) * HOUR + i * HOUR);

/** hourly samples from the top of the hour under way; `at` overrides the dry defaults per index */
function hours(at: Record<number, Partial<HourForecast>> = {}): HourForecast[] {
  return Array.from({ length: 6 }, (_, i) => {
    const t = top(i - 1);
    return { time: t.toISOString(), local: `${t.getUTCHours()}:00`, dewSpreadC: 10, humidity: 50, weatherCode: 0, ...at[i - 1] } as HourForecast;
  });
}
const dryNow = { temperatureC: 10, dewPointC: 0, humidity: 50, at: null };

describe('dew risk: the current and next hour', () => {
  test('dry air with a wide spread is no risk', () => {
    const r = dewRisk(hours(), dryNow, NOW);
    assert.equal(r.risk, false, r.reason);
  });

  test('a spread within the Auto threshold in the next hour is a risk', () => {
    const r = dewRisk(hours({ 2: { dewSpreadC: DEW_AUTO_SPREAD_C - 0.5 } }), dryNow, NOW);
    assert.equal(r.risk, true);
    assert.match(r.reason, /spread/);
  });

  test("the score's 'dew likely' (3 °C) is not the bar: 4 °C still counts", () => {
    assert.equal(dewRisk(hours({ 1: { dewSpreadC: 4 } }), dryNow, NOW).risk, true);
  });

  test('high humidity alone, fog alone, or the current conditions alone are each a risk', () => {
    assert.equal(dewRisk(hours({ 0: { humidity: 90 } }), dryNow, NOW).risk, true);
    assert.equal(dewRisk(hours({ 1: { weatherCode: 45 } }), dryNow, NOW).risk, true);
    assert.equal(dewRisk(hours(), { temperatureC: 5, dewPointC: 3, humidity: 70, at: null }, NOW).risk, true);
  });

  test('a risk beyond the next hour does not count', () => {
    assert.equal(dewRisk(hours({ 3: { dewSpreadC: 0 } }), dryNow, NOW).risk, false);
  });

  test('a forecast without the hours for now is a risk (not knowing is no reason to leave it off)', () => {
    assert.equal(dewRisk([], dryNow, NOW).risk, true);
  });
});

/** A telescope with only a dew heater, recording the sets. */
class StubScope extends EventEmitter {
  state = { connected: true, released: false };
  capabilities = { switches: true } as WebTelescope['capabilities'];
  label = 'Test scope';
  heater: boolean | null = false;
  sets: boolean[] = [];
  fail = false;
  /** a Starfront roof: undefined = none; null = mode on, status unknown */
  roofState: boolean | null | undefined = undefined;
  roofFns = new Set<() => void>();
  /** what parked() answers: undefined = the driver has no parked state */
  parkedState: boolean | null | undefined = undefined;
  get parked() {
    return this.parkedState === undefined ? undefined : () => this.parkedState ?? null;
  }
  park(p: boolean) {
    this.parkedState = p;
    this.emit('state', this.state);
  }
  get roof() {
    if (this.roofState === undefined) return undefined;
    return {
      open: () => this.roofState ?? null,
      onChange: (fn: () => void) => {
        this.roofFns.add(fn);
        return () => void this.roofFns.delete(fn);
      },
    };
  }
  reportRoof(open: boolean | null) {
    this.roofState = open;
    for (const fn of this.roofFns) fn();
  }
  private view = (): SwitchView[] => [{ id: 'lens_defog', label: 'Dew heater', hint: '', on: this.heater }];
  switches = {
    list: async () => this.view(),
    set: async (_id: string, on: boolean) => {
      if (this.fail) throw new Error('no answer');
      this.sets.push(on);
      this.heater = on;
      return { result: `Dew heater ${on ? 'on' : 'off'}`, switches: this.view() };
    },
  };
}

const SITE = { lat: 45, lon: -122, elev: 0 };
const forecastOf = (h: HourForecast[]) => async () => ({ hours: h, current: dryNow }) as unknown as Forecast;

function make(o: { h?: HourForecast[]; forecast?: () => Promise<Forecast>; file?: string; events?: string[]; roof?: boolean | null } = {}) {
  const scope = new StubScope();
  scope.roofState = o.roof;
  const dew = new DewAuto({
    scope: scope as unknown as WebTelescope,
    site: () => SITE,
    tz: () => 'UTC',
    forecast: o.forecast ?? forecastOf(o.h ?? hours()),
    file: o.file,
    event: (t) => o.events?.push(t),
    now: () => NOW,
  });
  return { scope, dew };
}

describe('dew heater Auto', () => {
  test('defaults to on, and turns the heater on when dew is possible', async () => {
    const events: string[] = [];
    const { scope, dew } = make({ h: hours({ 1: { humidity: 95 } }), events });
    assert.equal(dew.auto, true);
    const s = await dew.check();
    dew.close();
    assert.deepEqual(scope.sets, [true]);
    assert.equal(s.hold, true);
    assert.ok(s.lastTurnedOn);
    assert.match(events[0] ?? '', /dew heater on/);
  });

  test('a heater already on is left alone; and with no risk Auto never turns it off', async () => {
    const a = make({ h: hours({ 0: { dewSpreadC: 1 } }) });
    a.scope.heater = true;
    await a.dew.check();
    a.dew.close();
    assert.deepEqual(a.scope.sets, []);
    const b = make();
    b.scope.heater = true;
    const s = await b.dew.check();
    b.dew.close();
    assert.equal(s.hold, null);
    assert.deepEqual(b.scope.sets, []);
  });

  test('an unknown heater state counts as off', async () => {
    const { scope, dew } = make({ h: hours({ 0: { dewSpreadC: 1 } }) });
    scope.heater = null;
    await dew.check();
    dew.close();
    assert.deepEqual(scope.sets, [true]);
  });

  test('a forecast that fails turns the heater on to be safe', async () => {
    const { scope, dew } = make({ forecast: async () => Promise.reject(new Error('offline')) });
    const s = await dew.check();
    dew.close();
    assert.equal(s.hold, true);
    assert.match(s.reason ?? '', /unavailable/);
    assert.deepEqual(scope.sets, [true]);
  });

  test('Auto off does nothing; a disconnected telescope is left until it connects', async () => {
    const off = make({ h: hours({ 0: { dewSpreadC: 1 } }) });
    await off.dew.setAuto(false);
    off.dew.close();
    assert.deepEqual(off.scope.sets, []);

    const { scope, dew } = make({ h: hours({ 0: { dewSpreadC: 1 } }) });
    scope.state.connected = false;
    dew.start();
    await dew.check();
    assert.deepEqual(scope.sets, []);
    scope.state.connected = true;
    scope.emit('state', scope.state);
    await dew.check();
    dew.close();
    assert.deepEqual(scope.sets, [true]);
  });

  test('a failed set is reported, not thrown', async () => {
    const { scope, dew } = make({ h: hours({ 0: { dewSpreadC: 1 } }) });
    scope.fail = true;
    const s = await dew.check();
    dew.close();
    assert.match(s.lastError ?? '', /could not turn the dew heater on/);
  });

  test('the Auto setting persists; a missing file means on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dew-auto-'));
    const file = path.join(dir, 'dew-auto.json');
    try {
      const a = make({ file });
      assert.equal(a.dew.auto, true);
      await a.dew.setAuto(false);
      a.dew.close();
      assert.equal(make({ file }).dew.auto, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dew heater Auto under a Starfront roof', () => {
  test('roof open: on, even with no dew in the forecast', async () => {
    const { scope, dew } = make({ roof: true });
    const s = await dew.check();
    dew.close();
    assert.equal(s.source, 'roof');
    assert.equal(s.hold, true);
    assert.deepEqual(scope.sets, [true]);
  });

  test('roof closed: off, even with dew in the forecast', async () => {
    const events: string[] = [];
    const { scope, dew } = make({ roof: false, h: hours({ 0: { dewSpreadC: 0 } }), events });
    scope.heater = true;
    const s = await dew.check();
    dew.close();
    assert.equal(s.hold, false);
    assert.deepEqual(scope.sets, [false]);
    assert.ok(s.lastTurnedOff);
    assert.match(events[0] ?? '', /dew heater off .*roof is closed/);
  });

  test('the roof opening and closing switches it at once', async () => {
    const { scope, dew } = make({ roof: false });
    dew.start();
    await dew.check();
    scope.reportRoof(true);
    await dew.check();
    assert.equal(scope.heater, true);
    scope.reportRoof(false);
    await dew.check();
    dew.close();
    assert.equal(scope.heater, false);
    assert.deepEqual(scope.sets, [true, false]);
  });

  test('a roof report that changes nothing does not check again', async () => {
    const { scope, dew } = make({ roof: true });
    scope.heater = true;
    dew.start();
    await dew.check();
    let checks = 0;
    dew.on('state', () => checks++);
    scope.reportRoof(true);
    await new Promise((r) => setImmediate(r));
    dew.close();
    assert.equal(checks, 0);
  });

  test('roof status unknown (or the mode off): the forecast decides', async () => {
    const { scope, dew } = make({ roof: null, h: hours({ 0: { dewSpreadC: 1 } }) });
    const s = await dew.check();
    dew.close();
    assert.equal(s.source, 'forecast');
    assert.deepEqual(scope.sets, [true]);
  });

  test('Auto off leaves the heater to the user under the roof too', async () => {
    const { scope, dew } = make({ roof: false });
    scope.heater = true;
    await dew.setAuto(false);
    dew.close();
    assert.deepEqual(scope.sets, []);
  });
});

describe('dew heater Auto and parking', () => {
  test('parking turns the heater off, even with dew possible; unparking turns it back on', async () => {
    const { scope, dew } = make({ h: hours({ 0: { dewSpreadC: 1 } }) });
    scope.parkedState = false;
    dew.start();
    await dew.check();
    assert.equal(scope.heater, true);
    scope.park(true);
    const parked = await dew.check();
    assert.equal(parked.source, 'parked');
    assert.equal(scope.heater, false);
    scope.park(false);
    await dew.check();
    dew.close();
    assert.equal(scope.heater, true);
    assert.deepEqual(scope.sets, [true, false, true]);
  });

  test('unparked with no dew risk: the heater stays off', async () => {
    const { scope, dew } = make();
    scope.parkedState = true;
    scope.heater = true;
    dew.start();
    await dew.check();
    scope.park(false);
    await dew.check();
    dew.close();
    assert.deepEqual(scope.sets, [false]);
  });

  test('Starfront: an open roof keeps the heater on through a park', async () => {
    const { scope, dew } = make({ roof: true });
    scope.parkedState = false;
    dew.start();
    await dew.check();
    scope.park(true);
    const s = await dew.check();
    dew.close();
    assert.equal(s.source, 'roof');
    assert.equal(scope.heater, true);
    assert.deepEqual(scope.sets, [true]);
  });

  test('state reports that change neither the park nor the link do not check again', async () => {
    const { scope, dew } = make({ roof: true });
    scope.parkedState = true;
    scope.heater = true;
    dew.start();
    await dew.check();
    let checks = 0;
    dew.on('state', () => checks++);
    scope.emit('state', scope.state);
    await new Promise((r) => setImmediate(r));
    dew.close();
    assert.equal(checks, 0);
  });

  test('parked: On is refused while Auto holds the heater off', async () => {
    const { scope, dew } = make();
    scope.parkedState = true;
    await dew.check();
    assert.equal(dew.holds()?.hold, false);
  });
});

describe('dew heater Auto in the control route', () => {
  async function withApp(dew: DewAuto, scope: StubScope, fn: (post: (p: string, b: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
    const ctx = { scope, duty: { event: () => undefined } } as unknown as WebContext;
    const app = express();
    app.use(express.json());
    app.use('/api', controlRoutes(ctx, dew));
    app.use(jsonErrors);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      await fn(async (p, b) => {
        const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
        return { status: res.status, body: await res.json() };
      });
    } finally {
      dew.close();
      await new Promise((r) => server.close(r));
    }
  }

  test('Off is refused while Auto holds the heater on, and allowed once Auto is off', async () => {
    const { scope, dew } = make({ h: hours({ 0: { dewSpreadC: 1 } }) });
    await dew.check();
    await withApp(dew, scope, async (post) => {
      const refused = await post('/control', { action: 'switch', id: 'lens_defog', on: false });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /turn Auto off first/);
      const s = await post('/dew-auto', { auto: false });
      assert.equal(s.body.auto, false);
      const ok = await post('/control', { action: 'switch', id: 'lens_defog', on: false });
      assert.equal(ok.status, 200);
      assert.equal(scope.heater, false);
    });
  });

  test('roof closed: On is refused while Auto holds the heater off', async () => {
    const { scope, dew } = make({ roof: false });
    await dew.check();
    await withApp(dew, scope, async (post) => {
      const refused = await post('/control', { action: 'switch', id: 'lens_defog', on: true });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /keeping the dew heater off/);
      assert.equal((await post('/control', { action: 'switch', id: 'lens_defog', on: false })).status, 200);
    });
  });

  test('with no dew risk, Off is allowed with Auto on', async () => {
    const { scope, dew } = make();
    scope.heater = true;
    await dew.check();
    await withApp(dew, scope, async (post) => {
      const ok = await post('/control', { action: 'switch', id: 'lens_defog', on: false });
      assert.equal(ok.status, 200);
    });
  });
});

describe('the Dwarf parked, from its pose', () => {
  const st = (pitchDeg: number | undefined, o: { homed?: boolean; tracking?: string; connected?: boolean } = {}) =>
    ({ connected: o.connected ?? true, motors: { pitchDeg, homed: o.homed ?? true }, tracking: { state: o.tracking ?? 'idle' } }) as Parameters<typeof dwarfParked>[0];
  test('the park pitch is parked; pointing up, or tracking, is not; unread or unhomed is unknown', () => {
    assert.equal(dwarfParked(st(2.5)), true);
    assert.equal(dwarfParked(st(4)), true);
    assert.equal(dwarfParked(st(45)), false);
    assert.equal(dwarfParked(st(2.5, { tracking: 'running' })), false);
    assert.equal(dwarfParked(st(undefined)), null);
    assert.equal(dwarfParked(st(2.5, { homed: false })), null);
    assert.equal(dwarfParked(st(2.5, { connected: false })), null);
  });
});
