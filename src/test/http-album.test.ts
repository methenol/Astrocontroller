import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeHttpApi } from './fake-http.js';
import { config } from '../config.js';
import { deleteMedia } from '../dwarf/http.js';

const SESSION = '/DWARF3/Astronomy/DWARF_RAW_WIDE_C 20_EXP_15_GAIN_60_2026-10-12-04-34-34-512/stacked.jpg';

describe('album delete against the fake HTTP API', () => {
  let api: FakeHttpApi;

  before(() => {
    config.dwarf.host = '127.0.0.1';
  });

  beforeEach(async () => {
    api = await new FakeHttpApi().start();
    config.dwarf.httpPort = api.port;
  });

  afterEach(async () => {
    await api.stop();
  });

  test('sends {datas:[...]} with the album entry\'s own type, name and astro sub-type', async () => {
    api.route('POST /album/getMediaInfoByFilePath', (r) => ({
      data: { filePath: (r.body as { filePath: string }).filePath, fileName: 'DWARF_RAW_WIDE_C 20_EXP_15_GAIN_60_2026-10-12-04-34-34-512', mediaType: 4, astroSubType: 2 },
    }));
    api.route('POST /album/delete', (r) => ({ data: (r.body as { datas: Array<{ filePath: string }> }).datas.map((d) => ({ filePath: d.filePath, isSuccess: true })) }));
    const out = await deleteMedia([{ filePath: SESSION }]);
    assert.deepEqual(out, [{ filePath: SESSION, deleted: true }]);
    const body = api.requestsFor('/album/delete')[0].body as { datas: unknown[] };
    assert.ok(!Array.isArray(body), 'a bare array deletes nothing on fw 1.5.3');
    assert.deepEqual(body.datas, [{ mediaType: 4, filePath: SESSION, fileName: 'DWARF_RAW_WIDE_C 20_EXP_15_GAIN_60_2026-10-12-04-34-34-512', subType: 2 }]);
  });

  test('{data:null} (the device deleted nothing) is an error, not an empty success', async () => {
    api.route('POST /album/getMediaInfoByFilePath', () => ({ data: null }));
    api.route('POST /album/delete', () => ({ data: null }));
    await assert.rejects(deleteMedia([{ filePath: SESSION, mediaType: 4 }]), /nothing was deleted: .*did not confirm/);
  });

  test('without an album entry: astro items are named after their session folder, others after the file', async () => {
    api.route('POST /album/getMediaInfoByFilePath', () => ({ data: null }));
    api.route('POST /album/delete', (r) => ({ data: (r.body as { datas: Array<{ filePath: string }> }).datas.map((d) => ({ filePath: d.filePath, isSuccess: true })) }));
    const out = await deleteMedia([{ filePath: SESSION, mediaType: 4 }, { filePath: '/DWARF3/Normal_Photos/DWARF_TELE_2026-10-11.jpg', mediaType: 1 }]);
    const datas = (api.requestsFor('/album/delete')[0].body as { datas: Array<{ fileName: string }> }).datas;
    assert.equal(datas[0].fileName, 'DWARF_RAW_WIDE_C 20_EXP_15_GAIN_60_2026-10-12-04-34-34-512');
    assert.equal(datas[1].fileName, 'DWARF_TELE_2026-10-11.jpg');
    assert.ok(out.every((o) => o.deleted && /no album entry/.test(o.note ?? '')));
  });

  test('without an album entry or a type, a session path (its stacked image or the folder) is deleted as the whole astro session', async () => {
    api.route('POST /album/getMediaInfoByFilePath', () => ({ data: null }));
    api.route('POST /album/delete', (r) => ({ data: (r.body as { datas: Array<{ filePath: string }> }).datas.map((d) => ({ filePath: d.filePath, isSuccess: true })) }));
    const folder = SESSION.replace(/\/stacked\.jpg$/, '');
    await deleteMedia([{ filePath: SESSION }, { filePath: folder }, { filePath: '/DWARF3/Normal_Photos/DWARF_TELE_2026-10-11.jpg' }]);
    const datas = (api.requestsFor('/album/delete')[0].body as { datas: Array<{ mediaType: number; fileName: string }> }).datas;
    const name = 'DWARF_RAW_WIDE_C 20_EXP_15_GAIN_60_2026-10-12-04-34-34-512';
    assert.deepEqual(datas.map((d) => [d.mediaType, d.fileName]), [[4, name], [4, name], [1, 'DWARF_TELE_2026-10-11.jpg']]);
  });

  test('a partial delete reports each path', async () => {
    api.route('POST /album/getMediaInfoByFilePath', () => ({ data: null }));
    api.route('POST /album/delete', () => ({ data: [{ filePath: '/a/1.jpg', isSuccess: true }, { filePath: '/a/2.jpg', isSuccess: false }] }));
    const out = await deleteMedia([{ filePath: '/a/1.jpg' }, { filePath: '/a/2.jpg' }, { filePath: '/a/3.jpg' }]);
    assert.deepEqual(
      out.map((o) => [o.filePath, o.deleted, /refused/.test(o.note ?? '') ? 'refused' : /did not confirm/.test(o.note ?? '') ? 'unconfirmed' : '']),
      [['/a/1.jpg', true, ''], ['/a/2.jpg', false, 'refused'], ['/a/3.jpg', false, 'unconfirmed']],
    );
  });

  test('a device API error code is an error', async () => {
    api.route('POST /album/getMediaInfoByFilePath', () => ({ data: null }));
    api.route('POST /album/delete', () => ({ code: -1 }));
    await assert.rejects(deleteMedia([{ filePath: '/a/1.jpg' }]), /returned code -1/);
  });
});
