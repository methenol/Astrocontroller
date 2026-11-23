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

  test('galaxy, cluster and nebula catalogs written every which way land on one key', () => {
    for (const s of ['MCG +02-01-031', 'MCG 2-1-31', 'MCG+2-01-031', 'mcg 02-01-031']) assert.equal(normalizeName(s), 'mcg+2-1-31', s);
    assert.equal(normalizeName('MCG -02-01-031'), 'mcg-2-1-31');
    assert.notEqual(normalizeName('MCG -00-01-001'), normalizeName('MCG +00-01-001'), 'the -0 and +0 zones are different');
    for (const s of ['ESO 351-30', 'ESO351-030', 'ESO 351-G030', 'ESO 351- G 30']) assert.equal(normalizeName(s), 'eso351-30', s);
    for (const s of ['CGCG 382-014', 'CGCG382-14']) assert.equal(normalizeName(s), 'cgcg382-14', s);
    for (const s of ['Mrk 421', 'Markarian 421', 'MRK421']) assert.equal(normalizeName(s), 'mrk421', s);
    for (const s of ['DDO 154', 'DDO154']) assert.equal(normalizeName(s), 'ddo154', s);
    for (const s of ['UGCA 86', 'ugca86']) assert.equal(normalizeName(s), 'ugca86', s);
    for (const s of ['vdBH 3a', 'vdB-Ha 3a', 'vdBHa 3a']) assert.equal(normalizeName(s), 'vdbh3a', s);
    assert.equal(normalizeName('vdB 12'), 'vdb12', 'van den Bergh alone is still vdB');
    for (const s of ['Abell S373', 'ACO S 373', 'aco s373']) assert.equal(normalizeName(s), 'acos373', s);
    assert.equal(normalizeName('Abell 1656'), 'abell1656');
    assert.equal(normalizeName('LEDA 2557'), 'pgc2557');
    for (const s of ['Ou 4', 'Ou4']) assert.equal(normalizeName(s), 'ou4', s);
    assert.equal(normalizeName('Pal 5'), 'pal5', 'Palomar is not Patchick');
    assert.equal(normalizeName('Minkowski 2-9'), normalizeName('M 2-9'));
    assert.equal(normalizeName('Messier 2'), 'm2');
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
