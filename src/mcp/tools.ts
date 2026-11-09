/**
 * The agent's tools, registered on one MCP server. Each area lives in its own module under
 * ./tools/; this only puts them together.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAcquisitionTools } from './tools/acquisition.js';
import { registerAstroTools } from './tools/astro.js';
import { registerCameraTools } from './tools/camera.js';
import { makeTool, type ToolContext } from './tools/common.js';
import { registerDarkTools } from './tools/darks.js';
import { registerDutyTools } from './tools/duty.js';
import { registerHorizonTools } from './tools/horizon.js';
import { registerLibraryTools } from './tools/library.js';
import { registerMediaTools } from './tools/media.js';
import { registerMotionTools } from './tools/motion.js';
import { registerMosaicTools } from './tools/mosaic.js';
import { registerNightTools } from './tools/night.js';
import { DEFAULT_TELE_FOV, registerPlanningTools } from './tools/planning.js';
import { registerResearchTools } from './tools/research.js';
import { registerStellariumTools } from './tools/stellarium.js';
import { registerSystemTools } from './tools/system.js';
import { dwarfDarkFrames, dwarfFacts, dwarfSessionSubs } from '../drivers/dwarf/acquisition.js';

export { toolEvents, type ToolContext } from './tools/common.js';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const tool = makeTool(server);
  registerSystemTools(tool, ctx);
  registerCameraTools(tool, ctx);
  registerMotionTools(tool, ctx);
  registerPlanningTools(tool, { site: () => ctx.dwarf.requireLocation(), teleFov: () => ctx.dwarf.state.fov.tele ?? null, dwarf: ctx.dwarf, hub: ctx.hub, restChanged: () => ctx.night?.plan.changed('the target memory changed') });
  registerHorizonTools(tool, ctx);
  registerAstroTools(tool, ctx);
  registerMediaTools(tool, ctx);
  registerLibraryTools(tool);
  registerDarkTools(tool, ctx);
  registerDutyTools(tool, ctx);
  if (ctx.night) {
    registerNightTools(tool, ctx.night);
    registerMosaicTools(tool, ctx.night, {
      field: () => {
        const f = ctx.dwarf.state.fov.tele ?? DEFAULT_TELE_FOV;
        return { w: f.h * 60, h: f.v * 60 };
      },
      facts: dwarfFacts(ctx.dwarf),
      startNative: async (project, native) => {
        const w = native.wireScale ?? 1;
        await ctx.dwarf.gotoRaDec(project.footprint.raHours, project.footprint.decDeg, project.gotoName, true);
        await ctx.dwarf.startMosaic({ horizontalScale: Math.round(project.nativeScale!.x * w), verticalScale: Math.round(project.nativeScale!.y * w), rotation: Math.round(project.footprint.angleDeg) });
        return 'the Dwarf started its own mosaic';
      },
    });
  }
  registerStellariumTools(tool);
  registerResearchTools(tool, { fov: () => ctx.dwarf.state.fov.tele ?? DEFAULT_TELE_FOV, site: () => ctx.dwarf.requireLocation() });
  registerAcquisitionTools(tool, { site: () => ctx.dwarf.requireLocation(), facts: dwarfFacts(ctx.dwarf), night: ctx.night, sessionSubs: dwarfSessionSubs, darkFrames: dwarfDarkFrames });
}
