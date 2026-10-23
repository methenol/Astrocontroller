/** Calibration, GoTo, live stacking, polar alignment, Sun/Moon and daytime tracking, sentry. */
import { z } from 'zod';
import { errMsg, logger } from '../../log.js';
import { round, type CameraName, type Dwarf } from '../../drivers/dwarf/device.js';
import { findObject, gotoLabel } from '../../astro/catalog.js';
import * as sky from '../../astro/sky.js';
import * as library from '../../library/transfer.js';
import { cameraArg, sleep, text, type ToolContext, type ToolFn } from './common.js';

const log = logger('mcp');

/** -11501 ASTRO_FUNCTION_BUSY: the astro service refuses although (as far as the controller sees) nothing runs. */
const ASTRO_BUSY = /-11501/;
const MIN_GOTO_ALTITUDE_DEG = 5;
/** Total polar-axis error (°) below which the alignment is excellent, good, or fine for short subs. */
const POLAR_EXCELLENT_DEG = 0.1;
const POLAR_GOOD_DEG = 0.25;
const POLAR_ACCEPTABLE_DEG = 0.5;
/** A polar-axis error under this (°) on one axis needs no adjustment. */
const POLAR_ON_DEG = 0.05;

/** Refuse a GoTo to a position below the horizon: the scope would slew for minutes and then fail. */
function assertAboveHorizon(what: string, altitude: number): void {
  if (altitude < MIN_GOTO_ALTITUDE_DEG) throw new Error(`${what} is below the horizon (altitude ${altitude.toFixed(1)}°; GoTo needs at least ${MIN_GOTO_ALTITUDE_DEG}°). Nothing was moved.`);
}

/**
 * -11501 while the controller sees nothing running is the stuck astro service (2026-10-11 00:13).
 * Recover and retry once; a second refusal recovers again with a motor re-home and retries a last
 * time. Then the power cycle is the user's call. The outcome is recorded in state.astroRecovery.
 */
export async function withAstroBusyRecovery<T>(dwarf: Dwarf, what: string, fn: () => Promise<T>): Promise<T> {
  const record = (ok: boolean) => {
    const r = dwarf.state.astroRecovery;
    if (r) dwarf.publishState({ astroRecovery: { ...r, ok } });
  };
  const tried: string[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn();
      if (attempt > 0) record(true);
      return r;
    } catch (err) {
      const stuck = ASTRO_BUSY.test(errMsg(err)) && !dwarf.isBusy();
      if (!stuck) {
        // a different failure (after a recovery, or none was needed): the telescope's own error, as it is
        if (attempt > 0) record(false);
        throw err;
      }
      if (attempt >= 2) {
        record(false);
        throw new Error(
          `${errMsg(err)}. Astrocontroller ran astro_recover ${attempt} time(s) before this attempt (${tried.join(' | ')}) and ${what} is still refused: the astro service stays stuck. Ask the user to power-cycle the telescope (then motors_home and sync_time_and_location).`,
        );
      }
      log.warn(`${what} refused with ASTRO_FUNCTION_BUSY while nothing runs: astro service recovery ${attempt + 1}`);
      const { steps } = await dwarf.recoverAstroService({ rehome: attempt === 1 });
      tried.push(steps.join(', '));
      await sleep(3000);
    }
  }
}

