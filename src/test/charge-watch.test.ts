import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChargeWatch, type ChargeAgent, type ChargeDevice } from '../agent/charge-watch.js';

function setup(opts: { pending?: string[] | Error; busy?: string | null; tracking?: boolean } = {}) {
  const ev = new EventEmitter();
  const state = { connected: true, charging: false as boolean | undefined, battery: 80 };
  const device = {
    state,
    isBusy: () => opts.busy ?? null,
    isTracking: () => opts.tracking ?? false,
    on: (e: string, fn: () => void) => ev.on(e, fn),
    off: (e: string, fn: () => void) => ev.off(e, fn),
  } as unknown as ChargeDevice;
  const prompts: string[] = [];
  const agent: ChargeAgent = {
    note: () => undefined,
    prompt: async (t: string) => {
      prompts.push(t);
    },
  } as unknown as ChargeAgent;
  let now = 1_000_000;
  const w = new ChargeWatch(device, agent, {
    settleMs: 1,
    pendingSessions: async () => {
      if (opts.pending instanceof Error) throw opts.pending;
      return opts.pending ?? ['S1'];
    },
    now: () => now,
  });
  const set = (charging: boolean | undefined, connected = true) => {
    state.charging = charging;
    state.connected = connected;
    ev.emit('state');
  };
  return { w, set, prompts, advance: (ms: number) => (now += ms), state };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('charge watch', () => {
  test('plugged in while tracking a target: the routine (which parks) does not run', async () => {
    const t = setup({ tracking: true });
    t.w.start();
    t.set(false);
    t.set(true);
    await settle();
    assert.equal(t.prompts.length, 0);
    t.w.stop();
  });

  test('plugging in wakes the agent once with the pending sessions; the cooldown holds', async () => {
    const t = setup();
    t.w.start();
    t.set(false);
    t.set(true);
    await settle();
    assert.equal(t.prompts.length, 1);
    assert.match(t.prompts[0], /S1/);
    assert.match(t.prompts[0], /battery 80%/);
    t.set(false);
    t.set(true);
    await settle();
    assert.equal(t.prompts.length, 1, 'within the cooldown');
    t.advance(31 * 60000);
    t.set(false);
    t.set(true);
    await settle();
    assert.equal(t.prompts.length, 2);
    t.w.stop();
  });

  test('already charging at start, or charging seen through a dropped link, does not fire on its own', async () => {
    const t = setup();
    t.w.start();
    t.set(true);
    await settle();
    assert.equal(t.prompts.length, 0);
    // the last value survives a disconnect: unplugged, link drops, plugged in, link back
    t.set(false);
    t.set(true, false);
    t.set(true, true);
    await settle();
    assert.equal(t.prompts.length, 1);
    t.w.stop();
  });

  test('never while imaging, never with nothing to transfer, never when the SD listing fails', async () => {
    for (const opts of [{ busy: 'stacking' }, { pending: [] }, { pending: new Error('ftp down') }]) {
      const t = setup(opts);
      t.w.start();
      t.set(false);
      t.set(true);
      await settle();
      assert.equal(t.prompts.length, 0, JSON.stringify(opts));
      t.w.stop();
    }
  });

  test('stop() removes the listener', async () => {
    const t = setup();
    t.w.start();
    t.w.stop();
    t.set(false);
    t.set(true);
    await settle();
    assert.equal(t.prompts.length, 0);
  });
});
