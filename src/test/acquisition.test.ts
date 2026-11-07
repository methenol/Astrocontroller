import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { advise, rotationRate, subCycle, BG_MAX_FRAC, type SkySlice, type TargetInfo } from '../astro/acquisition/advise.js';
import { loadDevices, pickDevice, resolveRig, userDevicesDir, deviceById } from '../astro/acquisition/devices.js';
import { skyBrightness, zenithFromMeasured, airmass } from '../astro/acquisition/skyglow.js';
import { cadence, clipLevel, frameStats, measureLights, measureSensor, readRaw, greenPhase, stampOfName } from '../astro/acquisition/measure.js';
import { forget, latestSubLength, recordSensor, recordSubLength, resetStoreCache, sensorProfile } from '../astro/acquisition/store.js';
import { analyzeSubLength, bayerOffset, calibrationNameInfo, efficiencyOf, erfc, exGaussianMoments, fitExGaussian, minSubFor, nelderMead, normalCdf, referenceNoise, swampAt } from '../astro/acquisition/sublength.js';

const SITE = { lat: 31.5, lon: -99.4, elev: 450 };

/** A 16-bit FITS (BZERO 32768) of these ADU values, with header cards. */
function fits(width: number, height: number, adu: (x: number, y: number) => number, cards: Record<string, string | number> = {}): Buffer {
  const all: Record<string, string | number | boolean> = { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height, BZERO: 32768, BSCALE: 1, ...cards };
  const lines = Object.entries(all).map(([k, v]) => {
    const val = typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : typeof v === 'number' ? String(v).padStart(20) : `'${v.padEnd(8)}'`;
    return `${k.padEnd(8)}= ${val}`.padEnd(80);
  });
  lines.push('END'.padEnd(80));
  const header = Buffer.from(lines.join('').padEnd(Math.ceil(lines.length / 36) * 2880), 'latin1');
  const data = Buffer.alloc(Math.ceil((width * height * 2) / 2880) * 2880);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.writeInt16BE(Math.max(0, Math.min(65535, Math.round(adu(x, y)))) - 32768, (y * width + x) * 2);
  return Buffer.concat([header, data]);
}

/** A seeded normal deviate (Box–Muller over a small LCG): the same frames on every run. */
function gauss(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 1) / 4294967297;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const target = (o: Partial<TargetInfo> = {}): TargetInfo => ({ name: 'T', raHours: 0, decDeg: 0, type: 'G', sb: 22, emission: 'broadband', ...o });
const slices = (n: number, o: Partial<SkySlice> = {}): SkySlice[] => Array.from({ length: n }, (_, i) => ({ at: i * 900e3, altDeg: 50, azDeg: 120, moon: null, ...o }));

