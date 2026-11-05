import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { altAz, raDecFromAltAz } from '../astro/sky.js';
import { planNight } from '../astro/planner.js';
import { clearMasks, describeMask, horizonOf, limitAt, maskFor, parseHorizonText, saveMask, toHorizonText, unknownSectors, type HorizonMask } from '../astro/horizon.js';
import { angleDeg, cameraGeom, fitMount, fromAltAz, pixelToDir, poseBasis, poseFor, toAltAz, type Anchor, type MountModel } from '../media/horizon/geometry.js';
import { buildPanorama, frameEvidence, profileOf, skyline, skyLevelOf, type PanoFrame } from '../media/horizon/mask.js';
import { cappedAzimuths } from '../media/horizon/survey.js';
import { frameBasis, mountPole, WIDE_HFOV_DEG } from '../drivers/seestar/survey.js';
import { FrameKeeper, loadSurvey, resolveSurvey } from '../media/horizon/solve.js';
import type { FloatImage } from '../media/images.js';

const RANGES = { rotation: [0, 315] as const, pitch: [0, 195] as const };
const SITE = { lat: 45.5, lon: -122.6, elev: 50 };

describe('survey geometry', () => {
  test('alt-az ↔ vectors round-trip', () => {
    for (const [az, alt] of [[0, 0], [90, 30], [271.5, 62], [359.9, -5]]) {
      const back = toAltAz(fromAltAz(az, alt));
      assert.ok(Math.abs(back.az - az) < 1e-9 && Math.abs(back.alt - alt) < 1e-9);
    }
  });

  test('alt-az head: pitch 90 is the horizon, rotation decreasing pans toward increasing azimuth', () => {
    const m: MountModel = { pole: { az: 0, alt: 90 }, lambda0: 100, sense: -1, pitchOffset: 0 };
    const a = toAltAz(poseBasis(m, 0, 90).b);
    assert.ok(Math.abs(a.alt) < 1e-9 && Math.abs(a.az - 100) < 1e-9);
    assert.ok(Math.abs(toAltAz(poseBasis(m, 10, 150).b).az - 90) < 1e-9);
    assert.ok(Math.abs(toAltAz(poseBasis(m, 10, 150).b).alt - 60) < 1e-9);
    // the camera's right is clockwise along the horizon (toward increasing azimuth)
    const { b, r } = poseBasis(m, 50, 100);
    assert.ok(toAltAz([b[0] + 0.01 * r[0], b[1] + 0.01 * r[1], b[2] + 0.01 * r[2]]).az > toAltAz(b).az);
  });

  test('poseFor inverts poseBasis on the alt-az head and on an EQ wedge', () => {
    const models: MountModel[] = [
      { pole: { az: 0, alt: 90 }, lambda0: 37, sense: -1, pitchOffset: 1.5 },
      { pole: { az: 0, alt: 40 }, lambda0: 210, sense: 1, pitchOffset: -2 },
    ];
    for (const m of models) {
      for (const [rot, pitch] of [[10, 100], [150, 140], [300, 175], [200, 120]]) {
        const v = poseBasis(m, rot, pitch).b;
        const p = poseFor(m, v, RANGES);
        assert.ok(p, `pose for rot ${rot} pitch ${pitch}`);
        assert.ok(angleDeg(poseBasis(m, p.rotationDeg, p.pitchDeg).b, v) < 0.02);
      }
    }
    // the alt-az head cannot reach behind its rotation stops
    const m = models[0];
    assert.equal(poseFor(m, poseBasis(m, 340, 120).b, RANGES), null);
  });

  test('fitMount recovers the mount from plate-solved anchors, both heads', () => {
    const cases: Array<{ m: MountModel; poses: Array<[number, number]> }> = [
      { m: { pole: { az: 0, alt: 90 }, lambda0: 123.4, sense: -1, pitchOffset: 1.7 }, poses: [[40, 155], [160, 157]] },
      { m: { pole: { az: 2, alt: 29 }, lambda0: 251.3, sense: 1, pitchOffset: -2.3 }, poses: [[60, 140], [150, 150], [250, 130]] },
    ];
    for (const { m, poses } of cases) {
      const anchors: Anchor[] = poses.map(([rotationDeg, pitchDeg]) => ({ rotationDeg, pitchDeg, ...toAltAz(poseBasis(m, rotationDeg, pitchDeg).b) }));
      const fit = fitMount(m.pole, anchors);
      assert.equal(fit.model.sense, m.sense);
      assert.ok(Math.abs(fit.model.lambda0 - m.lambda0) < 0.05, `λ0 ${fit.model.lambda0}`);
      assert.ok(Math.abs(fit.model.pitchOffset - m.pitchOffset) < 0.05, `offset ${fit.model.pitchOffset}`);
      assert.ok(fit.residualDeg < 0.05);
    }
  });

  test('anchors that disagree show as a large residual', () => {
    const m: MountModel = { pole: { az: 0, alt: 90 }, lambda0: 50, sense: -1, pitchOffset: 0 };
    const anchors: Anchor[] = [[40, 155], [160, 157]].map(([rotationDeg, pitchDeg]) => ({ rotationDeg, pitchDeg, ...toAltAz(poseBasis(m, rotationDeg, pitchDeg).b) }));
    // the second anchor's rotation reset came back 15° off
    anchors[1].rotationDeg += 15;
    assert.ok(fitMount(m.pole, anchors).residualDeg > 3);
  });

  test('a GoTo target for an azimuth and altitude lands there', () => {
    const when = new Date('2026-10-20T06:00:00Z');
    for (const [az, alt] of [[45, 65], [200, 30], [330, 70]]) {
      const { raHours, decDeg } = raDecFromAltAz(SITE, az, alt, when);
      const back = altAz(SITE, raHours, decDeg, when);
      assert.ok(Math.abs(back.azimuth - az) < 0.01 && Math.abs(back.altitude - alt) < 0.01, `${az}/${alt} → ${back.azimuth}/${back.altitude}`);
    }
  });
});

