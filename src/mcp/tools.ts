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
import { measureTele, starFocusSweep } from '../media/focus.js';
import { findObject, searchObjects, gotoLabel, describe as describeObject } from '../astro/catalog.js';
import { queryCatalog } from '../astro/catalog-search.js';
import { planNight } from '../astro/planner.js';
import * as sky from '../astro/sky.js';
import * as weather from '../astro/weather.js';
import * as library from '../library/transfer.js';
import { listDir } from '../dwarf/ftp.js';
import * as processing from '../processing/queue.js';
import * as studio from '../processing/studio.js';
import type { DutyLoop } from '../agent/duty.js';

const log = logger('mcp');

export interface ToolContext {
  dwarf: Dwarf;
  hub: StreamHub;
  duty?: DutyLoop;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (v: unknown): Result => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });

function fail(err: unknown): Result {
  let msg = errMsg(err);
  if (err instanceof DwarfCommandError) msg = `${msg}\nresponse: ${JSON.stringify(err.response)}`;
  // A bare "aborted due to timeout" told the agent nothing (2026-10-03 night): say what timed out
  // and what that usually means.
  if (/aborted due to timeout|TimeoutError/i.test(msg)) msg = `${msg}\n${http.timeoutExplanation()}`;
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
  const lines = [`${label}: ${img.width}×${img.height}${img.linear ? ' (linear data, auto-stretched for display)' : ''}`, capturedLine(img), `saved as captures/${saved}`].filter(Boolean);
  if (opts.note) lines.push(opts.note);
  return {
    content: config.llm.vision
      ? [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: lines.join('\n') }]
      : [{ type: 'text', text: `${lines.join('\n')}\n(vision disabled: use analyze_image for numbers)` }],
  };
}

