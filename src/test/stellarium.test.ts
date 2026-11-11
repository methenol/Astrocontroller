import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, findObject, gotoLabel, objectsInView, SKY_LAYERS } from '../astro/catalog.js';
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

describe('the object layers on the map', () => {
  const m31 = findObject('M 31')!;
  const all = Object.keys(SKY_LAYERS);

  test('every type in the database belongs to exactly one layer', () => {
    const owners = (t: string) => Object.values(SKY_LAYERS).filter((types) => types.includes(t)).length;
    for (const t of new Set(catalog().map((o) => o.type))) assert.equal(owners(t), 1, t);
  });

  test('all layers over the whole sky reach every object in the database', () => {
    assert.equal(objectsInView({ raHours: 0, decDeg: 0, radiusDeg: 180, layers: all }).total, catalog().length);
  });

  test('a view holds its layers within its radius, most prominent first', () => {
    const near = objectsInView({ raHours: m31.raHours, decDeg: m31.decDeg, radiusDeg: 3, layers: ['galaxies'] });
    assert.equal(near.objects[0].id, m31.id);
    assert.ok(near.objects.every((o) => o.layer === 'galaxies'));
    assert.ok(!objectsInView({ raHours: m31.raHours, decDeg: m31.decDeg, radiusDeg: 3, layers: ['planetary'] }).objects.some((o) => o.id === m31.id));
    assert.ok(!objectsInView({ raHours: (m31.raHours + 12) % 24, decDeg: -m31.decDeg, radiusDeg: 90, layers: ['galaxies'] }).objects.some((o) => o.id === m31.id));
  });

  test('the limit trims the list, not the count, and no layers means nothing', () => {
    const v = objectsInView({ raHours: 12, decDeg: 12, radiusDeg: 60, layers: ['galaxies'], limit: 5 });
    assert.equal(v.objects.length, 5);
    assert.ok(v.total > 5);
    assert.equal(objectsInView({ raHours: 12, decDeg: 12, radiusDeg: 60, layers: [] }).total, 0);
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
