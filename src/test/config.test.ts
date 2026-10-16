import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Env } from '../config/env.js';
import { HostOverride, validHost } from '../config/host.js';
import { errMsg, logBus, logger, recentLogs } from '../log.js';

describe('Env', () => {
  test('host and time zone are validated; cross-variable problems are reported', () => {
    const e = new Env({ H: 'dwarf.local', BH: 'http://x', T: 'Europe/Berlin', BT: 'Mars/Olympus' });
    assert.equal(e.host('H', 'd'), 'dwarf.local');
    assert.equal(e.host('BH', 'd'), 'd');
    assert.equal(e.timezone('T', 'UTC'), 'Europe/Berlin');
    assert.equal(e.timezone('BT', 'UTC'), 'UTC');
    e.report('A and B must be set together');
    assert.throws(() => e.check(), (err: Error) => /BH must be an IP address/.test(err.message) && /BT must be an IANA/.test(err.message) && /set together/.test(err.message));
  });

  test('reads typed values and falls back when unset or blank', () => {
    const e = new Env({ A: ' 5 ', B: 'yes', C: 'off', D: '', U: 'http://x:8000/v1//', J: '{"k":1}', O: 'shared' });
    assert.equal(e.num('A', 0), 5);
    assert.equal(e.bool('B', false), true);
    assert.equal(e.bool('C', true), false);
    assert.equal(e.num('D', 7), 7);
    assert.equal(e.optNum('missing'), null);
    assert.equal(e.url('U', ''), 'http://x:8000/v1');
    assert.deepEqual(e.json('J'), { k: 1 });
    assert.equal(e.oneOf('O', ['auto', 'shared'] as const, 'auto'), 'shared');
    assert.doesNotThrow(() => e.check());
  });

  test('a bad URL is reported without the password it carries', () => {
    const e = new Env({ U: 'ftp://studio:hunter2@gpu-box:8000' });
    e.url('U', '');
    assert.throws(() => e.check(), (err: Error) => /U must be an http\(s\) URL/.test(err.message) && !err.message.includes('hunter2'));
  });

  test('every problem is reported at once', () => {
    const e = new Env({ P: '70000', L: '91', B: 'maybe', O: 'x', U: 'ftp://h', J: '[1]', I: '1.5', N: 'abc' });
    e.port('P', 1);
    e.optNum('L', { min: -90, max: 90 });
    e.bool('B', true);
    e.oneOf('O', ['a', 'b'] as const, 'a');
    e.url('U', '');
    e.json('J');
    e.num('I', 1, { int: true });
    e.num('N', 1);
    assert.throws(
      () => e.check(),
      (err: Error) => {
        for (const name of ['P', 'L', 'B', 'O', 'U', 'J', 'I', 'N']) assert.match(err.message, new RegExp(`- ${name} must be`));
        assert.match(err.message, /L must be a number between -90 and 90 \(got "91"\)/);
        return true;
      },
    );
  });
});

describe('telescope host override', () => {
  let dir = '';
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('validHost accepts IPs and names, refuses the rest', () => {
    for (const h of ['192.168.88.1', 'dwarf.local', 'a-b.c']) assert.ok(validHost(h), h);
    for (const h of ['', '-a', 'a..b', 'a b', 'http://x', 'a'.repeat(64), '300.1.1.1', '192.168.1', '1.2.3.4.5']) assert.ok(!validHost(h), h);
    for (const h of ['0.0.0.0', '255.255.255.255', '10.0.0.1', 'dwarf3', 'host-1.lan']) assert.ok(validHost(h), h);
  });

  test('set saves atomically, load reads it back, the .env address or empty drops it', () => {
    const file = path.join(dir, 'sub', 'telescope.json');
    const o = new HostOverride(file, '192.168.88.1');
    assert.equal(o.load(), null);
    assert.equal(o.set(' 10.0.0.5 '), '10.0.0.5');
    assert.equal(o.load(), '10.0.0.5');
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(`${file}.tmp`));
    assert.throws(() => o.set('not a host'), /not an IP address/);
    assert.equal(o.set('192.168.88.1'), '192.168.88.1');
    assert.ok(!fs.existsSync(file));
    assert.equal(o.load(), null);
  });

  test('a corrupt or invalid saved file is ignored', () => {
    const file = path.join(dir, 'telescope.json');
    fs.writeFileSync(file, '{bad');
    assert.equal(new HostOverride(file, 'h').load(), null);
    fs.writeFileSync(file, JSON.stringify({ host: 'a b' }));
    assert.equal(new HostOverride(file, 'h').load(), null);
  });
});

describe('log', () => {
  test('recentLogs keeps entries in order and honours the limit', () => {
    logger('t').info('first');
    logger('t').info('second');
    const last = recentLogs(2).map((e) => e.msg);
    assert.deepEqual(last, ['first', 'second']);
    assert.deepEqual(recentLogs(0), []);
  });

  test('a throwing log listener neither throws into the caller nor starves other listeners', () => {
    const got: string[] = [];
    const bad = () => {
      throw new Error('boom');
    };
    const good = (e: { msg: string }) => got.push(e.msg);
    logBus.on('log', bad);
    logBus.on('log', good);
    try {
      assert.doesNotThrow(() => logger('t').info('hello'));
      assert.deepEqual(got, ['hello']);
      assert.equal(recentLogs(1)[0].msg, 'hello');
    } finally {
      logBus.off('log', bad);
      logBus.off('log', good);
    }
  });

  test('errMsg reads errors, error-like objects and plain values', () => {
    assert.equal(errMsg(new Error('e')), 'e');
    assert.equal(errMsg({ message: 'm' }), 'm');
    assert.equal(errMsg({ code: 3 }), '{"code":3}');
    assert.equal(errMsg('s'), 's');
    assert.equal(errMsg(undefined), 'undefined');
    const cyc: Record<string, unknown> = {};
    cyc.c = cyc;
    assert.equal(errMsg(cyc), '[object Object]');
  });
});
