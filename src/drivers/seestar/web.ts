/**
 * The Seestar behind the shared web UI (public/): its state projected onto the field names the UI
 * renders, the UI's controls mapped onto the Seestar's commands, its live views, and the
 * Seestar-only API under /api/seestar (tunnel, ZWO devices, raw RPC, the stacked image).
 *
 * The camera the UI shows as its main view is the camera the scope exposes: the video socket's
 * `main` reaches the hub (hub.ts), which selects it on the device. A tool or an operation that
 * needs the other camera borrows it and the selection comes back after (device.ts).
 */
import express, { type Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';
import { displayJpeg } from '../../mcp/tools/common.js';
import { sharpnessLine, starSharpness } from '../../media/focus.js';
import { decode, type FloatImage } from '../../media/images.js';
import { body, route } from '../../web/http.js';
import { unsupported, type Capabilities, type DeviceSwitches, type GotoTarget, type SwitchView, type WebTelescope } from '../../web/telescope.js';
import type { ControlAction } from '../../web/routes/control.js';
import type { StarfrontNights } from '../../agent/starfront.js';
import { bayerFits, SeestarCapture } from './capture.js';
import { NUDGE_MAX_PERCENT, NUDGE_MAX_S, type Seestar } from './device.js';
import { NOMINAL_FOV, seestarFocusSweep } from './focus.js';
import { frameImage, framePixels, JPEG_SOI } from './frames.js';
import { SeestarVideoHub } from './hub.js';
import type { SeestarEvent } from './link.js';
import { isStacking, TERMINAL_STATES, type OperationState, type SeestarState } from './model.js';
import { SeestarFiles, seestarStorage, type SeestarStorage } from './storage.js';
import { SeestarSurvey } from './survey.js';
import { listDevices } from './zwo-cloud.js';

const LABEL = 'ZWO Seestar';

const CAPABILITIES: Capabilities = {
  nudge: true,
  home: true,
  level: true,
  park: true,
  goto: true,
  photo: true,
  burst: true,
  record: true,
  timelapse: true,
  stack: true,
  autofocus: true,
  autofocusAstro: true,
  focusSteps: true,
  starFocus: true,
  starTune: true,
  polarAlign: true,
  modes: true,
  exposure: true,
  gain: true,
  sync: true,
  liveView: true,
  rgb: true,
  switches: true,
  reboot: true,
  shutdown: true,
  album: true,
  sessions: true,
  transfer: true,
  horizonSurvey: true,
  wire: true,
  video: ['tele', 'wide', 'stack'],
  singleView: true,
};

/**
 * The nudge slider per camera: the speed (0.05-1 on the UI's slider) runs exponentially from the
 * camera's slowest to its fastest percent. The firmware's rate is close to linear in the percent
 * (measured on an S50 Pro, fw 9.75, 2026-11-04: 1% 0.03°/s, 10% 0.34°/s, 50% 1.35°/s, 100% 2.48°/s).
 * Tele (1.4°×2.5° field): 1-30%, from a crawl for framing to about a field in 2 s. Wide: 5-100%,
 * panning to get onto a target or look round the sky.
 */
export const NUDGE_CURVE = { tele: [1, 30], wide: [5, 100], degPerSPerPercent: 0.026, speedMin: 0.05 } as const;

export function nudgePercent(speed: number, camera: 'tele' | 'wide'): number {
  const [lo, hi] = NUDGE_CURVE[camera];
  const t = Math.max(0, Math.min(1, (speed - NUDGE_CURVE.speedMin) / (1 - NUDGE_CURVE.speedMin)));
  return Math.max(1, Math.min(NUDGE_MAX_PERCENT, Math.round(lo * (hi / lo) ** t)));
}

export const nudgeDegPerS = (percent: number) => Math.round(percent * NUDGE_CURVE.degPerSPerPercent * 1000) / 1000;

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

/** The UI's shooting modes (the Dwarf's names) and the Seestar view modes they are. */
const MODES: Record<string, 'star' | 'moon' | 'planet' | 'sun'> = { dso: 'star', moon: 'moon', planet: 'planet', sun: 'sun' };

/** The view the scope runs, as the UI's mode name. */
function modeName(v: SeestarState['view']): string | undefined {
  if (!v.mode || v.mode === 'none' || (v.state && TERMINAL_STATES.has(v.state))) return undefined;
  if (v.mode === 'scenery') return 'Normal';
  if (v.mode === 'star') return 'DSO';
  if (v.mode === 'solar_sys' || v.mode === 'moon' || v.mode === 'planet' || v.mode === 'sun') {
    const t = v.targetType ?? (v.mode === 'solar_sys' ? undefined : v.mode);
    return t === 'moon' ? 'Moon' : t === 'planet' ? 'Planet' : t === 'sun' ? 'Sun' : undefined;
  }
  return undefined;
}

const gb = (mb: number | undefined) => (mb === undefined ? undefined : +(mb / 1024).toFixed(1));

/** The Seestar's state in the UI's field names; the fields it has no equivalent of are left out. */
export function projectState(scope: Pick<Seestar, 'state' | 'isBusy' | 'selected' | 'exposing'>): WebTelescope['state'] {
  const st = scope.state;
  const busy = scope.isBusy();
  const stackRunning = isStacking(st);
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
    shootingMode: modeName(st.view) ? { name: modeName(st.view) } : undefined,
    storage: st.storage.totalMB !== undefined ? { availableGB: gb(st.storage.freeMB) ?? 0, totalGB: gb(st.storage.totalMB) ?? 0 } : undefined,
    goto: { state: opWord(st.ops.AutoGoto), target },
    tracking: { state: st.mount.tracking === undefined ? 'idle' : st.mount.tracking ? 'running' : 'idle', target: st.mount.tracking ? target : undefined },
    focusPosition: scope.selected === 'wide' ? st.wideFocus.position : st.focus.position,
    focusPositions: { tele: st.focus.position, wide: st.wideFocus.position },
    autofocus: { state: opWord(st.ops.AutoFocus) },
    fov: { tele: st.fov ?? NOMINAL_FOV },
    capture: {},
    stacking: {
      tele: { state: stackRunning ? 'running' : 'idle', currentCount: taken || undefined, stackedCount: st.stack.stacked, totalCount: st.stack.total, target },
      wide: { state: 'idle' },
    },
    polarAlign: st.polarAlign,
    focusTune: st.focusTune,
    horizonSurvey: st.horizonSurvey,
    pointing: target && raDec ? { target, raHours: raDec[0], decDeg: raDec[1], at: st.ops.AutoGoto?.at ?? Date.now() } : undefined,
    mount: st.mount,
    alert: st.alert,
    // which camera the scope exposes, and which one the UI chose (they differ while something borrows the other)
    camera: { selected: scope.selected, exposing: scope.exposing },
  } as WebTelescope['state'];
}

