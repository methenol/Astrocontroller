import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { encodeHeader, frameImage, framePixels, IMG_TYPE, parseHeader } from '../drivers/seestar/image-stream.js';
import { nightOf, parseLight, parseStack, seestarLibrary, zonedEpochS } from '../drivers/seestar/library.js';
import { parseFitsHeader, type SeestarEntry, type SeestarFiles } from '../drivers/seestar/files.js';
import { bayerFits } from '../drivers/seestar/capture.js';
import { superviseStack } from '../drivers/seestar/duty.js';
import { initialState } from '../drivers/seestar/state.js';
import type { Seestar } from '../drivers/seestar/device.js';
import { readFits } from '../media/fits.js';
import { decode } from '../media/images.js';
import { parseSessionFolder } from '../library/sessions.js';
import { calibrationCamera } from '../processing/queue.js';

/** A streaming ZIP local entry around the data, as the scope sends frames. */
function zipped(data: Buffer, name = 'raw_data'): Buffer {
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 6); // sizes in a data descriptor, as the scope writes them
  local.writeUInt16LE(n.length, 26);
  return Buffer.concat([local, n, zlib.deflateRawSync(data)]);
}

/** A FITS header block (the cards, END, padded). */
function fitsHeader(cards: Record<string, string | number | boolean>): Buffer {
  const lines = Object.entries(cards).map(([k, v]) => `${k.padEnd(8)}= ${typeof v === 'string' ? `'${v}'` : typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : String(v).padStart(20)}`.padEnd(80));
  lines.push('END'.padEnd(80));
  return Buffer.from(lines.join('').padEnd(2880), 'latin1');
}

describe('Seestar frames (S50 Pro, firmware 9.75)', () => {
  test('a preview sub wrapped in a ZIP is unwrapped and binned like a plain one', async () => {
    const w = 4;
    const h = 2;
    const px = Buffer.alloc(w * h * 2);
    for (let i = 0; i < w * h; i++) px.writeUInt16LE(i < 2 || (i >= 4 && i < 6) ? 65535 : 0, i * 2);
    const zip = zipped(px);
    assert.deepEqual(framePixels(zip, px.length, 'x'), px);
    const img = await frameImage({ header: parseHeader(encodeHeader({ imgType: IMG_TYPE.preview, length: zip.length, width: w, height: h }))!, payload: zip, at: 5 }, 'tele');
    assert.deepEqual([img.width, img.height, img.channels], [2, 1, 1]);
    assert.deepEqual([...img.data].map((v) => +v.toFixed(3)), [1, 0]);
    assert.throws(() => framePixels(Buffer.alloc(9), px.length, 'not a frame'), /not a frame/);
  });
});

describe('Seestar storage names', () => {
  test('lights and stacks are read from their names, in the scope\'s local time', () => {
    assert.deepEqual(parseLight('Light_M 31_60.0s_IRCUT_20261028-003945.fit'), { target: 'M 31', exp: '60.0', filter: 'IRCUT', stamp: '2026-10-28-00-39-45' });
    assert.deepEqual(parseStack('Stacked_159_M 31_60.0s_IRCUT_20261028-004000.fit'), { frames: 159, target: 'M 31', exp: '60.0', filter: 'IRCUT', stamp: '2026-10-28-00-40-00' });
    assert.equal(parseStack('Stacked_37_IC 434_60.0s_LP_20261028-055344.jpg')?.target, 'IC 434');
    assert.equal(parseLight('Light_M 31_60.0s_IRCUT_20261028-003945_thn.jpg'), null);
    assert.equal(parseLight('2026-10-28-100643-Scenery.mp4'), null);
  });

  test('a night runs noon to noon: after midnight belongs to the evening before', () => {
    assert.equal(nightOf('2026-10-27-21-51-23'), '2026-10-27');
    assert.equal(nightOf('2026-10-28-05-53-44'), '2026-10-27');
    assert.equal(nightOf('2026-10-28-12-00-01'), '2026-10-28');
  });

  test('a wall-clock time in a zone becomes the right instant, either side of a DST change', () => {
    assert.equal(zonedEpochS('2026-10-28 05:53:46', 'America/Chicago'), Date.UTC(2026, 9, 28, 10, 53, 46) / 1000);
    assert.equal(zonedEpochS('2026-12-01 20:00:00', 'America/Chicago'), Date.UTC(2026, 11, 2, 2, 0, 0) / 1000);
    assert.equal(zonedEpochS('nonsense', 'UTC'), 0);
  });

  test("the two telescopes' calibration masters live apart in a shared library", () => {
    assert.equal(calibrationCamera('DWARF_RAW_TELE_M 42_EXP_15_GAIN_60_2026-10-10-04-11-32-312'), 'cam_0');
    assert.equal(calibrationCamera('DWARF_RAW_WIDE_M 42_EXP_15_GAIN_60_2026-10-10-04-11-32-312'), 'cam_1');
    assert.equal(calibrationCamera('SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-51-23_IRCUT'), 'seestar_cam_0');
    assert.equal(calibrationCamera('SEESTAR_RAW_WIDE_M 31_EXP_60_GAIN_200_2026-10-27-21-51-23_IRCUT'), 'seestar_cam_1');
  });

  test('a Seestar session folder parses like a Dwarf one', () => {
    const s = parseSessionFolder('SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-51-23_IRCUT')!;
    assert.deepEqual([s.camera, s.target, s.exposureS, s.gain, s.startedAt, s.path], ['tele', 'M 31', 60, 200, '2026-10-27T21:51:23', s.folder]);
    assert.equal(parseSessionFolder('DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268')!.path, '/Astronomy/DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268');
  });
});

