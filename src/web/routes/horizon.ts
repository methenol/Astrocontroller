/** The site's obstruction map for the Tonight tab: status, the survey (started in the background), clear, import and export. */
import express, { type Router } from 'express';
import { z } from 'zod';
import { errMsg, logger } from '../../log.js';
import { clearMasks, describeMask, maskFor, newMaskId, parseHorizonText, saveMask, toHorizonText, unknownSectors } from '../../astro/horizon.js';
import { assertSurveyAllowed, stopSurvey, surveyObstructions } from '../../media/horizon/survey.js';
import { body, notFound, route } from '../http.js';
import { requireSite, type WebContext } from '../context.js';

const log = logger('horizon');

const SurveyBody = z.object({ calibrate: z.boolean().optional() });
const ImportBody = z.object({ text: z.string().min(1).max(200_000) });

export function horizonRoutes({ dwarf, hub, duty }: WebContext): Router {
  const api = express.Router();

  api.get(
    '/horizon',
    route(async () => {
      const m = maskFor(requireSite(dwarf));
      return {
        mask: m ? { ...m, summary: describeMask(m), notObserved: unknownSectors(m), panoramaUrl: m.survey?.panorama ? `/captures/${m.survey.panorama}` : null } : null,
        survey: dwarf.state.horizonSurvey ?? null,
      };
    }),
  );

  // Runs for 15–25 min: answered as soon as it starts (or refuses); progress arrives over the state socket.
  api.post(
    '/horizon/survey',
    route(async (req) => {
      const b = body(req, SurveyBody);
      assertSurveyAllowed(dwarf);
      duty.event('the user started the obstruction survey (map_obstructions) from the web UI: the scope pans all round for ~20 min', true);
      surveyObstructions({ dwarf, hub }, { calibrate: b.calibrate }).then(
        (r) => duty.event(`the obstruction survey finished: ${r.summary}`, true),
        (e) => {
          log.warn(`obstruction survey failed: ${errMsg(e)}`);
          duty.event(`the obstruction survey started from the web UI failed: ${errMsg(e)}`, true);
        },
      );
      return { started: true };
    }),
  );

  api.post(
    '/horizon/stop',
    route(async () => ({ stopping: await stopSurvey(dwarf) })),
  );

  api.delete(
    '/horizon',
    route(async () => ({ cleared: clearMasks(requireSite(dwarf)) })),
  );

  api.post(
    '/horizon/import',
    route(async (req) => {
      const b = body(req, ImportBody);
      const s = requireSite(dwarf);
      const m = saveMask({ id: newMaskId(), site: { lat: s.lat, lon: s.lon }, createdAt: new Date().toISOString(), source: 'import', profile: parseHorizonText(b.text) });
      return { summary: describeMask(m) };
    }),
  );

  api.get(
    '/horizon/export',
    route(async (_req, res) => {
      const m = maskFor(requireSite(dwarf));
      if (!m) throw notFound('this site has no obstruction map');
      res.type('text/plain').attachment(`horizon-${m.createdAt.slice(0, 10)}.hrz`).send(toHorizonText(m));
    }),
  );

  return api;
}
