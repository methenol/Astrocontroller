import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WeatherService, scoreHour } from '../astro/weather.js';
import { bestWindow } from '../astro/weather.js';
import { getJson, transient } from '../astro/weather/http.js';
import { CLOUD_MODELS, cloudMedians, median } from '../astro/weather/providers.js';
import type { HourForecast } from '../astro/weather/score.js';

const SITE = { lat: 45.5, lon: -122.6, elev: 0 };
const TZ = 'UTC';

function openMeteo(hours = 3, cloud = 0) {
  const time = Array.from({ length: hours }, (_, i) => `2026-10-12T0${i}:00`);
  const fill = (v: number | null) => Array.from({ length: hours }, () => v);
  return {
    hourly: {
      time,
      cloud_cover: fill(cloud),
      cloud_cover_low: fill(0),
      cloud_cover_mid: fill(0),
      cloud_cover_high: fill(0),
      relative_humidity_2m: fill(50),
      dew_point_2m: fill(2),
      temperature_2m: fill(12),
      wind_speed_10m: fill(5),
      wind_gusts_10m: fill(10),
      precipitation_probability: fill(0),
      precipitation: fill(0),
      visibility: fill(20000),
    },
    current: { time: '2026-10-12T00:00', cloud_cover: cloud, temperature_2m: 12 },
  };
}

const sevenTimer = { init: '2026101200', dataseries: [{ timepoint: 3, seeing: 2, transparency: 7, extra: 1 }] };

