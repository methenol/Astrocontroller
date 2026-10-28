import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assess, ringPoints, parsePoints, RainGuard, GUARD_DEFAULTS, FAULT_AFTER_MS, SNOOZE_MS, type Point } from '../astro/weather/guard.js';
import { hourHazards } from '../astro/weather/safety.js';
import type { HourForecast } from '../astro/weather/score.js';
import { unitFormat } from '../util/units.js';

const NOW = Date.UTC(2026, 9, 27, 22, 5); // 22:05 UTC
const T = Math.floor(NOW / 1000);
const SLOT = 900;
const slotEnd0 = Math.ceil(T / SLOT) * SLOT; // the slot under way ends at 22:15
const S = GUARD_DEFAULTS;

/** One location: 8 15-minute slots from the one under way, hourly from the hour under way. */
function point(opts: { mm?: number[]; codes?: number[]; prob?: number[]; gust?: number; current?: { precipitation?: number; weather_code?: number } } = {}): Point {
  const times = Array.from({ length: 8 }, (_, i) => slotEnd0 + i * SLOT);
  const hours = Array.from({ length: 3 }, (_, i) => Math.ceil(T / 3600) * 3600 + i * 3600);
  return {
    latitude: 40.0,
    longitude: -105.0,
    current: { time: slotEnd0 - SLOT, precipitation: 0, weather_code: 0, wind_gusts_10m: 10, ...opts.current },
    minutely_15: { time: times, precipitation: times.map((_, i) => opts.mm?.[i] ?? 0), weather_code: times.map((_, i) => opts.codes?.[i] ?? 0), wind_gusts_10m: times.map(() => opts.gust ?? 10) },
    hourly: { time: hours, precipitation_probability: hours.map((_, i) => opts.prob?.[i] ?? 0), weather_code: hours.map(() => 0), wind_gusts_10m: hours.map(() => opts.gust ?? 10) },
  };
}
const dry = () => point();
const ring = (site: Point, others: Point[] = []) => [site, ...Array.from({ length: 8 }, (_, i) => others[i] ?? dry())];
const LABELS = ['site', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

describe('rain guard: assessment', () => {
  test('a dry hour everywhere is clear', () => {
    const a = assess(ring(dry()), LABELS, NOW, S, 'UTC');
    assert.equal(a.level, 'clear');
    assert.deepEqual(a.hazards, []);
    // 22:15 … 23:15 overlap (22:05, 23:05]; 23:15 covers 23:00–23:15 which still overlaps
    assert.equal(a.slots.length, 5);
  });

  test('showers count: precipitation, not only rain, sounds the alarm', () => {
    const a = assess(ring(point({ mm: [0, 0, 0.3], codes: [0, 0, 80] })), LABELS, NOW, S, 'UTC');
    assert.equal(a.level, 'alarm');
    assert.match(a.hazards[0].message, /from 22:30/);
    assert.equal(a.siteMm, 0.3);
  });

  test('a slot past the lookahead does not count', () => {
    const a = assess(ring(point({ mm: [0, 0, 0, 0, 0, 0, 2] })), LABELS, NOW, S, 'UTC');
    assert.equal(a.level, 'clear');
  });

  test('precipitation now, snow, a high chance, gusts and storms each sound the alarm', () => {
    assert.equal(assess(ring(point({ current: { precipitation: 0.1 } })), LABELS, NOW, S, 'UTC').hazards[0].kind, 'rain');
    assert.equal(assess(ring(point({ mm: [0.2], codes: [73] })), LABELS, NOW, S, 'UTC').hazards[0].kind, 'snow');
    assert.match(assess(ring(point({ prob: [70] })), LABELS, NOW, S, 'UTC').hazards[0].message, /70% chance/);
    assert.equal(assess(ring(point({ gust: 60 })), LABELS, NOW, S, 'UTC').hazards[0].kind, 'wind');
    assert.equal(assess(ring(point({ codes: [0, 95] })), LABELS, NOW, S, 'UTC').hazards.find((h) => h.kind === 'storm')?.level, 'alarm');
  });

  test('rain in the ring is a watch; a storm in the ring is an alarm', () => {
    const wet = assess(ring(dry(), [point({ mm: [0, 0.5] })]), LABELS, NOW, S, 'UTC');
    assert.equal(wet.level, 'watch');
    assert.match(wet.hazards[0].message, /20 km N from 22:15/);
    const storm = assess(ring(dry(), [dry(), dry(), point({ codes: [0, 0, 96] })]), LABELS, NOW, S, 'UTC');
    assert.equal(storm.level, 'alarm');
    assert.match(storm.hazards[0].message, /within 20 km \(E\)/);
  });

  test('the ring surrounds the site at its radius; a single point comes back as one location', () => {
    const pts = ringPoints({ lat: 45, lon: 10 }, 20);
    assert.equal(pts.length, 9);
    assert.ok(Math.abs(pts[1][0] - 45 - 20 / 111.32) < 1e-9, 'N is 20 km north');
    assert.equal(ringPoints({ lat: 45, lon: 10 }, 0).length, 1);
    assert.equal(parsePoints(dry(), 1).length, 1);
    assert.throws(() => parsePoints([dry()], 9), /1 locations for 9/);
  });
});

/** A guard on a fake clock and a scripted Open-Meteo. */
function rig(answer: () => unknown) {
  let now = NOW;
  const f = (async () => {
    const out = answer();
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  const g = new RainGuard({ site: () => ({ lat: 40.0, lon: -105.0, elev: 0 }), tz: () => 'UTC', fetch: f, now: () => now });
  return { g, advance: (ms: number) => (now += ms) };
}

describe('rain guard: the alarm', () => {
  test('sounds until acknowledged, sounds again after the snooze, and ends once acknowledged and dry', async () => {
    let wet = true;
    // rain in every slot, so it is still ahead after the clock moves on
    const { g, advance } = rig(() => ring(wet ? point({ mm: [1, 1, 1, 1, 1, 1, 1, 1] }) : dry()));
    try {
      let s = await g.arm();
      assert.equal(s.state, 'alarm');
      assert.equal(s.sounding, true);
      s = g.acknowledge();
      assert.equal(s.sounding, false);
      advance(SNOOZE_MS / 2);
      assert.equal((await g.check()).sounding, false, 'still within the snooze');
      advance(SNOOZE_MS);
      assert.equal((await g.check()).sounding, true, 'the rain outlasted the snooze');
      g.acknowledge();
      wet = false;
      s = await g.check();
      assert.equal(s.alarm, null);
      assert.equal(s.state, 'clear');
    } finally {
      g.close();
    }
  });

  test('an alarm nobody acknowledged keeps sounding after the forecast clears', async () => {
    let wet = true;
    const { g } = rig(() => ring(wet ? point({ mm: [1] }) : dry()));
    try {
      await g.arm();
      wet = false;
      const s = await g.check();
      assert.equal(s.sounding, true);
      assert.match(s.alarm?.message ?? '', /since cleared/);
    } finally {
      g.close();
    }
  });

  test('checks that keep failing raise a fault alarm, which ends when a check succeeds', async () => {
    let down = false;
    const { g, advance } = rig(() => (down ? new Error('the provider refused the request') : ring(dry())));
    try {
      await g.arm();
      down = true;
      advance(FAULT_AFTER_MS - 60e3);
      assert.equal((await g.check()).state, 'clear', 'not yet');
      advance(2 * 60e3);
      const s = await g.check();
      assert.equal(s.state, 'fault');
      assert.equal(s.sounding, true);
      assert.match(s.alarm?.message ?? '', /no forecast for 13 min/);
      down = false;
      assert.equal((await g.check()).alarm, null);
    } finally {
      g.close();
    }
  });

  test('a disarmed guard never sounds', async () => {
    const { g } = rig(() => ring(point({ mm: [1] })));
    try {
      const s = await g.check();
      assert.equal(s.state, 'disarmed');
      assert.equal(s.sounding, false);
      assert.equal(s.assessment?.level, 'alarm', 'but a manual check still reports what it found');
    } finally {
      g.close();
    }
  });
});

describe('night safety', () => {
  const hour = (o: Partial<HourForecast>): HourForecast =>
    ({ time: '2026-10-27T23:00:00.000Z', local: 'Oct 27, 23:00', temperatureC: 12, dewPointC: 5, dewSpreadC: 7, humidity: 60, windKmh: 5, gustKmh: 10, precipProbability: 0, precipMm: 0, visibilityKm: 20, cloudTotal: 0, weatherCode: 0, ...o }) as HourForecast;
  const L = { gustKmh: 45, probabilityPct: 60, minTempC: -20 };

  test('a calm dry hour has no hazard', () => assert.deepEqual(hourHazards(hour({}), L), []));
  test('likely rain, storms, gusts and deep cold are dangers', () => {
    assert.equal(hourHazards(hour({ precipProbability: 70 }), L)[0].risk, 'danger');
    assert.equal(hourHazards(hour({ weatherCode: 95 }), L)[0].text, 'thunderstorm');
    assert.equal(hourHazards(hour({ gustKmh: 50 }), L)[0].risk, 'danger');
    assert.equal(hourHazards(hour({ temperatureC: -25, dewSpreadC: 5 }), L)[0].risk, 'danger');
  });
  test('a small chance, frost and condensation call for care', () => {
    assert.equal(hourHazards(hour({ precipProbability: 30 }), L)[0].risk, 'caution');
    assert.match(hourHazards(hour({ temperatureC: -2, dewSpreadC: 1 }), L)[0].text, /^frost/);
    assert.match(hourHazards(hour({ dewSpreadC: 0.5, humidity: 98 }), L)[0].text, /^condensation/);
  });
});

describe('units', () => {
  test('imperial messages and reports convert from the metric the providers send', () => {
    const imp = unitFormat('imperial');
    assert.equal(imp.temp(0), '32°F');
    assert.equal(imp.tempDelta(1), '1.8°F');
    assert.equal(imp.speed(45), '28 mph');
    assert.equal(imp.precip(2.54), '0.100 in');
    assert.equal(imp.dist(20), '12 mi');
    const a = assess(ring(point({ gust: 60 }), [point({ mm: [0, 0.5] })]), LABELS, NOW, S, 'UTC', imp);
    assert.match(a.hazards.map((h) => h.message).join(' | '), /gusts to 37 mph within 60 min \(limit 28 mph\).*12 mi N/);
    assert.equal(unitFormat('metric').speed(45), '45 km/h');
  });
});
