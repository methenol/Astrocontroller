import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { altAz } from '../astro/sky.js';
import { horizonFor } from '../astro/horizon.js';
import { clearsAt, nightStartAt, recordBlocked, sightingLimit, sightingsFor, withSightings } from '../astro/sightings.js';

const SITE = { lat: 34.05, lon: -118.25, elev: 100 };
const NOW = new Date('2026-10-12T05:00:00Z');

const savedData = config.paths.data;
let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sightings-'));
  config.paths.data = dir;
});
after(() => {
  config.paths.data = savedData;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('blocked views', () => {
  test('a sighting raises the horizon at its azimuth only, just above the blocked altitude', () => {
    const s = [{ at: NOW.toISOString(), site: SITE, target: 'x', azimuth: 120, altitude: 30, reason: '' }];
    assert.ok(sightingLimit(s, 120) > 30, 'what was blocked stays blocked');
    assert.ok(sightingLimit(s, 121) > 30, 'across the frame');
    assert.equal(sightingLimit(s, 140), 0, 'twenty degrees round is another patch of sky');
    const h = withSightings({ limit: () => 10, summary: 'map' }, s)!;
    assert.equal(h.limit(200), 10, 'the map still holds elsewhere');
    assert.match(h.summary, /1 blocked view/);
  });

  test('it is kept for the night, at this site, and not the next', () => {
    recordBlocked(SITE, 'ngc 7000', 60, 35, 'only 3 stars', NOW);
    assert.equal(sightingsFor(SITE, new Date(NOW.getTime() + 3600e3)).length, 1);
    assert.equal(sightingsFor({ lat: SITE.lat + 1, lon: SITE.lon }, NOW).length, 0, 'another site');
    assert.equal(sightingsFor(SITE, new Date(NOW.getTime() + 24 * 3600e3)).length, 0, 'gone by the next night');
    assert.ok(horizonFor(SITE, NOW)!.limit(60) > 35, 'the planner horizon carries it');
  });

  test("last night's sightings do not reach tonight's plan, even when it is solved by day", () => {
    // Florida (UTC−5): a view blocked at 00:28 local, the plan solved again at 12:20 local the same day
    const FL = { lat: 28.8, lon: -81.7 };
    const seen = new Date('2026-11-07T05:28:00Z');
    recordBlocked(FL, 'Mel 22', 113.7, 79.5, 'blurred', seen);
    assert.equal(sightingsFor(FL, new Date('2026-11-07T06:30:00Z')).length, 1, 'the rest of that night keeps it');
    assert.equal(sightingsFor(FL, new Date('2026-11-07T14:00:00Z')).length, 1, 'early morning is still that night');
    assert.equal(sightingsFor(FL, new Date('2026-11-07T17:20:00Z')).length, 0, 'the 12:20 re-solve plans tonight: gone');
    assert.equal(sightingsFor(FL, new Date('2026-11-08T00:30:00Z')).length, 0, 'and not at dusk either');
  });

  test('the night starts mid-morning, local solar time', () => {
    // 10:00 solar time in Florida is about 15:27 UTC
    const start = new Date(nightStartAt(-81.7, new Date('2026-11-08T03:00:00Z')));
    assert.equal(start.toISOString().slice(0, 16), '2026-11-07T15:26');
    assert.equal(nightStartAt(-81.7, new Date('2026-11-07T15:00:00Z')), start.getTime() - 24 * 3600e3, 'before it belongs to the night before');
  });

  test('a rising target blocked now is clear later, and the time is given', () => {
    // Vega low in the north-east, rising: block where it is now
    const ra = 18.6156;
    const dec = 38.78;
    const from = new Date('2026-06-01T04:00:00Z');
    const aa = altAz(SITE, ra, dec, from);
    const h = withSightings(undefined, [{ at: from.toISOString(), site: SITE, target: 'vega', azimuth: aa.azimuth, altitude: aa.altitude, reason: '' }]);
    const until = new Date(from.getTime() + 8 * 3600e3);
    const clear = clearsAt(SITE, ra, dec, 0, h, from, until);
    assert.ok(clear && clear > from, 'not clear now, clear later');
    assert.equal(clearsAt(SITE, ra, dec, 0, undefined, from, until)?.getTime(), from.getTime(), 'with nothing in the way it is clear at once');
  });
});
