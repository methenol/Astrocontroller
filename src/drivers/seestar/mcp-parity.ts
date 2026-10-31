/**
 * The Dwarf agent's remaining tools (mcp/tools/system.ts, motion.ts, astro.ts, camera.ts,
 * planning.ts sky_check) under the same names, carried out with the Seestar: skills and notes
 * written for one telescope work with the other. Where the Seestar has no equivalent the tool says
 * so and why, rather than guessing at a command.
 */
import { z } from 'zod';
import { config, type ObserverLocation } from '../../config.js';
import * as sky from '../../astro/sky.js';
import { analyze } from '../../media/images.js';
import { blockedAt } from '../../mcp/tools/motion.js';
import { skyVerdict } from '../../mcp/tools/planning.js';
import { capturedLine, displayJpeg, imageResult, localTime, saveCapture, text, withImage, type ToolFn } from '../../mcp/tools/common.js';
import type { Seestar } from './device.js';
import { measureSeestar } from './focus.js';
import { seestarImage } from './mcp-media.js';
import type { SeestarMedia } from './web.js';

/** tele_visibility: what counts as stars in view (the Dwarf's thresholds) */
const VISIBLE_MIN_STARS = 20;
const VISIBLE_MAX_HFR_PX = 6;
const MODES: Record<string, 'star' | 'moon' | 'planet'> = { dso: 'star', moon: 'moon', planet: 'planet' };
/** device_switches: the Dwarf's switch names and the Seestar settings they are */
const SWITCHES: Record<string, { setting: string; on: unknown; off: unknown } | null> = {
  lens_defog: { setting: 'heater_enable', on: true, off: false },
  auto_shutdown: { setting: 'auto_power_off', on: true, off: false },
  power_sound: { setting: 'beep_volume', on: 'backyard', off: 'off' },
  anti_tangle: null,
  auto_cooling: null,
  do_not_disturb: null,
};

