import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { readFits, superpixel } from '../media/fits.js';
import { analyze, autoStretch, crop, decode, devicePath, guessCamera, resolveLocalPath, type FloatImage } from '../media/images.js';

/** A FITS file: header cards padded to 2880, big-endian 16-bit data with BZERO 32768. */
function fits(width: number, height: number, values: number[], extra: Record<string, string> = {}): Buffer {
  const cards = { SIMPLE: 'T', BITPIX: '16', NAXIS: '2', NAXIS1: String(width), NAXIS2: String(height), BZERO: '32768', BSCALE: '1', ...extra };
  let h = Object.entries(cards).map(([k, v]) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80)).join('') + 'END'.padEnd(80);
  h = h.padEnd(Math.ceil(h.length / 2880) * 2880);
  const data = Buffer.alloc(Math.ceil((values.length * 2) / 2880) * 2880);
  values.forEach((v, i) => data.writeInt16BE(v - 32768, i * 2));
  return Buffer.concat([Buffer.from(h, 'ascii'), data]);
}

describe('FITS reader', () => {
  test('applies BZERO and reads the header', () => {
    const f = readFits(fits(2, 2, [0, 100, 4095, 65535], { BAYERPAT: "'RGGB    '" }));
    assert.deepEqual([...f.data], [0, 100, 4095, 65535]);
    assert.equal(f.bayer, 'RGGB');
    assert.equal(f.header.NAXIS1, 2);
  });

  test('a truncated file and a header without END are refused clearly', () => {
    const whole = fits(100, 100, new Array(10000).fill(10));
    assert.throws(() => readFits(whole.subarray(0, 2880 + 100)), /truncated: 100 of 20000 bytes/);
    assert.throws(() => readFits(whole.subarray(0, 400)), /no END card/);
  });

  test('a header claiming an impossible size or a non-numeric BZERO is refused', () => {
    assert.throws(() => readFits(fits(2, 2, [0, 0, 0, 0], { NAXIS1: '100000', NAXIS2: '100000' })), /header is corrupt/);
    assert.throws(() => readFits(fits(2, 2, [0, 0, 0, 0], { NAXIS1: '1.5' })), /no 2D image/);
    assert.throws(() => readFits(fits(2, 2, [0, 0, 0, 0], { BZERO: "'x'" })), /BZERO\/BSCALE/);
  });

  test('superpixel debayer puts R, mean G and B where the pattern says', () => {
    const f = readFits(fits(2, 2, [10, 20, 30, 40], { BAYERPAT: "'RGGB'" }));
    assert.deepEqual([...superpixel(f).rgb], [10, 25, 40]);
    const g = readFits(fits(2, 2, [10, 20, 30, 40], { BAYERPAT: "'BGGR'" }));
    assert.deepEqual([...superpixel(g).rgb], [40, 25, 10]);
  });

  test('a float master with NaN, infinite and negative pixels decodes to finite values in 0..1', async () => {
    const cards = { SIMPLE: 'T', BITPIX: '-32', NAXIS: '2', NAXIS1: '2', NAXIS2: '2' };
    let h = Object.entries(cards).map(([k, v]) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80)).join('') + 'END'.padEnd(80);
    h = h.padEnd(2880);
    const data = Buffer.alloc(2880);
    [Number.NaN, Number.POSITIVE_INFINITY, -50, 2000].forEach((v, i) => data.writeFloatBE(v, i * 4));
    const img = await decode(Buffer.concat([Buffer.from(h, 'ascii'), data]), 'master.fits');
    assert.deepEqual([...img.data].map((v) => Math.round(v * 4095)), [0, 4095, 0, 2000]);
  });

  test('a Bayer frame too small for one cell is read as mono, not as an empty image', async () => {
    const img = await decode(fits(1, 3, [100, 200, 300], { BAYERPAT: "'RGGB'" }), 'x.fits');
    assert.deepEqual({ w: img.width, h: img.height, ch: img.channels, n: img.data.length }, { w: 1, h: 3, ch: 1, n: 3 });
  });

  test('12-bit data is scaled to its own range, not 16-bit', async () => {
    const img = await decode(fits(2, 2, [0, 1000, 2000, 4095]), 'x.fits');
    assert.equal(img.linear, true);
    assert.ok(Math.abs(img.data[3] - 1) < 1e-6);
  });
});

