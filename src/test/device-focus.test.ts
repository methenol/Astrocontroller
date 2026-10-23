import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDwarf } from './fake-dwarf.js';
import { config } from '../config.js';
import { Dwarf, FOCUS_MAX, AstroServiceHungError } from '../drivers/dwarf/device.js';
import { Cmd } from '../drivers/dwarf/protocol.js';
import { FakeFocuser } from './fake-focuser.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(() => {
  config.dwarf.host = '127.0.0.1';
  config.dwarf.httpPort = 9;
  config.dwarf.autoSyncTimeLocation = false;
});

describe('Dwarf focus against a fake focuser', () => {
  let fake: FakeDwarf;
  let dwarf: Dwarf;
  let focuser: FakeFocuser | undefined;

  beforeEach(async () => {
    fake = await new FakeDwarf().start();
    dwarf = new Dwarf({ host: '127.0.0.1', port: fake.port, linkTiming: { requestTimeoutMs: 1000 } });
    Object.assign(dwarf.focusTiming, { stepMs: 2, quietMs: 150, settleMaxMs: 2000 });
    Object.assign(dwarf.autofocusTiming, { astroMs: 1500, normalMs: 1500 });
    dwarf.astroTiming.silentMs = 400;
    dwarf.link.start();
    await dwarf.link.waitConnected(2000);
  });

  afterEach(async () => {
    focuser?.stop();
    dwarf.stop();
    await fake.stop();
  });

  test('focusTo lands on the target with counted steps (no overshoot, no end-to-end swing)', async () => {
    focuser = new FakeFocuser(fake, 572);
    const reached = await dwarf.focusTo(550);
    assert.equal(reached, 550);
    assert.equal(focuser.pos, 550);
    assert.equal(focuser.steps, 22);
    // never a continuous move (the overshooting kind)
    assert.equal(fake.requestsFor(Cmd.FOCUS_START_MANUAL_CONTINU_FOCUS).length, 0);
  });

  test('lost steps are corrected from the read-back position', async () => {
    focuser = new FakeFocuser(fake, 300, { dropEvery: 10 });
    const reached = await dwarf.focusTo(400);
    assert.ok(Math.abs(reached - 400) <= 2, `reached ${reached}`);
    assert.equal(reached, focuser.pos);
  });

  test('targets beyond the travel are clamped to 0..FOCUS_MAX', async () => {
    focuser = new FakeFocuser(fake, 690);
    assert.equal(await dwarf.focusTo(9999), FOCUS_MAX);
  });

  test('reports the position the focuser really has, even when notifications lag far behind', async () => {
    focuser = new FakeFocuser(fake, 100, { burstMs: 5000 });
    const reached = await dwarf.focusTo(160);
    assert.equal(reached, 160);
    assert.equal(dwarf.state.focusPosition, 160);
  });

  test('focus_step moves by the count and reports before → after', async () => {
    focuser = new FakeFocuser(fake, 200);
    const r = await dwarf.focusStep('near', 15);
    assert.match(r, /200 → 185/);
    assert.equal(focuser.pos, 185);
  });

  test('concurrent moves run one after another: each sees the other\'s result, none interleave', async () => {
    focuser = new FakeFocuser(fake, 300);
    const dirs: number[] = [];
    fake.on(Cmd.FOCUS_MANUAL_SINGLE_STEP_FOCUS, (req) => {
      dirs.push(Number(req.data.direction ?? 0));
      focuser!.pos += Number(req.data.direction ?? 0) === 0 ? 1 : -1;
      return undefined;
    });
    const [a, b] = await Promise.all([dwarf.focusStep('far', 20), dwarf.focusStep('near', 20)]);
    assert.match(a, /300 → 320/);
    assert.match(b, /320 → 300/);
    // all the far steps, then all the near ones
    assert.deepEqual(dirs, [...Array(20).fill(0), ...Array(20).fill(1)]);
  });

  test('refused while the tele is live stacking (would blur every sub)', async () => {
    focuser = new FakeFocuser(fake, 200);
    dwarf.stacks.startSent('tele');
    await assert.rejects(dwarf.focusTo(250), /refused: the tele camera is live stacking/);
    await assert.rejects(dwarf.focusStep('far', 5), /refused/);
    assert.equal(focuser.steps, 0);
  });

  test('a dropped link stops the move with an explanation', async () => {
    focuser = new FakeFocuser(fake, 100);
    dwarf.focusTiming.stepMs = 5;
    const p = dwarf.focusTo(500);
    // drop once the move is under way (a drop before it only delays the start: the link reconnects)
    const drop = setInterval(() => {
      if (focuser!.steps >= 20) {
        clearInterval(drop);
        fake.dropClient();
      }
    }, 5);
    await assert.rejects(p, /interrupted: the telescope link dropped|connection closed|not connected/);
    assert.ok(focuser.steps < 400);
  });
  /** The astro AF as fw 1.5.3 ran it on 2026-10-12: running, then "stopped" ~24 s later, focuser untouched. */
  function astroAf(o: { moveTo?: number; end?: number | null } = {}) {
    fake.on(Cmd.FOCUS_START_ASTRO_AUTO_FOCUS, (_req, f) => {
      setTimeout(async () => {
        await f.notify('astroAutoFocusState', { state: 1 });
        await sleep(50);
        if (o.moveTo !== undefined) {
          focuser!.pos = o.moveTo;
          await f.notify('focusPosition', { pos: o.moveTo });
        }
        if (o.end !== null) await f.notify('astroAutoFocusState', { state: o.end ?? 3 });
      }, 30);
      return { code: 0 };
    });
  }

  test('astro AF that ends without moving the focuser is a failure, not a success with a warning', async () => {
    focuser = new FakeFocuser(fake, 412);
    astroAf();
    await assert.rejects(dwarf.autofocus('astro'), /astro autofocus FAILED: .*WITHOUT MOVING THE FOCUSER \(position 412 before, 412 after\)/);
  });

  test('astro AF that moves the focuser reports the read-back positions', async () => {
    focuser = new FakeFocuser(fake, 412);
    astroAf({ moveTo: 455, end: 0 });
    assert.match(await dwarf.autofocus('astro'), /finished in \d+ s: focus position 412 → 455/);
  });

  test('astro AF that never reports its end is stopped and fails', async () => {
    focuser = new FakeFocuser(fake, 412);
    astroAf({ end: null });
    await assert.rejects(dwarf.autofocus('astro'), /did not report its end .*\(it did start\); it was stopped/);
    assert.ok(fake.requestsFor(Cmd.FOCUS_STOP_ASTRO_AUTO_FOCUS).length >= 1);
    assert.equal(dwarf.operation, null);
  });

  test('astro AF that the telescope ignores entirely: hung, at the silence limit', async () => {
    focuser = new FakeFocuser(fake, 412);
    fake.silent(Cmd.FOCUS_START_ASTRO_AUTO_FOCUS);
    await assert.rejects(dwarf.autofocus('astro'), AstroServiceHungError);
  });

  test('astro AF is refused while the tele is live stacking', async () => {
    focuser = new FakeFocuser(fake, 412);
    dwarf.stacks.startSent('tele');
    await assert.rejects(dwarf.autofocus('astro'), /refused: the tele camera is live stacking/);
    assert.equal(fake.requestsFor(Cmd.FOCUS_START_ASTRO_AUTO_FOCUS).length, 0);
  });
});
