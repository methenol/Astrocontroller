import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compact, listResearch, searchResearch, type ResearchEntry } from '../web/routes/research.js';

const M33 = `# M 33 — The Triangulum Galaxy (NGC 598)

_Research package compiled 2026-11-09. Look-up only._

The third-largest galaxy in our Local Group.

## At a glance

| | |
|---|---|
| Other names | NGC 598, M33, Triangulum Galaxy, UGC 1117, PGC 5818 |

## Reference imagery
![M 33: DSS2](captures/agent/2026-11-09T17-31-02-326Z_001_reference_Triangulum_Galaxy.jpg)
`;
const SH2 = `# Sh2-119 — The Clamshell Nebula

Emission nebula in Cygnus.

| Other names | Clamshell Nebula · LBN 391 · LBN 400 |
`;

describe('research library', () => {
  let entries: ResearchEntry[];
  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-'));
    fs.writeFileSync(path.join(dir, 'M-33.md'), M33);
    fs.writeFileSync(path.join(dir, 'Sh2-119.md'), SH2);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a package');
    entries = listResearch(dir);
  });

  test('lists the .md packages with their title, date, first image and aliases', () => {
    assert.deepEqual(entries.map((e) => e.name).sort(), ['M-33', 'Sh2-119']);
    const m = entries.find((e) => e.name === 'M-33')!;
    assert.equal(m.title, 'M 33 — The Triangulum Galaxy (NGC 598)');
    assert.equal(m.date, '2026-11-09');
    assert.equal(m.hook, 'The third-largest galaxy in our Local Group.');
    assert.match(m.image ?? '', /^captures\/agent\/.*Triangulum_Galaxy\.jpg$/);
    assert.ok(m.aliases.includes('UGC 1117'));
    assert.ok(entries.find((e) => e.name === 'Sh2-119')!.aliases.includes('LBN 391'));
  });

  test('a search ignores case, spaces and dashes', () => {
    assert.equal(compact('M-33'), compact('m 33'));
    for (const q of ['m33', 'M 33', 'NGC598', 'triangulum', 'ugc 1117']) assert.deepEqual(searchResearch(q, entries).map((e) => e.name), ['M-33'], q);
    assert.deepEqual(searchResearch('lbn 400', entries).map((e) => e.name), ['Sh2-119']);
    assert.equal(searchResearch('', entries).length, 2);
    assert.equal(searchResearch('Andromeda', entries).length, 0);
  });
});
