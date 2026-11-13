import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveRig } from '../astro/acquisition/devices.js';
import { INITIAL_POINTS_MAX, VALID_DAYS, initialPoints, solveQuality, validate, type QualityInput } from '../astro/acquisition/quality.js';
import { forgetQuality, qualitySamples, recordQuality, resetStoreCache, type QualitySample } from '../astro/acquisition/store.js';
import { probing, whileProbing } from '../astro/acquisition/probe.js';
import type { SkySlice, TargetInfo } from '../astro/acquisition/advise.js';
import { Journal } from '../night/journal.js';
import { JournalRecorder, type ScopeSnapshot } from '../night/recorder.js';
import * as sky from '../astro/sky.js';
import { config } from '../config.js';

const SITE = { lat: 31.5, lon: -99.4, elev: 450 };
const NOW = Date.UTC(2026, 10, 14, 5, 0, 0);
const dwarfEq = () => resolveRig({ driver: 'dwarf', model: 'DWARF3', eqMode: true });
const target: TargetInfo = { name: 'NGC 224', raHours: 0.71, decDeg: 41.3, type: 'G', sb: 22, emission: 'broadband' };
const slices = (n = 8, o: Partial<SkySlice> = {}): SkySlice[] => Array.from({ length: n }, (_, i) => ({ at: NOW + i * 900e3, altDeg: 60, azDeg: 180, moon: null, ...o }));
const model = { settings: { filter: 'Astro', gain: 60, subS: 30, frames: 100, ditherEverySubs: 6, gainNote: '' }, alternatives: [{ filter: 'Duo-Band', gain: 60, subS: 60, relative: 0.6, note: '' }, { filter: 'Astro', gain: 80, subS: 30, relative: 0.9, note: '' }] };

let n = 0;
/** A cohort as the probe would store it: sky noise rate nSky e⁻/s, read noise rnE e⁻ through 0.25 e⁻/ADU. */
function sample(o: { filter?: string; gain?: number; subS: number; nSky?: number; rnE?: number; stars?: number; fwhm?: number; round?: number; at?: number; moon?: { alt: number; sep: number; illum: number } | null; target?: string }): QualitySample {
  const k = 0.25;
  const nSky = o.nSky ?? 0.5;
  return {
    id: `t${n++}`,
    at: o.at ?? NOW - 600e3,
    device: 'dwarf-3',
    target: o.target ?? 'ngc 224',
    targetName: 'M 31',
    filter: o.filter ?? 'Astro',
    gain: o.gain ?? 60,
    subS: o.subS,
    frames: ['a.fits', 'b.fits'],
    source: 'probe',
    valid: true,
    skyAduPerS: nSky / k,
    skyVarAduPerS: (nSky + 0.02) / k ** 2,
    readNoiseAdu: (o.rnE ?? 4) / k,
    ePerAdu: k,
    swamp: 1,
    efficiency: 0.9,
    backgroundPct: 2,
    clippedPct: 0,
    stars: o.stars ?? 200,
    fwhmArcsec: o.fwhm ?? 8,
    roundness: o.round ?? 0.9,
    skyMag: 20,
    modelSkyMag: 20,
    modelMoonlessMag: 20,
    cond: { altDeg: 60, azDeg: 180, moonAltDeg: o.moon ? o.moon.alt : -30, moonSepDeg: o.moon ? o.moon.sep : 120, moonIllum: o.moon ? o.moon.illum : 0.5, sunAltDeg: -30, mount: 'eq' },
  };
}

const input = (samples: QualitySample[], o: Partial<QualityInput> = {}): QualityInput => ({ rig: dwarfEq(), target, site: SITE, zenithSqm: 21, filterMode: 'Astro', slices: slices(), model, samples, now: NOW, ...o });

