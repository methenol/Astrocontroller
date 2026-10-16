import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { config, setTelescopeHost } from '../config.js';
import { systemRoutes } from '../web/routes/system.js';
import { mediaRoutes, ThumbCache } from '../web/routes/media.js';
import { jsonErrors } from '../web/http.js';
import type { WebContext } from '../web/context.js';

/** The system routes over a real HTTP server, with the telescope side stubbed out. */
async function withSystemRoutes(fn: (post: (p: string, b: unknown) => Promise<{ status: number; body: Record<string, unknown> }>, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const ctx = {
    dwarf: { state: {}, location: () => null, setHost: (h: string) => calls.push(`setHost ${h}`) },
    hub: { retarget: () => calls.push('retarget'), release: () => calls.push('release') },
    agent: { status: () => ({}) },
    duty: { event: () => undefined, status: () => ({}) },
    broadcast: (m: { type: string }) => calls.push(`broadcast ${m.type}`),
  } as unknown as WebContext;
  const app = express();
  app.use(express.json());
  app.use('/api', systemRoutes(ctx, () => calls.push('thumbs cleared')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    await fn(async (p, b) => {
      const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('system routes', () => {
  test('a new telescope address moves the link and the live readers to it; the same address changes nothing', async () => {
    const before = config.dwarf.host;
    try {
      await withSystemRoutes(async (post, calls) => {
        const r = await post('/telescope-host', { host: '10.123.45.67' });
        assert.equal(r.status, 200);
        assert.equal(r.body.telescope, '10.123.45.67');
        assert.deepEqual(calls, ['thumbs cleared', 'setHost 10.123.45.67', 'retarget', 'broadcast config']);
        calls.length = 0;
        await post('/telescope-host', { host: '10.123.45.67' });
        assert.deepEqual(calls, ['broadcast config']);
      });
    } finally {
      setTelescopeHost('');
      config.dwarf.host = before;
    }
  });
});

describe('body errors', () => {
  test('a body that is not JSON or too large gets a JSON answer, JSON-RPC on /mcp, never an HTML stack trace', async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/api/x', (_req, res) => void res.json({ ok: true }));
    app.post('/mcp', (_req, res) => void res.json({ ok: true }));
    app.use(jsonErrors);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (p: string, body: string) => {
      const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      return { status: res.status, type: res.headers.get('content-type') ?? '', body: (await res.text()) };
    };
    try {
      const bad = await post('/api/x', '{nope');
      assert.equal(bad.status, 400);
      assert.match(bad.type, /application\/json/);
      assert.deepEqual(JSON.parse(bad.body), { error: 'request body is not valid JSON' });
      const big = await post('/api/x', JSON.stringify({ t: 'x'.repeat(5000) }));
      assert.equal(big.status, 413);
      assert.deepEqual(JSON.parse(big.body), { error: 'request body too large' });
      const rpc = await post('/mcp', '{nope');
      assert.equal(rpc.status, 400);
      assert.deepEqual(JSON.parse(rpc.body), { jsonrpc: '2.0', error: { code: -32700, message: 'request body is not valid JSON' }, id: null });
      assert.doesNotMatch(bad.body + big.body + rpc.body, /at .*\.js|<html/i);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('media routes', () => {
  test('captures: the newest 60, oldest first (the web UI prepends each, so the newest shows first)', async () => {
    const before = config.paths.captures;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
    config.paths.captures = dir;
    fs.mkdirSync(path.join(dir, 'agent'));
    const names = Array.from({ length: 62 }, (_, i) => `2026-10-12T0${Math.floor(i / 60)}-${String(i % 60).padStart(2, '0')}-00-000Z_001_x.jpg`);
    // written newest first, so the order comes from the names and not the directory
    for (const n of [...names].reverse()) fs.writeFileSync(path.join(dir, 'agent', n), '');
    fs.writeFileSync(path.join(dir, 'agent', 'notes.txt'), '');
    const app = express();
    app.use('/api', mediaRoutes({ hub: {} } as unknown as WebContext, new ThumbCache()));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/captures`);
      const list = (await res.json()) as Array<{ path: string; name: string }>;
      assert.equal(list.length, 60);
      assert.deepEqual(list.map((c) => c.name), names.slice(-60));
      assert.equal(list[0].path, `agent/${names[2]}`);
    } finally {
      await new Promise((r) => server.close(r));
      config.paths.captures = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
