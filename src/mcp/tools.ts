import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { Dwarf, FILTERS, type CameraName, round } from '../dwarf/device.js';
import * as http from '../dwarf/http.js';
import { DwarfCommandError } from '../dwarf/link.js';
import type { StreamHub } from '../media/streams.js';
import { loadImage, crop as cropImage, autoStretch, toJpeg, analyze, type FloatImage } from '../media/images.js';
import { findObject, searchObjects, describe as describeObject } from '../astro/catalog.js';
import { planNight } from '../astro/planner.js';
import * as sky from '../astro/sky.js';
import * as weather from '../astro/weather.js';
import * as library from '../library/transfer.js';

const log = logger('mcp');

export interface ToolContext {
  dwarf: Dwarf;
  hub: StreamHub;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (v: unknown): Result => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });

function fail(err: unknown): Result {
  let msg = errMsg(err);
  if (err instanceof DwarfCommandError) msg = `${msg}\nresponse: ${JSON.stringify(err.response)}`;
  return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] };
}

export const toolEvents = new EventEmitter();

/** Save an image the agent looked at, so the UI can show it too. */
function saveCapture(jpeg: Buffer, label: string): string {
  const dir = path.join(config.paths.captures, 'agent');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60)}.jpg`;
  fs.writeFileSync(path.join(dir, name), jpeg);
  const rel = `agent/${name}`;
  toolEvents.emit('image', { path: rel, label, at: Date.now() });
  return rel;
}

async function imageResult(img: FloatImage, label: string, opts: { stretch?: boolean; maxSize?: number; note?: string }): Promise<Result> {
  const shown = opts.stretch ?? img.linear ? autoStretch(img) : img;
  const jpeg = await toJpeg(shown, opts.maxSize ?? 1280);
  const saved = saveCapture(jpeg, label);
  const lines = [`${label}: ${img.width}×${img.height}${img.linear ? ' (linear data, auto-stretched for display)' : ''}`, `saved as captures/${saved}`];
  if (opts.note) lines.push(opts.note);
  return {
    content: config.llm.vision
      ? [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: lines.join('\n') }]
      : [{ type: 'text', text: `${lines.join('\n')}\n(vision disabled: use analyze_image for numbers)` }],
  };
}

const camera = z.enum(['tele', 'wide']).describe('tele = 150mm telephoto (2.95°×1.66° FOV), wide = 6.7mm wide-angle (45°×26°)');
const cropSchema = z
  .object({
    x: z.number().min(0).describe('left edge; 0..1 fraction of width, or pixels if > 1'),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .optional()
  .describe('optional region; fractions (0..1) or pixels');

function wrap<A>(name: string, fn: (args: A) => Promise<Result>) {
  return async (args: A): Promise<Result> => {
    const started = Date.now();
    toolEvents.emit('call', { name, args, at: started });
    try {
      const r = await fn(args);
      toolEvents.emit('done', { name, ok: !r.isError, ms: Date.now() - started });
      return r;
    } catch (err) {
      log.warn(`${name} failed: ${errMsg(err)}`);
      toolEvents.emit('done', { name, ok: false, ms: Date.now() - started, error: errMsg(err) });
      return fail(err);
    }
  };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { dwarf, hub } = ctx;
  const site = () => {
    const l = dwarf.requireLocation();
    return { lat: l.lat, lon: l.lon, elev: l.elev };
  };
  const tz = config.observer.timezone;

  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<Result>) => {
    server.registerTool(name, { description, inputSchema: shape }, wrap(name, fn) as never);
  };

  // ------------------------------------------------------------------ status
  tool(
    'telescope_status',
    'Current telescope state: connection, battery, temperatures, storage, shooting mode, Alt-Az/EQ mode, motor angles, focus, calibration/GoTo/tracking, live-stacking progress, polar-alignment result, observer location and local time. Call this first and whenever unsure.',
    { refresh: z.boolean().optional().describe('re-query the device instead of using the cached state (default true)') },
    async ({ refresh }) => {
      if (refresh !== false && dwarf.link.connected) {
        await dwarf.refreshState().catch(() => {});
        await dwarf.readMotorPositions().catch(() => {});
      }
      const loc = dwarf.location();
      const s = dwarf.state;
      return text({
        ...s,
        motorsNote: 'pitch≈90° is level with the horizon in Alt-Az mode (pitch − 90 ≈ altitude); ~2.5° is the parked/down position',
        observer: loc ? { ...loc, timezone: tz } : 'NOT CONFIGURED — set OBSERVER_LATITUDE/OBSERVER_LONGITUDE',
        localTime: new Date().toLocaleString('en-US', { timeZone: tz }),
        busyWith: dwarf.isBusy(),
      });
    },
  );

  tool('telescope_device_info', 'Static device info from the HTTP API: name, serial, firmware, Wi-Fi/STA details, SD card, supported shooting modes.', {}, async () => {
    const [info, fw, modes] = await Promise.all([http.getDeviceInfo(), http.getFirmware().catch(() => null), http.getShootingModes()]);
    return text({ ...info, firmware: fw?.version, shootingModes: modes.map((m) => ({ id: m.id, name: m.name, parent: m.parentId, techniques: m.shootingTechnology.map((t) => http.SHOOTING_TECH_NAMES[t.id] ?? t.id) })) });
  });

  tool('telescope_reconnect', 'Drop and re-open the control connection. Use if commands time out. Note: the official DWARFLAB app must be closed or it takes over the session.', {}, async () => {
    dwarf.link.reconnect();
    await dwarf.link.waitConnected(15000);
    return text('reconnected');
  });

  tool(
    'sync_time_and_location',
    'Push the current time, timezone and observer location to the telescope (needed for calibration/GoTo). Optionally override the location for this session (otherwise .env OBSERVER_* is used).',
    {
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      elevation_m: z.number().optional(),
    },
    async ({ latitude, longitude, elevation_m }) => {
      if (latitude !== undefined && longitude !== undefined) dwarf.locationOverride = { lat: latitude, lon: longitude, elev: elevation_m ?? config.observer.elevationM };
      const done = await dwarf.syncTimeLocation();
      return text(`synced: ${done.join('; ')}`);
    },
  );

  // ------------------------------------------------------------------ modes & settings
  tool(
    'set_shooting_mode',
    'Switch the telescope scene mode. Normal = daytime photo/video/burst/timelapse; DSO = deep-sky stacking; Sun/Moon/Planet = solar-system; Milky Way; Star Trail; Auto Tracking = daytime object tracking; Panorama.',
    { mode: z.string().describe('Normal | DSO | Sun | Moon | Planet | Milky Way | Star Trail | Auto Tracking | Panorama (or numeric id)') },
    async ({ mode }) => {
      const m = await dwarf.setShootingMode(mode);
      return text(`shooting mode → ${m.name} (id ${m.id}); techniques: ${m.shootingTechnology.map((t) => http.SHOOTING_TECH_NAMES[t.id]).join(', ')}`);
    },
  );

  tool(
    'get_camera_settings',
    'Current values and allowed options for a camera in the current (or given) shooting mode: exposure, gain, white balance, filter, brightness/contrast/saturation/hue/sharpness, resolution, burst/timelapse/stacking settings, plus device-wide settings (autoShutdown, disableHostSlave).',
    { camera, mode: z.string().optional().describe('shooting mode name/id; default current') },
    async ({ camera: cam, mode }) => {
      const modeId = mode ? (await http.resolveShootingMode(mode)).id : undefined;
      return text(await dwarf.cameraSettings(cam, modeId));
    },
  );

  tool(
    'set_camera_setting',
    'Change one camera setting. exposure: "auto" or seconds like "1/500", "0.5", "15", "60" (nearest supported). gain: number (nearest allowed). white_balance: auto | scene name | kelvin. filter: VIS | Astro | Duo-Band (tele only). Also any setting name from get_camera_settings (brightness, contrast, saturation, hue, sharpness, stackCount, burstCount, timelapseIntervalTime, autoCalibration, and device-wide autoShutdown / disableHostSlave with value true/false).',
    {
      camera,
      setting: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      mode: z.string().optional().describe('apply to this shooting mode instead of the current one (e.g. set DSO exposure while in Normal)'),
    },
    async ({ camera: cam, setting, value, mode }) => {
      const modeId = mode ? (await http.resolveShootingMode(mode)).id : undefined;
      return text(await dwarf.setSetting(cam, setting, value, modeId));
    },
  );

  // ------------------------------------------------------------------ capture
  tool(
    'take_photo',
    'Take a still photo (count>1 = burst) with the tele or wide camera using current settings. Returns the album file path; use view_image with "device:<path>" to inspect it.',
    { camera, count: z.number().int().min(1).max(999).optional() },
    async ({ camera: cam, count }) => {
      if (count && count > 1) return text(await dwarf.burst(cam, count));
      const item = await dwarf.takePhoto(cam);
      return text(item ? { saved: item.filePath, exif: item.exifInfo, thumbnail: item.thumbnailPath } : 'photo taken (album entry not found yet)');
    },
  );

  tool('video_recording', 'Start or stop video recording on a camera.', { camera, action: z.enum(['start', 'stop']) }, async ({ camera: cam, action }) => {
    await dwarf.record(cam, action);
    return text(`${cam} recording ${action === 'start' ? 'started' : 'stopped'}`);
  });

  tool(
    'timelapse',
    'Start or stop a timelapse on a camera. interval_s from {0,1,2,3,4,5,8,10,15,20,25,30,60}; total_s 0 = until stopped.',
    { camera, action: z.enum(['start', 'stop']), interval_s: z.number().optional(), total_s: z.number().optional() },
    async ({ camera: cam, action, interval_s, total_s }) => {
      await dwarf.timelapse(cam, action, interval_s, total_s);
      return text(`${cam} timelapse ${action}ed`);
    },
  );

  tool(
    'view_camera',
    'Look at what a camera sees right now (returns an image). source: tele | wide | stack (the current live-stacking result). Use crop to zoom into a region; full_resolution grabs a 1920×1080 frame (slower).',
    {
      source: z.enum(['tele', 'wide', 'stack']),
      crop: cropSchema,
      full_resolution: z.boolean().optional(),
      max_size: z.number().int().min(256).max(2048).optional().describe('longest edge of the returned image (default 1280)'),
      stretch: z.boolean().optional().describe('auto-stretch faint data'),
    },
    async ({ source, crop, full_resolution, max_size, stretch }) => {
      let { img } = await loadImage(source, hub, { fullRes: full_resolution });
      if (crop) img = cropImage(img, crop);
      return imageResult(img, `${source} live`, { stretch, maxSize: max_size });
    },
  );

  // ------------------------------------------------------------------ motion
  tool('motors_home', 'Home (reset) both motor axes against their limit switches. Required after power-on before any motion (error -14520 means "home first"). Takes up to ~1 minute; the scope ends pointing down.', {}, async () => text(await dwarf.homeMotors()));

  tool('motor_position', 'Read the rotation (azimuth axis) and pitch (altitude axis) motor angles.', {}, async () => text(await dwarf.readMotorPositions()));

  tool(
    'move_motors',
    'Move the motors. Absolute: pitch ~2.5 parked/down, ~90 level (Alt-Az: altitude ≈ pitch − 90, so 135 ≈ 45° up); rotation ~159 after homing is the centre of travel. relative=true moves BY the given degrees instead. Directions (verified): rotation DEcreasing pans the view RIGHT; pitch increasing tilts UP. To centre a subject at pixel offset (dx right, dy down) from frame centre: rotation_deg = −dx·scale, pitch_deg = −dy·scale, with scale ≈ 0.0235°/px (wide) or 0.0015°/px (tele) for a 1920-px-wide frame (scale by 1920/width for smaller frames). speed 0.1-30 °/s (default 10). Waits until the motion completes.',
    { rotation_deg: z.number().optional(), pitch_deg: z.number().optional(), relative: z.boolean().optional(), speed: z.number().optional() },
    async ({ rotation_deg, pitch_deg, relative, speed }) => {
      if (relative) {
        const p = await dwarf.readMotorPositions();
        if (!p.homed || p.rotationDeg === undefined || p.pitchDeg === undefined) throw new Error('motors are not homed; run motors_home first');
        return text(await dwarf.moveTo({ rotationDeg: rotation_deg !== undefined ? p.rotationDeg + rotation_deg : undefined, pitchDeg: pitch_deg !== undefined ? p.pitchDeg + pitch_deg : undefined }, speed));
      }
      return text(await dwarf.moveTo({ rotationDeg: rotation_deg, pitchDeg: pitch_deg }, speed));
    },
  );

  tool(
    'nudge',
    'Joystick-style slew for framing/following (daytime targets, centring). direction: up/down/left/right/up-left/… or angle_deg (0 = up, 90 = right). speed 0.01-1 (fraction of max). seconds 0.1-30.',
    {
      direction: z.enum(['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right']).optional(),
      angle_deg: z.number().optional(),
      speed: z.number().min(0.01).max(1).optional(),
      seconds: z.number().min(0.1).max(30),
    },
    async ({ direction, angle_deg, speed, seconds }) => {
      const angles: Record<string, number> = { up: 0, 'up-right': 45, right: 90, 'down-right': 135, down: 180, 'down-left': 225, left: 270, 'up-left': 315 };
      const angle = angle_deg ?? (direction ? angles[direction] : undefined);
      if (angle === undefined) throw new Error('give direction or angle_deg');
      await dwarf.nudge(angle, speed ?? 0.5, seconds * 1000);
      const p = await dwarf.readMotorPositions().catch(() => null);
      return text(`nudged ${direction ?? `${angle}°`} for ${seconds}s${p ? `; now rotation ${p.rotationDeg}°, pitch ${p.pitchDeg}°` : ''}`);
    },
  );

  tool('stop_motion', 'Immediately stop all motor motion.', {}, async () => {
    await dwarf.stopMotion();
    return text('motion stopped');
  });

  // ------------------------------------------------------------------ focus
  tool(
    'autofocus',
    'Run autofocus. normal = contrast AF for daytime/Moon/planets at a point (x,y in 1920×1080 tele frame, default centre). astro = star-based AF for deep sky (needs stars in view, takes ~1-2 min).',
    { mode: z.enum(['normal', 'astro']), x: z.number().optional(), y: z.number().optional() },
    async ({ mode, x, y }) => text(await dwarf.autofocus(mode, x, y)),
  );

  tool(
    'focus_step',
    'Move the tele focuser manually. direction near (closer objects) or far (towards infinity); steps 1-200. Check sharpness with analyze_image between moves.',
    { direction: z.enum(['near', 'far']), steps: z.number().int().min(1).max(200) },
    async ({ direction, steps }) => text(await dwarf.focusStep(direction, steps)),
  );

  tool(
    'focus_position',
    'Absolute focuser control. action get: current and stored infinity positions. action infinity: drive to the stored infinity position (instant starting point for sky work without stars; temperature drift means astro autofocus still refines it). action goto: drive to `position`. action save_infinity: store the current position as the new infinity reference (only after a verified-good astro focus, with user approval). Note: in Normal mode realtime AF may move focus again; use DSO/Moon/Planet modes for sky work.',
    { action: z.enum(['get', 'infinity', 'goto', 'save_infinity']), position: z.number().int().min(0).optional() },
    async ({ action, position }) => {
      const inf = await dwarf.infinityFocusPosition();
      if (action === 'get') {
        await dwarf.refreshState();
        return text({ current: dwarf.state.focusPosition, infinity: inf, note: 'higher = farther; 0 = near limit' });
      }
      if (action === 'save_infinity') {
        await dwarf.refreshState();
        const cur = dwarf.state.focusPosition ?? 0;
        await dwarf.request(15012, { pos: cur }, { timeout: 5000 });
        return text(`saved ${cur} as the infinity position (was ${inf})`);
      }
      const target = action === 'infinity' ? inf : position;
      if (target === undefined) throw new Error('position required for goto');
      const final = await dwarf.focusTo(target);
      return text(`focuser at ${final} (target ${target}${action === 'infinity' ? ', stored infinity' : ''})`);
    },
  );

  // ------------------------------------------------------------------ planning
  tool(
    'sky_conditions',
    "Tonight's observing window at the observer location: sunset, twilights, astronomical darkness start/end, Sun and Moon altitude, Moon phase/illumination/rise/set, and planet visibility.",
    { date: z.string().optional().describe('local date (YYYY-MM-DD = that night) or local date-time; default now') },
    async ({ date }) => {
      const s = site();
      const when = date ? sky.parseLocal(date, tz) : new Date();
      const w = sky.nightWindow(s, when);
      const f = (d: Date | null) => sky.fmtTime(d, tz);
      const planets = (['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const).map((b) => sky.bodyInfo(s, b, when));
      return text({
        localTime: when.toLocaleString('en-US', { timeZone: tz }),
        sunAltitude: round(sky.bodyAlt(s, 'Sun', when), 1),
        isDark: sky.bodyAlt(s, 'Sun', when) < -18,
        night: { sunset: f(w.sunset), civilDusk: f(w.civilDusk), nauticalDusk: f(w.nauticalDusk), astronomicalDusk: f(w.astroDusk), astronomicalDawn: f(w.astroDawn), sunrise: f(w.sunrise) },
        darkHours: w.darkStart && w.darkEnd ? round((w.darkEnd.getTime() - w.darkStart.getTime()) / 3600e3, 1) : 0,
        moon: sky.moonState(s, when),
        planets: planets.map((p) => ({ body: p.body, altitudeNow: p.altitude, magnitude: p.magnitude, transit: sky.fmtTime(new Date(String(p.nextTransit)), tz), transitAltitude: p.transitAltitude, rise: sky.fmtTime(p.nextRise ? new Date(String(p.nextRise)) : null, tz), set: sky.fmtTime(p.nextSet ? new Date(String(p.nextSet)) : null, tz) })),
      });
    },
  );

  tool(
    'weather_forecast',
    'Local weather & observability for the observer location: current conditions, and an hourly forecast with cloud cover (low/mid/high), rain chance, wind/gusts, humidity, dew-point spread (dew risk), visibility, astronomical seeing & transparency (7Timer), and a 0–100 observability score. period "tonight" (default) gives the darkness window with a verdict and the best clear window; "next24"/"next72" give raw hours.',
    { period: z.enum(['tonight', 'next24', 'next72']).optional() },
    async ({ period }) => {
      const s = site();
      if (!period || period === 'tonight') {
        const t = await weather.tonight(s, tz);
        return text({ ...t, hours: t.hours.map(compactHour) });
      }
      const { hours, current } = await weather.forecast(s, tz);
      const now = Date.now() - 3600e3;
      const n = period === 'next24' ? 24 : 72;
      return text({ current, hours: hours.filter((h) => new Date(h.time).getTime() >= now).slice(0, n).map(compactHour) });
    },
  );

  tool(
    'plan_targets',
    'Rank deep-sky targets for tonight (or a given window) for the Dwarf 3 tele camera: hours above min altitude, peak altitude/time, size vs field of view, brightness, Moon separation, and suggested filter. Use before choosing what to image.',
    {
      types: z.array(z.string()).optional().describe('galaxy, nebula, emission, planetary, cluster, globular, open_cluster, supernova_remnant, reflection'),
      min_altitude: z.number().optional(),
      max_magnitude: z.number().optional().describe('default 11'),
      min_size_arcmin: z.number().optional().describe('default 4'),
      max_size_arcmin: z.number().optional(),
      start: z.string().optional().describe('local time YYYY-MM-DDTHH:MM; default astronomical dusk (or now)'),
      end: z.string().optional().describe('local time; default astronomical dawn'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (a) => {
      const fov = dwarf.state.fov.tele ?? { h: 2.95, v: 1.66 };
      return text(
        planNight(site(), {
          types: a.types,
          minAltitude: a.min_altitude ?? config.observer.minAltitudeDeg,
          maxMagnitude: a.max_magnitude,
          minSizeArcmin: a.min_size_arcmin,
          maxSizeArcmin: a.max_size_arcmin,
          start: a.start ? sky.parseLocal(a.start, tz) : undefined,
          end: a.end ? sky.parseLocal(a.end, tz) : undefined,
          limit: a.limit,
          fovArcmin: { w: fov.h * 60, h: fov.v * 60 },
          timezone: tz,
        }),
      );
    },
  );

  tool(
    'find_target',
    'Look up a target by name (M31, NGC 7000, IC 1396, C 33, Sh2-155, "Orion Nebula", Jupiter, Moon…): J2000 coordinates, type, size, magnitude, current altitude/azimuth and tonight\'s visibility.',
    { name: z.string() },
    async ({ name }) => {
      const s = site();
      const body = sky.bodyByName(name);
      if (body) return text(sky.bodyInfo(s, body));
      const o = findObject(name);
      if (!o) {
        const alts = searchObjects(name, 8).map(describeObject);
        throw new Error(`"${name}" not found in the catalog${alts.length ? `. Similar: ${alts.join('; ')}` : ''}`);
      }
      const now = sky.altAz(s, o.raHours, o.decDeg);
      const w = sky.nightWindow(s);
      const vis = w.darkStart && w.darkEnd ? sky.visibility(s, o.raHours, o.decDeg, w.darkStart, w.darkEnd, config.observer.minAltitudeDeg) : null;
      const fov = dwarf.state.fov.tele ?? { h: 2.95, v: 1.66 };
      return text({
        summary: describeObject(o),
        raHoursJ2000: round(o.raHours, 5),
        decDegJ2000: round(o.decDeg, 4),
        ra: sky.hoursToHms(o.raHours),
        dec: sky.degToDms(o.decDeg),
        altitudeNow: round(now.altitude, 1),
        azimuthNow: round(now.azimuth, 1),
        tonight: vis ? { maxAltitude: vis.maxAlt, at: sky.fmtTime(vis.maxAltAt, tz), hoursAboveMinAlt: vis.hoursAboveMin, from: sky.fmtTime(vis.firstAbove, tz), until: sky.fmtTime(vis.lastAbove, tz) } : null,
        fitsTeleFov: o.majorArcmin ? `${round((o.majorArcmin / (fov.h * 60)) * 100, 0)}% of frame width` : 'unknown size',
      });
    },
  );

  // ------------------------------------------------------------------ astro operations
  tool(
    'calibrate',
    'Astro calibration (plate-solve the sky to learn pointing). Needs a clear sky, synced time/location, DSO mode, and motors homed. Takes ~1-3 minutes. Required before goto_target unless one_click is used.',
    {},
    async () => text(await dwarf.calibrate()),
  );

  tool(
    'goto_target',
    'Slew to and track a target. Give a name (catalog object or planet/Moon/Sun) or ra_hours+dec_deg (J2000). one_click (default true) = calibrate + GoTo in one step. Waits for arrival (can take several minutes). NEVER point at the Sun without a solar filter.',
    {
      name: z.string().optional(),
      ra_hours: z.number().min(0).max(24).optional(),
      dec_deg: z.number().min(-90).max(90).optional(),
      one_click: z.boolean().optional(),
    },
    async ({ name, ra_hours, dec_deg, one_click }) => {
      const oneClick = one_click !== false;
      if (ra_hours !== undefined && dec_deg !== undefined) return text(await dwarf.gotoRaDec(ra_hours, dec_deg, name ?? 'Custom', oneClick));
      if (!name) throw new Error('give a target name or ra_hours + dec_deg');
      const body = sky.bodyByName(name);
      if (body) {
        if (body === 'Sun') throw new Error('Pointing at the Sun requires the solar filter fitted. Use track_sun_moon after the user confirms the filter is on.');
        return text(await dwarf.gotoSolarSystem(body, oneClick));
      }
      const o = findObject(name);
      if (!o) throw new Error(`"${name}" not found; use find_target or give coordinates`);
      const alt = sky.altAz(site(), o.raHours, o.decDeg).altitude;
      if (alt < 5) throw new Error(`${o.id} is below the horizon (altitude ${alt.toFixed(1)}°)`);
      const label = o.aliases.find((a) => /^M \d/.test(a)) ?? o.id;
      return text(await dwarf.gotoRaDec(o.raHours, o.decDeg, label, oneClick));
    },
  );

  tool('stop_goto', 'Abort a running GoTo / one-click GoTo.', {}, async () => {
    await dwarf.stopGoto();
    return text('goto stopped');
  });

  tool(
    'live_stacking',
    'Start or stop deep-sky live stacking (in DSO mode, after GoTo). On start you may set exposure (s), gain, filter (VIS/Astro/Duo-Band) and frame count first. Raw FITS subframes are saved on the SD card. Stop normally lets the final stack finish; fast_stop skips final processing.',
    {
      action: z.enum(['start', 'stop']),
      camera: camera.optional(),
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
      await dwarf.ensureMode('DSO');
      const applied: string[] = [];
      if (a.exposure !== undefined) applied.push(await dwarf.setSetting(cam, 'exposure', a.exposure));
      if (a.gain !== undefined) applied.push(await dwarf.setSetting(cam, 'gain', a.gain));
      let filterIndex: number | undefined;
      if (a.filter && cam === 'tele') {
        applied.push(await dwarf.setSetting(cam, 'filter', a.filter));
        filterIndex = FILTERS.findIndex((f) => f.toLowerCase().startsWith(a.filter!.toLowerCase().slice(0, 3)));
        if (filterIndex < 0) filterIndex = undefined;
      }
      if (a.frames !== undefined) applied.push(await dwarf.setSetting(cam, cam === 'wide' ? 'stackCount_wide' : 'stackCount', a.frames));
      const r = await dwarf.startStacking(cam, { filterIndex, force: a.force });
      return text(`${applied.join('\n')}\n${r}`.trim());
    },
  );

  tool(
    'stacking_status',
    'Live-stacking progress: frames taken/stacked/target, integration time, target, plus whether frames are being rejected. Use view_camera source "stack" to see the stacked image.',
    {},
    async () => {
      const s = dwarf.state.stacking;
      const describe = (x: typeof s.tele) => ({
        ...x,
        rejected: x.currentCount !== undefined && x.stackedCount !== undefined ? x.currentCount - x.stackedCount : undefined,
        integrationMinutes: x.stackedTimeS !== undefined ? round(x.stackedTimeS / 60, 1) : undefined,
        lastUpdateAgoS: x.updatedAt ? Math.round((Date.now() - x.updatedAt) / 1000) : undefined,
      });
      return text({ tele: describe(s.tele), wide: describe(s.wide), stackPreviewAvailable: !!hub.stack.latest, stackPreviewAgeS: hub.stack.latest ? Math.round((Date.now() - hub.stack.latest.at) / 1000) : null });
    },
  );

  tool(
    'wait',
    'Pause for a while (e.g. between stacking checks) and then report stacking/GoTo state. Max 600 s per call.',
    { seconds: z.number().min(1).max(600) },
    async ({ seconds }) => {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const s = dwarf.state;
      return text({ waited: seconds, stacking: s.stacking, goto: s.goto, tracking: s.tracking, battery: s.battery });
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
        quality: total < 0.1 ? 'excellent' : total < 0.25 ? 'good' : total < 0.5 ? 'acceptable for short exposures' : 'needs adjustment',
        bodyMode: dwarf.state.bodyMode,
      };
      if (prev) {
        out.previous = { azimuthErrorDeg: round(prev.azimuthErrorDeg, 3), altitudeErrorDeg: round(prev.altitudeErrorDeg, 3) };
        out.change = {
          azimuth: Math.abs(r.azimuthErrorDeg) < Math.abs(prev.azimuthErrorDeg) ? 'improved — keep turning the same way' : 'got worse — reverse the azimuth adjustment',
          altitude: Math.abs(r.altitudeErrorDeg) < Math.abs(prev.altitudeErrorDeg) ? 'improved — keep turning the same way' : 'got worse — reverse the altitude adjustment',
        };
      }
      return text(out);
    },
  );

  tool(
    'track_sun_moon',
    'Start/stop the dedicated Sun or Moon tracking mode. SUN: only after the user confirms the solar filter is fitted on the tele lens.',
    { body: z.enum(['sun', 'moon']), action: z.enum(['start', 'stop']), solar_filter_confirmed: z.boolean().optional() },
    async ({ body, action, solar_filter_confirmed }) => {
      if (body === 'sun' && action === 'start' && !solar_filter_confirmed) throw new Error('Ask the user to confirm the solar filter is fitted, then call again with solar_filter_confirmed=true');
      await dwarf.ensureMode(body === 'sun' ? 'Sun' : 'Moon');
      await dwarf.trackSunMoon(body, action);
      return text(`${body} tracking ${action}ed`);
    },
  );

  // ------------------------------------------------------------------ daytime tracking
  tool(
    'track_object',
    'Lock onto and follow a moving/static object (birds, animals, vehicles, aircraft) by its bounding box in the 1920×1080 frame of the chosen camera. Use view_camera first to find the box. action stop ends tracking.',
    {
      action: z.enum(['start', 'stop']),
      camera: camera.optional(),
      x: z.number().optional().describe('box left, px in 1920×1080'),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
    async ({ action, camera: cam, x, y, width, height }) => {
      if (action === 'stop') {
        await dwarf.stopTracking();
        return text('tracking stopped');
      }
      if ([x, y, width, height].some((v) => v === undefined)) throw new Error('x, y, width, height are required');
      await dwarf.trackObject(cam ?? 'tele', { x: x!, y: y!, w: width!, h: height! });
      return text(`tracking started on ${cam ?? 'tele'} box (${x},${y},${width}×${height}); results stream in telescope_status.trackResult`);
    },
  );

  tool(
    'sentry_mode',
    'Automatic detection & tracking (sentry): the telescope watches with the wide camera and tracks objects that appear. object_type: 0 any/UFO, 2 bird, 3 person, 4 animal, 5 vehicle, 6 flying object, 7 boat.',
    { action: z.enum(['start', 'stop']), object_type: z.number().int().min(0).max(7).optional() },
    async ({ action, object_type }) => {
      await dwarf.sentry(action, object_type ?? 0);
      return text(`sentry mode ${action}ed`);
    },
  );

  // ------------------------------------------------------------------ album & images
  tool(
    'list_album',
    'List media on the telescope SD card. type: all | photo | video | burst | astro | panorama. Astro entries include target, exposure, gain, filter, frames stacked and the session folder.',
    { type: z.enum(['all', 'photo', 'video', 'burst', 'astro', 'panorama']).optional(), page: z.number().int().min(0).optional(), page_size: z.number().int().min(1).max(50).optional() },
    async ({ type, page, page_size }) => {
      const mt = Number(Object.entries(http.MEDIA_TYPES).find(([, n]) => n === (type ?? 'all'))?.[0] ?? 0);
      const [counts, items] = await Promise.all([http.getMediaCounts(), http.listMedia(mt, page ?? 0, page_size ?? 15)]);
      return text({
        counts: Object.fromEntries(counts.map((c) => [http.MEDIA_TYPES[c.mediaType] ?? c.mediaType, c.count])),
        items: items.map((m) => ({
          path: m.filePath,
          camera: m.camId === 1 ? 'wide' : 'tele',
          type: http.MEDIA_TYPES[m.mediaType] ?? m.mediaType,
          time: new Date(m.modificationTime * 1000).toLocaleString('en-US', { timeZone: tz }),
          sizeMB: round(m.fileSize / 1e6, 1),
          target: m.astroTargetName,
          astro: m.astroImageDetails ? { session: m.astroImageDetails.srcDir, stacked: m.astroImageDetails.shotsStacked, taken: m.astroImageDetails.shotsTaken, totalExposureS: m.astroImageDetails.totalExp, ...m.astroImageDetails.params } : undefined,
          exif: m.exifInfo,
        })),
      });
    },
  );

  tool(
    'view_image',
    'Show an image to you. source: "device:/DWARF3/…" (album JPG/PNG or FITS subframe on the telescope), or a library/captures path. FITS and 16-bit stacks are debayered and auto-stretched. Use crop to zoom (fractions 0..1).',
    { source: z.string(), crop: cropSchema, max_size: z.number().int().min(256).max(2048).optional(), stretch: z.boolean().optional() },
    async ({ source, crop, max_size, stretch }) => {
      let { img } = await loadImage(source, hub);
      const header = img.header ? Object.fromEntries(Object.entries(img.header).filter(([k]) => /EXPTIME|GAIN|DATE|OBJECT|RA|DEC|CCD-TEMP|FILTER|BAYER|INSTRUME|FOCAL|TELESCOP/.test(k))) : undefined;
      if (crop) img = cropImage(img, crop);
      return imageResult(img, path.basename(source), { stretch, maxSize: max_size, note: header ? `FITS header: ${JSON.stringify(header)}` : undefined });
    },
  );

  tool(
    'analyze_image',
    'Measure an image numerically: background level & noise, saturation, sharpness, star count, median star HFR/FWHM (focus quality) and roundness (tracking quality), colour balance, with a plain-language assessment. source: tele | wide | stack | device:<path> | library path.',
    { source: z.string(), crop: cropSchema, camera: camera.optional().describe('which lens took it, for plate scale') },
    async ({ source, crop, camera: cam }) => {
      let { img } = await loadImage(source, hub);
      if (crop) img = cropImage(img, crop);
      return text(analyze(img, cam));
    },
  );

  tool(
    'delete_album_items',
    'Delete files from the telescope SD card (frees space). Destructive — only with explicit user approval; set confirm=true.',
    { paths: z.array(z.string()).min(1), media_type: z.number().int().optional(), confirm: z.literal(true) },
    async ({ paths, media_type }) => text(await http.deleteMedia(paths.map((p) => ({ filePath: p, mediaType: media_type ?? 1 })))),
  );

  // ------------------------------------------------------------------ library
  tool(
    'list_device_sessions',
    'List deep-sky imaging sessions stored on the telescope (folder, target, camera, exposure, gain, start time, FITS count, size) and whether each is already in the local library.',
    { counts: z.boolean().optional().describe('include FITS counts/sizes (slower), default true') },
    async ({ counts }) => text(await library.listDeviceSessions(counts !== false)),
  );

  tool(
    'transfer_session',
    `Copy an imaging session from the telescope to the imagery library (${config.paths.library}) in the background: stacked results, metadata, raw FITS subframes ("lights") and the matching calibration frames (darks/flats/bias). session: folder name from list_device_sessions, or "latest". Returns a job id; check with jobs.`,
    { session: z.string(), include_subframes: z.boolean().optional(), include_calibration: z.boolean().optional() },
    async ({ session, include_subframes, include_calibration }) => {
      const job = await library.transferSession(session, { includeSubframes: include_subframes !== false, includeCalibration: include_calibration !== false });
      return text(job);
    },
  );

  tool('transfer_files', 'Copy specific album files (photos, videos, stacked images) from the telescope into the library.', { paths: z.array(z.string()).min(1) }, async ({ paths }) => text(library.transferFiles(paths)));

  tool(
    'jobs',
    'List background jobs (transfers), get one, or cancel one.',
    { action: z.enum(['list', 'get', 'cancel']).optional(), id: z.string().optional() },
    async ({ action, id }) => {
      if (action === 'cancel' && id) return text(library.cancelJob(id) ? 'cancelled' : 'not running');
      if (action === 'get' && id) return text(library.getJob(id) ?? 'no such job');
      return text(library.listJobs());
    },
  );

  tool('list_library', 'What is already in the local imagery library (targets, sessions, number of lights).', {}, async () =>
    text({ root: config.paths.library, targets: library.listLibrary() }),
  );

  // ------------------------------------------------------------------ system
  tool(
    'power',
    'Power & lights: reboot, shutdown (ask the user first), rgb_on/rgb_off (ring light — turn off for astro), indicator_on/indicator_off.',
    { action: z.enum(['reboot', 'shutdown', 'rgb_on', 'rgb_off', 'indicator_on', 'indicator_off']) },
    async ({ action }) => {
      await dwarf.power(action);
      return text(`${action} sent`);
    },
  );

  tool(
    'raw_command',
    'Expert escape hatch: send any DWARF WebSocket command id with protobuf params (camelCase field names). Types default to the built-in registry; otherwise give request_type/response_type like "astro.ReqCaptureDarkFrameWithParam". Use only when no dedicated tool exists, and record what worked in a skill.',
    {
      cmd: z.number().int(),
      params: z.record(z.string(), z.unknown()).optional(),
      request_type: z.string().optional(),
      response_type: z.string().optional(),
      timeout_s: z.number().optional(),
    },
    async ({ cmd, params, request_type, response_type, timeout_s }) =>
      text((await dwarf.raw(cmd, params ?? {}, request_type, response_type, (timeout_s ?? 15) * 1000)) ?? 'no reply'),
  );
}

function compactHour(h: weather.HourForecast) {
  return {
    t: h.local,
    score: h.score,
    rating: h.rating,
    dark: h.dark,
    cloud: `${h.cloudTotal}% (L${h.cloudLow}/M${h.cloudMid}/H${h.cloudHigh})`,
    rain: h.precipProbability,
    wind: `${Math.round(h.windKmh)}/${Math.round(h.gustKmh)} km/h`,
    tempC: h.temperatureC,
    dewSpreadC: h.dewSpreadC,
    seeing: h.seeing,
    transparency: h.transparency,
    issues: h.issues.length ? h.issues : undefined,
  };
}