function capturedLine(img: FloatImage): string {
  if (!img.capturedAt) return '';
  const age = (Date.now() - img.capturedAt) / 1000;
  return `captured ${new Date(img.capturedAt).toLocaleTimeString('en-US', { timeZone: config.observer.timezone, hour12: false })} (${age < 120 ? `${age.toFixed(1)} s` : `${Math.round(age / 60)} min`} ago)`;
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
  const { dwarf, hub, duty } = ctx;
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
    'Current telescope state: connection, battery, temperatures, storage, shooting mode, Alt-Az/EQ mode, motor angles, focus, calibration/GoTo/tracking, live-stacking progress, polar-alignment result, observer location and local time, and health (camera service responding or hung, live video per camera). Call this first, whenever unsure, and after any timeout.',
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
        motorsNote: 'pitch≈90° is level with the horizon in Alt-Az mode (pitch − 90 ≈ altitude); ~2.5° is the parked/down position. While tracking after a GoTo the motors report homed: false; that is normal, do not re-home a tracking scope.',
        trackingNow: dwarf.isTracking(),
        observer: loc ? { ...loc, timezone: tz } : 'NOT CONFIGURED — set OBSERVER_LATITUDE/OBSERVER_LONGITUDE',
        localTime: new Date().toLocaleString('en-US', { timeZone: tz }),
        busyWith: dwarf.isBusy(),
        health: {
          ...http.apiHealth(),
          video: Object.fromEntries((['tele', 'wide'] as const).map((n) => {
            const v = hub.get(n).status() as ReturnType<typeof hub.tele.status>;
            return [n, { phase: v.phase, lastFrameAgoS: v.lastFrameAt ? Math.round((Date.now() - v.lastFrameAt) / 1000) : null, note: v.note ?? undefined }];
          })),
        },
      });
    },
  );

  tool('telescope_device_info', 'Static device info from the HTTP API: name, serial, firmware, Wi-Fi/STA details, SD card, supported shooting modes.', {}, async () => {
    const [info, fw, modes] = await Promise.all([http.getDeviceInfo(), http.getFirmware().catch(() => null), http.getShootingModes()]);
    return text({ ...info, firmware: fw?.version, shootingModes: modes.map((m) => ({ id: m.id, name: m.name, parent: m.parentId, techniques: m.shootingTechnology.map((t) => http.SHOOTING_TECH_NAMES[t.id] ?? t.id) })) });
  });

  tool('telescope_reconnect', 'Drop and re-open the control connection. Use if commands time out. Note: the official DWARFLAB app must be closed or it takes over the session. Does nothing while the user has released the telescope (Disconnect in the web UI).', {}, async () => {
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
      allow_live_stall: z.boolean().optional().describe('required to set a wide-camera exposure ≥ 1 s: that stops the wide live video until exposure is back to auto (only for wide-camera stacking)'),
    },
    async ({ camera: cam, setting, value, mode, allow_live_stall }) => {
      if (cam === 'wide' && /^(exposure|exp|shutter)$/i.test(setting) && String(value).toLowerCase() !== 'auto') {
        const v = String(value);
        const secs = v.includes('/') ? Number(v.split('/')[0]) / Number(v.split('/')[1]) : Number(v.replace(/s$/i, ''));
        if (secs >= 1 && !allow_live_stall) {
          throw new Error(`a ${v}s manual exposure on the wide camera stops its live video completely (verified). For a night/sky look use sky_check, or view_camera/analyze_image with exposure_s=${v} (one still, settings restored). Pass allow_live_stall=true only for wide-camera stacking. Nothing was changed.`);
        }
      }
      const m = mode ? await http.resolveShootingMode(mode) : undefined;
      const res = await dwarf.setSetting(cam, setting, value, m?.id);
      const modeName = m?.name ?? dwarf.state.shootingMode?.name ?? '?';
      return text(`${res}  [stored in ${modeName} mode — each shooting mode keeps its own camera settings; switching mode (GoTo switches to DSO) uses that mode's values]`);
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
    'Look at what a camera sees right now (returns an image). source: tele | wide | stack (the current live-stacking result). With the camera on auto exposure this is a live frame; with a manual exposure ≥ 1 s (e.g. checking for stars at night) it takes a real still photo at that exposure instead, because the telescope stops its live stream at long exposures. Use crop to zoom into a region; full_resolution grabs a 1920×1080 frame (slower).',
    {
      source: z.enum(['tele', 'wide', 'stack']),
      crop: cropSchema,
      full_resolution: z.boolean().optional(),
      max_size: z.number().int().min(256).max(2048).optional().describe('longest edge of the returned image (default 1280)'),
      stretch: z.boolean().optional().describe('auto-stretch faint data'),
      exposure_s: z.number().positive().max(60).optional().describe('take ONE still at this exposure (e.g. 2 to see stars at night) and restore the camera setting afterwards; keeps the live view working. Prefer this over changing the camera exposure with set_camera_setting.'),
    },
    async ({ source, crop, full_resolution, max_size, stretch, exposure_s }) => {
      let { img } = await loadImage(source, hub, { fullRes: full_resolution, exposureS: source === 'stack' ? undefined : exposure_s });
      if (crop) img = cropImage(img, crop);
      return imageResult(img, `${source} live`, { stretch, maxSize: max_size });
    },
  );

  // ------------------------------------------------------------------ motion
  tool('motors_home', 'Home (reset) both motor axes against their reference switches. Needed after power-on (error -14520 means "no reference"); move_motors also does it by itself when needed. Returns when the telescope reports both axes homed (usually under a minute; from a far starting position it continues past the firmware\'s own time limit, up to several minutes). The scope ends pointing down.', {}, async () => text(await dwarf.homeMotors()));

  tool('motor_position', 'Read the rotation (azimuth axis) and pitch (altitude axis) motor angles.', {}, async () => text(await dwarf.readMotorPositions()));

  tool(
    'move_motors',
    'Move the motors. Returns when the telescope reports the move finished. If the motors have no reference (after power-on, while tracking after a GoTo, or after a failed astro routine), it stops tracking and homes them first by itself. Absolute: pitch ~2.5 parked/down, ~90 level (Alt-Az: altitude ≈ pitch − 90, so 135 ≈ 45° up); rotation ~159 after homing is the centre of travel. relative=true moves BY the given degrees instead. Directions (verified): rotation DEcreasing pans the view RIGHT; pitch increasing tilts UP. To centre a subject at pixel offset (dx right, dy down) from frame centre: rotation_deg = −dx·scale, pitch_deg = −dy·scale, with scale ≈ 0.0235°/px (wide) or 0.0015°/px (tele) for a 1920-px-wide frame (scale by 1920/width for smaller frames). speed 0.1-30 °/s (default 10). Waits until the motion completes.',
    { rotation_deg: z.number().optional(), pitch_deg: z.number().optional(), relative: z.boolean().optional(), speed: z.number().optional() },
    async ({ rotation_deg, pitch_deg, relative, speed }) => {
      if (relative) {
        const p = await dwarf.readMotorPositions();
        if (!p.homed || p.rotationDeg === undefined || p.pitchDeg === undefined) throw new Error('the motors report no position (no reference: while tracking, after power-on or a failed astro routine), so a relative move cannot be computed. Give an absolute move instead (it homes first by itself), or call motors_home. Nothing was moved.');
        for (const [axis, d] of [['rotation_deg', rotation_deg], ['pitch_deg', pitch_deg]] as const) {
          if (d !== undefined && Math.abs(d) > 60) throw new Error(`relative ${axis}=${d}° is too large for a relative nudge (max ±60°). Did you mean an absolute move? Call again without relative. Nothing was moved.`);
        }
        const res = await dwarf.moveTo({ rotationDeg: rotation_deg ? p.rotationDeg + rotation_deg : undefined, pitchDeg: pitch_deg ? p.pitchDeg + pitch_deg : undefined }, speed);
        return text(`relative move (Δrotation ${rotation_deg ?? 0}°, Δpitch ${pitch_deg ?? 0}°): ${res}`);
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
    'Run the telescope\'s own autofocus. normal = contrast AF for daytime/Moon/planets at a point (x,y in 1920×1080 tele frame, default centre). astro = star-based AF for deep sky (needs stars in view, takes ~1-3 min). Returns when the telescope reports AF finished, and says so plainly if it never did. This is the FINDER: it searches the whole range and gets you close. At night, run it first, then tune what it found with star_focus (a fine search around the result) and check the number with star_sharpness.',
    { mode: z.enum(['normal', 'astro']), x: z.number().optional(), y: z.number().optional() },
    async ({ mode, x, y }) => text(await dwarf.autofocus(mode, x, y)),
  );

  tool(
    'star_sharpness',
    'Measure how sharp the stars are in one tele frame and get the focus number: median star half-flux radius (HFR) in px and arcsec, and `score` = 1000 ÷ HFR(arcsec), higher = sharper (on this scope ~250-450 is sharp, <120 is soft). Every part of it is flux-weighted per star against that star\'s own local sky, so it does not move with exposure, gain, cloud thickness, sky glow or the camera\'s tone curve — two scores from minutes apart are comparable, which is what makes it usable as a trend. It only measures; it does not focus. Order of work: autofocus (the finder) → star_focus (a fine sweep that also moves the focuser) → star_sharpness to confirm; or focus_step + this to nudge by hand. Run it after autofocus, between focus_step moves, and once per target as the night\'s baseline. By default it takes the reading from a short (0.5 s) snapshot when the camera sits on auto or a long exposure, then puts the setting back — a long exposure writes star trails into the number. Raise gain if the stars are too faint to measure.',
    {
      exposure_s: z.number().min(0.05).max(60).optional().describe('take the ONE still at this exposure instead of the default short snapshot; the camera setting is restored afterwards either way'),
      gain: z.number().min(0).max(240).optional().describe('gain for that still, restored afterwards'),
      crop: cropSchema.describe('measure one region (fractions 0..1); give every frame you compare the same region'),
    },
    async ({ exposure_s, gain, crop }) => {
      const { img, sharp } = await measureTele({ dwarf, hub }, { exposureS: exposure_s, gain, crop });
      const jpeg = await toJpeg(img.linear ? autoStretch(img) : img, 1024);
      const saved = saveCapture(jpeg, 'star_sharpness');
      const report = { focusPosition: dwarf.state.focusPosition, captured: capturedLine(img) || undefined, ...sharp, image: `captures/${saved}` };
      const body = JSON.stringify(report, null, 1);
      return { content: config.llm.vision ? [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: body }] : [{ type: 'text', text: body }] };
    },
  );

  tool(
    'star_focus',
    'Fine-tune the tele focus on the stars. Sweeps the focuser up and down around its current position, takes a tele still at every position, scores its stars (the star_sharpness measurement) and leaves the focuser on the sharpest position, refined by fitting the curve through the samples around the best one. Run autofocus (mode=astro) FIRST to get close — autofocus is the whole-range finder, this is the narrow-range tuner; with no stars in view at all start from focus_position action=infinity instead. Use it after autofocus, after >5 °C of cooling, and whenever star_sharpness or analyze_subs says the HFR has grown. Camera exposure/gain are restored afterwards; ~10 s per sample (default 13 samples ≈ 2-3 min). Refuses while live stacking, a GoTo or calibration runs.',
    {
      center: z.number().int().min(0).optional().describe("focus units to centre the search on; default the focuser's current position"),
      range: z.number().int().min(5).max(400).optional().describe('focus units to cover on each side of the centre (default 30)'),
      step: z.number().int().min(1).max(50).optional().describe('focus units between samples (default 5)'),
      exposure_s: z.number().min(0.05).max(15).optional().describe("exposure of the measurement stills; default the camera's current one when it is ≤ 1 s, else 0.5 s"),
      gain: z.number().min(0).max(240).optional().describe('gain for the measurement stills, restored afterwards'),
      crop: cropSchema.describe('score only this region of every frame; the same region for all samples'),
      repeats: z.number().int().min(1).max(3).optional().describe('frames averaged per position when the sky is unsteady (default 1)'),
      apply: z.boolean().optional().describe('false = measure only: the focuser goes back to the centre of the range it searched (where the sweep started); default leaves it on the sharpest position'),
    },
    async ({ center, range, step, exposure_s, gain, crop, repeats, apply }) => {
      const r = await starFocusSweep({ dwarf, hub }, { center, range, step, exposureS: exposure_s, gain, crop, repeats, apply });
      const table = r.samples
        .map((s) => `${String(s.position).padStart(4)}  ${s.error ? `FAILED: ${s.error}` : `score ${String(s.score).padStart(4)}  HFR ${String(s.hfrArcsec ?? s.hfrPx).padStart(5)}${s.hfrArcsec ? '″' : 'px'} ±${s.hfrUncertaintyPx}  ${String(s.stars).padStart(3)} stars  ${s.seconds}s`}`)
        .join('\n');
      const lines = [r.verdict, ...r.notes.map((x) => `note: ${x}`), '', `settings: ${r.settings}`, r.final ? `final position ${r.finalPosition}: HFR ${r.final.hfrArcsec ?? r.final.hfrPx}${r.final.hfrArcsec ? '″' : 'px'}, score ${r.final.score}` : '', `samples (${r.elapsedS} s):`, table];
      const cautions = [...new Set([r.best, r.final].filter(Boolean).flatMap((s) => s!.cautions ?? []))];
      if (cautions.length) lines.push('', `cautions: ${cautions.join(' | ')}`);
      let jpeg: Buffer | undefined;
      if (r.finalImage) {
        jpeg = await toJpeg(r.finalImage.linear ? autoStretch(r.finalImage) : r.finalImage, 1024);
        lines.push(`final frame: captures/${saveCapture(jpeg, `star_focus_${r.finalPosition}`)}`);
      }
      return { content: [...(config.llm.vision && jpeg ? [{ type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] : []), { type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  tool(
    'focus_step',
    'Move the tele focuser manually. direction near (closer objects) or far (towards infinity); steps 1-200. Check the effect with star_sharpness (the star focus number) between moves — for stars that is the right meter, not analyze_image sharpness. For a whole search in one call use star_focus instead.',
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
        return text({ ...t, hours: t.hours.map(compactHour), ...forecastStaleness(t) });
      }
      const f = await weather.forecast(s, tz);
      const now = Date.now() - 3600e3;
      const n = period === 'next24' ? 24 : 72;
      return text({ fetchedAt: f.fetchedAt, ageMin: f.ageMin, stale: f.stale, current: f.current, hours: f.hours.filter((h) => new Date(h.time).getTime() >= now).slice(0, n).map(compactHour), ...forecastStaleness(f) });
    },
  );

  tool(
    'sky_check',
    'One-call clear-sky check: points nowhere (uses the current pointing), takes a single wide-camera still at night settings (default 2.5 s, gain 60), restores the camera\'s previous exposure/gain, and returns the star count, background level, a verdict (clear / partly clear / cloudy / bright) and the image. Raise the scope above ~60° altitude first (pitch > 150). Use this instead of hand-setting exposure/gain + take_photo + analyze_image.',
    {
      exposure_s: z.number().min(0.2).max(15).optional().describe('default 2.5'),
      gain: z.number().min(0).max(240).optional().describe('default 60'),
    },
    async ({ exposure_s, gain }) => {
      const exp = exposure_s ?? 2.5;
      const g = gain ?? 60;
      const pos = await dwarf.readMotorPositions().catch(() => null);
      const settings = await dwarf.cameraSettings('wide');
      const prevGain = (settings.settings.gain as { current?: unknown } | undefined)?.current;
      // Restore exposure to the previous *known* value; if unknown, auto (a long manual exposure
      // left on the wide camera stops its live video entirely).
      const prevExpRaw = (settings.settings.exposure as { current?: unknown } | undefined)?.current;
      const prevExp = typeof prevExpRaw === 'string' && !prevExpRaw.startsWith('unknown') && !(Number(prevExpRaw) >= 1) ? prevExpRaw : 'auto';
      await dwarf.setSetting('wide', 'gain', g);
      let img: FloatImage;
      try {
        ({ img } = await loadImage('wide', hub, { exposureS: exp }));
      } catch (err) {
        throw new Error(`sky_check could not take its still, so the sky is UNKNOWN (not cloudy): ${errMsg(err)}`);
      } finally {
        if (typeof prevGain === 'number') await dwarf.setSetting('wide', 'gain', prevGain).catch(() => {});
        await dwarf.setSetting('wide', 'exposure', prevExp).catch(() => {});
      }
      const a = analyze(img, 'wide');
      const stars = a.stars.count;
      const bg = a.stats.median;
      const verdict = a.assessment.some((x) => x.startsWith('FLAT')) ? 'invalid frame (blank)' : bg > 0.6 ? 'too bright (twilight, Moon glow or a lit cloud deck)' : stars >= 40 ? 'clear' : stars >= 10 ? 'partly clear / thin cloud' : 'cloudy (no usable stars)';
      const jpeg = await toJpeg(autoStretch(img), 1024);
      const saved = saveCapture(jpeg, 'sky_check');
      const summary = {
        verdict,
        stars,
        backgroundMedian: bg,
        medianHfrPx: a.stars.medianHfrPx,
        pointing: pos ? { rotationDeg: pos.rotationDeg, pitchDeg: pos.pitchDeg, altitudeDeg: pos.pitchDeg !== undefined ? Math.round(pos.pitchDeg - 90) : undefined } : undefined,
        settingsUsed: `${exp}s, gain ${g} (camera restored to ${prevExp ?? '?'} / gain ${prevGain ?? '?'})`,
        captured: capturedLine(img),
        image: `captures/${saved}`,
        notes: pos?.pitchDeg !== undefined && pos.pitchDeg < 120 ? 'pointing is low (< 30° altitude): trees, houses and haze will reduce the star count' : undefined,
      };
      return {
        content: config.llm.vision
          ? [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: JSON.stringify(summary, null, 1) }]
          : [{ type: 'text', text: JSON.stringify(summary, null, 1) }],
      };
    },
  );

  tool(
    'plan_targets',
    'Rank deep-sky targets for tonight (or a given window) for the Dwarf 3 tele camera. Each target gets a visibility score (hours above the minimum altitude, peak altitude, size vs field of view, brightness, Moon separation), scaled by weatherAlignment: how good the hourly forecast (clouds, rain, wind, dew, seeing, transparency) is during that target\'s own best hours, weighted toward its peak. The best targets are those whose optimal time coincides with good weather. bestTime is the target\'s own peak; skyAtBest is the forecast then; clearHours are its forecast-weighted hours up. Use before choosing what to image, and schedule each target around its bestTime.',
    {
      types: z.array(z.string()).optional().describe('galaxy, nebula, emission, planetary, cluster, globular, open_cluster, supernova_remnant, reflection, dark, galaxy_cluster'),
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
      const observability = (await weather.observabilityAt(site(), tz)) ?? undefined;
      return text(
        planNight(site(), {
          observability,
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
    'Look up a target by name (M31, NGC 7000, IC 1396, C 33, Sh2-155, LBN 437, vdB 142, B 33, Abell 39, UGC 12889, HCG 92, Vega, "alpha Lyr", "Orion Nebula", Jupiter, Moon…): J2000 coordinates, type, size, magnitude, other designations, current altitude/azimuth and tonight\'s visibility. goto_name is the name to give goto_target.',
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
        goto_name: gotoLabel(o),
        designations: o.aliases.slice(0, 12),
        brightnessClass: o.brightClass,
        catalogs: o.sources,
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

  tool(
    'search_catalog',
    'Search and filter the object database (~45,000 objects: NGC/IC/Messier/Caldwell, Sharpless, LBN/LDN, Barnard, vdB, Cederblad, RCW, planetary nebulae, supernova remnants, open/globular clusters, RC3 galaxies, Arp, Hickson, Abell clusters, bright stars with IAU names). Use it to find candidates plan_targets does not rank (dark nebulae, faint Sharpless regions, a constellation\'s galaxies, what is up right now). Each result has its altitude now, peak altitude, hours above min_altitude and best time tonight.',
    {
      query: z.string().optional().describe('name or designation, substring match ("veil", "sh2-1", "arp")'),
      types: z.array(z.string()).optional().describe('groups: galaxy, galaxy_cluster, nebula, emission, planetary, cluster, globular, open_cluster, supernova_remnant, reflection, dark, star; or type codes (G, HII, RfN, DrkN, PN, OCl, GCl, SNR…)'),
      constellation: z.string().optional().describe('IAU abbreviation, e.g. Cyg'),
      catalog: z.string().optional().describe('messier, caldwell, or a source: openngc, sh2, lbn, ldn, barnard, vdb, ced, rcw, pn, green, dias, harris, rc3, arp, hcg, aco, bsc, iau'),
      max_magnitude: z.number().optional(),
      min_size_arcmin: z.number().optional(),
      max_size_arcmin: z.number().optional(),
      named: z.boolean().optional().describe('only objects with a common name'),
      up: z.enum(['now', 'tonight']).optional().describe('now: above min_altitude now; tonight: at least min_hours above it during darkness'),
      min_altitude: z.number().optional(),
      min_hours: z.number().optional().describe('with up=tonight; default 1'),
      sort: z.enum(['relevance', 'name', 'mag', 'size', 'altitude', 'hours', 'transit', 'ra']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('default 25'),
      offset: z.number().int().min(0).optional(),
    },
    async (a) => {
      return text(queryCatalog(
        {
          q: a.query,
          types: a.types,
          constellation: a.constellation,
          catalog: a.catalog,
          maxMag: a.max_magnitude,
          minSize: a.min_size_arcmin,
          maxSize: a.max_size_arcmin,
          named: a.named,
          up: a.up,
          minAlt: a.min_altitude ?? config.observer.minAltitudeDeg,
          minHours: a.min_hours,
          sort: a.sort,
          offset: a.offset,
          limit: a.limit ?? 25,
        },
        site(),
        tz,
      ));
    },
  );

  // ------------------------------------------------------------------ astro operations
  tool(
    'calibrate',
    'Astro calibration (plate-solve the sky to learn pointing). Needs a clear sky, synced time/location, DSO mode, and motors homed. Takes ~1-3 minutes and returns when the telescope reports the result (or that plate-solving failed). Required before goto_target unless one_click is used.',
    {},
    async () => text(await dwarf.withPointingRecovery('calibration', () => dwarf.calibrate())),
  );

  tool(
    'goto_target',
    'Slew to and track a target. Give a name (catalog object or planet/Moon/Sun) or ra_hours+dec_deg (J2000). one_click (default true) = calibrate + GoTo in one step. Returns when the telescope reports it is tracking the target (usually 1-3 minutes, at most 10), or with the telescope\'s error code. NEVER point at the Sun without a solar filter.',
    {
      name: z.string().optional(),
      ra_hours: z.number().min(0).max(24).optional(),
      dec_deg: z.number().min(-90).max(90).optional(),
      one_click: z.boolean().optional(),
    },
    async ({ name, ra_hours, dec_deg, one_click }) => {
      const oneClick = one_click !== false;
      if (ra_hours !== undefined && dec_deg !== undefined) return text(await dwarf.withPointingRecovery('GoTo', () => dwarf.gotoRaDec(ra_hours, dec_deg, name ?? 'Custom', oneClick)));
      if (!name) throw new Error('give a target name or ra_hours + dec_deg');
      const body = sky.bodyByName(name);
      if (body) {
        if (body === 'Sun') throw new Error('Pointing at the Sun requires the solar filter fitted. Use track_sun_moon after the user confirms the filter is on.');
        return text(await dwarf.withPointingRecovery('GoTo', () => dwarf.gotoSolarSystem(body, oneClick)));
      }
      const o = findObject(name);
      if (!o) throw new Error(`"${name}" not found; use find_target or give coordinates`);
      const alt = sky.altAz(site(), o.raHours, o.decDeg).altitude;
      if (alt < 5) throw new Error(`${o.id} is below the horizon (altitude ${alt.toFixed(1)}°)`);
      // The scope names the session folder after this (see gotoLabel): the DWARF app's choice, so
      // nights captured with the app and with us carry the same target name and stack together.
      const label = gotoLabel(o);
      try {
        return text(await dwarf.withPointingRecovery('GoTo', () => dwarf.gotoRaDec(o.raHours, o.decDeg, label, oneClick)));
      } catch (err) {
        const m = errMsg(err);
        if (/-11504/.test(m)) throw new Error(`${m} Calibration failed because plate-solving found no usable stars (cloud, obstruction, dew or daylight) at this pointing. Check the sky with sky_check (other directions too) before retrying.`);
        if (/-11505/.test(m)) throw err;
        if (/timed out/i.test(m)) throw new Error(`${m} The GoTo did not finish; this is NOT a cloud verdict. Check telescope_status.health: a hung camera service also stops plate-solving.`);
        throw err;
      }
    },
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
      dwarf.stackControl[cam] = { startedBy: 'agent' };
      const r = await dwarf.startStacking(cam, { filterIndex, force: a.force });
      return text(`${applied.join('\n')}\n${r}`.trim());
    },
  );

  tool(
    'stacking_status',
    'Live-stacking progress: frames taken/stacked/target, integration time, target, plus whether frames are being rejected. Use view_camera source "stack" to see the stacked image. After a stop and restart on the same target the telescope keeps counting from the earlier stack but writes the new subs to a NEW DWARF_RAW session folder (verified 2026-10-04): process those sessions together (process_session target=…).',
    {},
    async () => {
      const s = dwarf.state.stacking;
      // fw 1.5.3 progress messages carry no stacked time: use stacked subs x the sub exposure of
      // the running session (its folder name says EXP_<s>)
      let subS: number | undefined;
      if (s.tele.state === 'running' || s.wide.state === 'running') {
        const newest = (await library.listDeviceSessions(false).catch(() => ({ sessions: [] as library.DeviceSession[] }))).sessions[0];
        subS = newest?.exposureS;
      }
      const describe = (x: typeof s.tele) => ({
        ...x,
        rejected: x.currentCount !== undefined && x.stackedCount !== undefined ? x.currentCount - x.stackedCount : undefined,
        subExposureS: x.state === 'running' ? subS : undefined,
        integrationMinutes: x.stackedTimeS !== undefined ? round(x.stackedTimeS / 60, 1) : x.stackedCount !== undefined && subS ? round((x.stackedCount * subS) / 60, 1) : undefined,
        lastUpdateAgoS: x.updatedAt ? Math.round((Date.now() - x.updatedAt) / 1000) : undefined,
      });
      return text({ tele: describe(s.tele), wide: describe(s.wide), stackPreviewAvailable: !!hub.stack.latest, stackPreviewAgeS: hub.stack.latest ? Math.round((Date.now() - hub.stack.latest.at) / 1000) : null });
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
      // Where the rotation axis points, against where the pole is (the latitude): what the
      // firmware's own measurement says needs to change, without assuming how the wedge is set.
      const lat = dwarf.location()?.lat;
      if (lat !== undefined) {
        const axisAlt = lat - r.altitudeErrorDeg;
        out.rotationAxis = `points at altitude ${axisAlt.toFixed(1)}°, azimuth ${(-r.azimuthErrorDeg).toFixed(1)}°; the celestial pole is at altitude ${Math.abs(lat).toFixed(1)}°, azimuth ${lat >= 0 ? 0 : 180}°`;
        out.correction = `${Math.abs(r.altitudeErrorDeg) >= 0.05 ? `${r.altitudeErrorDeg < 0 ? 'lower' : 'raise'} the rotation axis by ${Math.abs(r.altitudeErrorDeg).toFixed(1)}°` : 'altitude is on'}; ${Math.abs(r.azimuthErrorDeg) >= 0.05 ? `turn it ${Math.abs(r.azimuthErrorDeg).toFixed(1)}° ${r.azimuthErrorDeg < 0 ? 'east' : 'west'} (to be confirmed by the next measurement)` : 'azimuth is on'}. Measure again after each adjustment (about 15 s). EQ mode engages only once the error is small; until then GoTo cannot work on a tilted base.`;
      }
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
    {
      source: z.string(),
      crop: cropSchema,
      camera: camera.optional().describe('which lens took it, for plate scale'),
      exposure_s: z.number().positive().max(60).optional().describe('for tele/wide: analyse ONE still at this exposure (e.g. 2 s to count stars at night), restoring the camera setting afterwards'),
    },
    async ({ source, crop, camera: cam, exposure_s }) => {
      let { img } = await loadImage(source, hub, { exposureS: source === 'tele' || source === 'wide' ? exposure_s : undefined });
      if (crop) img = cropImage(img, crop);
      return text({ captured: capturedLine(img) || undefined, ...analyze(img, cam) });
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
    `Copy an imaging session from the telescope to the imagery library (${config.paths.library}) in the background: stacked results, metadata, raw FITS subframes and the matching calibration masters (CALI_FRAME). session: folder name from list_device_sessions, or "latest". Returns a job id; check with jobs. ${config.studio.url ? `When it finishes, processing in AstroPhoto Studio is queued automatically${config.studio.autoProcess ? '' : ' only if process=true'} (profile ${config.studio.profile}); follow it with processing_status.` : 'Processing is off (ASTROPHOTO_URL not set).'}`,
    {
      session: z.string(),
      include_subframes: z.boolean().optional(),
      include_calibration: z.boolean().optional(),
      process: z.boolean().optional().describe(`queue processing after the transfer (default ${config.studio.autoProcess && !!config.studio.url})`),
      profile: z.string().optional().describe('processing profile for this session (names from processing_status); default from .env'),
      pool: z.boolean().optional().describe(`process this session pooled with every earlier library session of the same target, as one multi-night image (default ${config.studio.poolSessions})`),
    },
    async ({ session, include_subframes, include_calibration, process, profile, pool }) => {
      const job = await library.transferSession(session, { includeSubframes: include_subframes !== false, includeCalibration: include_calibration !== false, process, profile, pool, origin: 'agent' });
      return text({ ...job, note: 'Runs in the background; Astrocontroller tells you with an event when it ends (done, partial or failed), and again when its processing finishes. No need to poll.' });
    },
  );

  // ------------------------------------------------------------------ processing (AstroPhoto Studio)
  tool(
    'processing_status',
    'AstroPhoto Studio processing: whether the server is reachable, its GPU, the processing profiles it offers and the one configured, the local outbox (sessions waiting to be sent, uploading, processing on the server, done, failed) and the server queue with ETAs. Items wait in the outbox while the server is out of reach (field sessions) and go out by themselves later.',
    { server_queue: z.boolean().optional().describe('include the server queue and server info (default true)') },
    async ({ server_queue }) => {
      const out: Record<string, unknown> = { server: processing.reachability(), configuredProfile: config.studio.profile, dataAccess: config.studio.dataAccess, autoProcess: config.studio.autoProcess };
      if (config.studio.url && server_queue !== false) {
        try {
          const i = await studio.info();
          out.serverInfo = { version: i.version, device: i.devices?.default, gpus: i.devices?.gpus?.map((g) => g.name), profiles: Object.fromEntries(Object.entries(i.profiles).map(([k, v]) => [k, v.label])), defaultProfile: i.default_profile };
          if (!(config.studio.profile in i.profiles)) out.warning = `ASTROPHOTO_PROFILE=${config.studio.profile} is not a profile this server offers`;
          const q = await studio.queue();
          out.serverQueue = { drainsInMin: q.drains_in != null ? Math.round(q.drains_in / 60) : null, jobs: [...q.running, ...q.queued].map((j) => ({ id: j.id, label: j.label ?? j.dataset, state: j.state, profile: j.profile, progress: Math.round(j.progress * 100) + '%', stage: j.message, position: j.position, etaMin: j.total_eta != null ? Math.round(j.total_eta / 60) : undefined })) };
        } catch (e) {
          out.serverError = errMsg(e);
        }
      }
      out.outbox = processing.listItems(20).map((i) => ({ id: i.id, target: i.target, sessions: i.sessions, profile: i.profile, state: i.state, access: i.access, studioJob: i.studioJobId, message: i.message, upload: i.upload, outputs: i.outputs, created: new Date(i.createdAt).toLocaleString('en-US', { timeZone: tz }) }));
      return text(out);
    },
  );

  tool(
    'process_session',
    'Queue processing in AstroPhoto Studio (normally automatic after transfer_session). ONE job = ONE image: every session given is pooled into one stack, so several nights of the same object (sessions from different days) become one deep image. Give target (every library session of that target, e.g. all nights of NGC 7000) and/or sessions (DWARF_RAW_… folder names from list_library, to pick specific nights). The server keeps the dominant filter/exposure group across the pool, so do not mix filters (e.g. Duo-Band and Astro nights) unless intended. profile: one of the server\'s profiles (processing_status), default from .env.',
    {
      sessions: z.array(z.string()).optional(),
      target: z.string().optional().describe('add every library session of this target (as named in list_library)'),
      camera: z.enum(['tele', 'wide']).optional().describe('with target: only this camera (default tele)'),
      label: z.string().optional().describe('name of the pooled image (default: the target)'),
      profile: z.string().optional(),
      kind: z.string().optional().describe('job kind (default "all" = analyse, stack, restore, star remover, export)'),
    },
    async ({ sessions, target, camera, label, profile, kind }) => {
      const names = (sessions ?? []).map((s) => s.replace(/\/+$/, '').split('/').pop()!);
      if (target) names.push(...library.librarySessionsFor(target, camera ?? 'tele'));
      const unique = [...new Set(names)];
      if (!unique.length) throw new Error(target ? `no library sessions of "${target}" (list_library)` : 'give sessions and/or target');
      const targets = [...new Set(unique.map((n) => library.parseSessionFolder(n)?.target ?? n))];
      const name = label ?? target ?? targets[0];
      const it = processing.enqueueProcessing({ sessions: unique, target: name, profile, kind, origin: 'agent' });
      return text({ ...it, note: `${unique.length} session(s) pooled into one image${targets.length > 1 ? ` (folder targets: ${targets.join(', ')})` : ''}` });
    },
  );

  tool(
    'processing_job',
    'Act on one processing item (id from processing_status: the local proc_… id or the server job id). get = details; cancel = stop it (also on the server); retry = send a failed/cancelled item again; move = change its place in the server queue (position 1 = next).',
    { action: z.enum(['get', 'cancel', 'retry', 'move']), id: z.string(), position: z.number().int().min(1).optional() },
    async ({ action, id, position }) => {
      if (action === 'cancel') return text(await processing.cancelItem(id));
      if (action === 'retry') return text(processing.retryItem(id));
      const it = processing.getItem(id);
      if (action === 'move') {
        const jobId = it?.studioJobId ?? id;
        return text(await studio.move(jobId, position ?? 1));
      }
      if (!it) throw new Error(`no processing item ${id}`);
      const server = it.studioJobId ? await studio.job(it.studioJobId).catch((e) => ({ error: errMsg(e) })) : undefined;
      return text({ ...it, server });
    },
  );

  tool(
    'analyze_subs',
    'Quality check of the newest RAW subframes (FITS) of an imaging session on the SD card, while it runs: per sub the star count, HFR/FWHM (focus), roundness (tracking / field rotation), background, saturation, sensor temperature and whether the scope rejected it (failed_). Use during live stacking to judge focus drift, trailing, dew or cloud from real subs rather than the stretched stack preview. Each sub is ~16 MB over Wi-Fi.',
    {
      count: z.number().int().min(1).max(6).optional().describe('newest N subs (default 3)'),
      session: z.string().optional().describe('DWARF_RAW_… folder; default the newest session'),
    },
    async ({ count, session }) => {
      const folder = session ?? (await library.listDeviceSessions(false)).sessions[0]?.folder;
      if (!folder) throw new Error('no astronomy sessions on the SD card');
      const files = (await listDir(`/Astronomy/${folder}`)).filter((f) => !f.isDir && /\.fits$/i.test(f.name) && !/^stacked/i.test(f.name));
      const stamp = (n: string) => n.match(/(\d{8}-\d{9})/)?.[1] ?? n;
      files.sort((a, b) => stamp(a.name).localeCompare(stamp(b.name)));
      const pick = files.slice(-(count ?? 3));
      const subs = [];
      for (const f of pick) {
        const { img } = await loadImage(`device:/DWARF3/Astronomy/${folder}/${f.name}`, hub);
        const a = analyze(img, 'tele');
        subs.push({
          file: f.name,
          rejectedByScope: f.name.startsWith('failed_'),
          sensorC: Number(f.name.match(/_(-?\d+)C\.fits$/i)?.[1]) || undefined,
          stars: a.stars.count,
          hfrPx: a.stars.medianHfrPx,
          fwhmArcsec: a.stars.medianFwhmArcsec,
          roundness: a.stars.medianRoundness,
          background: a.stats.median,
          saturatedPct: a.saturatedPercent,
          notes: a.assessment.length ? a.assessment : undefined,
        });
      }
      const med = (xs: Array<number | undefined>) => {
        const v = xs.filter((x): x is number => typeof x === 'number').sort((p, q) => p - q);
        return v.length ? v[Math.floor(v.length / 2)] : undefined;
      };
      return text({
        session: folder,
        subsOnCard: files.length,
        rejectedOnCard: files.filter((f) => f.name.startsWith('failed_')).length,
        median: { stars: med(subs.map((s) => s.stars)), hfrPx: med(subs.map((s) => s.hfrPx)), roundness: med(subs.map((s) => s.roundness)), background: med(subs.map((s) => s.background)) },
        subs,
      });
    },
  );

  tool(
    'dark_frames',
    'Dark-frame library (tele camera). An ND session: the operator fits the magnetic ND filter over the lenses (they tilt the scope by hand) -> nd_fitted (locks every motion and light capture: moving or parking would knock the filter off) -> capture each master (runs in the background, ~frames x exposure + 1 min; you get an event when it is saved) -> the operator removes the filter -> nd_removed. Actions: list (masters on the scope, firmware codes, sensor temperature), nd_fitted, capture, status, stop, nd_removed. NEVER move, park or home the scope during an ND session.',
    {
      action: z.enum(['list', 'nd_fitted', 'capture', 'status', 'stop', 'nd_removed']),
      exposure_s: z.number().positive().optional(),
      gain: z.number().optional(),
      frames: z.number().int().min(5).max(20).optional().describe('frames stacked into the master (default 20, the firmware maximum)'),
      operator_confirmed: z.boolean().optional().describe('nd_fitted / nd_removed: the operator told you the ND filter is on / off'),
      nd_filter_confirmed: z.boolean().optional().describe('capture: same as calling nd_fitted first'),
    },
    async ({ action, exposure_s, gain, frames, operator_confirmed, nd_filter_confirmed }) => {
      const dc = () => {
        const d = dwarf.state.darkCapture;
        if (!d) return { state: 'none' };
        const now = Date.now();
        return { ...d, elapsedMin: d.startedAt ? round((now - (d.finishedAt ?? now) + ((d.finishedAt ?? now) - d.startedAt)) / 60000, 1) : undefined, remainingMin: d.state === 'running' && d.expectedEndAt ? Math.max(0, round((d.expectedEndAt - now) / 60000, 1)) : undefined };
      };
      if (action === 'status') return text({ capture: dc(), ndLock: dwarf.state.ndLock ?? null, sensorNowC: dwarf.state.cmosTempC.tele });
      if (action === 'stop') {
        await dwarf.stopDarks();
        return text({ stopped: true, capture: dc() });
      }
      if (action === 'nd_fitted') {
        if (operator_confirmed !== true) throw new Error('Only after the operator has said the ND filter is on: call again with operator_confirmed=true.');
        dwarf.setNdLock(true, 'operator confirmed the ND filter');
        return text('ND session started: motion, homing, GoTo, calibration, stacking and tracking are locked until nd_removed. Do not move or park the scope.');
      }
      if (action === 'nd_removed') {
        if (operator_confirmed !== true) throw new Error('Only after the operator has said the ND filter is off: call again with operator_confirmed=true.');
        if (dwarf.state.darkCapture?.state === 'running') throw new Error('a dark capture is still running; wait for it (status) or stop it first');
        dwarf.setNdLock(false);
        return text('ND session ended, motion unlocked. The scope was tilted by hand, so its motor position is unknown: run motors_home before any pointing.');
      }
      if (action === 'list') {
        const listed = await dwarf.darkFrameList().catch((e) => ({ error: errMsg(e) }));
        const files = await listDir('/Astronomy/CALI_FRAME/dark/cam_0').catch(() => []);
        const masters = files.filter((f) => /\.fits$/i.test(f.name)).map((f) => ({
          file: f.name,
          exposureS: Number(f.name.match(/exp_([\d.]+)/)?.[1]),
          gain: Number(f.name.match(/gain_(\d+)/)?.[1]),
          tempC: Number(f.name.match(/_(-?\d+)C(?:_|\.)/)?.[1]),
          stack: Number(f.name.match(/stack_(\d+)/)?.[1] ?? 1),
        }));
        return text({ sensorNowC: dwarf.state.cmosTempC.tele, ndLock: dwarf.state.ndLock ?? null, capture: dc(), firmwareList: listed, masterFiles: masters });
      }
      // capture
      if (!dwarf.state.ndLock) {
        if (nd_filter_confirmed !== true) throw new Error('Ask the operator to fit the ND filter (no parking: they tilt the scope by hand), wait for their confirmation, then dark_frames action=nd_fitted operator_confirmed=true. Nothing was captured.');
        dwarf.setNdLock(true, 'confirmed with the first capture');
      }
      if (exposure_s === undefined || gain === undefined) throw new Error('exposure_s and gain are required');
      const listed = await dwarf.darkFrameList();
      // The firmware addresses exposure and gain by its own index codes; its dark list pairs them with names.
      const expHit = listed.find((d) => Math.abs(parseFloat(d.exposure) - exposure_s) < 0.01);
      const gainHit = listed.find((d) => Math.abs(parseFloat(d.gain) - gain) < 0.01);
      if (!gainHit) throw new Error(`no known gain code for gain ${gain}: the firmware's dark list only covers gains ${[...new Set(listed.map((d) => d.gain))].join(', ') || 'none'}. Capture a dark at that gain once with the DWARFLAB app, then this tool can repeat it.`);
      if (!expHit) throw new Error(`no known exposure code for ${exposure_s} s: the firmware's dark list covers ${[...new Set(listed.map((d) => d.exposure))].join(', ') || 'none'}. Capture that exposure once with the DWARFLAB app, then this tool can repeat it.`);
      const n = frames ?? 20;
      await dwarf.ensureMode('DSO');
      await dwarf.captureDarks({ expIndex: expHit.expIndex, gainIndex: gainHit.gainIndex, binIndex: expHit.binIndex, frames: n, exposureS: exposure_s, gain });
      return text(`dark capture running in the background: ${exposure_s} s, gain ${gain}, ${expHit.bin || 'bin1'}, ${n} frames, ≈${Math.ceil((n * exposure_s) / 60) + 1} min, sensor ${dwarf.state.cmosTempC.tele ?? '?'} °C. The telescope never acknowledges this command; Astrocontroller detects the finished master when it appears in CALI_FRAME and wakes you with an event (dark master saved, or why it failed). End your turn now; on that event start the next master. The scope must not move until the operator has removed the ND filter.`);
    },
  );

  tool('transfer_files', 'Copy specific album files (photos, videos, stacked images) from the telescope into the library. Runs in the background; you get an event when it ends.', { paths: z.array(z.string()).min(1) }, async ({ paths }) => text(library.transferFiles(paths, 'agent')));

  tool(
    'jobs',
    'List background jobs (transfers), get one, or cancel one. Transfer status: done; partial = finished but some files could not be copied after 3 attempts each (error lists them; run the same transfer again: copied files are skipped); failed = could not run at all (e.g. telescope unreachable).',
    { action: z.enum(['list', 'get', 'cancel']).optional(), id: z.string().optional() },
    async ({ action, id }) => {
      if (action === 'cancel' && id) return text(library.cancelJob(id) ? 'cancelled' : 'not running');
      if (action === 'get' && id) return text(library.getJob(id) ?? 'no such job');
      return text(library.listJobs());
    },
  );

  tool('list_library', 'What is already in the imagery library: sessions (DWARF_RAW_… folders) by target, with their number of subs (lights) and rejected subs.', {}, async () =>
    text({ root: config.paths.library, targets: library.listLibrary() }),
  );

  // ------------------------------------------------------------------ duty (closed-loop control)
  tool(
    'duty',
    'Your duty loop: while on duty, Astrocontroller wakes you with the objective and fresh measurements every few minutes and on events, so ending your turn never ends the work. start: when the user gives you an objective to carry out unattended (a night of imaging, a dark library, transfers to see through), start a duty with the user\'s instruction as the objective, word for word, and an end time (until: "dawn" for night imaging unless the user said otherwise, "HH:MM", or "none"). next_check: choose when the next sample comes (in_s 30-900) when the default does not fit, e.g. 60 s while sweeping for clear sky, 600 s while a long stack runs fine; this replaces waiting. status: the duty as it stands. complete: only when the objective is fully done; refused before the end time. Only the user can stop or pause a duty.',
    {
      action: z.enum(['start', 'status', 'next_check', 'complete']),
      objective: z.string().optional().describe("start: the user's instruction, verbatim"),
      until: z.string().optional().describe('start: "dawn" | "HH:MM" (local) | "none"'),
      interval_s: z.number().optional().describe('start: default time between samples (30-900, default from .env)'),
      in_s: z.number().optional().describe('next_check: seconds until the next sample (30-900)'),
      reason: z.string().optional().describe('next_check: why this time'),
      report: z.string().optional().describe('complete: what was achieved, from tool results'),
    },
    async ({ action, objective, until, interval_s, in_s, reason, report }) => {
      if (!duty) throw new Error('the duty loop is not available in this process');
      if (action === 'status') return text(duty.status());
      if (action === 'start') {
        if (!objective) throw new Error("objective is required: the user's instruction, verbatim");
        const st = duty.start({ objective, until, intervalS: interval_s, by: 'agent' });
        return text({ ...st, note: 'On duty. Carry on now; whenever your turn ends you will be woken for the next sample or on an event.' });
      }
      if (action === 'next_check') {
        if (in_s === undefined) throw new Error('in_s is required');
        const r = duty.nextCheck(in_s, reason);
        return text(`next sample in ${r.inS} s (${r.at}) after this turn ends, or sooner on an event. End your turn when you are done with this one.`);
      }
      if (!report) throw new Error('report is required: what was achieved, from tool results');
      duty.complete(report);
      return text('duty completed');
    },
  );

  // ------------------------------------------------------------------ system
  tool(
    'power',
    'Power & lights: reboot, shutdown (ask the user first), rgb_on/rgb_off (ring light — turn off for astro), indicator_on/indicator_off. After a reboot the connection drops and comes back by itself in about a minute (you get events when on duty); then motors_home and sync_time_and_location.',
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
    async ({ cmd, params, request_type, response_type, timeout_s }) => {
      dwarf.assertNoNdLock('raw commands');
      return text((await dwarf.raw(cmd, params ?? {}, request_type, response_type, (timeout_s ?? 15) * 1000)) ?? 'no reply');
    },
  );
}

function compactHour(h: weather.HourForecast) {
  return {
    t: h.local,
    score: h.score,
    rating: h.rating,
    dark: h.dark,
    cloud: `${h.cloudTotal}% (L${h.cloudLow}/M${h.cloudMid}/H${h.cloudHigh})`,
    rain: `${h.precipProbability}%${h.precipMm >= 0.1 ? ` (${h.precipMm.toFixed(1)} mm)` : ''}`,
    wind: `${Math.round(h.windKmh)}/${Math.round(h.gustKmh)} km/h`,
    tempC: h.temperatureC,
    dewSpreadC: h.dewSpreadC,
    seeing: h.seeing,
    transparency: h.transparency,
    issues: h.issues.length ? h.issues : undefined,
  };
}

/**
 * Weather is cached and the last good forecast is kept when a refresh fails (see astro/weather.ts),
 * so the numbers can be minutes or hours old. Say so out loud: the agent must not report a cached
 * forecast as if it had just asked the providers.
 */
function forecastStaleness(f: { stale: boolean; ageMin: number; staleError?: string }) {
  if (!f.stale) return {};
  return {
    forecastWarning: `this forecast is ${f.ageMin} min old${f.staleError ? `; every refresh since has failed (${f.staleError})` : ''}. Say it is ${f.ageMin} min old rather than current, and call weather_forecast again before acting on it.`,
  };
}
