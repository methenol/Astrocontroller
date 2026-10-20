/**
 * Tiny MCP client for exercising the tools from a shell.
 *   node dist/tools/smoke.js                      → list tools
 *   node dist/tools/smoke.js telescope_status     → call a tool
 *   node dist/tools/smoke.js move_motors '{"pitch_deg":120}'
 * Images in results are written to ./smoke-<n>.<ext>. Exits non-zero when the call fails.
 */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Long tools (GoTo, calibration, homing) block until the telescope finishes. */
const CALL_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_PORT = 8080;
const EXT: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function parseArgs(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch (e) {
    throw new Error(`the arguments are not JSON: ${(e as Error).message}`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('the arguments must be a JSON object, e.g. \'{"pitch_deg":120}\'');
  return v as Record<string, unknown>;
}

async function main(): Promise<number> {
  const url = process.env.MCP_URL || `http://127.0.0.1:${process.env.WEB_PORT || DEFAULT_PORT}/mcp`;
  const [tool, argJson] = process.argv.slice(2);
  const args = parseArgs(argJson);
  const client = new Client({ name: 'smoke', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    if (!tool) {
      const { tools } = await client.listTools();
      for (const t of tools) console.log(`${t.name.padEnd(26)} ${t.description?.split('. ')[0] ?? ''}`);
      console.log(`\n${tools.length} tools`);
      return 0;
    }
    const started = Date.now();
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const content = Array.isArray(res.content) ? (res.content as Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>) : [];
    let n = 0;
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string') console.log(c.text);
      else if (c.type === 'image' && typeof c.data === 'string') {
        const ext = (typeof c.mimeType === 'string' && Object.hasOwn(EXT, c.mimeType) ? EXT[c.mimeType] : undefined) ?? 'bin';
        const f = `smoke-${++n}.${ext}`;
        fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
        console.log(`[image → ${f}]`);
      }
    }
    console.log(`${res.isError ? 'ERROR' : 'ok'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return res.isError ? 1 : 0;
  } finally {
    await client.close().catch(() => {});
  }
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(`smoke: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
