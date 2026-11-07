import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simbadQuery, skyviewUrl, wikiThumb } from '../mcp/tools/research.js';
import { targetSeason } from '../astro/season.js';

describe('target research', () => {
  test('a SIMBAD identifier is quoted as an ADQL literal', () => {
    assert.match(simbadQuery("Barnard's Star"), /WHERE i\.id = 'Barnard''s Star'$/);
  });

  test('a survey plate keeps the field shape, long side 1280 px', () => {
    const u = new URL(skyviewUrl(1.5, 30.5, 1.2, 2.13));
    assert.equal(u.searchParams.get('Position'), '22.50000,30.50000');
    assert.equal(u.searchParams.get('Size'), '1.2000,2.1300');
    assert.equal(u.searchParams.get('Pixels'), '721,1280');
  });

  test('a Wikimedia thumbnail is asked for at 1280 px; an original stays as it is', () => {
    const thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/VST_M33.jpg/3840px-VST_M33.jpg?utm_source=en.wikipedia.org';
    assert.equal(wikiThumb(thumb), 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/VST_M33.jpg/1280px-VST_M33.jpg');
    const orig = 'https://upload.wikimedia.org/wikipedia/commons/6/64/M33.jpg';
    assert.equal(wikiThumb(orig), orig);
  });
});

describe('target season', () => {
  // a mid-northern site, a mid-November evening
  const site = { lat: 40, lon: -75, elev: 0 };
  const from = new Date('2026-11-15T12:00:00Z');
  const opts = { minAltitude: 25, tz: 'America/New_York', from };

  test('an autumn object is in season now, at its best in the autumn months', () => {
    // M 31
    const s = targetSeason(site, 0.7123, 41.269, opts);
    assert.equal(s.circumpolar, false);
    assert.equal(s.neverRises, false);
    assert.equal(s.inSeasonNow, true);
    assert.ok(s.transitAltitude > 85, `transit ${s.transitAltitude}`);
    const best = s.bestNight!;
    assert.ok(['2026-09', '2026-10', '2026-11', '2027-09', '2027-10'].some((m) => best.date.startsWith(m)), `best night ${best.date}`);
    assert.equal(s.months.length, 12);
    assert.equal(s.months[0].month, 'Nov');
    // in season since the summer, until late winter
    assert.ok(s.seasonStart! < '2026-11-15' && s.seasonEnd! > '2027-01-01', `${s.seasonStart} → ${s.seasonEnd}`);
  });

  test('a spring galaxy is out of season in November and peaks in spring', () => {
    // M 104, Sombrero
    const s = targetSeason(site, 12.666, -11.623, opts);
    assert.equal(s.inSeasonNow, false);
    assert.ok(s.bestMonths.some((m) => ['Mar', 'Apr', 'May'].includes(m)), s.bestMonths.join(', '));
    assert.ok(s.seasonStart && s.seasonEnd && s.seasonStart < s.seasonEnd);
  });

  test('a far-southern object never rises; a polar one is circumpolar', () => {
    assert.equal(targetSeason(site, 5.4, -69.75, opts).neverRises, true);
    const polar = targetSeason(site, 2.5, 89.26, opts);
    assert.equal(polar.circumpolar, true);
    assert.equal(polar.usableAllYear, true);
  });

  test('an obstruction map takes its share: a wall to the south shortens a southern object', () => {
    const open = targetSeason(site, 12.666, -11.623, opts);
    const walled = targetSeason(site, 12.666, -11.623, { ...opts, horizon: { limit: (az) => (az > 120 && az < 240 ? 60 : 0), summary: 'test wall' } });
    const sum = (x: typeof open) => x.months.reduce((n, m) => n + m.usableHours, 0);
    assert.ok(sum(walled) < sum(open) / 2, `${sum(walled)} vs ${sum(open)}`);
    assert.equal(walled.horizon, 'test wall');
  });
});
