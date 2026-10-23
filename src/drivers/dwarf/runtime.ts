/**
 * The DWARFLAB Dwarf 3 driver: the device, its live streams, its MCP tools and web UI, and the
 * services that watch over a night with it (duty loop, travel guard, stack supervisor, charge watch).
 */
import type http from 'node:http';
import type { Express } from 'express';
import { config } from '../../config.js';
import { Dwarf } from './device.js';
import { StreamHub } from '../../media/streams.js';
import { dwarfMcpSpec } from '../../mcp/server.js';
import { mountWeb } from '../../web/server.js';
import { watchCharging, type ChargeWatch } from '../../agent/charge-watch.js';
import { DutyLoop } from '../../agent/duty.js';
import { clock } from '../../agent/duty/time.js';
import { TravelGuard } from './travel-guard.js';
import { StackSupervisor } from './stack-supervisor.js';
import { cancelActiveJobs } from '../../library/transfer.js';
import { flushWire } from './wirelog.js';
import type { DriverDeps, DriverRuntime, TelescopeDriver } from '../types.js';

function create({ agent }: DriverDeps): DriverRuntime {
  const dwarf = new Dwarf();
  const hub = new StreamHub(dwarf);
  const duty = new DutyLoop(dwarf, agent);
  const travelGuard = new TravelGuard(dwarf, (t) => duty.event(t));
  const stackSupervisor = new StackSupervisor(dwarf, (t) => duty.event(t), { autoStopAfterMs: config.dwarf.stackAutoStopMin * 60_000, clock: (t) => clock(t) });
  duty.stackSupervisor = stackSupervisor;
  let chargeWatch: ChargeWatch | null = null;

  return {
    device: dwarf,
    mcp: dwarfMcpSpec({ dwarf, hub, duty }),
    mountWeb: (app: Express, server: http.Server) => mountWeb(app, server, { dwarf, hub, agent, duty }),
    start() {
      dwarf.start();
      travelGuard.start();
      stackSupervisor.start();
      if (config.agent.enabled) chargeWatch = watchCharging(dwarf, agent);
    },
    shutdownSteps: () => [
      ['transfers', () => void cancelActiveJobs()],
      ['streams', () => hub.shutdown()],
      ['charge watch', () => chargeWatch?.stop()],
      ['duty', () => duty.dispose()],
      ['travel guard', () => travelGuard.stop()],
      ['stack supervisor', () => stackSupervisor.stop()],
      ['telescope link', () => dwarf.stop()],
      ['wire log', () => flushWire()],
    ],
    describeTarget: () => `Dwarf 3 at ${config.dwarf.host}`,
  };
}

export const dwarfDriver: TelescopeDriver = { id: 'dwarf', label: 'DWARFLAB Dwarf 3', create };