export function registerAstroTools(tool: ToolFn, { dwarf, hub }: ToolContext): void {
  /** A GoTo with both recoveries; the two failures that are easy to misread get an explanation. */
  const goto = async (what: string, fn: () => Promise<string>): Promise<string> => {
    try {
      return await withAstroBusyRecovery(dwarf, what, () => dwarf.withPointingRecovery('GoTo', fn));
    } catch (err) {
      const m = errMsg(err);
      if (/-11504/.test(m)) {
        throw new Error(`${m} Calibration failed because plate-solving found no usable stars (cloud, obstruction, dew or daylight) at this pointing. Check the sky with sky_check (other directions too) before retrying.`);
      }
      if (/timed out/i.test(m)) throw new Error(`${m} The GoTo did not finish; this is NOT a cloud verdict. Check telescope_status.health: a hung camera service also stops plate-solving.`);
      throw err;
    }
  };

  tool(
    'calibrate',
    'Astro calibration (plate-solve the sky to learn pointing). Needs a clear sky, synced time/location, DSO mode, and motors homed. Takes ~1-3 minutes and returns when the telescope reports the result (or that plate-solving failed). Required before goto_target unless one_click is used.',
    {},
    async () => text(await dwarf.withPointingRecovery('calibration', () => dwarf.calibrate())),
  );

  tool(
    'goto_target',
    "Slew to and track a target. Give a name (catalog object or planet/Moon/Sun) or ra_hours+dec_deg (J2000). one_click (default true) = calibrate + GoTo in one step. Returns when the telescope reports it is tracking the target (usually 1-3 minutes, at most 10), or with the telescope's error code. NEVER point at the Sun without a solar filter.",
    {
      name: z.string().optional(),
      ra_hours: z.number().min(0).lt(24).optional(),
      dec_deg: z.number().min(-90).max(90).optional(),
      one_click: z.boolean().optional(),
    },
    async ({ name, ra_hours, dec_deg, one_click }) => {
      const oneClick = one_click !== false;
      if ((ra_hours === undefined) !== (dec_deg === undefined)) throw new Error('give both ra_hours and dec_deg, or a name. Nothing was moved.');
      if (ra_hours !== undefined && dec_deg !== undefined) {
        assertAboveHorizon(`RA ${sky.hoursToHms(ra_hours)} Dec ${sky.degToDms(dec_deg)}`, sky.altAz(dwarf.requireLocation(), ra_hours, dec_deg).altitude);
        return text(await goto('GoTo', () => dwarf.gotoRaDec(ra_hours, dec_deg, name ?? 'Custom', oneClick)));
      }
      if (!name) throw new Error('give a target name or ra_hours + dec_deg');
      const body = sky.bodyByName(name);
      if (body) {
        if (body === 'Sun') throw new Error('Pointing at the Sun requires the solar filter fitted. Use track_sun_moon after the user confirms the filter is on.');
        assertAboveHorizon(body, sky.bodyAlt(dwarf.requireLocation(), body));
        return text(await goto(`GoTo ${body}`, () => dwarf.gotoSolarSystem(body, oneClick)));
      }
      const o = findObject(name);
      if (!o) throw new Error(`"${name}" not found; use find_target or give coordinates`);
      const alt = sky.altAz(dwarf.requireLocation(), o.raHours, o.decDeg).altitude;
      assertAboveHorizon(o.id, alt);
      // The scope names the session folder after this (see gotoLabel): the DWARF app's choice, so
      // nights captured with the app and with Astrocontroller carry the same name and stack together.
      const label = gotoLabel(o);
      return text(await goto(`GoTo ${label}`, () => dwarf.gotoRaDec(o.raHours, o.decDeg, label, oneClick)));
    },
  );

  tool(
    'astro_recover',
    "Release a stuck astro service without a power cycle: sends every astro stop, 'go live' for both cameras, re-enters the camera and re-homes the motors if they lost their reference (rehome=true re-homes anyway). For when GoTo / live stacking are refused with -11501 ASTRO_FUNCTION_BUSY although nothing runs, or the scope stopped a stack by itself and then refuses commands. goto_target and live_stacking start already run it once by themselves on -11501. Afterwards retry what was refused; only if that still fails, ask the user to power-cycle the telescope.",
    { rehome: z.boolean().optional() },
    async ({ rehome }) => text(await dwarf.recoverAstroService({ rehome })),
  );

  tool('stop_goto', 'Abort a running GoTo / one-click GoTo.', {}, async () => {
    await dwarf.stopGoto();
    return text('goto stopped');
  });

  tool(
    'live_stacking',
    'Start or stop deep-sky live stacking (in DSO mode, after GoTo). On start you may set exposure (s), gain, filter (VIS/Astro/Duo-Band) and frame count first. Raw FITS subframes are saved on the SD card. Start returns once the telescope reports stacking; stop once it reports it stopped (normal stop lets the final stack finish; fast_stop skips it). If the scope ends a stack by itself (frame count reached), Astrocontroller tells you with an event.',
    {
      action: z.enum(['start', 'stop']),
      camera: cameraArg.optional(),
      exposure: z.union([z.string(), z.number()]).optional(),
      gain: z.number().optional(),
      filter: z.string().optional(),
      frames: z.number().int().min(1).max(999).optional(),
      force: z.boolean().optional().describe('start even if the device thinks calibration/GoTo is missing'),
      fast_stop: z.boolean().optional(),
    },
    async (a) => {
      const cam: CameraName = a.camera ?? 'tele';
      if (a.action === 'stop') {
        await dwarf.stopStacking(cam, a.fast_stop);
        return text({ stopped: cam, final: dwarf.state.stacking[cam] });
      }
      return text(
        await withAstroBusyRecovery(dwarf, 'starting live stacking', () =>
          dwarf.startStackingWith(cam, { exposure: a.exposure, gain: a.gain, filter: a.filter, frames: a.frames, force: a.force, startedBy: 'agent' }),
        ),
      );
    },
  );

  tool(
    'stacking_status',
    'Live-stacking progress: frames taken/stacked/target, integration time, target, plus whether frames are being rejected. Use view_camera source "stack" to see the stacked image. After a stop and restart on the same target the telescope keeps counting from the earlier stack but writes the new subs to a NEW DWARF_RAW session folder (verified 2026-10-04): process those sessions together (process_session target=…).',
    {},
    async () => {
      const s = dwarf.state.stacking;
      // fw 1.5.3 progress messages carry no stacked time: stacked subs × the sub exposure of the
      // running session (its folder name says EXP_<s>): the newest session of that camera
      const subS: Partial<Record<CameraName, number>> = {};
      if (s.tele.state === 'running' || s.wide.state === 'running') {
        const listed = await library.listDeviceSessions(false).catch(() => null);
        for (const cam of ['tele', 'wide'] as const) subS[cam] = listed?.sessions.find((x) => x.camera === cam)?.exposureS;
      }
      const describe = (x: typeof s.tele, sub: number | undefined) => ({
        ...x,
        rejected: x.currentCount !== undefined && x.stackedCount !== undefined ? x.currentCount - x.stackedCount : undefined,
        subExposureS: x.state === 'running' ? sub : undefined,
        integrationMinutes: x.stackedTimeS !== undefined ? round(x.stackedTimeS / 60, 1) : x.stackedCount !== undefined && sub ? round((x.stackedCount * sub) / 60, 1) : undefined,
        lastUpdateAgoS: x.updatedAt ? Math.round((Date.now() - x.updatedAt) / 1000) : undefined,
      });
      const preview = hub.stack.latest;
      return text({ tele: describe(s.tele, subS.tele), wide: describe(s.wide, subS.wide), stackPreviewAvailable: !!preview, stackPreviewAgeS: preview ? Math.round((Date.now() - preview.at) / 1000) : null });
    },
  );

  tool(
    'polar_alignment',
    'EQ-mode polar alignment helper (Dwarf 3 tilted on its side/wedge with the base aimed at the celestial pole). measure: the scope plate-solves two positions and returns the polar axis error in azimuth and altitude (degrees). Adjust the tripod/wedge and measure again until both are below ~0.5° (ideally < 0.2°). stop aborts.',
    { action: z.enum(['measure', 'stop']) },
    async ({ action }) => {
      if (action === 'stop') {
        await dwarf.stopPolarAlignment();
        return text('polar alignment stopped');
      }
      const prev = dwarf.state.eqSolving.result;
      const r = await dwarf.measurePolarAlignment();
      const total = Math.hypot(r.azimuthErrorDeg, r.altitudeErrorDeg);
      const fmt = (d: number) => `${d >= 0 ? '+' : ''}${d.toFixed(3)}° (${(d * 60).toFixed(1)}′)`;
      const out: Record<string, unknown> = {
        azimuthError: fmt(r.azimuthErrorDeg),
        altitudeError: fmt(r.altitudeErrorDeg),
        totalErrorArcmin: round(total * 60, 1),
        quality: total < POLAR_EXCELLENT_DEG ? 'excellent' : total < POLAR_GOOD_DEG ? 'good' : total < POLAR_ACCEPTABLE_DEG ? 'acceptable for short exposures' : 'needs adjustment',
        bodyMode: dwarf.state.bodyMode,
      };
      // where the rotation axis points against where the pole is (the latitude): what the
      // firmware's own measurement says needs to change, without assuming how the wedge is set
      const lat = dwarf.location()?.lat;
      if (lat !== undefined) {
        // the visible pole: north at azimuth 0 in the northern hemisphere, south at 180 in the southern
        const poleAlt = Math.abs(lat);
        const poleAz = lat >= 0 ? 0 : 180;
        const axisAlt = poleAlt - r.altitudeErrorDeg;
        const axisAz = (((poleAz - r.azimuthErrorDeg) % 360) + 360) % 360;
        out.rotationAxis = `points at altitude ${axisAlt.toFixed(1)}°, azimuth ${axisAz.toFixed(1)}°; the celestial pole is at altitude ${poleAlt.toFixed(1)}°, azimuth ${poleAz}°`;
        const altFix = Math.abs(r.altitudeErrorDeg) >= POLAR_ON_DEG ? `${r.altitudeErrorDeg < 0 ? 'lower' : 'raise'} the rotation axis by ${Math.abs(r.altitudeErrorDeg).toFixed(1)}°` : 'altitude is on';
        const aziFix = Math.abs(r.azimuthErrorDeg) >= POLAR_ON_DEG ? `turn it ${Math.abs(r.azimuthErrorDeg).toFixed(1)}° ${r.azimuthErrorDeg < 0 ? 'east' : 'west'} (to be confirmed by the next measurement)` : 'azimuth is on';
        out.correction = `${altFix}; ${aziFix}. Measure again after each adjustment (about 15 s). EQ mode engages only once the error is small; until then GoTo cannot work on a tilted base.`;
      }
      if (prev) {
        out.previous = { azimuthErrorDeg: round(prev.azimuthErrorDeg, 3), altitudeErrorDeg: round(prev.altitudeErrorDeg, 3) };
        const trend = (now: number, before: number, axis: string) => (Math.abs(now) < Math.abs(before) ? 'improved — keep turning the same way' : `got worse — reverse the ${axis} adjustment`);
        out.change = { azimuth: trend(r.azimuthErrorDeg, prev.azimuthErrorDeg, 'azimuth'), altitude: trend(r.altitudeErrorDeg, prev.altitudeErrorDeg, 'altitude') };
      }
      return text(out);
    },
  );

  tool(
    'track_sun_moon',
    'Start/stop the dedicated Sun or Moon tracking mode. SUN: only after the user confirms the solar filter is fitted on the tele lens.',
    { body: z.enum(['sun', 'moon']), action: z.enum(['start', 'stop']), solar_filter_confirmed: z.boolean().optional() },
    async ({ body, action, solar_filter_confirmed }) => {
      if (action === 'start') {
        if (body === 'sun' && !solar_filter_confirmed) throw new Error('Ask the user to confirm the solar filter is fitted, then call again with solar_filter_confirmed=true');
        // refused before the mode switch: a refusal must leave the telescope as it was
        dwarf.assertNoNdLock(`${body} tracking`);
        dwarf.assertNoOperation(`${body} tracking`);
        await dwarf.ensureMode(body === 'sun' ? 'Sun' : 'Moon');
      }
      await dwarf.trackSunMoon(body, action);
      return text(`${body} tracking ${action === 'start' ? 'started' : 'stopped'}`);
    },
  );

  tool(
    'track_object',
    'Lock onto and follow a moving/static object (birds, animals, vehicles, aircraft) by its bounding box in the 1920×1080 frame of the chosen camera. Use view_camera first to find the box. action stop ends tracking.',
    {
      action: z.enum(['start', 'stop']),
      camera: cameraArg.optional(),
      x: z.number().min(0).max(1920).optional().describe('box left, px in 1920×1080'),
      y: z.number().min(0).max(1080).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    },
    async ({ action, camera, x, y, width, height }) => {
      if (action === 'stop') {
        await dwarf.stopTracking();
        return text('tracking stopped');
      }
      if (x === undefined || y === undefined || width === undefined || height === undefined) throw new Error('x, y, width, height are required');
      const cam = camera ?? 'tele';
      await dwarf.trackObject(cam, { x, y, w: width, h: height });
      return text(`tracking started on ${cam} box (${x},${y},${width}×${height}); results stream in telescope_status.trackResult`);
    },
  );

  tool(
    'sentry_mode',
    'Automatic detection & tracking (sentry): the telescope watches with the wide camera and tracks objects that appear. Not available on the DWARF 3 as of firmware 1.5.3.9 (verified: the telescope ignores the command; this tool then says so) — use track_object there. object_type: 0 any/UFO, 2 bird, 3 person, 4 animal, 5 vehicle, 6 flying object, 7 boat.',
    { action: z.enum(['start', 'stop']), object_type: z.number().int().min(0).max(7).optional() },
    async ({ action, object_type }) => {
      await dwarf.sentry(action, object_type ?? 0);
      return text(`sentry mode ${action === 'start' ? 'started' : 'stopped'}`);
    },
  );
}
