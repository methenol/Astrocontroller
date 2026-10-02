import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { logger, errMsg } from './log.js';
import { Dwarf } from './dwarf/device.js';
import { StreamHub } from './media/streams.js';
import { mountMcp } from './mcp/server.js';
import { mountWeb } from './web/server.js';
import { AgentBridge } from './agent/omp.js';
import { catalog } from './astro/catalog.js';

const log = logger('main');

for (const dir of [config.paths.data, config.paths.library, config.paths.captures, config.paths.workspace, config.paths.sessions, config.paths.home]) {
  fs.mkdirSync(dir, { recursive: true });
}

const dwarf = new Dwarf();
const hub = new StreamHub(dwarf);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '60mb' }));

mountMcp(app, { dwarf, hub });

const server = http.createServer(app);
const agent = new AgentBridge();
mountWeb(app, server, { dwarf, hub, agent });

server.listen(config.web.port, () => {
  log.info(`Astrocontroller on http://0.0.0.0:${config.web.port}  (MCP at /mcp, telescope ${config.dwarf.host})`);
  if (!config.observer.latitude || !config.observer.longitude) log.warn('OBSERVER_LATITUDE / OBSERVER_LONGITUDE not set — planning, calibration and GoTo need them');
  dwarf.start();
  catalog();
  if (config.agent.enabled) {
    agent.start(`http://127.0.0.1:${config.web.port}/mcp`).catch((e) => log.error(`agent failed to start: ${errMsg(e)}`));
  }
});

const shutdown = () => {
  log.info('shutting down');
  agent.stop();
  dwarf.stop();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (r) => log.error(`unhandled rejection: ${errMsg(r)}`));
