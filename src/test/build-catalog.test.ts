import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { num, sexa, crossIds, parseOpenNgc, prettyOpenNgcId } from '../tools/catalog/parse.js';
import { Catalog, sepArcmin, extendedTol, resolveType } from '../tools/catalog/merge.js';
import { Downloader, parseVizierTsv } from '../tools/catalog/fetch.js';
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

  test('downloads are cached, retried on server errors, and a client error is final', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catdl-'));
    try {
      let calls = 0;
      const ok = new Downloader(dir, false, (async () => { calls++; return new Response(calls === 1 ? 'busy' : 'data', { status: calls === 1 ? 503 : 200 }); }) as typeof fetch, () => {});
      // the first attempt fails with 503; the backoff before the second is 3 s
      assert.equal(await ok.text('a.txt', 'http://x'), 'data');
      assert.equal(await ok.text('a.txt', 'http://x'), 'data');
      assert.equal(calls, 2, 'the second read came from the cache');
      assert.deepEqual(fs.readdirSync(dir), ['a.txt'], 'no temporary file left behind');
      let gone = 0;
      const missing = new Downloader(dir, false, (async () => { gone++; return new Response('', { status: 404 }); }) as typeof fetch, () => {});
      await assert.rejects(missing.text('b.txt', 'http://x'), /HTTP 404 \(attempt 1 of 3\)/);
      assert.equal(gone, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
