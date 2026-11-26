import fs from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { collectTools, capturePaths, toolRoutes } from '../web/routes/tools.js';
import { makeTool, text } from '../mcp/tools/common.js';
import { registerTools, type ToolContext } from '../mcp/tools.js';
import { seestarMcpSpec } from '../drivers/seestar/mcp.js';
import type { Seestar } from '../drivers/seestar/device.js';
import type { SeestarMedia } from '../drivers/seestar/web.js';
import type { McpSpec } from '../drivers/types.js';
import type { StarfrontNights } from '../agent/starfront.js';
import type { NightServices } from '../night/index.js';
import type { WebContext } from '../web/context.js';
import { ESTOP_MSG } from '../safety/estop.js';

/** A driver's tools as the web UI sees them, with what the duty loop was told. */
function fakeSpec(): McpSpec {
  return {
    name: 'fake',
    instructions: '',
    register(server: McpServer) {
      const tool = makeTool(server);
      tool('motor_position', 'where it points', {}, async () => text({ azDeg: 180, altDeg: 45 }));
      tool('move_motors', 'move', { azimuth_deg: z.number().min(0).max(360), relative: z.boolean().optional() }, async (a) => text({ moved: a }));
      tool('sky_check', 'look at the sky', {}, async () => text('sky_check (wide): 1920×1080\nsaved as captures/agent/2026-11-25_001_sky_check.jpg\n{"verdict":"clear"}'));
      tool('broken', 'fails', {}, async () => {
        throw new Error('the scope said no');
      });
      tool('locked', 'refused by the E-Stop', {}, async () => {
        throw new Error(ESTOP_MSG);
      });
      tool('duty', 'the agent only', {}, async () => text('no'));
    },
  };
}

async function withRoutes(fn: (call: (method: string, p: string, b?: unknown) => Promise<{ status: number; body: any }>, events: string[]) => Promise<void>) {
  const events: string[] = [];
  const ctx = { tools: fakeSpec(), duty: { event: (t: string) => events.push(t) } } as unknown as WebContext;
  const app = express();
  app.use(express.json());
  app.use('/api', toolRoutes(ctx));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    await fn(async (method, p, b) => {
      const res = await fetch(`${base}${p}`, { method, headers: b === undefined ? undefined : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: res.status, body: await res.json() };
    }, events);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('the tools route', () => {
  test('lists every tool but the agent-only ones, with its arguments as JSON Schema', async () => {
    await withRoutes(async (call) => {
      const r = await call('GET', '/tools');
      assert.equal(r.status, 200);
      const names = r.body.tools.map((t: { name: string }) => t.name);
      assert.ok(names.includes('move_motors'));
      assert.ok(!names.includes('duty'));
      const move = r.body.tools.find((t: { name: string }) => t.name === 'move_motors');
      assert.equal(move.schema.properties.azimuth_deg.type, 'number');
      assert.deepEqual(move.schema.required, ['azimuth_deg']);
      assert.equal(r.body.tools.find((t: { name: string }) => t.name === 'motor_position').readOnly, true);
    });
  });

  test('runs a tool with arguments checked against its schema, and tells an agent on duty', async () => {
    await withRoutes(async (call, events) => {
      const bad = await call('POST', '/tools/move_motors', { azimuth_deg: 400 });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /^azimuth_deg:/);
      const ok = await call('POST', '/tools/move_motors', { azimuth_deg: 90, relative: true, extra: 'dropped' });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body.json, { moved: { azimuth_deg: 90, relative: true } });
      assert.deepEqual(events, ['the user ran move_motors (azimuth_deg=90 relative=true) from the web UI']);
      // a read is not news for the agent
      await call('POST', '/tools/motor_position', {});
      assert.equal(events.length, 1);
    });
  });

  test("a tool's saved images come back as captures, and its failures as errors with their own status", async () => {
    await withRoutes(async (call) => {
      const sky = await call('POST', '/tools/sky_check', {});
      assert.deepEqual(sky.body.images, ['captures/agent/2026-11-25_001_sky_check.jpg']);
      const broken = await call('POST', '/tools/broken', {});
      assert.equal(broken.status, 422);
      assert.equal(broken.body.error, 'the scope said no');
      assert.equal((await call('POST', '/tools/locked', {})).status, 423);
      assert.equal((await call('POST', '/tools/duty', {})).status, 404);
      assert.equal((await call('POST', '/tools/nope', {})).status, 404);
    });
  });

  test('capture paths are read out of any tool text, once each', () => {
    assert.deepEqual(capturePaths('"image": "captures/agent/a_1.jpg",\nfinal frame: captures/agent/b.jpg (and captures/agent/a_1.jpg)'), ['agent/a_1.jpg', 'agent/b.jpg']);
  });
});

/** Both drivers' real tool registries (registration touches no device: the handlers do). */
function realRegistries() {
  const dwarf = collectTools({ name: 'dwarf3', instructions: '', register: (s) => registerTools(s, { dwarf: {}, hub: {}, night: {} } as unknown as ToolContext) });
  const seestar = collectTools(seestarMcpSpec({ state: {} } as unknown as Seestar, undefined, {} as SeestarMedia, {} as StarfrontNights, {} as NightServices));
  return { dwarf, seestar };
}

test('every tool form and button in the web UI names a real tool, and only arguments and actions a driver takes', () => {
  const { dwarf, seestar } = realRegistries();
  const shapes = (name: string) => [dwarf.get(name), seestar.get(name)].filter(Boolean).map((t) => z.toJSONSchema(z.object(t!.shape), { unrepresentable: 'any', io: 'input' }) as { properties?: Record<string, { enum?: unknown[] }> });
  const doc = new JSDOM(fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')).window.document;
  const problems: string[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>('[data-tool]')) {
    const name = el.dataset.tool!;
    const schemas = shapes(name);
    if (!schemas.length) {
      problems.push(`${name}: no driver has this tool`);
      continue;
    }
    if (el.tagName !== 'FORM') continue;
    for (const f of el.querySelectorAll<HTMLInputElement>('[name]')) {
      const props = schemas.map((s) => s.properties?.[f.name]).filter(Boolean);
      if (!props.length) {
        problems.push(`${name}: no driver's tool takes "${f.name}"`);
        continue;
      }
      const enums = props.flatMap((p) => p!.enum ?? []);
      const values = f.tagName === 'BUTTON' ? [f.value] : f.tagName === 'SELECT' ? [...(f as unknown as HTMLSelectElement).options].map((o) => o.value).filter((v) => v !== '') : [];
      for (const v of values) if (enums.length && !enums.includes(v)) problems.push(`${name}: no driver's ${f.name} takes "${v}"`);
    }
  }
  assert.deepEqual(problems, []);
});
