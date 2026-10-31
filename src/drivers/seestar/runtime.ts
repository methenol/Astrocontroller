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

function create({ agent }: DriverDeps): DriverRuntime {
  const scope = new Seestar();
  const duty = new DutyLoop(seestarDuty(scope), agent);
  const media = seestarMedia(scope);
  setDeviceLibrary(media.storage);
  // Starfront's autonomous nights: only with STARFRONT_REMOTE_ZWO on a scope over ZWO Telescope Network
  const nights = config.starfront.available
    ? new StarfrontNights({
        duty,
        site: () => scope.requireLocation(),
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
  const web = seestarWeb(scope, media, nights);
  return {
    device: scope,
    mcp: seestarMcpSpec(scope, duty, media, nights),
    mountWeb: (app: Express, server: http.Server) => mountWeb(app, server, { scope: web, agent, duty }),
    start: () => {
      scope.start();
      nights?.start();
    },
    shutdownSteps: () => [
      ['transfers', () => void cancelActiveJobs()],
      ['starfront', () => nights?.stop()],
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
