/**
 * The Seestar behind the shared web UI (public/): its state projected onto the field names the UI
 * renders, the UI's controls mapped onto the Seestar's commands, its live views, and the
 * Seestar-only API under /api/seestar (tunnel, ZWO devices, raw RPC, the stacked image).
 */
import express, { type Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';
import { displayJpeg } from '../../mcp/tools/common.js';
import { sharpnessLine, starSharpness } from '../../media/focus.js';
import { body, route } from '../../web/http.js';
import { unsupported, type Capabilities, type GotoTarget, type WebTelescope } from '../../web/telescope.js';
import type { ControlAction } from '../../web/routes/control.js';
import { NUDGE_MAX_S, NUDGE_MAX_SPEED, type Seestar } from './device.js';
import { NOMINAL_FOV } from './mcp.js';
import { TERMINAL_STATES, type OperationState, type SeestarState } from './state.js';
import type { SeestarEvent } from './rpc.js';
import { SeestarVideoHub } from './video.js';
import { listDevices } from './zwo-cloud.js';

const LABEL = 'ZWO Seestar';

const CAPABILITIES: Capabilities = {
  nudge: true,
  home: true,
  level: false,
  park: true,
  goto: true,
  photo: false,
  burst: false,
  record: false,
  timelapse: false,
  stack: true,
  autofocus: true,
  autofocusAstro: false,
  focusSteps: true,
  starFocus: true,
  starTune: false,
  polarAlign: true,
  modes: false,
  exposure: true,
  gain: true,
  sync: true,
  liveView: true,
  rgb: false,
  reboot: true,
  shutdown: true,
  album: false,
  sessions: false,
  transfer: false,
  horizonSurvey: false,
  wire: false,
  video: ['tele', 'wide', 'stack'],
};

/** The UI's operation words for what the Seestar is busy with. */
const OPERATION: Record<string, string> = { goto: 'GoTo', parking: 'parking', autofocus: 'autofocus', 'polar alignment': 'polar alignment', 'dark library': 'dark library', stacking: '' };

/** An operation's state as the UI words it (the Dwarf's idle / running / done / failed). */
function opWord(o: OperationState | undefined): string {
  if (!o) return 'idle';
  if (o.state === 'complete') return 'done';
  if (o.state === 'fail') return 'failed';
  if (o.state === 'cancel') return 'cancelled';
  if (o.state === 'idle' || o.state === 'off') return 'idle';
  return 'running';
}

/** The control link in the UI's terms (its state and a plain-language detail). */
function linkView(st: SeestarState): { state: string; detail: string; health: SeestarState['link'] } {
  const l = st.link;
  const where = l ? `${l.host}:${l.port}` : config.seestar.host;
  if (st.released) return { state: 'released', detail: 'released by the user (Disconnect in the web UI)', health: l };
  if (st.connected) return { state: 'connected', detail: `connected to the Seestar at ${where}`, health: l };
  return { state: 'connecting', detail: `connecting to the Seestar at ${where}${l?.lastError ? `: ${l.lastError}` : ''}`, health: l };
}

const gb = (mb: number | undefined) => (mb === undefined ? undefined : +(mb / 1024).toFixed(1));

/** The Seestar's state in the UI's field names; the fields it has no equivalent of are left out. */
export function projectState(st: SeestarState, busy: string | null): WebTelescope['state'] {
  const stackRunning = !!st.stack.state && !TERMINAL_STATES.has(st.stack.state) && st.stack.state !== 'idle';
  const taken = (st.stack.stacked ?? 0) + (st.stack.dropped ?? 0);
  const target = st.view.target;
  const raDec = st.view.targetRaDec;
  const operation = busy && busy !== 'stacking' ? (OPERATION[busy] ?? busy) : undefined;
  return {
    driver: 'seestar',
    connected: st.connected,
    released: st.released,
    link: linkView(st),
    tunnel: st.tunnel,
    device: { name: st.device.name ?? st.device.model, model: st.device.model, serial: st.device.serial, firmware: st.device.firmware },
    battery: st.power.batteryPct,
    charging: st.power.charging,
    temperatureC: st.power.tempC,
    operation,
    bodyMode: st.mount.eqMode === undefined ? undefined : st.mount.eqMode ? 'eq' : 'altaz',
    storage: st.storage.totalMB !== undefined ? { availableGB: gb(st.storage.freeMB) ?? 0, totalGB: gb(st.storage.totalMB) ?? 0 } : undefined,
    goto: { state: opWord(st.ops.AutoGoto), target },
    tracking: { state: st.mount.tracking === undefined ? 'idle' : st.mount.tracking ? 'running' : 'idle', target: st.mount.tracking ? target : undefined },
    focusPosition: st.focus.position,
    autofocus: { state: opWord(st.ops.AutoFocus) },
    fov: { tele: st.fov ?? NOMINAL_FOV },
    capture: {},
    stacking: {
      tele: { state: stackRunning ? 'running' : 'idle', currentCount: taken || undefined, stackedCount: st.stack.stacked, totalCount: st.stack.total, target },
      wide: { state: 'idle' },
    },
    polarAlign: st.polarAlign,
    pointing: target && raDec ? { target, raHours: raDec[0], decDeg: raDec[1], at: st.ops.AutoGoto?.at ?? Date.now() } : undefined,
    mount: st.mount,
    alert: st.alert,
  };
}

/** "30", "30s", "500ms", "1/100" → milliseconds. */
function exposureMs(v: string | number | boolean): number {
  const s = String(v).trim().toLowerCase();
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
  const ms = frac ? (1000 * +frac[1]) / +frac[2] : s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`exposure "${v}" is not a duration (seconds, e.g. 10, or a fraction, e.g. 1/100)`);
  return ms;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function seestarWeb(scope: Seestar): WebTelescope {
  const hub = new SeestarVideoHub(scope, () => config.seestar.host);

  const control = async (b: ControlAction): Promise<unknown> => {
    switch (b.action) {
      case 'nudge': {
        // the UI's angle is the screen's (0 up, 90 right), the Seestar's the math one (0 right, 90 up);
        // the Seestar moves for whole seconds, so the move is stopped after the UI's duration
        await scope.nudge(90 - b.angle, b.speed * NUDGE_MAX_SPEED, Math.min(NUDGE_MAX_S, Math.max(1, Math.ceil(b.ms / 1000))));
        await sleep(b.ms);
        await scope.stopMotion();
        return scope.readPointing();
      }
      case 'stop':
        await scope.stopMotion();
        return { ok: true };
      case 'home':
        // the Seestar keeps its own axis positions: home is raising the arm out of park
        return { result: (await scope.openArm()).state };
      case 'park':
        return { result: (await scope.park()).state };
      case 'stack_start':
        await scope.startStack();
        return { result: 'Live stacking started' };
      case 'stack_stop':
        await scope.stopStack();
        return { ok: true };
      case 'autofocus':
        return { result: `autofocus ${(await scope.autofocus()).state}` };
      case 'focus': {
        const at = await scope.focusBy(b.direction === 'near' ? -b.steps : b.steps);
        return { result: `focuser at ${at ?? '?'}` };
      }
      case 'star_measure': {
        // one live sub, measured; the plate scale comes from the tele field
        const { image } = await scope.grabImage('tele', 'preview');
        const fov = scope.state.fov ?? NOMINAL_FOV;
        const sharp = starSharpness(image, { arcsecPerPx: (fov.h * 3600) / (image.frameWidth ?? image.width) });
        return { result: sharpnessLine(sharp), focusPosition: scope.state.focus.position, ...sharp };
      }
      case 'setting': {
        if (b.setting === 'exposure') return { result: await scope.setExposure({ stackMs: exposureMs(b.value), continuousMs: exposureMs(b.value) }) };
        if (b.setting === 'gain') {
          const g = Number(b.value);
          if (!Number.isFinite(g)) throw new Error(`gain "${b.value}" is not a number`);
          return { result: await scope.setGain(g) };
        }
        return { result: await scope.setSetting({ [b.setting]: b.value }) };
      }
      case 'settings':
        return scope.settings();
      case 'polar_align':
        // takes minutes; progress and the outcome are published as state.polarAlign for the Polar group's readout
        return { result: (await scope.polarAlign()).summary };
      case 'polar_stop':
        await scope.stopPolarAlign();
        return { result: 'Polar alignment stopped' };
      case 'goto_stop':
        await scope.stopView();
        return { ok: true };
      case 'sync':
        return { result: (await scope.syncTimeLocation()).join(', ') };
      case 'liveview':
        await scope.startView();
        return { ok: true };
      case 'reboot':
        await scope.power('reboot');
        return { result: 'Reboot sent: the telescope reconnects in about a minute' };
      case 'shutdown':
        await scope.power('shutdown');
        return { result: 'Shutdown sent' };
      default:
        // the route checks the capabilities first; this is a control the table above marks unsupported
        throw unsupported({ label: LABEL }, `"${b.action}"`);
    }
  };

  const goto = async (t: GotoTarget): Promise<string> => {
    // the Seestar takes a fixed position: a planet's is computed for now
    const p = t.kind === 'body' ? sky.bodyRaDec(scope.requireLocation(), t.body) : t;
    const r = await scope.gotoTarget({ raHours: p.raHours, decDeg: p.decDeg, name: t.label });
    return `GoTo ${t.label}: ${r.goto.state} after ${(r.goto.ms / 1000).toFixed(0)} s`;
  };

  const routes = (): Router => {
    const api = express.Router();
    api.get('/seestar/status', route(async () => ({ ...scope.state, busy: scope.isBusy() })));
    api.post('/seestar/refresh', route(async () => scope.refreshState()));
    api.get('/seestar/events', route(async () => scope.state.recent));
    api.get('/seestar/tunnel', route(async () => scope.tunnel?.status() ?? null));
    api.post('/seestar/tunnel/restart', route(async () => scope.tunnel?.restart()));
    api.get('/seestar/zwo-devices', route(async () => listDevices()));
    api.post(
      '/seestar/rpc',
      route(async (req) => {
        const b = body(req, z.object({ method: z.string().min(1), params: z.unknown().optional() }));
        return scope.raw(b.method, b.params);
      }),
    );
    api.get(
      '/seestar/image.jpg',
      route(async (req, res) => {
        const camera = req.query.camera === 'wide' ? 'wide' : 'tele';
        const kind = req.query.kind === 'preview' ? 'preview' : 'stacked';
        const { image } = await scope.grabImage(camera, kind);
        const jpeg = await displayJpeg(image, 1600);
        res.setHeader('Cache-Control', 'no-store');
        res.type('jpeg').send(jpeg);
      }),
    );
    return api;
  };

  // the UI's 'state' is the projection; the Seestar's event frames are its notifications
  const listeners = new Map<(...a: any[]) => void, (...a: any[]) => void>();
  const wrap = (event: 'state' | 'notification', fn: (...a: any[]) => void) => {
    const w = event === 'state' ? () => fn(projectState(scope.state, scope.isBusy())) : (e: SeestarEvent) => fn({ name: e.Event, data: e, ts: e.at });
    listeners.set(fn, w);
    return w;
  };

  return {
    driver: 'seestar',
    label: LABEL,
    get state() {
      return projectState(scope.state, scope.isBusy());
    },
    capabilities: CAPABILITIES,
    hub,
    location: () => scope.location(),
    requireLocation: () => scope.requireLocation(),
    teleFovDeg: () => scope.state.fov ?? NOMINAL_FOV,
    connectLink: () => scope.connectLink(),
    release: () => scope.release(),
    setHost: (host) => scope.setHost(host),
    control,
    goto,
    routes,
    on: (event, fn) => scope.on(event === 'state' ? 'state' : 'event', wrap(event, fn)),
    off: (event, fn) => {
      const w = listeners.get(fn);
      if (!w) return scope;
      listeners.delete(fn);
      return scope.off(event === 'state' ? 'state' : 'event', w);
    },
  };
}
