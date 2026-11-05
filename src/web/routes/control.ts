/**
 * Manual control from the web UI, for every driver. Each action is validated and checked against
 * what the driver's telescope can do before anything is sent; GoTo targets are resolved and
 * checked here (altitude, the Sun) and the driver only carries them out. The drivers' own guards
 * (the Dwarf's ND lock, exclusive operations, a running stack) still apply.
 */
import express, { type Router } from 'express';
import { z } from 'zod';
import * as sky from '../../astro/sky.js';
import { findObject, gotoLabel } from '../../astro/catalog.js';
import { resolveSkyTarget } from '../../astro/sky-target.js';
import { body, notFound, badRequest, route } from '../http.js';
import { requireSite, type WebContext } from '../context.js';
import { unsupported, type Capabilities } from '../telescope.js';

/** GoTo from the UI refuses targets lower than this (the firmware would fail them anyway). */
const MIN_GOTO_ALTITUDE_DEG = 5;

const camera = z.enum(['tele', 'wide']).optional();
const num = z.coerce.number().refine(Number.isFinite, 'must be a number');

export const ControlBody = z.discriminatedUnion('action', [
  // press: the web press a held arrow renews (its release stops it, and only it)
  z.object({ action: z.literal('nudge'), angle: num.default(0), speed: num.min(0).max(1).default(0.5), ms: num.int().min(50).max(5000).default(600), press: z.string().max(64).optional() }),
  z.object({ action: z.literal('stop'), press: z.string().max(64).optional() }),
  z.object({ action: z.enum(['home', 'park', 'level', 'goto_stop', 'polar_align', 'polar_stop', 'sync', 'liveview', 'reboot', 'shutdown']) }),
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
  z.object({ action: z.literal('goto_sky'), name: z.string().trim().max(120).optional(), raHours: num.min(0).lt(24), decDeg: num.min(-90).max(90), oneClick: z.boolean().optional() }),
]);

/** A control the driver carries out (GoTo and find are resolved here first). */
export type ControlAction = Exclude<z.infer<typeof ControlBody>, { action: 'find' | 'goto' | 'goto_sky' }>;

/** The capability each driver action needs, and what the refusal calls it. */
const NEEDS: Record<ControlAction['action'], [keyof Capabilities, string]> = {
  nudge: ['nudge', 'Manual slewing'],
  stop: ['nudge', 'Stopping motion'],
  home: ['home', 'Homing the motors'],
  park: ['park', 'Park'],
  level: ['level', 'Level'],
  goto_stop: ['goto', 'Stopping a GoTo'],
  polar_align: ['polarAlign', 'Polar alignment'],
  polar_stop: ['polarAlign', 'Polar alignment'],
  sync: ['sync', 'Time and location sync'],
  liveview: ['liveView', 'Live view'],
  reboot: ['reboot', 'Reboot'],
  shutdown: ['shutdown', 'Shut down'],
  photo: ['photo', 'Taking a photo'],
  burst: ['burst', 'Burst'],
  record: ['record', 'Video recording'],
  timelapse: ['timelapse', 'Timelapse'],
  stack_start: ['stack', 'Live stacking'],
  stack_stop: ['stack', 'Live stacking'],
  autofocus: ['autofocus', 'Autofocus'],
  focus: ['focusSteps', 'Manual focus'],
  star_measure: ['starFocus', 'Star sharpness'],
  star_sweep: ['starTune', 'Star focus tuning'],
  mode: ['modes', 'Shooting modes'],
  setting: ['exposure', 'Camera settings'],
  settings: ['exposure', 'Camera settings'],
  rgb: ['rgb', 'The ring light'],
};

export function controlRoutes({ scope, duty }: WebContext): Router {
  const api = express.Router();

  api.post(
    '/control',
    route(async (req) => {
      const b = body(req, ControlBody);
      switch (b.action) {
        case 'find':
          return findObject(b.name) ?? { error: 'not found' };
        case 'goto': {
          // GoTo from the Database tab: a catalog object by name, one-click (calibrate + GoTo) by default.
          if (!scope.capabilities.goto) throw unsupported(scope, 'GoTo');
          const o = findObject(b.name);
          if (!o) throw notFound(`"${b.name}" is not in the database`);
          const alt = sky.altAz(requireSite(scope), o.raHours, o.decDeg).altitude;
          if (alt < MIN_GOTO_ALTITUDE_DEG) throw badRequest(`${o.id} is below the horizon (altitude ${alt.toFixed(1)}°)`);
          const label = gotoLabel(o);
          duty.event(`the user started a GoTo to ${label} from the web UI`, true);
          return { result: await scope.goto({ kind: 'position', label, raHours: o.raHours, decDeg: o.decDeg, oneClick: b.oneClick !== false }) };
        }
        case 'goto_sky': {
          // GoTo from the Stellarium tab: whatever was picked on the map, a planet, a catalog object or a bare position.
          if (!scope.capabilities.goto) throw unsupported(scope, 'GoTo');
          const site = requireSite(scope);
          const t = resolveSkyTarget(b.name, b.raHours, b.decDeg);
          const oneClick = b.oneClick !== false;
          if (t.kind === 'body' && t.body === 'Sun') throw badRequest('Pointing at the Sun requires the solar filter fitted; use Sun tracking after fitting it');
          const alt = t.kind === 'body' ? sky.bodyAlt(site, t.body) : sky.altAz(site, t.raHours, t.decDeg).altitude;
          if (alt < MIN_GOTO_ALTITUDE_DEG) throw badRequest(`${t.label} is below the horizon (altitude ${alt.toFixed(1)}°)`);
          const framing = t.kind === 'catalog' && t.framed ? ` framed off-centre at RA ${sky.hoursToHms(t.raHours)} Dec ${sky.degToDms(t.decDeg)}` : '';
          duty.event(`the user started a GoTo to ${t.label}${framing} from the Stellarium tab`, true);
          const go = t.kind === 'body' ? { kind: 'body' as const, body: t.body, label: t.label, oneClick } : { kind: 'position' as const, label: t.label, raHours: t.raHours, decDeg: t.decDeg, oneClick };
          return { result: await scope.goto(go), target: t.label };
        }
        default: {
          const [cap, what] = NEEDS[b.action];
          const astroAf = b.action === 'autofocus' && b.mode === 'astro';
          const gainOnly = (b.action === 'setting' && b.setting === 'gain') || b.action === 'settings';
          const able = astroAf ? scope.capabilities.autofocusAstro : gainOnly ? scope.capabilities.gain || scope.capabilities.exposure : scope.capabilities[cap];
          if (!able) throw unsupported(scope, astroAf ? 'Astro autofocus' : what);
          if (b.action === 'polar_align') duty.event('the user started an EQ polar alignment measurement from the web UI', true);
          const r = await scope.control(b);
          if (b.action === 'reboot') duty.event(`the user rebooted the telescope from the web UI (it reconnects in about a minute${scope.driver === 'dwarf' ? '; then motors_home and sync_time_and_location' : ''})`, true);
          if (b.action === 'shutdown') duty.event('the user shut the telescope down from the web UI', true);
          return r;
        }
      }
    }),
  );

  return api;
}