describe('obstruction mask from stills', () => {
  // the site: low everywhere, a tree NE, a house SW, a tall tree WNW that runs off the top of the sweep
  const truth = (az: number) => (az >= 40 && az < 80 ? 26 : az >= 200 && az < 260 ? 15 : az >= 295 && az < 315 ? 60 : 3);
  const SKY = 40 / 255;
  const model: MountModel = { pole: { az: 0, alt: 90 }, lambda0: 137, sense: -1, pitchOffset: 1 };

  /** A night still as the wide camera sees this site: black silhouettes against neutral sky glow, a few stars. */
  function render(rot: number, pitch: number): { img: FloatImage; frame: PanoFrame } {
    const W = 640;
    const H = 360;
    const cam = cameraGeom(W, H, 45.06, { x: 0.47, y: 0.49 });
    const basis = poseBasis(model, rot, pitch);
    const data = new Float32Array(W * H * 3);
    let seed = rot * 1000 + pitch;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const { az, alt } = toAltAz(pixelToDir(cam, basis, x, y));
        const blocked = alt < Math.max(0, truth(az));
        const v = blocked ? 0.01 * rnd() : SKY * (0.9 + 0.2 * rnd()) + (rnd() < 0.002 ? 0.6 : 0);
        const i = (y * W + x) * 3;
        data[i] = v * 1.02;
        data[i + 1] = v;
        data[i + 2] = v * 0.97;
      }
    }
    const img: FloatImage = { width: W, height: H, channels: 3, data, linear: false, source: 'synthetic' };
    return { img, frame: { evidence: frameEvidence(img, SKY), cam, basis } };
  }

  test('rings of stills become a profile in true azimuth that matches the scene', () => {
    const frames: PanoFrame[] = [];
    for (const alt of [10, 32]) {
      for (const rot of [2, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 313]) frames.push(render(rot, alt + 90 - model.pitchOffset).frame);
    }
    const sl = skyline(buildPanorama(frames));
    const { profile, capped } = profileOf(sl, 1);
    // every direction was seen
    assert.equal(profile.filter((v) => v === null).length, 0);
    for (const [k, want] of [[60, 27], [230, 16], [150, 4], [10, 4], [350, 4]]) {
      assert.ok(Math.abs(profile[k]! - want) <= 1.5, `az ${k}: ${profile[k]} (want ≈${want})`);
    }
    // the edges of the house are where they are (±1° widening, ±1 bin)
    assert.ok(profile[197]! < 6 && profile[203]! > 14, `house edge: ${profile[197]}, ${profile[203]}`);
    // the tall tree reaches the top of the sweep: capped, and asked to be looked at higher
    assert.ok(capped.includes(305), `capped: ${capped.join(',')}`);
    assert.ok(!capped.includes(60) && !capped.includes(150));
    assert.ok(cappedAzimuths(capped).some((c) => Math.abs(c - 305) <= 13));
  });

  test('the sky level is read from a sky frame', () => {
    const { img } = render(150, 160);
    assert.ok(Math.abs(skyLevelOf(img) - SKY) < 4 / 255);
  });

  test('cappedAzimuths covers each capped run with frames 25° apart', () => {
    const c = cappedAzimuths([10, 11, 12, 13, 14, 100, 358, 359]);
    for (const k of [10, 14, 100, 358, 359]) assert.ok(c.some((x) => Math.abs(((k + 0.5 - x + 540) % 360) - 180) <= 12.5), `bin ${k} in ${c.join(',')}`);
    assert.ok(c.length <= 3);
  });
});