/** "30", "30s", "500ms", "1/100" → milliseconds. */
function exposureMs(v: string | number | boolean): number {
  const s = String(v).trim().toLowerCase();
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
  const ms = frac ? (1000 * +frac[1]!) / +frac[2]! : s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`exposure "${v}" is not a duration (seconds, e.g. 10, or a fraction, e.g. 1/100)`);
  return ms;
}

type Settings = Record<string, unknown>;
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/**
 * The Seestar's switches, read from get_setting: the dew heater (pi_output_set2, at device.ts's
 * power), the indicator light (light_brightness 0 or 100), auto power-off and the beep.
 */
export function seestarSwitches(scope: Pick<Seestar, 'state' | 'settings' | 'setSetting' | 'setHeater' | 'setLightBrightness'>): DeviceSwitches {
  const table: Array<{ id: string; label: string; hint: string; read(s: Settings): boolean | null; set(on: boolean): Promise<unknown> }> = [
    { id: 'lens_defog', label: 'Dew heater', hint: 'Heats the lens against dew', read: (s) => flag(s.heater_enable), set: (on) => scope.setHeater(on) },
    { id: 'indicator_light', label: 'Indicator light', hint: 'The status light on the arm: turn it off for astro', read: (s) => (typeof s.light_brightness === 'number' ? s.light_brightness > 0 : null), set: (on) => scope.setLightBrightness(on ? 100 : 0) },
    { id: 'auto_shutdown', label: 'Auto power-off', hint: 'Power off when idle', read: (s) => flag(s.auto_power_off), set: (on) => scope.setSetting({ auto_power_off: on }) },
    { id: 'power_sound', label: 'Beep', hint: 'The sounds the Seestar makes', read: (s) => (typeof s.beep_volume === 'string' ? s.beep_volume !== 'off' : null), set: (on) => scope.setSetting({ beep_volume: on ? 'backyard' : 'off' }) },
  ];
  const list = async (): Promise<SwitchView[]> => {
    // offline: the switches are there, their states unknown
    const s = scope.state.connected ? (((await scope.settings().catch(() => null)) ?? {}) as Settings) : {};
    return table.map(({ id, label, hint, read }) => ({ id, label, hint, on: read(s) }));
  };
  return {
    list,
    async set(id, on) {
      const sw = table.find((t) => t.id === id);
      if (!sw) throw new Error(`no switch "${id}"`);
      await sw.set(on);
      const switches = await list();
      const now = switches.find((t) => t.id === id)?.on;
      const what = `${sw.label} ${on ? 'on' : 'off'}`;
      return { result: now === on ? what : now === null ? `${what} sent` : `${what} sent; the Seestar still reports it ${now ? 'on' : 'off'}`, switches };
    },
  };
}

