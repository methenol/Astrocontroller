/** The E-Stop button: engage it (halting whatever runs) and Enable Control. */
import express, { type Router } from 'express';
import { z } from 'zod';
import { errMsg, logger } from '../../log.js';
import { cancelActiveJobs } from '../../library/transfer.js';
import { estop } from '../../safety/estop.js';
import { body, route } from '../http.js';
import type { WebContext } from '../context.js';

const log = logger('estop');

/** The press is answered after this long even if a stop command has not finished. */
const HALT_ANSWER_MS = 15_000;

/** Lock control out first, so nothing new starts while the stop commands go out. */
async function engage({ scope, agent, duty }: WebContext): Promise<void> {
  if (!estop.engage('user')) return;
  log.warn('E-Stop engaged: halting the telescope, control locked out until Enable Control');
  const halt = estop.runHalt(() => scope.emergencyHalt()).catch((e): string[] => [errMsg(e)]);
  duty.pause('E-Stop');
  cancelActiveJobs();
  void agent.abort().catch((e) => log.debug(`aborting the agent: ${errMsg(e)}`));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve(['the stop commands had not finished after 15 s']), HALT_ANSWER_MS);
  });
  const failed = await Promise.race([halt, late]);
  clearTimeout(timer);
  if (failed.length) log.error(`E-Stop: could not confirm: ${failed.join('; ')}`);
  estop.haltFinished(failed);
}

export function estopRoutes(ctx: WebContext): Router {
  const api = express.Router();
  api.get('/estop', route(async () => estop.status()));
  api.post(
    '/estop',
    route(async (req) => {
      const { engaged } = body(req, z.object({ engaged: z.boolean() }));
      if (engaged) await engage(ctx);
      else if (estop.engaged) {
        estop.reset();
        log.warn('E-Stop cleared: control enabled by the user');
      }
      return estop.status();
    }),
  );
  return api;
}
