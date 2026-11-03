import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { DutyLoop } from '../agent/duty.js';
import { dwarfDuty } from '../drivers/dwarf/duty.js';
import type { Dwarf } from '../drivers/dwarf/device.js';
import type { AgentBridge } from '../agent/omp.js';
import { startJob, cancelJob, drainJobs } from '../library/jobs.js';
import { parseUntil } from '../agent/duty/time.js';

const flush = () => new Promise((r) => setImmediate(r));

class StubAgent extends EventEmitter {
  ready = true;
  busy = false;
  prompts: string[] = [];
  notes: string[] = [];
  failNext = false;
  note(_kind: string, text: string) {
    this.notes.push(text);
  }
  async prompt(text: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('agent not reachable');
    }
    this.prompts.push(text);
  }
  set(o: { ready?: boolean; busy?: boolean }) {
    Object.assign(this, o);
    this.emit('status', {});
  }
}

class StubDwarf extends EventEmitter {
  state: any = {
    connected: true,
    released: false,
    link: { state: 'connected' },
    battery: 80,
    motors: { homed: true, rotationDeg: 150, pitchDeg: 140 },
    cmosTempC: { tele: 12 },
    shootingMode: { id: 2, name: 'DSO' },
    stacking: { tele: { state: 'idle' }, wide: { state: 'idle' } },
  };
  stackControl: any = { tele: {}, wide: {} };
  isTracking = () => true;
  requireLocation = () => ({ lat: 45.5, lon: -122.6, elev: 50 });
  changed() {
    this.emit('state', this.state);
  }
}

