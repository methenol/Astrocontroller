import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { logger, errMsg } from './log.js';
import { loadDriver } from './drivers/index.js';
import { mountMcpServer } from './mcp/server.js';
import { BODY_LIMIT_BYTES, jsonErrors } from './web/http.js';
import { AgentBridge } from './agent/omp.js';
import { catalog } from './astro/catalog.js';
import { startProcessing, stopProcessing } from './processing/queue.js';

const log = logger('main');

/** On shutdown, readers and the agent get this long to close before the process exits. */
const SHUTDOWN_GRACE_MS = 1500;

for (const dir of [config.paths.data, config.paths.library, config.paths.captures, config.paths.workspace, config.paths.sessions, config.paths.home]) {
  fs.mkdirSync(dir, { recursive: true });
}

const driver = await loadDriver(config.telescope.driver);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: BODY_LIMIT_BYTES }));
// device state carries 64-bit protobuf fields (BigInt), which plain JSON.stringify refuses
app.set('json replacer', (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

const agent = new AgentBridge();
const runtime = driver.create({ agent });
mountMcpServer(app, runtime.mcp);

const server = http.createServer(app);
const web = runtime.mountWeb(app, server);
app.use(jsonErrors);

server.on('error', (err: NodeJS.ErrnoException) => {
  log.error(err.code === 'EADDRINUSE' ? `port ${config.web.port} is already in use: is another Astrocontroller running?` : `web server: ${errMsg(err)}`);
  process.exit(1);
});

server.listen(config.web.port, () => {
  log.info(`Astrocontroller on http://0.0.0.0:${config.web.port}  (MCP at /mcp, driver ${driver.id}: ${runtime.describeTarget()})`);
  // null = not set; 0 is a real latitude (the equator) or longitude (Greenwich)
  if (config.observer.latitude === null || config.observer.longitude === null) log.warn('OBSERVER_LATITUDE / OBSERVER_LONGITUDE not set — planning, calibration and GoTo need them');
  runtime.start();
  try {
    catalog();
  } catch (e) {
    log.error(`the object catalog did not load: ${errMsg(e)} (search, planning and GoTo by name will fail)`);
  }
  startProcessing();
  if (config.agent.enabled) {
    agent.start(`http://127.0.0.1:${config.web.port}/mcp`).catch((e) => log.error(`agent failed to start: ${errMsg(e)}`));
  }
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${signal})`);
  const steps: Array<[string, () => void]> = [
    ['processing', () => stopProcessing()],
    ...runtime.shutdownSteps(),
    ['agent', () => agent.stop()],
    ['web', () => web.close()],
    ['server', () => server.close()],
  ];
  // one failing step never keeps the others from running
  for (const [name, step] of steps) {
    try {
      step();
    } catch (e) {
      log.warn(`shutdown: ${name}: ${errMsg(e)}`);
    }
  }
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(process.exitCode ?? 0);
  }, SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => log.error(`unhandled rejection: ${errMsg(r)}`));
process.on('uncaughtException', (e) => {
  log.error(`uncaught exception: ${e.stack ?? errMsg(e)}`);
  // the process state is unknown now: stop cleanly (the container restarts it)
  shutdown('uncaught exception');
  process.exitCode = 1;
});