describe('device specs', () => {
  test('every shipped file is valid and the six models are there', () => {
    const { specs, errors } = loadDevices(true);
    assert.deepEqual(errors, []);
    for (const id of ['dwarf-3', 'dwarf-mini', 'seestar-s30', 'seestar-s30-pro', 'seestar-s50', 'seestar-s50-pro']) assert.ok(specs.some((s) => s.id === id), id);
  });

  test('the longest match wins: an S50 Pro is not an S50', () => {
    assert.equal(pickDevice({ driver: 'seestar', model: 'ZWO Seestar S50 Pro' }).spec.id, 'seestar-s50-pro');
    assert.equal(pickDevice({ driver: 'seestar', model: 'Seestar S50' }).spec.id, 'seestar-s50');
    assert.equal(pickDevice({ driver: 'dwarf', model: 'DWARF3_704420' }).spec.id, 'dwarf-3');
  });

  test('without a model name the optics pick it', () => {
    assert.equal(pickDevice({ driver: 'seestar', focalLengthMm: 160, chip: [2160, 3840] }).spec.id, 'seestar-s30-pro');
    assert.equal(pickDevice({ driver: 'seestar', focalLengthMm: 250, chip: [1080, 1920] }).spec.id, 'seestar-s50');
  });

  test("an owner's file replaces a shipped id and adds a new one; a broken file is reported", () => {
    const dir = userDevicesDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = JSON.parse(fs.readFileSync(path.join(config.paths.devices, 'seestar-s50.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'mine.json'), JSON.stringify({ ...base, id: 'seestar-s50', name: 'My S50' }));
    fs.writeFileSync(path.join(dir, 'new.json'), JSON.stringify({ ...base, id: 'my-scope', name: 'My Scope', match: ['my scope'] }));
    fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ id: 'Bad Id' }));
    try {
      const { errors } = loadDevices(true);
      assert.equal(deviceById('seestar-s50')?.name, 'My S50');
      assert.equal(deviceById('my-scope')?.user, true);
      assert.ok(errors.some((e) => e.includes('broken.json')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      loadDevices(true);
    }
  });

  test('the rig follows the scope: EQ mode opens the EQ subs, more_exposure the extended ones, the stack gain is the firmware\'s', () => {
    const altaz = resolveRig({ driver: 'seestar', model: 'S50 Pro', eqMode: false, gain: 200 });
    assert.deepEqual(altaz.subsS, [2, 5, 10, 20, 30]);
    const eq = resolveRig({ driver: 'seestar', model: 'S50 Pro', eqMode: true, moreExposure: true, gain: 200 });
    assert.deepEqual(eq.subsS, [2, 5, 10, 20, 30, 60, 90, 120]);
    assert.deepEqual(eq.gains, [200]);
    assert.ok(Math.abs(eq.plateScale - 2.3) < 0.01);
    // the wheel's slots name the filters, the dark slot is not one
    const wheel = resolveRig({ driver: 'seestar', model: 'S50 Pro', filterSlots: ['dark', 'IRCUT', 'LP'] });
    assert.deepEqual(wheel.filters.map((f) => f.name), ['IRCUT', 'LP']);
  });
});

describe('sky brightness', () => {
  test('no Moon: the zenith is the site, the horizon brighter', () => {
    assert.ok(Math.abs(skyBrightness({ zenithSqm: 21.5, altDeg: 90 }).sqm - 21.5) < 0.01);
    assert.ok(skyBrightness({ zenithSqm: 21.5, altDeg: 25 }).sqm < 21.2);
    assert.ok(airmass(30) > 1.85 && airmass(30) < 2.0);
  });

  test('a full Moon nearby costs magnitudes, a crescent far away little', () => {
    const full = skyBrightness({ zenithSqm: 21.5, altDeg: 50, moon: { altDeg: 50, sepDeg: 30, phaseAngleDeg: 5 } });
    const crescent = skyBrightness({ zenithSqm: 21.5, altDeg: 50, moon: { altDeg: 10, sepDeg: 120, phaseAngleDeg: 140 } });
    assert.ok(full.sqm < 18.8, `full Moon sky ${full.sqm}`);
    assert.ok(full.moonFraction > 0.9);
    assert.ok(crescent.sqm > 21);
  });

  test('a measured sky is turned back into the zenith moonless one', () => {
    const moon = { altDeg: 20, sepDeg: 90, phaseAngleDeg: 100 };
    const there = skyBrightness({ zenithSqm: 21.2, altDeg: 45, moon });
    const back = zenithFromMeasured({ sqmThere: there.sqm, altDeg: 45, moon });
    assert.ok(back !== null && Math.abs(back - 21.2) < 0.01);
    // a sky the Moon makes is not inverted
    assert.equal(zenithFromMeasured({ sqmThere: 18, altDeg: 45, moon: { altDeg: 50, sepDeg: 20, phaseAngleDeg: 0 } }), null);
  });
});

describe('advise', () => {
  test('field rotation: on the meridian high up it is fast, due east none', () => {
    assert.ok(rotationRate(31.5, 75, 180) > 3 * rotationRate(31.5, 30, 180));
    assert.ok(rotationRate(31.5, 45, 90) < 1e-12);
  });

  test('alt-az: a target crossing high on the meridian gets shorter subs than one low in the east', () => {
    const rig = resolveRig({ driver: 'dwarf', model: 'DWARF 3', eqMode: false });
    const high = advise({ rig, target: target(), site: SITE, slices: slices(8, { altDeg: 75, azDeg: 180 }), zenithSqm: 21, sqmSource: 't', usableMin: 120 });
    const east = advise({ rig, target: target(), site: SITE, slices: slices(8, { altDeg: 35, azDeg: 95 }), zenithSqm: 21, sqmSource: 't', usableMin: 120 });
    assert.ok(high.settings.subS < east.settings.subS, `${high.settings.subS} vs ${east.settings.subS}`);
    assert.ok(high.conditions.caps.some((c) => c.startsWith('field rotation')));
  });

  test('the sky background never exceeds its share of the range, however long the device allows', () => {
    const rig = resolveRig({ driver: 'seestar', model: 'S50 Pro', eqMode: true, moreExposure: true, gain: 200 });
    // a city sky under a nearly full Moon close by
    const r = advise({ rig, target: target({ sb: 21 }), site: SITE, slices: slices(8, { moon: { altDeg: 50, sepDeg: 25, phaseAngleDeg: 10 } }), zenithSqm: 18, sqmSource: 't', usableMin: 120 });
    assert.ok(r.overexposure.backgroundPct <= BG_MAX_FRAC * 100, `${r.overexposure.backgroundPct}%`);
    assert.ok(r.settings.subS < 120);
    // the same rig under a dark sky goes as long as it may
    const dark = advise({ rig, target: target({ sb: 21 }), site: SITE, slices: slices(8), zenithSqm: 21.9, sqmSource: 't', usableMin: 120 });
    assert.ok(dark.settings.subS >= 60, `${dark.settings.subS}`);
  });

  test('filters: a galaxy through the broadband glass, an emission nebula under a bright Moon through the line filter', () => {
    const rig = resolveRig({ driver: 'seestar', model: 'S50 Pro', eqMode: true, gain: 200 });
    const moon = { altDeg: 45, sepDeg: 40, phaseAngleDeg: 15 };
    const galaxy = advise({ rig, target: target({ sb: 22, emission: 'broadband' }), site: SITE, slices: slices(8, { moon }), zenithSqm: 21, sqmSource: 't', usableMin: 120 });
    assert.equal(galaxy.settings.filter, 'IRCUT');
    const nebula = advise({ rig, target: target({ sb: 22.5, type: 'HII', emission: 'Ha_dominant' }), site: SITE, slices: slices(8, { moon }), zenithSqm: 19.5, sqmSource: 't', usableMin: 120 });
    assert.equal(nebula.settings.filter, 'LP');
  });

  test("the owner's settings are held, and the answer predicts them", () => {
    const rig = resolveRig({ driver: 'dwarf', model: 'DWARF 3', eqMode: true });
    const r = advise({ rig, target: target(), site: SITE, slices: slices(4), zenithSqm: 21, sqmSource: 't', usableMin: 60, fixed: { filter: 'duo-band', gain: 80, subS: 30 } });
    assert.deepEqual([r.settings.filter, r.settings.gain, r.settings.subS], ['Duo-Band', 80, 30]);
    assert.ok(r.apply.startsWith('live_stacking action=start exposure=30 gain=80 filter=Duo-Band'));
  });

  test('a Dwarf with a known dark list is only offered covered exposure/gain pairs', () => {
    const rig = resolveRig({ driver: 'dwarf', model: 'DWARF 3', eqMode: true, darks: [{ exposureS: 30, gain: 60 }, { exposureS: 15, gain: 60 }] });
    const r = advise({ rig, target: target(), site: SITE, slices: slices(4), zenithSqm: 21.5, sqmSource: 't', usableMin: 60 });
    assert.ok([15, 30].includes(r.settings.subS) && r.settings.gain === 60, `${r.settings.subS}s g${r.settings.gain}`);
  });

  test('a dither that discards a sub is part of a sub\'s cost', () => {
    const rig = resolveRig({ driver: 'dwarf', model: 'DWARF 3', eqMode: true });
    // below 60 s every 6th, from 60 s every 10th
    assert.ok(Math.abs(subCycle(rig, 30).cycleS - (30.5 + 30.5 / 6)) < 1e-9);
    assert.equal(subCycle(rig, 60).ditherEvery, 10);
  });
});

describe('measurements', () => {
  const W = 320;
  const H = 240;
  const K = 0.5;
  const RN_E = 2;
  const BIAS = 500;

  test('the green phase follows the Bayer pattern', () => {
    assert.deepEqual(greenPhase('RGGB'), [1, 0]);
    assert.deepEqual(greenPhase('GRBG'), [0, 0]);
  });

  test('photon transfer recovers the conversion gain of a synthetic camera', () => {
    const skyE = 2000;
    const frames = [1, 2, 3].map((seed) => {
      const g = gauss(seed);
      const buf = fits(W, H, () => BIAS + (skyE + Math.sqrt(skyE + RN_E ** 2) * g()) / K, { EXPTIME: 30, GAIN: 100, BAYERPAT: 'RGGB', BIAS });
      return readRaw(buf, `light${seed}.fits`);
    });
    const r = measureLights(frames, { blackAt: (_t, f) => f.biasAdu!, readNoiseAdu: RN_E / K });
    for (const x of r) {
      assert.ok(x.ePerAdu !== null && Math.abs(x.ePerAdu - K) / K < 0.08, `K ${x.ePerAdu}`);
      assert.ok(Math.abs(x.skyAdu - (skyE / K) * 0.98) < 0.05 * (skyE / K), `sky ${x.skyAdu}`);
    }
  });

  test('darks give the read noise, the offset and the dark current', () => {
    const dcE = 0.5;
    const dark = (t: number, seed: number) => {
      const g = gauss(seed);
      return readRaw(fits(W, H, () => BIAS + (dcE * t + Math.sqrt(dcE * t + RN_E ** 2) * g()) / K, { EXPTIME: t, GAIN: 100, BAYERPAT: 'RGGB' }), `dark_${t}_${seed}.fits`);
    };
    const r = measureSensor([dark(1, 11), dark(1, 12), dark(41, 13), dark(41, 14)]);
    assert.ok(r.readNoiseAdu !== null && Math.abs(r.readNoiseAdu - Math.sqrt(dcE + RN_E ** 2) / K) < 0.4, `rn ${r.readNoiseAdu}`);
    assert.ok(Math.abs(r.biasAdu - BIAS) < 2, `bias ${r.biasAdu}`);
    assert.ok(r.darkAduPerS !== null && Math.abs(r.darkAduPerS - dcE / K) < 0.1, `dark ${r.darkAduPerS}`);
    assert.deepEqual(r.warnings, []);
  });

  test('a lit frame among darks is called out, a master gives no read noise', () => {
    const g = gauss(3);
    const lit = readRaw(fits(W, H, () => 5000 + 30 * g(), { EXPTIME: 10, GAIN: 100, BIAS }), 'lit.fits');
    assert.ok(measureSensor([lit]).warnings.some((w) => w.includes('looks lit')));
    const master = readRaw(fits(W, H, () => BIAS, { EXPTIME: 10, GAIN: 100 }), 'MasterDark_20_10s.fit');
    assert.equal(master.master, true);
    assert.equal(measureSensor([master]).readNoiseAdu, null);
  });

  test('a sub far darker than its cohort is left out', () => {
    const frames = [1, 2, 3].map((seed) => readRaw(fits(W, H, () => BIAS + (seed === 3 ? 5 : 1000) + 10 * gauss(seed)(), { EXPTIME: 30, GAIN: 100, BIAS }), `l${seed}.fits`));
    const r = measureLights(frames, { blackAt: () => BIAS, readNoiseAdu: 4 });
    assert.deepEqual(r.map((x) => x.outlier), [false, false, true]);
  });

  test('the clip level is the maximum many pixels share, and stats ignore clipped pixels', () => {
    const g = gauss(9);
    const f = readRaw(fits(W, H, (x, y) => (x < 20 && y < 20 ? 65535 : BIAS + 100 + 5 * g()), { EXPTIME: 10 }), 'stars.fits');
    const s = frameStats(f);
    assert.equal(clipLevel([s]), 65535);
    assert.ok(s.sigma < 10);
  });

  test('cadence: the per-sub overhead and the dither cost from the timestamps', () => {
    const at: number[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      at.push(t);
      t += 63e3 + (i % 5 === 4 ? 16e3 : 0);
    }
    const c = cadence(at.map((x) => ({ at: x, exposureS: 60 })));
    assert.deepEqual(c, { subs: 20, overheadS: 3, ditherEvery: 5, ditherCostS: 16 });
    // the stamps both makers put in their file names
    assert.equal(stampOfName('Light_M 31_60.0s_IRCUT_20261027-215123.fit'), Date.UTC(2026, 9, 27, 21, 51, 23));
    assert.equal(stampOfName('NGC 281_120s40_Duo-Band_20261031-221303387_41C.fits'), Date.UTC(2026, 9, 31, 22, 13, 3, 387));
    assert.equal(cadence(at.slice(0, 5).map((x) => ({ at: x, exposureS: 60 }))), null, 'too few subs for a cadence');
  });

  test('a black read off one long dark keeps its dark current, it is not added twice', () => {
    const dark = readRaw(fits(64, 64, () => 2272, { EXPTIME: 60, GAIN: 200 }), 'MasterDark_5_60.0s.fit');
    const r = measureSensor([dark]);
    assert.equal(r.biasAtS, 60);
    assert.equal(r.darkAduPerS, null);
  });

  test('a measured conversion gain and read noise replace the spec for that gain', () => {
    resetStoreCache();
    recordSensor('seestar-s50-pro', 'TESTSN', { gain: 200, ePerAdu: 0.03, readNoiseAdu: 40, blackAdu: 2000, at: Date.now(), frames: 4, how: 'test' }, { saturationAdu: 65000 });
    const rig = resolveRig({ driver: 'seestar', model: 'S50 Pro', serial: 'TESTSN', gain: 200 });
    const s = rig.sensorAt(200);
    assert.equal(s.ePerAdu, 0.03);
    assert.ok(Math.abs(s.readNoiseE - 1.2) < 1e-9);
    assert.equal(s.saturationAdu, 65000);
    assert.equal(s.source.ePerAdu, 'measured');
    assert.ok(!rig.missing.some((m) => m.startsWith('conversion gain')));
    assert.ok(sensorProfile('seestar-s50-pro', 'TESTSN'));
  });
});

describe('sub length (Deep Sky Detail method)', () => {
  const W = 320;
  const H = 240;
  /** a seeded uniform in (0, 1) */
  const uniform = (seed: number) => {
    let x = seed >>> 0;
    return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) + 1) / 4294967297;
  };

  test('the normal CDF and erfc are accurate', () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
    assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6);
    assert.ok(Math.abs(normalCdf(-3) - 0.0013499) < 1e-6);
    assert.ok(Math.abs(erfc(0.5) - 0.4795001) < 1e-6);
  });

  test('Nelder–Mead finds the minimum of a bowl', () => {
    const r = nelderMead((x) => (x[0] - 3) ** 2 + 2 * (x[1] + 1) ** 2 + 5, [0, 0]);
    assert.ok(r.converged);
    assert.ok(Math.abs(r.x[0] - 3) < 1e-4 && Math.abs(r.x[1] + 1) < 1e-4, `${r.x}`);
    assert.ok(Math.abs(r.fx - 5) < 1e-8);
  });

  test('the ex-Gaussian fit recovers mu, sigma and tau of a synthetic sample', () => {
    const g = gauss(21);
    const u = uniform(22);
    const xs = Float64Array.from({ length: 10_000 }, () => 500 + 12 * g() - 20 * Math.log(u()));
    const start = exGaussianMoments(xs);
    assert.ok(Math.abs(start.tau - 20) < 6, `moments tau ${start.tau}`);
    const f = fitExGaussian(xs);
    assert.ok(!f.fallback && f.converged, JSON.stringify(f));
    assert.ok(Math.abs(f.mu - 500) < 1.5, `mu ${f.mu}`);
    assert.ok(Math.abs(f.sigma - 12) < 1, `sigma ${f.sigma}`);
    assert.ok(Math.abs(f.tau - 20) < 1.5, `tau ${f.tau}`);
    // the same sample gives the same answer: no randomness anywhere
    assert.deepEqual(fitExGaussian(xs), f);
  });

  test('a bias frame gives the read noise by the SD/MAD rule; a master gives the level only; two darks their pair difference', () => {
    const BIAS = 500;
    const RN = 4;
    const g0 = gauss(31);
    const bias = readRaw(fits(W, H, () => BIAS + RN * g0(), { EXPTIME: 0.001, GAIN: 60, BAYERPAT: 'RGGB' }), 'bias_gain_60_bin_1.fits');
    const b = referenceNoise([bias], 'auto');
    assert.equal(b.readNoiseHow, 'bias frame (DSD rule)');
    assert.ok(Math.abs(b.readNoiseAdu! - RN) < 0.4, `rn ${b.readNoiseAdu}`);
    assert.ok(Math.abs(b.levelAdu - BIAS) < 1);
    // hot pixels: the SD blows up, the MAD does not
    const g = gauss(32);
    const hot = readRaw(fits(W, H, (x, y) => ((x * 7 + y * 13) % 97 === 0 ? 4000 : BIAS + RN * g()), { EXPTIME: 0.001, GAIN: 60 }), 'bias2.fits');
    const h = referenceNoise([hot], 'auto');
    assert.equal(h.how, 'mad');
    assert.ok(Math.abs(h.readNoiseAdu! - RN) < 0.5, `rn ${h.readNoiseAdu}`);
    // a master: the level, no read noise
    const master = readRaw(fits(W, H, (x, y) => BIAS + 20 + ((x + y) % 5), { BAYERPAT: 'RGGB' }), 'dark_exp_60.000000_gain_60_bin_1_39C_stack_20.fits');
    const m = referenceNoise([master], 'auto');
    assert.equal(m.readNoiseAdu, null);
    assert.equal(m.stackCount, 20);
    assert.equal(m.exposureS, 60);
    assert.ok(m.warnings.some((w) => w.includes('offset only')));
    // two single darks of one length: the pair difference cancels the fixed pattern
    const pattern = (x: number, y: number) => ((x * 3 + y) % 11) * 2;
    const g1 = gauss(33);
    const g2 = gauss(34);
    const d1 = readRaw(fits(W, H, (x, y) => BIAS + pattern(x, y) + RN * g1()), 'dark_exp_30.000000_gain_60_bin_1_28C_stack_1.fits');
    const d2 = readRaw(fits(W, H, (x, y) => BIAS + pattern(x, y) + RN * g2()), 'dark_exp_30.000000_gain_60_bin_1_29C_stack_1.fits');
    const p = referenceNoise([d1, d2], 'auto');
    assert.equal(p.readNoiseHow, 'pair difference of darks (dark-current noise included)');
    assert.ok(Math.abs(p.readNoiseAdu! - RN) < 0.5, `rn ${p.readNoiseAdu}`);
  });

  test('calibration file names of both makers are read', () => {
    assert.deepEqual(calibrationNameInfo('dark_exp_90.000000_gain_40_bin_1_39C_stack_20.fits'), { kind: 'dark', exposureS: 90, gain: 40, tempC: 39, stackCount: 20 });
    assert.deepEqual(calibrationNameInfo('bias_gain_2_bin_1.fits'), { kind: 'bias', exposureS: undefined, gain: 2, tempC: undefined, stackCount: undefined });
    assert.deepEqual(calibrationNameInfo('MasterDark_5_60.0s_15.0C_20261104-045913.fit'), { kind: 'dark', stackCount: 5, exposureS: 60, tempC: 15 });
    assert.equal(calibrationNameInfo('Light_NGC 6960_60.0s_LP_20260927-000730.fit').kind, 'light');
    assert.deepEqual(bayerOffset('GRBG', 'R'), [1, 0]);
    assert.deepEqual(bayerOffset('RGGB', 'B'), [1, 1]);
  });

  test('a sub whose sky noise is √10 × the read noise has a swamp factor of 10 and a 95% efficiency', () => {
    const BIAS = 500;
    const RN = 4;
    const K = 1; // e⁻/ADU
    const skyE = 160; // → Poisson noise √160 = 12.65 ADU, 10 × RN²
    const g = gauss(41);
    const light = readRaw(fits(W, H, () => BIAS + skyE + Math.sqrt(skyE + RN ** 2) * g(), { EXPTIME: 30, GAIN: 60, BAYERPAT: 'RGGB' }), 'light.fits');
    const r = analyzeSubLength({ light, readNoiseAdu: RN, levelAdu: BIAS, ePerAdu: K, swamp: 10 });
    assert.ok(!r.fit.fallback);
    assert.ok(Math.abs(r.skyNoiseAdu - Math.sqrt(skyE)) < 0.8, `sky noise ${r.skyNoiseAdu}`);
    assert.ok(Math.abs(r.swamp - 10) < 1.5, `swamp ${r.swamp}`);
    assert.ok(Math.abs(r.swampPoisson - 10) < 1, `swamp by level ${r.swampPoisson}`);
    assert.ok(Math.abs(r.minSubS! - 30) < 5, `min sub ${r.minSubS}`);
    assert.ok(Math.abs(r.efficiency - 0.953) < 0.01, `eff ${r.efficiency}`);
    assert.ok(Math.abs(r.extraIntegration - 1.1) < 0.03);
    assert.ok(Math.abs(r.background.aduPerS - skyE / 30) < 0.1);
    // the same frame again: identical numbers
    assert.deepEqual(analyzeSubLength({ light, readNoiseAdu: RN, levelAdu: BIAS, ePerAdu: K, swamp: 10 }), r);
    // a sub four times shorter needs four times as long to reach the factor, and read noise costs more
    const short = analyzeSubLength({ light, readNoiseAdu: RN, levelAdu: BIAS, ePerAdu: K, swamp: 10, durationS: 7.5 });
    assert.ok(Math.abs(short.minSubS! - r.minSubS! / 4) < 1e-9);
    assert.equal(minSubFor(5, RN, 160, 30), 15);
    assert.ok(Math.abs(swampAt(160 / 30, RN, 60) - 20) < 1e-9);
    assert.ok(efficiencyOf(0, RN).efficiency < 0.01);
    assert.ok(efficiencyOf(100, RN).efficiency > 0.999);
  });

  test('a narrowband reading counts the skew as sky; a frame of pure offset says so', () => {
    const BIAS = 500;
    const g = gauss(51);
    const u = uniform(52);
    const light = readRaw(fits(W, H, () => BIAS + 100 + 10 * g() - 15 * Math.log(u()), { EXPTIME: 60, BAYERPAT: 'RGGB' }), 'neb.fits');
    const bb = analyzeSubLength({ light, readNoiseAdu: 3, levelAdu: BIAS, ePerAdu: 1, narrowband: false });
    const nb = analyzeSubLength({ light, readNoiseAdu: 3, levelAdu: BIAS, ePerAdu: 1, narrowband: true });
    assert.ok(nb.skyNoiseAdu > bb.skyNoiseAdu && nb.background.levelAdu > bb.background.levelAdu);
    assert.ok(Math.abs(bb.skyNoiseOtherReadingAdu - nb.skyNoiseAdu) < 1e-9);
    const g3 = gauss(53);
    const flat = readRaw(fits(W, H, () => BIAS + 3 * g3(), { EXPTIME: 60 }), 'dark.fits');
    const d = analyzeSubLength({ light: flat, readNoiseAdu: 3.5, levelAdu: BIAS, ePerAdu: 1 });
    assert.ok(d.notes.some((n) => n.includes('no wider than the read noise')));
    assert.ok(d.minSubS === null || d.minSubS > 1000);
  });

  test('a stored analysis is the newest per filter and gain, within its age, and is forgotten per device', () => {
    resetStoreCache();
    const base = { device: 'seestar-s50-pro:SUBSN', filter: 'LP', gain: 200, subS: 60, frame: 'a.fit', narrowband: true, readNoiseAdu: 46, readNoiseSource: 'spec', skyNoiseAdu: 400, skyVarAduPerS: 2667, skyAduPerS: 65, swamp: 10.2, efficiency: 0.954, skyNoiseScale: 1.3 };
    recordSubLength({ ...base, at: Date.now() - 2 * 86400e3 });
    recordSubLength({ ...base, at: Date.now() - 86400e3, frame: 'b.fit', swamp: 9 });
    recordSubLength({ ...base, at: Date.now() - 400 * 86400e3, frame: 'old.fit', filter: 'IRCUT' });
    assert.equal(latestSubLength('seestar-s50-pro:SUBSN', 'lp', 200)?.frame, 'b.fit');
    assert.equal(latestSubLength('seestar-s50-pro', 'LP', 200)?.frame, 'b.fit', 'the model matches the unit');
    assert.equal(latestSubLength('seestar-s50-pro:SUBSN', 'LP', 100), undefined);
    assert.equal(latestSubLength('seestar-s50-pro:SUBSN', 'IRCUT', 200), undefined, 'too old');
    assert.ok(forget({ device: 'seestar-s50-pro:SUBSN', subLength: true }).some((d) => d.includes('3 sub-length samples')));
    assert.equal(latestSubLength('seestar-s50-pro:SUBSN', 'LP', 200), undefined);
  });

  test('advise quotes the swamp factor of its sub: the model\'s, or scaled from this rig\'s own analysed sub', () => {
    const rig = resolveRig({ driver: 'seestar', model: 'S50 Pro', eqMode: true, moreExposure: true, gain: 200 });
    const base = { rig, target: target(), site: SITE, slices: slices(8), zenithSqm: 19.5, sqmSource: 'test', usableMin: 120 };
    const model = advise({ ...base, swampFactor: 10 });
    assert.equal(model.subLength.source, 'model');
    assert.equal(model.subLength.wanted, 10);
    assert.ok(model.subLength.swamp > 0 && model.subLength.efficiencyPct > 0 && model.subLength.efficiencyPct <= 100);
    assert.ok(model.why.some((w) => w.startsWith('sub-length:')));
    // measured: the sky variance per second against the read noise, at whatever sub it picks
    const sample = { at: Date.now(), device: 'seestar-s50-pro', filter: 'IRCUT', gain: 200, subS: 30, frame: 'x.fit', narrowband: false, readNoiseAdu: 40, readNoiseSource: 'spec', skyNoiseAdu: 100, skyVarAduPerS: 10000 / 30, skyAduPerS: 50, swamp: 6.25, efficiency: 0.93, skyNoiseScale: 1 };
    const measured = advise({ ...base, swampFactor: 10, fixed: { filter: 'IRCUT', subS: 60 }, subLength: (f, g) => (f === 'IRCUT' && g === 200 ? sample : undefined) });
    assert.equal(measured.subLength.source, 'measured');
    assert.ok(Math.abs(measured.subLength.swamp - (10000 / 30) * 60 / 1600) < 0.06, `swamp ${measured.subLength.swamp}`);
    assert.equal(measured.subLength.minSubS, 48);
    assert.equal(measured.subLength.offeredSubS, 60);
    assert.equal(measured.subLength.measured?.frame, 'x.fit');
    // a sky-noise scale changes the merit of short subs against long ones: a noisier sky than modelled hurts short subs less
    const scaled = advise({ ...base, fixed: { filter: 'IRCUT' }, subLength: () => ({ ...sample, skyNoiseScale: 3 }) });
    const plain = advise({ ...base, fixed: { filter: 'IRCUT' } });
    assert.ok(scaled.why.some((w) => w.includes('scaled ×3')));
    assert.ok(scaled.integration.hoursTo.good > plain.integration.hoursTo.good, 'more sky noise, longer to a clean picture');
  });
});
