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
import { dwarfWeb } from './web.js';
import { watchCharging, type ChargeWatch } from '../../agent/charge-watch.js';
import { DutyLoop } from '../../agent/duty.js';
import { clock } from '../../agent/duty/time.js';
import { TravelGuard } from './travel-guard.js';
import { StackSupervisor } from './stack-supervisor.js';
import { cancelActiveJobs } from '../../library/transfer.js';
import { flushWire } from './wirelog.js';
import { dwarfDuty } from './duty.js';
import type { DriverDeps, DriverRuntime, TelescopeDriver } from '../types.js';
import { createNight, withNightPlan, type NightServices } from '../../night/index.js';
import { dwarfProbe } from './journal.js';
import { dwarfFacts } from './acquisition.js';

function create({ agent }: DriverDeps): DriverRuntime {
  const dwarf = new Dwarf();
  const hub = new StreamHub(dwarf);
  const dutyScope = dwarfDuty(dwarf);
  let night: NightServices | null = null;
  const duty = new DutyLoop(withNightPlan(dutyScope, () => night), agent);
  const travelGuard = new TravelGuard(dwarf, (t) => duty.event(t));
  const stackSupervisor = new StackSupervisor(dwarf, (t) => duty.event(t), { autoStopAfterMs: config.dwarf.stackAutoStopMin * 60_000, clock: (t) => clock(t) });
  dutyScope.stackSupervisor = stackSupervisor;
  let chargeWatch: ChargeWatch | null = null;
  night = createNight({
    site: () => dwarf.location(),
    fovArcmin: () => {
      const f = dwarf.state.fov.tele ?? { h: 2.95, v: 1.66 };
      return { w: f.h * 60, h: f.v * 60 };
    },
    probe: dwarfProbe(dwarf, hub),
    duty,
    facts: dwarfFacts(dwarf),
  });

  return {
    device: dwarf,
    mcp: dwarfMcpSpec({ dwarf, hub, duty, night }),
    mountWeb: (app: Express, server: http.Server) => mountWeb(app, server, { scope: dwarfWeb(dwarf, hub), agent, duty, night }),
    start() {
      dwarf.start();
      travelGuard.start();
      stackSupervisor.start();
      night?.start();
      if (config.agent.enabled) chargeWatch = watchCharging(dwarf, agent);
    },
    shutdownSteps: () => [
      ['transfers', () => void cancelActiveJobs()],
      ['streams', () => hub.shutdown()],
      ['charge watch', () => chargeWatch?.stop()],
      ['night plan', () => night?.stop()],
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