describe('Seestar survey geometry', () => {
  // a site at Starfront's latitude: a tree line E, a building S, a tall tree W running off the rings
  const truth = (az: number) => (az >= 70 && az < 110 ? 22 : az >= 160 && az < 200 ? 12 : az >= 255 && az < 275 ? 55 : 4);
  const LAT = 31.5;
  const SKY = 30 / 255;

  /** A wide frame (portrait, 31° across) as the Seestar on its wedge sees the site, pointed at az/alt. */
  function render(az: number, alt: number, eq: boolean): PanoFrame {
    const { frame } = renderImg(az, alt, eq);
    return frame;
  }

  function renderImg(az: number, alt: number, eq: boolean): { img: FloatImage; frame: PanoFrame } {
    const W = 270;
    const H = 480;
    const cam = cameraGeom(W, H, WIDE_HFOV_DEG);
    const basis = frameBasis(az, alt, mountPole(eq, LAT));
    const data = new Float32Array(W * H * 3);
    let seed = Math.round(az * 100 + alt) + 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = toAltAz(pixelToDir(cam, basis, x, y));
        const blocked = d.alt < Math.max(0, truth(d.az));
        const v = blocked ? 0.008 * rnd() : SKY * (0.95 + 0.1 * rnd());
        const i = (y * W + x) * 3;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
      }
    }
    const img: FloatImage = { width: W, height: H, channels: 3, data, linear: false, source: 'synthetic' };
    return { img, frame: { evidence: frameEvidence(img, SKY), cam, basis } };
  }

  test('a survey keeps its frames and is solved again from them alone', async () => {
    const keeper = new FrameKeeper('hz-test-keep');
    const frames = [];
    for (const alt of [15, 40]) {
      for (let az = 0; az < 360; az += 20) {
        const { img, frame } = renderImg(az, alt, true);
        const file = await keeper.keep(img);
        assert.ok(file);
        frames.push({ file: file!, cam: frame.cam, basis: frame.basis });
      }
    }
    keeper.write({ id: 'hz-test-keep', driver: 'seestar', site: { lat: LAT, lon: -99 }, createdAt: new Date().toISOString(), mode: 'seestar-eq', skyLevel: SKY, marginDeg: 1, notes: [], frames });
    assert.equal(loadSurvey('hz-test-keep').frames.length, 36);
    const r = await resolveSurvey('hz-test-keep');
    for (const [k, want] of [[90, 23], [180, 13], [20, 5]]) assert.ok(Math.abs(r.mask.profile[k]! - want) <= 2.5, `az ${k}: ${r.mask.profile[k]} (want ≈${want})`);
    assert.match(r.notes[0], /solved again from the 36 frames/);
    assert.ok(r.panoramaJpeg.length > 1000);
    assert.throws(() => loadSurvey('../etc'), /not a survey id/);
  });

  test('a frame on the wedge is turned toward the celestial pole; in alt-az toward the zenith', () => {
    // looking south on the meridian the pole is straight up the frame either way
    const s = frameBasis(180, 30, mountPole(true, LAT));
    const sAltAz = frameBasis(180, 30, mountPole(false, LAT));
    assert.ok(angleDeg(s.u, sAltAz.u) < 1e-6 && s.u[2] > 0.8, 'south: up is the zenith side, as in alt-az');
    // looking east the wedge tilts the frame: up leans north (toward the pole), right stays to the south side
    const e = frameBasis(90, 20, mountPole(true, LAT));
    assert.ok(e.u[1] > 0.3 && e.u[2] > 0.3, `east: up leans north ${e.u}`);
    const a = frameBasis(90, 20, mountPole(false, LAT));
    assert.ok(Math.abs(a.u[1]) < 1e-9 && a.u[2] > 0.9, 'alt-az: up is the zenith side');
    // right is west when looking south (the picture is not mirrored)
    assert.ok(s.r[0] < -0.99);
  });

  for (const eq of [true, false]) {
    test(`two rings of tilted wide frames give the site's profile (${eq ? 'EQ' : 'alt-az'})`, () => {
      const frames: PanoFrame[] = [];
      for (const alt of [15, 40]) for (let az = 0; az < 360; az += 20) frames.push(render(az, alt, eq));
      const sl = skyline(buildPanorama(frames));
      const { profile } = profileOf(sl, 1);
      assert.equal(profile.filter((v) => v === null).length, 0, 'every direction seen');
      for (const [k, want] of [[90, 23], [180, 13], [20, 5], [330, 5], [140, 5]]) {
        assert.ok(Math.abs(profile[k]! - want) <= 2, `az ${k}: ${profile[k]} (want ≈${want})`);
      }
      assert.ok(profile[265]! >= 45, `tall tree: ${profile[265]}`);
    });
  }
});

