/**
 * The profile hub: the container's entry point when several telescopes are driven at once.
 *
 *   /                 the hub's page: the profile switcher, and the profile manager
 *   /hub/api/...      create, change, remove, activate and deactivate profiles
 *   /p/<id>/...       the profile's own Astrocontroller (its web UI, API, streams and sockets)
 *
 * Each active profile is the ordinary single-telescope app in its own process (src/hub/instances.ts)
 * with its own data folder, agent home, library, site and web port on loopback; the hub only starts,
 * stops and proxies them. Profiles are kept in <DATA_DIR>/profiles.json; the first start migrates the
 * single-telescope .env into one profile that keeps the data folder it had.
 *
 * Shared by every profile, from .env: the LLM, AstroPhoto Studio, units, Stellarium, the Seestar key,
 * the ZWO tunnel's host and token. Each profile can override any of these in its own variables.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { errMsg, logger } from '../log.js';
import { body, jsonErrors, notFound, rejectCrossSite, route } from '../web/http.js';
import { Instance, type InstanceSpec } from './instances.js';
import { childEnv, seestarKeyPath, seestarKeyProblem, usesSeestarKey, legacyProfile, ProfileInput, ProfileStore, profileDataDir, publicProfile, type HubPaths, type Profile } from './profiles.js';
import { guard, proxyRequest, proxyUpgrade, refuseUpgrade, splitPrefixed } from './proxy.js';
import { TunnelManager } from './tunnels.js';

const log = logger('hub');

const env = process.env;
const str = (k: string, d = ''): string => (env[k] ?? '').trim() || d;
const int = (k: string, d: number): number => {
  const n = Number(str(k));
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : d;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ENTRY = path.resolve(HERE, '..', 'index.js');
const paths: HubPaths = {
  data: path.resolve(str('DATA_DIR', './data')),
  library: path.resolve(str('LIBRARY_DIR', path.join(str('DATA_DIR', './data'), 'library'))),
};
const PORT = int('WEB_PORT', 8080);
const BIND = str('WEB_BIND');
const CHILD_PORT_BASE = int('HUB_CHILD_PORT_BASE', 18100);
const PUBLIC = path.resolve(str('PUBLIC_DIR', './public'), 'hub');
const TUNNEL_HOST = str('SEESTAR_TUNNEL_HOST', '127.0.0.1');
const ROOF_URL = str('STARFRONT_ROOF_URL', 'https://alpaca-api.tx.starfront.space/api/v1/roof/state');
/** how often every active ZWO profile's tunnel slot is asked for again (a restarted tunnel container) */
const TUNNEL_REFRESH_MS = 60_000;
const SHUTDOWN_GRACE_MS = 12_000;

const tunnels = new TunnelManager({
  url: (env.SEESTAR_TUNNEL_MANAGER_URL ?? `http://${TUNNEL_HOST}:${int('SEESTAR_TUNNEL_MANAGER_PORT', 4709)}`).trim().replace(/\/+$/, ''),
  token: str('SEESTAR_TUNNEL_CONTROL_TOKEN'),
});

fs.mkdirSync(paths.data, { recursive: true });
const store = new ProfileStore(paths);
if (!store.exists()) {
  const p = legacyProfile(env, paths);
  store.adopt(p);
  log.info(`first start of the profile hub: the .env setup is now profile "${p.name}" (its data stays in ${profileDataDir(p, paths)})`);
}
store.load((m) => log.warn(m));

// ---- processes ---------------------------------------------------------------------------------

const instances = new Map<string, Instance>();

function spec(p: Profile): InstanceSpec {
  const port = CHILD_PORT_BASE + p.slot;
  return { id: p.id, name: p.name, port, env: childEnv(p, env, { paths, port, tunnelHost: TUNNEL_HOST, cwd: process.cwd() }) };
}

function instanceOf(p: Profile): Instance {
  let inst = instances.get(p.id);
  if (!inst) {
    inst = new Instance(spec(p), { command: process.execPath, args: [APP_ENTRY], cwd: process.cwd() });
    inst.on('status', (s) => log.info(`${p.name}: ${s.phase}`));
    instances.set(p.id, inst);
  } else inst.configure(spec(p));
  return inst;
}

async function run(p: Profile): Promise<void> {
  // over ZWO the scope refuses every request without the signed handshake: say so up front
  const keyProblem = seestarKeyProblem(p, env);
  if (keyProblem) log.warn(`${p.name}: ${keyProblem}`);
  await tunnels.ensure(p);
  instanceOf(p).start();
}

async function halt(p: Profile, releaseTunnel: boolean): Promise<void> {
  await instances.get(p.id)?.stop();
  if (releaseTunnel) await tunnels.release(p);
}

