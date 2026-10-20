import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, commandsIn, commandFields, commandInfo, decodePayload, encodePayload, moduleIdFor, moduleIdForCmd, parseIncoming, payloadFields } from '../dwarf/wire/index.js';
import { CONNECT_TIMEOUT_MS, MESSAGE_TYPE, PING_INTERVAL_MS, PROTOCOL_MAJOR, PROTOCOL_MINOR, WS_PORT, decodePacket, encodePacket, headerFor } from '../dwarf/wire/transport.js';
import { Command, encodePacket as sdkEncodePacket, MessageType as SdkMessageType } from '@alikh/dwarflab-sdk';
import { DWARF_COMMANDS, DWARF_COMMANDS_BY_ID } from '../dwarf/wire/generated/catalog.generated.js';
import { PARAMS_RANGE, exposureIndex } from '../dwarf/wire/generated/params.generated.js';
import type { FieldSpec } from '../dwarf/wire/generated/payloads.generated.js';

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Decoded bytes and hand-written values are compared after this: bytes become arrays, keys become camelCase. */
function canon(v: unknown): unknown {
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => [camel(k), canon(x)])
        .sort(),
    );
  return v;
}

/** A value for every field the schema can express, so a field the encoder drops shows up as a missing key. */
function sampleFields(fields: readonly FieldSpec[], depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    let v: unknown;
    if (f.kind === 'message') {
      if (depth > 2 || !f.type) continue;
      const sub = payloadFields(f.type);
      if (!sub?.length) continue;
      v = sampleFields(sub, depth + 1);
    } else if (f.kind === 'string') v = 'probe';
    else if (f.kind === 'bool') v = true;
    else if (f.kind === 'bytes') v = new Uint8Array([1, 2, 250]);
    else if (f.kind === 'double' || f.kind === 'float') v = 1.25;
    else if (['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'].includes(f.kind)) v = '7';
    else if (['double', 'float', 'int32', 'uint32', 'sint32', 'fixed32', 'sfixed32'].includes(f.kind)) v = 7;
    else if (f.kind === 'enum') v = 1;
    else continue;
    out[f.name] = f.repeated ? [v] : v;
  }
  return out;
}

describe('the control plane as the APK frames it', () => {
  test('the endpoint and socket tuning are the ones MyWsManager uses', () => {
    assert.equal(WS_PORT, 9900);
    assert.equal(PING_INTERVAL_MS, 40_000);
    assert.equal(CONNECT_TIMEOUT_MS, 5_000);
  });

  test('every request carries the header rw4.d() writes, not the one base.proto declares', () => {
    assert.deepEqual([PROTOCOL_MAJOR, PROTOCOL_MINOR], [2, 3], 'the app sends 2.3; WS_MINOR_VERSION_NUMBER=7 is never on the wire');
    const v = decodePacket(buildRequest('CMD_DEVICE_ANTI_TANGLE', { state: 1 }, { deviceId: 7, clientId: 'c-1' }).bytes);
    assert.deepEqual([v.majorVersion, v.minorVersion, v.deviceId, v.cmd, v.type, v.clientId], [2, 3, 7, 17003, MESSAGE_TYPE.request, 'c-1']);
  });

  test('the packet carries the module ordinal, the way getModuleId().ordinal() does', () => {
    assert.equal(moduleIdFor('MOTOR'), 6);
    assert.equal(moduleIdFor('DEVICE'), 18);
    const v = decodePacket(buildRequest('CMD_DEVICE_ANTI_TANGLE', { state: 1 }).bytes);
    assert.equal(v.moduleId, 18);
  });

  test('with the sdk header it writes the packet the SDK encoder wrote, byte for byte', () => {
    // The app used to frame every request with the SDK's encoder. Switching framing here must not
    // change a byte of the traffic it has always put on the wire, or the firmware sees a new client.
    const cmd = 11_021;
    const payload = new Uint8Array([0x08, 0x01, 0x10, 0x2a]);
    const theirs = sdkEncodePacket(cmd, SdkMessageType.REQUEST, payload, 'astrocontroller', 1);
    const ours = encodePacket({ cmd, moduleId: moduleIdForCmd(cmd), type: MESSAGE_TYPE.request, data: payload, clientId: 'astrocontroller', deviceId: 1, ...headerFor('sdk') });
    assert.deepEqual(Buffer.from(ours), Buffer.from(theirs));
  });

  test('every command the SDK knows still frames to the bytes it sent', () => {
    // The module ordinal is what the device routes on, and the SDK filled it from its own table.
    // The recovered WsCmd must agree for all of them; the ones the SDK never registered (the device
    // switches, motor run-to) are where the recovered table is the only source, checked above.
    const ids = [...new Set(Object.values(Command).filter((v): v is number => typeof v === 'number'))];
    assert.ok(ids.length > 300, `expected the SDK's full command table, got ${ids.length}`);
    const payload = new Uint8Array([0x08, 0x01]);
    for (const cmd of ids) {
      const theirs = sdkEncodePacket(cmd, SdkMessageType.REQUEST, payload, 'astrocontroller', 1);
      const ours = encodePacket({ cmd, moduleId: moduleIdForCmd(cmd), type: MESSAGE_TYPE.request, data: payload, clientId: 'astrocontroller', deviceId: 1, ...headerFor('sdk') });
      assert.deepEqual(Buffer.from(ours), Buffer.from(theirs), `command ${cmd} frames differently from the SDK`);
    }
  });

  test('an id the APK reuses resolves to one name rather than guessing', () => {
    const names = Object.entries(DWARF_COMMANDS)
      .filter(([, s]) => s.id === 15245)
      .map(([n]) => n)
      .sort();
    assert.deepEqual(names, ['CMD_NOTIFY_PANORAMA_UPLOAD_COMPLETE', 'CMD_NOTIFY_PANORAMA_UPLOAD_UPLOAD_PROGRESS']);
    assert.equal(typeof DWARF_COMMANDS_BY_ID[15245], 'string');
  });
});

