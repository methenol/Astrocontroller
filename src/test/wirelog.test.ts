import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WireLog } from '../drivers/dwarf/wirelog.js';

describe('wire log', () => {
  let dir = '';
  let file = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'));
    file = path.join(dir, 'w.log');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('lines are batched and written on flush; the ring keeps the last entries', () => {
    const w = new WireLog(() => file, { ring: 3, now: () => Date.UTC(2026, 9, 12, 1, 2, 3) });
    for (let i = 0; i < 5; i++) w.add('>', `CMD_${i}`, { i });
    assert.equal(fs.existsSync(file), false, 'nothing written before the flush');
    w.flush();
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    assert.equal(lines[0], '2026-10-12T01:02:03.000Z > CMD_0 {"i":0}');
    assert.deepEqual(w.recent(10).map((e) => e.what), ['CMD_2 {"i":2}', 'CMD_3 {"i":3}', 'CMD_4 {"i":4}']);
    assert.deepEqual(w.recent(0), []);
  });

  test('replies keep more payload than other lines; unserialisable data does not throw', () => {
    const w = new WireLog(() => file);
    const big = { s: 'x'.repeat(1000) };
    w.add('<', 'R', big);
    w.add('~', 'N', big);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    w.add('>', 'C', cyc);
    w.add('>', 'B', { n: 10n });
    const [r, n, c, b] = w.recent(4);
    assert.ok(!r.what.endsWith('…'));
    assert.ok(n.what.endsWith('…') && n.what.length < 300);
    assert.equal(c.what, 'C [object Object]');
    assert.equal(b.what, 'B {"n":"10"}');
  });

  test('rotates by bytes, keeping one previous file', () => {
    const w = new WireLog(() => file, { maxBytes: 200 });
    w.add('!', 'é'.repeat(80)); // ~188 bytes but only ~108 characters
    w.flush();
    w.add('!', 'second');
    w.flush();
    assert.ok(fs.existsSync(`${file}.1`), 'rotated: the size is counted in bytes, not characters');
    assert.match(fs.readFileSync(file, 'utf8'), /second/);
  });

  test('a write that fails is dropped without throwing', () => {
    const w = new WireLog(() => path.join(dir, 'missing', 'w.log'));
    w.add('!', 'x');
    assert.doesNotThrow(() => w.flush());
  });

  test('keeps logging when the previous file cannot be replaced', () => {
    fs.mkdirSync(`${file}.1`); // a directory: the rename onto it fails
    fs.writeFileSync(`${file}.1/keep`, '');
    const w = new WireLog(() => file, { maxBytes: 100 });
    w.add('!', 'a'.repeat(90));
    w.flush();
    w.add('!', 'after rotation');
    w.flush();
    assert.match(fs.readFileSync(file, 'utf8'), /after rotation/);
  });

  test('one entry is one line, whatever its text holds', () => {
    const w = new WireLog(() => file);
    w.add('x', 'failed:\n  at a\r\n  at b');
    w.flush();
    assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 1);
    assert.doesNotMatch(w.recent(1)[0].what, /\n/);
  });
});
