import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { ProcessingQueue, outputSource, type StudioClient } from '../processing/queue.js';
import { OutboxStore } from '../processing/store.js';
import type { StudioJob } from '../processing/studio.js';
import type { ProcessingItem } from '../processing/store.js';

const S1 = 'DWARF_RAW_TELE_M 31_EXP_15_GAIN_60_2026-10-01-22-20-58-268';

function job(over: Partial<StudioJob> = {}): StudioJob {
  return { id: 'j1', kind: 'all', folders: [], state: 'queued', progress: 0, outputs: [], ...over };
}

/** A Studio stand-in: records calls; each method can be replaced per test. */
function fakeStudio() {
  const calls: string[] = [];
  const uploaded = new Map<string, number>();
  const downloaded: Array<{ url: string; dest: string }> = [];
  const s = {
    calls,
    uploaded,
    downloaded,
    health: async () => ({ ok: true, version: 't', busy: false, queued: 0 }),
    resolve: async () => ({ folders: [], exists: false, n_fits: 0 }),
    submit: async (_b: Record<string, unknown>) => {
      calls.push('submit');
      return job();
    },
    submitMosaic: async (_b: Record<string, unknown>) => {
      calls.push('submitMosaic');
      return job();
    },
    job: async (_id: string) => job({ state: 'running', progress: 0.5 }),
    cancel: async (id: string) => {
      calls.push(`cancel ${id}`);
      return job({ state: 'cancelled' });
    },
    uploads: async (_p: string) => ({ root: '/u', files: [] as Array<{ path: string; bytes: number }> }),
    uploadFile: async (local: string, remote: string, onBytes?: (n: number) => void) => {
      const n = fs.statSync(local).size;
      onBytes?.(n);
      uploaded.set(remote, n);
    },
    download: async (url: string, dest: string) => {
      downloaded.push({ url, dest });
      fs.writeFileSync(dest, 'out');
    },
  };
  return s satisfies StudioClient & Record<string, unknown>;
}