/** The live views, photo capture, storage and the horizon survey, shared by the web UI and the agent's tools. */
export interface SeestarMedia {
  hub: SeestarVideoHub;
  capture: SeestarCapture;
  /** its storage (sessions, album, transfers), registered for the library by the runtime */
  storage: SeestarStorage;
  survey: SeestarSurvey;
  /** the next full-resolution frame of a camera as an image (shown on its live view too) */
  liveFrame(camera: 'tele' | 'wide'): Promise<{ img: FloatImage; encoded: Buffer }>;
}

export function seestarMedia(scope: Seestar): SeestarMedia {
  const hub = new SeestarVideoHub(scope, () => config.seestar.host);
  const capture = new SeestarCapture(scope, (camera, jpeg) => hub.camera(camera).offer(jpeg));
  const liveFrame = async (camera: 'tele' | 'wide') => {
    const shot = await capture.frame(camera, false);
    const img = shot.raw && !shot.raw.payload.subarray(0, 2).equals(JPEG_SOI) ? await frameImage(shot.raw, camera) : await decode(shot.jpeg, `seestar:${camera}.jpg`);
    img.capturedAt = Date.now();
    return { img, encoded: shot.jpeg };
  };
  // the survey works from the wide's live frames as they come (bin 2, 1080×1920): no resolution
  // switch per frame, which would restart the exposures every time
  const survey = new SeestarSurvey(scope, async () => {
    const { image, frame } = await scope.grabImage('wide', 'preview');
    image.capturedAt = Date.now();
    return { image, jpeg: frame.payload.subarray(0, 2).equals(JPEG_SOI) ? frame.payload : undefined };
  }, async () => frameImage(await scope.grabRaw('wide'), 'wide'));
  return { hub, capture, storage: seestarStorage(new SeestarFiles(scope)), survey, liveFrame };
}