/** Storage as the scope lists it, with FITS headers for the first subs. */
function fakeFiles(tree: Record<string, SeestarEntry[]>, headers: Record<string, Record<string, string | number | boolean>> = {}) {
  const deleted: string[] = [];
  const files = {
    list: async (dir: string) => {
      if (!tree[dir]) throw new Error(`no ${dir}`);
      return tree[dir];
    },
    fitsHeader: async (rel: string) => headers[rel] ?? {},
    url: (rel: string) => `http://scope/${rel}`,
    delete: async (rel: string) => {
      deleted.push(rel);
      return true;
    },
  } as unknown as SeestarFiles;
  return { files, deleted };
}
const sub = (name: string): SeestarEntry => ({ name, isDir: false, size: 16205 * 1024 });
const dir = (name: string): SeestarEntry => ({ name, isDir: true, size: 0 });

describe('Seestar sessions', () => {
  const tree = {
    MyWorks: [dir('M 31'), dir('M 31_sub'), dir('IC 434'), dir('IC 434_sub'), dir('Scenery_video')],
    'MyWorks/M 31_sub': [
      sub('Light_M 31_60.0s_IRCUT_20261027-215123.fit'),
      sub('Light_M 31_60.0s_IRCUT_20261028-003945.fit'),
      sub('Light_M 31_60.0s_IRCUT_20261028-223000.fit'),
      sub('Light_M 31_30.0s_IRCUT_20261028-224000.fit'),
    ],
    'MyWorks/M 31': [sub('Stacked_2_M 31_60.0s_IRCUT_20261028-004000.fit'), sub('Stacked_2_M 31_60.0s_IRCUT_20261028-004000.jpg')],
    'MyWorks/IC 434_sub': [sub('Light_IC 434_60.0s_LP_20261028-004354.fit')],
    'MyWorks/IC 434': [],
    'MyWorks/Scenery_video': [sub('2026-10-28-103041-Scenery.mp4')],
  };
  const headers = { 'MyWorks/M 31_sub/Light_M 31_60.0s_IRCUT_20261027-215123.fit': { GAIN: 200, WIDECAM: 0 } };

  test('one session per target, sub length, filter and night, named like the Dwarf\'s', async () => {
    const lib = seestarLibrary(fakeFiles(tree, headers).files);
    const { sessions, otherFolders } = await lib.listSessions(true);
    assert.deepEqual(
      sessions.map((s) => s.folder),
      [
        'SEESTAR_RAW_TELE_M 31_EXP_30_GAIN_0_2026-10-28-22-40-00_IRCUT',
        'SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_0_2026-10-28-22-30-00_IRCUT',
        'SEESTAR_RAW_TELE_IC 434_EXP_60_GAIN_0_2026-10-28-00-43-54_LP',
        'SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-51-23_IRCUT',
      ],
    );
    const night = sessions.find((s) => s.gain === 200)!;
    assert.equal(night.fitsCount, 2);
    assert.deepEqual(otherFolders, ['Scenery_video']);
    assert.deepEqual(await lib.sessionSubs(night.folder), ['MyWorks/M 31_sub/Light_M 31_60.0s_IRCUT_20261027-215123.fit', 'MyWorks/M 31_sub/Light_M 31_60.0s_IRCUT_20261028-003945.fit']);
    // what the library records carries no listing state
    const resolved = await lib.resolveSession(night.folder);
    assert.equal('transferred' in resolved, false);
    assert.equal((await lib.resolveSession('latest')).folder, sessions[0].folder);
    await assert.rejects(lib.resolveSession('DWARF_RAW_TELE_X_EXP_1_GAIN_1_2026-01-01-00-00-00'), /not a Seestar session/);
  });

  test('the album: one tile per stack (its JPEG), linked to its night\'s session; videos with their thumbnails', async () => {
    const lib = seestarLibrary(fakeFiles(tree, headers).files);
    const items = await lib.album.list(0, 0, 50);
    const stack = items.find((i) => i.mediaType === 4)!;
    assert.equal(stack.filePath, '/SEESTAR/MyWorks/M 31/Stacked_2_M 31_60.0s_IRCUT_20261028-004000.jpg');
    assert.equal(stack.thumbnailPath, '/SEESTAR/MyWorks/M 31/Stacked_2_M 31_60.0s_IRCUT_20261028-004000_thn.jpg');
    assert.equal(stack.astroImageDetails?.srcDir, 'SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-51-23_IRCUT');
    const video = items.find((i) => i.mediaType === 2)!;
    assert.equal(video.thumbnailPath, '/SEESTAR/MyWorks/Scenery_video/2026-10-28-103041-Scenery_thn.jpg');
    assert.deepEqual((await lib.album.counts()).find((c) => c.mediaType === 0), { mediaType: 0, count: 2 });
    assert.equal(lib.album.isDevicePath('/SEESTAR/MyWorks/M 31/x.jpg'), true);
    assert.equal(lib.album.isDevicePath('/SEESTAR/../etc/passwd'), false);
    assert.equal(lib.album.isDevicePath('/DWARF3/Astronomy/x.jpg'), false);
  });

  test('deleting a session deletes its subs and stacks with their thumbnails, nothing else', async () => {
    const { files, deleted } = fakeFiles(tree, headers);
    const lib = seestarLibrary(files);
    const r = await lib.deleteSession(await lib.resolveSession('SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-51-23_IRCUT'));
    assert.deepEqual(r, { deleted: true });
    assert.deepEqual(deleted.filter((d) => !d.endsWith('_thn.jpg')).sort(), [
      'MyWorks/M 31/Stacked_2_M 31_60.0s_IRCUT_20261028-004000.fit',
      'MyWorks/M 31/Stacked_2_M 31_60.0s_IRCUT_20261028-004000.jpg',
      'MyWorks/M 31_sub/Light_M 31_60.0s_IRCUT_20261027-215123.fit',
      'MyWorks/M 31_sub/Light_M 31_60.0s_IRCUT_20261028-003945.fit',
    ]);
  });

  test('an album file lands under the library mirror of the scope, never outside it', () => {
    const lib = seestarLibrary(fakeFiles(tree).files);
    assert.equal(lib.albumLocalPath('/SEESTAR/MyWorks/M 31/a.jpg', '2026-10-28'), path.join(path.resolve(config.paths.library), 'MyWorks', 'M 31', 'a.jpg'));
    assert.throws(() => lib.albumLocalPath('/SEESTAR/MyWorks/../../x', '2026-10-28'));
  });
});

