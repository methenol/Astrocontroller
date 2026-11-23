import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { num, sexa, crossIds, parseOpenNgc, prettyOpenNgcId, simbadId, simbadName, simbadObjects, ledaName, ledaNames, prettyGalaxyName } from '../tools/catalog/parse.js';
import { Catalog, sepArcmin, extendedTol, resolveType } from '../tools/catalog/merge.js';
import { Downloader, parseVizierTsv, parseTapTsv, tapError, vizierError } from '../tools/catalog/fetch.js';
import { idRank, tsvRow, TSV_HEADER } from '../tools/catalog/write.js';
import type { Rec } from '../tools/catalog/types.js';

const rec = (over: Partial<Rec> & Pick<Rec, 'id'>): Rec => ({ type: 'HII', ra: 5, dec: 10, ids: [], names: [], ...over });

describe('catalog build: parsing', () => {
  test('numbers and sexagesimal', () => {
    assert.equal(num(''), undefined);
    assert.equal(num('  '), undefined, 'a blank field is not 0');
    assert.equal(num('x'), undefined);
    assert.equal(num(' 2.5 '), 2.5);
    assert.ok(Math.abs(sexa('05:35:17.3') - 5.58814) < 1e-4);
    assert.ok(Math.abs(sexa('-00:30:00') + 0.5) < 1e-9, 'the sign of a zero-degree value is kept');
    assert.ok(Math.abs(sexa('+07:12:60.0') - 7.21667) < 1e-4);
    assert.ok(Number.isNaN(sexa('12:xx:00')));
    assert.ok(Number.isNaN(sexa('12:61:00')));
  });

  test('cross-identifications', () => {
    assert.deepEqual(crossIds('NGC2327, IC 2177; M 42 Sh 2-155 M 1-36 Gum 2'), ['NGC 2327', 'IC 2177', 'M 42', 'Sh2-155', 'M 1-36', 'Gum 2']);
    assert.equal(prettyOpenNgcId('Cl 0399'), 'Cr 399');
    assert.equal(prettyOpenNgcId('SH 2-0155'), 'Sh2-155');
  });

  test('OpenNGC rows, Dup aliases and missing columns', () => {
    const head = 'Name;Type;RA;Dec;Const;MajAx;MinAx;PosAng;B-Mag;V-Mag;SurfBr;M;NGC;IC;Identifiers;Common names';
    const csv = [head,
      'NGC0224;G;00:42:44.35;+41:16:08.6;And;177.83;69.66;35;4.29;3.44;23.63;031;;;PGC 002557,UGC 00454;Andromeda Galaxy',
      'NGC0205;Dup;;;;;;;;;;110;;;;',
      'NGC9999;NonEx;00:00:00;+00:00:00;;;;;;;;;;;;',
    ].join('\n');
    const { records, aliases } = parseOpenNgc(csv);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'NGC 224');
    assert.deepEqual(records[0].ids, ['M 31', 'PGC 2557', 'UGC 454']);
    assert.deepEqual(records[0].names, ['Andromeda Galaxy']);
    assert.equal(records[0].mag, 3.44);
    assert.deepEqual(aliases, [['NGC 205', 'M 110']]);
    assert.throws(() => parseOpenNgc('Name;Type\n'), /columns missing: RA/);
  });

  test('VizieR TSV: header, units and dashes are skipped; missing columns and error pages throw', () => {
    const tsv = '#comment\nSh2\tDiam\t_RAJ2000\t_DEJ2000\n\tarcmin\tdeg\tdeg\n---\t---\t---\t---\n155\t50\t343.5\t62.6\n';
    assert.deepEqual(parseVizierTsv(tsv, 't', ['Sh2', 'Diam']), [{ Sh2: '155', Diam: '50', _RAJ2000: '343.5', _DEJ2000: '62.6' }]);
    assert.throws(() => parseVizierTsv(tsv, 't', ['Bright']), /columns missing.*Bright/);
    assert.throws(() => parseVizierTsv('#**** error: unknown table\n', 't', []), /not a VizieR table/);
  });
});

