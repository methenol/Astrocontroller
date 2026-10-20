import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../config.js';
import * as studio from '../processing/studio.js';

describe('Studio client', () => {
  const saved = config.studio.url;
  let server: http.Server;
  let port = 0;
  const seen: Array<{ url?: string; auth?: string }> = [];

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/health') res.end(JSON.stringify({ ok: true, version: 't', busy: false, queued: 0 }));
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: 'no such job' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    config.studio.url = saved;
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('credentials in ASTROPHOTO_URL are sent as Basic auth, not in the URL', async () => {
    config.studio.url = `http://user:secret@127.0.0.1:${port}`;
    const h = await studio.health();
    assert.equal(h.ok, true);
    const last = seen.at(-1)!;
    assert.equal(last.url, '/api/v1/health');
    assert.equal(Buffer.from(last.auth!.replace(/^Basic /, ''), 'base64').toString(), 'user:secret');
  });

  test("the server's error detail is reported, and an unreachable server never shows the password", async () => {
    config.studio.url = `http://user:secret@127.0.0.1:${port}`;
    await assert.rejects(studio.job('x'), (e: studio.StudioError) => e.status === 404 && /no such job/.test(e.message));
    config.studio.url = 'http://user:secret@127.0.0.1:1';
    await assert.rejects(studio.health(), (e: Error) => /unreachable at http:\/\/127\.0\.0\.1:1/.test(e.message) && !/secret/.test(e.message));
  });
});
