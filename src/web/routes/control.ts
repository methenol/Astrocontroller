/**
 * Manual control from the web UI. Each action is validated before anything is sent; the
 * controller's own guards (ND lock, exclusive operations, a running stack) still apply.
 */
import express, { type Router } from 'express';
import { z } from 'zod';
import { BURST_MAX, type CameraName } from '../../drivers/dwarf/device.js';
import * as sky from '../../astro/sky.js';
import { findObject, gotoLabel } from '../../astro/catalog.js';
import { measureTele, starFocusSweep, sharpnessLine } from '../../media/focus.js';
import { withAstroBusyRecovery } from '../../mcp/tools/astro.js';
import { body, notFound, badRequest, route } from '../http.js';
import { requireSite, type WebContext } from '../context.js';

/** GoTo from the UI refuses targets lower than this (the firmware would fail them anyway). */
const MIN_GOTO_ALTITUDE_DEG = 5;
const LEVEL_PITCH_DEG = 90;
/** the web UI's Burst button takes at least this many frames */
const BURST_MIN_UI = 3;

const camera = z.enum(['tele', 'wide']).optional();
const num = z.coerce.number().refine(Number.isFinite, 'must be a number');

export const ControlBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('nudge'), angle: num.default(0), speed: num.min(0).max(1).default(0.5), ms: num.int().min(50).max(5000).default(600) }),
  z.object({ action: z.enum(['stop', 'home', 'park', 'level', 'goto_stop', 'sync', 'liveview', 'reboot', 'shutdown']) }),
  z.object({ action: z.literal('photo'), camera }),
  z.object({ action: z.literal('burst'), camera, count: num.int().default(10) }),
  z.object({ action: z.literal('record'), camera, on: z.boolean().optional() }),
  z.object({ action: z.literal('timelapse'), camera, on: z.boolean().optional(), intervalS: num.min(0).max(60).optional(), totalS: num.min(0).optional() }),
  z.object({ action: z.literal('stack_start'), camera }),
  z.object({ action: z.literal('stack_stop'), camera, fast: z.boolean().optional() }),
  z.object({ action: z.literal('autofocus'), mode: z.enum(['normal', 'astro']).optional() }),
  z.object({ action: z.literal('focus'), direction: z.enum(['near', 'far']).optional(), steps: num.int().min(1).max(200).default(1) }),
  z.object({ action: z.literal('star_measure'), exposureS: num.positive().max(60).optional() }),
  z.object({ action: z.literal('star_sweep'), center: num.optional(), range: num.positive().optional(), step: num.positive().optional(), apply: z.boolean().optional() }),
  z.object({ action: z.literal('mode'), mode: z.string().min(1) }),
  z.object({ action: z.literal('setting'), camera, setting: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ action: z.literal('settings'), camera }),
  z.object({ action: z.literal('rgb'), on: z.boolean().optional() }),
  z.object({ action: z.literal('find'), name: z.string().default('') }),
  z.object({ action: z.literal('goto'), name: z.string().min(1), oneClick: z.boolean().optional() }),
]);

export function controlRoutes({ dwarf, hub, duty }: WebContext): Router {
  const api = express.Router();

  api.post(
    '/control',
    route(async (req) => {
      const b = body(req, ControlBody);
      const cam: CameraName = 'camera' in b && b.camera === 'wide' ? 'wide' : 'tele';
      switch (b.action) {
        case 'nudge':
          await dwarf.nudge(b.angle, b.speed, b.ms);
          return dwarf.readMotorPositions();
        case 'stop':
          await dwarf.stopMotion();
          return { ok: true };
        case 'home':
          return { result: await dwarf.homeMotors() };
        case 'park':
          return { result: await dwarf.park() };
        case 'level':
          return { result: await dwarf.moveTo({ pitchDeg: LEVEL_PITCH_DEG }) };
        case 'photo':
          return { item: await dwarf.takePhoto(cam) };
        case 'burst':
          return { result: await dwarf.burst(cam, Math.max(BURST_MIN_UI, Math.min(BURST_MAX, b.count))) };
        case 'record':
          return { result: await dwarf.record(cam, b.on ? 'start' : 'stop') };
        case 'timelapse':
          return { result: await dwarf.timelapse(cam, b.on ? 'start' : 'stop', b.intervalS, b.totalS) };
        case 'stack_start':
          // the same recovery as the agent's start: -11501 while nothing runs is the stuck astro service
          return { result: await withAstroBusyRecovery(dwarf, 'starting live stacking', () => dwarf.startStackingWith(cam, { startedBy: 'ui' })) };
        case 'stack_stop':
          await dwarf.stopStacking(cam, !!b.fast);
          return { ok: true };
        case 'autofocus':
          return { result: await dwarf.autofocus(b.mode === 'astro' ? 'astro' : 'normal') };
        case 'focus':
          return { result: await dwarf.focusStep(b.direction === 'near' ? 'near' : 'far', b.steps) };
        case 'star_measure': {
          // One tele frame measured for star sharpness; the camera's exposure is restored by the helper.
          const { sharp } = await measureTele({ dwarf, hub }, { exposureS: b.exposureS });
          return { result: sharpnessLine(sharp), focusPosition: dwarf.state.focusPosition, ...sharp };
        }
        case 'star_sweep': {
          // The search writes its own plain-language verdict; the UI toasts it and the progress arrives
          // over the state socket, so the response only has to be the summary.
          const r = await starFocusSweep({ dwarf, hub }, { center: b.center, range: b.range, step: b.step, apply: b.apply !== false });
          return { result: [r.verdict, ...r.notes].join(' — '), ...r };
        }
        case 'mode':
          return dwarf.setShootingMode(b.mode);
        case 'setting':
          return { result: await dwarf.setSetting(cam, b.setting, b.value) };
        case 'settings':
          return dwarf.cameraSettings(cam);
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
        case 'reboot':
          await dwarf.power('reboot');
          duty.event('the user rebooted the telescope from the web UI (it reconnects in about a minute; then motors_home and sync_time_and_location)', true);
          return { result: 'Reboot sent: the telescope reconnects in about a minute' };
        case 'shutdown':
          await dwarf.power('shutdown');
          duty.event('the user shut the telescope down from the web UI', true);
          return { result: 'Shutdown sent' };
        case 'find':
          return findObject(b.name) ?? { error: 'not found' };
        case 'goto': {
          // GoTo from the Database tab: a catalog object by name, one-click (calibrate + GoTo) by default.
          const o = findObject(b.name);
          if (!o) throw notFound(`"${b.name}" is not in the database`);
          const alt = sky.altAz(requireSite(dwarf), o.raHours, o.decDeg).altitude;
          if (alt < MIN_GOTO_ALTITUDE_DEG) throw badRequest(`${o.id} is below the horizon (altitude ${alt.toFixed(1)}°)`);
          const label = gotoLabel(o);
          duty.event(`the user started a GoTo to ${label} from the web UI`, true);
          return { result: await withAstroBusyRecovery(dwarf, `GoTo ${label}`, () => dwarf.withPointingRecovery('GoTo', () => dwarf.gotoRaDec(o.raHours, o.decDeg, label, b.oneClick !== false))) };
        }
      }
    }),
  );

  return api;
}