describe('local paths', () => {
  let dir: string;
  const saved = { ...config.paths };
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-img-'));
    for (const d of ['library', 'library2', 'captures', 'ws']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'library', 'a.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'library2', 'b.jpg'), 'x');
    Object.assign(config.paths, { library: path.join(dir, 'library'), captures: path.join(dir, 'captures'), workspace: path.join(dir, 'ws') });
  });
  after(() => {
    Object.assign(config.paths, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('files inside the roots resolve', () => {
    assert.equal(resolveLocalPath('a.jpg'), path.join(dir, 'library', 'a.jpg'));
    assert.equal(resolveLocalPath(path.join(dir, 'library', 'a.jpg')), path.join(dir, 'library', 'a.jpg'));
  });

  test('nothing outside them does, by .. or by a look-alike prefix', () => {
    assert.throws(() => resolveLocalPath('../library2/b.jpg'), /leaves the library/);
    assert.throws(() => resolveLocalPath(path.join(dir, 'library2', 'b.jpg')), /outside the library/);
    assert.throws(() => resolveLocalPath('/etc/passwd'), /outside the library/);
  });

  test('nor through a symlink inside a root', () => {
    fs.symlinkSync(path.join(dir, 'library2', 'b.jpg'), path.join(dir, 'library', 'link.jpg'));
    assert.throws(() => resolveLocalPath('link.jpg'), /links outside/);
    assert.throws(() => resolveLocalPath(path.join(dir, 'library', 'link.jpg')), /outside the library/);
  });

  test('device paths go under /DWARF3 and never up', () => {
    assert.equal(devicePath('Astronomy/x.fits'), '/DWARF3/Astronomy/x.fits');
    assert.equal(devicePath('/DWARF3/a.jpg'), '/DWARF3/a.jpg');
    assert.throws(() => devicePath('/DWARF3/../etc'), /bad device path/);
  });
});

describe('pixel operations', () => {
  const ramp = (): FloatImage => {
    const data = new Float32Array(10 * 10);
    for (let i = 0; i < data.length; i++) data[i] = i / 100;
    return { width: 10, height: 10, channels: 1, data, linear: true, source: 'ramp' };
  };

  test('a crop past the edge is clamped to the frame', () => {
    const c = crop(ramp(), { x: 50, y: 50, width: 20, height: 20 });
    assert.equal(c.width, 1);
    assert.equal(c.height, 1);
    assert.ok(Math.abs(c.data[0] - 0.99) < 1e-6);
    const n = crop(ramp(), { x: 0.5, y: 0, width: 0.5, height: 0.2 });
    assert.equal(n.width, 5);
    assert.equal(n.height, 2);
  });

  test('a crop with a non-finite, negative or empty region is refused clearly', () => {
    for (const c of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: -1, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: Infinity, height: 1 }]) {
      assert.throws(() => crop(ramp(), c), /crop needs/);
    }
  });

  test('stretching a saturated or flat frame gives finite values', () => {
    for (const fill of [1, 0, 0.3]) {
      const img: FloatImage = { width: 20, height: 20, channels: 1, data: new Float32Array(400).fill(fill), linear: true, source: 'flat' };
      const s = autoStretch(img);
      assert.ok([...s.data].every(Number.isFinite), `fill ${fill}`);
    }
  });

  test('a stretch strength the midtone solve cannot use is clamped, not turned into a white or black frame', () => {
    const data = new Float32Array(400);
    for (let i = 0; i < data.length; i++) data[i] = 0.05 + (i % 7) * 0.01;
    const img: FloatImage = { width: 20, height: 20, channels: 1, data, linear: true, source: 'sky' };
    for (const strength of [0, 5, 10, NaN]) {
      const v = [...autoStretch(img, strength).data];
      assert.ok(v.every(Number.isFinite), `strength ${strength}`);
      // brighter input stays brighter: not collapsed to one value
      assert.ok(v[6] > v[0] && v[6] < 1 && v[0] > 0, `strength ${strength} keeps the tonal range (${v[0]}..${v[6]})`);
    }
  });
});

