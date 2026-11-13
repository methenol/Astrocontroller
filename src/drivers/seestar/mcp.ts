/**
 * The Seestar's tools as an MCP server (`seestar`: they reach the agent as mcp__seestar__<tool>).
 *
 * The Seestar runs its own pipeline: a GoTo plate-solves and centres by itself, and a stack is
 * registered and integrated on the scope, so these tools start and follow the scope's operations
 * instead of driving each step. Catalog, planning and image analysis are the app's shared ones.
 */
import { z } from 'zod';
import { config, planDefaults } from '../../config.js';
import { describe as describeObject, findObject, gotoLabel, searchObjects } from '../../astro/catalog.js';
import { horizonFor } from '../../astro/horizon.js';
import { planNight } from '../../astro/planner.js';
import * as rest from '../../astro/rest.js';
import * as sky from '../../astro/sky.js';
import * as weather from '../../astro/weather.js';
import { starSharpness } from '../../media/focus/sharpness.js';
import { analyze } from '../../media/images.js';
import { imageResult, localTime, makeTool, text, type ToolFn } from '../../mcp/tools/common.js';
import { registerDutyTools } from '../../mcp/tools/duty.js';
import { registerLibraryTools } from '../../mcp/tools/library.js';
import { registerPlanningTools } from '../../mcp/tools/planning.js';
import { registerResearchTools } from '../../mcp/tools/research.js';
import { registerStellariumTools } from '../../mcp/tools/stellarium.js';
import { registerMapObstructions } from '../../mcp/tools/horizon.js';
import type { DutyLoop } from '../../agent/duty.js';
import type { StarfrontNights } from '../../agent/starfront.js';
import type { NightServices } from '../../night/index.js';
import { registerNightTools } from '../../mcp/tools/night.js';
import { registerMosaicTools } from '../../mcp/tools/mosaic.js';
import { registerAcquisitionTools } from '../../mcp/tools/acquisition.js';
import { seestarProbeDriver } from './probe.js';
import { pickDevice } from '../../astro/acquisition/devices.js';
import { seestarFacts } from './acquisition.js';
import type { McpSpec } from '../types.js';
import { NUDGE_MAX_PERCENT, NUDGE_MAX_S, type Seestar } from './device.js';
import { NOMINAL_FOV } from './focus.js';
import { pair, withJ2000 } from './model.js';
import { registerSeestarMediaTools } from './mcp-media.js';
import { registerSeestarParityTools } from './mcp-parity.js';
import type { SeestarMedia } from './web.js';
import { listDevices } from './zwo-cloud.js';

export const SERVER_NAME = 'seestar';
const SUN_WARN_DEG = 15;

const INSTRUCTIONS = `Tools for a ZWO Seestar smart telescope, over its native JSON-RPC link (on the local network, or through ZWO Telescope Network via a seestar-portfwd tunnel on 127.0.0.1).
Start with seestar_status. The Seestar runs its own pipeline: goto_target slews, plate-solves and centres in one operation and blocks until the scope reports it done; stacking is integrated on the scope (start_stacking / stop_stacking, get_image to look at the stack). Autofocus, park and polar alignment also block until the scope reports their end.
The scope exposes one camera at a time (tele or wide): the one chosen as the main view in the web UI, or with select_camera. Tools that need the other camera borrow it for the frame and give it back.
Only one operation runs at a time. Over ZWO Telescope Network only one remote session exists per telescope: connecting takes it from the official app.
Coordinates are J2000 (RA in hours, Dec in degrees). Never point at the Sun without the user confirming a solar filter.`;

/** The target counts as centred within this fraction of the frame's short side (≈4′ on an S50). */
const CENTRE_TOLERANCE = 0.05;

