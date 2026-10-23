import fs from 'node:fs';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type ToolContext } from './tools.js';
import type { McpSpec } from '../drivers/types.js';
import { logger, errMsg } from '../log.js';
import { rejectCrossSite } from '../web/http.js';

const log = logger('mcp');

/** The Dwarf MCP server's name: tools reach the agent as mcp__dwarf3__<tool>. */
const SERVER_NAME = 'dwarf3';
const VERSION = ((): string => {
  try {
    const v: unknown = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

const INSTRUCTIONS = `Tools for a DWARFLAB Dwarf 3 smart telescope (two cameras: tele 150mm f/4.3 with VIS/Astro/Duo-Band filters, and wide 6.7mm).
Start with telescope_status. Motors must be homed after power-on (motors_home). Long operations (calibrate, goto_target, polar_alignment, autofocus astro, motors_home, move_motors) block until the telescope reports them finished. Background work (dark masters, transfers, processing, a stack the scope ends itself) is reported to the agent by Astrocontroller as an event when it ends.
Coordinates are J2000. Never point at the Sun without the user confirming a solar filter.`;

/** The Dwarf 3 tools as an MCP server. */
export function dwarfMcpSpec(ctx: ToolContext): McpSpec {
  return { name: SERVER_NAME, instructions: INSTRUCTIONS, register: (server) => registerTools(server, ctx) };
}

/** The Dwarf 3 tools at /mcp. */
export function mountMcp(app: Express, ctx: ToolContext): void {
  mountMcpServer(app, dwarfMcpSpec(ctx));
}

/** A driver's MCP server at /mcp. */
export function mountMcpServer(app: Express, spec: McpSpec): void {
  const handle = async (req: Request, res: Response) => {
    // Stateless: one server and transport per request, closed with the response.
    const server = new McpServer({ name: spec.name, version: VERSION }, { instructions: spec.instructions });
    spec.register(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch((e: unknown) => log.debug(`closing an MCP transport: ${errMsg(e)}`));
      server.close().catch((e: unknown) => log.debug(`closing an MCP server: ${errMsg(e)}`));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error(`MCP request failed: ${errMsg(err)}`);
      if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal server error'));
    }
  };
  // the agent and MCP clients send no Origin; a browser page of another site must not reach the tools
  app.post('/mcp', rejectCrossSite, handle);
  // stateless: no server-initiated stream (GET) and no session to end (DELETE)
  const notAllowed = (_req: Request, res: Response) => res.status(405).set('Allow', 'POST').json(rpcError(-32000, 'Method not allowed.'));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
