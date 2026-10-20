import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skyVerdict } from '../mcp/tools/planning.js';

describe('sky_check verdict', () => {
  const night = { blank: false, background: 0.08, sunAltDeg: -30, altitudeDeg: 60 };

  test('no stars at night, pointing up: cloudy; many: clear; some: partly clear', () => {
    assert.equal(skyVerdict({ ...night, stars: 0 }), 'cloudy (no usable stars)');
    assert.equal(skyVerdict({ ...night, stars: 80 }), 'clear');
    assert.equal(skyVerdict({ ...night, stars: 15 }), 'partly clear / thin cloud');
  });

  test('no stars in daylight is not "cloudy" (2026-10-12: parked, Sun at 23°, the check said cloudy under a clear sky)', () => {
    assert.match(skyVerdict({ ...night, stars: 0, sunAltDeg: 23 }), /^unknown: the Sun is up \(23°\)/);
    assert.match(skyVerdict({ ...night, stars: 0, sunAltDeg: -3 }), /^unknown: the Sun is only just set/);
    assert.equal(skyVerdict({ ...night, stars: 80, sunAltDeg: -3 }), 'clear', 'stars seen in twilight still count');
  });

  test('pointing below the horizon (parked) says so', () => {
    assert.match(skyVerdict({ ...night, stars: 0, altitudeDeg: -87 }), /^unknown: the scope points below the horizon \(altitude -87°\)/);
  });

  test('a blank frame and a bright sky keep their verdicts', () => {
    assert.equal(skyVerdict({ ...night, stars: 0, blank: true }), 'invalid frame (blank)');
    assert.match(skyVerdict({ ...night, stars: 0, background: 0.9 }), /^too bright/);
  });
});
