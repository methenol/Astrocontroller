/** The Weather tab: the Rain Guard and the night safety report. */
import express, { type Router } from 'express';
import { config } from '../../config.js';
import * as weather from '../../astro/weather.js';
import { nightSafety } from '../../astro/weather/safety.js';
import { GuardSettingsSchema, type RainGuard } from '../../astro/weather/guard.js';
import { route, body } from '../http.js';
import { unitFormat } from '../../util/units.js';
import { requireSite, type WebContext } from '../context.js';

export function weatherRoutes({ scope }: WebContext, guard: RainGuard): Router {
  const api = express.Router();
  const tz = () => config.observer.timezone;

  api.get(
    '/weather/safety',
    route(async () => {
      const site = requireSite(scope);
      return nightSafety(await weather.forecast(site, tz()), site, tz(), guard.settings, new Date(), unitFormat(config.units));
    }),
  );

  api.get('/guard', route(async () => guard.status()));
  api.post('/guard/arm', route(async () => guard.arm()));
  api.post('/guard/disarm', route(async () => guard.disarm()));
  api.post('/guard/ack', route(async () => guard.acknowledge()));
  api.post('/guard/check', route(async () => guard.check()));
  api.post('/guard/settings', route(async (req) => guard.saveSettings(body(req, GuardSettingsSchema.partial()))));

  return api;
}
