import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type ToolContext } from './tools.js';
import { logger, errMsg } from '../log.js';

const log = logger('mcp');

const INSTRUCTIONS = `Tools for a DWARFLAB Dwarf 3 smart telescope (two cameras: tele 150mm f/4.3 with VIS/Astro/Duo-Band filters, and wide 6.7mm).
Start with telescope_status. Motors must be homed after power-on (motors_home). Long operations (calibrate, goto_target, polar_alignment, autofocus astro, motors_home, move_motors) block until the telescope reports them finished. Background work (dark masters, transfers, processing, a stack the scope ends itself) is reported to the agent by Astrocontroller as an event when it ends.
Coordinates are J2000. Never point at the Sun without the user confirming a solar filter.`;

export function mountMcp(app: Express, ctx: ToolContext): void {
  const handle = async (req: Request, res: Response) => {
    const server = new McpServer({ name: 'dwarf3', version: '0.1.0' }, { instructions: INSTRUCTIONS });
    registerTools(server, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error(`MCP request failed: ${errMsg(err)}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  };
  app.post('/mcp', handle);
  app.get('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
}