/** A fetch that answers per host from a script, counting calls. */
function scripted(routes: { om?: () => unknown; st?: () => unknown; ens?: () => unknown }) {
  const calls = { om: 0, st: 0, ens: 0 };
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    const which = url.includes('open-meteo') ? (url.includes('models=') ? 'ens' : 'om') : 'st';
    calls[which]++;
    const r = routes[which];
    const out = r ? r() : { status: 404 };
    if (out instanceof Error) throw out;
    if (out && typeof out === 'object' && 'status' in out) return new Response('no', { status: (out as { status: number }).status });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('weather', () => {
  test('a forecast combines both providers into scored hours', async () => {
    const { f } = scripted({ om: () => openMeteo(), st: () => sevenTimer });
    const w = new WeatherService({ fetch: f });
    const fc = await w.forecast(SITE, TZ);
    assert.equal(fc.hours.length, 3);
    assert.equal(fc.hours[0].rating, 'excellent');
    assert.equal(fc.hours[2].seeing, '0.5–0.75″', 'the 03:00 sample covers 02:00');
    assert.equal(fc.hours[2].transparency, 'poor');
    assert.ok(fc.hours[2].issues.includes('poor transparency'));
    assert.equal(fc.current.cloudCover, 0);
    assert.equal(fc.stale, false);
  });

  test("7Timer's missing values (-9999) leave the hour without seeing instead of indexing past the scale", async () => {
    const st = { init: '2026101200', dataseries: [{ timepoint: 3, seeing: -9999, transparency: -9999 }] };
    const { f } = scripted({ om: () => openMeteo(), st: () => st });
    const fc = await new WeatherService({ fetch: f }).forecast(SITE, TZ);
    assert.ok(fc.hours.every((h) => h.seeing === undefined && h.transparency === undefined));
  });

  test('a malformed Open-Meteo answer is an error naming the provider; a malformed 7Timer one only drops seeing', async () => {
    const bad = scripted({ om: () => ({ hourly: { time: ['x'] } }), st: () => sevenTimer });
    await assert.rejects(new WeatherService({ fetch: bad.f }).forecast(SITE, TZ), /Open-Meteo answered in an unexpected shape/);
    const mismatched = openMeteo();
    mismatched.hourly.cloud_cover = [0];
    const short = scripted({ om: () => mismatched });
    await assert.rejects(new WeatherService({ fetch: short.f }).forecast(SITE, TZ), /1 values of cloud_cover for 3 hours/);
    const noSeeing = scripted({ om: () => openMeteo(), st: () => ({ init: 'garbage', dataseries: 5 }) });
    const fc = await new WeatherService({ fetch: noSeeing.f }).forecast(SITE, TZ);
    assert.equal(fc.hours.length, 3);
    assert.equal(fc.hours[0].seeing, undefined);
  });

  test('hours missing their core values are left out', async () => {
    const om = openMeteo();
    om.hourly.temperature_2m[1] = null as never;
    const { f } = scripted({ om: () => om, st: () => sevenTimer });
    const fc = await new WeatherService({ fetch: f }).forecast(SITE, TZ);
    assert.deepEqual(fc.hours.map((h) => h.time.slice(11, 13)), ['00', '02']);
  });

  test('concurrent callers share one fetch; a fresh forecast is served from the cache', async () => {
    const { f, calls } = scripted({ om: () => openMeteo(), st: () => sevenTimer });
    const w = new WeatherService({ fetch: f });
    const [a, b] = await Promise.all([w.forecast(SITE, TZ), w.forecast(SITE, TZ)]);
    assert.equal(a.fetchedAt, b.fetchedAt);
    await w.forecast(SITE, TZ);
    assert.equal(calls.om, 1);
  });

  test("a slow refresh for a site we moved away from does not replace the new site's forecast", async () => {
    const OTHER = { lat: 10, lon: 20, elev: 0 };
    let om = 0;
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes('open-meteo')) return new Response(JSON.stringify(sevenTimer), { status: 200 });
      if (url.includes('models=')) return new Response('no', { status: 404 });
      om++;
      // the first site's answer arrives after the second site's
      if (url.includes(`latitude=${SITE.lat}`)) await new Promise((r) => setTimeout(r, 60));
      return new Response(JSON.stringify(openMeteo()), { status: 200 });
    }) as typeof fetch;
    const w = new WeatherService({ fetch: f });
    const slow = w.forecast(SITE, TZ);
    await w.forecast(OTHER, TZ);
    await slow;
    await w.forecast(OTHER, TZ);
    assert.equal(om, 2, 'the second site is still served from its cache');
  });

  test('a failed refresh keeps the last forecast, flagged stale with the reason, and cools down', async () => {
    let now = Date.UTC(2026, 9, 12, 0, 0);
    let up = true;
    const { f, calls } = scripted({ om: () => (up ? openMeteo() : { status: 404 }), st: () => sevenTimer });
    const w = new WeatherService({ fetch: f, now: () => now });
    await w.forecast(SITE, TZ);
    up = false;
    now += 30 * 60e3;
    const served = await w.forecast(SITE, TZ);
    assert.equal(served.stale, true, 'the held copy is served at once while refreshing');
    await new Promise((r) => setTimeout(r, 20));
    const after = await w.forecast(SITE, TZ);
    assert.match(after.staleError ?? '', /HTTP 404/);
    assert.equal(calls.om, 2, 'no new attempt during the cool-down');
    now += 13 * 3600e3;
    await assert.rejects(w.forecast(SITE, TZ), /past 12 h/);
  });

  test('cloud cover is the median across the models, per layer, and the current value follows it', async () => {
    // three hours; models answer 0, 2, 54, 0, 54, 6 for the total and the last model has no data at 02:00
    const totals = [0, 2, 54, 0, 54, 6];
    const hourly: Record<string, unknown[]> = { time: ['2026-10-12T00:00', '2026-10-12T01:00', '2026-10-12T02:00'] };
    CLOUD_MODELS.forEach((m, k) => {
      const last = k === CLOUD_MODELS.length - 1;
      hourly[`cloud_cover_${m}`] = [totals[k], totals[k], last ? null : totals[k]];
      hourly[`cloud_cover_low_${m}`] = [k === 2 ? 40 : 0, 0, 0];
      hourly[`cloud_cover_mid_${m}`] = [0, 0, 0];
      hourly[`cloud_cover_high_${m}`] = [0, 0, 0];
    });
    const { f, calls } = scripted({ om: () => openMeteo(3, 0), st: () => sevenTimer, ens: () => ({ hourly }) });
    const fc = await new WeatherService({ fetch: f }).forecast(SITE, TZ);
    assert.equal(calls.ens, 1);
    assert.deepEqual(fc.hours.map((h) => h.cloudTotal), [4, 4, 2], 'median of 0,0,2,6,54,54 is 4; of 0,0,2,54,54 is 2');
    assert.equal(fc.current.cloudCover, 4, "the current value is its hour's median, not the default model's 0");
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    // a layer's median above the total's lifts the total
    const lifted = cloudMedians({ hourly: { time: ['t'], ...Object.fromEntries(CLOUD_MODELS.flatMap((m) => [[`cloud_cover_${m}`, [0]], [`cloud_cover_low_${m}`, [30]]])) } });
    assert.equal(lifted.get('t')?.cloud_cover, 30);
  });

  test("without the models' answer the default model's cloud cover stands", async () => {
    const { f } = scripted({ om: () => openMeteo(3, 25), st: () => sevenTimer, ens: () => ({ status: 404 }) });
    const fc = await new WeatherService({ fetch: f }).forecast(SITE, TZ);
    assert.deepEqual(fc.hours.map((h) => h.cloudTotal), [25, 25, 25]);
    assert.equal(fc.current.cloudCover, 25);
  });

  test('getJson retries transient failures only', async () => {
    let n = 0;
    const flaky = (async () => (++n < 3 ? new Response('', { status: 503 }) : new Response('{"ok":1}'))) as typeof fetch;
    assert.deepEqual(await getJson('http://x.test/a', { fetch: flaky, backoffMs: 1 }), { ok: 1 });
    assert.equal(n, 3);
    n = 0;
    const gone = (async () => (n++, new Response('', { status: 404 }))) as typeof fetch;
    await assert.rejects(getJson('http://x.test/a', { fetch: gone, backoffMs: 1 }), /HTTP 404 from x\.test \(attempt 1 of 3\)/);
    assert.equal(n, 1);
    assert.ok(transient({ name: 'TimeoutError' }));
    assert.ok(transient({ cause: { code: 'ECONNRESET' } }));
    assert.ok(!transient(new SyntaxError('bad json')));
  });

  test('scoring and the best window', () => {
    const base = { time: '', local: '', sunAltitude: -30, dark: true, cloudTotal: 0, cloudLow: 0, cloudMid: 0, cloudHigh: 0, humidity: 50, temperatureC: 10, dewPointC: 0, dewSpreadC: 10, windKmh: 0, gustKmh: 0, precipProbability: 0, precipMm: 0, visibilityKm: null };
    assert.equal(scoreHour(base).score, 100);
    assert.equal(scoreHour({ ...base, precipProbability: 60 }).score, 20);
    assert.ok(scoreHour({ ...base, gustKmh: 45 }).issues[0].startsWith('strong gusts'));
    const h = (i: number, score: number) => ({ time: `2026-10-12T0${i}:00:00.000Z`, local: `0${i}:00`, score }) as HourForecast;
    const b = bestWindow([h(0, 90), h(1, 30), h(2, 70), h(3, 80), h(4, 10)], 'UTC');
    assert.deepEqual({ ...b, to: undefined }, { from: '02:00', to: undefined, hours: 2, avgScore: 75 });
    assert.match(b?.to ?? '', /04:00$/, 'the window ends an hour after its last clear hour');
    assert.equal(bestWindow([h(0, 10)], 'UTC'), null);
    // a missing hour (02:00) splits what would otherwise be one 3-hour run
    assert.equal(bestWindow([h(0, 90), h(1, 90), h(3, 90)], 'UTC')?.hours, 2);
  });
});
