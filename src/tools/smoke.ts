/**
 * Tiny MCP client for exercising the telescope tools from a shell.
 *   node dist/tools/smoke.js                      → list tools
 *   node dist/tools/smoke.js telescope_status     → call a tool
 *   node dist/tools/smoke.js move_motors '{"pitch_deg":120}'
 * Images in results are written to ./smoke-<n>.jpg.
 */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL || `http://127.0.0.1:${process.env.WEB_PORT || 8080}/mcp`;
const [, , tool, argJson] = process.argv;

const client = new Client({ name: 'smoke', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

if (!tool) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name.padEnd(26)} ${t.description?.split('. ')[0]}`);
  console.log(`\n${tools.length} tools`);
} else {
  const started = Date.now();
  const res = await client.callTool({ name: tool, arguments: argJson ? JSON.parse(argJson) : {} }, undefined, { timeout: 900000 });
  let n = 0;
  for (const c of res.content as Array<{ type: string; text?: string; data?: string }>) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image' && c.data) {
      const f = `smoke-${++n}.jpg`;
      fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
      console.log(`[image → ${f}]`);
    }
  }
  console.log(`${res.isError ? 'ERROR' : 'ok'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
await client.close();