describe('which lens took an image', () => {
  test('the session folder decides, whatever folders it sits in', () => {
    assert.equal(guessCamera('/home/me/telescope/library/DWARF_RAW_WIDE_M 31_EXP_15_GAIN_60_2026-10-01-22-20-58-268/a.fits'), 'wide');
    assert.equal(guessCamera('/data/wide-field/DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268/a.fits'), 'tele');
    assert.equal(guessCamera('/DWARF3/Astronomy/CALI_FRAME/dark/cam_1/dark_exp_15.fits'), 'wide');
    assert.equal(guessCamera('/DWARF3/Astronomy/CALI_FRAME/dark/cam_0/dark_exp_15.fits'), 'tele');
    assert.equal(guessCamera('wide'), 'wide');
    assert.equal(guessCamera('stack'), 'tele');
    assert.equal(guessCamera('captures/agent/2026_tele_live.jpg'), 'tele');
    assert.equal(guessCamera('/home/me/telescope/photo.jpg'), undefined);
  });
});

describe('image analysis', () => {
  test('a dense field is measured on its brightest stars, wherever they are in the frame', () => {
    const W = 1600, H = 1000;
    const data = new Float32Array(W * H).fill(0.1);
    const star = (cx: number, cy: number, amp: number, s: number) => {
      for (let y = Math.max(0, cy - 8); y <= Math.min(H - 1, cy + 8); y++) {
        for (let x = Math.max(0, cx - 8); x <= Math.min(W - 1, cx + 8); x++) data[y * W + x] += amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
      }
    };
    // ~9,000 faint, tight peaks fill the top of the frame (more than the measurement cap)
    for (let y = 10; y < 380; y += 8) for (let x = 10; x < W - 10; x += 8) star(x, y, 0.05, 0.8);
    // the bright, wider stars are all in the bottom half
    for (let y = 450; y < H - 20; y += 30) for (let x = 20; x < W - 20; x += 30) star(x, y, 0.6, 2.5);
    const a = analyze({ width: W, height: H, channels: 1, data, linear: true, source: 'synthetic' });
    assert.ok(a.stars.medianHfrPx !== undefined && a.stars.medianHfrPx > 2, `median HFR ${a.stars.medianHfrPx} is the bright stars'`);
    assert.ok(a.stars.brightest!.every((s) => s.y >= 450), 'the brightest listed are the bright ones');
  });

  test('a crop keeps the whole frame\'s plate scale, so its arcsec figures match the frame\'s', () => {
    const W = 1920, H = 1080;
    const data = new Float32Array(W * H).fill(0.1);
    for (let cy = 40; cy < H - 40; cy += 60) {
      for (let cx = 40; cx < W - 40; cx += 60) {
        for (let y = cy - 8; y <= cy + 8; y++) for (let x = cx - 8; x <= cx + 8; x++) data[y * W + x] += 0.5 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 8);
      }
    }
    const whole: FloatImage = { width: W, height: H, channels: 1, data, linear: true, source: 'synthetic', camera: 'tele' };
    const a = analyze(whole);
    const c = analyze(crop(crop(whole, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }), { x: 0, y: 0, width: 0.5, height: 0.5 }));
    assert.equal(a.plateScaleArcsecPerPx, 5.53);
    assert.equal(c.plateScaleArcsecPerPx, a.plateScaleArcsecPerPx, 'a crop of a crop too');
    assert.equal(c.stars.medianFwhmArcsec, a.stars.medianFwhmArcsec);
  });
});
