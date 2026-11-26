/**
 * The agent's tools for the web UI: the user can run every tool the agent has, with the same
 * arguments, checks and results, so the agent is optional. Each driver registers its tools under
 * the same names (the Seestar's parity layer), so one route serves both; what differs between them
 * is each tool's argument schema, which GET /api/tools hands the UI so its forms show only the
 * fields this driver's tool takes.
 *
 * The tools run exactly as an MCP request runs them: registered on a fresh collector per call (no
 * tool keeps state in its registration), arguments validated against the tool's own schema, and
 * every command still passes the transports' E-Stop check.
 */
import express, { type Router } from 'express';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpSpec } from '../../drivers/types.js';
import type { Result } from '../../mcp/tools/common.js';
import { badRequest, HttpError, notFound, route } from '../http.js';
import type { WebContext } from '../context.js';
import { ESTOP_MSG } from '../../safety/estop.js';

/** Tools that only make sense for the agent: its duty loop has its own controls, and showing a target in Stellarium is the agent driving this UI. */
const AGENT_ONLY = new Set(['duty', 'show_in_stellarium']);

/**
 * Tools that only read: running them from the UI is not news for an agent on duty. Every other
 * tool run from the UI is told to it (as a GoTo or a stop from the UI is), so it does not act on a
 * telescope it believes is in another state.
 */
const READ_ONLY = new Set([
  'telescope_status',
  'seestar_status',
  'telescope_device_info',
  'motor_position',
  'get_camera_settings',
  'get_settings',
  'stacking_status',
  'list_album',
  'view_image',
  'view_camera',
  'get_image',
  'analyze_image',
  'analyze_subs',
  'list_device_sessions',
  'list_library',
  'jobs',
  'processing_status',
  'sky_conditions',
  'weather_forecast',
  'find_target',
  'search_catalog',
  'object_info',
  'reference_image',
  'target_season',
  'get_mosaic_progress',
  'get_next_mosaic_panel',
  'tunnel_status',
  'zwo_devices',
  'acquisition_plan',
  'journal',
]);

/** A tool as registered: what the agent sees of it, and its handler. */
interface ToolEntry {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (args: unknown) => Promise<Result>;
}

/** Every tool the driver's MCP server registers, collected without a server or a transport. */
export function collectTools(spec: McpSpec): Map<string, ToolEntry> {
  const tools = new Map<string, ToolEntry>();
  const collector = {
    registerTool(name: string, cfg: { description?: string; inputSchema?: z.ZodRawShape }, run: (args: unknown) => Promise<Result>) {
      if (!AGENT_ONLY.has(name)) tools.set(name, { name, description: cfg.description ?? '', shape: cfg.inputSchema ?? {}, run });
    },
  };
  spec.register(collector as unknown as McpServer);
  return tools;
}

/** A tool's arguments as JSON Schema, for the UI's forms (fields, enums, ranges, defaults). */
function argSchema(shape: z.ZodRawShape): unknown {
  try {
    return z.toJSONSchema(z.object(shape), { unrepresentable: 'any', io: 'input' });
  } catch {
    // a schema that cannot be described still runs: the UI then shows no fields for it
    return { type: 'object', properties: {} };
  }
}

/** Paths under captures/ that a tool saved its images to (saveCapture), in the order they appear. */
export function capturePaths(text: string): string[] {
  return [...new Set([...text.matchAll(/captures\/(agent\/[^\s"',)\]]+\.(?:jpe?g|png))/gi)].map((m) => m[1]!))];
}

/** A tool's text as JSON when it is a JSON document (most tools answer with one). */
function asJson(text: string): unknown {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** One line for the agent: which tool the user ran, with its arguments in brief. */
function eventLine(name: string, args: Record<string, unknown>): string {
  const brief = Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
    .slice(0, 200);
  return `the user ran ${name}${brief ? ` (${brief})` : ''} from the web UI`;
}

export function toolRoutes({ tools, duty }: WebContext): Router {
  const api = express.Router();
  const registry = () => {
    if (!tools) throw notFound('this server has no tools for the web UI');
    return collectTools(tools);
  };

  api.get(
    '/tools',
    route(async () => ({
      tools: [...registry().values()].map((t) => ({ name: t.name, description: t.description, schema: argSchema(t.shape), readOnly: READ_ONLY.has(t.name) })),
    })),
  );

  api.post(
    '/tools/:name',
    route(async (req) => {
      const name = String(req.params.name);
      const t = registry().get(name);
      if (!t) throw notFound(`no tool "${name}" on this telescope`);
      const parsed = z.object(t.shape).safeParse(req.body ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw badRequest(issue ? `${issue.path.join('.') || 'arguments'}: ${issue.message}` : 'invalid arguments');
      }
      const args = parsed.data as Record<string, unknown>;
      if (!READ_ONLY.has(name)) duty.event(eventLine(name, args), true);
      const r = await t.run(args);
      const text = r.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const images = capturePaths(text);
      // an image the tool returned without saving it (none do today): sent inline rather than lost
      const inline = images.length ? [] : r.content.filter((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image').map((c) => `data:${c.mimeType};base64,${c.data}`);
      if (r.isError) {
        const msg = text.replace(/^Error:\s*/, '');
        // the E-Stop's refusal keeps its own status, as from every other route
        throw new HttpError(msg.startsWith(ESTOP_MSG) ? 423 : 422, msg);
      }
      return { tool: name, text, json: asJson(text), images: [...images.map((p) => `captures/${p}`), ...inline] };
    }),
  );

  return api;
}
