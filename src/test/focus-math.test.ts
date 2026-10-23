import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FloatImage } from '../media/images.js';
import { starSharpness, sweepPositions, fitMinimum, checkSweepOptions, type FocusSample } from '../media/focus.js';
import { FOCUS_MAX } from '../drivers/dwarf/device.js';

/** A linear mono frame with Gaussian stars of one width on a flat, slightly noisy sky. */
function starField(sigmaPx: number, o: { w?: number; h?: number; stars?: number; seed?: number } = {}): FloatImage {
  const W = o.w ?? 400;
  const H = o.h ?? 300;
  const data = new Float32Array(W * H);
  let s = o.seed ?? 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < data.length; i++) data[i] = 0.05 + (rnd() - 0.5) * 0.002;
  const n = o.stars ?? 25;
  for (let k = 0; k < n; k++) {
    const cx = 40 + ((k * 73) % (W - 80));
    const cy = 40 + ((k * 151) % (H - 80));
    const amp = 0.3 + 0.4 * rnd();
    const R = Math.ceil(sigmaPx * 5);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      data[y * W + x] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigmaPx * sigmaPx));
    }
  }
  return { width: W, height: H, channels: 1, data, linear: true, source: 'synthetic' };
}

describe('star sharpness', () => {
  test('options it cannot work with are refused, not turned into a meaningless reading', () => {
    const f = starField(1.5);
    for (const o of [{ aperturePx: 0 }, { aperturePx: NaN }, { aperturePx: 1000 }, { maxStars: 0 }, { maxStars: 2.5 }, { thresholdSigma: -1 }, { minStarSnr: NaN }, { arcsecPerPx: 0 }]) {
      assert.throws(() => starSharpness(f, o), /star sharpness:/, JSON.stringify(o));
    }
    assert.ok(starSharpness(f, { aperturePx: 10, maxStars: 30 }).ok);
  });

  test('sharper stars score higher and their HFR tracks the profile width', () => {
    const sharp = starSharpness(starField(1.2));
    const soft = starSharpness(starField(2.5));
    assert.ok(sharp.ok && soft.ok, `${sharp.blocking ?? ''} ${soft.blocking ?? ''}`);
    assert.ok(sharp.hfrPx < soft.hfrPx);
    assert.ok(sharp.score > soft.score);
    // HFR of a Gaussian is σ·√(π/2) ≈ 1.25σ
    assert.ok(Math.abs(soft.hfrPx - 2.5 * 1.2533) < 0.6, `hfr ${soft.hfrPx}`);
    assert.ok(sharp.roundness > 0.85);
  });

  test('the reading does not move with the brightness of the stars', () => {
    const a = starField(1.8);
    const b = starField(1.8);
    for (let i = 0; i < b.data.length; i++) b.data[i] = 0.05 + (b.data[i] - 0.05) * 0.4;
    const ra = starSharpness(a);
    const rb = starSharpness(b);
    assert.ok(ra.ok && rb.ok);
    assert.ok(Math.abs(ra.hfrPx - rb.hfrPx) < 0.15, `${ra.hfrPx} vs ${rb.hfrPx}`);
  });

  test('a flat frame and a tiny region give no reading, with the reason', () => {
    const flat: FloatImage = { width: 200, height: 200, channels: 1, data: new Float32Array(40000).fill(0.1), linear: true, source: 'flat' };
    const r = starSharpness(flat);
    assert.equal(r.ok, false);
    assert.match(r.blocking!, /blank\/flat frame/);
    const small = starSharpness(starField(1.5), { crop: { x: 0, y: 0, width: 0.05, height: 0.05 } });
    assert.equal(small.ok, false);
    assert.match(small.blocking!, /too small/);
  });

  test('a dense field is measured on its brightest stars, wherever they are in the frame', () => {
    const W = 800;
    const H = 600;
    const data = new Float32Array(W * H).fill(0.05);
    const blob = (cx: number, cy: number, amp: number, sigma: number) => {
      const R = Math.ceil(sigma * 5);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) data[y * W + x] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      }
    };
    // thousands of faint tight peaks across the top, more than the detector measures
    for (let y = 40; y < 200; y += 6) for (let x = 40; x < W - 40; x += 6) blob(x, y, 0.05, 0.8);
    // the stars worth measuring: bright and wider, at the bottom
    for (let k = 0; k < 16; k++) blob(80 + (k % 8) * 85, 420 + Math.floor(k / 8) * 90, 0.5, 2);
    const r = starSharpness({ width: W, height: H, channels: 1, data, linear: true, source: 'dense' }, { maxStars: 16 });
    assert.ok(r.ok, r.blocking);
    assert.ok(r.starsDetected > 900, `detected ${r.starsDetected}`);
    assert.ok(Math.abs(r.hfrPx - 2 * 1.2533) < 0.6, `hfr ${r.hfrPx}: measured the faint top band instead of the bright stars`);
  });

  test('an 8-bit sky that sits on one code does not turn one-code bumps into stars', () => {
    const W = 400;
    const H = 300;
    const data = new Float32Array(W * H * 3).fill(10 / 255);
    // scattered single-code bumps: quantisation, not starlight
    for (let k = 0; k < 400; k++) {
      const px = ((k * 7919) % (W * H)) * 3;
      data[px] = data[px + 1] = data[px + 2] = 11 / 255;
    }
    // one bright pixel keeps the frame from reading as blank
    data[(150 * W + 200) * 3] = 1;
    const r = starSharpness({ width: W, height: H, channels: 3, data, linear: false, source: 'synthetic8' });
    assert.equal(r.ok, false);
    assert.ok(r.starsDetected < 3, `${r.starsDetected} detections`);
  });

  test('8-bit frames with out-of-range values do not break the lookup', () => {
    const img = starField(1.5);
    const rgb: FloatImage = { ...img, channels: 3, linear: false, data: new Float32Array(img.data.length * 3) };
    for (let i = 0; i < img.data.length; i++) rgb.data[3 * i] = rgb.data[3 * i + 1] = rgb.data[3 * i + 2] = Math.min(1.2, img.data[i] * 1.5);
    const r = starSharpness(rgb);
    assert.ok(Number.isFinite(r.hfrPx));
  });
});

