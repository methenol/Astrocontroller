import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CameraSource, JpegSplitter, Source } from '../media/streams.js';
import type { Dwarf } from '../drivers/dwarf/device.js';

const jpeg = (n: number, fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]);

function split(chunks: Buffer[]): Buffer[] {
  const out: Buffer[] = [];
  const s = new JpegSplitter((j) => out.push(j));
  for (const c of chunks) s.push(c);
  return out;
}

describe('JPEG splitter', () => {
  test('whole frames in one chunk, with junk around them', () => {
    const a = jpeg(10, 1);
    const b = jpeg(20, 2);
    const out = split([Buffer.concat([Buffer.from('junk'), a, Buffer.from('--frame\r\n'), b])]);
    assert.deepEqual(out, [a, b]);
  });

  test('every possible chunk boundary, including inside both markers', () => {
    const a = jpeg(7, 3);
    const b = jpeg(5, 4);
    const all = Buffer.concat([Buffer.from('xx'), a, Buffer.from('yy'), b]);
    for (let cut = 1; cut < all.length; cut++) {
      const out = split([all.subarray(0, cut), all.subarray(cut)]);
      assert.deepEqual(out, [a, b], `cut at ${cut}`);
    }
  });

  test('byte by byte', () => {
    const a = jpeg(30, 5);
    const all = Buffer.concat([a, a]);
    const out = split([...all].map((b) => Buffer.from([b])));
    assert.deepEqual(out, [a, a]);
  });

  test('frames are copies, not views of the input', () => {
    const input = Buffer.concat([jpeg(4, 6)]);
    const [f] = split([input]);
    input.fill(0);
    assert.equal(f[2], 6);
  });
});

class TestSource extends Source {
  started = 0;
  stopped = 0;
  constructor() {
    super('test');
  }
  protected startSource(): void {
    this.started++;
  }
  protected stopSource(): void {
    this.stopped++;
  }
  push(j: Buffer) {
    this.frame(j);
  }
}

describe('frame source', () => {
  test('a subscriber starts it, a throwing subscriber does not break the others', () => {
    const s = new TestSource();
    const got: number[] = [];
    const offBad = s.subscribe(() => {
      throw new Error('bad sink');
    });
    const off = s.subscribe((f) => got.push(f.jpeg.length));
    assert.equal(s.started, 1);
    s.push(jpeg(1, 1));
    assert.deepEqual(got, [5]);
    // a late subscriber gets the latest frame at once, and a throwing one is contained
    assert.doesNotThrow(() => s.subscribe(() => {
      throw new Error('late bad sink');
    }));
    off();
    offBad();
    s.forceStop();
    assert.equal(s.stopped, 1);
    assert.equal(s.running, false);
  });

  test('snapshot returns a fresh frame, waits for a new one, or times out with a reason', async () => {
    const s = new TestSource();
    s.push(jpeg(1, 1));
    assert.equal((await s.snapshot(10000, 100)).jpeg.length, 5);
    const waiting = s.snapshot(-1, 1000);
    setTimeout(() => s.push(jpeg(3, 1)), 10);
    assert.equal((await waiting).jpeg.length, 7);
    await assert.rejects(s.snapshot(-1, 30), /no new test frame within 0 s \(last frame was/);
    s.forceStop();
  });
});

/** A telescope in DSO mode, idle unless `teleStack`; a stub ffmpeg that just waits stands in for the reader. */
function teleInDso(teleStack = false) {
  const bin = mkdtempSync(path.join(tmpdir(), 'ffmpeg-stub-'));
  writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const dwarf = {
    state: { connected: true, released: false, shootingMode: { id: 2, name: 'DSO' }, stacking: { tele: { state: teleStack ? 'running' : 'idle' }, wide: { state: 'idle' } } },
    lastMotionAt: 0,
    quietPeriod: () => false,
    stackOwnsCamera: (cam: string) => teleStack && cam === 'tele',
    ensureLiveView: async () => {},
    autoExposureForLiveView: async () => null,
  } as unknown as Dwarf;
  const tele = new CameraSource('tele', 0, dwarf);
  tele.fallback = new TestSource();
  return { tele, restore: () => (process.env.PATH = oldPath) };
}

describe('wide camera source', () => {
  /** A wide camera whose reader exits at once, as ffmpeg does on a refused session. */
  function refusedWide(quiet: () => boolean) {
    const bin = mkdtempSync(path.join(tmpdir(), 'ffmpeg-stub-'));
    writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    const heals = { count: 0 };
    const dwarf = {
      state: { connected: true, released: false, shootingMode: { id: 2, name: 'DSO' }, stacking: { tele: { state: 'idle' }, wide: { state: 'idle' } } },
      lastMotionAt: 0,
      quietPeriod: quiet,
      stackOwnsCamera: () => false,
      ensureLiveView: async () => {},
      autoExposureForLiveView: async () => {
        heals.count++;
        return 'unreported';
      },
    } as unknown as Dwarf;
    return { wide: new CameraSource('wide', 1, dwarf), heals, restore: () => (process.env.PATH = oldPath) };
  }
  const exited = () => new Promise((r) => setTimeout(r, 300));

  test('a refused session triggers the exposure heal, once per episode', async () => {
    const { wide, heals, restore } = refusedWide(() => false);
    try {
      const off = wide.subscribe(() => {});
      await exited();
      assert.equal(heals.count, 1);
      wide.retryRtsp();
      await exited();
      assert.equal(heals.count, 1, 'the heal does not repeat within an episode');
      off();
    } finally {
      wide.forceStop();
      restore();
    }
  });

  test('no heal while the telescope is running an operation', async () => {
    const { wide, heals, restore } = refusedWide(() => true);
    try {
      const off = wide.subscribe(() => {});
      await exited();
      assert.equal(heals.count, 0);
      off();
    } finally {
      wide.forceStop();
      restore();
    }
  });
});

describe('tele camera source', () => {
  test('DSO mode with no stack opens the tele RTSP (it has video there), not the silent stack preview', () => {
    const { tele, restore } = teleInDso();
    try {
      const off = tele.subscribe(() => {});
      const st = tele.status();
      assert.equal(st.phase, 'connecting');
      assert.notEqual(st.reader, null);
      off();
    } finally {
      tele.forceStop();
      restore();
    }
  });

  test('a running tele stack shows the stack preview and opens no RTSP session', () => {
    const { tele, restore } = teleInDso(true);
    try {
      const off = tele.subscribe(() => {});
      const st = tele.status();
      assert.equal(st.phase, 'preview');
      assert.equal(st.reader, null);
      assert.match(st.note ?? '', /live stack preview/);
      off();
    } finally {
      tele.forceStop();
      restore();
    }
  });
});
