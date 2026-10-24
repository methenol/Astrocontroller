import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findObject, gotoLabel } from '../astro/catalog.js';
import { resolveSkyTarget, SAME_OBJECT_DEG } from '../astro/sky-target.js';
import { GAIA_PROPERTIES, GAIA_TILE } from '../web/routes/stellarium.js';
import { ControlBody } from '../web/routes/control.js';

describe('a target picked on the Stellarium map', () => {
  const m31 = findObject('M 31')!;

  test('a planet goes by name, whatever position came with it', () => {
    const t = resolveSkyTarget('Jupiter', 1, 1);
    assert.equal(t.kind, 'body');
    assert.equal(t.kind === 'body' && t.body, 'Jupiter');
  });

  test('a catalog object at its own position takes the catalog label and coordinates', () => {
    const t = resolveSkyTarget('M 31', m31.raHours + 0.001, m31.decDeg);
    assert.equal(t.kind, 'catalog');
    assert.equal(t.label, gotoLabel(m31));
    assert.equal(t.kind === 'catalog' && t.framed, false);
    assert.equal(t.kind === 'catalog' && t.raHours, m31.raHours);
  });

  test('a shot framed off the object keeps its label but goes to the framed position', () => {
    const dec = m31.decDeg + SAME_OBJECT_DEG * 3;
    const t = resolveSkyTarget('M 31', m31.raHours, dec);
    assert.equal(t.kind, 'catalog');
    assert.equal(t.label, gotoLabel(m31));
    assert.ok(t.kind === 'catalog' && t.framed);
    assert.equal(t.kind === 'catalog' && t.decDeg, dec);
  });

  test('a name that resolves elsewhere in the sky is a bare position, labelled with that name', () => {
    const t = resolveSkyTarget('M 31', (m31.raHours + 6) % 24, -20);
    assert.equal(t.kind, 'position');
    assert.equal(t.label, 'M 31');
  });

  test('no name: the label is the coordinates; odd characters are dropped from names', () => {
    assert.equal(resolveSkyTarget(undefined, 5.5, -5.25).label, 'RA 05h30m00.0s Dec -05°15\'00"');
    assert.equal(resolveSkyTarget('<b>Star/x</b>', 3, 80).label, 'bStarxb');
  });
});

describe('the Gaia survey proxy', () => {
  test('the properties carry the line the engine needs to read the survey as stars', () => {
    assert.match(GAIA_PROPERTIES, /^type = stars$/m);
    assert.match(GAIA_PROPERTIES, /^hips_tile_format = eph$/m);
  });

  test('only HiPS tile paths are redirected', () => {
    assert.ok(GAIA_TILE.test('Norder3/Dir0/Npix12.eph'));
    assert.ok(GAIA_TILE.test('Norder5/Allsky.eph'));
    for (const bad of ['../dss/properties', 'Norder3/Dir0/Npix12.eph/../../x', 'properties', 'Norder3/Dir0/Npix12.png', 'https://evil.example/a.eph']) assert.ok(!GAIA_TILE.test(bad), bad);
  });
});

describe('goto_sky', () => {
  test('takes a position with an optional name, and refuses impossible ones', () => {
    assert.ok(ControlBody.safeParse({ action: 'goto_sky', raHours: 5.5, decDeg: -5 }).success);
    assert.ok(ControlBody.safeParse({ action: 'goto_sky', name: 'M 42', raHours: '5.5', decDeg: '-5' }).success);
    assert.ok(!ControlBody.safeParse({ action: 'goto_sky', raHours: 24, decDeg: 0 }).success);
    assert.ok(!ControlBody.safeParse({ action: 'goto_sky', raHours: 1, decDeg: 91 }).success);
    assert.ok(!ControlBody.safeParse({ action: 'goto_sky', name: 'M 42' }).success);
  });
});
