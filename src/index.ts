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
import { watchCharging } from './agent/charge-watch.js';
import { DutyLoop } from './agent/duty.js';
import { catalog } from './astro/catalog.js';
import { startProcessing, stopProcessing } from './processing/queue.js';

const log = logger('main');

for (const dir of [config.paths.data, config.paths.library, config.paths.captures, config.paths.workspace, config.paths.sessions, config.paths.home]) {
  fs.mkdirSync(dir, { recursive: true });
}

const dwarf = new Dwarf();
const hub = new StreamHub(dwarf);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '60mb' }));

const agent = new AgentBridge();
const duty = new DutyLoop(dwarf, agent);
mountMcp(app, { dwarf, hub, duty });

const server = http.createServer(app);
mountWeb(app, server, { dwarf, hub, agent, duty });

server.listen(config.web.port, () => {
  log.info(`Astrocontroller on http://0.0.0.0:${config.web.port}  (MCP at /mcp, telescope ${config.dwarf.host})`);
  if (!config.observer.latitude || !config.observer.longitude) log.warn('OBSERVER_LATITUDE / OBSERVER_LONGITUDE not set — planning, calibration and GoTo need them');
  dwarf.start();
  catalog();
  startProcessing();
  if (config.agent.enabled) {
    agent.start(`http://127.0.0.1:${config.web.port}/mcp`).catch((e) => log.error(`agent failed to start: ${errMsg(e)}`));
    watchCharging(dwarf, agent);
  }
});

const shutdown = () => {
  log.info('shutting down');
  hub.shutdown();
  stopProcessing();
  agent.stop();
  dwarf.stop();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (r) => log.error(`unhandled rejection: ${errMsg(r)}`));