describe('FITS', () => {
  test('the header parser reads strings, numbers and flags up to END', () => {
    const h = parseFitsHeader(fitsHeader({ SIMPLE: true, GAIN: 200, FILTER: 'IRCUT', 'CCD-TEMP': 22.4375, WIDECAM: 0 }));
    assert.deepEqual(h, { SIMPLE: true, GAIN: 200, FILTER: 'IRCUT', 'CCD-TEMP': 22.4375, WIDECAM: 0 });
  });

  test('a raw photo is written as 16-bit FITS that reads back to the same pixels', () => {
    const w = 4;
    const h = 2;
    const px = Buffer.alloc(w * h * 2);
    for (let i = 0; i < w * h; i++) px.writeUInt16LE(i * 8000, i * 2);
    const f = readFits(bayerFits(px, w, h, { BAYERPAT: 'GRBG', OBJECT: "Barnard's Loop" }));
    assert.deepEqual([...f.data], [0, 8000, 16000, 24000, 32000, 40000, 48000, 56000]);
    assert.equal(f.bayer, 'GRBG');
    assert.equal(f.header.OBJECT, "Barnard's Loop");
  });

  test('a Seestar stack (an RGB cube) decodes in colour', async () => {
    const w = 2;
    const h = 1;
    const data = Buffer.alloc(3 * w * h * 2);
    // planes R, G, B: the first pixel red, the second blue
    const planes = [[1000, 0], [0, 0], [0, 1000]];
    planes.forEach((p, c) => p.forEach((v, i) => data.writeInt16BE(v - 32768, (c * w * h + i) * 2)));
    const buf = Buffer.concat([fitsHeader({ SIMPLE: true, BITPIX: 16, NAXIS: 3, NAXIS1: w, NAXIS2: h, NAXIS3: 3, BZERO: 32768, BAYERPAT: 'GRBG' }), data, Buffer.alloc(2880 - data.length)]);
    const f = readFits(buf);
    assert.equal(f.bayer, undefined);
    assert.deepEqual([...f.rgb!], [1000, 0, 0, 0, 0, 1000]);
    const img = await decode(buf, 'stack.fit');
    assert.equal(img.channels, 3);
    assert.ok(img.data[0] > img.data[2] && img.data[5] > img.data[3]);
  });
});

