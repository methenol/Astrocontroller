import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StackTracker, type StackHealth, type CameraName } from '../drivers/dwarf/stacking.js';
import { readWireLog, at, type WireLine } from './wirelog-replay.js';

const FIXTURE = path.resolve('test-fixtures/2026-10-12-wide-c20.wire.log');

/** Replay the notifications of a wire log into a tracker with a clock that follows the log. */
function replay(lines: WireLine[], until = Infinity, exposureS?: number) {
  let now = lines[0]?.t ?? 0;
  const tr = new StackTracker(() => now, () => exposureS);
  const health: Array<{ cam: CameraName; h: StackHealth; t: number }> = [];
  let progressEvents = 0;
  tr.on('health', (cam: CameraName, h: StackHealth) => health.push({ cam, h, t: now }));
  tr.on('progress', () => progressEvents++);
  for (const l of lines) {
    if (l.t > until) break;
    now = l.t;
    // what device.ts does when it sends a start
    if (l.dir === '>' && /START_WIDE_CAPTURE_LIVE_STACKING/.test(l.name)) tr.startSent('wide');
    if (l.dir === '>' && /START_CAPTURE_RAW_LIVE_STACKING/.test(l.name)) tr.startSent('tele');
    if (l.dir === '~') tr.onNotification(l.name, l.data, l.t);
  }
  return { tr, health, progressEvents, setNow: (t: number) => (now = t) };
}

// the wire log is a local capture (*.log is git-ignored): the suite runs where it is present
describe('StackTracker on the 2026-10-12 C 20 wide stack (real wire log)', { skip: !fs.existsSync(FIXTURE) && `no fixture at ${FIXTURE}` }, () => {
  const lines = fs.existsSync(FIXTURE) ? readWireLog(FIXTURE) : [];

  test('the fixture parses', () => {
    assert.ok(lines.length > 2000);
    assert.ok(lines.some((l) => l.name === 'teleStackingProgress' && l.data.cameraType === 1));
  });

  test('a wide stack reported on the tele notification ids is attributed to the wide camera only', () => {
    const { tr } = replay(lines, at('2026-10-12T05:20:00Z'));
    assert.equal(tr.info.wide.state, 'running');
    assert.equal(tr.info.wide.target, 'C 20');
    assert.equal(tr.info.tele.state, 'idle');
    assert.equal(tr.info.tele.currentCount, undefined);
    assert.equal(tr.running(), 'wide');
    assert.ok(tr.owns('wide'));
  });

  test('frames are counted once, not once per poll echo', () => {
    const { tr, progressEvents } = replay(lines, at('2026-10-12T05:20:00Z'));
    const w = tr.info.wide;
    assert.equal(w.stackedCount, 99);
    assert.ok(w.currentCount! >= 150, `taken ${w.currentCount}`);
    // one event per new taken and per new stacked: at most taken + stacked, far fewer than the messages
    const messages = lines.filter((l) => l.t <= at('2026-10-12T05:20:00Z') && l.name === 'teleStackingProgress').length;
    assert.ok(progressEvents <= w.currentCount! + w.stackedCount!, `${progressEvents} events`);
    assert.ok(messages > progressEvents);
  });

  test('stays ok while frames stack, then turns rejecting within minutes of the rejections starting', () => {
    const { health } = replay(lines, at('2026-10-12T05:20:00Z'));
    const wide = health.filter((e) => e.cam === 'wide');
    const firstOk = wide.find((e) => e.h.verdict === 'ok');
    assert.ok(firstOk && firstOk.t < at('2026-10-12T04:40:00Z'), 'ok after the first ten frames');
    // nothing alarming during the good part (stacked 84 of 84 at 04:58)
    assert.equal(wide.filter((e) => e.t < at('2026-10-12T04:59:00Z') && e.h.verdict === 'rejecting').length, 0);
    // total rejection from frame ~105 (05:04:30): the alarm must come within ~5 min of it
    const rej = wide.find((e) => e.h.verdict === 'rejecting');
    assert.ok(rej, 'rejecting verdict');
    assert.ok(rej.t > at('2026-10-12T05:02:00Z') && rej.t < at('2026-10-12T05:10:00Z'), new Date(rej.t).toISOString());
    assert.ok(rej.h.windowStacked / rej.h.windowTaken < 0.2);
    // and it stays rejecting (no flapping) until the stop
    assert.equal(wide[wide.length - 1].h.verdict, 'rejecting');
    assert.equal(wide.filter((e) => e.t > rej.t).length, 0);
  });

  test('measures the frame interval as the 15 s sub', () => {
    const { tr } = replay(lines, at('2026-10-12T05:20:00Z'));
    const iv = tr.info.wide.health?.frameIntervalS;
    assert.ok(iv && iv > 13 && iv < 17, `interval ${iv}`);
  });

  test('the stop ends the stack; straggling progress does not revive it', () => {
    const { tr } = replay(lines, at('2026-10-12T05:21:40Z'));
    assert.notEqual(tr.info.wide.state, 'running');
    assert.equal(tr.running(), null);
  });

  test('a restarted stack starts from zero with a fresh verdict', () => {
    const { tr } = replay(lines, at('2026-10-12T05:22:20Z'));
    assert.equal(tr.info.wide.state, 'running');
    assert.equal(tr.info.wide.currentCount, undefined);
    assert.equal(tr.info.wide.stackedCount, undefined);
    assert.equal(tr.info.wide.health?.verdict, 'starting');
  });

  test('a stack that takes no frame at all is reported stalled (05:21:55: 3 min, not one frame)', () => {
    const { tr, health, setNow } = replay(lines, at('2026-10-12T05:24:49Z'), 15);
    // 15 s subs: stalled after 3 × 15 + 60 = 105 s without a frame
    setNow(at('2026-10-12T05:24:49Z'));
    tr.tick();
    assert.equal(tr.info.wide.health?.verdict, 'stalled');
    assert.ok(health.some((e) => e.cam === 'wide' && e.h.verdict === 'stalled'));
  });
});

