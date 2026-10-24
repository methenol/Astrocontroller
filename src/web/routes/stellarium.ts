/**
 * The Gaia star survey for the Stellarium tab, when STELLARIUM_STREAM is on. data.stellarium.org's
 * properties file for it lacks the `type = stars` line this engine build needs to read it as stars,
 * so the properties are served here and the tiles are redirected to the data server (CORS allows any
 * origin there, so the browser fetches them directly).
 */
import express, { type Router } from 'express';
import { config } from '../../config.js';
import { notFound, route } from '../http.js';

/** data.stellarium.org/surveys/gaia/properties (2018-08-28), plus the line the engine needs. */
export const GAIA_PROPERTIES = ['hips_order_min = 3', 'hips_release_date = 2018-08-28T08:10Z', 'hips_tile_format = eph', 'type = stars', ''].join('\n');
/** Only HiPS tile paths are redirected: this is not an open redirect to any path on the data server. */
export const GAIA_TILE = /^Norder\d{1,2}\/(?:Dir\d{1,9}\/Npix\d{1,12}|Allsky)\.eph$/;
const TILE_CACHE = 'public, max-age=86400';

export function stellariumRoutes(): Router {
  const api = express.Router();

  api.get('/stellarium/gaia/properties', (_req, res) => {
    if (!config.stellarium.stream) return void res.status(404).json({ error: 'streaming is off (STELLARIUM_STREAM)' });
    res.type('text/plain').set('Cache-Control', TILE_CACHE).send(GAIA_PROPERTIES);
  });

  api.get(
    '/stellarium/gaia/*tile',
    route(async (req, res) => {
      const tile = ([] as string[]).concat(req.params.tile as string | string[]).join('/');
      if (!config.stellarium.stream || !GAIA_TILE.test(tile)) throw notFound(`no such Gaia tile: ${tile}`);
      const q = req.originalUrl.indexOf('?');
      res.set('Cache-Control', TILE_CACHE).redirect(302, `${config.stellarium.dataUrl.replace(/\/+$/, '')}/surveys/gaia/${tile}${q >= 0 ? req.originalUrl.slice(q) : ''}`);
      return undefined;
    }),
  );

  return api;
}
