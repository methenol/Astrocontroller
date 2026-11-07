import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLocal, hoursToHms, degToDms, bodyInfo, nightWindow, visibility } from '../astro/sky.js';
import { zonedWallTimeToInstant } from '../util/time.js';
import { parseRow, findObject, searchObjects, catalog } from '../astro/catalog.js';
import { planNight } from '../astro/planner.js';
import { queryCatalog } from '../astro/catalog-search.js';
import { classifyFilter, detectFor, moonlitKeep, sqmFor } from '../astro/detect.js';
import { ladderRound, subPlan, type Rig } from '../astro/exposure.js';
import { captureRecords, REST_DEFAULTS, restPenalty, restState, saveRestSettings, targetKey } from '../astro/rest.js';
import { config } from '../config.js';

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

  test('the minute after sunset reports today’s sunset, not tomorrow’s (refraction does not split the night)', () => {
    // 31.5°N 99.4°W on 2026-11-02: sunset (the search's, geometric) 23:47:18Z; with refraction the Sun still reads above it at 23:47:45Z
    const site = { lat: 31.5475, lon: -99.3817, elev: 454 };
    const when = new Date('2026-11-02T23:47:45Z');
    const w = nightWindow(site, when);
    assert.ok(w.sunset && w.sunset < when, `sunset ${w.sunset?.toISOString()} is today's`);
    assert.ok(w.darkStart && w.sunrise && w.darkStart > w.sunset && w.darkStart < w.sunrise, 'dusk and sunset are the same night');
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
  const base = { minAltitude: 30, fovArcmin: { w: 168, h: 94 }, timezone: LA, now, limit: 8, applyRest: false };

  test('a night plan is ranked, capped and free of nested fields', () => {
    const plan = planNight(SITE, base);
    assert.equal(plan.targets.length, 8);
    for (let i = 1; i < plan.targets.length; i++) assert.ok(plan.targets[i - 1].score >= plan.targets[i].score);
    assert.ok(plan.targets.every((t) => t.hoursAboveMin >= 0.75 && t.maxAltitude >= 30));
    assert.equal(plan.targets[0].weatherAlignment, null);
  });

  test('the forecast scales scores: a clouded-out night ranks below a clear one', () => {
    const clear = planNight(SITE, { ...base, conditions: () => ({ observability: 100 }) });
    const cloudy = planNight(SITE, { ...base, conditions: () => ({ observability: 0 }) });
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
    const odd = planNight(SITE, { ...base, conditions: () => ({ observability: Number.NaN }) });
    assert.equal(odd.targets[0].weatherAlignment, 100);
    assert.equal(odd.targets[0].skyAtBest, null);
  });

  test('minFovPercent keeps only targets that cover that percent of the frame width', () => {
    const wide = planNight(SITE, { ...base, minFovPercent: 50 });
    assert.ok(wide.targets.length > 0);
    // 50% of a 168′ frame: nothing smaller than 84′ may be offered
    for (const t of wide.targets) {
      const major = parseFloat(t.sizeArcmin);
      assert.ok(major >= 84, `${t.displayName} (${t.sizeArcmin}′) is below half the frame width`);
    }
    assert.throws(() => planNight(SITE, { ...base, minFovPercent: 150 }), /minFovPercent/);
  });

  test('queryCatalog pages and clamps its limits', () => {
    const r = queryCatalog({ q: 'nebula', limit: 1e6, offset: -5 }, null, LA);
    assert.equal(r.limit, 200);
    assert.equal(r.offset, 0);
    assert.throws(() => queryCatalog({ up: 'now' }, null, LA), /observer location/);
  });

  test('queryCatalog: minFovPercent keeps objects spanning that percent of the tele frame width', () => {
    const fov = { teleFovWidthArcmin: 100 };
    const all = queryCatalog({ types: ['galaxy'] }, null, LA);
    const big = queryCatalog({ types: ['galaxy'], minFovPercent: 50 }, null, LA, fov);
    assert.ok(big.total > 0 && big.total < all.total);
    for (const it of big.items) assert.ok((it.majorArcmin ?? 0) >= 50, `${it.name} is smaller than half the frame`);
    // without a frame width the filter is refused rather than silently ignored
    assert.throws(() => queryCatalog({ minFovPercent: 25 }, null, LA), /field of width/);
    assert.throws(() => queryCatalog({ minFovPercent: -5 }, null, LA, fov), /frame coverage/);
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

  test('a type with nothing shootable tonight is refused honestly, not quietly padded out', () => {
    const plan = planNight(SITE, { ...base, types: ['HII'], limit: 12, bortle: 5, filter: 'none' });
    assert.ok(plan.targets.length > 0, 'the rows are still shown, with their reason');
    for (const t of plan.targets) {
      assert.equal(t.detectBucket, 'SKIP_TONIGHT', `${t.displayName} should be refused under this sky with no filter`);
      assert.ok(t.gated && t.gateReason, `${t.displayName} should be gated, with the reason on the row`);
    }
    assert.equal(plan.hero, null, 'nothing shootable means no hero');
    assert.equal(plan.season.label, '—', 'gated rows are no evidence of what the sky is about');
  });

  test('a two-hour session is scored on what those two hours offered', () => {
    const full = planNight(SITE, base);
    const start = new Date('2026-10-13T08:30:00Z');
    const short = planNight(SITE, { ...base, start, end: new Date(start.getTime() + 2 * 3600e3) });
    assert.ok(short.targets.length > 0);
    for (const t of short.targets) assert.ok(t.hoursAboveMin <= 2.01, `${t.displayName} is counted up beyond the window`);
    // integration is normalised against the window, so the best target here is not punished for
    // a night it was never given: anything near the top of a full night scores near the top here.
    assert.ok(
      short.targets[0].score >= full.targets[0].score - 8,
      `${short.targets[0].displayName} scored ${short.targets[0].score} against a full night's best of ${full.targets[0].score}`,
    );
    assert.ok(short.targets[0].usableMinutes >= 60, 'two hours of dark should leave an hour of usable integration');
  });

  test('the plan states the sky and glass it judged everything against', () => {
    const plan = planNight(SITE, { ...base, bortle: 2, filter: 'duo-band' });
    assert.deepEqual(plan.sky, { bortle: 2, sqm: 21.9, filter: 'duo-band', band: 'duo_wide' });
    assert.equal(planNight(SITE, base).sky.bortle, 5, 'an unconfigured site is the reference class');
  });
});

describe('detectability', () => {
  const at = (name: string, bortle: number, filter?: string) => {
    const o = findObject(name);
    assert.ok(o, `${name} is in the catalog`);
    return detectFor(o!, { bortle, filter });
  };

  test('a faint hydrogen-alpha region is only shootable through a filter', () => {
    const bare = at('NGC 6888', 5, 'none');
    assert.equal(bare.bucket, 'SKIP_TONIGHT');
    assert.match(bare.reason, /filter/);
    const nb = at('NGC 6888', 5, 'duo-band');
    assert.notEqual(nb.bucket, 'SKIP_TONIGHT', 'the same target through a duo-band is workable');
    assert.ok(nb.score > bare.score);
  });

  test('a dark nebula is a contrast target and a lit sky takes it away', () => {
    assert.equal(at('B 33', 8).bucket, 'SKIP_TONIGHT');
    assert.notEqual(at('B 33', 2).bucket, 'SKIP_TONIGHT');
  });

  test('the sky class moves the ladder rather than the target', () => {
    const dark = at('M 33', 1);
    const city = at('M 33', 8);
    assert.equal(dark.sb, city.sb, 'the target did not change, the sky did');
    assert.ok(dark.score > city.score, `${dark.score} vs ${city.score}`);
    assert.match(city.reason, /faint/);
    assert.doesNotMatch(dark.reason, /faint/);
  });

  test('missing data costs a target its badge but never refuses it', () => {
    const d = at('C 33', 5);
    assert.equal(d.bucket, 'UNKNOWN');
    assert.equal(d.sb, null);
    assert.ok(d.score >= 50, 'the neutral score, not a condemnation');
  });

  test('an estimated surface brightness sits on the measured axis', () => {
    // mag + 2.5·log10(area) over arcminute axes is 8.89 below mag/arcsec²; putting an estimate on
    // that axis makes every galaxy look sky-brighht, which is the bug this pins.
    const d = at('M 33', 5);
    assert.ok(d.sb !== null && d.sb > 18 && d.sb < 27, `galaxy surface brightness ${d.sb} is off the physical axis`);
  });

  test('the Moon costs a narrowband target a fraction of what it costs a faint galaxy', () => {
    const ha = at('NGC 6888', 5, 'duo-band');
    const galaxy = at('M 33', 5, 'none');
    assert.ok(moonlitKeep(ha, 0) === 1 && moonlitKeep(galaxy, 0) === 1, 'no Moon, no cost');
    const keepHa = moonlitKeep(ha, 0.8);
    const keepGalaxy = moonlitKeep(galaxy, 0.8);
    assert.ok(keepHa - keepGalaxy >= 0.25, `a gibbous Moon leaves ${keepHa.toFixed(2)} of an Ha minute and ${keepGalaxy.toFixed(2)} of a galaxy minute`);
    assert.ok(moonlitKeep(ha, 1) > 0.4 && moonlitKeep(galaxy, 1) < 0.2);
  });

  test('the glass in the light path is classified by what it passes', () => {
    assert.equal(classifyFilter('none'), 'broadband');
    assert.equal(classifyFilter(undefined), 'broadband');
    assert.equal(classifyFilter('astro'), 'broadband');
    assert.equal(classifyFilter('UHC'), 'uhc');
    assert.equal(classifyFilter('duo-band'), 'duo_wide');
    assert.equal(classifyFilter('Optolong L-eXtreme'), 'duo_tight');
    assert.equal(classifyFilter('Ha 7nm'), 'line');
  });

  test('an unknown site is the reference class, and a wild class is clamped', () => {
    assert.equal(sqmFor(undefined), 20);
    assert.equal(sqmFor(3), 21.8);
    assert.equal(sqmFor(99), 17.5, 'Bortle 9 is the worst sky there is');
  });

  test('a fractional Bortle class lands between its neighbours', () => {
    assert.equal(sqmFor(6.6), 18.9, '6.6 is 60% of the way from Bortle 6 (19.2) to 7 (18.7)');
    assert.equal(sqmFor(6), 19.2);
    assert.equal(sqmFor(8.5), 17.8);
    assert.equal(sqmFor(0.4), 22, 'below 1 is clamped to the darkest class');
    assert.ok(sqmFor(4.5) < sqmFor(4) && sqmFor(4.5) > sqmFor(5));
  });
});

describe('sub-exposure', () => {
  // The Dwarf: a 60 mm lens on an alt-az head, unguided, 2.77″ per pixel.
  const DWARF: Rig = { plateScaleArcsecPerPx: 2.766, apertureMm: 60, mount: 'alt-az', guided: false, band: 'broadband' };
  // A 300 mm f/6 achromat on a star tracker: unguided, so its trails budget is the ceiling.
  const TRACKER: Rig = { plateScaleArcsecPerPx: 0.72, apertureMm: 50, effectiveFlMm: 300, mount: 'eq', guided: false, band: 'broadband' };
  const plan = (rig: Rig, o: { bortle?: number; transitAlt?: number; usableMin?: number; windKmh?: number; moonUp?: boolean } = {}) =>
    subPlan({ rig, bortle: o.bortle ?? 5, transitAlt: o.transitAlt ?? 60, usableMin: o.usableMin ?? 180, windKmh: o.windKmh, moonUp: o.moonUp });

  test('an alt-az head, not the sky, sets the sub length', () => {
    const p = plan(DWARF, { bortle: 3 })!;
    assert.equal(p.subS, 20, '20 s is the longest this head holds at mid-sky');
    assert.equal(p.capKind, 'rotation');
    assert.ok(p.capBound, 'a dark sky would reward far more than this mount can track');
    assert.equal(p.subs * p.subS, p.integrationMin * 60, 'the frame count is the integration');
    assert.match(p.line, /frame count, not length/);
  });

  test('wind takes over from field rotation', () => {
    assert.equal(plan(DWARF, { bortle: 3, windKmh: 8 })!.capKind, 'rotation', 'a calm night is the rotation rung');
    const windy = plan(DWARF, { bortle: 3, windKmh: 25 })!;
    assert.equal(windy.capKind, 'wind');
    assert.equal(windy.subS, 10);
    assert.match(windy.line, /wind \(25 km\/h\) is the limit/);
  });

  test('near the zenith an alt-az head holds less, not more', () => {
    assert.equal(plan(DWARF, { bortle: 3, transitAlt: 86 })!.subS, 15);
    assert.equal(plan(DWARF, { bortle: 3, transitAlt: 45 })!.subS, 20);
  });

  test('an unguided equatorial is capped by its trails budget, and guiding removes the cap', () => {
    const p = plan(TRACKER)!;
    assert.equal(p.capKind, 'periodic-error');
    assert.equal(p.capS, 90, 'a 300 mm lens on a tracker holds about a minute and a half');
    assert.ok(p.capBound, 'the sky wants 450 s here, which this mount cannot hold unguided');
    assert.equal(p.subS, p.capS, 'the shown length is the ceiling itself');
    const guided = plan({ ...TRACKER, guided: true })!;
    assert.equal(guided.capS, null);
    assert.equal(guided.capBound, false);
    assert.ok(guided.subS > p.subS, 'guiding buys the sky its vote');
  });

  test('without the aperture the advice is the mount ceiling and says what is missing', () => {
    const p = plan({ ...DWARF, apertureMm: undefined }, { bortle: 3, usableMin: 120 })!;
    assert.equal(p.swampS, null, 'the sky-limited length is unknowable without the aperture');
    assert.equal(p.subS, 20, 'so the mount ceiling is the only honest number');
    assert.match(p.line, /PLAN_APERTURE_MM/);
  });

  test('a narrowband filter buys longer subs than the sky alone', () => {
    const guided: Rig = { ...DWARF, mount: 'eq', guided: true };
    const bb = plan(guided)!.subS;
    const duo = plan({ ...guided, band: 'duo_tight' })!.subS;
    const line = plan({ ...guided, band: 'line' })!.subS;
    assert.ok(bb < duo && duo < line, `broadband ${bb}s < duo-band ${duo}s < narrowband ${line}s`);
    assert.ok(line <= 600, 'and nothing longer is ever offered');
  });

  test('when the sky is the limit the plan stops blaming the mount', () => {
    const guided: Rig = { ...DWARF, mount: 'eq', guided: true };
    const p = plan(guided)!;
    assert.equal(p.capS, null);
    assert.equal(p.capBound, false);
    assert.ok(p.subRangeS, 'without a read-noise figure both honest answers are shown');
    assert.match(p.line, /the sky, not the camera, is the limit/);
    assert.ok(!/frame count, not length/.test(p.line), 'the mount is not mentioned when it is not the constraint');
  });

  test('the ladder is snapped, not interpolated, and clamped at the top', () => {
    assert.equal(ladderRound(61).rung, 60, 'a 1% shortfall must not buy a 50% longer sub');
    assert.equal(ladderRound(62).rung, 90);
    assert.equal(ladderRound(700).rung, 600, 'nothing longer is ever offered');
    assert.equal(ladderRound(Number.NaN).rung, 600, 'an unknowable length falls back to the ceiling');
  });
});

describe('target memory', () => {
  const TODAY = '2026-10-12';
  const ago = (days: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - days * 86_400e3).toISOString().slice(0, 10);
  const shot = (days: number, name = 'M 31') => [{ name: targetKey(name), date: ago(days), role: 'shot' as const }];

  test('a capture rests a target at full strength for the rest length, then not at all', () => {
    assert.equal(restPenalty('M 31', TODAY, shot(0)), 25);
    assert.equal(restPenalty('M 31', TODAY, shot(REST_DEFAULTS.restDays - 1)), 25, 'full strength through the rest');
    assert.equal(restState('M 31', TODAY, shot(0))?.until, ago(-REST_DEFAULTS.restDays));
    assert.equal(restPenalty('M 31', TODAY, shot(REST_DEFAULTS.restDays)), 0);
    assert.equal(restState('M 31', TODAY, shot(REST_DEFAULTS.restDays)), null, 'nothing to report once it has recovered');
  });

  test('the rest length is the user\'s', () => {
    try {
      saveRestSettings({ restDays: 10 });
      assert.equal(restPenalty('M 31', TODAY, shot(9)), 25);
      assert.equal(restPenalty('M 31', TODAY, shot(10)), 0);
      assert.equal(restState('M 31', TODAY, shot(0))?.until, ago(-10));
    } finally {
      saveRestSettings(REST_DEFAULTS);
    }
  });

  test('captures rest a target only once they add up to the integration goal', () => {
    const savedLib = config.paths.library;
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-lib-'));
    const session = (name: string, subs: number, failed = 0) => {
      const dir = path.join(lib, name);
      fs.mkdirSync(dir);
      for (let i = 0; i < subs; i++) fs.writeFileSync(path.join(dir, `sub_${i}.fits`), '');
      for (let i = 0; i < failed; i++) fs.writeFileSync(path.join(dir, `failed_sub_${i}.fits`), '');
    };
    try {
      config.paths.library = lib;
      // 40 × 15 s = 10 min kept the first night, 80 × 15 s = 20 min the second; 50 rejected subs never count
      session('DWARF_RAW_TELE_M 31_EXP_15_GAIN_60_2026-10-01-22-00-00-000', 40, 50);
      session('DWARF_RAW_TELE_M 31_EXP_15_GAIN_60_2026-10-05-22-00-00-000', 80);
      session('DWARF_RAW_WIDE_M 31_EXP_15_GAIN_60_2026-10-06-22-00-00-000', 80);
      assert.deepEqual(captureRecords(TODAY, 0).map((r) => r.date), ['2026-10-01', '2026-10-05', '2026-10-06'], 'no goal: every capture rests it');
      assert.deepEqual(captureRecords(TODAY, 30).map((r) => r.date), ['2026-10-05'], 'rested the night the tele total reached 30 min');
      assert.deepEqual(captureRecords(TODAY, 31), [], 'the cameras are not added together');
    } finally {
      config.paths.library = savedLib;
      fs.rmSync(lib, { recursive: true, force: true });
    }
  });

  test('what was suggested tonight does not demote tonight’s own list', () => {
    assert.equal(restPenalty('M 31', TODAY, [{ name: targetKey('M 31'), date: TODAY, role: 'hero' }]), 0);
    assert.ok(restPenalty('M 31', TODAY, [{ name: targetKey('M 31'), date: ago(1), role: 'hero' }]) > 0, "yesterday's hero rests today");
  });

  test('"done" never comes back on its own', () => {
    assert.equal(restPenalty('M 31', TODAY, [{ name: targetKey('M 31'), date: '2020-01-01', role: 'done' }]), 100);
    assert.equal(restState('M 31', TODAY, [{ name: targetKey('M 31'), date: '2020-01-01', role: 'done' }])?.until, null);
  });

  test('a library folder and a catalog id rest the same object', () => {
    assert.equal(targetKey('M 31'), targetKey('NGC 224'));
    assert.equal(targetKey('Andromeda Galaxy'), targetKey('M 31'));
    assert.equal(targetKey('M 42'), targetKey('NGC 1976'));
    assert.equal(targetKey('Heart Nebula'), targetKey('IC 1805'));
  });

  test('the plan holds a captured target back and names it instead of hiding it', () => {
    // the evening of TODAY: planned on the real date, a moonlit night gates every row and leaves no hero to compare
    const opts = { minAltitude: 30, timezone: LA, fovArcmin: { w: 168, h: 94 }, limit: 8, now: new Date(`${TODAY}T20:00:00Z`) };
    const clean = planNight(SITE, opts);
    const captured = clean.targets[0].name;
    const rested = planNight(SITE, { ...opts, today: TODAY, restRecords: shot(2, captured) });
    assert.ok(!rested.targets.some((t) => t.name === captured), `${clean.targets[0].displayName} was photographed two nights ago`);
    assert.ok(rested.resting.some((r) => r.penalty > 0 && r.reason.startsWith('shot') && r.reason.includes('until')), 'it is reported, not silently dropped');
    assert.ok(rested.targets.length === opts.limit, 'the list is refilled from the next candidates');
    assert.notEqual(rested.hero, clean.hero, 'and the night starts somewhere else');
  });
});