describe('catalog build: merging', () => {
  test('separation and tolerance', () => {
    assert.ok(Math.abs(sepArcmin(0, 0, 0, 1) - 60) < 1e-9);
    assert.ok(Math.abs(sepArcmin(0, 60, 1, 60) - 449.035) < 0.01, '15° of RA at dec 60 is a 7.484° great circle');
    assert.equal(extendedTol(rec({ id: 'a', maj: 10 }), { ...rec({ id: 'b', maj: 40 }), sources: [] }), null);
    assert.equal(extendedTol(rec({ id: 'a', maj: 10 }), { ...rec({ id: 'b', maj: 20 }), sources: [] }), 6);
  });

  test('by designation, with distance and part-of checks', () => {
    const c = new Catalog();
    assert.equal(c.add(rec({ id: 'Sh2-155', maj: 50, ids: ['LBN 529'] }), 'sh2'), 'added');
    assert.equal(c.add(rec({ id: 'Sh 2-155', maj: 40, min: 20, names: ['Cave Nebula'] }), 'lbn'), 'merged');
    const o = c.get('sharpless 2-155')!;
    assert.deepEqual(o.sources, ['sh2', 'lbn']);
    assert.deepEqual(o.names, ['Cave Nebula']);
    assert.equal(o.min, undefined, 'a minor axis from a different major axis is not taken');
    // the same designation far away is a different thing
    assert.equal(c.add(rec({ id: 'X 1', ids: ['LBN 529'], ra: 12 }), 'x'), 'added');
    // a record listing a much smaller object as a cross-id is not that object
    const big = rec({ id: 'LDN 1630', maj: 600, ids: ['Sh2-155'] });
    assert.equal(c.add(big, 'ldn'), 'added');
    assert.deepEqual(big.ids, []);
    assert.equal(c.add(rec({ id: 'Bad', ra: NaN }), 'x'), null);
  });

  test('by position, including next to the pole', () => {
    const c = new Catalog();
    const near = { types: ['HII'], tol: () => 5 };
    c.add(rec({ id: 'A', ra: 1, dec: 89.5 }), 's');
    // 180° of RA away but only ~0.9° across the pole: outside 5′
    assert.equal(c.add(rec({ id: 'B', ra: 13, dec: 89.6 }), 't', near), 'added');
    // same place, other RA cell at the pole
    assert.equal(c.add(rec({ id: 'C', ra: 1.01, dec: 89.51 }), 't', near), 'merged');
    // a large polar object reached from a declination band below its own
    const wide = { types: ['HII'], tol: extendedTol };
    c.add(rec({ id: 'D', ra: 22.3, dec: 87.76, maj: 420 }), 's');
    assert.equal(c.add(rec({ id: 'E', ra: 22.8, dec: 88.77, maj: 140 }), 't', wide), 'merged');
    // only candidates of the listed types are matched by position
    c.add(rec({ id: 'G1', type: 'G', ra: 6, dec: 0 }), 's');
    assert.equal(c.add(rec({ id: 'F', ra: 6, dec: 0 }), 't', near), 'added');
  });

  test('a merge fills the fields the object lacks, surface brightness included', () => {
    const c = new Catalog();
    c.add(rec({ id: 'NGC 1', type: 'G', maj: 2 }), 'openngc');
    c.add(rec({ id: 'NGC 1', type: 'G', mag: 12.1, sb: 13.4, pa: 30 }), 'rc3');
    const o = c.get('NGC 1')!;
    assert.equal(o.mag, 12.1);
    assert.equal(o.sb, 13.4);
    assert.equal(o.pa, 30);
  });

  test('a merge keeps every source type claim, and the classifying surveys settle the type', () => {
    const surveys = new Set(['vdb', 'sh2', 'rcw']);
    const c = new Catalog();
    // Maia Nebula: OpenNGC labels it HII; only the reflection survey and general catalogs match it
    c.add(rec({ id: 'NGC 1432', type: 'HII', ra: 3.76, dec: 24.37, maj: 60, ids: ['LBN 771'] }), 'openngc');
    c.add(rec({ id: 'LBN 771', type: 'Neb', ra: 3.76, dec: 24.37, maj: 60 }), 'lbn');
    c.add(rec({ id: 'vdB 21', type: 'RfN', ra: 3.76, dec: 24.37, maj: 50, ids: ['NGC 1432'] }), 'vdb');
    const maia = c.get('NGC 1432')!;
    assert.deepEqual(maia.claims, { openngc: 'HII', lbn: 'Neb', vdb: 'RfN' });
    assert.equal(maia.type, 'HII', 'the merge itself leaves the type alone');
    assert.equal(resolveType(maia, surveys), 'RfN');
    // a general catalog's unspecified Neb takes the survey's kind too
    assert.equal(resolveType({ type: 'Neb', claims: { ced: 'Neb', vdb: 'RfN' } }, surveys), 'RfN');
    // the surveys disagree (an HII region with a vdB entry): mixed, so the first catalog's type stands
    assert.equal(resolveType({ type: 'Neb', claims: { openngc: 'Neb', sh2: 'HII', vdb: 'RfN' } }, surveys), 'Neb');
    // a survey that agrees on the kind keeps the code (EmN and HII are both emission)
    assert.equal(resolveType({ type: 'EmN', claims: { openngc: 'EmN', sh2: 'HII' } }, surveys), 'EmN');
    // a general catalog is not evidence, and non-nebula codes are never weighed
    assert.equal(resolveType({ type: 'HII', claims: { openngc: 'HII', lbn: 'RfN' } }, surveys), 'HII');
    assert.equal(resolveType({ type: 'Cl+N', claims: { openngc: 'Cl+N', vdb: 'RfN' } }, surveys), 'Cl+N');
    assert.equal(resolveType({ type: 'HII' }, surveys), 'HII');
  });

  test('aliases do not take a designation that already names something', () => {
    const c = new Catalog();
    c.add(rec({ id: 'M 110' }), 's');
    c.add(rec({ id: 'NGC 1', ra: 0 }), 's');
    assert.equal(c.alias('NGC 205', 'M 110'), true);
    assert.equal(c.get('ngc205')?.id, 'M 110');
    assert.equal(c.alias('NGC 1', 'M 110'), false);
    assert.equal(c.alias('X', 'nothing'), false);
  });
});