describe('payloads from the descriptors the APK ships', () => {
  test('a payload survives the packet, in the spelling the caller picked', () => {
    assert.deepEqual(parseIncoming(buildRequest('CMD_DEVICE_ANTI_TANGLE', { state: 1 }).bytes).payload, { state: 1 });
    const rect = commandFields('CMD_PANORAMA_UPDATE_FRAMING_RECT', 'request');
    assert.ok(rect.length >= 4, 'the recovered schema for the framing rect should have fields');
    const snake = Object.fromEntries(rect.map((f) => [f.name, 1.25]));
    const camelIn = Object.fromEntries(rect.map((f) => [camel(f.name), 2.5]));
    assert.deepEqual(parseIncoming(buildRequest('CMD_PANORAMA_UPDATE_FRAMING_RECT', snake).bytes).payload, Object.fromEntries(rect.map((f) => [camel(f.name), 1.25])));
    assert.deepEqual(parseIncoming(buildRequest('CMD_PANORAMA_UPDATE_FRAMING_RECT', camelIn).bytes).payload, camelIn);
  });

  test('a name the message does not declare is refused, at any depth, rather than sent empty', () => {
    assert.throws(() => buildRequest('CMD_DEVICE_ANTI_TANGLE', { definitelyNotAField: 1 }), /definitelyNotAField/);
    assert.throws(() => buildRequest('CMD_SYNC_SHOOTING_SCHEDULE', { shooting_schedule: { schedule_id: 1, bogus_child: 2 } }), /bogus_child/);
    assert.throws(() => encodePayload('motor.ReqMotorStop', { nope: 1 }), /nope/);
  });

  test('a command whose payload the APK never described takes no fields', () => {
    assert.equal(commandInfo('CMD_STEP_MOTOR_STOP').request, undefined);
    assert.equal(decodePacket(buildRequest('CMD_STEP_MOTOR_STOP').bytes).cmd, 14002);
    assert.throws(() => buildRequest('CMD_STEP_MOTOR_STOP', { id: 1 }), /no recovered request payload/);
    assert.throws(() => commandInfo('CMD_NOT_A_COMMAND'), /unknown command/);
  });

  test('a frame from the device decodes to declared fields only', () => {
    const name = 'CMD_NOTIFY_TELE_WIDE_PICTURE_MATCHING';
    const spec = commandInfo(name);
    const fields = commandFields(name, 'response');
    const wanted = sampleFields(fields);
    const frame = parseIncoming(
      encodePacket({
        cmd: spec.id,
        moduleId: moduleIdFor(spec.module),
        type: MESSAGE_TYPE.notification,
        data: encodePayload(String(spec.response), wanted),
      }),
    );
    assert.deepEqual([frame.commandName, frame.isNotification, frame.payloadType], [name, true, spec.response]);
    assert.deepEqual(canon(frame.payload), canon(wanted));
    // protobufjs would add a `<oneofName>: "<field>"` marker; consumers must not see it.
    const declared = fields.map((f) => camel(f.name)).sort();
    assert.deepEqual(Object.keys(frame.payload ?? {}).sort(), declared);
  });

  test('every command with a recoverable request round-trips what it was given', () => {
    const built: string[] = [];
    const problems: string[] = [];
    for (const [name, spec] of Object.entries(DWARF_COMMANDS)) {
      if (!spec.request) continue;
      const fields = commandFields(name, 'request');
      const wanted = sampleFields(fields);
      if (Object.keys(wanted).length === 0) continue;
      let bytes: Uint8Array<ArrayBufferLike>;
      try {
        bytes = buildRequest(name, wanted).bytes;
      } catch (e) {
        problems.push(`${name}: ${String(e)}`);
        continue;
      }
      built.push(name);
      const packet = decodePacket(bytes);
      if (packet.cmd !== spec.id) problems.push(`${name}: cmd ${packet.cmd} != ${spec.id}`);
      else if (packet.majorVersion !== 2 || packet.minorVersion !== 3) problems.push(`${name}: header ${packet.majorVersion}.${packet.minorVersion}`);
      else {
        const want = canon(wanted) as Record<string, unknown>;
        const have = canon(parseIncoming(bytes).payload ?? {}) as Record<string, unknown>;
        const lost = Object.keys(want).filter((k) => !(k in have));
        if (lost.length) problems.push(`${name}: dropped ${lost.join(',')}`);
        else {
          const differ = Object.keys(want).find((k) => JSON.stringify(want[k]) !== JSON.stringify(have[k]));
          if (differ !== undefined) problems.push(`${name}: ${differ} -> ${JSON.stringify(have[differ])} != ${JSON.stringify(want[differ])}`);
        }
      }
    }
    assert.ok(built.length > 50, `the sweep should exercise a real share of the catalogue, got ${built.length}`);
    assert.deepEqual(problems, []);
  });

  test('decoded 64-bit fields stay strings so a counter cannot lose precision', () => {
    const fields = payloadFields('notify.GeneralIntParam') ?? [];
    const sixtyFour = fields.find((f) => ['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'].includes(f.kind));
    assert.ok(sixtyFour !== undefined, 'the APK ships 64-bit ids, so the decoder must not round them through a JS number');
    const beyondSafeInteger = '9007199254740993'; // 2^53 + 1: unrecoverable as a double
    const decoded = decodePayload('notify.GeneralIntParam', encodePayload('notify.GeneralIntParam', { [sixtyFour.name]: beyondSafeInteger }));
    assert.equal(decoded[camel(sixtyFour.name)], beyondSafeInteger);
  });
});

describe('the catalogue describes the APK', () => {
  test('every command belongs to a module and is reachable by id', () => {
    for (const [name, spec] of Object.entries(DWARF_COMMANDS)) {
      assert.ok(spec.module.length > 0, `${name} has no module`);
      assert.equal(DWARF_COMMANDS_BY_ID[spec.id] !== undefined, true, `${name} is unreachable by id`);
    }
    assert.equal(commandsIn('MOTOR').length, 13);
    assert.ok(commandsIn('MOTOR').every((n) => DWARF_COMMANDS[n]?.module === 'MOTOR'));
  });

  test('every payload the catalogue names is a schema the recovery actually defines', () => {
    const missing = Object.entries(DWARF_COMMANDS).flatMap(([n, s]) => [s.request, s.response].filter((r): r is string => !!r && payloadFields(r) === null).map((r) => `${n} -> ${r}`));
    assert.deepEqual(missing, [], 'a catalogue reference that no schema backs would make buildRequest throw at runtime');
  });

  test('the shutter labels map to the raw index the firmware wants', () => {
    assert.ok(PARAMS_RANGE.expValues.length > 20);
    assert.equal(exposureIndex('1/1000'), 30);
    assert.equal(exposureIndex('9/1'), null);
  });
});