describe('StackTracker unit behaviour', () => {
  const mk = () => {
    let now = 1_000_000;
    const tr = new StackTracker(() => now);
    return { tr, adv: (ms: number) => (now += ms), now: () => now };
  };

  test('progress of a stack started right after a stop is not dropped as a straggler', () => {
    const { tr, adv, now } = mk();
    tr.startSent('tele');
    tr.confirmRunning('tele');
    tr.onNotification('teleStackingProgress', { currentCount: 5, stackedCount: 4 }, now());
    adv(1000);
    tr.onNotification('teleStackingState', { state: 3 }, now());
    tr.markIdle('tele');
    adv(1000);
    // a straggler of the stopped stack is ignored
    tr.onNotification('teleStackingProgress', { currentCount: 6, stackedCount: 5 }, now());
    assert.equal(tr.running(), null);
    adv(2000);
    tr.startSent('tele');
    adv(2000);
    tr.onNotification('teleStackingProgress', { currentCount: 1 }, now());
    assert.equal(tr.info.tele.state, 'running');
    assert.equal(tr.info.tele.currentCount, 1);
  });

  test('tele stack: progress without cameraType is the tele', () => {
    const { tr, now } = mk();
    tr.startSent('tele');
    tr.onNotification('teleStackingState', { state: 1 }, now());
    tr.onNotification('teleStackingProgress', { currentCount: 1, targetName: 'M 31' }, now());
    assert.equal(tr.info.tele.state, 'running');
    assert.equal(tr.info.tele.currentCount, 1);
    assert.equal(tr.info.wide.state, 'idle');
  });

  test('state for a wide stack started by the controller lands on the wide entry before any progress', () => {
    const { tr, now } = mk();
    tr.startSent('wide');
    tr.onNotification('teleStackingState', { state: 1 }, now());
    assert.equal(tr.info.wide.state, 'running');
    assert.equal(tr.info.tele.state, 'idle');
  });

  test('a wide stack started elsewhere (DWARFLAB app) is handed over from tele on its first progress', () => {
    const { tr, now } = mk();
    tr.onNotification('teleStackingState', { state: 1 }, now());
    assert.equal(tr.info.tele.state, 'running');
    tr.onNotification('teleStackingProgress', { cameraType: 1, currentCount: 1 }, now());
    assert.equal(tr.info.tele.state, 'idle');
    assert.equal(tr.info.wide.state, 'running');
    tr.onNotification('teleStackingState', { state: 3 }, now());
    assert.equal(tr.info.wide.state, 'stopped');
  });

  test('owns() covers the window between sending a start and the first notification', () => {
    const { tr, adv } = mk();
    assert.equal(tr.owns('wide'), false);
    tr.startSent('wide');
    assert.equal(tr.owns('wide'), true);
    adv(121_000);
    assert.equal(tr.owns('wide'), false);
  });

  test('every frame rejected from the start: rejecting after ten frames', () => {
    const { tr, adv, now } = mk();
    const seen: string[] = [];
    tr.on('health', (_c, h: StackHealth) => seen.push(h.verdict));
    tr.startSent('tele');
    tr.onNotification('teleStackingState', { state: 1 }, now());
    for (let i = 1; i <= 12; i++) {
      adv(15_000);
      tr.onNotification('teleStackingProgress', { currentCount: i }, now());
      tr.onNotification('teleStackingProgress', { updateType: 1 }, now() + 1000);
    }
    assert.deepEqual(seen, ['rejecting']);
  });

  test('a passing cloud: rejecting, then ok again once frames stack', () => {
    const { tr, adv, now } = mk();
    const seen: string[] = [];
    tr.on('health', (_c, h: StackHealth) => seen.push(h.verdict));
    tr.onNotification('teleStackingState', { state: 1 }, now());
    let stacked = 0;
    const frame = (i: number, ok: boolean) => {
      adv(10_000);
      tr.onNotification('teleStackingProgress', { currentCount: i }, now());
      if (ok) stacked++;
      tr.onNotification('teleStackingProgress', { updateType: 1, stackedCount: stacked }, now());
    };
    let i = 0;
    while (i < 20) frame(++i, true);
    while (i < 45) frame(++i, false);
    while (i < 70) frame(++i, true);
    assert.deepEqual(seen, ['ok', 'degraded', 'rejecting', 'ok']);
  });

  test('a stack whose counts go back to zero without a state notification is treated as a new stack', () => {
    const { tr, adv, now } = mk();
    tr.onNotification('teleStackingState', { state: 1 }, now());
    for (let i = 1; i <= 30; i++) {
      adv(10_000);
      tr.onNotification('teleStackingProgress', { currentCount: i, stackedCount: i - 1 }, now());
    }
    adv(10_000);
    tr.onNotification('teleStackingProgress', { currentCount: 1 }, now());
    assert.equal(tr.info.tele.currentCount, 1);
    assert.equal(tr.info.tele.stackedCount, undefined);
  });

  test('stalled once the frames stop arriving for 5 intervals (min 2 min), and back to ok when they resume', () => {
    const { tr, adv, now } = mk();
    const seen: string[] = [];
    tr.on('health', (_c, h: StackHealth) => seen.push(h.verdict));
    tr.onNotification('teleStackingState', { state: 1 }, now());
    let i = 0;
    const frame = () => {
      adv(15_000);
      i++;
      tr.onNotification('teleStackingProgress', { currentCount: i, stackedCount: i - 1 }, now());
    };
    while (i < 15) frame();
    adv(60_000);
    tr.tick();
    assert.equal(tr.info.tele.health?.verdict, 'ok');
    adv(70_000);
    tr.tick();
    assert.equal(tr.info.tele.health?.verdict, 'stalled');
    frame();
    assert.equal(tr.info.tele.health?.verdict, 'ok');
    assert.deepEqual(seen, ['ok', 'stalled', 'ok']);
  });
});

