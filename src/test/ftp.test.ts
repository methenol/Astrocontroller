import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { downloadFiles, downloadOne, toFtpPath, TransferCancelled } from '../dwarf/ftp.js';
import { FakeFtp } from './fake-ftp.js';

const bytes = (n: number, fill: number) => Buffer.alloc(n, fill);

describe('FTP transfers against a fake telescope FTP server', () => {
  let ftp: FakeFtp;
  let dir: string;

  before(() => {
    config.dwarf.host = '127.0.0.1';
  });

  beforeEach(async () => {
    ftp = await new FakeFtp().start();
    config.dwarf.ftpPort = ftp.port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-test-'));
  });

  afterEach(async () => {
    await ftp.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('device paths map to the FTP root and ".." is refused', () => {
    assert.equal(toFtpPath('/DWARF3/Astronomy/M 31/stacked.jpg'), '/Astronomy/M 31/stacked.jpg');
    assert.equal(toFtpPath('Astronomy/'), '/Astronomy');
    assert.throws(() => toFtpPath('/DWARF3/../etc'), /bad device path/);
  });

  test('copies every file, skips one already there at the same size, and leaves no .part files', async () => {
    ftp.files.set('/Astronomy/S/a.fits', bytes(5000, 1));
    ftp.files.set('/Astronomy/S/b.fits', bytes(7000, 2));
    fs.writeFileSync(path.join(dir, 'b.fits'), bytes(7000, 2));
    const progress: number[] = [];
    const r = await downloadFiles([{ remoteDir: '/DWARF3/Astronomy/S', localDir: dir }], (p) => progress.push(p.filesDone));
    assert.deepEqual({ files: r.files, skipped: r.skipped, failed: r.failed }, { files: 1, skipped: 1, failed: [] });
    assert.equal(r.bytes, 12000);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'a.fits')), bytes(5000, 1));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.fits', 'b.fits']);
    assert.equal(progress.at(-1), 2);
    assert.deepEqual(ftp.retrs, ['/Astronomy/S/a.fits']);
  });

  test('a transfer cut short is not taken for the file: it is fetched again, whole', async () => {
    ftp.files.set('/Astronomy/S/a.fits', bytes(9000, 3));
    ftp.truncate.set('/Astronomy/S/a.fits', 1);
    const r = await downloadFiles([{ remoteDir: '/Astronomy/S', localDir: dir }], () => undefined);
    assert.equal(r.files, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'a.fits')), bytes(9000, 3));
    assert.equal(ftp.retrs.length, 2);
  });

  test('a file that never arrives whole is reported failed; the others still copy', async () => {
    ftp.files.set('/Astronomy/S/bad.fits', bytes(4000, 4));
    ftp.files.set('/Astronomy/S/good.fits', bytes(4000, 5));
    ftp.truncate.set('/Astronomy/S/bad.fits', 99);
    const r = await downloadFiles([{ remoteDir: '/Astronomy/S', localDir: dir }], () => undefined);
    assert.equal(r.files, 1);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].error, /incomplete download: 2000 of 4000 bytes/);
    assert.equal(r.bytes, 4000, 'the failed file is not counted');
    assert.deepEqual(fs.readdirSync(dir), ['good.fits']);
  });

  test('an empty directory adds nothing; a missing file fails downloadOne and leaves nothing behind', async () => {
    ftp.files.set('/Astronomy/S/a.fits', bytes(10, 6));
    const r = await downloadFiles([{ remoteDir: '/Astronomy/S', localDir: dir }, { remoteDir: '/Astronomy/Empty', localDir: dir, optional: true }], () => undefined);
    assert.equal(r.files, 1);
    await assert.rejects(downloadOne('/DWARF3/Astronomy/S/none.jpg', path.join(dir, 'none.jpg')), /550/);
    assert.equal(fs.existsSync(path.join(dir, 'none.jpg')), false);
  });

  test('a cancelled transfer stops and says so', async () => {
    ftp.files.set('/Astronomy/S/a.fits', bytes(10, 7));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(downloadFiles([{ remoteDir: '/Astronomy/S', localDir: dir }], () => undefined, ac.signal), TransferCancelled);
  });

  test('a cancel that comes while the connection is opening ends the copy before any data is asked for', async () => {
    ftp.files.set('/Astronomy/S/a.fits', bytes(10, 8));
    ftp.loginDelayMs = 150;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    await assert.rejects(downloadOne('/DWARF3/Astronomy/S/a.fits', path.join(dir, 'a.fits'), ac.signal), TransferCancelled);
    assert.deepEqual(ftp.retrs, []);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