describe('catalog build: output', () => {
  test('designation order and row cleaning', () => {
    assert.ok(idRank('α Lyr') < idRank('3 Lyr') && idRank('3 Lyr') < idRank('M 57') && idRank('M 57') < idRank('NGC 6720'));
    const row = tsvRow({ ...rec({ id: 'NGC 6720', ra: 18.893, dec: 33.03, ids: ['PGC 1', 'M 57', 'M 57', 'NGC 6720'], names: ['Ring\tNebula', 'a|b'] }), sources: ['openngc'] });
    const f = row.split('\t');
    assert.equal(f.length, TSV_HEADER.split('\t').length);
    assert.equal(f[4], 'Lyr', 'the constellation is computed when missing');
    assert.equal(f[11], 'Ring Nebula|a b');
    assert.equal(f[12], 'M 57|PGC 1');
  });

  test('an RA a hair under 24 h is written as 0, not as 24 (which the loader rejects)', () => {
    const row = tsvRow({ ...rec({ id: 'X 1', ra: 23.99999997, dec: 10, ids: [], names: [] }), sources: ['openngc'] });
    assert.equal(row.split('\t')[2], '0');
    assert.equal(tsvRow({ ...rec({ id: 'X 2', ra: 12.5, dec: 10, ids: [], names: [] }), sources: ['openngc'] }).split('\t')[2], '12.5');
  });

  test('downloads are cached, retried on server errors, and a client error moves on to the next mirror', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catdl-'));
    try {
      let calls = 0;
      const ok = new Downloader(dir, false, (async () => { calls++; return new Response(calls === 1 ? 'busy' : 'data', { status: calls === 1 ? 503 : 200 }); }) as typeof fetch, () => {}, 1);
      assert.equal(await ok.text('a.txt', 'http://x'), 'data');
      assert.equal(await ok.text('a.txt', 'http://x'), 'data');
      assert.equal(calls, 2, 'the second read came from the cache');
      assert.deepEqual(fs.readdirSync(dir), ['a.txt'], 'no temporary file left behind');
      let gone = 0;
      const missing = new Downloader(dir, false, (async () => { gone++; return new Response('', { status: 404 }); }) as typeof fetch, () => {}, 1);
      await assert.rejects(missing.text('b.txt', ['http://one', 'http://two']), /b\.txt: one: HTTP 404; two: HTTP 404/);
      assert.equal(gone, 2, 'a client error is not retried on the same mirror');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a mirror answering with an error page is retried, then the next mirror is used, and the error page is never cached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catdl-'));
    try {
      const asked: string[] = [];
      const table = '#c\nSh2\tDiam\n\tarcmin\n---\t---\n155\t50\n';
      const fetchFn = (async (url: string | URL) => {
        const host = new URL(String(url)).host;
        asked.push(host);
        if (host === 'down') return new Response('<!doctype html>Page unavailable', { status: 404 });
        // the mirror's database is unreachable for its first two answers
        return new Response(asked.filter((h) => h === 'flaky').length <= 2 ? '#INFO\tError=The database is not currently reachable.\t\n' : table);
      }) as typeof fetch;
      const d = new Downloader(dir, false, fetchFn, () => {}, 1);
      assert.equal(await d.text('t.tsv', ['http://down/q', 'http://flaky/q'], vizierError), table);
      assert.deepEqual(asked, ['down', 'flaky', 'flaky', 'flaky']);
      assert.equal(fs.readFileSync(path.join(dir, 't.tsv'), 'utf8'), table);
      assert.equal(vizierError('#INFO\tError=Table or Catalog not found: X/1\t\n'), 'Table or Catalog not found: X/1');
      assert.equal(vizierError('#\n#RESOURCE=\n#Name:\n'), 'no table in the response', 'an empty resource is a dropped query, not an empty table');
      assert.equal(vizierError('#c\nSh2\n\n---\n'), null, 'a table with no rows is still a table');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TAP results: quoted fields, missing columns and error documents', () => {
    const tsv = 'oid\tra\thit\n123\t83.8\t"NAME Orion Nebula"\n124\t\t"say ""hi"""\n';
    assert.deepEqual(parseTapTsv(tsv, 'q', ['oid', 'hit']), [{ oid: '123', ra: '83.8', hit: 'NAME Orion Nebula' }, { oid: '124', ra: '', hit: 'say "hi"' }]);
    assert.match(tapError(tsv, ['alt']) ?? '', /columns missing.*alt/);
    assert.match(tapError('<?xml version="1.0"?><VOTABLE><INFO name="QUERY_STATUS" value="ERROR">Incorrect ADQL query</INFO></VOTABLE>', []) ?? '', /query failed: Incorrect ADQL query/);
  });
});

describe('catalog build: SIMBAD, HyperLEDA and nearby-galaxy designations', () => {
  test('SIMBAD identifiers in this database\'s spelling; star, IR and radio surveys are not kept', () => {
    const cases: [string, string | null][] = [
      ['NGC  2579', 'NGC 2579'], ['IC 2599', 'IC 2599'], ['M  42', 'M 42'], ['SH  2-155', 'Sh2-155'], ['LBN   959', 'LBN 959'],
      ['Barnard  18F', 'B 18F'], ['VdB 12', 'vdB 12'], ['VdBH  3a', 'vdBH 3a'], ['Ced  32c', 'Ced 32c'], ['GUM 31', 'Gum 31'],
      ['PN A66   21', 'Abell 21'], ['PN G331.3-12.1', 'PN G331.3-12.1'], ['SNR G005.4-01.2', 'SNR G005.4-01.2'], ['LEDA 2557', 'PGC 2557'],
      ['ESO 351-30', 'ESO 351-30'], ['ACO  1656', 'ACO 1656'], ['ACO S  373', 'ACO S373'], ['Cl Collinder  399', 'Cr 399'],
      ['LHA 120-N  11', 'LHA 120-N 11'], ['NAME PN Kn 61', 'Kn 61'],
      ['HD  73882', null], ['IRAS 05327+3404', null], ['LBN 123.4-05.6', null], ['PN VV\'  474', null], ['NAME Orion Nebula', null],
    ];
    for (const [raw, want] of cases) assert.equal(simbadId(raw), want, raw);
  });

  test('SIMBAD names: common names kept, part labels, survey ids and designations dropped', () => {
    assert.equal(simbadName('NAME the Witch Head Nebula'), 'Witch Head Nebula');
    assert.equal(simbadName("NAME Barnard's Loop"), "Barnard's Loop");
    for (const keep of ['NAME Ring Nebula', 'NAME North America Nebula', 'NAME Southern Pinwheel', 'NAME Horsehead Nebula']) assert.ok(simbadName(keep), keep);
    for (const drop of ['NAME [BM89] L1082C', 'NAME Mon R2 IRS3', 'NAME Cygnus Loop Northern Shell', 'NAME PN Kn 40', 'NAME B18-F', 'NAME OAC', 'NGC 224', 'NAME Rho Oph region', 'NAME Vela']) {
      assert.equal(simbadName(drop), null, drop);
    }
  });

  test('SIMBAD rows group into objects, without a size where SIMBAD has the 32767 placeholder angle', () => {
    const row = (alt: string) => ({ oid: '7', ra: '161.26', dec: '-59.7', otype: 'HII', galdim_majaxis: '120', galdim_minaxis: '', galdim_angle: '32767', hit: 'GUM 33', alt });
    const [o, ...rest] = simbadObjects([row('NGC  3372'), row('RCW  53'), { ...row('X'), oid: '8', ra: '' }]);
    assert.equal(rest.length, 0, 'a row without a position is dropped');
    assert.deepEqual(o.keys, ['GUM 33']);
    assert.deepEqual(o.idents, ['NGC  3372', 'RCW  53']);
    assert.ok(Math.abs(o.ra - 161.26 / 15) < 1e-9);
    assert.equal(o.maj, 120);
    assert.equal(o.pa, undefined);
  });

  test('HyperLEDA alternate names: brackets, "!" and "?" are not the galaxy\'s own', () => {
    assert.deepEqual(ledaNames('UGC12889              MCG8-01-018           CGCG549-13            [RC2]A2357+47         IRAS23574+4659'), ['UGC 12889', 'MCG +8-01-018', 'CGCG 549-13']);
    assert.deepEqual(ledaNames('(NGC190)              (UGC397)              MCG1-02-042           HCG5B                 !MCG5-01-040          ?NGC21'), ['MCG +1-02-042', 'HCG 5B']);
    assert.equal(ledaName('ESO293-27'), 'ESO 293-27');
    assert.equal(ledaName('ESO-LV2930270'), null);
    assert.equal(ledaName('MRK1138'), 'Mrk 1138');
    assert.equal(ledaName('MCG-7-01-005'), 'MCG -7-01-005');
    assert.equal(ledaName('NGC0023'), 'NGC 23');
  });

  test('nearby-galaxy names', () => {
    assert.equal(prettyGalaxyName('UGC12894'), 'UGC 12894');
    assert.equal(prettyGalaxyName('ESO409-015'), 'ESO 409-15');
    assert.equal(prettyGalaxyName('ESO 410- G 005'), 'ESO 410-5');
    assert.equal(prettyGalaxyName('And XVIII'), 'Andromeda XVIII');
    assert.equal(prettyGalaxyName('MESSIER081'), 'M 81');
    assert.equal(prettyGalaxyName('KK 230'), 'KK 230');
    assert.equal(prettyGalaxyName('WLM'), 'WLM');
    assert.equal(prettyGalaxyName('HolmII'), 'Holmberg II');
    assert.equal(prettyGalaxyName('LeoIV'), 'Leo IV');
    assert.equal(prettyGalaxyName('LeoT'), 'Leo T');
    assert.equal(prettyGalaxyName('CVnII'), 'Canes Venatici II');
    assert.equal(prettyGalaxyName('UMa II'), 'Ursa Major II');
    assert.equal(prettyGalaxyName('Sc22'), 'Sc22');
    assert.equal(prettyGalaxyName('GARLAND'), 'GARLAND');
  });

  test('a source that may not create only adds names to objects already listed', () => {
    const c = new Catalog();
    c.add(rec({ id: 'PGC 2557', type: 'G', maj: 180 }), 'pgc');
    assert.equal(c.add(rec({ id: 'PGC 2557', type: 'G', ids: ['UGC 454'] }), 'leda', undefined, false), 'merged');
    assert.equal(c.get('UGC 454')?.id, 'PGC 2557');
    assert.equal(c.add(rec({ id: 'PGC 9', type: 'G', ra: 7 }), 'leda', undefined, false), null);
    assert.equal(c.get('PGC 9'), undefined);
    assert.equal(c.objects.length, 1);
  });

  test('a merge does not copy a designation that already names another object', () => {
    const c = new Catalog();
    c.add(rec({ id: 'NGC 1', type: 'G', ra: 0.1, dec: 27.7 }), 'openngc');
    c.add(rec({ id: 'PGC 564', type: 'G', ra: 0.1, dec: 27.71 }), 'pgc');
    c.add(rec({ id: 'PGC 564', type: 'G', ra: 0.1, dec: 27.71, ids: ['NGC 1', 'UGC 57'] }), 'leda');
    const pgc = c.get('PGC 564')!;
    assert.deepEqual(pgc.ids, ['UGC 57']);
    assert.equal(c.get('NGC 1')?.id, 'NGC 1');
  });
});