export function seestarMcpSpec(scope: Seestar, duty?: DutyLoop, media?: SeestarMedia, nights?: StarfrontNights | null, night?: NightServices | null): McpSpec {
  return {
    name: SERVER_NAME,
    instructions: INSTRUCTIONS,
    register: (server) => {
      const tool = makeTool(server);
      registerSeestarTools(tool, scope);
      // the app's shared tools, the same for every driver (find_target and plan_targets are the Seestar's own above)
      registerPlanningTools(tool, { site: () => scope.requireLocation(), teleFov: () => scope.state.fov ?? NOMINAL_FOV, skip: ['find_target', 'plan_targets'], restChanged: () => night?.plan.changed('the target memory changed') });
      if (media) {
        registerSeestarMediaTools(tool, scope, media);
        // the Dwarf agent's other tools, under their names
        registerSeestarParityTools(tool, scope, media);
        registerMapObstructions(tool, {
          site: () => scope.requireLocation(),
          run: async () => media.survey.run(),
          stop: async () => media.survey.stop(),
          running: () => media.survey.isRunning,
          progress: () => scope.state.horizonSurvey,
          how: "a plate-solved GoTo to the sky at 65° fixes the pointing; the wide camera's focus is put at its factory infinity and checked on the stars (swept if soft); then the Seestar slews round at ~15° and ~40° altitude (higher where something runs off the top) taking wide frames, each placed by the mount's alt/az, and the map (with a panorama picture) is built and saved for this site, like the Dwarf's; night only (the Sun below −12°), needs clear sky at the anchor (it refuses under a closed roof or cloud), ~15–25 min, moves the scope",
        });
      }
      // sessions on the Seestar, transfers, the library and processing
      registerLibraryTools(tool, { device: true, transferHold: () => nights?.transferHold() ?? null });
      if (duty) registerDutyTools(tool, { duty });
      if (night) {
        registerNightTools(tool, night);
        registerMosaicTools(tool, night, {
          field: () => {
            const f = scope.state.fov ?? NOMINAL_FOV;
            return { w: f.h * 60, h: f.v * 60 };
          },
          facts: seestarFacts(scope),
          startNative: async (project) => {
            const angle = project.footprint.angleDeg - 90;
            // star_map_angle = 361 + angle, the value the Seestar community documents; the scale is how many frames the mosaic spans
            const r = await scope.gotoTarget({ raHours: project.footprint.raHours, decDeg: project.footprint.decDeg, name: project.gotoName, stack: true, mosaic: { scale: Math.max(project.nativeScale!.x, project.nativeScale!.y), angle, star_map_angle: 361 + angle, star_map_ratio: 1 } });
            return `GoTo ${r.goto.state}; stacking ${r.stacking}`;
          },
        });
      }
      if (nights) {
        tool(
          'starfront_roof',
          "Autonomous Starfront nights: status (the roof over the scope as Starfront reports it, tonight's window and what the mode is doing), or report the roof as you saw it with the telescope (action=report open=true|false) after a roof check; open starts tonight's imaging duty.",
          { action: z.enum(['status', 'report']), open: z.boolean().optional() },
          async ({ action, open }) => {
            if (action === 'report') {
              if (open === undefined) throw new Error('report needs open=true or open=false');
              return text(nights.report(open));
            }
            return text(nights.status());
          },
        );
      }
      registerStellariumTools(tool);
      registerResearchTools(tool, { fov: () => scope.state.fov ?? NOMINAL_FOV, site: () => scope.requireLocation() });
      registerAcquisitionTools(tool, { site: () => scope.requireLocation(), facts: seestarFacts(scope), night, sessionSubs: media ? (folder) => media.storage.sessionSubs(folder) : undefined, darkFrames: media ? () => media.storage.darkFrames() : undefined, probe: seestarProbeDriver(scope, media, () => pickDevice({ driver: 'seestar', model: scope.state.device.model, focalLengthMm: scope.state.device.focalLengthMm, chip: scope.state.device.chipSize }).spec.gain.default) });
    },
  };
}

const json = (v: unknown) => text(v);

