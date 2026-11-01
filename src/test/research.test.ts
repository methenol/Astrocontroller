import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simbadQuery, skyviewUrl, wikiThumb } from '../mcp/tools/research.js';

describe('target research', () => {
  test('a SIMBAD identifier is quoted as an ADQL literal', () => {
    assert.match(simbadQuery("Barnard's Star"), /WHERE i\.id = 'Barnard''s Star'$/);
  });

  test('a survey plate keeps the field shape, long side 1280 px', () => {
    const u = new URL(skyviewUrl(1.5, 30.5, 1.2, 2.13));
    assert.equal(u.searchParams.get('Position'), '22.50000,30.50000');
    assert.equal(u.searchParams.get('Size'), '1.2000,2.1300');
    assert.equal(u.searchParams.get('Pixels'), '721,1280');
  });

  test('a Wikimedia thumbnail is asked for at 1280 px; an original stays as it is', () => {
    const thumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/VST_M33.jpg/3840px-VST_M33.jpg?utm_source=en.wikipedia.org';
    assert.equal(wikiThumb(thumb), 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/VST_M33.jpg/1280px-VST_M33.jpg');
    const orig = 'https://upload.wikimedia.org/wikipedia/commons/6/64/M33.jpg';
    assert.equal(wikiThumb(orig), orig);
  });
});
