/**
 * The ZWO Seestar driver: the device (control link, image sockets, and the ZWO Telescope Network
 * tunnel when SEESTAR_CONNECTION=zwo), its MCP tools, the shared web UI through its adapter, its
 * live views and the duty loop.
 *
 * Its storage (sessions, album, transfers into the library) is registered for the library at
 * creation (storage.ts).
 */
import type http from 'node:http';
import type { Express } from 'express';
import { config } from '../../config.js';
import { DutyLoop } from '../../agent/duty.js';
import { setDeviceLibrary } from '../../library/device-library.js';
import { cancelActiveJobs, listDeviceSessions, transferSession } from '../../library/transfer.js';
import { StarfrontNights } from '../../agent/starfront.js';
import { mountWeb } from '../../web/server.js';
import type { DriverDeps, DriverRuntime, TelescopeDriver } from '../types.js';
import { Seestar } from './device.js';
import { seestarDuty } from './duty.js';
import { seestarMcpSpec } from './mcp.js';
import { seestarMedia, seestarWeb } from './web.js';
import { seestarProbe } from './journal.js';
import { createNight, withNightPlan, type NightServices } from '../../night/index.js';
import { NOMINAL_FOV } from './focus.js';
import { seestarFacts } from './acquisition.js';

function create({ agent }: DriverDeps): DriverRuntime {
  const scope = new Seestar();
  // the night plan's lines go into every duty sample; the plan needs the duty (it starts the nightly one), so it is bound late
  let night: NightServices | null = null;
  // on autonomous nights the agent keeps being woken while the scope is released: it connects it again itself
  const duty: DutyLoop = new DutyLoop(withNightPlan(seestarDuty(scope, { autonomous: (): boolean => !!nights?.enabled }), () => night), agent);
  const media = seestarMedia(scope);
  setDeviceLibrary(media.storage);
  // Starfront's autonomous nights: only with STARFRONT_REMOTE_ZWO on a scope over ZWO Telescope Network
  const nights: StarfrontNights | null = config.starfront.available
    ? new StarfrontNights({
        duty,
        site: () => scope.requireLocation(),
        planStart: () => {
          try {
            return night?.plan.currentNight().window.start.getTime() ?? null;
          } catch {
            return null;
          }
        },
        stacking: {
          on: (e, f) => scope.on(e, f),
          off: (e, f) => scope.off(e, f),
          current: () => ({ stacking: scope.isStacking(), target: scope.state.view.target }),
        },
        transferTarget: async (target) => {
          const { sessions } = await listDeviceSessions(false);
          const todo = sessions.filter((s) => s.target === target && !s.transferred);
          for (const s of todo) await transferSession(s.folder, { includeSubframes: true, includeCalibration: true, origin: 'agent' });
          return todo.length ? `${todo.length} session(s) queued (${todo.map((s) => s.folder).join(', ')})` : 'nothing left to transfer';
        },
      })
    : null;
  night = createNight({
    site: () => scope.location(),
    fovArcmin: () => {
      const f = scope.state.fov ?? NOMINAL_FOV;
      return { w: f.h * 60, h: f.v * 60 };
    },
    probe: seestarProbe(scope),
    duty,
    facts: seestarFacts(scope),
    nightsEnabled: () => !!nights?.status().enabled,
  });
  const web = seestarWeb(scope, media, nights);
  return {
    device: scope,
    mcp: seestarMcpSpec(scope, duty, media, nights, night),
    mountWeb: (app: Express, server: http.Server) => mountWeb(app, server, { scope: web, agent, duty, night }),
    start: () => {
      scope.start();
      nights?.start();
      night?.start();
    },
    shutdownSteps: () => [
      ['transfers', () => void cancelActiveJobs()],
      ['starfront', () => nights?.stop()],
      ['night plan', () => night?.stop()],
      ['timelapse', () => media.capture.stop()],
      ['survey', () => void media.survey.stop()],
      ['streams', () => media.hub.shutdown()],
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
