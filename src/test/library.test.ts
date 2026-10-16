import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { toFtpPath } from '../dwarf/ftp.js';
import { startJob, cancelJob, getJob, drainJobs } from '../library/jobs.js';
import { parseSessionFolder, librarySessionsFor, listLibrary, isTransferred, sessionLocalDir } from '../library/sessions.js';
import { albumLocalPath, distinctPaths, missingLights } from '../library/transfer.js';

const FOLDER = 'DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268';

describe('session folders', () => {
  test('parses a DWARF session folder', () => {
    const s = parseSessionFolder(FOLDER);
    assert.deepEqual(s, { folder: FOLDER, path: `/Astronomy/${FOLDER}`, camera: 'tele', target: 'NGC 281', exposureS: 15, gain: 60, startedAt: '2026-10-01T22:20:58' });
  });

  test('refuses names that are not one plain folder', () => {
    assert.equal(parseSessionFolder(`${FOLDER}/../../etc`), null);
    assert.equal(parseSessionFolder(`${FOLDER}\\x`), null);
    assert.equal(parseSessionFolder('photos'), null);
  });
});

describe('device and library paths', () => {
  const saved = { ...config.paths };
  let dir = '';
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
    Object.assign(config.paths, { library: path.join(dir, 'library') });
  });
  after(() => {
    Object.assign(config.paths, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('toFtpPath strips DWARF3 and refuses ..', () => {
    assert.equal(toFtpPath('/DWARF3/Astronomy/X/'), '/Astronomy/X');
    assert.equal(toFtpPath('Astronomy'), '/Astronomy');
    assert.throws(() => toFtpPath('/DWARF3/../etc'), /bad device path/);
  });

  test('album files land inside the library', () => {
    const lib = path.resolve(config.paths.library);
    assert.equal(albumLocalPath('/DWARF3/Astronomy/S/stacked.jpg'), path.join(lib, 'Astronomy', 'S', 'stacked.jpg'));
    assert.equal(albumLocalPath('/DWARF3/Normal_Photos/a.jpg', '2026-10-12'), path.join(lib, '_photos', '2026-10-12', 'a.jpg'));
    assert.throws(() => albumLocalPath('/DWARF3/Astronomy/../../x'), /bad device path/);
    assert.throws(() => albumLocalPath(''), /bad device path/);
  });

  test('album files of the same name in one request get distinct destinations', () => {
    assert.deepEqual(distinctPaths(['/l/a.jpg', '/l/a.jpg', '/l/b.jpg', '/l/a.jpg']), ['/l/a.jpg', '/l/a-2.jpg', '/l/b.jpg', '/l/a-3.jpg']);
  });

  test('library listing groups by target and skips unreadable entries', () => {
    const lib = config.paths.library;
    const a = path.join(lib, FOLDER);
    fs.mkdirSync(a, { recursive: true });
    for (const f of ['1.fits', '2.fits', 'failed_3.fits', 'stacked-16_x.fits', 'stacked.jpg']) fs.writeFileSync(path.join(a, f), '');
    fs.writeFileSync(path.join(lib, 'DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-02-22-00-00-000'), 'a file, not a session');
    assert.deepEqual(librarySessionsFor('NGC 281'), [FOLDER]);
    assert.deepEqual(librarySessionsFor('NGC 281', 'wide'), []);
    assert.deepEqual(listLibrary(), [{ target: 'NGC 281', sessions: [{ name: FOLDER, camera: 'tele', lights: 2, rejected: 1, startedAt: '2026-10-01T22:20:58' }] }]);
  });

  test('a session counts as transferred only once its transfer finished with every file', () => {
    const s = parseSessionFolder(FOLDER.replace('22-20-58', '23-00-00'))!;
    const dir = sessionLocalDir(s);
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(isTransferred(s), false, 'the folder alone: a transfer that never finished');
    fs.writeFileSync(path.join(dir, 'session.json'), '{"failedFiles":2}');
    assert.equal(isTransferred(s), false, 'a partial transfer');
    fs.writeFileSync(path.join(dir, 'session.json'), '{trunc');
    assert.equal(isTransferred(s), false, 'unreadable metadata');
    fs.writeFileSync(path.join(dir, 'session.json'), '{"failedFiles":0}');
    assert.equal(isTransferred(s), true);
    fs.writeFileSync(path.join(dir, 'session.json'), '{"transferredAt":"2026-10-01T00:00:00Z"}');
    assert.equal(isTransferred(s), true, 'metadata from before failures were recorded');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing library is empty, not an error', () => {
    Object.assign(config.paths, { library: path.join(dir, 'absent') });
    assert.deepEqual(listLibrary(), []);
    assert.deepEqual(librarySessionsFor('x'), []);
    Object.assign(config.paths, { library: path.join(dir, 'library') });
  });
});

describe('jobs', () => {
  test('a job that finishes is done; failed files make it partial', async () => {
    const ok = startJob('t', 'ok', async () => ({ failed: [] }));
    const part = startJob('t', 'part', async () => ({ failed: [{ remote: '/a/b.fits', error: 'EIO' }] }));
    await drainJobs();
    assert.equal(getJob(ok.id)?.status, 'done');
    assert.equal(getJob(part.id)?.status, 'partial');
    assert.match(getJob(part.id)?.error ?? '', /b\.fits \(EIO\)/);
  });

  test('a job cancelled while running stays cancelled even if its work returns', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const j = startJob('t', 'slow', async () => {
      await gate;
      return { failed: [] };
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(getJob(j.id)?.status, 'running');
    assert.equal(cancelJob(j.id), true);
    release();
    await drainJobs();
    assert.equal(getJob(j.id)?.status, 'cancelled');
    assert.ok(getJob(j.id)?.finishedAt);
    assert.equal(cancelJob(j.id), false);
  });

  test('a queued job cancelled before its turn never runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    startJob('t', 'first', () => gate);
    let ran = false;
    const second = startJob('t', 'second', async () => {
      ran = true;
    });
    assert.equal(cancelJob(second.id), true);
    release();
    await drainJobs();
    assert.equal(ran, false);
    assert.equal(getJob(second.id)?.status, 'cancelled');
  });

  test('a throwing job fails with its message', async () => {
    const j = startJob('t', 'boom', async () => {
      throw new Error('boom');
    });
    await drainJobs();
    assert.equal(getJob(j.id)?.status, 'failed');
    assert.equal(getJob(j.id)?.error, 'boom');
  });
});

describe('processing after a transfer', () => {
  test('only a missing light frame holds processing back, not the scope\'s stacked FITS or a calibration master', () => {
    const s = parseSessionFolder(FOLDER)!;
    const f = (remote: string) => ({ remote, error: 'x' });
    assert.deepEqual(missingLights(s, [f(`${s.path}/stacked-16_NGC 281.fits`), f('/Astronomy/CALI_FRAME/dark/cam_0/dark_exp_15.fits'), f(`${s.path}/stacked.jpg`)]), []);
    assert.equal(missingLights(s, [f(`${s.path}/NGC 281_15s60_Astro_0001.fits`), f(`${s.path}/failed_NGC 281_0002.fits`)]).length, 2);
  });
});
