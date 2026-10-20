/** Status, connection, clock and location, power, device switches, and the raw-command escape hatch. */
import { z } from 'zod';
import { config } from '../../config.js';
import type { Dwarf } from '../../dwarf/device.js';
import type { SwitchResult } from '../../dwarf/controller/extras.js';
import * as http from '../../dwarf/http.js';
import { wireLines } from '../../dwarf/wirelog.js';
import { localTime, sleep, text, type ToolContext, type ToolFn } from './common.js';

/** Reconnects are rate-limited per device across MCP requests (each request registers the tools anew). */
const RECONNECT_MIN_INTERVAL_MS = 120_000;
const RECONNECT_CONNECT_MS = 15_000;
/** After reconnecting, the command service gets this long to answer, asked at most once per RECHECK_MS. */
const RECONNECT_ANSWER_MS = 20_000;
const RECHECK_MS = 1_000;
const lastReconnectAt = new WeakMap<Dwarf, number>();

export function registerSystemTools(tool: ToolFn, { dwarf, hub }: ToolContext): void {
  const tz = config.observer.timezone;

  tool(
    'telescope_status',
    'Current telescope state: connection, battery, temperatures, storage, shooting mode, Alt-Az/EQ mode, motor angles, focus, calibration/GoTo/tracking, live-stacking progress, polar-alignment result, observer location and local time, and health (camera service responding or hung, live video per camera). Call this first, whenever unsure, and after any timeout.',
    { refresh: z.boolean().optional().describe('re-query the device instead of using the cached state (default true)') },
    async ({ refresh }) => {
      // during an operation the telescope's own notifications keep the state current: no extra queries in the middle of it
      if (refresh !== false && dwarf.link.usable && !dwarf.quietPeriod()) {
        await dwarf.refreshState().catch(() => {});
        await dwarf.readMotorPositions().catch(() => {});
      }
      const loc = dwarf.location();
      return text({
        ...dwarf.state,
        motorsNote:
          'pitch≈90° is level with the horizon in Alt-Az mode (pitch − 90 ≈ altitude); ~2.5° is the parked/down position. While tracking after a GoTo the motors report homed: false; that is normal, do not re-home a tracking scope.',
        trackingNow: dwarf.isTracking(),
        observer: loc ? { ...loc, timezone: tz } : 'NOT CONFIGURED — set OBSERVER_LATITUDE/OBSERVER_LONGITUDE',
        localTime: localTime(),
        busyWith: dwarf.isBusy(),
        // the latest commands to the telescope (> sent, < reply, x unanswered, ! link event)
        recentCommands: wireLines(15, { notifications: false }),
        health: {
          ...http.apiHealth(),
          ...(dwarf.state.photoStuckSince && Object.keys(dwarf.state.photoStuckSince).length
            ? { stuckCameras: Object.keys(dwarf.state.photoStuckSince).map((c) => `${c}: a photo never finished; the camera refuses commands until the telescope is rebooted (power reboot)`) }
            : {}),
          video: Object.fromEntries(
            (['tele', 'wide'] as const).map((n) => {
              const v = hub.get(n).status() as ReturnType<typeof hub.tele.status>;
              return [n, { phase: v.phase, lastFrameAgoS: v.lastFrameAt ? Math.round((Date.now() - v.lastFrameAt) / 1000) : null, note: v.note ?? undefined }];
            }),
          ),
        },
      });
    },
  );

  tool('telescope_device_info', 'Static device info from the HTTP API: name, serial, firmware, Wi-Fi/STA details (passwords hidden), SD card, supported shooting modes.', {}, async () => {
    const [info, fw, modes] = await Promise.all([http.getDeviceInfo(), http.getFirmware().catch(() => null), http.getShootingModes()]);
    return text({
      ...http.redactDeviceInfo(info),
      firmware: fw?.version,
      shootingModes: modes.map((m) => ({ id: m.id, name: m.name, parent: m.parentId, techniques: m.shootingTechnology.map((t) => http.SHOOTING_TECH_NAMES[t.id] ?? t.id) })),
    });
  });

  tool(
    'telescope_reconnect',
    'Re-open the control connection if it is not working, then check that the telescope answers. Rarely needed: the link detects dead connections and hangs by itself and recovers on its own (telescope_status.link). A healthy connection is checked, never dropped. At most once every 2 minutes; refused while an operation runs or while another app holds the telescope (reconnecting then knocks one of you off). It does NOT clear a stuck calibration/GoTo (use stop_goto) and cannot fix a hung telescope (that needs a power cycle). Does nothing while the user has released the telescope (Disconnect in the web UI).',
    {},
    async () => {
      dwarf.assertNoOperation('reconnecting');
      if (dwarf.state.released) throw new Error('the user has released the telescope (Disconnect in the web UI): not reconnecting until they press Connect');
      const health = dwarf.link.health();
      const answers = () => dwarf.refreshState().then(() => true, () => false);
      if (health.state === 'connected' && (await answers())) return text('the connection is healthy and the telescope is answering commands: nothing to do (it was not dropped)');
      if (health.state === 'contended') throw new Error(`not reconnecting: ${health.detail}`);
      const last = lastReconnectAt.get(dwarf) ?? 0;
      const wait = RECONNECT_MIN_INTERVAL_MS - (Date.now() - last);
      if (wait > 0) {
        throw new Error(
          `a reconnect was done ${Math.round((Date.now() - last) / 1000)} s ago; repeated reconnects make things worse. Current link: ${health.detail}. Try again in ${Math.ceil(wait / 1000)} s if it is still not answering.`,
        );
      }
      lastReconnectAt.set(dwarf, Date.now());
      dwarf.link.reconnect();
      await dwarf.link.waitConnected(RECONNECT_CONNECT_MS);
      // a connection is only useful if the command service answers
      const end = Date.now() + RECONNECT_ANSWER_MS;
      let answered = false;
      while (Date.now() < end && !answered) {
        const asked = Date.now();
        answered = await answers();
        if (answered || dwarf.link.health().state === 'unresponsive') break;
        // a refusal comes back at once while the link is down: do not ask again in a tight loop
        await sleep(Math.max(0, RECHECK_MS - (Date.now() - asked)));
      }
      if (!answered) throw new Error(`reconnected, but the telescope does not answer commands: ${dwarf.link.health().detail}`);
      return text('reconnected; the telescope is answering commands');
    },
  );

  tool(
    'sync_time_and_location',
    'Push the current time, timezone and observer location to the telescope (needed for calibration/GoTo). Optionally override the location for this session (otherwise .env OBSERVER_* is used). Refused while a stack, GoTo, calibration, dark capture or tracking runs (it could disturb it).',
    {
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      elevation_m: z.number().optional(),
    },
    async ({ latitude, longitude, elevation_m }) => {
      if ((latitude === undefined) !== (longitude === undefined)) throw new Error('give both latitude and longitude, or neither. Nothing was synced.');
      dwarf.assertNoOperation('syncing time and location');
      const override = latitude !== undefined && longitude !== undefined ? { lat: latitude, lon: longitude, elev: elevation_m ?? config.observer.elevationM } : null;
      const done = await dwarf.syncTimeLocation(override ?? dwarf.location());
      // only a location the telescope has taken is used for the session's calibrations and GoTos
      if (override) dwarf.locationOverride = override;
      return text(`synced: ${done.join('; ')}`);
    },
  );

  tool(
    'power',
    'Power & lights: reboot (the fix for a hung camera service), shutdown, rgb_on/rgb_off (ring light — turn off for astro), indicator_on/indicator_off. After a reboot the connection drops and comes back by itself in about a minute (you get events when on duty); then motors_home and sync_time_and_location.',
    { action: z.enum(['reboot', 'shutdown', 'rgb_on', 'rgb_off', 'indicator_on', 'indicator_off']) },
    async ({ action }) => {
      await dwarf.power(action);
      return text(`${action} sent`);
    },
  );

  const SWITCHES: Record<string, (on: boolean) => Promise<SwitchResult>> = {
    anti_tangle: (on) => dwarf.extras.setAntiTangle(on),
    lens_defog: (on) => dwarf.extras.setLensDefog(on),
    auto_cooling: (on) => dwarf.extras.setAutoCooling(on),
    auto_shutdown: (on) => dwarf.extras.setAutoShutdown(on),
    power_sound: (on) => dwarf.extras.setPowerSound(on),
    do_not_disturb: (on) => dwarf.extras.setDoNotDisturb(on),
  };

  tool(
    'device_switches',
    'The device switches the stock SDK never exposed: anti_tangle (the electronic limit — stops the mount before the cable winds up), lens_defog (defogger heater), auto_cooling, auto_shutdown, power_sound (startup chime), do_not_disturb (no notifications while shooting). With no arguments it reports what the telescope currently says (also in telescope_status.switches); with switch+on it applies the change and says whether the telescope confirmed it. power_sound and do_not_disturb are declared by the device but never used by the official app: confirmed:false there usually means the firmware does not implement them.',
    {
      switch: z.enum(['anti_tangle', 'lens_defog', 'auto_cooling', 'auto_shutdown', 'power_sound', 'do_not_disturb']).optional(),
      on: z.boolean().optional(),
    },
    async ({ switch: name, on }) => {
      if (name === undefined) return text({ switches: dwarf.extras.switches() });
      if (on === undefined) throw new Error(`give on: true or false with switch ${name}; nothing was changed`);
      return text({ switch: name, on, ...(await SWITCHES[name](on)), switches: dwarf.extras.switches() });
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
      timeout_s: z.number().min(1).max(600).optional(),
    },
    async ({ cmd, params, request_type, response_type, timeout_s }) => {
      dwarf.assertNoNdLock('raw commands');
      dwarf.assertNoOperation('a raw command');
      return text((await dwarf.raw(cmd, params ?? {}, request_type, response_type, (timeout_s ?? 15) * 1000)) ?? 'no reply');
    },
  );
}