describe('sweep planning', () => {
  test('positions alternate outward from the centre', () => {
    assert.deepEqual(sweepPositions(500, { range: 10, step: 5 }).positions, [500, 495, 505, 490, 510]);
  });

  test('positions outside the focuser travel are dropped', () => {
    const { positions } = sweepPositions(FOCUS_MAX - 3, { range: 10, step: 5 });
    assert.ok(positions.every((p) => p >= 0 && p <= FOCUS_MAX));
    const explicit = sweepPositions(0, { positions: [-5, 10, 10, FOCUS_MAX + 1, 3] });
    assert.deepEqual(explicit.positions, [3, 10]);
    assert.equal(explicit.notes.length, 2);
  });

  test('the step widens to stay under the sample cap', () => {
    const r = sweepPositions(400, { range: 100, step: 2, maxPoints: 11 });
    assert.ok(r.positions.length <= 11);
    assert.match(r.notes[0], /step widened/);
  });
});

describe('fitting the minimum', () => {
  const s = (position: number, hfrPx: number): FocusSample => ({ position, hfrPx, score: 0, hfrUncertaintyPx: 0, stars: 10, saturated: 0, seconds: 1 });

  test('finds the vertex of a parabola between the samples', () => {
    // hfr = (p - 501)² / 50 + 2
    const f = (p: number) => ((p - 501) ** 2) / 50 + 2;
    const v = fitMinimum([s(495, f(495)), s(500, f(500)), s(505, f(505))], 1);
    assert.ok(v !== null && Math.abs(v - 501) < 0.01, String(v));
  });

  test('unequally spaced samples (where the focuser actually stopped) fit the same vertex', () => {
    const f = (p: number) => ((p - 503) ** 2) / 50 + 2;
    const v = fitMinimum([s(490, f(490)), s(502, f(502)), s(506, f(506))], 1);
    assert.ok(v !== null && Math.abs(v - 503) < 0.01, String(v));
  });

  test('refuses when the middle is not a minimum or a neighbour failed', () => {
    assert.equal(fitMinimum([s(495, 2), s(500, 3), s(505, 4)], 1), null);
    assert.equal(fitMinimum([{ ...s(495, 3), error: 'x' }, s(500, 2), s(505, 3)], 1), null);
    assert.equal(fitMinimum([s(500, 2), s(505, 3)], 0), null);
  });
});

describe('sweep options', () => {
  test('values that cannot describe a sweep are refused before anything moves', () => {
    for (const o of [{ step: NaN }, { range: 0 }, { center: -1 }, { center: Infinity }, { positions: [10, NaN] }, { exposureS: 0 }, { repeats: 0 }, { settleMs: -5 }, { maxPoints: 2 }, { deadlineMs: 0 }]) {
      assert.throws(() => checkSweepOptions(o), /focus sweep:/, JSON.stringify(o));
    }
    assert.doesNotThrow(() => checkSweepOptions({ center: 400, range: 40, step: 4, repeats: 2 }));
  });
});

describe('median', () => {
  test('an even count is the mean of the two middle values; odd is the middle; empty is NaN', async () => {
    const { median } = await import('../util/stats.js');
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([2.0, 3.0]), 2.5, 'two repeats at one focus position average, not the larger HFR');
    assert.ok(Number.isNaN(median([])));
  });
});