export function seestarWeb(scope: Seestar, { hub, capture, survey, liveFrame }: SeestarMedia = seestarMedia(scope), nights: StarfrontNights | null = null): WebTelescope {
  const control = async (b: ControlAction): Promise<unknown> => {
    switch (b.action) {
      case 'nudge': {
        // the UI's angle is the screen's (0 up, 90 right), the Seestar's the math one (0 right, 90 up).
        // The speed (the slider, 0-1) runs along the curve of the camera in the main view: the tele
        // nudges for framing, the wide pans. A held arrow renews its press faster than it runs out
        // (device.ts keeps one move going); the answer does not wait for the scope.
        const camera = scope.selected;
        const pct = nudgePercent(b.speed, camera);
        await scope.nudge(90 - b.angle, pct, Math.min(NUDGE_MAX_S, b.ms / 1000), { wait: false, press: b.press });
        return { ok: true, camera, percent: pct, degPerS: nudgeDegPerS(pct) };
      }
      case 'stop': {
        // the UI's stop ends whatever runs: hand movement, an operation, a stack. A press's own
        // release (press set) only ends that hand movement.
        if (b.press) {
          await scope.stopMotion(b.press);
          return { ok: true, stopped: ['hand movement'] };
        }
        const { stopped } = await scope.stopWork();
        if (!stopped.includes('hand movement')) await scope.stopMotion();
        return { ok: true, stopped };
      }
      case 'home':
        // the Seestar keeps its own axis positions: home is raising the arm out of park
        return { result: (await scope.openArm()).state };
      case 'park':
        return { result: (await scope.park()).state };
      case 'level': {
        const l = await scope.level();
        return { result: `Tilt ${l.tiltDeg.toFixed(1)}° from level${scope.state.mount.eqMode ? ` (EQ mode: a wedge set for latitude ${(90 - l.tiltDeg).toFixed(1)}°; the site is at ${scope.location()?.lat.toFixed(1) ?? '?'}°)` : ''}`, ...l };
      }
      case 'photo':
        return { item: await capture.photo(b.camera === 'wide' ? 'wide' : 'tele') };
      case 'burst':
        return { result: await capture.burst(b.camera === 'wide' ? 'wide' : 'tele', b.count) };
      case 'record':
        if (b.camera === 'wide') throw unsupported({ label: LABEL }, 'Recording the wide camera');
        await scope.record(b.on !== false);
        return { result: b.on !== false ? 'Recording the tele camera to the Seestar (MyWorks/Scenery_video)' : 'Recording stopped: the video is in the Album' };
      case 'timelapse':
        return { result: await capture.timelapse(b.camera === 'wide' ? 'wide' : 'tele', b.on !== false, b.intervalS, b.totalS) };
      case 'mode': {
        const mode = MODES[b.mode.trim().toLowerCase()];
        if (!mode) throw unsupported({ label: LABEL }, `The ${b.mode} mode`);
        if (mode === 'sun') throw new Error('Sun mode is refused remotely: it is only safe with the solar filter fitted, which nobody can check from here');
        await scope.setViewMode(mode);
        return { result: `Mode ${b.mode}` };
      }
      case 'rgb':
        await scope.setLightBrightness(b.on ? 100 : 0);
        return { result: `Indicator light ${b.on ? 'on' : 'off'}` };
      case 'star_sweep': {
        const startedAt = Date.now();
        scope.state.focusTune = { running: true, startedAt, message: 'starting…' };
        scope.changed();
        try {
          const r = await seestarFocusSweep(scope, {
            center: b.center,
            range: b.range,
            step: b.step,
            apply: b.apply !== false,
            onProgress: (smp, i, n) => {
              scope.state.focusTune = { running: true, startedAt, message: `${i + 1}/${n} at ${smp.position}: ${smp.error ?? `HFR ${smp.hfrPx.toFixed(2)} px`}` };
              scope.changed();
            },
          });
          scope.state.focusTune = { running: false, startedAt, finishedAt: Date.now(), message: r.verdict };
          return { result: [r.verdict, ...r.notes].join(' — '), ...r };
        } catch (e) {
          scope.state.focusTune = { running: false, startedAt, finishedAt: Date.now(), message: `failed: ${(e as Error).message}` };
          throw e;
        } finally {
          scope.changed();
        }
      }
      case 'stack_start':
        await scope.startStack();
        return { result: 'Live stacking started' };
      case 'stack_stop':
        await scope.stopStack();
        return { ok: true };
      case 'autofocus':
        // the Seestar's autofocus is a star autofocus: the astro one is the same
        return { result: `autofocus ${(await scope.autofocus()).state}` };
      case 'focus': {
        // the focuser of the camera in the main view (the one being looked at); each camera has its own
        const camera = scope.selected;
        const at = await scope.focusBy(b.direction === 'near' ? -b.steps : b.steps, camera);
        return { result: `${camera} focuser at ${at ?? '?'}` };
      }
      case 'star_measure': {
        // one full-resolution tele frame, measured; the plate scale comes from the tele field
        const { img } = await liveFrame('tele');
        const fov = scope.state.fov ?? NOMINAL_FOV;
        const sharp = starSharpness(img, { arcsecPerPx: (fov.h * 3600) / (img.frameWidth ?? img.width) });
        return { result: sharpnessLine(sharp), focusPosition: scope.state.focus.position, ...sharp };
      }
      case 'setting': {
        // the stack sub length only: the live view's exposure is the stream's cadence
        if (b.setting === 'exposure') return { result: await scope.setExposure({ stackMs: exposureMs(b.value) }) };
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
        await scope.stopGoto();
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
        throw unsupported({ label: LABEL }, `"${(b as { action: string }).action}"`);
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
    api.get('/seestar/status', route(async () => ({ ...scope.state, busy: scope.isBusy(), selected: scope.selected, exposing: scope.exposing, images: { tele: scope.images.tele.status(), wide: scope.images.wide.status() } })));
    api.post('/seestar/refresh', route(async () => scope.refreshState()));
    api.get('/seestar/events', route(async () => scope.state.recent));
    api.get('/seestar/tunnel', route(async () => scope.tunnel?.status() ?? null));
    api.post('/seestar/tunnel/restart', route(async () => scope.tunnel?.restart()));
    api.get('/seestar/zwo-devices', route(async () => listDevices()));
    api.post(
      '/seestar/camera',
      route(async (req) => {
        const b = body(req, z.object({ camera: z.enum(['tele', 'wide']) }));
        await scope.selectCamera(b.camera, 'chosen in the web UI');
        return { selected: scope.selected, exposing: scope.exposing };
      }),
    );
    // Starfront's autonomous nights (agent tab), when STARFRONT_REMOTE_ZWO offers them
    api.get('/starfront', route(async () => nights?.status() ?? { available: false }));
    api.post(
      '/starfront',
      route(async (req) => {
        if (!nights) throw unsupported({ label: LABEL }, 'Autonomous Starfront nights (STARFRONT_REMOTE_ZWO=true, over ZWO Telescope Network)');
        return nights.setEnabled(body(req, z.object({ enabled: z.boolean() })).enabled);
      }),
    );
    api.post(
      '/seestar/rpc',
      route(async (req) => {
        const b = body(req, z.object({ method: z.string().min(1), params: z.unknown().optional() }));
        return scope.raw(b.method, b.params);
      }),
    );
    // one raw (Bayer, 16-bit) frame of a camera as FITS, for measuring the sensor's real levels; nothing is saved
    api.get(
      '/seestar/raw.fits',
      route(async (req, res) => {
        const camera = req.query.camera === 'wide' ? 'wide' : 'tele';
        const f = await scope.withCamera(camera, `a raw ${camera} frame`, () => scope.grabRaw(camera));
        const { width, height } = f.header;
        const px = framePixels(f.payload, width * height * 2, `raw frame of ${f.payload.length} B`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('application/fits').send(bayerFits(px, width, height, { BAYERPAT: 'GRBG', WIDECAM: camera === 'wide' ? 1 : 0 }));
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
    const w = event === 'state' ? () => fn(projectState(scope)) : (e: SeestarEvent) => fn({ name: e.Event, data: e, ts: e.at });
    listeners.set(fn, w);
    return w;
  };

  return {
    driver: 'seestar',
    label: LABEL,
    get state() {
      return projectState(scope);
    },
    capabilities: CAPABILITIES,
    nudgeCurve: NUDGE_CURVE,
    hub,
    location: () => scope.location(),
    requireLocation: () => scope.requireLocation(),
    teleFovDeg: () => scope.state.fov ?? NOMINAL_FOV,
    connectLink: () => scope.connectLink(),
    release: () => scope.release(),
    setHost: (host) => scope.setHost(host),
    control,
    goto,
    switches: seestarSwitches(scope),
    routes,
    wireLines: (n, o) => scope.link.wireLines(n, o),
    horizonSurvey: {
      start: async (o) => ({ summary: (await survey.run({ rehearsal: o.rehearsal })).summary }),
      stop: async () => survey.stop(),
      assertAllowed: (o) => survey.assertAllowed(o),
    },
    on: (event, fn) => scope.on(event === 'state' ? 'state' : 'event', wrap(event, fn)),
    off: (event, fn) => {
      const w = listeners.get(fn);
      if (!w) return scope;
      listeners.delete(fn);
      return scope.off(event === 'state' ? 'state' : 'event', w);
    },
  };
}