export function registerSeestarParityTools(tool: ToolFn, scope: Seestar, media: SeestarMedia): void {
  const settings = async () => ((await scope.settings()) ?? {}) as Record<string, any>;
  const wheel = async () => {
    const [pos, names] = await Promise.all([scope.raw('get_wheel_position'), scope.raw('get_wheel_slot_name')]);
    const slots = Array.isArray(names.result) ? (names.result as string[]) : [];
    return { position: typeof pos.result === 'number' ? pos.result : undefined, name: typeof pos.result === 'number' ? slots[pos.result] : undefined, slots };
  };

  // ---- system ----------------------------------------------------------------

  tool(
    'telescope_status',
    'Current telescope state (the same as seestar_status): link and tunnel, device, mount (pointing, tracking, EQ mode, parked), view and stack, focuser, battery, temperature, storage, the last state of every operation, alerts, observer location and local time. Call this first, whenever unsure, and after any timeout.',
    { refresh: z.boolean().optional().describe('re-query the device instead of using the cached state (default true)') },
    async ({ refresh }) => {
      if (refresh !== false && scope.state.connected) await scope.refreshState();
      return text({ ...scope.state, deviceState: undefined, busy: scope.isBusy(), location: scope.location(), localTime: localTime() });
    },
  );

  tool('telescope_device_info', 'Static device info: model, serial, firmware, optics, the two cameras, the filter wheel slots, storage (Wi-Fi passwords left out).', {}, async () => {
    const [cams, cam, w] = await Promise.all([scope.raw('get_connected_cameras'), scope.raw('get_camera_info'), wheel()]);
    const st = scope.state;
    return text({ device: st.device, fovDeg: st.fov, cameras: cams.result, teleCamera: cam.result, filterWheel: w, storage: st.storage, connection: st.connection });
  });

  tool(
    'telescope_reconnect',
    'Re-open the control link if it is not working (over ZWO Telescope Network the tunnel too, when it is down). A healthy link is checked, never dropped. Refused while an operation runs.',
    {},
    async () => {
      if (scope.isBusy()) throw new Error(`refused: ${scope.isBusy()} is running`);
      if (scope.rpc.usable) {
        const r = await scope.raw('test_connection');
        return text({ link: 'healthy, left as it is', answer: r.result });
      }
      if (scope.tunnel && scope.tunnel.status().phase !== 'up' && scope.tunnel.status().managed) scope.tunnel.restart();
      scope.connectLink();
      return text({ link: 'reconnecting', health: scope.rpc.health(), tunnel: scope.tunnel?.status() ?? null });
    },
  );

  tool(
    'sync_time_and_location',
    "Push the host's time and the observer location to the Seestar (it plans and solves with them). Optionally override the location for this session (otherwise .env OBSERVER_*). Refused while an operation runs.",
    { latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), elevation_m: z.number().optional() },
    async ({ latitude, longitude, elevation_m }) => {
      if (scope.isBusy()) throw new Error(`refused: ${scope.isBusy()} is running`);
      if (latitude !== undefined && longitude !== undefined) scope.locationOverride = { ...(scope.location() ?? ({} as ObserverLocation)), lat: latitude, lon: longitude, ...(elevation_m !== undefined ? { elevationM: elevation_m } : {}) } as ObserverLocation;
      return text({ synced: await scope.syncTimeLocation() });
    },
  );

  tool(
    'raw_command',
    "Expert escape hatch (the Seestar's raw_rpc): send any JSON-RPC method with its params and get the reply as the scope sent it. Use only when no dedicated tool exists, and record what worked in a skill.",
    { method: z.string().min(1), params: z.unknown().optional(), timeout_s: z.number().min(1).max(600).optional() },
    async ({ method, params, timeout_s }) => text(await scope.raw(method, params, (timeout_s ?? 15) * 1000)),
  );

  tool(
    'device_switches',
    'Device switches: lens_defog (the dew heater), auto_shutdown, power_sound. anti_tangle, auto_cooling and do_not_disturb are the Dwarf\'s and have no Seestar equivalent. With no arguments it reports them; with switch+on it sets one.',
    { switch: z.enum(['anti_tangle', 'lens_defog', 'auto_cooling', 'auto_shutdown', 'power_sound', 'do_not_disturb']).optional(), on: z.boolean().optional() },
    async (a) => {
      if (a.switch) {
        const sw = SWITCHES[a.switch];
        if (!sw) throw new Error(`${a.switch} has no equivalent on the Seestar`);
        if (a.on === undefined) throw new Error('give on=true or on=false');
        await scope.setSetting({ [sw.setting]: a.on ? sw.on : sw.off });
      }
      const s = await settings();
      return text(Object.fromEntries(Object.entries(SWITCHES).map(([k, sw]) => [k, sw ? s[sw.setting] === sw.on : 'not on the Seestar'])));
    },
  );

  // ---- motion ----------------------------------------------------------------

  tool('motor_position', "Where the mount points: azimuth and altitude, RA and Dec, tracking, parked, EQ mode. (The Seestar reports sky coordinates, not the Dwarf's motor angles.)", {}, async () => text(await scope.readPointing()));

  tool(
    'move_motors',
    'Slew without plate solving: to azimuth/altitude (true degrees), or BY them with relative=true. Refused below the horizon and within 15° of the Sun. Returns when the Seestar reports the slew done. (The Seestar takes sky positions, not the Dwarf\'s rotation/pitch angles.)',
    { azimuth_deg: z.number().min(-360).max(360).optional(), altitude_deg: z.number().min(-90).max(90).optional(), relative: z.boolean().optional() },
    async ({ azimuth_deg, altitude_deg, relative }) => {
      const now = await scope.readPointing();
      const az = relative ? (now.azDeg ?? 0) + (azimuth_deg ?? 0) : (azimuth_deg ?? now.azDeg);
      const alt = relative ? (now.altDeg ?? 0) + (altitude_deg ?? 0) : (altitude_deg ?? now.altDeg);
      if (az === undefined || alt === undefined) throw new Error('the current pointing is unknown: give both azimuth_deg and altitude_deg');
      const r = await scope.slewAltAz(((az % 360) + 360) % 360, alt);
      return text({ slew: r.state, seconds: Math.round(r.ms / 1000), pointing: await scope.readPointing() });
    },
  );

  tool('motors_home', 'Bring the Seestar to its reference position: raise the arm out of park to the horizon position (the Seestar keeps its own axis references). Blocks until done.', {}, async () => text(await scope.openArm()));

  tool('stop_motion', 'Stop any manual motion now.', {}, async () => text(await scope.stopMotion()));

  tool('stop_goto', 'Stop a GoTo (and whatever the view is doing).', {}, async () => text(await scope.stopView()));

  // ---- focus -----------------------------------------------------------------

  tool(
    'focus_step',
    'Move the tele focuser manually: direction near or far, steps 1-200 (the Seestar\'s own fine step is 10). Check the effect with star_sharpness between moves; for a whole search use star_focus.',
    { direction: z.enum(['near', 'far']), steps: z.number().int().min(1).max(200) },
    async ({ direction, steps }) => text({ focuserPosition: await scope.focusBy(direction === 'near' ? -steps : steps) }),
  );

  tool(
    'focus_position',
    "Absolute focuser control. get: the current position and the Seestar's stored focus (focal_pos, and the factory one). infinity: drive to the stored focus (the starting point for sky work). goto: drive to `position`.",
    { action: z.enum(['get', 'infinity', 'goto']), position: z.number().int().min(0).optional() },
    async ({ action, position }) => {
      const s = await settings();
      const stored = typeof s.focal_pos === 'number' ? s.focal_pos : undefined;
      if (action === 'goto') {
        if (position === undefined) throw new Error('give position');
        return text({ focuserPosition: await scope.focusTo(position) });
      }
      if (action === 'infinity') {
        if (stored === undefined) throw new Error('the Seestar reports no stored focus position');
        return text({ focuserPosition: await scope.focusTo(stored), storedFocus: stored });
      }
      return text({ focuserPosition: await scope.focuserPosition(), storedFocus: stored, factoryFocus: s.factory_focal_pos, maxStep: scope.state.focus.maxStep });
    },
  );

  tool(
    'tele_visibility',
    `Is the target really in view of the tele after a GoTo? Measures the stars on one raw tele sub: VISIBLE = at least ${VISIBLE_MIN_STARS} measurable stars with a median HFR at most ${VISIBLE_MAX_HFR_PX} px; anything else is BLOCKED (a wall, the roof, cloud or dew). A BLOCKED verdict is remembered as that patch of sky at that time: plan_targets then raises the site's horizon there for tonight and gives \`clearsAt\`.`,
    { target: z.string().optional().describe('the target the scope is pointing at; default the current view target') },
    async (a) => {
      const { img, sharp } = await measureSeestar(scope);
      const jpeg = await displayJpeg(img, 1024);
      const saved = saveCapture(jpeg, 'tele_visibility');
      const visible = sharp.ok && sharp.starsUsed >= VISIBLE_MIN_STARS && sharp.hfrPx <= VISIBLE_MAX_HFR_PX;
      const why = !sharp.ok ? sharp.blocking : sharp.starsUsed < VISIBLE_MIN_STARS ? `only ${sharp.starsUsed} measurable stars` : `median HFR ${sharp.hfrPx.toFixed(1)} px: blurred near structure, not stars`;
      const blocked = visible ? null : blockedAt(scope.requireLocation(), a.target ?? scope.state.view.target, why ?? 'not visible');
      return withImage(
        jpeg,
        JSON.stringify(
          {
            verdict: visible ? 'VISIBLE' : 'BLOCKED',
            reason: visible ? `${sharp.starsUsed} stars, median HFR ${sharp.hfrPx.toFixed(1)} px` : why,
            ...(blocked ?? {}),
            focusPosition: scope.state.focus.position,
            captured: capturedLine(img) || undefined,
            image: `captures/${saved}`,
          },
          null,
          1,
        ),
      );
    },
  );

  tool(
    'mark_blocked',
    "Record that the owner says the tele's view is blocked here (a wall, the roof, a tree): the patch of sky the target is in right now, as a BLOCKED tele_visibility files it. plan_targets then raises the site's horizon there for tonight. Returns when this target clears (null = not tonight).",
    { target: z.string().optional().describe('the target the scope is pointing at; default the current view target') },
    async (a) => text(blockedAt(scope.requireLocation(), a.target ?? scope.state.view.target, 'the owner said the view is blocked')),
  );

  // ---- astro -----------------------------------------------------------------

  tool('calibrate', 'Plate-solve the current view (the Seestar calibrates its pointing by itself in every GoTo; this checks where it really points). Needs stars in view.', {}, async () => text(await scope.plateSolve()));

  tool(
    'astro_recover',
    'Release a stuck Seestar without a power cycle: stops the view, stacking, autofocus and polar alignment and any manual motion, then reads the state again. For when commands are refused although nothing should be running.',
    {},
    async () => {
      const done: Record<string, unknown> = {};
      for (const [what, run] of [
        ['view', () => scope.raw('iscope_stop_view')],
        ['autofocus', () => scope.raw('stop_auto_focuse')],
        ['polar alignment', () => scope.raw('stop_polar_align')],
        ['motion', () => scope.stopMotion()],
      ] as const) {
        done[what] = await run().then((r) => r.code ?? 0, (e) => String(e));
      }
      await scope.refreshState().catch(() => {});
      return text({ stopped: done, busy: scope.isBusy(), view: scope.state.view, link: scope.rpc.health() });
    },
  );

  tool(
    'live_stacking',
    'Start or stop live stacking on the target in view (start_stacking / stop_stacking). The frames stacked so far are kept on a stop.',
    { action: z.enum(['start', 'stop']) },
    async ({ action }) => text(action === 'start' ? await scope.startStack() : await scope.stopStack()),
  );

  tool('polar_alignment', 'Run the Seestar polar alignment (EQ mode on a wedge): blocks until done; the result carries the deviation and the correction.', {}, async () => text(await scope.polarAlign()));

  tool(
    'track_sun_moon',
    'Track the Moon (or the Sun) in the solar-system view. The Sun is refused over ZWO Telescope Network (nobody at the scope can check its solar filter); on the local network only with solar_filter_confirmed=true from the owner.',
    { body: z.enum(['sun', 'moon']), action: z.enum(['start', 'stop']), solar_filter_confirmed: z.boolean().optional() },
    async ({ body, action, solar_filter_confirmed }) => {
      if (action === 'stop') return text(await scope.stopView());
      if (body === 'moon') return text(await scope.setViewMode('moon'));
      if (config.seestar.connection === 'zwo') throw new Error('the Sun is refused on a remote Seestar: nobody can check the solar filter');
      if (!solar_filter_confirmed) throw new Error('the Sun needs the solar filter: set solar_filter_confirmed=true only once the owner confirmed it is fitted');
      return text(await scope.raw('iscope_start_view', { mode: 'sun' }));
    },
  );

  tool(
    'track_object',
    "Follow a moving object by its box in the frame — not available on the Seestar: its object tracking (start_track_object) takes the id of an object its own detection found, which the Seestar does not report over its control link.",
    { action: z.enum(['start', 'stop']) },
    async () => {
      throw new Error('track_object is not available on the Seestar (its tracking takes an object id from its own detection, which it does not report)');
    },
  );

  tool(
    'sentry_mode',
    'Automatic detection & tracking — not available on the Seestar over its control link (as on the DWARF 3).',
    { action: z.enum(['start', 'stop']) },
    async () => {
      throw new Error('sentry_mode is not available on the Seestar');
    },
  );

  // ---- camera ----------------------------------------------------------------

  tool(
    'set_shooting_mode',
    'Switch the view mode: DSO (star mode: deep-sky stacking, where every live frame and still comes from), Moon, Planet. Normal (daytime scenery) is out of scope for this astrophotography setup and Sun is refused remotely; Milky Way, Star Trail, Auto Tracking and Panorama are the Dwarf\'s.',
    { mode: z.string() },
    async ({ mode }) => {
      const m = MODES[mode.trim().toLowerCase()];
      if (!m) throw new Error(`${mode} is not a mode this controller runs the Seestar in (DSO, Moon, Planet; the scenery view is out of scope for astrophotography)`);
      return text(await scope.setViewMode(m));
    },
  );

  tool(
    'get_camera_settings',
    "The tele camera's settings: the stack sub length and live exposure, gain, the filter wheel (dark / IRCUT / LP) and the view's LP filter, dithering, auto-focus and dark-frame options, plus every other Seestar setting as it reports them.",
    { camera: z.enum(['tele', 'wide']).optional() },
    async ({ camera }) => {
      const s = await settings();
      const cam = camera === 'wide' ? (s.second_camera ?? {}) : s;
      return text({
        camera: camera ?? 'tele',
        exposure: { stackSubS: cam.exp_ms?.stack_l / 1000, liveS: cam.exp_ms?.continuous / 1000 },
        gain: scope.state.view.gain,
        filterWheel: camera === 'wide' ? undefined : await wheel(),
        lpFilterInView: scope.state.view.lpFilter,
        dither: cam.stack_dither,
        autoFocus: s.auto_af,
        autoMasterDark: s.auto_master_dark,
        settings: cam,
      });
    },
  );

  tool(
    'set_camera_setting',
    'Change one setting. exposure: the stack sub length in seconds ("10", "20", "60"…); live_exposure: the live view\'s, in seconds; gain: a number; filter: IRCUT | LP | dark (the wheel); any other name is a Seestar setting (set_setting), e.g. auto_af, stack_dither as JSON.',
    { camera: z.enum(['tele', 'wide']).optional(), setting: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) },
    async ({ setting, value }) => {
      const sec = (v: string | number | boolean) => {
        const n = Number(String(v).replace(/s$/i, ''));
        if (!Number.isFinite(n) || n <= 0) throw new Error(`"${v}" is not a duration in seconds`);
        return n;
      };
      if (setting === 'exposure') return text(await scope.setExposure({ stackMs: sec(value) * 1000 }));
      if (setting === 'live_exposure') return text(await scope.setExposure({ continuousMs: sec(value) * 1000 }));
      if (setting === 'gain') return text(await scope.setGain(Number(value)));
      if (setting === 'filter') {
        const w = await wheel();
        const i = w.slots.findIndex((n) => n.toLowerCase() === String(value).toLowerCase().replace(/[^a-z]/g, '') || n.toLowerCase() === String(value).toLowerCase());
        if (i < 0) throw new Error(`no filter ${value}: the wheel has ${w.slots.join(', ')}`);
        await scope.raw('set_wheel_position', [i]);
        return text({ filter: w.slots[i], wheelPosition: i });
      }
      let v: unknown = value;
      if (typeof value === 'string' && /^[[{]/.test(value.trim())) v = JSON.parse(value);
      return text(await scope.setSetting({ [setting]: v }));
    },
  );

  // ---- planning ----------------------------------------------------------------

  tool(
    'sky_check',
    "One-call clear-sky check with the wide camera, where the scope points now: the star count, background level and a verdict (clear / partly clear / cloudy / bright, or unknown with the reason when the Sun is up or the scope points below the horizon), and the image. Point above ~60° altitude for the fairest reading.",
    {},
    async () => {
      const site = scope.requireLocation();
      const { img } = await seestarImage('wide', scope, media);
      const a = analyze(img);
      const pointing = await scope.readPointing().catch(() => scope.state.mount);
      const verdict = skyVerdict({ blank: a.stars.count === 0 && a.stats.median < 0.02, background: a.stats.median, stars: a.stars.count, sunAltDeg: sky.bodyAlt(site, 'Sun'), altitudeDeg: pointing.altDeg });
      return imageResult(img, 'sky_check (wide)', { note: JSON.stringify({ verdict, stars: a.stars.count, background: a.stats.median, pointing: { az: pointing.azDeg, alt: pointing.altDeg }, captured: capturedLine(img) || undefined }) });
    },
  );
}
