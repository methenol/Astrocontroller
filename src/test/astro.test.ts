import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocal, hoursToHms, degToDms, bodyInfo, nightWindow, visibility } from '../astro/sky.js';
import { zonedWallTimeToInstant } from '../util/time.js';
import { parseRow, findObject, searchObjects, catalog } from '../astro/catalog.js';
import { planNight } from '../astro/planner.js';
import { queryCatalog } from '../astro/catalog-search.js';

const LA = 'America/Los_Angeles';
const SITE = { lat: 45.5, lon: -122.6, elev: 50 };
const wall = (s: string) => Date.parse(`${s}Z`);

describe('time zones', () => {
  test('wall times resolve with the offset in force at that instant, across DST changes', () => {
    assert.equal(new Date(zonedWallTimeToInstant(wall('2026-10-12T21:00:00'), LA)).toISOString(), '2026-10-13T04:00:00.000Z');
    assert.equal(new Date(zonedWallTimeToInstant(wall('2026-12-12T21:00:00'), LA)).toISOString(), '2026-12-13T05:00:00.000Z');
    // just after the autumn change (2026-11-01 09:00Z): PST, although the naive guess lands in PDT
    assert.equal(new Date(zonedWallTimeToInstant(wall('2026-11-01T08:30:00'), LA)).toISOString(), '2026-11-01T16:30:00.000Z');
    // the repeated hour: its first occurrence (PDT)
    assert.equal(new Date(zonedWallTimeToInstant(wall('2026-11-01T01:30:00'), LA)).toISOString(), '2026-11-01T08:30:00.000Z');
    // the skipped hour (2026-03-08 02:30 does not exist): an hour later, 03:30 PDT
    assert.equal(new Date(zonedWallTimeToInstant(wall('2026-03-08T02:30:00'), LA)).toISOString(), '2026-03-08T10:30:00.000Z');
    assert.equal(zonedWallTimeToInstant(wall('2026-10-12T21:00:00'), 'Not/AZone'), wall('2026-10-12T21:00:00'));
  });

  test('east of Greenwich too: the skipped hour lands after the gap, the repeated hour on its first occurrence', () => {
    const at = (s: string, tz: string) => new Date(zonedWallTimeToInstant(wall(s), tz)).toISOString();
    // Berlin: 2026-03-29 02:00 CET → 03:00 CEST; 02:30 does not exist → 03:30 CEST
    assert.equal(at('2026-03-29T02:30:00', 'Europe/Berlin'), '2026-03-29T01:30:00.000Z');
    // Berlin: 2026-10-25 03:00 CEST → 02:00 CET; 02:30 happens twice → the CEST one
    assert.equal(at('2026-10-25T02:30:00', 'Europe/Berlin'), '2026-10-25T00:30:00.000Z');
    assert.equal(at('2026-10-25T03:30:00', 'Europe/Berlin'), '2026-10-25T02:30:00.000Z');
    // Sydney: 2026-10-04 02:00 AEST → 03:00 AEDT; 2026-04-05 03:00 AEDT → 02:00 AEST
    assert.equal(at('2026-10-04T02:30:00', 'Australia/Sydney'), '2026-10-03T16:30:00.000Z');
    assert.equal(at('2026-04-05T02:30:00', 'Australia/Sydney'), '2026-04-04T15:30:00.000Z');
    // a half-hour zone with no DST
    assert.equal(at('2026-10-12T21:00:00', 'Asia/Kolkata'), '2026-10-12T15:30:00.000Z');
  });

  test('parseLocal: dates mean local noon, zoned strings are absolute, bad input throws', () => {
    assert.equal(parseLocal('2026-10-12', LA).toISOString(), '2026-10-12T19:00:00.000Z');
    assert.equal(parseLocal('2026-10-12 21:30', LA).toISOString(), '2026-10-13T04:30:00.000Z');
    assert.equal(parseLocal('2026-10-12T21:30:00Z', LA).toISOString(), '2026-10-12T21:30:00.000Z');
    assert.equal(parseLocal('2026-10-12T21:30-0700', LA).toISOString(), '2026-10-13T04:30:00.000Z');
    assert.throws(() => parseLocal('tonight', LA), /cannot parse/);
    assert.throws(() => parseLocal('2026-13-45T99:99Z', LA), /cannot parse/);
    assert.throws(() => parseLocal('2026-02-30T10:00', LA), /cannot parse/);
  });
});

