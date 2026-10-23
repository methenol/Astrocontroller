import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyNotification, initialState, type ParamCache } from '../drivers/dwarf/controller/state.js';
import type { Notification } from '../drivers/dwarf/link.js';

const RUNNING = 1;
const IDLE = 0;
const note = (name: string, data: Record<string, unknown>, ts = Date.now()) => ({ name, data, ts }) as unknown as Notification;

describe('dark capture state from the firmware', () => {
  test('a capture the controller did not start follows the firmware and ends with it', () => {
    const st = initialState();
    const params: ParamCache = new Map();
    applyNotification(st, params, note('darkCaptureState', { state: RUNNING }));
    assert.equal(st.darkCapture?.state, 'running');
    applyNotification(st, params, note('darkCaptureState', { state: IDLE }, 1000));
    assert.equal(st.darkCapture?.state, 'idle', 'not held at running for ever');
    assert.equal(st.darkCapture?.finishedAt, 1000);
  });

  test("the controller's own capture is not ended by the firmware state (its master decides)", () => {
    const st = initialState();
    const params: ParamCache = new Map();
    st.darkCapture = { state: 'running', startedAt: 1, exposureS: 15 };
    applyNotification(st, params, note('darkCaptureState', { state: IDLE }));
    assert.equal(st.darkCapture?.state, 'running');
    assert.equal(st.darkCapture?.fwState, 'idle');
    assert.equal(st.darkCapture?.exposureS, 15);
  });

  test('a trailing idle after a finished capture keeps its outcome', () => {
    const st = initialState();
    const params: ParamCache = new Map();
    st.darkCapture = { state: 'done', startedAt: 1, master: 'dark.fits' };
    applyNotification(st, params, note('darkCaptureState', { state: IDLE }));
    assert.equal(st.darkCapture?.state, 'done');
    assert.equal(st.darkCapture?.master, 'dark.fits');
  });

  test('an app capture after a finished one of ours starts fresh and ends with the firmware', () => {
    const st = initialState();
    const params: ParamCache = new Map();
    st.darkCapture = { state: 'done', startedAt: 1, master: 'dark.fits' };
    applyNotification(st, params, note('darkCaptureState', { state: RUNNING }));
    assert.equal(st.darkCapture?.state, 'running');
    assert.equal(st.darkCapture?.startedAt, undefined);
    applyNotification(st, params, note('darkCaptureState', { state: IDLE }));
    assert.equal(st.darkCapture?.state, 'idle');
  });
});

describe('camera parameter reports', () => {
  // ids as the firmware sends them (wire log, 2026-10-12, firmware 1.5.3.9)
  const TELE_ASTRO_EXP = '144396663052566529'; // 0x0201000000000001, the id that is set
  const TELE_ASTRO_EXP_ECHO = '792915009393917953'; // 0x0b01000000000001, its DSO-mode echo
  const WIDE_ASTRO_EXP = '144414255238610945'; // 0x0201100000000001
  const WIDE_ASTRO_EXP_ECHO = '864990195617890305'; // 0x0c01100000000001
  const PHOTO_TELE_EXP = '72339069014638593'; // 0x0101000000000001

  test("the DSO-mode echo of a set is stored under the id that was set, for both cameras", () => {
    const st = initialState();
    const params: ParamCache = new Map();
    applyNotification(st, params, note('intParam', { paramId: TELE_ASTRO_EXP_ECHO, mode: 1, value: 75 }));
    applyNotification(st, params, note('intParam', { paramId: WIDE_ASTRO_EXP_ECHO, value: 156 }));
    assert.deepEqual(params.get(TELE_ASTRO_EXP), { mode: 1, value: 75, ts: params.get(TELE_ASTRO_EXP)?.ts });
    assert.equal(params.get(WIDE_ASTRO_EXP)?.mode, 0, 'a missing mode is auto');
    assert.equal(params.get(WIDE_ASTRO_EXP)?.value, 156);
    assert.equal(params.has(TELE_ASTRO_EXP_ECHO), false);
  });

  test('other ids are stored as reported', () => {
    const st = initialState();
    const params: ParamCache = new Map();
    applyNotification(st, params, note('intParam', { paramId: PHOTO_TELE_EXP, mode: 1, value: 111 }));
    applyNotification(st, params, note('intParam', { paramId: TELE_ASTRO_EXP, mode: 1, value: 69 }));
    assert.equal(params.get(PHOTO_TELE_EXP)?.value, 111);
    assert.equal(params.get(TELE_ASTRO_EXP)?.value, 69);
  });
});