describe('StackTracker robustness', () => {
  test('a throwing listener does not stop the update or the other listeners', () => {
    let now = 1_000_000;
    const tr = new StackTracker(() => now);
    let seen = 0;
    tr.on('progress', () => {
      throw new Error('listener bug');
    });
    tr.on('progress', () => seen++);
    tr.onNotification('teleStackingState', { state: 1 }, now);
    now += 10_000;
    tr.onNotification('teleStackingProgress', { currentCount: 1, stackedCount: 0 }, now);
    assert.equal(seen, 1);
    assert.equal(tr.info.tele.currentCount, 1);
    assert.equal(tr.running(), 'tele');
  });

  test('fields of the wrong type are ignored, not stored', () => {
    const now = 1_000_000;
    const tr = new StackTracker(() => now);
    tr.onNotification('teleStackingState', { state: 1 }, now);
    tr.onNotification('teleStackingProgress', { currentCount: '5', stackedCount: null, targetName: 7, totalCount: 100 }, now);
    assert.equal(tr.info.tele.currentCount, undefined);
    assert.equal(tr.info.tele.target, undefined);
    assert.equal(tr.info.tele.totalCount, 100);
  });
});

describe('StackTracker camera ownership', () => {
  test('a stop frees the camera at once; the start claim does not outlive the run it started', () => {
    let now = 1_000_000;
    const tr = new StackTracker(() => now);
    tr.startSent('tele');
    assert.ok(tr.owns('tele'), 'claimed from the start command');
    now += 500;
    tr.onNotification('teleStackingState', { state: 1 }, now);
    assert.equal(tr.info.tele.state, 'running');
    now += 10_000;
    tr.onNotification('teleStackingState', { state: 3 }, now);
    assert.notEqual(tr.info.tele.state, 'running');
    assert.equal(tr.owns('tele'), false, 'free right after the stop, not 120 s after the start');
  });

  test('a start sent but not yet confirmed keeps its claim', () => {
    let now = 1_000_000;
    const tr = new StackTracker(() => now);
    tr.startSent('wide');
    now += 30_000;
    assert.ok(tr.owns('wide'));
  });
});
