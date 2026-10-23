/**
 * The ZWO Seestar driver: the device (control link, image sockets, and the ZWO Telescope Network
 * tunnel when SEESTAR_CONNECTION=zwo), its MCP tools and its web page.
 *
 * The Dwarf-only services (duty loop, travel guard, stack supervisor, charge watch, live streams)
 * are not part of this driver: they speak the Dwarf's protocol.
 */
import type http from 'node:http';
import type { Express } from 'express';
import { config } from '../../config.js';
import type { DriverDeps, DriverRuntime, TelescopeDriver } from '../types.js';
import { Seestar } from './device.js';
import { seestarMcpSpec } from './mcp.js';
import { mountSeestarWeb } from './web.js';

function create({ agent }: DriverDeps): DriverRuntime {
  const scope = new Seestar();
  return {
    device: scope,
    mcp: seestarMcpSpec(scope),
    mountWeb: (app: Express, server: http.Server) => mountSeestarWeb(app, server, { scope, agent }),
    start: () => scope.start(),
    shutdownSteps: () => [['telescope link', () => scope.stop()]],
    describeTarget: () => {
      const s = config.seestar;
      return s.connection === 'zwo' ? `Seestar via ZWO Telescope Network (tunnel at ${s.host}:${s.rpcPort})` : `Seestar at ${s.host}:${s.rpcPort}`;
    },
  };
}

export const seestarDriver: TelescopeDriver = { id: 'seestar', label: 'ZWO Seestar', create };