export function registerSeestarTools(tool: ToolFn, scope: Seestar): void {
  const tz = config.observer.timezone;
  const fov = () => scope.state.fov ?? NOMINAL_FOV;
  const plateScale = (width: number) => (fov().h * 3600) / width;
  const cameras = () => ({ selected: scope.selected, exposing: scope.exposing, tele: scope.liveNote('tele'), wide: scope.liveNote('wide') });
  /**
   * How far the GoTo target sits from the frame centre, from the scope's newest completed plate
   * solve (since `since`), all J2000. The firmware's own "complete" is not this measurement.
   */
  const centring = (since = 0) => {
    const solves = ['PlateSolve', 'PlateSolve.step'].map((k) => scope.state.ops[k]).filter((o) => o && o.state === 'complete' && o.at >= since && pair(o.detail?.ra_dec));
    const op = solves.sort((a, b) => b!.at - a!.at)[0];
    const target = scope.state.view.targetRaDec;
    if (!op) return { measured: false, note: 'no plate solve since the GoTo: run plate_solve to measure the framing' };
    // ops details carry J2000 already (model.withJ2000)
    const [ra, dec] = pair(op.detail!.ra_dec)!;
    const frameCentre = { raHours: +ra.toFixed(5), decDeg: +dec.toFixed(4) };
    if (!target) return { measured: true, frameCentre, note: 'no GoTo target known to compare with' };
    const off = sky.offsetFromCentre(target[0], target[1], ra, dec);
    const shortArcmin = Math.min(fov().h, fov().v) * 60;
    const tolArcmin = +(shortArcmin * CENTRE_TOLERANCE).toFixed(1);
    const centred = off.totalArcmin <= tolArcmin;
    return {
      measured: true,
      solvedAt: localTime(op.at),
      target: { name: scope.state.view.target, raHours: +target[0].toFixed(5), decDeg: +target[1].toFixed(4) },
      frameCentre,
      targetFromCentre: off,
      percentOfShortSide: Math.round((off.totalArcmin / shortArcmin) * 100),
      toleranceArcmin: tolArcmin,
      centred,
      verdict: centred
        ? `centred: the target is ${off.totalArcmin}′ from the frame centre (tolerance ${tolArcmin}′)`
        : `NOT CENTRED: the target is ${off.totalArcmin}′ from the frame centre (${Math.abs(off.eastArcmin)}′ ${off.eastArcmin >= 0 ? 'east' : 'west'}, ${Math.abs(off.northArcmin)}′ ${off.northArcmin >= 0 ? 'north' : 'south'}; tolerance ${tolArcmin}′): re-centre before stacking`,
    };
  };

  // ---- status & link -------------------------------------------------------

  tool(
    'seestar_status',
    'Everything known about the Seestar: link and tunnel health, the device (model, firmware, optics, field of view), mount (pointing, tracking, EQ mode, parked), what the view and stack are doing (stacked/dropped frames), which camera is selected and exposing, focuser, battery and temperature, storage, the last state of every operation, the latest alert and recent events, and the full device state as the scope reported it. refresh=true reads it from the scope first.',
    { refresh: z.boolean().optional().describe('read the device and app state from the scope first (default true)') },
    async ({ refresh }) => {
      if (refresh !== false && scope.state.connected) await scope.refreshState();
      return json({ ...scope.state, busy: scope.isBusy(), cameras: cameras(), images: { tele: scope.images.tele.status(), wide: scope.images.wide.status() }, localTime: localTime() });
    },
  );

  tool(
    'seestar_connect',
    'Connect (or reconnect) to the Seestar after it was released: opens the control link and, over ZWO Telescope Network, asks the tunnel for the one remote session of the scope (its supervisor takes it from whoever holds it, the official app included). Over ZWO this can take 5–10 min: end your turn (on duty: duty next_check in_s=120); you are woken when the connection is up.',
    {},
    async () => {
      scope.connectLink();
      return text(scope.state.connection === 'zwo' ? 'connecting through ZWO Telescope Network: this can take 5–10 min. End your turn (on duty: duty next_check in_s=120); the connection coming up wakes you, and seestar_status shows it.' : 'connecting; check seestar_status in a few seconds');
    },
  );

  tool(
    'seestar_disconnect',
    'Release the Seestar: stop a running view (what it stacked is kept), close every link and, over ZWO Telescope Network, hand the session back so the scope leaves OCCUPIED and the official app can take it. It does not park (park is its own tool). It stays released, across restarts, until seestar_connect.',
    {},
    async () => {
      await scope.release();
      return text('released');
    },
  );

  tool(
    'select_camera',
    'Choose which camera the Seestar exposes (its star view runs on one at a time): tele (the telescope) or wide (the wide-angle lens). The web UI\'s main view does the same. The selection is sticky: a tool or an operation that borrows the other camera gives it back.',
    { camera: z.enum(['tele', 'wide']) },
    async ({ camera }) => {
      await scope.selectCamera(camera, 'selected by the agent');
      return json(cameras());
    },
  );

  tool('zwo_devices', "The telescopes on the ZWO account (owned and shared, as a rented remote scope appears) with their network state: online, offline, shooting (busy with someone's session), occupied.", {}, async () => json(await listDevices()));

  tool('tunnel_status', 'The ZWO Telescope Network tunnel: phase (starting, up, releasing, down, stopped, failed, unmanaged), whether the forwarded control port answers, reconnects, its last output lines, and what the supervisor in the tunnel container reported (device state, session, last error).', {}, async () =>
    json(scope.tunnel?.status() ?? { phase: 'none', note: `connection is ${scope.state.connection}: no tunnel` }),
  );

  tool('tunnel_restart', 'Restart the ZWO Telescope Network tunnel (after it failed, or the remote session was taken): release the session and take it again.', {}, async () => {
    if (!scope.tunnel) throw new Error(`connection is ${scope.state.connection}: there is no tunnel`);
    scope.tunnel.restart();
    return json(scope.tunnel.status());
  });

  tool('sync_time_location', "Push the host's clock and the observer location to the Seestar (it plans and solves with them). Done by itself on connect unless SEESTAR_AUTO_SYNC is false.", {}, async () => json({ synced: await scope.syncTimeLocation() }));

  // ---- pointing ------------------------------------------------------------

  tool(
    'find_target',
    'Look up an object in the catalog by name or designation (M 31, NGC 7000, Andromeda, Sh2-155): its coordinates, type, size and magnitude, and its altitude now.',
    { name: z.string() },
    async ({ name }) => {
      const o = findObject(name);
      if (!o) {
        const near = searchObjects(name, 8).map((m) => describeObject(m));
        throw new Error(`"${name}" is not in the catalog${near.length ? `; close matches:\n${near.join('\n')}` : ''}`);
      }
      const loc = scope.location();
      const now = loc ? sky.altAz(loc, o.raHours, o.decDeg) : null;
      return json({ ...o, gotoName: gotoLabel(o), description: describeObject(o), now, fovPercent: o.majorArcmin ? Math.round((o.majorArcmin / (fov().h * 60)) * 100) : undefined });
    },
  );

  tool(
    'goto_target',
    'GoTo a target by catalog name, or by J2000 RA/Dec: the Seestar slews, plate-solves and centres it on the tele, and this blocks until it reports the GoTo done (or failed). stack=true starts stacking on arrival. The Sun is refused unless solar_filter_confirmed.',
    {
      name: z.string().optional().describe('catalog name or designation; or give ra_hours/dec_deg (and a name for the session)'),
      ra_hours: z.number().min(0).lt(24).optional(),
      dec_deg: z.number().min(-90).max(90).optional(),
      lp_filter: z.boolean().optional().describe('the light-pollution (duo-band) filter for this target'),
      stack: z.boolean().optional().describe('start stacking once centred'),
      solar_filter_confirmed: z.boolean().optional(),
    },
    async (a) => {
      let ra = a.ra_hours;
      let dec = a.dec_deg;
      let name = a.name?.trim();
      if (ra === undefined || dec === undefined) {
        if (!name) throw new Error('give a target name, or ra_hours and dec_deg');
        const o = findObject(name);
        if (!o) throw new Error(`"${name}" is not in the catalog: give ra_hours and dec_deg`);
        [ra, dec, name] = [o.raHours, o.decDeg, gotoLabel(o)];
      }
      name ||= `RA ${ra.toFixed(3)}h Dec ${dec.toFixed(2)}°`;
      const loc = scope.location();
      if (loc) {
        const sun = sky.bodyRaDec(loc, 'Sun');
        if (sky.separationDeg(sun.raHours, sun.decDeg, ra, dec) < SUN_WARN_DEG && !a.solar_filter_confirmed) {
          throw new Error(`${name} is within ${SUN_WARN_DEG}° of the Sun: refused without solar_filter_confirmed (a solar filter on the scope)`);
        }
        const pos = sky.altAz(loc, ra, dec);
        if (pos.altitude < 0) throw new Error(`${name} is below the horizon (altitude ${pos.altitude.toFixed(1)}°)`);
      }
      const startedAt = Date.now();
      const r = await scope.gotoTarget({ raHours: ra, decDeg: dec, name, lpFilter: a.lp_filter, stack: a.stack });
      await scope.readPointing().catch(() => {});
      return json({ target: name, raHours: ra, decDeg: dec, goto: { state: r.goto.state, seconds: Math.round(r.goto.ms / 1000) }, centring: centring(startedAt), stacking: r.stacking, mount: scope.state.mount, cameras: cameras() });
    },
  );

  tool('stop', 'Stop what the scope is doing (a GoTo, stacking, autofocus, polar alignment, a hand move), the way the app stops each; the live view keeps running.', {}, async () => {
    const { stopped } = await scope.stopWork();
    return json({ stopped, note: stopped.length ? undefined : 'nothing was running; the live view keeps running' });
  });

  const NUDGE_DIRECTIONS: Record<string, number> = { right: 0, 'up-right': 45, up: 90, 'up-left': 135, left: 180, 'down-left': 225, down: 270, 'down-right': 315 };
  tool(
    'nudge',
    `Move the mount by hand, as the app's joystick does: direction (up/down/left/right/up-left/…) or angle_deg (0 right, 90 up, 180 left, 270 down), percent (the stick's throw, 1–${NUDGE_MAX_PERCENT}; 50 ≈ 2.7°/s, default 25) for up to ${NUDGE_MAX_S} s. Returns when the move has stopped. The live view keeps streaming through the move on whichever camera is selected.`,
    {
      direction: z.enum(['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right']).optional(),
      angle_deg: z.number().optional(),
      percent: z.number().min(1).max(NUDGE_MAX_PERCENT).optional(),
      seconds: z.number().gt(0).max(NUDGE_MAX_S),
    },
    async ({ direction, angle_deg, percent, seconds }) => {
      const angle = angle_deg ?? (direction ? NUDGE_DIRECTIONS[direction] : undefined);
      if (angle === undefined) throw new Error('give direction or angle_deg');
      return json(await scope.nudge(angle, percent ?? 25, seconds));
    },
  );

  tool('park', 'Park the Seestar (close the arm); blocks until it reports parked.', {}, async () => json(await scope.park()));

  tool('open_arm', 'Raise the arm out of park to the horizon position; blocks until done.', {}, async () => json(await scope.openArm()));

  tool(
    'plate_solve',
    'Plate-solve the current view: where the scope really points (J2000), the field, and `centring`: how far the GoTo target is from the frame centre (arcmin east/north), with a centred / NOT CENTRED verdict. The measurement for the framing check before stacking.',
    {},
    async () => {
      const startedAt = Date.now();
      const r = await scope.plateSolve();
      return json({ state: r.state, seconds: Math.round(r.ms / 1000), centring: centring(startedAt), solve: withJ2000(r.event, Date.now()) });
    },
  );

  tool('polar_align', 'Run the Seestar polar alignment (EQ mode on a wedge): blocks until it reports done; the result carries the deviation (EqModePA x/y, degrees) and the correction (pitch up/down, rotate clockwise/counter-clockwise).', {}, async () => json(await scope.polarAlign()));

  // ---- imaging -------------------------------------------------------------

  tool(
    'start_stacking',
    'Start stacking on the current target (the scope registers and integrates each sub itself, on the tele). restart=true begins a new stack instead of adding to the current one.',
    { restart: z.boolean().optional() },
    async ({ restart }) => json(await scope.startStack(!!restart)),
  );

  tool('stop_stacking', 'Stop stacking; the stack so far is kept and saved by the scope.', {}, async () => json(await scope.stopStack()));

  tool('start_live_view', 'Live view without a target (no GoTo) on the selected camera, e.g. to check the sky or focus.', { lp_filter: z.boolean().optional() }, async ({ lp_filter }) => {
    await scope.startView(!!lp_filter);
    return json(cameras());
  });

  tool('autofocus', 'Run the Seestar autofocus (on the tele); blocks until it reports done, with the focuser position it chose.', {}, async () => {
    const r = await scope.autofocus();
    const position = await scope.focuserPosition().catch(() => null);
    return json({ ...r, position });
  });

  tool(
    'move_focuser',
    'Move the focuser to an absolute step, or by a relative amount; returns where it ended.',
    { step: z.number().int().min(0).optional(), by: z.number().int().optional() },
    async ({ step, by }) => {
      if (step === undefined && by === undefined) throw new Error('give step or by');
      const at = step !== undefined ? await scope.focusTo(step) : await scope.focusBy(by!);
      return json({ position: at, maxStep: scope.state.focus.maxStep });
    },
  );

  tool(
    'set_exposure',
    'Set the stack sub length and/or the live-view exposure, in seconds.',
    { stack_s: z.number().positive().max(600).optional(), live_s: z.number().positive().max(60).optional(), camera: z.enum(['tele', 'wide']).optional() },
    async ({ stack_s, live_s, camera }) => json(await scope.setExposure({ stackMs: stack_s !== undefined ? stack_s * 1000 : undefined, continuousMs: live_s !== undefined ? live_s * 1000 : undefined }, camera ?? 'tele')),
  );

  tool('set_gain', 'Set the camera gain.', { gain: z.number().int().min(0).max(400) }, async ({ gain }) => json(await scope.setGain(gain)));

  tool(
    'set_dither',
    'Dithering during a stack: enable, the offset in pixels and every how many subs.',
    { enable: z.boolean(), pixels: z.number().int().min(1).max(200).optional(), interval: z.number().int().min(1).max(100).optional() },
    async ({ enable, pixels, interval }) => json(await scope.setDither({ enable, pix: pixels, interval })),
  );

  tool('get_settings', "The Seestar's settings as it reports them (get_setting).", {}, async () => json(await scope.settings()));

  tool(
    'set_settings',
    'Change Seestar settings (set_setting) by their own keys, e.g. {"auto_af": true}, {"stack_after_goto": false}, {"stack_lenhance": true}, {"heater_enable": true}. Read get_settings for the keys.',
    { settings: z.record(z.string(), z.unknown()) },
    async ({ settings }) => json(await scope.setSetting(settings)),
  );

  tool(
    'get_image',
    'Look at the Seestar: the current stacked image (kind=stacked, the default) or one live sub (kind=preview, the default when a camera is given: from the camera as it exposes now, the selected one or the one given), with star count, HFR/FWHM and an assessment. camera wide for the wide-angle lens.',
    { kind: z.enum(['stacked', 'preview']).optional(), camera: z.enum(['tele', 'wide']).optional(), analyze: z.boolean().optional().describe('add the numbers (default true)') },
    async (a) => {
      const kind = a.kind ?? (a.camera ? 'preview' : 'stacked');
      const camera = kind === 'stacked' ? 'tele' : (a.camera ?? scope.exposing ?? scope.selected);
      const { image, frame } = camera === scope.exposing || kind === 'stacked' ? await scope.grabImage(camera, kind) : await scope.withCamera(camera, `a ${camera} preview`, () => scope.grabImage(camera, kind));
      const lines: string[] = [];
      if (a.analyze !== false) {
        const scale = camera === 'tele' ? plateScale(image.frameWidth ?? image.width) : undefined;
        const an = analyze(image, camera, scale);
        const hfr = an.stars.medianHfrPx;
        const sharp = starSharpness(image, { arcsecPerPx: scale });
        lines.push(
          JSON.stringify(
            {
              camera,
              stars: an.stars.count,
              medianHfrPx: hfr,
              medianFwhmArcsec: hfr !== undefined && scale ? +(hfr * 2 * scale).toFixed(2) : undefined,
              plateScaleArcsecPerPx: scale ? +scale.toFixed(2) : undefined,
              focus: sharp.ok ? { score: sharp.score, hfrArcsec: sharp.hfrArcsec } : { blocking: sharp.blocking },
              background: an.stats.median,
              saturatedPercent: an.saturatedPercent,
              assessment: an.assessment,
              stack: { stacked: scope.state.stack.stacked, dropped: scope.state.stack.dropped, imageId: frame.header.imageId },
            },
            null,
            1,
          ),
        );
      }
      return imageResult(image, `seestar_${camera}_${kind}`, { note: lines.join('\n') || undefined });
    },
  );

  // ---- planning ------------------------------------------------------------

  tool(
    'plan_targets',
    "Rank deep-sky targets for tonight for the Seestar's own field of view (from its reported optics), with the app's planner: framing, time up, integration worth after the Moon, detectability through the sky and filter, and the forecast. Quote its numbers; `hero` is the one to start with, `gotoName` the name to pass to goto_target.",
    {
      types: z.array(z.string()).optional(),
      min_altitude: z.number().min(0).lt(90).optional(),
      max_magnitude: z.number().optional(),
      min_size_arcmin: z.number().optional(),
      max_size_arcmin: z.number().optional(),
      start: z.string().optional().describe('local time YYYY-MM-DDTHH:MM'),
      end: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      bortle: z.number().min(1).max(9).optional(),
      filter: z.string().optional().describe('"none", or "duo-band" for the light-pollution filter'),
      ignore_rest: z.boolean().optional(),
      ignore_horizon: z.boolean().optional(),
    },
    async (a) => {
      const s = scope.requireLocation();
      const f = fov();
      const defaults = planDefaults();
      const plan = planNight(s, {
        conditions: (await weather.conditionsAt(s, tz)) ?? undefined,
        types: a.types,
        minAltitude: a.min_altitude ?? config.observer.minAltitudeDeg,
        maxMagnitude: a.max_magnitude,
        minSizeArcmin: a.min_size_arcmin,
        maxSizeArcmin: a.max_size_arcmin,
        start: a.start ? sky.parseLocal(a.start, tz) : undefined,
        end: a.end ? sky.parseLocal(a.end, tz) : undefined,
        limit: a.limit,
        fovArcmin: { w: f.h * 60, h: f.v * 60 },
        timezone: tz,
        bortle: a.bortle ?? defaults.bortle,
        filter: a.filter ?? 'none',
        rig: { ...defaults.rig, plateScaleArcsecPerPx: plateScale(scope.state.device.chipSize?.[1] ?? 1920), apertureMm: scope.state.device.focalLengthMm && scope.state.device.fNumber ? scope.state.device.focalLengthMm / scope.state.device.fNumber : defaults.rig.apertureMm, mount: scope.state.mount.eqMode ? 'eq' : 'alt-az', guided: false },
        applyRest: a.ignore_rest ? false : undefined,
        horizon: a.ignore_horizon ? undefined : horizonFor(s),
      });
      if (!a.ignore_rest) rest.recordShown([{ name: plan.hero ?? '', role: 'hero' }, ...plan.targets.slice(0, 5).map((t) => ({ name: t.name, role: 'shortlist' as const }))], sky.localDate(new Date(), tz));
      return json({ fovDeg: f, ...plan });
    },
  );

  // ---- system --------------------------------------------------------------

  tool(
    'power',
    'Shut the Seestar down or reboot it. Only when the user asked for it.',
    { action: z.enum(['shutdown', 'reboot']), confirmed: z.literal(true).describe('the user asked for it') },
    async ({ action }) => json(await scope.power(action)),
  );

  tool(
    'raw_rpc',
    'Send any JSON-RPC method to the Seestar and return its reply as sent (code, result, error). For methods the other tools do not cover, e.g. get_device_state, get_setting, get_view_state, iscope_get_app_state, get_stack_info, get_albums.',
    { method: z.string().min(1), params: z.unknown().optional().describe("the method's params as a JSON value (an object for most methods), not as a string"), timeout_s: z.number().positive().max(300).optional() },
    async ({ method, params, timeout_s }) => {
      // a params object that arrived as its JSON text (the scope answers "expected object param" to a string)
      if (typeof params === 'string' && /^\s*[[{]/.test(params)) {
        try {
          params = JSON.parse(params);
        } catch {
          /* not JSON: sent as the string it is */
        }
      }
      return json(await scope.raw(method, params, timeout_s ? timeout_s * 1000 : undefined));
    },
  );
}