function view(p: Profile) {
  const inst = instances.get(p.id);
  const status = inst?.status() ?? { phase: 'stopped', pid: null, port: CHILD_PORT_BASE + p.slot, since: 0, restarts: 0, lastExit: null };
  let hostOverride: string | null = null;
  try {
    const saved = (JSON.parse(fs.readFileSync(path.join(profileDataDir(p, paths), 'telescope.json'), 'utf8')) as { host?: unknown }).host;
    if (typeof saved === 'string') hostOverride = saved;
  } catch {
    /* none set from the telescope's own System panel */
  }
  return { ...publicProfile(p, paths), status, hostOverride, tunnelProblem: tunnels.problem(p.id), keyFile: usesSeestarKey(p) ? seestarKeyPath(env) || null : null, keyProblem: seestarKeyProblem(p, env) };
}

const need = (id: string): Profile => {
  const p = store.get(id);
  if (!p) throw notFound(`no profile "${id}"`);
  return p;
};

/** Settings that only reach a process when it starts. */
const runtimeKey = (p: Profile): string => JSON.stringify(spec(p).env);

// ---- the web side --------------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

const api = express.Router();
api.use(express.json({ limit: '256kb' }));
api.use(rejectCrossSite);

api.get('/profiles', route(async () => ({ profiles: store.all().map(view), tunnelManager: tunnels.enabled })));

api.post(
  '/profiles',
  route(async (req) => {
    const input = body(req, ProfileInput.extend({ activate: z.boolean().optional() }));
    const p = store.create(input);
    log.info(`profile "${p.name}" created (${p.driver}${p.seestar.zwo ? ' over ZWO' : ''}, slot ${p.slot})`);
    if (input.activate) await run(store.setActive(p.id, true));
    return view(store.get(p.id)!);
  }),
);

api.put(
  '/profiles/:id',
  route(async (req) => {
    const before = need(String(req.params.id));
    const p = store.update(before.id, body(req, ProfileInput));
    // a ZWO slot the profile no longer uses (switched to the LAN, or to the Dwarf) is given back
    if (before.driver === 'seestar' && before.seestar.zwo && !(p.driver === 'seestar' && p.seestar.zwo)) await tunnels.release(before);
    // an address set here wins over one set earlier in the telescope's own System panel
    if (p.host !== before.host) fs.rmSync(path.join(profileDataDir(p, paths), 'telescope.json'), { force: true });
    const changed = runtimeKey(before) !== runtimeKey(p);
    if (p.active && changed) await tunnels.ensure(p);
    log.info(`profile "${p.name}" changed${p.active && changed ? ' (applies at its next restart)' : ''}`);
    return { ...view(p), restartNeeded: p.active && changed && instances.get(p.id)?.status().phase !== 'stopped' };
  }),
);

api.delete(
  '/profiles/:id',
  route(async (req) => {
    const p = need(String(req.params.id));
    await halt(p, true);
    instances.delete(p.id);
    store.remove(p.id);
    let purged = false;
    // only a folder the hub made itself goes: never a migrated setup's data, never a library
    const own = path.join(paths.data, 'profiles', p.id);
    if (req.query.purge === 'true' && !p.dataDir && profileDataDir(p, paths) === own) {
      fs.rmSync(own, { recursive: true, force: true });
      purged = true;
    }
    log.info(`profile "${p.name}" removed${purged ? ' with its data folder' : ''}`);
    return { removed: p.id, purged };
  }),
);

api.post(
  '/profiles/:id/activate',
  route(async (req) => {
    const p = store.setActive(need(String(req.params.id)).id, true);
    log.info(`profile "${p.name}" activated`);
    await run(p);
    return view(p);
  }),
);

api.post(
  '/profiles/:id/deactivate',
  route(async (req) => {
    const p = store.setActive(need(String(req.params.id)).id, false);
    log.info(`profile "${p.name}" deactivated: its process stops and nothing of it runs until it is activated again`);
    await halt(p, true);
    return view(p);
  }),
);

api.post(
  '/profiles/:id/restart',
  route(async (req) => {
    const p = need(String(req.params.id));
    if (!p.active) throw new Error(`"${p.name}" is not active`);
    await tunnels.ensure(p);
    const inst = instanceOf(p);
    await inst.restart();
    return view(p);
  }),
);

api.get(
  '/profiles/:id/output',
  route(async (req) => {
    const p = need(String(req.params.id));
    return { lines: instances.get(p.id)?.output() ?? [] };
  }),
);