describe('Seestar stack supervisor', () => {
  function scopeWith(stack: { state?: string; stacked?: number; dropped?: number }) {
    const st = initialState('zwo');
    st.connected = true;
    st.stack = stack;
    st.deviceState = { setting: { exp_ms: { stack_l: 60_000 } } };
    let stops = 0;
    const scope = {
      state: st,
      stopStack: async () => {
        stops++;
        st.stack.state = 'cancel';
        return { code: 0 };
      },
    } as unknown as Seestar;
    return { scope, st, stops: () => stops };
  }

  test('frames that keep coming but never stack: alarm, then an automatic stop', async () => {
    let t = 0;
    const events: string[] = [];
    const { scope, st, stops } = scopeWith({ state: 'working', stacked: 10, dropped: 0 });
    const off = superviseStack(scope, (text) => events.push(text), { autoStopAfterMs: 10 * 60_000, everyMs: 5, now: () => t });
    const wait = () => new Promise((r) => setTimeout(r, 20));
    await wait();
    t += 6 * 60_000;
    st.stack.dropped = 6;
    await wait();
    assert.ok(events.some((e) => /REJECTING/.test(e)), events.join('\n'));
    assert.equal(stops(), 0);
    t += 11 * 60_000;
    st.stack.dropped = 17;
    await wait();
    off();
    assert.equal(stops(), 1);
    assert.ok(events.some((e) => /STOPPED automatically/.test(e)), events.join('\n'));
  });

  test('a stack that stacks is left alone, and one that recovers is reported', async () => {
    let t = 0;
    const events: string[] = [];
    const { scope, st, stops } = scopeWith({ state: 'working', stacked: 1, dropped: 0 });
    const off = superviseStack(scope, (text) => events.push(text), { autoStopAfterMs: 60 * 60_000, everyMs: 5, now: () => t });
    const wait = () => new Promise((r) => setTimeout(r, 20));
    await wait();
    t += 2 * 60_000;
    st.stack.stacked = 3;
    await wait();
    assert.deepEqual(events, []);
    t += 10 * 60_000;
    await wait();
    assert.ok(events.some((e) => /STALLED/.test(e)));
    st.stack.stacked = 4;
    await wait();
    off();
    assert.ok(events.some((e) => /recovered/.test(e)));
    assert.equal(stops(), 0);
  });
});
