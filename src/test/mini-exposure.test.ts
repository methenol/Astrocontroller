/**
 * The Dwarf Mini's first night (2026-11-26): the plan held it to 15 s and its quality probe measured
 * 1 s and 15 s. Four causes: the unguided-EQ trailing cap had no focal length and fell to its floor;
 * the spec cut the EQ list at 90 s; the device's 1 s was offered as a sub; and only exposures with a
 * dark master were offered, on a scope that can shoot its own. The 1 s points were stacked at 15 s.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planDefaults } from '../config.js';
import { advise, darkStatus, selfDarkFrames, type SkySlice, type TargetInfo } from '../astro/acquisition/advise.js';
import { resolveRig } from '../astro/acquisition/devices.js';
import { mountSubCap } from '../astro/exposure.js';
import { sessionExposureS } from '../drivers/dwarf/probe.js';
import { driverSteps } from '../night/procedure.js';

const SITE = { lat: 28.8, lon: -81.7, elev: 30 };
const target = (o: Partial<TargetInfo> = {}): TargetInfo => ({ name: 'T', raHours: 0, decDeg: 60, type: 'HII', sb: 21.8, emission: 'Ha_dominant', ...o });
const slices = (n: number): SkySlice[] => Array.from({ length: n }, (_, i) => ({ at: i * 900e3, altDeg: 50, azDeg: 30, moon: null }));
/** the Mini's own report that night: EQ, its camera schema up to 180 s, and its dark list */
const MINI_EXPOSURES = [0.5, 1, 1.3, 2, 4, 5, 6, 8, 10, 13, 15, 30, 45, 60, 90, 120, 180];
const miniFacts = (darks = [{ exposureS: 1, gain: 60 }, { exposureS: 15, gain: 60 }]) => ({ driver: 'dwarf' as const, model: 'DWARF_mini_6A7478', eqMode: true, exposureOptionsS: MINI_EXPOSURES, darks });

describe('Dwarf Mini exposures', () => {
  test('in EQ the Mini is offered 5–120 s: no 1 s bias-length sub, nothing past the 120 s the owner confirms', () => {
    const rig = resolveRig(miniFacts());
    assert.equal(rig.spec.id, 'dwarf-mini');
    assert.equal(Math.min(...rig.subsS), 5);
    assert.equal(Math.max(...rig.subsS), 120);
    assert.ok(rig.subsS.includes(60) && rig.subsS.includes(90));
  });

  test('the unguided-EQ trailing cap is sized from the focal length (120 s at 150 mm), not its 15 s floor', () => {
    const base = { plateScaleArcsecPerPx: 4, band: 'broadband' as const, mount: 'eq' as const, guided: false };
    assert.equal(mountSubCap({ ...base, effectiveFlMm: 150 }, 60).capS, 120);
    assert.equal(mountSubCap(base, 60).capS, 15);
    // the plan's rig now carries one (the profile's known rig, else its device spec)
    assert.ok((planDefaults().rig.effectiveFlMm ?? 0) > 0);
  });

  test('a missing dark is shot first on the Mini, avoided on the Dwarf 3', () => {
    const mini = resolveRig(miniFacts());
    assert.equal(darkStatus(mini, 15, 60), 'covered');
    assert.equal(darkStatus(mini, 60, 60), 'shootable');
    const d3 = resolveRig({ driver: 'dwarf', model: 'DWARF3_704420', eqMode: true, darks: [{ exposureS: 15, gain: 60 }] });
    assert.equal(darkStatus(d3, 60, 60), 'missing');
  });

  test('the Mini is advised past its two darks, and the apply line shoots the master first', () => {
    const rig = resolveRig(miniFacts());
    const r = advise({ rig, target: target(), site: SITE, slices: slices(8), zenithSqm: 20, sqmSource: 't', usableMin: 240 });
    assert.ok(r.settings.subS > 15, `${r.settings.subS}s`);
    assert.ok(r.dark, 'a dark is needed');
    assert.equal(r.dark!.exposureS, r.settings.subS);
    assert.match(r.apply, new RegExp(`^dark_frames action=capture exposure_s=${r.settings.subS} gain=${r.settings.gain} frames=\\d+ .*, then live_stacking action=start exposure=${r.settings.subS}`));
  });

  test('fixed settings without a master are still advised on the Mini (the quality engine holds its answer that way)', () => {
    const rig = resolveRig(miniFacts());
    const r = advise({ rig, target: target(), site: SITE, slices: slices(4), zenithSqm: 20, sqmSource: 't', usableMin: 60, fixed: { filter: 'Duo-Band', gain: 60, subS: 90 } });
    assert.equal(r.settings.subS, 90);
    assert.equal(r.dark?.frames, selfDarkFrames(90));
  });

  test('covered settings need no dark and keep the plain apply line', () => {
    const rig = resolveRig(miniFacts([{ exposureS: 60, gain: 60 }]));
    const r = advise({ rig, target: target(), site: SITE, slices: slices(4), zenithSqm: 20, sqmSource: 't', usableMin: 60, fixed: { filter: 'Duo-Band', gain: 60, subS: 60 } });
    assert.equal(r.dark, null);
    assert.ok(r.apply.startsWith('live_stacking action=start'));
  });

  test('a dark master is at most ~10 min: 20 frames short, never under 5', () => {
    assert.equal(selfDarkFrames(15), 20);
    assert.equal(selfDarkFrames(60), 10);
    assert.equal(selfDarkFrames(120), 5);
    assert.equal(selfDarkFrames(600), 5);
  });

  test('the target step puts the dark before the stack, unless the settings are still to be measured', () => {
    const dark = { exposureS: 90, gain: 60, frames: 6, minutes: 10 };
    const step = driverSteps().target('NGC 281', { subS: 90, gain: 60, filter: 'Duo-Band', dark });
    assert.ok(step.indexOf('dark_frames action=capture exposure_s=90') < step.indexOf('live_stacking action=start exposure=90'));
    assert.ok(step.includes('dark_frames'));
    assert.ok(!driverSteps().target('NGC 281', { subS: 90, gain: 60, dark, measure: 'needed', name: 'ngc 281' }).includes('dark_frames'));
  });

  test("the probe reads the exposure a session was really stacked at off its folder name", () => {
    assert.equal(sessionExposureS('DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-11-26-19-59-07-528'), 15);
    assert.equal(sessionExposureS('DWARF_RAW_TELE_M 31_EXP_0.5_GAIN_80_2026-11-26-19-59-07-528'), 0.5);
    assert.equal(sessionExposureS('something else'), null);
  });
});