/** The Starfront buildings (and their roofs), for the building picker. */
api.get(
  '/starfront/buildings',
  route(async () => {
    const res = await fetch(ROOF_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`the Starfront roof service answered HTTP ${res.status}`);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) throw new Error('the Starfront roof service did not send a list');
    return {
      buildings: list
        .filter((r): r is { device_number: number; name?: unknown; is_open?: unknown } => !!r && typeof r === 'object' && typeof (r as { device_number?: unknown }).device_number === 'number')
        .map((r) => ({ number: r.device_number, name: typeof r.name === 'string' ? r.name : `Building ${r.device_number}`, open: r.is_open === true }))
        .sort((a, b) => a.number - b.number),
    };
  }),
);

api.use((req, res) => res.status(404).json({ error: `no such API route: ${req.method} ${req.path}` }));
app.use('/hub/api', api);

// the hub's page, versioned per start like the app's own
const bootId = Date.now().toString(36);
app.get(['/', '/index.html'], (_req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/(href="hub\/hub\.css|src="hub\/hub\.js)"/g, `$1?v=${bootId}"`);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
});
app.use('/hub', express.static(PUBLIC, { index: false }));
// the app's icons for the hub page too
app.use('/icons', express.static(path.resolve(str('PUBLIC_DIR', './public'), 'icons')));
app.use(jsonErrors);

const server = http.createServer((req, res) => {
  const hit = splitPrefixed(req.url ?? '/');
  if (!hit) return void app(req, res);
  const p = store.get(hit.id);
  if (!p) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`no profile "${hit.id}"`);
    return;
  }
  // /p/<id> → /p/<id>/: the app's relative URLs resolve against the folder
  if (!/^\/p\/[^/?]+\//.test(req.url ?? '')) {
    const q = (req.url ?? '').indexOf('?');
    res.writeHead(308, { Location: `/p/${hit.id}/${q < 0 ? '' : (req.url ?? '').slice(q)}` }).end();
    return;
  }
  const inst = instances.get(p.id);
  proxyRequest(req, res, { name: p.name, port: CHILD_PORT_BASE + p.slot, active: p.active, running: !!inst && p.active && inst.status().phase === 'running' }, hit.rest);
});

server.on('upgrade', (req, socket, head) => {
  guard(socket);
  const hit = splitPrefixed(req.url ?? '/');
  const p = hit ? store.get(hit.id) : undefined;
  // e.g. a tab still open from before the hub, reconnecting its socket at /ws
  if (!hit || !p) return refuseUpgrade(socket, '404 Not Found');
  const inst = instances.get(p.id);
  proxyUpgrade(req, socket, head, { name: p.name, port: CHILD_PORT_BASE + p.slot, active: p.active, running: !!inst && p.active && inst.status().phase === 'running' }, hit.rest);
});

// a malformed or reset request from a client: close it, never let it reach the process
server.on('clientError', (_err, socket) => {
  guard(socket);
  socket.destroy();
});
server.on('connection', guard);

server.on('error', (err: NodeJS.ErrnoException) => {
  log.error(err.code === 'EADDRINUSE' ? `port ${PORT} is already in use: is another Astrocontroller running?` : `web server: ${errMsg(err)}`);
  process.exit(1);
});

const onListen = () => {
  const all = store.all();
  log.info(`Astrocontroller profile hub on http://${BIND || '0.0.0.0'}:${PORT}: ${all.length} profile(s), ${all.filter((p) => p.active).length} active`);
  for (const p of all) if (p.active) void run(p).catch((e) => log.error(`${p.name}: ${errMsg(e)}`));
};
if (BIND) server.listen(PORT, BIND, onListen);
else server.listen(PORT, onListen);

const refresh = setInterval(() => {
  for (const p of store.all()) if (p.active) void tunnels.ensure(p);
}, TUNNEL_REFRESH_MS);
refresh.unref();

// ---- shutdown ------------------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${signal}): stopping ${instances.size} profile process(es)`);
  clearInterval(refresh);
  setTimeout(() => process.exit(process.exitCode ?? 0), SHUTDOWN_GRACE_MS).unref();
  // every profile at once; their ZWO sessions stay with the tunnel supervisors for the next start
  await Promise.allSettled([...instances.values()].map((i) => i.stop()));
  server.closeAllConnections();
  server.close();
  process.exit(process.exitCode ?? 0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => log.error(`unhandled rejection: ${errMsg(r)}`));
// The hub only starts, stops and proxies; every profile's process dies with it. An error it did not
// see coming is logged, not allowed to take every telescope down with it.
process.on('uncaughtException', (e) => log.error(`uncaught exception (the hub keeps running): ${e.stack ?? errMsg(e)}`));
