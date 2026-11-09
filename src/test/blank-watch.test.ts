import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { BlankWatch, type BlankWatchDeps } from '../media/stream/blank-watch.js';
import { stillGainFloor } from '../media/focus/gain-floor.js';
import { isBlackJpeg } from '../media/images.js';

function rig(over: Partial<BlankWatchDeps> = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  let at = 0;
  let black = true;
  const deps: BlankWatchDeps = {
    frame: () => ({ jpeg: Buffer.alloc(1), at }),
    isBlack: async () => black,
    canWatch: () => true,
    raiseGain: async () => (calls.push('gain'), 'gain 60 → 120'),
    reenterCamera: async () => void calls.push('reenter'),
    rearmCamera: async () => void calls.push('rearm'),
    saveEvidence: async () => (calls.push('evidence'), 'captures/blank/x'),
    ...over,
  };
  const w = new BlankWatch(deps);
  w.start((t) => notes.push(t));
  w.stop();
  /** one look with a new frame at this time */
  const look = (t: number) => ((at = t), w.tick(t));
  return { w, calls, notes, look, setBlack: (b: boolean) => (black = b) };
}

describe('black-frame watch', () => {
  test('a few black frames are not an episode', async () => {
    const { w, calls, look, setBlack } = rig();
    await look(1000);
    await look(6000);
    setBlack(false);
    await look(11000);
    setBlack(true);
    await look(16000);
    assert.deepEqual(calls, []);
    assert.equal(w.status().black, false);
  });

  test('an episode saves evidence, then climbs the ladder in order, one step per look', async () => {
    const { calls, notes, look } = rig();
    for (const t of [1000, 6000, 11000]) await look(t);
    assert.deepEqual(calls, ['evidence', 'gain']);
    await look(30_000);
    assert.deepEqual(calls, ['evidence', 'gain'], 'the next step waits for its time');
    await look(11000 + 60_000);
    await look(11000 + 180_000);
    assert.deepEqual(calls, ['evidence', 'gain', 'reenter', 'rearm']);
    assert.equal(notes.length, 0);
    await look(11000 + 360_000);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /not a reason to reboot/);
    assert.doesNotMatch(notes[0], /power action=reboot/);
    await look(11000 + 400_000);
    assert.equal(notes.length, 1, 'told once per episode');
  });

  test('the picture coming back ends the episode, and the agent hears only if it was told', async () => {
    const { w, calls, notes, look, setBlack } = rig();
    for (const t of [1000, 6000, 11000]) await look(t);
    assert.equal(w.status().black, true);
    setBlack(false);
    await look(20_000);
    assert.equal(w.status().black, false);
    assert.equal(notes.length, 0);
    setBlack(true);
    for (const t of [30_000, 35_000, 40_000]) await look(t);
    assert.deepEqual(calls.filter((c) => c === 'evidence').length, 2, 'a new episode');
  });

  test('nothing is sampled or touched while the camera is busy', async () => {
    let free = false;
    const { calls, look } = rig({ canWatch: () => free });
    for (const t of [1000, 6000, 11000]) await look(t);
    assert.deepEqual(calls, []);
    free = true;
    for (const t of [20_000, 25_000, 30_000]) await look(t);
    assert.deepEqual(calls, ['evidence', 'gain']);
  });

  test('a stale frame says nothing', async () => {
    const { calls, w } = rig();
    for (const t of [100_000, 200_000, 300_000]) await w.tick(t);
    assert.deepEqual(calls, []);
  });

  test('a failed step is logged and the ladder goes on', async () => {
    const { calls, look } = rig({
      raiseGain: async () => {
        throw new Error('refused');
      },
    });
    for (const t of [1000, 6000, 11000]) await look(t);
    await look(11000 + 60_000);
    assert.deepEqual(calls, ['evidence', 'reenter']);
  });
});

describe('black frame test', () => {
  const frame = (bg: number, stars = 0) => {
    const w = 1280;
    const h = 720;
    const raw = Buffer.alloc(w * h, bg);
    for (let i = 0; i < stars; i++) {
      const x = 40 + ((i * 97) % (w - 80));
      const y = 40 + ((i * 53) % (h - 80));
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) raw[(y + dy) * w + x + dx] = 230;
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 1 } }).jpeg().toBuffer();
  };

  test('a black frame is black, a dark sky with stars is not, and neither is a bright flat one', async () => {
    assert.equal(await isBlackJpeg(await frame(0)), true);
    assert.equal(await isBlackJpeg(await frame(2)), true);
    assert.equal(await isBlackJpeg(await frame(3, 120)), false);
    assert.equal(await isBlackJpeg(await frame(128)), false);
  });
});

describe('still gain floor', () => {
  test('sub-second stills need more gain than multi-second ones; unknown takes the higher', () => {
    assert.equal(stillGainFloor(4), 80);
    assert.equal(stillGainFloor(1), 80);
    assert.equal(stillGainFloor(0.5), 120);
    assert.equal(stillGainFloor(null), 120);
  });
});