describe('horizon masks', () => {
  const site = { lat: 40.0, lon: -105.0 };
  const flat = (v: number | null): Array<number | null> => Array.from({ length: 360 }, () => v);
  const mk = (profile: Array<number | null>, createdAt: string, at = site): HorizonMask => ({ id: `t-${createdAt}`, site: at, createdAt, source: 'import', profile });

  test('the newest mask within 300 m is the one in use; far away there is none; clear forgets them', () => {
    clearMasks(site);
    saveMask(mk(flat(10), '2026-10-01T00:00:00Z'));
    saveMask(mk(flat(20), '2026-10-02T00:00:00Z'));
    saveMask(mk(flat(30), '2026-10-03T00:00:00Z', { lat: 41.0, lon: -105.0 }));
    assert.equal(maskFor({ lat: 40.0005, lon: -105.0003 })?.profile[0], 20);
    assert.equal(maskFor({ lat: 40.1, lon: -105.0 }), null);
    assert.equal(clearMasks(site), 2);
    assert.equal(maskFor(site), null);
    assert.equal(maskFor({ lat: 41.0, lon: -105.0 })?.profile[0], 30);
  });

  test('only five masks are kept per site', () => {
    clearMasks(site);
    for (let d = 1; d <= 7; d++) saveMask(mk(flat(d), `2026-10-0${d}T00:00:00Z`));
    assert.equal(clearMasks(site), 5);
  });

  test('the limit is interpolated between bin centres, around north too; unobserved is no limit', () => {
    const p = flat(0);
    p[0] = 10;
    p[359] = 20;
    p[180] = null;
    const m = { profile: p };
    assert.equal(limitAt(m, 0.5), 10);
    assert.equal(limitAt(m, 0), 15);
    assert.equal(limitAt(m, 359.5), 20);
    assert.equal(limitAt(m, 180.5), 0);
    assert.deepEqual(unknownSectors(m), ['180–181°']);
  });

  test('horizon files: parsed with interpolation round the circle, exported and read back', () => {
    const prof = parseHorizonText('# my yard\n0 10\n90, 20\n180 10 ; south\n270 0\n');
    assert.ok(Math.abs(prof[45] - 15.1) < 0.11);
    assert.ok(Math.abs(prof[315] - 5.1) < 0.11);
    const m = mk(prof, '2026-10-05T00:00:00Z');
    assert.deepEqual(parseHorizonText(toHorizonText(m)), prof);
    assert.match(describeMask(m), /360\/360° observed/);
    assert.throws(() => parseHorizonText('0 10'), /at least two/);
    assert.throws(() => parseHorizonText('0 10\nfoo bar'), /not an "azimuth altitude" line/);
    assert.throws(() => parseHorizonText('0 10\n90 95'), /out of range/);
  });

  test('the planner only counts a target as up above the site horizon', () => {
    const base = { minAltitude: 30, fovArcmin: { w: 168, h: 94 }, timezone: 'America/Los_Angeles', now: new Date('2026-10-12T20:00:00Z'), limit: 8, applyRest: false };
    const plain = planNight(SITE, base);
    assert.equal(plain.horizon, null);
    assert.ok(plain.targets.every((t) => t.obstructedNow === null));
    // a horizon under the minimum altitude changes nothing
    const low = planNight(SITE, { ...base, horizon: horizonOf(mk(flat(10), '2026-10-06T00:00:00Z')) });
    assert.deepEqual(low.targets.map((t) => t.name), plain.targets.map((t) => t.name));
    assert.match(low.horizon ?? '', /imported horizon/);
    // walls to the zenith all round: nothing is ever up
    const walled = planNight(SITE, { ...base, horizon: horizonOf(mk(flat(90), '2026-10-06T00:00:00Z')) });
    assert.equal(walled.targets.length, 0);
    // the northern half blocked to 80°: what remains is up in the south, for no longer than before
    const half = flat(0).map((_, k) => (k < 90 || k >= 270 ? 80 : 0));
    const south = planNight(SITE, { ...base, horizon: horizonOf(mk(half, '2026-10-06T00:00:00Z')) });
    const hoursBefore = new Map(plain.targets.map((t) => [t.name, t.hoursAboveMin]));
    for (const t of south.targets) if (hoursBefore.has(t.name)) assert.ok(t.hoursAboveMin <= hoursBefore.get(t.name)!);
    assert.ok(south.targets.every((t) => typeof t.obstructedNow === 'boolean'));
  });
});
