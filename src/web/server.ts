import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../config.js';
import { logger, logBus, recentLogs, errMsg } from '../log.js';
import type { Dwarf, CameraName } from '../dwarf/device.js';
import * as dhttp from '../dwarf/http.js';
import type { StreamHub } from '../media/streams.js';
import type { AgentBridge } from '../agent/omp.js';
import { toolEvents } from '../mcp/tools.js';
import * as library from '../library/transfer.js';
import * as sky from '../astro/sky.js';
import { planNight } from '../astro/planner.js';
import * as weather from '../astro/weather.js';
import { findObject } from '../astro/catalog.js';

const log = logger('web');

interface Ctx {
  dwarf: Dwarf;
  hub: StreamHub;
  agent: AgentBridge;
}

const thumbCache = new Map<string, { buf: Buffer; type: string; at: number }>();

export function mountWeb(app: Express, server: http.Server, ctx: Ctx): void {
  const { dwarf, hub, agent } = ctx;
  const api = express.Router();

  const route = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      if (!res.headersSent) res.status(400).json({ error: errMsg(err) });
    }
  };

  // ---------------------------------------------------------------- streams
  app.get('/stream/:name', (req, res) => {
    try {
      hub.get(String(req.params.name)).attach(res);
    } catch (err) {
      res.status(404).send(errMsg(err));
    }
  });

  api.get('/snapshot/:name', route(async (req, res) => {
    const src = hub.get(String(req.params.name));
    const f = await src.snapshot(5000, 15000);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(f.jpeg);
  }));

  // ---------------------------------------------------------------- state
  api.get('/state', route(async () => ({ telescope: dwarf.state, agent: agent.status(), jobs: library.listJobs(), config: publicConfig(dwarf) })));
  api.get('/logs', route(async () => recentLogs(300)));

  api.get('/conditions', route(async () => {
    const loc = dwarf.requireLocation();
    const s = { lat: loc.lat, lon: loc.lon, elev: loc.elev };
    const w = sky.nightWindow(s);
    const tz = config.observer.timezone;
    return {
      sunAltitude: Math.round(sky.bodyAlt(s, 'Sun') * 10) / 10,
      moon: sky.moonState(s),
      night: { sunset: sky.fmtTime(w.sunset, tz), astroDusk: sky.fmtTime(w.astroDusk, tz), astroDawn: sky.fmtTime(w.astroDawn, tz), sunrise: sky.fmtTime(w.sunrise, tz) },
    };
  }));

  api.get('/weather', route(async () => {
    const loc = dwarf.requireLocation();
    return weather.tonight({ lat: loc.lat, lon: loc.lon, elev: loc.elev }, config.observer.timezone);
  }));

  api.get('/plan', route(async (req) => {
    const loc = dwarf.requireLocation();
    const fov = dwarf.state.fov.tele ?? { h: 2.95, v: 1.66 };
    const types = req.query.types ? String(req.query.types).split(',') : undefined;
    return planNight({ lat: loc.lat, lon: loc.lon, elev: loc.elev }, { types, minAltitude: config.observer.minAltitudeDeg, limit: 20, fovArcmin: { w: fov.h * 60, h: fov.v * 60 }, timezone: config.observer.timezone });
  }));

  // ---------------------------------------------------------------- album & library
  api.get('/album', route(async (req) => {
    const type = Number(req.query.type ?? 0);
    const page = Number(req.query.page ?? 0);
    const [counts, items] = await Promise.all([dhttp.getMediaCounts(), dhttp.listMedia(type, page, 24)]);
    return { counts, items };
  }));

  api.get('/device-file', route(async (req, res) => {
    const p = String(req.query.path ?? '');
    if (!p.startsWith('/DWARF3/')) throw new Error('bad path');
    const hit = thumbCache.get(p);
    let entry = hit && Date.now() - hit.at < 3600e3 ? hit : null;
    if (!entry) {
      const buf = await dhttp.fetchFile(p);
      entry = { buf, type: p.endsWith('.png') ? 'image/png' : p.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', at: Date.now() };
      if (buf.length < 2e6) {
        thumbCache.set(p, entry);
        if (thumbCache.size > 300) thumbCache.delete(thumbCache.keys().next().value!);
      }
    }
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(entry.buf);
  }));

  api.get('/sessions', route(async (req) => library.listDeviceSessions(req.query.counts === '1')));
  api.get('/library', route(async () => ({ root: config.paths.library, targets: library.listLibrary() })));
  api.post('/transfer', route(async (req) => {
    const b = req.body ?? {};
    if (b.session) return library.transferSession(String(b.session), { includeSubframes: b.subframes !== false, includeCalibration: b.calibration !== false });
    if (Array.isArray(b.paths)) return library.transferFiles(b.paths.map(String));
    throw new Error('give session or paths');
  }));
  api.post('/jobs/:id/cancel', route(async (req) => ({ cancelled: library.cancelJob(String(req.params.id)) })));

  app.use('/captures', express.static(config.paths.captures, { maxAge: '1h' }));
  api.get('/captures', route(async () => {
    const dir = path.join(config.paths.captures, 'agent');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().slice(-60).map((f) => ({ path: `agent/${f}`, name: f }));
  }));

  // ---------------------------------------------------------------- manual control
  api.post('/control', route(async (req) => {
    const b = req.body ?? {};
    const cam: CameraName = b.camera === 'wide' ? 'wide' : 'tele';
    switch (b.action) {
      case 'nudge':
        await dwarf.nudge(Number(b.angle ?? 0), Number(b.speed ?? 0.5), Number(b.ms ?? 600));
        return dwarf.readMotorPositions();
      case 'stop':
        await dwarf.stopMotion();
        return { ok: true };
      case 'home':
        return { result: await dwarf.homeMotors() };
      case 'park':
        return { result: await dwarf.moveTo({ pitchDeg: 3, rotationDeg: 159 }) };
      case 'level':
        return { result: await dwarf.moveTo({ pitchDeg: 90 }) };
      case 'photo':
        return { item: await dwarf.takePhoto(cam) };
      case 'burst':
        return { result: await dwarf.burst(cam, Math.max(3, Math.min(999, Number(b.count ?? 10)))) };
      case 'record':
        await dwarf.record(cam, b.on ? 'start' : 'stop');
        return { result: `${cam} recording ${b.on ? 'started' : 'stopped'}` };
      case 'stack_start':
        await dwarf.ensureMode('DSO');
        return { result: await dwarf.startStacking(cam) };
      case 'autofocus':
        return { result: await dwarf.autofocus(b.mode === 'astro' ? 'astro' : 'normal') };
      case 'focus':
        return { result: await dwarf.focusStep(b.direction === 'near' ? 'near' : 'far', Number(b.steps ?? 1)) };
      case 'mode':
        return dwarf.setShootingMode(String(b.mode));
      case 'setting':
        return { result: await dwarf.setSetting(cam, String(b.setting), b.value) };
      case 'settings':
        return dwarf.cameraSettings(cam);
      case 'stack_stop':
        await dwarf.stopStacking(cam, !!b.fast);
        return { ok: true };
      case 'goto_stop':
        await dwarf.stopGoto();
        return { ok: true };
      case 'sync':
        return { result: await dwarf.syncTimeLocation() };
      case 'liveview':
        await dwarf.ensureLiveView(true);
        return { ok: true };
      case 'rgb':
        await dwarf.power(b.on ? 'rgb_on' : 'rgb_off');
        return { ok: true };
      case 'find': {
        const o = findObject(String(b.name ?? ''));
        return o ?? { error: 'not found' };
      }
      default:
        throw new Error(`unknown action ${b.action}`);
    }
  }));

  // ---------------------------------------------------------------- agent
  api.post('/agent/prompt', route(async (req) => {
    const { text, images } = req.body ?? {};
    if (!text || typeof text !== 'string') throw new Error('text required');
    await agent.prompt(text, Array.isArray(images) ? images : []);
    return { ok: true };
  }));
  api.post('/agent/abort', route(async () => agent.abort()));
  api.post('/agent/new', route(async () => agent.newSession()));
  api.post('/agent/thinking', route(async (req) => agent.setThinking(String(req.body?.level ?? 'medium'))));

  // ---------------------------------------------------------------- skills
  api.get('/skills', route(async () => listSkills(agent.skillsDir)));
  api.get('/skills/:name', route(async (req) => {
    const file = skillFile(agent.skillsDir, String(req.params.name));
    return { name: req.params.name, content: fs.readFileSync(file, 'utf8') };
  }));
  api.put('/skills/:name', route(async (req) => {
    const file = skillFile(agent.skillsDir, String(req.params.name), true);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(req.body?.content ?? ''));
    return { ok: true };
  }));

  app.use('/api', api);
  app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.resolve('node_modules/marked/lib/marked.umd.js')));
  // Serve index.html with asset URLs versioned by process start, so browsers pick up new builds.
  const bootId = Date.now().toString(36);
  app.get(['/', '/index.html'], (_req, res) => {
    const html = fs.readFileSync(path.join(config.paths.public, 'index.html'), 'utf8').replace(/(href="style\.css|src="app\.js)"/g, `$1?v=${bootId}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  app.use(express.static(config.paths.public, { index: false }));

  // ---------------------------------------------------------------- websocket
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(data);
  };
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', telescope: dwarf.state, agent: agent.status(), history: agent.history, jobs: library.listJobs(), logs: recentLogs(150), config: publicConfig(dwarf) }));
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === 'prompt') await agent.prompt(String(m.text ?? ''), m.images ?? []);
        else if (m.type === 'abort') await agent.abort();
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: errMsg(err) }));
      }
    });
  });

  dwarf.on('state', (s) => broadcast({ type: 'telescope', state: s }));
  dwarf.on('notification', (n) => {
    if (['temperature', 'cmosTemperature', 'intParam', 'systemResourceState'].includes(n.name)) return;
    broadcast({ type: 'notify', name: n.name, data: n.data, ts: n.ts });
  });
  agent.on('event', (e) => broadcast({ type: 'agent', event: e }));
  agent.on('status', (s) => broadcast({ type: 'agentStatus', status: s }));
  logBus.on('log', (l) => broadcast({ type: 'log', entry: l }));
  library.jobBus.on('job', (j) => broadcast({ type: 'job', job: j }));
  toolEvents.on('image', (i) => broadcast({ type: 'capture', ...i }));
  log.debug('web routes mounted');
}

function publicConfig(dwarf: Dwarf) {
  const loc = dwarf.location();
  return {
    telescope: config.dwarf.host,
    observer: loc ? { ...loc, timezone: config.observer.timezone } : null,
    llm: { baseUrl: config.llm.baseUrl, model: config.llm.model, reasoningEffort: config.llm.reasoningEffort, vision: config.llm.vision },
    library: config.paths.library,
    minAltitude: config.observer.minAltitudeDeg,
  };
}

function skillFile(dir: string, name: string, create = false): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('skill names are lowercase letters, digits and dashes');
  const file = path.join(dir, name, 'SKILL.md');
  if (!create && !fs.existsSync(file)) throw new Error('no such skill');
  return file;
}

function listSkills(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map((d) => {
      const file = path.join(dir, d.name, 'SKILL.md');
      const content = fs.readFileSync(file, 'utf8');
      const desc = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
      return { name: d.name, description: desc.replace(/^["']|["']$/g, ''), updatedAt: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
