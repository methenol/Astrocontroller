import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SeestarFiles } from '../drivers/seestar/storage.js';

describe('Seestar files: an immutable file crosses the link once', () => {
  test('concurrent and later reads of a sub or a dark master share one transfer; other files are read each time', async () => {
    const gets: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') gets.push(decodeURIComponent(req.url ?? ''));
      const body = Buffer.alloc(100_000, 7);
      res.writeHead(200, { 'content-length': body.length });
      // slow enough that two askers overlap
      setTimeout(() => res.end(body), 100);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const files = new SeestarFiles({ call: async () => ({}) } as never, () => '127.0.0.1', port, 0);
      const sub = 'MyWorks/C 20_sub/Light_C 20_30.0s_LP_20261118-202148.fit';
      const [a, b] = await Promise.all([files.readOnce(sub, 1e7), files.readOnce(sub, 1e7)]);
      assert.equal(a.length, 100_000);
      assert.equal(b.length, 100_000);
      assert.equal((await files.readOnce(sub, 1e7)).length, 100_000);
      assert.equal(gets.filter((g) => g.endsWith('202148.fit')).length, 1, 'one transfer for the sub');
      const dark = 'darklibrary/60s/MasterDark_5_60.0s_17.9C_20261113-225928.fit';
      await files.readOnce(dark, 1e7);
      await files.readOnce(dark, 1e7);
      assert.equal(gets.filter((g) => g.includes('MasterDark')).length, 1, 'one transfer for the master');
      const stack = 'MyWorks/C 20/Stacked_45_C 20_30.0s_LP_20261118-202148.fit';
      await files.readOnce(stack, 1e7);
      await files.readOnce(stack, 1e7);
      assert.equal(gets.filter((g) => g.includes('Stacked_')).length, 2, 'a growing stack is read fresh');
    } finally {
      server.close();
    }
  });
});