describe('sexagesimal formatting', () => {
  test('rounding carries instead of printing 60', () => {
    assert.equal(hoursToHms(0.712263), '00h42m44.1s');
    assert.equal(hoursToHms(1 - 0.01 / 3600), '01h00m00.0s');
    assert.equal(hoursToHms(24 - 0.01 / 3600), '00h00m00.0s');
    assert.equal(hoursToHms(-1), '23h00m00.0s');
    assert.equal(degToDms(41.26875), "+41°16'08\"");
    assert.equal(degToDms(10 - 0.4 / 3600), "+10°00'00\"");
    assert.equal(degToDms(-0.5), "-00°30'00\"");
  });
});

describe('ephemeris', () => {
  test('a night under way for more than 14 hours is still reported as the current night', () => {
    // 60°N at the winter solstice: the Sun set about 15 hours before 05:00Z and astronomical dawn is still ahead
    const site = { lat: 60, lon: 10, elev: 0 };
    const when = new Date('2026-12-21T05:00:00Z');
    const w = nightWindow(site, when);
    assert.ok(w.sunset && w.sunset < when, `sunset ${w.sunset?.toISOString()} is the evening before`);
    assert.ok(w.darkStart && w.darkStart < when && w.darkEnd && w.darkEnd > when, 'now is inside the reported window');
  });

  test('evening twilight reports today’s sunset; morning twilight after dawn reports the coming night', () => {
    const site = { lat: 45, lon: 0, elev: 0 };
    // 2026-10-12 at 45°N, 0°: sunset ≈ 17:20Z, astronomical dusk ≈ 18:58Z, astronomical dawn ≈ 04:35Z
    const evening = new Date('2026-10-12T17:50:00Z');
    const e = nightWindow(site, evening);
    assert.ok(e.sunset && e.sunset < evening && evening.getTime() - e.sunset.getTime() < 3600e3, `sunset ${e.sunset?.toISOString()} is today's`);
    assert.ok(e.darkStart && e.darkStart > evening);
    const morning = new Date('2026-10-13T05:40:00Z');
    const m = nightWindow(site, morning);
    assert.ok(m.darkEnd && m.darkEnd > morning, `dawn ${m.darkEnd?.toISOString()} is ahead, not the one that passed`);
    assert.ok(m.darkStart && m.darkStart > morning, 'the window is the coming night');
  });

  test('the night after the season without astronomical darkness is not paired with the next night\'s darkness', () => {
    // 52.5°N on 2026-07-24: no -18° dusk that night (the first comes the next night, at 23:05Z)
    const site = { lat: 52.5, lon: 13.4, elev: 50 };
    const w = nightWindow(site, new Date('2026-07-24T12:00:00Z'));
    assert.equal(w.astroDusk, null);
    assert.ok(w.sunset && w.sunrise && w.darkStart && w.darkEnd);
    assert.equal(w.sunset.toISOString().slice(0, 10), '2026-07-24');
    for (const [k, d] of Object.entries({ darkStart: w.darkStart, darkEnd: w.darkEnd })) {
      assert.ok(d > w.sunset && d < w.sunrise, `${k} ${d.toISOString()} lies between that sunset and the sunrise after it`);
    }
    assert.equal(w.darkStart.getTime(), w.nauticalDusk?.getTime(), 'the darkness is that night\'s nautical one');
  });

  test('visibility counts the time a target is up, not one step per sample', () => {
    // Polaris from 45°N: up the whole hour
    const t = new Date('2026-10-12T05:00:00Z');
    const v = visibility({ lat: 45, lon: 0, elev: 0 }, 2.53, 89.26, t, new Date(t.getTime() + 3600e3), 20, 10);
    assert.equal(v.hoursAboveMin, 1);
  });

  test('visibility refuses a step that would never advance', () => {
    const t = new Date('2026-10-12T05:00:00Z');
    assert.throws(() => visibility(SITE, 0, 0, t, t, 20, 0), /positive/);
  });

  test('bodyInfo is typed and complete', () => {
    const j = bodyInfo(SITE, 'Jupiter', new Date('2026-10-12T06:00:00Z'));
    assert.equal(j.body, 'Jupiter');
    assert.equal(typeof j.magnitude, 'number');
    assert.match(j.nextTransit, /^\d{4}-/);
    assert.equal(bodyInfo(SITE, 'Sun', new Date('2026-10-12T06:00:00Z')).magnitude, undefined);
  });
});

