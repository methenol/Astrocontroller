import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { filterId, sameFilter } from '../astro/acquisition/devices.js';
import { filterFromNames, librarySessionsLike, sessionDevice, sessionFilter } from '../library/sessions.js';
import { collected } from '../night/progress.js';
import type { Journal } from '../night/journal.js';

const D_DUO_1 = 'DWARF_RAW_TELE_NGC 281_EXP_120_GAIN_40_2026-10-01-22-00-00-100';
const D_DUO_2 = 'DWARF_RAW_TELE_NGC 281_EXP_120_GAIN_40_2026-10-03-22-00-00-100';
const D_ASTRO = 'DWARF_RAW_TELE_NGC 281_EXP_60_GAIN_60_2026-10-02-22-00-00-100';
const D_WIDE = 'DWARF_RAW_WIDE_NGC 281_EXP_120_GAIN_40_2026-10-01-22-00-00-200';
const S_LP = 'SEESTAR_RAW_TELE_NGC 281_EXP_60_GAIN_200_2026-10-04-21-00-00_LP';
const S_IR = 'SEESTAR_RAW_TELE_NGC 281_EXP_60_GAIN_200_2026-10-05-21-00-00_IRCUT';

const dwarfSubs = (filter: string, n: number) => Array.from({ length: n }, (_, i) => `NGC 281_120s40_${filter}_20261001-2200${String(i).padStart(2, '0')}000_41C.fits`);

describe('session filters and pooling', () => {
  const saved = config.paths.library;
  let dir = '';
  const make = (folder: string, files: string[], meta?: object) => {
    const d = path.join(dir, folder);
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(d, f), '');
    if (meta) fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify(meta));
  };
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filters-'));
    config.paths.library = dir;
    make(D_DUO_1, [...dwarfSubs('Duo-Band', 4), 'failed_x.fits', 'stacked.jpg']);
    make(D_DUO_2, dwarfSubs('Duo-Band', 2));
    make(D_ASTRO, dwarfSubs('Astro', 3));
    make(D_WIDE, dwarfSubs('Duo-Band', 2));
    make(S_LP, ['Light_NGC 281_60s_LP_20261004-210000.fit', 'Light_NGC 281_60s_LP_20261004-210100.fit']);
    make(S_IR, ['Light_NGC 281_60s_IRCUT_20261005-210000.fit']);
  });
  after(() => {
    config.paths.library = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('one name per filter across devices and labels', () => {
    assert.equal(filterId('Duo-Band (Ha/OIII)'), filterId('dual band'));
    assert.equal(filterId('IR-cut'), 'ircut');
    assert.ok(sameFilter('LP', 'lp_filter'));
    assert.ok(!sameFilter('LP', 'IRCUT'));
    assert.ok(!sameFilter('Astro', undefined));
    assert.ok(sameFilter(undefined, undefined));
  });

  test('the filter from a Seestar folder name and from Dwarf sub names', () => {
    assert.equal(filterFromNames(S_LP), 'LP');
    assert.equal(filterFromNames(D_DUO_1), 'Duo-Band');
    assert.equal(filterFromNames(D_ASTRO), 'Astro');
    assert.equal(filterFromNames(D_ASTRO, []), undefined, 'a Dwarf session without its subs says nothing');
    assert.equal(sessionDevice(D_DUO_1), 'dwarf');
    assert.equal(sessionDevice(S_LP), 'seestar');
  });

  test('session.json overrides the names', () => {
    const f = 'DWARF_RAW_TELE_M 1_EXP_15_GAIN_60_2026-10-01-22-00-00-000';
    make(f, [], { filter: 'Astro' });
    assert.equal(sessionFilter(f), 'Astro');
    fs.rmSync(path.join(dir, f), { recursive: true });
  });

  test('pooling takes only sessions of the same camera, device and filter', () => {
    assert.deepEqual(librarySessionsLike(D_DUO_2), [D_DUO_1, D_DUO_2]);
    assert.deepEqual(librarySessionsLike(D_ASTRO), [D_ASTRO]);
    assert.deepEqual(librarySessionsLike(D_WIDE), [D_WIDE]);
    assert.deepEqual(librarySessionsLike(S_LP), [S_LP], 'a Seestar LP night does not pool with Dwarf Duo-Band nights');
    assert.deepEqual(librarySessionsLike(S_IR), [S_IR]);
  });

  test('collected time counts only the wanted filter', () => {
    const journal = {
      recentSessions: () => [
        // the Dwarf's journal has no filter: counted only on a night the library has nothing from
        { target: 'NGC 281', night: '2026-10-01', stats: { integrationS: 99 * 60 } },
        { target: 'NGC 281', night: '2026-10-09', stats: { integrationS: 30 * 60 } },
        // the Seestar's names it
        { target: 'NGC 281', night: '2026-10-10', stats: { integrationS: 20 * 60, filter: 'IRCUT' } },
        { target: 'NGC 281', night: '2026-10-11', stats: { integrationS: 10 * 60, filter: 'Duo-Band' } },
      ],
    } as unknown as Pick<Journal, 'recentSessions'>;
    const key = [...collected(null).keys()][0]!;
    const all = collected(journal).get(key)!;
    const duo = collected(journal, { filterOf: () => 'Duo-Band' }).get(key)!;
    const astro = collected(journal, { filterOf: () => 'Astro' }).get(key)!;
    const auto = collected(journal, { filterOf: () => 'auto' }).get(key)!;
    // library (sub length from the folder): Duo-Band tele 4×2 + 2×2 min, wide 2×2 min; Astro 3×1 min; LP 2×1 min; IRCUT 1 min
    assert.equal(duo.libraryMin, 8 + 4 + 4);
    assert.equal(duo.totalMin, 16 + 30 + 10);
    assert.equal(astro.libraryMin, 3);
    assert.equal(astro.totalMin, 3 + 30);
    assert.equal(auto.totalMin, all.totalMin);
    assert.ok(all.totalMin > duo.totalMin);
  });
});
