/** The site's obstruction map for the Tonight tab: status, the survey (started in the background), clear, import and export. */
import express, { type Router } from 'express';
import { estop } from '../../safety/estop.js';
import { z } from 'zod';
import { errMsg, logger } from '../../log.js';
import { clearMasks, describeMask, maskFor, newMaskId, parseHorizonText, saveMask, toHorizonText, unknownSectors } from '../../astro/horizon.js';
import { evidencePathOf, listSurveys, resolveSurvey, surveyIdOf } from '../../media/horizon/solve.js';
import { body, notFound, route } from '../http.js';
import { unsupported } from '../telescope.js';
import { requireSite, type WebContext } from '../context.js';

const log = logger('horizon');

const SurveyBody = z.object({ calibrate: z.boolean().optional(), rehearsal: z.boolean().optional() });
const ImportBody = z.object({ text: z.string().min(1).max(200_000) });
const ResolveBody = z.object({ id: z.string().regex(/^[\w.-]+$/).optional(), marginDeg: z.number().min(0).max(10).optional() });

export function horizonRoutes({ scope, duty }: WebContext): Router {
  const api = express.Router();

  api.get(
    '/horizon',
    route(async () => {
      const m = maskFor(requireSite(scope));
      const ev = m ? evidencePathOf(m) : null;
      return {
        mask: m
          ? { ...m, summary: describeMask(m), notObserved: unknownSectors(m), panoramaUrl: m.survey?.panorama ? `/captures/${m.survey.panorama}` : null, evidenceUrl: ev ? `/captures/${ev}` : null, surveyId: surveyIdOf(m) }
          : null,
        survey: scope.state.horizonSurvey ?? null,
      };
    }),
  );

  // Runs for 15–25 min: answered as soon as it starts (or refuses); progress arrives over the state socket.
  api.post(
    '/horizon/survey',
    route(async (req) => {
      const b = body(req, SurveyBody);
      const survey = scope.horizonSurvey;
      if (!survey) throw unsupported(scope, 'The obstruction survey');
      if (b.rehearsal && scope.driver !== 'seestar') throw unsupported(scope, 'A survey rehearsal');
      estop.assertClear();
      survey.assertAllowed({ rehearsal: b.rehearsal });
      duty.event('the user started the obstruction survey (map_obstructions) from the web UI: the scope pans all round for ~20 min', true);
      survey.start({ calibrate: b.calibrate, rehearsal: b.rehearsal }).then(
        (r) => duty.event(`the obstruction survey finished: ${r.summary}`, true),
        (e) => {
          log.warn(`obstruction survey failed: ${errMsg(e)}`);
          duty.event(`the obstruction survey started from the web UI failed: ${errMsg(e)}`, true);
        },
      );
      return { started: true };
    }),
  );

  // Solve a kept survey again (the newest of this site's when no id) with the current evidence: no telescope needed.
  api.post(
    '/horizon/resolve',
    route(async (req) => {
      const b = body(req, ResolveBody);
      const here = maskFor(requireSite(scope));
      const id = b.id ?? (here ? surveyIdOf(here) : null) ?? listSurveys()[0]?.id;
      if (!id) throw notFound('no survey has kept its frames yet (surveys from 2026-11-04 on do)');
      const r = await resolveSurvey(id, { marginDeg: b.marginDeg });
      duty.event(`the obstruction map was solved again from survey ${id}'s kept frames: ${r.summary}`, true);
      return { summary: r.summary, notes: r.notes, maskId: r.mask.id };
    }),
  );

  api.get(
    '/horizon/surveys',
    route(async () => ({ surveys: listSurveys() })),
  );

  api.post(
    '/horizon/stop',
    route(async () => {
      if (!scope.horizonSurvey) throw unsupported(scope, 'The obstruction survey');
      return { stopping: await scope.horizonSurvey.stop() };
    }),
  );

  api.delete(
    '/horizon',
    route(async () => ({ cleared: clearMasks(requireSite(scope)) })),
  );

  api.post(
    '/horizon/import',
    route(async (req) => {
      const b = body(req, ImportBody);
      const s = requireSite(scope);
      const m = saveMask({ id: newMaskId(), site: { lat: s.lat, lon: s.lon }, createdAt: new Date().toISOString(), source: 'import', profile: parseHorizonText(b.text) });
      return { summary: describeMask(m) };
    }),
  );

  api.get(
    '/horizon/export',
    route(async (_req, res) => {
      const m = maskFor(requireSite(scope));
      if (!m) throw notFound('this site has no obstruction map');
      res.type('text/plain').attachment(`horizon-${m.createdAt.slice(0, 10)}.hrz`).send(toHorizonText(m));
    }),
  );

  return api;
}