describe('catalog', () => {
  test('parseRow reads a row and rejects rows without a usable position', () => {
    const o = parseRow('NGC 224\tG\t0.712314\t41.26875\tAnd\t177.83\t69.66\t35\t3.44\t23.63\t\tAndromeda Galaxy\tM 31|UGC 454\topenngc');
    assert.ok(o);
    assert.equal(o.id, 'NGC 224');
    assert.deepEqual(o.aliases.slice(0, 2), ['M 31', 'Andromeda Galaxy']);
    assert.equal(o.mag, 3.44);
    assert.equal(o.brightClass, undefined);
    assert.equal(parseRow('X 1\tG\t\t41\tAnd'), null, 'no RA');
    assert.equal(parseRow('X 1\tG\t25\t41\tAnd\t\t\t\t\t\t\t\t\t'), null, 'RA out of range');
    assert.equal(parseRow('X 1\tG\t1\t-91\tAnd\t\t\t\t\t\t\t\t\t'), null, 'Dec out of range');
    assert.equal(parseRow('\tG\t1\t1\tAnd\t\t\t\t\t\t\t\t\t'), null, 'no id');
    const junk = parseRow('X 2\tG\t1\t1\tAnd\tabc\t\t\t\t\t\t\t\t');
    assert.equal(junk?.majorArcmin, undefined, 'a non-numeric size is dropped, not NaN');
  });

  test('the shipped catalog loads and resolves names, nicknames and fuzzy names', () => {
    assert.ok(catalog().length > 10_000);
    assert.equal(findObject('M31')?.id, 'NGC 224');
    assert.equal(findObject('Heart Nebula')?.id, 'IC 1805');
    assert.equal(findObject('andromeda')?.id, 'NGC 224');
    assert.equal(findObject('xx'), null);
    assert.equal(searchObjects('M 3', 5)[0].aliases[0], 'M 3');
    assert.deepEqual(searchObjects('M 3', 0), []);
  });
});

describe('planning', () => {
  const now = new Date('2026-10-12T20:00:00Z');
  const base = { minAltitude: 30, fovArcmin: { w: 168, h: 94 }, timezone: LA, now, limit: 8 };

  test('a night plan is ranked, capped and free of nested fields', () => {
    const plan = planNight(SITE, base);
    assert.equal(plan.targets.length, 8);
    for (let i = 1; i < plan.targets.length; i++) assert.ok(plan.targets[i - 1].score >= plan.targets[i].score);
    assert.ok(plan.targets.every((t) => t.hoursAboveMin >= 0.75 && t.maxAltitude >= 30));
    assert.equal(plan.targets[0].weatherAlignment, null);
  });

  test('the forecast scales scores: a clouded-out night ranks below a clear one', () => {
    const clear = planNight(SITE, { ...base, observability: () => 100 });
    const cloudy = planNight(SITE, { ...base, observability: () => 0 });
    assert.equal(clear.targets[0].weatherAlignment, 100);
    assert.equal(cloudy.targets[0].clearHours, 0);
    assert.ok(cloudy.targets[0].score < clear.targets[0].score);
  });

  test('a window that ends before it starts, or an impossible altitude, is refused', () => {
    assert.throws(() => planNight(SITE, { ...base, start: new Date('2026-10-13T06:00:00Z'), end: new Date('2026-10-13T04:00:00Z') }), /must end after it starts/);
    assert.throws(() => planNight(SITE, { ...base, minAltitude: 90 }), /minAltitude/);
    assert.throws(() => planNight(SITE, { ...base, start: new Date('2026-10-13T04:00:00Z'), end: new Date('2026-10-20T04:00:00Z') }), /one night/);
    assert.throws(() => planNight(SITE, { ...base, fovArcmin: { w: 0, h: 94 } }), /field of view/);
    assert.throws(() => planNight(SITE, { ...base, limit: Number.NaN }), /limit/);
  });

  test('a type group is looked up by its own keys only, and a broken forecast counts as clear', () => {
    assert.equal(planNight(SITE, { ...base, types: ['constructor'] }).targets.length, 0);
    const odd = planNight(SITE, { ...base, observability: () => Number.NaN });
    assert.equal(odd.targets[0].weatherAlignment, 100);
    assert.equal(odd.targets[0].skyAtBest, null);
  });

  test('queryCatalog pages and clamps its limits', () => {
    const r = queryCatalog({ q: 'nebula', limit: 1e6, offset: -5 }, null, LA);
    assert.equal(r.limit, 200);
    assert.equal(r.offset, 0);
    assert.throws(() => queryCatalog({ up: 'now' }, null, LA), /observer location/);
  });

  test('queryCatalog: sorting by altitude orders the matches without dropping the ones that never rise', () => {
    const plain = queryCatalog({ q: 'nebula' }, SITE, LA);
    const sorted = queryCatalog({ q: 'nebula', sort: 'altitude', limit: 200 }, SITE, LA);
    assert.ok(plain.total > 0);
    assert.equal(sorted.total, plain.total);
    const alts = sorted.items.map((i) => i.altitudeNow ?? -90);
    assert.deepEqual(alts, [...alts].sort((a, b) => b - a));
    // the filter still drops what never reaches the minimum altitude
    const up = queryCatalog({ q: 'nebula', up: 'tonight', minHours: 0 }, SITE, LA);
    assert.ok(up.total <= plain.total);
  });
});
