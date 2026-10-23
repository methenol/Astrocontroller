import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { DwarfLink, DwarfCommandError, TelescopeUnresponsiveError, type LinkTiming } from '../drivers/dwarf/link.js';
import { Cmd } from '../drivers/dwarf/protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAST: Partial<LinkTiming> = {
  checkEveryMs: 20,
  pingEveryMs: 50,
  deadSocketMs: 400,
  probeIfQuietMs: 150,
  probeTimeoutMs: 100,
  probeWhileHungMs: 100,
  strikes: 3,
  silenceMs: 300,
  stableMs: 500,
  shortMs: 200,
  contendedRetryMs: 1000,
  backoffMinMs: 20,
  backoffMaxMs: 100,
  requestTimeoutMs: 300,
};

describe('DwarfLink against the fake telescope', () => {
  let fake: FakeDwarf;
  let link: DwarfLink;

  beforeEach(async () => {
    fake = await new FakeDwarf().start();
    link = new DwarfLink('127.0.0.1', fake.port, FAST);
  });

  afterEach(async () => {
    link.stop();
    await fake.stop();
  });

  test('connects, sends a request with its protobuf payload and resolves with the reply', async () => {
    fake.reply(Cmd.CAMERA_TELE_GET_ALL_PARAMS, { code: 0 });
    link.start();
    await link.waitConnected(2000);
    const r = await link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS);
    assert.equal(r?.code ?? 0, 0);
    assert.equal(fake.requestsFor(Cmd.CAMERA_TELE_GET_ALL_PARAMS).length, 1);
    assert.equal(link.health().state, 'connected');
  });

  test('a negative reply code rejects with DwarfCommandError carrying the code', async () => {
    fake.reply(Cmd.ASTRO_START_GOTO_DSO, { code: -11501 });
    link.start();
    await link.waitConnected(2000);
    await assert.rejects(link.request(Cmd.ASTRO_START_GOTO_DSO, { ra: 1, dec: 2, targetName: 'x' }), (e: unknown) => {
      assert.ok(e instanceof DwarfCommandError);
      assert.equal(e.code, -11501);
      return true;
    });
  });

  test('allowError resolves with the error payload instead of throwing', async () => {
    fake.reply(Cmd.ASTRO_START_GOTO_DSO, { code: -11501 });
    link.start();
    await link.waitConnected(2000);
    const r = await link.request(Cmd.ASTRO_START_GOTO_DSO, {}, { allowError: true });
    assert.equal(r?.code, -11501);
  });

  test('replies to the same command are matched in order, and `match` picks the right one', async () => {
    let n = 0;
    fake.on(Cmd.CAMERA_TELE_GET_ALL_PARAMS, async () => {
      const mine = ++n;
      await sleep(mine === 1 ? 60 : 0);
      return { code: -mine };
    });
    link.start();
    await link.waitConnected(2000);
    const a = link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS, {}, { allowError: true, match: (d) => d.code === -1 });
    const b = link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS, {}, { allowError: true, match: (d) => d.code === -2 });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra?.code, -1);
    assert.equal(rb?.code, -2);
  });

  test('a command with no reply times out; best-effort resolves null', async () => {
    fake.silent(Cmd.CAMERA_TELE_GET_ALL_PARAMS);
    link.start();
    await link.waitConnected(2000);
    await assert.rejects(link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS, {}, { timeout: 100 }), /timed out/);
    assert.equal(await link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS, {}, { timeout: 100, bestEffort: true }), null);
  });

  test('notifications are decoded with their notify type and emitted', async () => {
    link.start();
    await link.waitConnected(2000);
    const got = link.waitFor((n) => n.name === 'teleStackingProgress', 2000);
    await fake.notify('teleStackingProgress', { totalCount: 999, currentCount: 12, stackedCount: 3, cameraType: 1, targetName: 'C 20' });
    const n = await got;
    assert.equal(n.data.currentCount, 12);
    assert.equal(n.data.stackedCount, 3);
    assert.equal(n.data.cameraType, 1);
    assert.equal(n.data.targetName, 'C 20');
  });

  test('a dropped socket fails pending requests, emits disconnected, and reconnects by itself', async () => {
    fake.silent(Cmd.CAMERA_TELE_GET_ALL_PARAMS);
    link.start();
    await link.waitConnected(2000);
    const pending = link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS, {}, { timeout: 5000 });
    const dropped = new Promise((r) => link.once('disconnected', r));
    await fake.nextRequest(Cmd.CAMERA_TELE_GET_ALL_PARAMS, 2000, 1);
    fake.dropClient();
    await assert.rejects(pending, /connection closed/);
    await dropped;
    await new Promise((r) => link.once('connected', r));
    assert.ok(fake.connections >= 2);
  });

  test('a hung command service (pings answered, commands not) is declared unresponsive and fails fast', async () => {
    link.start();
    await link.waitConnected(2000);
    fake.hung = true;
    const unresponsive = new Promise((r) => link.once('unresponsive', r));
    await unresponsive;
    assert.equal(link.health().state, 'unresponsive');
    assert.match(link.health().detail, /HUNG/);
    assert.equal(link.usable, false);
    await assert.rejects(link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS), (e) => e instanceof TelescopeUnresponsiveError);
    // and it comes back by itself once the firmware answers again
    fake.hung = false;
    await new Promise((r) => link.once('responsive', r));
    assert.equal(link.health().state, 'connected');
  });

  test('an undecodable frame is dropped and the link keeps working', async () => {
    fake.reply(Cmd.CAMERA_TELE_GET_ALL_PARAMS, { code: 0 });
    link.start();
    await link.waitConnected(2000);
    await fake.sendRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01]));
    const r = await link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS);
    assert.equal(r?.code ?? 0, 0);
    assert.equal(link.health().state, 'connected');
  });

  test('a notification listener that throws does not break the link or other listeners', async () => {
    fake.reply(Cmd.CAMERA_TELE_GET_ALL_PARAMS, { code: 0 });
    link.start();
    await link.waitConnected(2000);
    link.on('notification', () => {
      throw new Error('listener bug');
    });
    const got = link.waitFor((n) => n.name === 'teleStackingProgress', 2000);
    await fake.notify('teleStackingProgress', { currentCount: 1 });
    await got;
    let onces = 0;
    link.once('notification', () => onces++);
    await fake.notify('teleStackingProgress', { currentCount: 2 });
    await fake.notify('teleStackingProgress', { currentCount: 3 });
    await sleep(50);
    assert.equal(onces, 1, 'once listeners still fire once');
    assert.equal((await link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS))?.code ?? 0, 0);
  });

  test('a match function that throws does not claim the reply', async () => {
    fake.reply(Cmd.CAMERA_TELE_GET_ALL_PARAMS, { code: -7 });
    link.start();
    await link.waitConnected(2000);
    const bad = link.request(Cmd.CAMERA_TELE_GET_ALL_PARAMS, {}, { allowError: true, timeout: 200, match: () => { throw new Error('bug'); } });
    await assert.rejects(bad, /timed out/);
  });

  test('waitFor: an aborted signal rejects at once; a throwing predicate rejects', async () => {
    link.start();
    await link.waitConnected(2000);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(link.waitFor(() => true, 2000, ac.signal), /aborted/);
    const p = link.waitFor(() => {
      throw new Error('predicate bug');
    }, 2000);
    await fake.notify('teleStackingProgress', { currentCount: 1 });
    await assert.rejects(p, /predicate bug/);
    assert.equal(link.listenerCount('notification'), 0, 'listeners are removed');
  });

  test('retarget drops the connection and connects afresh', async () => {
    link.start();
    await link.waitConnected(2000);
    const before = fake.connections;
    const dropped = new Promise((r) => link.once('disconnected', r));
    link.retarget('localhost');
    await dropped;
    await link.waitConnected(2000);
    assert.equal(fake.connections, before + 1);
  });

  test('starting a link that is already started does not open a second connection', async () => {
    link.start();
    await link.waitConnected(2000);
    const before = fake.connections;
    let drops = 0;
    link.on('disconnected', () => drops++);
    link.start();
    link.start();
    await sleep(150);
    assert.equal(fake.connections, before);
    assert.equal(drops, 0);
    assert.equal(link.health().state, 'connected');
  });

  test('a link stopped by the user fails requests and does not reconnect', async () => {
    link.start();
    await link.waitConnected(2000);
    const before = fake.connections;
    link.stop();
    await sleep(150);
    assert.equal(fake.connections, before);
    assert.equal(link.health().state, 'released');
  });
});
