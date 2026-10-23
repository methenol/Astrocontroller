/** Tonight's sky: sun and moon, weather, the target plan, and the object database. */
import express, { type Router } from 'express';
import { z } from 'zod';
import { config, planDefaults } from '../../config.js';
import * as sky from '../../astro/sky.js';
import { planNight } from '../../astro/planner.js';
import { horizonFor } from '../../astro/horizon.js';
import * as rest from '../../astro/rest.js';
import * as weather from '../../astro/weather.js';
import { findObject } from '../../astro/catalog.js';
import { queryCatalog, catalogMeta, objectDetails, type CatalogQuery } from '../../astro/catalog-search.js';
import { notFound, queryNumber, queryString, route, body } from '../http.js';
import { observerSite, requireSite, teleFovArcmin, type WebContext } from '../context.js';

const list = (s: string | undefined) => s?.split(',').map((x) => x.trim()).filter(Boolean);

/** How a user wants a target held back: parked for a while, finished for good, or neither. */
const RestBody = z.object({ name: z.string().min(1), role: z.enum(['snooze', 'done', 'none']) });

/** The integration goal a target must reach before a capture rests it, and how long that rest lasts. */
const RestSettingsBody = z.object({
  integrationTargetMin: z.number().min(0).max(100_000).optional(),
  restDays: z.number().int().min(1).max(3650).optional(),
});

export function skyRoutes({ dwarf }: WebContext): Router {
  const api = express.Router();
  const tz = () => config.observer.timezone;

  api.get(
    '/conditions',
    route(async () => {
      const s = requireSite(dwarf);
      const w = sky.nightWindow(s);
      return {
        sunAltitude: Math.round(sky.bodyAlt(s, 'Sun') * 10) / 10,
        moon: sky.moonState(s),
        night: { sunset: sky.fmtTime(w.sunset, tz()), astroDusk: sky.fmtTime(w.astroDusk, tz()), astroDawn: sky.fmtTime(w.astroDawn, tz()), sunrise: sky.fmtTime(w.sunrise, tz()) },
      };
    }),
  );

  api.get('/weather', route(async () => weather.tonight(requireSite(dwarf), tz())));

  api.get(
    '/plan',
    route(async (req) => {
      const site = requireSite(dwarf);
      const types = list(queryString(req, 'types'));
      const minFovPercent = queryNumber(req, 'minFovPercent');
      const conditions = (await weather.conditionsAt(site, tz())) ?? undefined;
      const plan = planNight(site, { types, minAltitude: config.observer.minAltitudeDeg, minFovPercent, limit: 20, fovArcmin: teleFovArcmin(dwarf), timezone: tz(), conditions, ...planDefaults(), horizon: horizonFor(site) });
      // The tab showing a target is what the memory rotates against, same as an agent plan call:
      // idempotent per night and role, so polling the tab tonight cannot stack penalties on itself.
      rest.recordShown([{ name: plan.hero ?? '', role: 'hero' }, ...plan.targets.slice(0, 5).map((t) => ({ name: t.name, role: 'shortlist' as const }))], sky.localDate(new Date(), tz()));
      return plan;
    }),
  );

  // ---- Target memory: what the app is holding back, and the user's say in it.

  api.get(
    '/rest',
    route(async () => ({ today: sky.localDate(new Date(), tz()), records: rest.loadRest() })),
  );

  api.post(
    '/rest',
    route(async (req) => {
      const b = body(req, RestBody);
      const today = sky.localDate(new Date(), tz());
      const records = b.role === 'none' ? rest.liftRest(b.name) : rest.setRest(b.name, b.role === 'done' ? 'done' : 'snoozed', today);
      return { name: b.name, today, state: rest.restState(b.name, today, records) };
    }),
  );

  api.get('/rest/settings', route(async () => rest.restSettings()));

  api.post(
    '/rest/settings',
    route(async (req) => rest.saveRestSettings(body(req, RestSettingsBody))),
  );

  api.get('/catalog/meta', route(async () => catalogMeta()));

  api.get(
    '/catalog/search',
    route(async (req) => {
      const up = queryString(req, 'up');
      const query: CatalogQuery = {
        q: queryString(req, 'q'),
        types: list(queryString(req, 'types')),
        constellation: queryString(req, 'constellation'),
        catalog: queryString(req, 'catalog'),
        maxMag: queryNumber(req, 'maxMag'),
        minSize: queryNumber(req, 'minSize'),
        maxSize: queryNumber(req, 'maxSize'),
        minFovPercent: queryNumber(req, 'minFovPercent'),
        named: queryString(req, 'named') === '1',
        up: up === 'now' || up === 'tonight' ? up : undefined,
        minAlt: queryNumber(req, 'minAlt') ?? config.observer.minAltitudeDeg,
        minHours: queryNumber(req, 'minHours'),
        sort: queryString(req, 'sort') as CatalogQuery['sort'],
        offset: queryNumber(req, 'offset'),
        limit: queryNumber(req, 'limit'),
      };
      return queryCatalog(query, observerSite(dwarf), tz(), { teleFovWidthArcmin: teleFovArcmin(dwarf).w });
    }),
  );

  api.get(
    '/catalog/object',
    route(async (req) => {
      const id = queryString(req, 'id') ?? '';
      const o = findObject(id);
      if (!o) throw notFound(`"${id}" is not in the database`);
      return objectDetails(o, observerSite(dwarf), tz(), { minAlt: config.observer.minAltitudeDeg, fovArcmin: teleFovArcmin(dwarf) });
    }),
  );

  return api;
}
