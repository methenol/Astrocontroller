import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, isDesignation, greekSymbol, prettyId, typeName, typeGroup, TYPE_NAMES, CONSTELLATIONS } from '../astro/designations.js';

describe('designations', () => {
  test('every spelling of an object lands on one key', () => {
    for (const s of ['M31', 'm 31', 'Messier 31', 'M031']) assert.equal(normalizeName(s), 'm31', s);
    for (const s of ['NGC 0224', 'ngc224', 'NGC  224']) assert.equal(normalizeName(s), 'ngc224', s);
    for (const s of ['Sharpless 2-155', 'Sh2-155', 'sh 2-155', 'Sh2 155']) assert.equal(normalizeName(s), 'sh2-155', s);
    for (const s of ['alpha Lyrae', 'α Lyr', 'alf Lyr', 'Alp Lyr']) assert.equal(normalizeName(s), 'alp lyr', s);
    assert.equal(normalizeName('alp-2 Cap'), 'alp2 cap');
    assert.equal(normalizeName('61 Cygni'), '61 cyg');
    assert.equal(normalizeName('Collinder 399'), 'cr399');
    assert.equal(normalizeName('Barnard’s Loop'), 'barnards loop');
    assert.equal(normalizeName('  Orion   Nebula '), 'orion nebula');
    assert.equal(normalizeName('Ćave Nebula'), 'cave nebula');
  });

  test('Greek letters and packed ids', () => {
    assert.equal(greekSymbol('alf02'), 'α2');
    assert.equal(greekSymbol('Gamma'), 'γ');
    assert.equal(greekSymbol('ngc'), undefined);
    assert.equal(prettyId('NGC0224'), 'NGC 224');
    assert.equal(prettyId('Sh2155'), 'Sh2-155');
    assert.equal(prettyId('IC0434A'), 'IC 434A');
    assert.equal(prettyId('Orion'), 'Orion');
  });

  test('designations versus common names', () => {
    for (const s of ['M31', 'NGC 224', 'Sh2-155', 'α2 Cap', '61 Cyg', 'gam Cyg']) assert.ok(isDesignation(s), s);
    for (const s of ['Orion Nebula', 'Pleiades', 'big Dipper']) assert.ok(!isDesignation(s), s);
  });

  test('type lookups use own keys only and the tables are frozen', () => {
    assert.equal(typeName('PN'), 'planetary nebula');
    assert.equal(typeName('constructor'), 'constructor');
    assert.deepEqual(typeGroup('Galaxy'), ['G', 'GPair', 'GTrpl', 'GGroup']);
    assert.equal(typeGroup('toString'), undefined);
    assert.ok(Object.isFrozen(TYPE_NAMES) && Object.isFrozen(CONSTELLATIONS));
    assert.equal(CONSTELLATIONS.length, 88);
    assert.equal(new Set(CONSTELLATIONS.map((c) => c[0])).size, 88);
  });
});
