import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { cancelJob, drainJobs, getJob, INTERRUPTED, jobBus, startJob } from '../library/jobs.js';

describe('background jobs', () => {
  // Every startJob persists to DATA_DIR/jobs.json: keep the whole suite in a temp dir so a test
  // run never leaves fake jobs in the running app's job list.
  const savedData = config.paths.data;
  let dataDir = '';
  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
    config.paths.data = dataDir;
  });
  after(() => {
    config.paths.data = savedData;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('run one at a time in order; a failed file list makes a job partial', async () => {
    const order: string[] = [];
    const a = startJob('t', 'a', async () => {
      order.push('a start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a end');
    });
    const b = startJob('t', 'b', async () => {
      order.push('b');
      return { failed: [{ remote: '/x/y.fits', error: 'timeout' }] };
    });
    await drainJobs();
    assert.deepEqual(order, ['a start', 'a end', 'b']);
    assert.equal(getJob(a.id)?.status, 'done');
    assert.equal(getJob(b.id)?.status, 'partial');
    assert.match(getJob(b.id)?.error ?? '', /y\.fits \(timeout\).*3 attempts|3 attempts.*y\.fits/);
  });

  test('a listener that throws neither fails the job nor stalls the ones after it', async () => {
    const bad = () => {
      throw new Error('listener bug');
    };
    jobBus.on('job', bad);
    try {
      const a = startJob('t', 'a', async () => 1);
      const b = startJob('t', 'b', async () => 2);
      await drainJobs();
      assert.equal(getJob(a.id)?.status, 'done');
      assert.equal(getJob(b.id)?.status, 'done');
    } finally {
      jobBus.off('job', bad);
    }
  });

  test('a queued job cancelled never runs; a throwing run fails only itself', async () => {
    let ran = false;
    const blocker = startJob('t', 'blocker', () => new Promise((r) => setTimeout(r, 20)));
    const q = startJob('t', 'queued', async () => {
      ran = true;
    });
    assert.ok(cancelJob(q.id));
    const f = startJob('t', 'fails', async () => {
      throw new Error('boom');
    });
    const after = startJob('t', 'after', async () => 'ok');
    await drainJobs();
    assert.equal(ran, false);
    assert.equal(getJob(blocker.id)?.status, 'done');
    assert.equal(getJob(q.id)?.status, 'cancelled');
    assert.equal(getJob(f.id)?.status, 'failed');
    assert.equal(getJob(after.id)?.status, 'done');
  });

  test('a running job that was cancelled is kept while it unwinds, however many jobs finish meanwhile', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = startJob('test', 'slow', async (j) => {
      await new Promise((r) => setTimeout(r, 5));
      await held;
      if (j.signal.aborted) throw new Error('aborted');
    });
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(cancelJob(slow.id), true);
    // more finished jobs than are kept: each start prunes
    for (let i = 0; i < 60; i++) {
      const q = startJob('test', `queued ${i}`, async () => undefined);
      cancelJob(q.id);
    }
    assert.equal(getJob(slow.id)?.status, 'cancelled', 'not forgotten while it unwinds');
    release();
    await drainJobs();
    assert.equal(getJob(slow.id)?.status, 'cancelled');
    assert.ok(getJob(slow.id)?.finishedAt);
  });

  test('the same keyed work asked for twice is one job; once it has ended it can be asked for again', async () => {
    let runs = 0;
    const work = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 5));
    };
    const a = startJob('t', 'copy x', work, 'ui', 'copy:x');
    const b = startJob('t', 'copy x', work, 'agent', 'copy:x');
    const other = startJob('t', 'copy y', work, 'ui', 'copy:y');
    assert.equal(b.id, a.id);
    assert.notEqual(other.id, a.id);
    assert.equal('key' in a, false, 'the key is not part of the job shown');
    await drainJobs();
    assert.equal(runs, 2);
    const again = startJob('t', 'copy x', work, 'ui', 'copy:x');
    assert.notEqual(again.id, a.id);
    await drainJobs();
    assert.equal(runs, 3);
  });

  test('jobs survive a restart: finished ones keep their outcome, one cut off is marked interrupted', async () => {
    const before = config.paths.data;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
    try {
      config.paths.data = dir;
      fs.writeFileSync(
        path.join(dir, 'jobs.json'),
        JSON.stringify([
          { id: 'job_done', kind: 'transfer_files', description: 'transfer 1 file(s)', status: 'done', startedAt: 1, finishedAt: 2 },
          { id: 'job_cut', kind: 'transfer_session', description: 'transfer M 31', status: 'running', startedAt: 3, progress: { filesDone: 4, filesTotal: 9, bytesDone: 0, bytesTotal: 0 } },
        ]),
      );
      assert.equal(getJob('job_done')?.status, 'done');
      const cut = getJob('job_cut');
      assert.equal(cut?.status, 'failed');
      assert.equal(cut?.error, INTERRUPTED);
      assert.equal(cancelJob('job_cut'), false, 'nothing runs to cancel');
      const fresh = startJob('t', 'after the restart', async () => 'ok');
      await drainJobs();
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8')) as Array<{ id: string; status: string }>;
      assert.equal(onDisk.find((j) => j.id === fresh.id)?.status, 'done');
      assert.equal(onDisk.find((j) => j.id === 'job_cut')?.status, 'failed');
    } finally {
      config.paths.data = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
