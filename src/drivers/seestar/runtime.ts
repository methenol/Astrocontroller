/**
 * The ZWO Seestar driver: the device (control link, image sockets, and the ZWO Telescope Network
 * tunnel when SEESTAR_CONNECTION=zwo), its MCP tools, the shared web UI through its adapter, its
 * live views and the duty loop.
 *
 * The Dwarf's own services (travel guard, stack supervisor, charge watch) speak the Dwarf's
 * protocol and are not part of this driver.
 */
import type http from 'node:http';
import type { Express } from 'express';
import { config } from '../../config.js';
import { DutyLoop } from '../../agent/duty.js';
import { mountWeb } from '../../web/server.js';
import type { DriverDeps, DriverRuntime, TelescopeDriver } from '../types.js';
import { Seestar } from './device.js';
import { seestarDuty } from './duty.js';
import { seestarMcpSpec } from './mcp.js';
import { seestarWeb } from './web.js';

function create({ agent }: DriverDeps): DriverRuntime {
  const scope = new Seestar();
  const duty = new DutyLoop(seestarDuty(scope), agent);
  const web = seestarWeb(scope);
  return {
    device: scope,
    mcp: seestarMcpSpec(scope, duty),
    mountWeb: (app: Express, server: http.Server) => mountWeb(app, server, { scope: web, agent, duty }),
    start: () => scope.start(),
    shutdownSteps: () => [
      ['streams', () => web.hub.shutdown()],
      ['duty', () => duty.dispose()],
      ['telescope link', () => scope.stop()],
    ],
    describeTarget: () => {
      const s = config.seestar;
      return s.connection === 'zwo' ? `Seestar via ZWO Telescope Network (tunnel at ${s.host}:${s.rpcPort})` : `Seestar at ${s.host}:${s.rpcPort}`;
    },
  };
}

export const seestarDriver: TelescopeDriver = { id: 'seestar', label: 'ZWO Seestar', create };
