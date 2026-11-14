import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FloatImage } from '../media/images.js';
import type { Seestar } from '../drivers/seestar/device.js';
import { seestarFocusSweep } from '../drivers/seestar/focus.js';

/** A linear mono frame with Gaussian stars of one width on a flat, slightly noisy sky. */
function starField(sigmaPx: number, W: number, H: number): FloatImage {
  const data = new Float32Array(W * H);
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < data.length; i++) data[i] = 0.05 + (rnd() - 0.5) * 0.002;
  for (let k = 0; k < 25; k++) {
    const cx = 30 + ((k * 73) % (W - 60));
    const cy = 30 + ((k * 151) % (H - 60));
    const amp = 0.3 + 0.4 * rnd();
    const R = Math.ceil(sigmaPx * 5);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      data[y * W + x] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigmaPx * sigmaPx));
    }
  }
  return { width: W, height: H, channels: 1, data, linear: true, source: 'synthetic', frameWidth: W };
}

const FULL_W = 400;
const FULL_H = 300;
const TRUE_FOCUS = 900;

/**
 * Just what the sweep touches on a Seestar. The first `binnedFrames` frames after the start come at
 * bin 2 (half the width) with tight-looking stars, as on 2026-11-14 C 34: small in px, so a sweep
 * that compares px HFR across bins picks them.
 */
function stubScope(o: { binnedFrames: number; chipKnown: boolean }) {
  let pos = 897;
  let left = o.binnedFrames;
  const calls = { applyBin: 0 };
  const scope = {
    state: {
      mount: { parked: false },
      focus: { maxStep: 2600 },
      fov: { h: (FULL_W * 2.3) / 3600, v: (FULL_H * 2.3) / 3600 },
      device: o.chipKnown ? { chipSize: [FULL_W, FULL_H] } : {},
    },
    isBusy: () => null,
    ensureLiveView: async () => null,
    withCamera: <T>(_c: string, _w: string, run: () => Promise<T>) => run(),
    withFullRes: <T>(_c: string, _w: string, run: () => Promise<T>) => run(),
    applyBin: async () => { calls.applyBin++; return true; },
    focuserPosition: async () => pos,
    focusTo: async (p: number) => (pos = p),
    grabImage: async () => {
      if (left > 0) {
        left--;
        return { image: starField(0.9, FULL_W / 2, FULL_H / 2) };
      }
      return { image: starField(1.4 + 0.25 * Math.abs(pos - TRUE_FOCUS), FULL_W, FULL_H) };
    },
  };
  return { scope: scope as unknown as Seestar, calls };
}

describe('Seestar star focus: binned frames never decide the sweep', () => {
  test('bin-2 frames still arriving after the switch to bin 1 are discarded, and the peak is the full-res one', async () => {
    const { scope, calls } = stubScope({ binnedFrames: 7, chipKnown: true });
    const r = await seestarFocusSweep(scope, { center: 897, range: 4, step: 1, settleMs: 0 });
    for (const s of r.samples) assert.ok(!s.error, `${s.position}: ${s.error}`);
    for (const s of r.samples) assert.ok(Math.abs((s.arcsecPerPx ?? 0) - 2.3) < 0.05, `${s.position} at ${s.arcsecPerPx}″/px`);
    assert.equal(r.best.position, TRUE_FOCUS);
    assert.equal(r.bestAtEdge, false);
    assert.equal(r.finalPosition, TRUE_FOCUS);
    assert.ok(calls.applyBin >= 1, 'bin 1 is asked for again while binned frames keep coming');
  });

  test('binned samples that get through (sensor size unknown) are left out, not taken as the sharpest', async () => {
    const { scope } = stubScope({ binnedFrames: 6, chipKnown: false });
    const r = await seestarFocusSweep(scope, { center: 897, range: 4, step: 1, settleMs: 0 });
    const out = r.samples.filter((s) => s.error);
    assert.ok(out.length >= 2, 'the binned samples are marked');
    for (const s of out) assert.match(s.error!, /binned/);
    assert.equal(r.best.position, TRUE_FOCUS);
    assert.equal(r.bestAtEdge, false);
    assert.ok(r.notes.some((n) => /binned frames/.test(n)));
  });

  test('a peak next to left-out samples is still at the edge of what was measured', async () => {
    const { scope } = stubScope({ binnedFrames: 6, chipKnown: false });
    // sweep 900–908: 900–902 come back binned and are left out, so 903 is the lowest measured
    // sample and the sharpest; focus may lie below it, so it is an edge peak to sweep again from
    const r = await seestarFocusSweep(scope, { center: 904, range: 4, step: 1, settleMs: 0 });
    assert.deepEqual(r.samples.filter((s) => s.error).map((s) => s.position), [900, 901, 902]);
    assert.equal(r.best.position, 903);
    assert.equal(r.bestAtEdge, true);
  });
});
