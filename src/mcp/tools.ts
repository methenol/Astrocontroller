/**
 * The agent's tools, registered on one MCP server. Each area lives in its own module under
 * ./tools/; this only puts them together.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAstroTools } from './tools/astro.js';
import { registerCameraTools } from './tools/camera.js';
import { makeTool, type ToolContext } from './tools/common.js';
import { registerDarkTools } from './tools/darks.js';
import { registerDutyTools } from './tools/duty.js';
import { registerHorizonTools } from './tools/horizon.js';
import { registerLibraryTools } from './tools/library.js';
import { registerMediaTools } from './tools/media.js';
import { registerMotionTools } from './tools/motion.js';
import { registerPlanningTools } from './tools/planning.js';
import { registerSystemTools } from './tools/system.js';

export { toolEvents, type ToolContext } from './tools/common.js';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const tool = makeTool(server);
  registerSystemTools(tool, ctx);
  registerCameraTools(tool, ctx);
  registerMotionTools(tool, ctx);
  registerPlanningTools(tool, ctx);
  registerHorizonTools(tool, ctx);
  registerAstroTools(tool, ctx);
  registerMediaTools(tool, ctx);
  registerLibraryTools(tool);
  registerDarkTools(tool, ctx);
  registerDutyTools(tool, ctx);
}
