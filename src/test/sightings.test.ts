import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { altAz } from '../astro/sky.js';
import { horizonFor } from '../astro/horizon.js';
import { clearsAt, nightBeganAt, raisedBy, recordBlocked, sightingLimit, sightingsFor } from '../astro/sightings.js';

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
  test("a sighting raises its own target's limit at its azimuth only, just above the blocked altitude", () => {
    const s = [{ at: NOW.toISOString(), site: SITE, target: 'x', azimuth: 120, altitude: 30, reason: '' }];
    assert.ok(sightingLimit(s, 120) > 30, 'what was blocked stays blocked');
    assert.ok(sightingLimit(s, 121) > 30, 'across the frame');
    assert.equal(sightingLimit(s, 140), 0, 'twenty degrees round is another patch of sky');
    const h = raisedBy({ limit: () => 10, summary: 'map' }, s);
    assert.equal(h.limit(200), 10, 'the map still holds elsewhere');
    assert.ok(h.limit(120) > 30);
  });

  test('it is kept for the night, at this site, and not the next', () => {
    recordBlocked(SITE, 'ngc 7000', 60, 35, 'only 3 stars', NOW);
    assert.equal(sightingsFor(SITE, new Date(NOW.getTime() + 3600e3)).length, 1);
    assert.equal(sightingsFor({ lat: SITE.lat + 1, lon: SITE.lon }, NOW).length, 0, 'another site');
    assert.equal(sightingsFor(SITE, new Date(NOW.getTime() + 24 * 3600e3)).length, 0, 'gone by the next night');
    assert.equal(horizonFor(SITE), undefined, "the planner's horizon is the obstruction map alone: a blocked view does not change it");
  });

  test("last night's sightings do not reach tonight's plan, even when it is solved by day", () => {
    // Florida (UTC−5): a view blocked at 00:28 local, the plan solved again at 12:20 local the same day
    const FL = { lat: 28.8, lon: -81.7 };
    const seen = new Date('2026-11-07T05:28:00Z');
    recordBlocked(FL, 'Mel 22', 113.7, 79.5, 'blurred', seen);
    assert.equal(sightingsFor(FL, new Date('2026-11-07T06:30:00Z')).length, 1, 'the rest of that night keeps it');
    assert.equal(sightingsFor(FL, new Date('2026-11-07T14:00:00Z')).length, 0, '09:00, after dawn: the plan is for tonight, gone');
    assert.equal(sightingsFor(FL, new Date('2026-11-07T17:20:00Z')).length, 0, 'the 12:20 re-solve plans tonight: gone');
    assert.equal(sightingsFor(FL, new Date('2026-11-08T00:30:00Z')).length, 0, 'and not at dusk either');
  });

  test('a plan for tonight solved at dawn does not carry the night just ending', () => {
    // 2026-11-15: views blocked 20:45–01:58 local; tonight's plan solved at 06:53, after the darkness ended
    const FL = { lat: 28.8, lon: -81.7 };
    recordBlocked(FL, 'IC 353', 78, 37, 'blurred', new Date('2026-11-15T01:45:00Z'));
    recordBlocked(FL, 'SNR G180.0-01.7', 96, 83, 'blurred', new Date('2026-11-15T06:58:00Z'));
    assert.equal(sightingsFor(FL, new Date('2026-11-15T10:00:00Z')).length, 2, '05:00, still dark: that night keeps them');
    assert.equal(sightingsFor(FL, new Date('2026-11-15T11:53:00Z')).length, 0, '06:53, the plan is for tonight: none');
    recordBlocked(FL, 'IC 353', 60, 40, 'blurred', new Date('2026-11-16T01:00:00Z'));
    assert.equal(sightingsFor(FL, new Date('2026-11-16T02:00:00Z')).length, 1, "tonight's own view counts, last night's do not");
  });

  test("a night begins at the planner's sunset", () => {
    const FL = { lat: 28.8, lon: -81.7 };
    const began = new Date(nightBeganAt(FL, new Date('2026-11-16T03:00:00Z')));
    assert.ok(began.toISOString() > '2026-11-15T22:00' && began.toISOString() < '2026-11-15T23:00', `the evening's sunset (got ${began.toISOString()})`);
    assert.ok(nightBeganAt(FL, new Date('2026-11-15T11:53:00Z')) > Date.parse('2026-11-15T11:53:00Z'), 'after dawn the night in force is still to come');
  });

  test('a rising target blocked now is clear later, and the time is given', () => {
    // Vega low in the north-east, rising: block where it is now
    const ra = 18.6156;
    const dec = 38.78;
    const from = new Date('2026-06-01T04:00:00Z');
    const aa = altAz(SITE, ra, dec, from);
    const h = raisedBy(undefined, [{ at: from.toISOString(), site: SITE, target: 'vega', azimuth: aa.azimuth, altitude: aa.altitude, reason: '' }]);
    const until = new Date(from.getTime() + 8 * 3600e3);
    const clear = clearsAt(SITE, ra, dec, 0, h, from, until);
    assert.ok(clear && clear > from, 'not clear now, clear later');
    assert.equal(clearsAt(SITE, ra, dec, 0, undefined, from, until)?.getTime(), from.getTime(), 'with nothing in the way it is clear at once');
  });
});
