import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitCredentials, withoutCredentials } from '../util/url.js';

describe('URL credentials', () => {
  test('withoutCredentials drops user:password and keeps the rest as given', () => {
    assert.equal(withoutCredentials('http://u:p@gpu.box:8000'), 'http://gpu.box:8000');
    assert.equal(withoutCredentials('http://u:p@gpu.box:8000/v1/'), 'http://gpu.box:8000/v1/');
    assert.equal(withoutCredentials('http://gpu.box:8000'), 'http://gpu.box:8000');
    assert.equal(withoutCredentials('not a url //u:p@x/y'), 'not a url //x/y');
  });

  test('splitCredentials turns them into a Basic header', () => {
    const { url, authorization } = splitCredentials('https://al%40ce:s%3Acret@studio.lan:8443/');
    assert.equal(url, 'https://studio.lan:8443');
    assert.equal(Buffer.from(authorization!.replace(/^Basic /, ''), 'base64').toString(), 'al@ce:s:cret');
    assert.deepEqual(splitCredentials('http://studio.lan'), { url: 'http://studio.lan' });
  });

  test('a password with a bare "%" (not percent-encoding) is sent as written, not a crash', () => {
    const { url, authorization } = splitCredentials('http://bob:50%off@studio.lan:8443');
    assert.equal(url, 'http://studio.lan:8443');
    assert.equal(Buffer.from(authorization!.replace(/^Basic /, ''), 'base64').toString(), 'bob:50%off');
  });
});

describe('links in the model\'s markdown', () => {
  test('only http(s), mailto and relative addresses are kept', async () => {
    const { isSafeUrl } = (await import(new URL('../../public/js/safe-url.js', import.meta.url).href)) as { isSafeUrl: (h: unknown) => boolean };
    for (const ok of ['https://example.org/a', 'http://x', 'mailto:a@b.c', 'captures/agent/x.jpg', '/api/state', '#top', '?q=1', '']) assert.equal(isSafeUrl(ok), true, ok);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:1', 'java\tscript:1', 'java\nscript:1', 'data:text/html,hi', 'vbscript:x', 'file:///etc/passwd']) assert.equal(isSafeUrl(bad), false, JSON.stringify(bad));
  });
});