describe('DutyLoop', () => {
  let now: number;
  let agent: StubAgent;
  let dwarf: StubDwarf;
  let duty: DutyLoop;
  const make = () => new DutyLoop(dwarfDuty(dwarf as unknown as Dwarf), agent as unknown as AgentBridge, { now: () => now, tickMs: 0 });

  // Never write the real DATA_DIR: a duty.json left here resumes in the running app on its next
  // start (a test duty woke the agent on 2026-10-17), and startJob would persist test jobs to jobs.json.
  const savedData = config.paths.data;
  let dataDir = '';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-test-'));
    config.paths.data = dataDir;
    now = Date.UTC(2026, 9, 12, 8, 0);
    agent = new StubAgent();
    dwarf = new StubDwarf();
    duty = make();
  });

  afterEach(() => {
    duty.dispose();
    config.paths.data = savedData;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('a released telescope holds the samples, unless the device keeps waking while released (autonomous nights)', async () => {
    duty.start({ objective: 'image the plan', until: 'none', by: 'user' });
    dwarf.state.released = true;
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 0, 'the user has the telescope');
    duty.dispose();
    let autonomous = true;
    const dev = { ...dwarfDuty(dwarf as unknown as Dwarf), wakeWhileReleased: () => autonomous };
    Object.defineProperty(dev, 'state', { get: () => dwarf.state });
    duty = new DutyLoop(dev, agent as unknown as AgentBridge, { now: () => now, tickMs: 0 });
    duty.start({ objective: 'image the plan', until: 'none', by: 'user' });
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 1, 'woken to connect it again');
    autonomous = false;
    agent.set({ busy: true });
    agent.set({ busy: false });
    now += 3600e3;
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 1, 'the mode off: the release holds the samples again');
  });

  test('with no duty and autonomous mode off, nothing wakes the agent; events are dropped', async () => {
    duty.event('the night plan moved on: Now: M31');
    duty.event('transfer job 1 done');
    duty.order('the Starfront roof opened');
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 0);
    assert.equal(duty.status().pendingEvents, 0);
  });

  test('autonomous mode on, no duty: orders and events wake the agent', async () => {
    duty.dispose();
    const dev = { ...dwarfDuty(dwarf as unknown as Dwarf), autonomous: () => true };
    Object.defineProperty(dev, 'state', { get: () => dwarf.state });
    duty = new DutyLoop(dev, agent as unknown as AgentBridge, { now: () => now, tickMs: 0 });
    duty.event('dark master saved');
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 1);
  });

  test('an order is carried out, an event only noted', async () => {
    duty.dispose();
    const dev = { ...dwarfDuty(dwarf as unknown as Dwarf), autonomous: () => true };
    Object.defineProperty(dev, 'state', { get: () => dwarf.state });
    duty = new DutyLoop(dev, agent as unknown as AgentBridge, { now: () => now, tickMs: 0 });
    duty.order('the Starfront roof opened: verify it');
    await new Promise((r) => setTimeout(r, 3100));
    assert.match(agent.prompts[0], /ORDER \(the owner's autonomous mode\): the Starfront roof opened/);
    assert.match(agent.prompts[0], /carry them out now/);
  });

  test('dispose removes every listener it added', () => {
    duty.dispose();
    assert.equal(dwarf.listenerCount('state'), 0);
    assert.equal(agent.listenerCount('status'), 0);
    duty = make();
  });

  test('a cancelled transfer is reported once, though the job publishes it twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const j = startJob('t', 'slow', () => gate, 'agent');
    await flush();
    cancelJob(j.id);
    release();
    await drainJobs();
    const status = duty.status();
    assert.equal(status.pendingEvents, 1);
  });

  test('an unreadable duty.json is ignored, not fatal', () => {
    duty.dispose();
    fs.writeFileSync(path.join(config.paths.data, 'duty.json'), '{"status":"bogus"}');
    duty = make();
    assert.equal(duty.state.status, 'off');
    duty.dispose();
    fs.writeFileSync(path.join(config.paths.data, 'duty.json'), 'not json');
    duty = make();
    assert.equal(duty.state.status, 'off');
  });

  test('fields of the wrong type in duty.json are dropped; an active duty needs an objective', () => {
    duty.dispose();
    const file = path.join(config.paths.data, 'duty.json');
    fs.writeFileSync(file, JSON.stringify({ status: 'active', objective: 'image M 31', until: 'tomorrow', intervalS: 'x', wakes: '3', startedBy: 'root' }));
    duty = make();
    assert.equal(duty.state.status, 'active');
    assert.equal(duty.state.until, undefined);
    assert.equal(typeof duty.state.intervalS, 'number');
    assert.equal(duty.state.wakes, 0);
    assert.equal(duty.state.startedBy, undefined);
    duty.dispose();
    fs.writeFileSync(file, JSON.stringify({ status: 'active', objective: 42 }));
    duty = make();
    assert.equal(duty.state.status, 'off');
  });

  test('a saved active duty resumes after a restart; a passed end time ends it', () => {
    duty.start({ objective: 'image', until: '23:00', by: 'user' });
    duty.dispose();
    duty = make();
    assert.equal(duty.state.status, 'active');
    assert.equal(duty.state.nextWakeAt, now + 20_000);
    duty.dispose();
    now += 2 * 86_400_000;
    duty = make();
    assert.equal(duty.state.status, 'off');
    assert.match(duty.state.endedReason ?? '', /passed while Astrocontroller was not running/);
  });

  test('end times: HH:MM is the next occurrence, nonsense is refused', () => {
    const site = () => ({ lat: 45.5, lon: -122.6, elev: 50 });
    const u = parseUntil('07:00', now, site)!;
    assert.ok(u.at > now && u.at - now <= 86_400_000);
    assert.equal(parseUntil('none', now, site), undefined);
    assert.equal(parseUntil('  ', now, site), undefined);
    assert.throws(() => parseUntil('25:00', now, site), /not a time of day/);
    assert.throws(() => parseUntil('2020-01-01T00:00', now, site), /not in the future/);
  });

  test('a user duty wakes at once, then one interval after each turn ends', async () => {
    duty.start({ objective: 'image C 20 until dawn', intervalS: 300, by: 'user' });
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 1);
    assert.match(agent.prompts[0], /duty sample: automatic/);
    assert.match(agent.prompts[0], /Objective from the user: image C 20 until dawn/);
    agent.set({ busy: true });
    agent.set({ busy: false });
    now += 299_000;
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 1);
    now += 1_000;
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 2);
  });

  test('a new session starts clean: events queued for the old one are not delivered, and the first sample says so', async () => {
    duty.start({ objective: 'image the Moon', intervalS: 300, by: 'user' });
    duty.tick();
    await flush();
    assert.match(agent.prompts[0], /fresh start/, 'a new duty begins fresh');
    agent.set({ busy: true });
    duty.event('tele stack on Moon is COLLECTING NOTHING');
    duty.newSession();
    agent.set({ busy: false });
    assert.equal(duty.status().pendingEvents, 0);
    now += 300_000;
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 2);
    assert.doesNotMatch(agent.prompts[1], /COLLECTING NOTHING|Events since/);
    assert.match(agent.prompts[1], /fresh start/);
    agent.set({ busy: true });
    agent.set({ busy: false });
    now += 300_000;
    duty.tick();
    await flush();
    assert.doesNotMatch(agent.prompts[2], /fresh start/, 'only the first sample of the session');
  });

  test('a new user duty drops the previous duty\'s events', async () => {
    duty.start({ objective: 'image the Moon', by: 'user' });
    duty.event('tele stack on Moon is COLLECTING NOTHING');
    duty.start({ objective: 'soak IC 1848', by: 'user' });
    duty.tick();
    await flush();
    // the event's own delivery timer must not bring it back either
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 1);
    assert.match(agent.prompts[0], /soak IC 1848/);
    assert.doesNotMatch(agent.prompts[0], /Moon/);
  });

  test('the agent cannot end a duty before its end time', () => {
    duty.start({ objective: 'x', until: new Date(now + 3600_000).toISOString(), by: 'user' });
    assert.throws(() => duty.complete('done'), /refused: this duty runs until/);
    assert.equal(duty.state.status, 'active');
  });

  test('the user\'s Stop holds every automatic wake until they write again', async () => {
    duty.start({ objective: 'x', by: 'user' });
    duty.userStop();
    duty.event('transfer job 1 done');
    now += 3600_000;
    duty.tick();
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 0);
    duty.userSpoke();
    assert.equal(duty.status().heldByStop, false);
  });

  test('events during a turn wait for it to end, then go out', async () => {
    agent.set({ busy: true });
    duty.event('dark master saved');
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 0);
    agent.set({ busy: false });
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 1);
    assert.match(agent.prompts[0], /dark master saved/);
  });

  test('events queued while the agent was down go out when it is back', async () => {
    agent.set({ ready: false });
    duty.event('processing p1 done');
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 0);
    agent.set({ ready: true });
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(agent.prompts.length, 1);
    assert.match(agent.prompts[0], /processing p1 done/);
  });

  test('the END wake is not lost when a wake is in flight at the end time', async () => {
    duty.start({ objective: 'image until 09:00 then transfer', until: new Date(now + 60_000).toISOString(), by: 'user' });
    // a slow wake still being delivered when the end time comes
    let release!: () => void;
    agent.prompt = (text: string) => {
      agent.prompts.push(text);
      return new Promise<void>((r) => (release = r));
    };
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 1);
    now += 61_000;
    duty.tick();
    assert.equal(duty.state.status, 'active', 'waits for the wake in flight');
    release();
    await flush();
    duty.tick();
    await flush();
    assert.equal(duty.state.status, 'off');
    assert.match(agent.prompts.at(-1)!, /duty END/);
    assert.match(agent.prompts.at(-1)!, /Carry out the end steps/);
  });

  test('an END wake the agent could not take is retried as the END message, not as a plain event', async () => {
    duty.start({ objective: 'image until 09:00 then transfer', until: new Date(now + 60_000).toISOString(), by: 'user' });
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 1);
    now += 61_000;
    agent.failNext = true;
    duty.tick();
    await flush();
    assert.equal(duty.state.status, 'off');
    assert.equal(agent.prompts.length, 1, 'the END wake failed');
    duty.wakeNow();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(agent.prompts.length, 2);
    assert.match(agent.prompts[1], /duty END/);
    assert.match(agent.prompts[1], /Carry out the end steps/);
    assert.match(agent.prompts[1], /end time \(.*\) has been reached/);
  });

  test('a failed wake keeps its events for the next try', async () => {
    duty.start({ objective: 'x', by: 'user' });
    duty.event('battery down to 15%', true);
    agent.failNext = true;
    duty.tick();
    await flush();
    assert.equal(agent.prompts.length, 0);
    now += 60_000;
    duty.tick();
    await flush();
    assert.match(agent.prompts[0], /battery down to 15%/);
  });

  test('a stack the scope ends by itself is an event; a requested stop is not', async () => {
    dwarf.state.stacking.tele = { state: 'running', stackedCount: 40, currentCount: 44, totalCount: 999 };
    dwarf.stackControl.tele = { startedBy: 'agent' };
    dwarf.changed();
    dwarf.state.stacking.tele = { ...dwarf.state.stacking.tele, state: 'stopped' };
    dwarf.changed();
    assert.match(duty.status().pendingEvents ? 'queued' : '', /queued/);
    // requested: stopStacking stamps stopRequestedAt
    dwarf.state.stacking.wide = { state: 'running' };
    dwarf.stackControl.wide = { startedBy: 'agent' };
    dwarf.changed();
    dwarf.stackControl.wide.stopRequestedAt = now;
    dwarf.state.stacking.wide = { state: 'stopped' };
    dwarf.changed();
    assert.equal(duty.status().pendingEvents, 1);
  });

  test('a battery reading lost while disconnected is not a drop when it comes back', () => {
    duty.start({ objective: 'x', by: 'user' });
    agent.set({ busy: true });
    const before = duty.status().pendingEvents;
    dwarf.state.battery = 12;
    dwarf.changed();
    assert.equal(duty.status().pendingEvents, before + 1);
    dwarf.state.battery = undefined;
    dwarf.changed();
    dwarf.state.battery = 12;
    dwarf.changed();
    assert.equal(duty.status().pendingEvents, before + 1);
    dwarf.state.battery = 9;
    dwarf.changed();
    assert.equal(duty.status().pendingEvents, before + 2);
  });

  test('next_check is clamped to 30 s .. 15 min', () => {
    duty.start({ objective: 'x', by: 'user' });
    assert.equal(duty.nextCheck(5).inS, 30);
    assert.equal(duty.nextCheck(5000).inS, 900);
  });
});
