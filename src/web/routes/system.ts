/** State, the telescope link and address, the duty loop and logs. */
import express, { type Router } from 'express';
import { z } from 'zod';
import { setTelescopeHost, telescopeHostInfo } from '../../config.js';
import { recentLogs } from '../../log.js';
import * as library from '../../library/transfer.js';
import { body, queryNumber, route } from '../http.js';
import { publicConfig, type WebContext } from '../context.js';

const DutyBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    objective: z.string().trim().min(1, 'write the objective'),
    until: z.string().optional(),
    intervalS: z.coerce.number().positive().optional(),
  }),
  z.object({ action: z.enum(['pause', 'resume', 'stop', 'wake']) }),
]);

export function systemRoutes(ctx: WebContext, onHostChanged: () => void): Router {
  const { scope, agent, duty, broadcast } = ctx;
  const api = express.Router();

  api.get('/state', route(async () => ({ telescope: scope.state, agent: agent.status(), duty: duty.status(), jobs: library.listJobs(), config: publicConfig(scope) })));

  // Everything recently exchanged with the telescope (the full log is data/telescope-wire.log).
  api.get(
    '/wire',
    route(async (req) => ({ lines: scope.wireLines?.(Math.max(1, Math.min(400, queryNumber(req, 'n') ?? 200)), { notifications: req.query.notifications !== 'false' }) ?? [] })),
  );

  // Disconnect: free the telescope for another client (its own app) without stopping the container.
  // Closes the control link, the video readers and the stack preview, cancels transfers, and blocks
  // every call to the telescope until Connect.
  api.post(
    '/link',
    route(async (req) => {
      const { connect } = body(req, z.object({ connect: z.boolean().optional() }));
      if (connect) {
        scope.connectLink();
        return { released: false };
      }
      const cancelled = library.cancelActiveJobs();
      scope.release();
      scope.hub.release();
      duty.event('the user released the telescope (Disconnect in the web UI): no telescope commands until they press Connect', true);
      return { released: true, cancelledTransfers: cancelled };
    }),
  );

  // Telescope address (overrides DWARF_HOST / SEESTAR_HOST, persisted in the data folder). Empty = back to .env.
  api.post(
    '/telescope-host',
    route(async (req) => {
      const { host: wanted } = body(req, z.object({ host: z.string().trim().optional() }));
      const before = telescopeHostInfo().host;
      const host = setTelescopeHost(wanted ?? '');
      if (host !== before) {
        onHostChanged();
        scope.setHost(host);
        scope.hub.retarget();
        duty.event(`the user changed the telescope address from ${before} to ${host} in the web UI`, true);
      }
      const cfg = publicConfig(scope);
      broadcast({ type: 'config', config: cfg });
      return cfg;
    }),
  );

  api.get('/duty', route(async () => duty.status()));
  api.post(
    '/duty',
    route(async (req) => {
      const b = body(req, DutyBody);
      switch (b.action) {
        case 'start':
          duty.start({ objective: b.objective, until: b.until || undefined, intervalS: b.intervalS, by: 'user' });
          break;
        case 'pause':
          duty.pause('paused by the user');
          break;
        case 'resume':
          duty.resume();
          break;
        case 'stop':
          duty.stop('user', 'from the web UI');
          break;
        case 'wake':
          duty.wakeNow();
          break;
      }
      return duty.status();
    }),
  );

  api.get('/logs', route(async () => recentLogs(300)));
  return api;
}
