/**
 * The driver registry. Each driver is imported only when it is the one selected, so a Dwarf run
 * never loads the Seestar code and the other way round.
 */
import type { DriverId, TelescopeDriver } from './types.js';

export type { DriverId, DriverRuntime, TelescopeDevice, TelescopeDriver, McpSpec } from './types.js';
export { DRIVER_IDS } from './types.js';

/** The MCP server name each driver registers: the agent sees its tools as mcp__<name>__<tool>. */
export const MCP_SERVER_NAMES: Readonly<Record<DriverId, string>> = { dwarf: 'dwarf3', seestar: 'seestar' };

export async function loadDriver(id: DriverId): Promise<TelescopeDriver> {
  switch (id) {
    case 'dwarf':
      return (await import('./dwarf/runtime.js')).dwarfDriver;
    case 'seestar':
      return (await import('./seestar/runtime.js')).seestarDriver;
  }
}