describe('collection quality: the points', () => {
  test('auto: both filters, a second gain and the sub lengths either side, at most five', () => {
    const pts = initialPoints({ rig: dwarfEq(), filterMode: 'auto', model });
    assert.ok(pts.length <= INITIAL_POINTS_MAX && pts.length >= 4, `${pts.length} points`);
    assert.ok(pts.some((p) => p.filter === 'Duo-Band'), 'the other filter');
    assert.ok(pts.some((p) => p.filter === 'Astro' && p.gain === 80), 'the other gain');
    const astro60 = pts.filter((p) => p.filter === 'Astro' && p.gain === 60).map((p) => p.subS);
    assert.ok(astro60.includes(15) && astro60.includes(30) && astro60.includes(60), astro60.join(','));
    // one filter at a time
    const order = pts.map((p) => p.filter);
    assert.deepEqual(order, [...order].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });

  test("a program filter is kept: every point through it", () => {
    const pts = initialPoints({ rig: dwarfEq(), filterMode: 'Duo-Band', model: { ...model, settings: { ...model.settings, filter: 'Duo-Band' } } });
    assert.ok(pts.length >= 3);
    assert.ok(pts.every((p) => p.filter === 'Duo-Band'));
  });

  test('nothing measured: needed, with the points and no settings', () => {
    const a = solveQuality(input([]));
    assert.equal(a.status, 'needed');
    assert.equal(a.settings, null);
    assert.ok(a.points.length >= 3 && a.points.length <= INITIAL_POINTS_MAX);
  });

  test(`stale after ${VALID_DAYS} days: needed again`, () => {
    const old = NOW - (VALID_DAYS + 1) * 86400e3;
    const a = solveQuality(input([15, 30, 60].map((t) => sample({ subS: t, at: old }))));
    assert.equal(a.status, 'needed');
  });
});

describe('collection quality: the solve', () => {
  test('measured trailing at the long sub: the best is the longest that holds round stars', () => {
    const a = solveQuality(input([sample({ subS: 15 }), sample({ subS: 30 }), sample({ subS: 60, round: 0.5, fwhm: 12 })]));
    assert.equal(a.settings?.subS, 30, JSON.stringify(a.table));
    assert.equal(a.status, 'established', a.why.join(' | '));
    assert.ok(a.table.find((r) => r.subS === 60)!.relative < 0.5, 'the trailed sub scores low');
  });

  test('established, the agent can still re-measure: the engine gives points around the answer', () => {
    const a = solveQuality(input([sample({ subS: 15 }), sample({ subS: 30 }), sample({ subS: 60, round: 0.5, fwhm: 12 })]));
    assert.equal(a.status, 'established');
    assert.equal(a.points.length, 0);
    assert.ok(a.refreshPoints?.some((p) => p.subS === 30 && p.filter === 'Astro'), JSON.stringify(a.refreshPoints));
  });

  test('the best at the edge of the tested subs: it asks for the next one', () => {
    const a = solveQuality(input([sample({ subS: 15 }), sample({ subS: 30 }), sample({ subS: 60 })]));
    assert.equal(a.status, 'more', a.why.join(' | '));
    assert.ok(a.points.some((p) => p.subS === 120), JSON.stringify(a.points));
  });

  test('a clouded cohort next to the best is a gap, shot once more', () => {
    const set = [sample({ subS: 15 }), sample({ subS: 30, stars: 5 }), sample({ subS: 60, round: 0.5, fwhm: 12 })];
    const checked = validate(set, dwarfEq());
    assert.ok(checked[1].gapWhy, 'the cloud is found');
    const a = solveQuality(input(set));
    assert.ok(a.set?.invalid.length === 1);
    assert.ok(a.points.some((p) => p.subS === 30 && p.retry), JSON.stringify(a.points));
    // after the retry it is not asked again
    const b = solveQuality(input([...set, sample({ subS: 30 })]));
    assert.ok(!b.points.some((p) => p.subS === 30), JSON.stringify(b.points));
    assert.equal(b.settings?.subS, 30);
  });

  test('auto: the filters compared on their measured sky', () => {
    // a bright sky through Astro, a dark one through Duo-Band: an emission target goes Duo-Band
    const t: TargetInfo = { ...target, name: 'NGC 7000', type: 'HII', emission: 'Ha_dominant' };
    const set = [sample({ subS: 30, nSky: 8 }), sample({ subS: 15, nSky: 8 }), sample({ filter: 'Duo-Band', subS: 30, nSky: 0.6 }), sample({ filter: 'Duo-Band', subS: 60, nSky: 0.6 })];
    const a = solveQuality(input(set, { target: t, filterMode: 'auto' }));
    assert.equal(a.settings?.filter, 'Duo-Band', JSON.stringify(a.table.slice(0, 4)));
  });

  test('the Moon: a moon-down and a moon-up cohort measure its scattering, and a moonlit block is brighter', () => {
    const dark = [15, 30, 60].map((t) => sample({ subS: t, round: t === 60 ? 0.5 : 0.9, at: NOW - 3 * 86400e3 }));
    const lit = [15, 30, 60].map((t) => sample({ subS: t, nSky: 3, round: t === 60 ? 0.5 : 0.9, moon: { alt: 40, sep: 60, illum: 0.8 } }));
    const moonlit = slices(8, { moon: { altDeg: 40, sepDeg: 60, phaseAngleDeg: 53 } as SkySlice['moon'] });
    const a = solveQuality(input([...dark, ...lit], { slices: moonlit }));
    assert.ok(a.moon?.measuredK !== null && a.moon?.measuredK !== undefined, JSON.stringify(a.moon));
    assert.ok((a.moon?.deltaMagBlock ?? 0) < 0, 'brighter');
  });

  test('refresh: measured moonless, the block moonlit without a measured Moon', () => {
    const set = [15, 30, 60].map((t) => sample({ subS: t, round: t === 60 ? 0.5 : 0.9 }));
    const moonlit = slices(8, { moon: { altDeg: 50, sepDeg: 25, phaseAngleDeg: 10 } as SkySlice['moon'] });
    const a = solveQuality(input(set, { slices: moonlit }));
    assert.equal(a.status, 'refresh', a.why.join(' | '));
    assert.ok(a.settings, 'still gives the rescaled settings');
    assert.ok(a.points.length && a.points.length <= 3);
  });
});

describe('collection quality: per target, out of the journal', () => {
  test("one target's cohorts are not another's", () => {
    resetStoreCache();
    forgetQuality('dwarf-3');
    recordQuality(sample({ subS: 30, target: 'ngc 224' }));
    assert.equal(qualitySamples('dwarf-3', 'ngc 224').length, 1);
    assert.equal(qualitySamples('dwarf-3', 'ngc 598').length, 0);
    forgetQuality('dwarf-3');
  });

  test('a probe stack opens no journal session', async () => {
    class FakeProbe extends EventEmitter {
      snap: ScopeSnapshot = { connected: true, goto: { state: 'idle' }, autofocus: { state: 'idle' }, fineFocus: { running: false }, stack: { running: false } };
      snapshot() {
        return structuredClone(this.snap);
      }
    }
    const journal = new Journal({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'journal-')) });
    const probe = new FakeProbe();
    const w = sky.nightWindow(SITE, new Date(NOW - 8 * 3600e3));
    let t = (w.astroDusk ?? new Date(NOW)).getTime() + 3600e3;
    const rec = new JournalRecorder({ journal, probe, site: () => SITE, now: () => t, settleMs: 0 });
    rec.observe();
    await whileProbing(async () => {
      assert.ok(probing());
      probe.snap.stack = { running: true, target: 'M 31', stacked: 2, subS: 30 };
      t += 60e3;
      rec.observe();
      probe.snap.stack = { running: false, target: 'M 31', stacked: 3, subS: 30 };
      t += 60e3;
      rec.observe();
    });
    const night = sky.localDate(w.sunset!, config.observer.timezone);
    assert.equal(journal.night(night).sessions.length, 0);
  });
});
