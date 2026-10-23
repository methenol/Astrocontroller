import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { toFtpPath } from '../drivers/dwarf/ftp.js';
import { startJob, cancelJob, getJob, drainJobs } from '../library/jobs.js';
import { parseSessionFolder, librarySessionsFor, listLibrary, isTransferred, sessionLocalDir } from '../library/sessions.js';
import { albumLocalPath, deleteDeviceSessions, distinctPaths, missingLights } from '../library/transfer.js';
import { FakeHttpApi } from './fake-http.js';

const FOLDER = 'DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268';

// The jobs suite below calls startJob, which persists to DATA_DIR/jobs.json: keep the whole file
// off the real data dir so a test run never leaves fake jobs in the running app's job list.
const savedData = config.paths.data;
let testDataDir = '';
before(() => {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-test-data-'));
  config.paths.data = testDataDir;
});
after(() => {
  config.paths.data = savedData;
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

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
    config.paths.library = saved.library; // only what this describe changes: restoring all of config.paths would undo the file-level data-dir isolation
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

describe('deleting sessions from the SD card', () => {
  const F = 'DWARF_RAW_TELE_M 31_EXP_15_GAIN_60_2026-10-12-22-00-00-000';
  let http: FakeHttpApi;
  let dir = '';
  const savedLib = { library: '', host: '', port: 0 };

  before(async () => {
    savedLib.library = config.paths.library;
    savedLib.host = config.dwarf.host;
    savedLib.port = config.dwarf.httpPort;
    config.dwarf.host = '127.0.0.1';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-del-'));
    config.paths.library = dir;
  });
  after(async () => {
    config.paths.library = savedLib.library;
    config.dwarf.host = savedLib.host;
    config.dwarf.httpPort = savedLib.port;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const serve = async (
    answer: (r: { datas: Array<{ filePath: string }> }) => unknown,
    info: (filePath: string) => unknown = () => null,
  ) => {
    http = await new FakeHttpApi().start();
    config.dwarf.httpPort = http.port;
    http.route('POST /album/getMediaInfoByFilePath', (r) => ({ data: info((r.body as { filePath: string }).filePath) }));
    http.route('POST /album/delete', (r) => ({ data: answer(r.body as { datas: Array<{ filePath: string }> }) }));
  };
  const stop = async () => {
    await http?.stop();
  };
  /** a session folder in the library; `complete` writes the metadata a finished transfer leaves */
  const cardSession = (folder: string, complete: boolean) => {
    const d = path.join(dir, folder);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    if (complete) fs.writeFileSync(path.join(d, 'session.json'), '{"failedFiles":0}');
  };

  test('a transferred session is deleted as its whole astro album package', async () => {
    cardSession(F, true);
    await serve(
      (b) => b.datas.map((d) => ({ filePath: d.filePath, isSuccess: true })),
      (filePath) => ({ filePath, fileName: F, mediaType: 4, astroSubType: 2 }),
    );
    const out = await deleteDeviceSessions([`${F}/`]);
    assert.deepEqual(out, [{ folder: F, deleted: true }]);
    const datas = (http.requestsFor('/album/delete')[0].body as { datas: Array<{ mediaType: number; fileName: string; filePath: string }> }).datas;
    assert.deepEqual(datas, [{ mediaType: 4, filePath: `/DWARF3/Astronomy/${F}`, fileName: F, subType: 2 }]);
    await stop();
  });

  test('a session not complete in the library is refused; force deletes it anyway', async () => {
    cardSession(F, false); // folder only: a transfer that never finished
    await serve((b) => b.datas.map((d) => ({ filePath: d.filePath, isSuccess: true })));
    const refused = await deleteDeviceSessions([F]);
    assert.equal(refused[0].deleted, false);
    assert.match(refused[0].note ?? '', /not fully in the library/);
    assert.equal(http.requestsFor('/album/delete').length, 0, 'the refused session never reaches the device');
    const forced = await deleteDeviceSessions([F], { force: true });
    assert.equal(forced[0].deleted, true);
    assert.equal(http.requestsFor('/album/delete').length, 1);
    await stop();
  });

  test('a bad folder and a device refusal are reported per folder without stopping the rest', async () => {
    cardSession(F, true);
    cardSession('DWARF_RAW_WIDE_Moon_EXP_1_GAIN_1_2026-10-12-20-00-00-000', true);
    await serve((b) => b.datas.map((d) => ({ filePath: d.filePath, isSuccess: !d.filePath.includes('WIDE') })));
    const out = await deleteDeviceSessions(['not-a-session', F, 'DWARF_RAW_WIDE_Moon_EXP_1_GAIN_1_2026-10-12-20-00-00-000']);
    assert.equal(out[0].deleted, false);
    assert.match(out[0].note ?? '', /not a DWARF session folder/);
    assert.equal(out[1].deleted, true);
    assert.equal(out[2].deleted, false);
    assert.match(out[2].note ?? '', /refused/);
    await stop();
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
