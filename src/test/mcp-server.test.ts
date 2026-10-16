import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Dwarf } from '../dwarf/device.js';
import { StreamHub } from '../media/streams.js';
import { mountMcp } from '../mcp/server.js';

describe('MCP endpoint', () => {
  let server: http.Server;
  let dwarf: Dwarf;
  let hub: StreamHub;
  let url = '';

  before(async () => {
    // never started: no tool here reaches a telescope
    dwarf = new Dwarf({ host: '127.0.0.1', port: 1 });
    hub = new StreamHub(dwarf);
    const app = express();
    app.use(express.json());
    mountMcp(app, { dwarf, hub });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  after(async () => {
    hub.shutdown();
    dwarf.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  test('a client connects, reads the instructions and lists every tool once, each described', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      assert.equal(client.getServerVersion()?.name, 'dwarf3');
      assert.match(client.getInstructions() ?? '', /telescope_status/);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 20, `${tools.length} tools`);
      assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
      for (const t of tools) {
        assert.match(t.name, /^[a-z][a-z0-9_]*$/, t.name);
        assert.ok((t.description ?? '').length > 10, `${t.name} has a description`);
      }
      assert.ok(tools.some((t) => t.name === 'telescope_status'));
      // a second request gets a fresh server: listing again still works
      assert.equal((await client.listTools()).tools.length, tools.length);
    } finally {
      await client.close();
    }
  });

  test('an unknown tool is an error result, not a crash', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const r = await client.callTool({ name: 'no_such_tool', arguments: {} }).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
      if (r.ok) assert.equal(r.v.isError, true);
      else assert.match(String(r.e), /no_such_tool|not found/i);
    } finally {
      await client.close();
    }
  });

  test('Sun/Moon tracking under the ND lock is refused before the shooting mode is touched', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    dwarf.setNdLock(true, 'test');
    try {
      const r = (await client.callTool({ name: 'track_sun_moon', arguments: { body: 'moon', action: 'start' } })) as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(r.isError, true);
      // a mode switch first would fail on the unreachable telescope with a different error
      assert.match(r.content[0]?.text ?? '', /refused: moon tracking while the ND filter is fitted/);
    } finally {
      dwarf.setNdLock(false);
      await client.close();
    }
  });

  test('a refused dark capture leaves no ND lock behind and sends nothing', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const before = dwarf.state.darkCapture;
    dwarf.state.darkCapture = { state: 'running', exposureS: 30, gain: 80, frames: 20, startedAt: Date.now(), expectedEndAt: Date.now() + 660_000, progress: 0 };
    try {
      const r = (await client.callTool({ name: 'dark_frames', arguments: { action: 'capture', exposure_s: 30, gain: 80, nd_filter_confirmed: true } })) as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(r.isError, true);
      // listing the firmware's masters first would fail on the unreachable telescope with a different error
      assert.match(r.content[0]?.text ?? '', /a dark capture is already running/);
      assert.equal(dwarf.state.ndLock ?? null, null);
    } finally {
      dwarf.state.darkCapture = before;
      dwarf.setNdLock(false);
      await client.close();
    }
  });

  test('a refused time/location sync does not keep the location it was given', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const before = dwarf.state.darkCapture;
    dwarf.state.darkCapture = { state: 'running', exposureS: 30, gain: 80, frames: 20, startedAt: Date.now(), expectedEndAt: Date.now() + 660_000, progress: 0 };
    try {
      const r = (await client.callTool({ name: 'sync_time_and_location', arguments: { latitude: 10, longitude: 20 } })) as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(r.isError, true);
      assert.match(r.content[0]?.text ?? '', /refused: setting the time and location while the telescope is busy with a dark capture/);
      assert.equal(dwarf.locationOverride, null);
    } finally {
      dwarf.state.darkCapture = before;
      await client.close();
    }
  });

  test('camera work under the ND lock is refused before any setting changes', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    dwarf.setNdLock(true, 'test');
    try {
      const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      // a settings change first would fail on the unreachable telescope with a different error
      const sky = await call('sky_check', {});
      assert.equal(sky.isError, true);
      assert.match(sky.content[0]?.text ?? '', /refused: a sky check while the ND filter is fitted/);
      const still = await call('view_camera', { source: 'tele', exposure_s: 2 });
      assert.equal(still.isError, true);
      assert.match(still.content[0]?.text ?? '', /refused: a still with its own exposure while the ND filter is fitted/);
    } finally {
      dwarf.setNdLock(false);
      await client.close();
    }
  });

  test('arguments that make no sense are refused before anything is sent, saying so', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      // each would fail on the unreachable telescope with a different error if it got that far
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ['move_motors', {}, /give rotation_deg and\/or pitch_deg\. Nothing was moved/],
        ['move_motors', { rotation_deg: 90, relative: true }, /too large for a relative nudge.*Nothing was moved/],
        ['goto_target', { ra_hours: 5 }, /give both ra_hours and dec_deg, or a name\. Nothing was moved/],
        ['goto_target', { name: 'Sun' }, /requires the solar filter/],
        ['goto_target', {}, /give a target name or ra_hours \+ dec_deg/],
        ['nudge', { seconds: 1 }, /give direction or angle_deg/],
        ['focus_position', { action: 'goto' }, /position required for goto/],
        ['set_camera_setting', { camera: 'wide', setting: 'exposure', value: '5' }, /stops its live video completely.*Nothing was changed/],
        ['track_sun_moon', { body: 'sun', action: 'start' }, /confirm the solar filter is fitted/],
        ['track_object', { action: 'start', x: 10 }, /x, y, width, height are required/],
        ['jobs', { action: 'cancel' }, /id is required for cancel/],
        ['sync_time_and_location', { latitude: 10 }, /give both latitude and longitude, or neither\. Nothing was synced/],
      ];
      for (const [name, args, want] of cases) {
        const r = await call(name, args);
        assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.match(r.content[0]?.text ?? '', want, `${name} ${JSON.stringify(args)}`);
      }
      assert.equal(dwarf.locationOverride, null);
    } finally {
      await client.close();
    }
  });

  test('GET and DELETE are 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(url, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
      const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32000);
    }
  });
});
