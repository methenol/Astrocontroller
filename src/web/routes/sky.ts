/** Tonight's sky: sun and moon, weather, the target plan, and the object database. */
import express, { type Router } from 'express';
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';
import { planNight } from '../../astro/planner.js';
import * as weather from '../../astro/weather.js';
import { findObject } from '../../astro/catalog.js';
import { queryCatalog, catalogMeta, objectDetails, type CatalogQuery } from '../../astro/catalog-search.js';
import { notFound, queryNumber, queryString, route } from '../http.js';
import { observerSite, requireSite, teleFovArcmin, type WebContext } from '../context.js';

/** A comma-separated query value as a list, without the empty items a trailing comma leaves. */
const list = (s: string | undefined) => s?.split(',').map((x) => x.trim()).filter(Boolean);

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
      const observability = (await weather.observabilityAt(site, tz())) ?? undefined;
      return planNight(site, { types, minAltitude: config.observer.minAltitudeDeg, minFovPercent, limit: 20, fovArcmin: teleFovArcmin(dwarf), timezone: tz(), observability });
    }),
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