describe('processing outbox', () => {
  const savedPaths = { ...config.paths };
  const savedStudio = { ...config.studio };
  let dir = '';
  let dataFile = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
    dataFile = path.join(dir, 'data', 'processing.json');
    Object.assign(config.paths, { library: path.join(dir, 'library') });
    Object.assign(config.studio, { url: 'http://studio.test', dataAccess: 'auto', fetchOutputs: true, libraryPath: '', stackParams: {}, params: {}, preset: '' });
    const s = path.join(config.paths.library, S1);
    fs.mkdirSync(s, { recursive: true });
    for (const f of ['a.fits', 'b.fits', 'stacked-16_x.fits']) fs.writeFileSync(path.join(s, f), 'xxxx');
    fs.writeFileSync(path.join(s, 'shotsInfo.json'), '{}');
    const dark = path.join(config.paths.library, 'CALI_FRAME', 'dark', 'cam_0');
    fs.mkdirSync(dark, { recursive: true });
    fs.writeFileSync(path.join(dark, 'd.fits'), 'dd');
  });

  afterEach(() => {
    Object.assign(config.paths, savedPaths);
    Object.assign(config.studio, savedStudio);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function pass(q: ProcessingQueue) {
    q.kick();
    await q.settled();
  }

  test('uploads what the server lacks, submits, and fetches the outputs when done', async () => {
    const st = fakeStudio();
    st.uploads = async (p: string) => ({ root: '/u', files: p === `library/${S1}` ? [{ path: `library/${S1}/a.fits`, bytes: 4 }] : [] });
    const q = new ProcessingQueue(st, () => dataFile);
    const it = q.enqueue({ sessions: [S1], target: 'M 31' });
    await q.settled();
    assert.equal(q.getItem(it.id)?.state, 'submitted');
    assert.equal(q.getItem(it.id)?.access, 'upload');
    // a.fits was already there; the stack is not a sub
    assert.deepEqual([...st.uploaded.keys()].sort(), [`library/CALI_FRAME/dark/cam_0/d.fits`, `library/${S1}/b.fits`, `library/${S1}/shotsInfo.json`]);
    assert.equal(q.getItem(it.id)?.upload?.filesTotal, 4);

    st.job = async () => job({ state: 'done', active: 120, outputs: [{ kind: 'jpg', name: '../../evil.jpg', bytes: 3, url: '/o/1' }, { kind: 'jpg', name: '..', bytes: 1, url: '/o/2' }] });
    await pass(q);
    const done = q.getItem(it.id)!;
    assert.equal(done.state, 'done');
    // the server's name is reduced to a plain file name inside processed/
    assert.deepEqual(done.outputs, [path.join(config.paths.library, S1, 'processed', 'evil.jpg')]);
    assert.ok(!fs.existsSync(path.join(dir, 'evil.jpg')));
    assert.equal(st.downloaded.length, 1);
  });

  test('the outbox survives a restart, and an interrupted upload resumes', async () => {
    const st = fakeStudio();
    st.health = async () => {
      throw new Error('unreachable');
    };
    const q1 = new ProcessingQueue(st, () => dataFile);
    const it = q1.enqueue({ sessions: [S1], target: 'M 31' });
    await q1.settled();
    assert.equal(q1.reachability().ok, false);
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    saved.items[0].state = 'uploading';
    fs.writeFileSync(dataFile, JSON.stringify(saved));
    const q2 = new ProcessingQueue(fakeStudio(), () => dataFile);
    assert.equal(q2.getItem(it.id)?.state, 'waiting');
  });

  test('a corrupt outbox file is set aside, not overwritten', () => {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, '{not json');
    const q = new ProcessingQueue(fakeStudio(), () => dataFile);
    assert.deepEqual(q.listItems(), []);
    assert.ok(fs.readdirSync(path.dirname(dataFile)).some((f) => f.startsWith('processing.json.bad-')));
  });

  test('saving before anything was read keeps the saved items; unknown states are dropped', () => {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const item = { id: 'a', sessions: ['s'], target: 't', profile: 'p', kind: 'k', origin: 'o', createdAt: 1, state: 'done', generation: 0, attempts: 0 };
    fs.writeFileSync(dataFile, JSON.stringify({ items: [item, { ...item, id: 'b', state: 'exploded' }] }));
    new OutboxStore(() => dataFile).save();
    const store = new OutboxStore(() => dataFile);
    assert.deepEqual(store.items.map((i) => i.id), ['a']);
  });

  test('a cancel during an in-flight submit cancels the job the server then accepted', async () => {
    const st = fakeStudio();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    st.submit = async () => {
      await gate;
      return job({ id: 'late' });
    };
    const q = new ProcessingQueue(st, () => dataFile);
    const it = q.enqueue({ sessions: [S1], target: 'M 31' });
    while (!st.uploaded.size) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await q.cancel(it.id);
    release();
    await q.settled();
    assert.equal(q.getItem(it.id)?.state, 'cancelled');
    assert.ok(st.calls.includes('cancel late'));
    await assert.rejects(q.cancel(it.id), /only waiting, uploading or submitted/);
  });

  test('a submitted item is cancelled on the server; an unreachable server is noted, the item still cancelled', async () => {
    const st = fakeStudio();
    const q = new ProcessingQueue(st, () => dataFile);
    const it = q.enqueue({ sessions: [S1], target: 'M 31' });
    await q.settled();
    st.cancel = async () => {
      throw new Error('down');
    };
    const c = await q.cancel(it.id);
    assert.equal(c.state, 'cancelled');
    assert.match(c.message ?? '', /may still run/);
  });

  test('a refusal from the server fails the item at once; network trouble retries', async () => {
    const { StudioError } = await import('../processing/studio.js');
    const st = fakeStudio();
    st.submit = async () => {
      throw new Error('ECONNRESET');
    };
    const q = new ProcessingQueue(st, () => dataFile);
    const it = q.enqueue({ sessions: [S1], target: 'M 31' });
    await q.settled();
    assert.equal(q.getItem(it.id)?.state, 'waiting');
    assert.equal(q.getItem(it.id)?.attempts, 1);
    st.submit = async () => {
      throw new StudioError('bad profile', 422);
    };
    await pass(q);
    assert.equal(q.getItem(it.id)?.state, 'failed');
    const r = q.retry(it.id);
    assert.equal(r.generation, 1);
    assert.equal(r.attempts, 0);
  });

  test('a server restart is resent even after the user retried the item several times', async () => {
    const st = fakeStudio();
    st.submit = async () => {
      throw new (await import('../processing/studio.js')).StudioError('bad profile', 422);
    };
    const q = new ProcessingQueue(st, () => dataFile);
    const it = q.enqueue({ sessions: [S1], target: 'M 31' });
    await q.settled();
    for (let i = 0; i < 4; i++) {
      q.retry(it.id);
      await q.settled();
    }
    assert.equal(q.getItem(it.id)?.generation, 4);
    st.submit = async () => job();
    q.retry(it.id);
    await q.settled();
    assert.equal(q.getItem(it.id)?.state, 'submitted');
    st.job = async () => job({ state: 'interrupted' });
    await pass(q);
    const after = q.getItem(it.id)!;
    assert.equal(after.resends, 1);
    assert.notEqual(after.state, 'failed', 'interrupted by a restart: sent again, not failed');
  });

  test('a processing listener that throws breaks neither the upload nor the item', async () => {
    const st = fakeStudio();
    const q = new ProcessingQueue(st, () => dataFile);
    q.bus.on('item', () => {
      throw new Error('listener bug');
    });
    const it = q.enqueue({ sessions: [S1], target: 'M 31' });
    await q.settled();
    assert.equal(q.getItem(it.id)?.state, 'submitted');
    assert.ok(st.uploaded.size > 0);
  });

  test('enqueue refuses an empty target name', () => {
    const q = new ProcessingQueue(fakeStudio(), () => dataFile);
    assert.throws(() => q.enqueue({ sessions: [S1], target: '  ' }), /target name/);
  });

  test('enqueue refuses bad names and dedupes open items', async () => {
    const q = new ProcessingQueue(fakeStudio(), () => dataFile);
    assert.throws(() => q.enqueue({ sessions: ['../etc'], target: 'x' }), /not a session folder name/);
    assert.throws(() => q.enqueue({ sessions: ['DWARF_RAW_TELE_X_EXP_1_GAIN_1_2026-01-01-00-00-00'], target: 'x' }), /not in the library/);
    assert.throws(() => q.enqueue({ sessions: [], target: 'x' }), /no sessions/);
    const a = q.enqueue({ sessions: [S1, S1], target: 'M 31' });
    assert.deepEqual(a.sessions, [S1]);
    assert.equal(q.enqueue({ sessions: [S1], target: 'M 31' }).id, a.id);
    q.stop();
    await q.settled();
  });
});

