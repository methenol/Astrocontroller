/**
 * The Dwarf 3 behind the shared web UI: every control maps onto the device, its streams and the
 * focus/polar helpers the agent's tools use too.
 */
import { BURST_MAX, type CameraName, type Dwarf } from './device.js';
import type { StreamHub } from '../../media/streams.js';
import { measureTele, starFocusSweep, sharpnessLine } from '../../media/focus.js';
import { measurePolarReport, withAstroBusyRecovery } from '../../mcp/tools/astro.js';
import { assertSurveyAllowed, stopSurvey, surveyObstructions } from '../../media/horizon/survey.js';
import { wireLines } from './wirelog.js';
import type { Capabilities, DeviceSwitches, GotoTarget, SwitchView, WebTelescope } from '../../web/telescope.js';
import type { TelescopeState } from './controller/state.js';
import type { PowerAction } from './controller/system.js';
import type { ControlAction } from '../../web/routes/control.js';

const LEVEL_PITCH_DEG = 90;
/** the web UI's Burst button takes at least this many frames */
const BURST_MIN_UI = 3;

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
};

type SwitchKey = keyof NonNullable<TelescopeState['switches']>;

/** The Dwarf's switches: the two lights (the power commands) and the device switches (extras.ts). */
export function dwarfSwitches(dwarf: Dwarf): DeviceSwitches {
  const power = (on: PowerAction, off: PowerAction) => async (v: boolean) => {
    await dwarf.power(v ? on : off);
    return null;
  };
  const table: Array<{ id: string; key: SwitchKey; label: string; hint: string; set(on: boolean): Promise<{ confirmed: boolean } | null> }> = [
    { id: 'ring_light', key: 'ringLight', label: 'Ring light', hint: 'The RGB light ring: turn it off for astro', set: power('rgb_on', 'rgb_off') },
    { id: 'power_indicator', key: 'powerIndicator', label: 'Power indicator', hint: 'The power button light', set: power('indicator_on', 'indicator_off') },
    { id: 'lens_defog', key: 'lensDefog', label: 'Dew heater', hint: 'The lens defogger heater', set: (on) => dwarf.extras.setLensDefog(on) },
    { id: 'anti_tangle', key: 'antiTangle', label: 'Anti-tangle', hint: 'The electronic limit: stops the mount before the cable winds up', set: (on) => dwarf.extras.setAntiTangle(on) },
    { id: 'auto_cooling', key: 'autoCooling', label: 'Auto cooling', hint: 'The firmware regulates the sensor temperature', set: (on) => dwarf.extras.setAutoCooling(on) },
    { id: 'auto_shutdown', key: 'autoShutdown', label: 'Auto shutdown', hint: 'Power off when idle', set: (on) => dwarf.extras.setAutoShutdown(on) },
    { id: 'power_sound', key: 'powerSound', label: 'Power sound', hint: 'The start-up chime (declared by the firmware but unused by the official app: it may not take)', set: (on) => dwarf.extras.setPowerSound(on) },
    { id: 'do_not_disturb', key: 'doNotDisturb', label: 'Do not disturb', hint: 'No notifications while shooting (declared by the firmware but unused by the official app: it may not take)', set: (on) => dwarf.extras.setDoNotDisturb(on) },
  ];
  const list = async (): Promise<SwitchView[]> => {
    const st = dwarf.extras.switches();
    return table.map(({ id, key, label, hint }) => ({ id, label, hint, on: st[key] ?? null }));
  };
  return {
    list,
    async set(id, on) {
      const sw = table.find((s) => s.id === id);
      if (!sw) throw new Error(`no switch "${id}"`);
      const r = await sw.set(on);
      const what = `${sw.label} ${on ? 'on' : 'off'}`;
      // the lights are fire-and-forget; the device switches say whether the telescope reported the change
      const result = r === null ? `${what} sent` : r.confirmed ? what : `${what} sent; the telescope has not confirmed it`;
      return { result, switches: await list() };
    },
  };
}

export function dwarfWeb(dwarf: Dwarf, hub: StreamHub): WebTelescope {
  const control = async (b: ControlAction): Promise<unknown> => {
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
      case 'polar_align':
        // takes 1-3 min; the outcome is also published as state.polarAlign for the Polar group's readout
        return { result: (await measurePolarReport(dwarf)).summary };
      case 'polar_stop':
        await dwarf.stopPolarAlignment();
        return { result: 'Polar alignment stopped' };
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
        return { result: 'Reboot sent: the telescope reconnects in about a minute' };
      case 'shutdown':
        await dwarf.power('shutdown');
        return { result: 'Shutdown sent' };
    }
  };

  const goto = (t: GotoTarget): Promise<string> => {
    const go = () => (t.kind === 'body' ? dwarf.gotoSolarSystem(t.body, t.oneClick) : dwarf.gotoRaDec(t.raHours, t.decDeg, t.label, t.oneClick));
    return withAstroBusyRecovery(dwarf, `GoTo ${t.label}`, () => dwarf.withPointingRecovery('GoTo', go));
  };

  return {
    driver: 'dwarf',
    label: 'DWARFLAB Dwarf 3',
    get state() {
      return dwarf.state as unknown as WebTelescope['state'];
    },
    capabilities: CAPABILITIES,
    hub,
    location: () => dwarf.location(),
    requireLocation: () => dwarf.requireLocation(),
    teleFovDeg: () => dwarf.state.fov.tele ?? { h: 2.95, v: 1.66 },
    connectLink: () => dwarf.connectLink(),
    release: () => dwarf.release(),
    setHost: (host) => dwarf.setHost(host),
    control,
    goto,
    switches: dwarfSwitches(dwarf),
    horizonSurvey: {
      start: (o) => surveyObstructions({ dwarf, hub }, o),
      stop: () => stopSurvey(dwarf),
      assertAllowed: () => void assertSurveyAllowed(dwarf),
    },
    wireLines: (n, o) => wireLines(n, o),
    on: (event, listener) => dwarf.on(event, listener),
    off: (event, listener) => dwarf.off(event, listener),
  };
}
