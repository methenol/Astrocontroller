import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SafeEmitter } from '../util/events.js';

describe('SafeEmitter', () => {
  test('a throwing listener neither throws out of emit nor stops the others; once still fires once', () => {
    const e = new SafeEmitter();
    const got: string[] = [];
    e.on('x', () => {
      throw new Error('bug');
    });
    e.once('x', (v: string) => got.push(`once ${v}`));
    e.on('x', (v: string) => got.push(`on ${v}`));
    assert.equal(e.emit('x', 'a'), true);
    e.emit('x', 'b');
    assert.deepEqual(got, ['once a', 'on a', 'on b']);
    assert.equal(e.emit('nobody'), false);
  });

  test("'error' with no listener still throws", () => {
    assert.throws(() => new SafeEmitter().emit('error', new Error('unhandled')), /unhandled/);
  });
});