describe('processing output downloads', () => {
  const savedPaths = { ...config.paths };
  const savedStudio = { ...config.studio };
  const lib = path.join(os.tmpdir(), 'proc-out-lib');
  const item = (over: Partial<ProcessingItem>): ProcessingItem => ({ id: 'p1', sessions: [S1], target: 'M 31', profile: 'default', kind: 'all', origin: 'ui', createdAt: 1, state: 'done', generation: 0, attempts: 0, ...over });

  beforeEach(() => {
    Object.assign(config.paths, { library: lib });
    Object.assign(config.studio, { url: 'http://user:pw@studio.test:8112' });
  });
  afterEach(() => {
    Object.assign(config.paths, savedPaths);
    Object.assign(config.studio, savedStudio);
  });

  test('a local output in the library is found by its file name', () => {
    const f = path.join(lib, S1, 'processed', 'M31.jpg');
    assert.deepEqual(outputSource(item({ outputs: [f] }), 'M31.jpg'), { local: f, name: 'M31.jpg' });
  });

  test('a remote output (outputs not fetched) is a path on the configured server', () => {
    assert.deepEqual(outputSource(item({ outputs: ['http://studio.test:8112/api/v1/jobs/j1/outputs/M31.tif'] }), 'M31.tif'), { remote: '/api/v1/jobs/j1/outputs/M31.tif', name: 'M31.tif' });
  });

  test('refuses unknown names, open items, paths outside the library and other hosts', () => {
    const f = path.join(lib, S1, 'processed', 'M31.jpg');
    assert.equal(outputSource(item({ outputs: [f] }), 'other.jpg'), null);
    assert.equal(outputSource(item({ outputs: [f], state: 'submitted' }), 'M31.jpg'), null);
    assert.equal(outputSource(item({ outputs: ['/etc/passwd'] }), 'passwd'), null);
    assert.equal(outputSource(item({ outputs: ['http://evil.test/x.jpg'] }), 'x.jpg'), null);
    assert.equal(outputSource(item({ outputs: [f] }), '..'), null);
    assert.equal(outputSource(undefined, 'M31.jpg'), null);
  });
});
