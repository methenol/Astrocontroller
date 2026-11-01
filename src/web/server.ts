/** The web UI: its REST API under /api, live streams, captures, the static app and the sockets. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import express, { type Express } from 'express';
import { config } from '../config.js';
import { logger } from '../log.js';
import type { WebContext } from './context.js';
import { rejectCrossSite } from './http.js';
import { mountSockets } from './sockets.js';
import { systemRoutes } from './routes/system.js';
import { skyRoutes } from './routes/sky.js';
import { horizonRoutes } from './routes/horizon.js';
import { mediaRoutes, streamRoute, ThumbCache } from './routes/media.js';
import { controlRoutes } from './routes/control.js';
import { agentRoutes } from './routes/agent.js';
import { stellariumRoutes } from './routes/stellarium.js';
import { weatherRoutes } from './routes/weather.js';
import { nightRoutes } from './routes/night.js';
import { RainGuard } from '../astro/weather/guard.js';
import { observerSite } from './context.js';

const log = logger('web');

/** The markdown renderer the chat uses, found from this file (dist/web) rather than the working directory. */
const MARKED = fileURLToPath(new URL('../../node_modules/marked/lib/marked.umd.js', import.meta.url));

export interface Web {
  /** Close the sockets and detach every listener (on shutdown). */
  close(): void;
}

export function mountWeb(app: Express, server: http.Server, deps: Omit<WebContext, 'broadcast'>): Web {
  // The Rain Guard lives with the server, not a browser tab: it keeps watching when no page is open.
  const guard = new RainGuard({ site: () => observerSite(deps.scope), tz: () => config.observer.timezone, units: () => config.units, file: path.join(config.paths.data, 'rain-guard.json') });
  const sockets = mountSockets(server, deps, guard);
  const ctx: WebContext = { ...deps, broadcast: sockets.broadcast };
  const thumbs = new ThumbCache();
  guard.start();

  const api = express.Router();
  api.use(rejectCrossSite);
  api.use(systemRoutes(ctx, () => thumbs.clear()));
  api.use(skyRoutes(ctx));
  api.use(horizonRoutes(ctx));
  api.use(mediaRoutes(ctx, thumbs));
  api.use(controlRoutes(ctx));
  api.use(agentRoutes(ctx));
  api.use(stellariumRoutes());
  api.use(weatherRoutes(ctx, guard));
  api.use(nightRoutes(ctx));
  // the driver's own API (the Seestar's tunnel and raw RPC)
  if (deps.scope.routes) api.use(deps.scope.routes());
  api.use((req, res) => res.status(404).json({ error: `no such API route: ${req.method} ${req.path}` }));

  app.get('/stream/:name', streamRoute(ctx));
  app.use('/captures', express.static(config.paths.captures, { maxAge: '1h' }));
  app.use('/api', api);
  app.get('/vendor/marked.js', (_req, res) => res.sendFile(MARKED));

  // index.html with asset URLs versioned by process start, so browsers pick up new builds.
  const bootId = Date.now().toString(36);
  const indexFile = path.join(config.paths.public, 'index.html');
  app.get(['/', '/index.html'], (_req, res) => {
    const html = fs.readFileSync(indexFile, 'utf8').replace(/(href="style\.css|src="js\/main\.js)"/g, `$1?v=${bootId}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  app.use(express.static(config.paths.public, { index: false }));

  log.debug('web routes mounted');
  return {
    close: () => {
      guard.close();
      sockets.close();
    },
  };
}
