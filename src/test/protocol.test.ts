import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Cmd, requestType, responseType, protoTypeByName, decodeWith, rawDecode, decodeNotification, errorText, NOTIFY } from '../dwarf/protocol.js';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('protocol', () => {
  test('rawDecode reads varints, fixed and length fields; repeats become arrays', () => {
    // f1=150, f2="hi", f1=1, f3=1.5 (double)
    const d = new Uint8Array([0x08, 0x96, 0x01, 0x12, 0x02, 0x68, 0x69, 0x08, 0x01, 0x19, ...new Uint8Array(new Float64Array([1.5]).buffer)]);
    assert.deepEqual(rawDecode(d), { f1: [150, 1], f2: 'hi', f3: 1.5 });
  });

  test('rawDecode reads a negative int64 and keeps binary as hex', () => {
    // f1 = -1 (ten-byte varint), f2 = bytes 00 ff
    const d = bytes(0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x12, 0x02, 0x00, 0xff);
    assert.deepEqual(rawDecode(d), { f1: -1, f2: '00ff' });
  });

  test('rawDecode marks truncated or unreadable payloads with _hex and keeps what it read', () => {
    assert.deepEqual(rawDecode(bytes(0x08, 0x05, 0x12, 0x09, 0x61)), { f1: 5, _hex: '0805120961' }, 'length past the end');
    assert.equal(rawDecode(bytes(0x19, 0x00, 0x00))._hex, '190000', 'double past the end');
    assert.equal(rawDecode(bytes(0x08, 0x80)).f1, undefined, 'unterminated varint');
    assert.ok(rawDecode(bytes(0x0b))._hex, 'group wire type');
    assert.ok(rawDecode(bytes(0x00, 0x01))._hex, 'field number 0');
    assert.deepEqual(rawDecode(new Uint8Array(0)), {});
  });

  test('rawDecode honours the view offset of a subarray', () => {
    const buf = bytes(0xaa, 0xbb, 0x19, ...new Uint8Array(new Float64Array([2.25]).buffer));
    assert.deepEqual(rawDecode(buf.subarray(2)), { f3: 2.25 });
  });

  test('typed requests round-trip, including the V3 variants', () => {
    const t = requestType(Cmd.ASTRO_START_GOTO_DSO)!;
    const enc = t.encode(t.create({ ra: 1.5, dec: -2, targetName: 'M 31', gotoOnly: true })).finish();
    assert.deepEqual(decodeWith(t, enc), { ra: 1.5, dec: -2, targetName: 'M 31', gotoOnly: true });
    assert.ok(requestType(Cmd.STEP_MOTOR_RUN_TO), 'commands the SDK lacks have codecs');
    assert.ok(responseType(Cmd.STEP_MOTOR_GET_POSITION));
    assert.equal(responseType(Cmd.ASTRO_STOP_RESTACKED), protoTypeByName('base.ComResponse'));
  });

  test('a payload that does not fit its type falls back to the schema-less decode', () => {
    const t = protoTypeByName('base.ComResponse');
    assert.ok(decodeWith(t, bytes(0x08, 0x80))._hex);
  });

  test('protoTypeByName rejects unknown or malformed names', () => {
    assert.throws(() => protoTypeByName('base.Nope'), /unknown proto type/);
    assert.throws(() => protoTypeByName('extra.Nope'), /unknown proto type/);
    assert.throws(() => protoTypeByName('nodot'), /pkg\.Name/);
    assert.throws(() => protoTypeByName('base.'), /pkg\.Name/);
  });

  test('notifications are named; unknown ones keep their command id', () => {
    assert.equal(decodeNotification(15201, new Uint8Array(0)).name, 'battery');
    const u = decodeNotification(15999, bytes(0x08, 0x02));
    assert.deepEqual(u, { name: 'notify_15999', data: { f1: 2 } });
    assert.ok(Object.isFrozen(NOTIFY));
    assert.ok(Object.isFrozen(Cmd));
  });

  test('errorText names the code and adds the hint', () => {
    assert.match(errorText(-14520), /\(-14520\) — motors must be homed/);
    assert.match(errorText(-987654), /unknown error \(-987654\)/);
  });
});
