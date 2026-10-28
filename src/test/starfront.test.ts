import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, type ObserverLocation } from '../config.js';
import * as sky from '../astro/sky.js';
import { NIGHT_OBJECTIVE, StarfrontNights, type Roof } from '../agent/starfront.js';

const SITE = { lat: 31.5475, lon: -99.3817, elev: 400 } as ObserverLocation;
// a night at Starfront: its sunset, darkness and the next morning
const NOON = new Date('2026-10-28T17:00:00Z').getTime();
const W = sky.nightWindow(SITE, new Date(NOON));
const AFTER_SUNSET = W.sunset!.getTime() + 10 * 60_000;
const DARK = W.astroDusk!.getTime() + 30 * 60_000;
const NIGHT_KEY = sky.localDate(W.sunset!, config.observer.timezone);
const CHECK_AT = sky.parseLocal(`${NIGHT_KEY}T19:00`, config.observer.timezone).getTime();

function roofs(open: Record<number, boolean>): Roof[] {
  return Array.from({ length: 16 }, (_, i) => ({ device_number: i + 1, name: `Building ${i + 1}`, is_open: !!open[i + 1] }));
}

function rig(o: { building?: number; dutyStatus?: 'off' | 'active' } = {}) {
  let t = NOON;
  let roof = roofs({});
  const starts: Array<{ objective: string; until?: string }> = [];
  const events: string[] = [];
  let dutyStatus = o.dutyStatus ?? 'off';
  const listeners = new Set<() => void>();
  let stack = { stacking: false, target: undefined as string | undefined };
  const transfers: string[] = [];
  const nights = new StarfrontNights({
    duty: {
      start: ((s: { objective: string; until?: string }) => {
        starts.push(s);
        dutyStatus = 'active';
        return {} as never;
      }) as never,
      event: (text: string) => void events.push(text),
      status: (() => ({ status: dutyStatus, objective: 'the user\'s own' })) as never,
    },
    site: () => SITE,
    fetchRoofs: async () => roof,
    now: () => t,
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'starfront-')), 'starfront.json'),
    building: o.building ?? 0,
    checkTime: '19:00',
    stacking: { on: (_e, f) => void listeners.add(f), off: (_e, f) => void listeners.delete(f), current: () => stack },
    transferTarget: async (target) => {
      transfers.push(target);
      return 'queued';
    },
  });
  return {
    nights,
    starts,
    events,
    transfers,
    at: (ms: number) => (t = ms),
    roof: (open: Record<number, boolean>) => (roof = roofs(open)),
    stackOn: (target: string | undefined, stacking = true) => {
      stack = { stacking, target };
      for (const f of listeners) f();
    },
    endDuty: () => (dutyStatus = 'off'),
  };
}

describe('autonomous Starfront nights', () => {
  test('off: nothing happens, whatever the roof does', async () => {
    const r = rig({ building: 6 });
    r.roof({ 6: true });
    r.at(DARK);
    await r.nights.tick();
    assert.deepEqual(r.starts, []);
    assert.equal(r.nights.status().phase, 'off');
  });

  test('the roof of its building opening after sunset starts one duty until dawn; other roofs do not', async () => {
    const r = rig({ building: 6 });
    r.nights.setEnabled(true);
    r.roof({ 6: true });
    r.at(NOON);
    await r.nights.tick();
    assert.equal(r.starts.length, 0, 'not in daylight');
    r.roof({ 3: true });
    r.at(AFTER_SUNSET);
    await r.nights.tick();
    assert.equal(r.starts.length, 0, 'another building opening is not ours');
    r.roof({ 3: true, 6: true });
    await r.nights.tick();
    assert.equal(r.starts.length, 1);
    assert.equal(r.starts[0].until, 'dawn');
    assert.equal(r.starts[0].objective, NIGHT_OBJECTIVE);
    r.at(DARK);
    await r.nights.tick();
    assert.equal(r.starts.length, 1, 'once a night');
    assert.equal(r.nights.status().tonight.engagedBy, 'the roof of building 6 opened');
  });

  test('the roof closing and reopening during the night is told to the agent at once', async () => {
    const r = rig({ building: 6 });
    r.nights.setEnabled(true);
    r.roof({ 6: true });
    r.at(DARK);
    await r.nights.tick();
    r.roof({});
    await r.nights.tick();
    assert.ok(r.events.some((e) => /CLOSING: stop_stacking and park NOW/.test(e)), r.events.join('\n'));
    r.roof({ 6: true });
    await r.nights.tick();
    assert.ok(r.events.some((e) => /REOPENED/.test(e)));
  });

  test('a roof still closed at 19:00 is checked with the telescope once; open starts the night', async () => {
    const r = rig({ building: 6 });
    r.nights.setEnabled(true);
    // in daylight nothing is checked, whatever the clock says
    r.at(W.sunset!.getTime() - 60_000);
    await r.nights.tick();
    assert.equal(r.events.length, 0, 'not before the night');
    r.at(Math.max(CHECK_AT, AFTER_SUNSET) + 60_000);
    await r.nights.tick();
    await r.nights.tick();
    assert.equal(r.events.filter((e) => /roof check/.test(e)).length, 1);
    assert.equal(r.starts.length, 0);
    r.nights.report(true);
    assert.equal(r.starts.length, 1);
    assert.equal(r.nights.status().tonight.checkResult, 'open');
  });

  test("a user's own duty is never replaced", async () => {
    const r = rig({ building: 6, dutyStatus: 'active' });
    r.nights.setEnabled(true);
    r.roof({ 6: true });
    r.at(DARK);
    await r.nights.tick();
    assert.deepEqual(r.starts, []);
    assert.match(String(r.nights.status().tonight.engagedBy), /not started: a duty was already active/);
  });

  test('without a building: any roof wakes it, and the telescope checks narrow down which roof is the scope\'s', async () => {
    const r = rig();
    r.nights.setEnabled(true);
    r.roof({ 2: true, 6: true, 9: true });
    r.at(DARK);
    await r.nights.tick();
    assert.equal(r.starts.length, 1);
    r.nights.report(true);
    assert.deepEqual(r.nights.status().candidates, [2, 6, 9]);
    r.roof({ 6: true });
    await r.nights.tick();
    r.nights.report(true);
    assert.equal(r.nights.status().building, 6);
  });

  test('when the next target starts stacking, the previous one is transferred', async () => {
    const r = rig({ building: 6 });
    r.nights.setEnabled(true);
    r.nights.start();
    r.stackOn('M 31');
    r.stackOn('M 31', false);
    r.stackOn('M 31');
    assert.deepEqual(r.transfers, [], 'the same target again is not a new one');
    r.stackOn('M 31', false);
    r.stackOn('IC 434');
    r.nights.stop();
    assert.deepEqual(r.transfers, ['M 31']);
  });
});
