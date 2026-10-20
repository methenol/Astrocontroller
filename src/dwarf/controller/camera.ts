/**
 * Cameras: shooting mode and technique, the live view, settings (exposure, gain, white balance,
 * filter and every generic parameter the device lists), and still/burst/video/timelapse capture.
 *
 * Settings are read from the telescope's own pushed values (15264 notifications); the HTTP
 * schema's currentValue goes stale and is only a fallback where nothing better exists.
 */
import Long from 'long';
import { logger } from '../../log.js';
import * as http from '../http.js';
import { DwarfCommandError } from '../link.js';
import { Cmd } from '../protocol.js';
import type { CameraName } from '../stacking.js';
import { busyWith, request, sendConfirmed, type Core } from './core.js';
import { markPhotoStuck, photoInFlight, stuckPhotoMessage } from './photo-watch.js';
import { finishEndedSession } from './session-finish.js';
import type { SystemControl } from './system.js';
import { camId, describeParam, exposureLabelSeconds, FILTERS, matchExposure, nearest, resolveFilter, sleep, snake, WB_SCENES } from './util.js';

const log = logger('dwarf');

/** Settings that change what a camera shoots: refused while a stack owns the camera. */
const SHOOTING_KEYS = new Set(['exposure', 'exp', 'shutter', 'gain', 'iso', 'filter', 'filtertype', 'ir_filter', 'ircut']);
const EXPOSURE_KEYS = new Set(['exposure', 'exp', 'shutter']);
const FILTER_KEYS = new Set(['filter', 'filtertype', 'ir_filter', 'ircut']);

/** A burst takes this many frames at most (the firmware's own limit). */
export const BURST_MAX = 999;

// Timings (fw 1.5.3). Mode switches restart the camera pipeline and are slow to show.
const MODE_SWITCH_REPLY_MS = 20_000;
const MODE_SWITCH_CONFIRM_MS = 15_000;
const ENTER_CAMERA_MS = 15_000;
/** the live view is woken at most this often (forced: after a connect or a recovery) */
const LIVE_VIEW_WAKE_MS = 60_000;
const LIVE_VIEW_WAKE_FORCED_MS = 5000;
const LIVE_VIEW_ENTER_MS = 5000;
const PREVIEW_QUALITY_MS = 3000;
/** calibration leaves the wide exposure behind a moment after it reports done */
const CALIBRATION_SETTLE_MS = 500;
/** bool params are applied but never acknowledged */
const BOOL_PARAM_MS = 2000;
/** how long after a manual exposure set the gain is watched for the firmware's reset to 160 */
const GAIN_RESET_WATCH_MS = 1000;
const GAIN_RESET_POLL_MS = 100;
/** without the end notification, wait this long before looking in the album */
const PHOTO_FALLBACK_WAIT_MS = 1500;
/** album timestamps are whole seconds and the clocks differ a little: look this far back */
const ALBUM_CLOCK_SLACK_S = 2;
const PHOTO_ALBUM_TRIES = 8;
const ALBUM_POLL_MS = 1000;
const ALBUM_RECENT = 10;
/** a burst's end is awaited this long, plus per frame */
const BURST_BASE_MS = 60_000;
const BURST_PER_FRAME_MS = 5000;
/** a shooting mode that is not reported yet is taken as this (Photo) */
const DEFAULT_MODE_ID = 1;

export type ShootingTech = 'single_photo' | 'stacking' | 'burst' | 'video' | 'timelapse' | 'panorama';

const packId = (def: http.ParamDef) => Long.fromString(String(def.paramId), false);

export class CameraControl {
  private lastLiveViewWake = 0;

  constructor(
    private readonly core: Core,
    private readonly system: SystemControl,
  ) {}

  private get state() {
    return this.core.store.state;
  }

  // ---- modes ---------------------------------------------------------------

  async currentModeId(): Promise<number> {
    if (!this.state.shootingMode) await this.system.refreshState();
    return this.state.shootingMode?.id ?? DEFAULT_MODE_ID;
  }

  async setShootingMode(nameOrId: string | number): Promise<http.ShootingModeDef> {
    this.core.guards.assertNoOperation('changing the shooting mode');
    // a mode switch ends a running stack on either camera (a stack's own preparation passes)
    for (const cam of ['tele', 'wide'] as const) this.core.guards.assertCameraFree(cam, 'changing the shooting mode');
    const mode = await http.resolveShootingMode(nameOrId);
    for (const cam of ['tele', 'wide'] as const) await finishEndedSession(this.core, cam, `switching to ${mode.name} mode`);
    await sendConfirmed(this.core, Cmd.TASK_MANAGER_SWITCH_SHOOTING_MODE, { mode: mode.id }, `switching to ${mode.name} mode`, {
      timeout: MODE_SWITCH_REPLY_MS,
      confirmMs: MODE_SWITCH_CONFIRM_MS,
      confirm: async () => {
        await this.system.refreshState();
        return this.state.shootingMode?.id === mode.id;
      },
    });
    await request(this.core, Cmd.TASK_MANAGER_ENTER_CAMERA, { clientParam: { encodeType: 1 } }, { timeout: ENTER_CAMERA_MS, allowError: true, bestEffort: true });
    this.state.shootingMode = { id: mode.id, name: mode.name };
    // the telescope reports no technique; a mode with one (DSO: stacking) is in it, otherwise it is unknown
    for (const cam of ['tele', 'wide'] as const) {
      const techs = (mode.shootingTechnology ?? []).filter((t) => !Array.isArray(t.cameraIds) || t.cameraIds.includes(camId(cam)));
      this.state.shootingTech[cam] = techs.length === 1 ? http.SHOOTING_TECH_NAMES[techs[0].id] : undefined;
    }
    this.lastLiveViewWake = Date.now();
    this.core.store.changed();
    return mode;
  }

  async ensureMode(name: string): Promise<void> {
    const mode = await http.resolveShootingMode(name);
    if (this.state.shootingMode?.id !== mode.id) await this.setShootingMode(mode.id);
  }

  async setShootingTech(tech: ShootingTech): Promise<void> {
    // the technique is device-wide: switching it under a stack on the other camera would change that stack
    for (const cam of ['tele', 'wide'] as const) this.core.guards.assertCameraFree(cam, `switching to ${tech}`);
    const id = Number(Object.entries(http.SHOOTING_TECH_NAMES).find(([, n]) => n === tech)?.[0]);
    if (!id) throw new Error(`unknown technique ${tech}`);
    for (const cam of ['tele', 'wide'] as const) await finishEndedSession(this.core, cam, `switching to ${tech}`);
    await sendConfirmed(this.core, Cmd.TASK_MANAGER_SWITCH_SHOOTING_TECH, { tech: id }, `switching to ${tech}`);
    this.state.shootingTech.tele = tech;
    this.state.shootingTech.wide = tech;
    this.core.store.changed();
  }

  // ---- live view -----------------------------------------------------------

  /**
   * Make sure RTSP previews are being produced (enter-camera + preview quality). Entering the
   * camera also makes the telescope broadcast every current camera parameter, which primes the
   * live settings. Skipped while anything runs, so it cannot disturb it.
   */
  async ensureLiveView(force = false): Promise<void> {
    if (busyWith(this.core)) return;
    if (Date.now() - this.lastLiveViewWake < (force ? LIVE_VIEW_WAKE_FORCED_MS : LIVE_VIEW_WAKE_MS)) return;
    this.lastLiveViewWake = Date.now();
    await request(this.core, Cmd.TASK_MANAGER_ENTER_CAMERA, { clientParam: { encodeType: 1 } }, { bestEffort: true, timeout: LIVE_VIEW_ENTER_MS });
    await request(this.core, Cmd.CAMERA_TELE_SET_PREVIEW_QUALITY, { level: 1 }, { bestEffort: true, timeout: PREVIEW_QUALITY_MS });
    await request(this.core, Cmd.CAMERA_WIDE_SET_PREVIEW_QUALITY, { level: 1 }, { bestEffort: true, timeout: PREVIEW_QUALITY_MS });
  }

  /** The camera was re-entered by someone else (recovery): the live view need not be woken again for a while. */
  noteLiveViewWoken(): void {
    this.lastLiveViewWake = Date.now();
  }

  /**
   * Set a camera back to auto exposure because a long manual exposure (≥ 1 s) has stopped its live
   * video. Never while a stack or a dark capture owns the camera or a stack is being prepared on it, never under another
   * caller's operation: the ownership is checked again right before the command is sent, with no
   * wait in between, so a stack start that lands during the lookups is never undercut.
   * Returns the manual exposure it replaced, or null if it changed nothing.
   */
  async autoExposureForLiveView(cam: CameraName): Promise<number | null> {
    const { guards } = this.core;
    const free = () => !guards.stackOwnsCamera(cam) && !guards.darkCaptureOwns(cam) && !guards.foreignOperation();
    if (!free()) return null;
    const exp = await this.exposureSeconds(cam);
    if (exp === null || exp < 1) return null;
    const def = (await this.schema()).cameras[camId(cam)]?.exp;
    if (!def) return null;
    if (!free()) return null;
    await request(this.core, Cmd.PARAM_SET_EXPOSURE, { paramId: packId(def), mode: 0, value: this.liveValue(def) ?? 0 });
    return exp;
  }

  /**
   * Calibration/plate-solving leaves the wide camera at a long manual exposure (observed: 1 s),
   * which stops its live video. Put it back to auto afterwards. Never throws.
   */
  async restoreWideLiveView(): Promise<void> {
    await sleep(CALIBRATION_SETTLE_MS);
    try {
      const exp = await this.autoExposureForLiveView('wide');
      if (exp !== null) log.info(`wide exposure was left at ${exp}s by the telescope's calibration; set back to auto for live view`);
    } catch (e) {
      log.warn(`could not restore wide exposure: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- settings ------------------------------------------------------------

  private async schema(modeId?: number) {
    return http.getParamSchema(modeId ?? (await this.currentModeId()));
  }

  private liveValue(def: http.ParamDef): number | undefined {
    const v = this.core.params.get(String(def.paramId))?.value;
    return typeof v === 'number' ? v : undefined;
  }

  async cameraSettings(camera: CameraName, modeId?: number) {
    const mode = modeId ?? (await this.currentModeId());
    const schema = await http.getParamSchema(mode);
    const defs = schema.cameras[camId(camera)] ?? {};
    const params = this.core.params;
    const out: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(defs)) {
      const cur = params.get(String(def.paramId));
      if (name === 'exp') {
        const values = (def.values ?? []) as Array<{ name: string; value: number }>;
        const current = !cur ? 'unknown (not reported since connect)' : cur.mode === 0 ? 'auto' : values.find((v) => v.value === cur.value)?.name ?? cur.value;
        out.exposure = { current, options: ['auto', ...values.map((v) => v.name)], unit: 'seconds' };
      } else if (name === 'gain') {
        out.gain = { current: cur?.value ?? def.currentValue, options: def.values, note: def.range?.map((r) => `${r.minValue}-${r.maxValue}`).join(',') };
      } else if (name === 'wb') {
        out.white_balance = { current: this.state.whiteBalance[camera] ?? 'unknown', options: ['auto', ...WB_SCENES, 'or a kelvin value 2800-7500'] };
      } else if (name === 'filterType') {
        const v = (cur?.value as number | undefined) ?? (def.currentValue as number);
        out.filter = { current: FILTERS[v] ?? v, options: ((def.values ?? []) as number[]).map((i) => FILTERS[i] ?? i) };
      } else {
        out[name] = describeParam(def, cur?.value);
      }
    }
    const modeSettings: Record<string, unknown> = {};
    for (const [name, def] of Object.entries({ ...schema.techSettings, ...schema.modeParams })) modeSettings[name] = describeParam(def, params.get(String(def.paramId))?.value);
    const deviceSettings: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(schema.device)) deviceSettings[name] = describeParam(def, params.get(String(def.paramId))?.value);
    return {
      camera,
      modeId: mode,
      settings: out,
      modeSettings,
      deviceSettings,
      notes: 'deviceSettings apply to the whole telescope in every mode: autoShutdown = power off automatically when idle; disableHostSlave = multi-client host/slave arbitration. Change any of these with set_camera_setting (camera can be either).',
    };
  }

  /**
   * Set any camera/mode setting by name: exposure (by label or "auto"), gain, white balance,
   * filter, and every generic int/bool parameter the device lists for the mode.
   */
  async setSetting(camera: CameraName, setting: string, value: string | number | boolean, modeId?: number): Promise<string> {
    this.core.guards.assertNoOperation('changing camera settings');
    const key = setting.toLowerCase().replace(/[\s-]/g, '_');
    // 2026-10-12: auto exposure mid-stack made the scope reject every frame
    if (SHOOTING_KEYS.has(key)) this.core.guards.assertCameraFree(camera, `changing its ${key}`);
    const current = await this.currentModeId();
    if (modeId !== undefined && modeId !== current) {
      // 2026-10-12 (fw 1.5.3.9): a set with another mode's parameter id changes the CURRENT mode's
      // value (a Normal-mode wide gain set in DSO mode changed the DSO gain and left Normal's).
      // So go to that mode, set it there, and come back.
      const target = await this.setShootingMode(modeId);
      let result: string;
      try {
        result = await this.setSetting(camera, setting, value);
      } finally {
        await this.setShootingMode(current);
      }
      return `${result} (in ${target.name} mode; back in ${this.state.shootingMode?.name ?? 'the previous'} mode)`;
    }
    const mode = current;
    const schema = await http.getParamSchema(mode);
    const defs = schema.cameras[camId(camera)] ?? {};

    if (EXPOSURE_KEYS.has(key)) return this.setExposure(camera, defs.exp, mode, value, defs.gain);
    if (key === 'gain' || key === 'iso') {
      const def = defs.gain;
      if (!def) throw new Error(`gain is not adjustable in mode ${mode}`);
      const want = Number(value);
      if (!Number.isFinite(want)) throw new Error('gain must be a number');
      // the list is the camera's full one; the ranges are what this mode accepts (tele astro: 40-240)
      const inRange = (v: number) => !def.range?.length || def.range.some((r) => v >= r.minValue && v <= r.maxValue);
      const allowed = ((def.values ?? []) as number[]).filter((v) => typeof v === 'number' && inRange(v));
      // no discrete list: a whole number within one of the ranges the device gives
      if (!allowed.length && def.range?.length && !def.range.some((r) => Math.round(want) >= r.minValue && Math.round(want) <= r.maxValue)) {
        throw new Error(`gain must be within ${def.range.map((r) => `${r.minValue}-${r.maxValue}`).join(', ')}`);
      }
      const pick = allowed.length ? nearest(allowed, want) : Math.round(want);
      const expAutoBefore = defs.exp ? this.core.params.get(String(defs.exp.paramId))?.mode === 0 : false;
      await request(this.core, Cmd.PARAM_SET_GAIN, { paramId: packId(def), mode: 1, value: pick });
      // 2026-10-12 (fw 1.5.3.9): a manual gain puts an auto exposure back to manual (its last value), reported
      // before the reply. Left like that, the camera stays on whatever short exposure auto had picked: at night
      // a black live view (2026-10-18: the focus sweep's restore, exposure auto then gain, blanked the tele for
      // minutes). Auto exposure holds when set after the gain, so put it back.
      const expManualNow = defs.exp ? this.core.params.get(String(defs.exp.paramId))?.mode === 1 : false;
      let restored = '';
      if (expAutoBefore && expManualNow) {
        await this.setExposure(camera, defs.exp, mode, 'auto');
        restored = ' (the gain put the exposure from auto to manual; put back to auto)';
      }
      return `${camera} gain → ${pick}${pick !== want ? ` (nearest allowed to ${want})` : ''}${restored}`;
    }
    if (key === 'white_balance' || key === 'wb') return this.setWhiteBalance(camera, defs.wb, mode, value);
    if (FILTER_KEYS.has(key)) {
      const def = defs.filterType;
      if (!def) throw new Error(`the filter is not selectable in mode ${mode} on the ${camera} camera`);
      const idx = resolveFilter(value);
      await request(this.core, Cmd.PARAM_SET_GENERAL_INT_PARAM, { paramId: packId(def), value: idx });
      return `${camera} filter → ${FILTERS[idx]}`;
    }
    return this.setGeneric(camera, setting, key, value, mode, schema);
  }

  private async setExposure(
    camera: CameraName,
    def: http.ParamDef | undefined,
    mode: number,
    value: string | number | boolean,
    gainDef?: http.ParamDef,
  ): Promise<string> {
    if (!def) throw new Error(`exposure is not adjustable in mode ${mode}`);
    if (String(value).toLowerCase() === 'auto') {
      await request(this.core, Cmd.PARAM_SET_EXPOSURE, { paramId: packId(def), mode: 0, value: this.liveValue(def) ?? 0 });
      return `${camera} exposure → auto`;
    }
    const match = matchExposure((def.values ?? []) as Array<{ name: string; value: number }>, value);
    const gainBefore = gainDef ? this.liveValue(gainDef) : undefined;
    await request(this.core, Cmd.PARAM_SET_EXPOSURE, { paramId: packId(def), mode: 1, value: match.value });
    const kept = gainDef && gainBefore !== undefined ? await this.keepGain(camera, gainDef, gainBefore) : '';
    const warn =
      exposureLabelSeconds(match.name) >= 1
        ? ` — WARNING: the ${camera} live view is now PAUSED (the telescope stops live streaming at exposures ≥ 1 s) for the user and for you until exposure is set back to "auto". For a one-off night check use view_camera/analyze_image with exposure_s instead, which restores the setting automatically.`
        : '';
    return `${camera} exposure → ${match.name}s (manual)${kept}${warn}`;
  }

  /**
   * 2026-10-19 (fw 1.5.3.9): switching the tele exposure from auto to manual resets the gain (seen: 160,
   * and 40 on 2026-10-20), reported a moment after the reply. A sweep or a stack set up as exposure-then-gain survives it, but
   * anything that only changes the exposure silently shoots at 160. Wait for the reset and undo it.
   */
  private async keepGain(camera: CameraName, gainDef: http.ParamDef, before: number): Promise<string> {
    const deadline = Date.now() + GAIN_RESET_WATCH_MS;
    let now = this.liveValue(gainDef);
    while (now === before && Date.now() < deadline) {
      await sleep(GAIN_RESET_POLL_MS);
      now = this.liveValue(gainDef);
    }
    if (now === undefined || now === before) return '';
    await request(this.core, Cmd.PARAM_SET_GAIN, { paramId: packId(gainDef), mode: 1, value: before });
    log.info(`${camera} exposure change reset the gain to ${now}; set back to ${before}`);
    return ` (the telescope reset the gain to ${now}; put back to ${before})`;
  }

  private async setWhiteBalance(camera: CameraName, def: http.ParamDef | undefined, mode: number, value: string | number | boolean): Promise<string> {
    if (!def) throw new Error(`white balance is not adjustable in mode ${mode}`);
    const v = String(value).toLowerCase();
    if (v === 'auto') {
      await request(this.core, Cmd.PARAM_SET_WB, { paramId: packId(def), mode: 0, value: 0 });
      return `${camera} white balance → auto`;
    }
    const scene = WB_SCENES.findIndex((s) => s.toLowerCase() === v);
    if (scene >= 0) {
      await request(this.core, Cmd.PARAM_SET_WB, { paramId: packId(def), mode: 2, value: scene });
      return `${camera} white balance → ${WB_SCENES[scene]}`;
    }
    const kelvin = Number(v.replace(/k$/i, ''));
    if (!Number.isFinite(kelvin)) throw new Error(`white balance must be auto, a scene (${WB_SCENES.join(', ')}) or kelvin`);
    const ct = nearest(def.ctModeValues ?? [], kelvin);
    await request(this.core, Cmd.PARAM_SET_WB, { paramId: packId(def), mode: 1, value: ct });
    return `${camera} white balance → ${ct}K`;
  }

  private async setGeneric(camera: CameraName, setting: string, key: string, value: string | number | boolean, mode: number, schema: http.ParamSchema): Promise<string> {
    const all: Record<string, http.ParamDef> = { ...schema.device, ...schema.modeParams, ...schema.techSettings, ...(schema.cameras[camId(camera)] ?? {}) };
    const name = Object.keys(all).find((n) => n.toLowerCase() === key.replace(/_/g, '') || n.toLowerCase() === key || snake(n) === key);
    if (!name) throw new Error(`unknown setting "${setting}" for ${camera} in mode ${mode}. Known: exposure, gain, white_balance, filter, ${Object.keys(all).join(', ')}`);
    const def = all[name];
    if (def.valueType === 3) {
      const b = typeof value === 'boolean' ? value : ['true', '1', 'on', 'yes'].includes(String(value).toLowerCase());
      // fw 1.5.3 applies bool params but never acknowledges them: send, then verify by reading back
      await request(this.core, Cmd.PARAM_SET_GENERAL_BOOL_PARAM, { paramId: packId(def), value: b }, { bestEffort: true, timeout: BOOL_PARAM_MS });
      http.invalidateParamSchema();
      const after = await http.getParamSchema(mode);
      const all2: Record<string, http.ParamDef> = { ...after.device, ...after.modeParams, ...after.techSettings, ...(after.cameras[camId(camera)] ?? {}) };
      const now = all2[name]?.currentValue;
      if (now !== undefined && Boolean(now) !== b) throw new Error(`${name} did not change (device still reports ${now})`);
      return `${name} → ${b}${now !== undefined ? ' (verified on device)' : ''}`;
    }
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error(`${name} needs a whole number`);
    if (def.minValue !== undefined && def.maxValue !== undefined && def.maxValue > def.minValue && (n < def.minValue || n > def.maxValue)) {
      throw new Error(`${name} must be within ${def.minValue}..${def.maxValue}`);
    }
    await request(this.core, Cmd.PARAM_SET_GENERAL_INT_PARAM, { paramId: packId(def), value: n });
    return `${name} → ${n}`;
  }

  /**
   * Current exposure of a camera in the current mode: null = auto or not reported, else seconds.
   * Long manual exposures stop the camera's RTSP live stream on the telescope.
   */
  async exposureSeconds(camera: CameraName): Promise<number | null> {
    const def = (await this.schema()).cameras[camId(camera)]?.exp;
    if (!def) return null;
    const live = this.core.params.get(String(def.paramId));
    if (!live || live.mode === 0) return null;
    const name = ((def.values ?? []) as Array<{ name: string; value: number }>).find((v) => v.value === live.value)?.name;
    return name ? exposureLabelSeconds(name) : null;
  }

  /** The tele filter in use: the live value, else the schema's (stale) one, else VIS. */
  async currentFilterIndex(): Promise<number> {
    const def = (await this.schema()).cameras[0]?.filterType;
    const live = def ? this.liveValue(def) : undefined;
    if (live !== undefined) return live;
    return typeof def?.currentValue === 'number' ? (def.currentValue as number) : 0;
  }

  // ---- capture -------------------------------------------------------------

  /** A still answers after its exposure is read out and saved: overheadMs on top of the exposure; its end notification may follow the reply by notifySlackMs. */
  readonly photoTiming = { overheadMs: 30_000, notifySlackMs: 10_000 };

  /** Take a still photo and return the album entry it produced (null if it finished but none appeared). */
  async takePhoto(camera: CameraName): Promise<http.MediaItem | null> {
    this.core.guards.assertNoNdLock('taking a photo');
    this.core.guards.assertNoOperation('taking a photo');
    this.core.guards.assertCameraFree(camera, 'taking a photo');
    if (this.state.photoStuckSince?.[camera]) throw new Error(stuckPhotoMessage(camera));
    // an ended stacking session not finished leaves a tele photo unanswered (wire logs 2026-10-10..12)
    await finishEndedSession(this.core, camera, 'a photo');
    const done = photoInFlight(this.core, camera);
    try {
      return await this.shoot(camera);
    } finally {
      done();
    }
  }

  private async shoot(camera: CameraName): Promise<http.MediaItem | null> {
    const started = Math.floor(Date.now() / 1000) - ALBUM_CLOCK_SLACK_S;
    // a long exposure answers only after it is read out: allow for it, then the album is the proof
    const expS = (await this.exposureSeconds(camera).catch(() => null)) ?? 0;
    const budget = Math.round(expS * 1000) + this.photoTiming.overheadMs;
    const ended = this.core.link.waitFor((n) => n.name === 'photoState' && (n.data.state ?? 0) === 0 && ((n.data.cameraType as number) ?? 0) === camId(camera), budget + this.photoTiming.notifySlackMs);
    ended.catch(() => {}); // observed below; never an unhandled rejection if the command throws
    const cmd = camera === 'tele' ? Cmd.CAMERA_TELE_PHOTOGRAPH : Cmd.CAMERA_WIDE_PHOTOGRAPH;
    const r = await request(this.core, cmd, {}, { timeout: budget, bestEffort: true, allowError: true });
    if (r && Number(r.code ?? 0) < 0) throw new DwarfCommandError(cmd, Number(r.code), r);
    const finished = await ended.then(() => true).catch(() => sleep(PHOTO_FALLBACK_WAIT_MS).then(() => false));
    const item = await this.findNewMedia(1, camera, started, PHOTO_ALBUM_TRIES);
    // no reply, no end of the photo and nothing in the album: a stuck camera (photo-watch.ts), not a slow album
    if (!item && !r && !finished) {
      markPhotoStuck(this.core, camera, started * 1000);
      this.core.store.changed();
      throw new Error(stuckPhotoMessage(camera));
    }
    return item;
  }

  async findNewMedia(mediaType: number, camera: CameraName | null, sinceEpochS: number, tries = 5): Promise<http.MediaItem | null> {
    for (let i = 0; i < tries; i++) {
      const items = await http.listMedia(mediaType, 0, ALBUM_RECENT).catch(() => [] as http.MediaItem[]);
      const hit = items.find((m) => m.modificationTime >= sinceEpochS && (camera === null || (m.camId ?? 0) === camId(camera)));
      if (hit) return hit;
      if (i < tries - 1) await sleep(ALBUM_POLL_MS);
    }
    return null;
  }

  /**
   * Get into a mode that offers a technique (and, when given, lists its setting). 2026-10-12 (fw
   * 1.5.3.9): in DSO mode the telescope accepts the burst technique and the burst command but lists
   * no burst count there, and shoots one frame; in Normal mode the same burst of 4 shot 4. DSO offers
   * only stacking; Normal offers photo, burst, video and timelapse, as the official app has them.
   */
  private async modeFor(camera: CameraName, tech: ShootingTech, setting: string | undefined, what: string): Promise<{ def?: http.ParamDef; switched?: string }> {
    const techId = Number(Object.entries(http.SHOOTING_TECH_NAMES).find(([, n]) => n === tech)?.[0]);
    const ready = async () => {
      const modeId = await this.currentModeId();
      const mode = (await http.getShootingModes()).find((m) => m.id === modeId);
      const offered = !mode?.shootingTechnology || mode.shootingTechnology.some((t) => t.id === techId && (!Array.isArray(t.cameraIds) || t.cameraIds.includes(camId(camera))));
      const def = setting ? (await this.schema(modeId)).techSettings[camera === 'wide' ? `${setting}_wide` : setting] ?? (await this.schema(modeId)).techSettings[setting] : undefined;
      return { ok: offered && (!setting || !!def), def };
    };
    const now = await ready();
    if (now.ok) return { def: now.def };
    const from = this.state.shootingMode?.name ?? 'the current';
    await this.ensureMode('Normal');
    const after = await ready();
    if (!after.ok) throw new Error(`${what} is not available: Normal mode does not offer it either${setting ? ` (no ${setting} setting)` : ''}`);
    return { def: after.def, switched: `switched from ${from} mode to Normal mode for ${what}` };
  }

  async burst(camera: CameraName, count: number): Promise<string> {
    if (!Number.isInteger(count) || count < 1 || count > BURST_MAX) throw new Error(`a burst is a whole number of frames up to ${BURST_MAX} (got ${count})`);
    this.core.guards.assertNoNdLock('a burst');
    this.core.guards.assertNoOperation('a burst');
    this.core.guards.assertCameraFree(camera, 'a burst');
    const { def, switched } = await this.modeFor(camera, 'burst', 'burstCount', 'a burst');
    if (!def) throw new Error('a burst is not available: the telescope lists no burst count');
    await this.setShootingTech('burst');
    // the device's own range (fw 1.5.3.9: 3..1000)
    const n = Math.max(def.minValue ?? 1, Math.min(def.maxValue ?? BURST_MAX, BURST_MAX, count));
    await request(this.core, Cmd.PARAM_SET_GENERAL_INT_PARAM, { paramId: packId(def), value: n });
    const done = this.core.link.waitFor((x) => x.name === 'burstState' && (x.data.state ?? 0) === 0, BURST_BASE_MS + n * BURST_PER_FRAME_MS);
    done.catch(() => {});
    await sendConfirmed(this.core, camera === 'tele' ? Cmd.CAMERA_TELE_BURST : Cmd.CAMERA_WIDE_BURST, { count: n }, 'burst');
    const ok = await done.then(() => true).catch(() => false);
    const progress = this.state.capture.burstProgress;
    const notes = [switched, n !== count ? `${n} frames: the telescope's burst is ${def.minValue ?? 1}..${def.maxValue ?? BURST_MAX}` : ''].filter(Boolean).join('; ');
    return (
      (ok
        ? `burst of ${n} on ${camera} finished (${progress ?? 'done'})`
        : `burst of ${n} on ${camera} started, but the telescope did not report its end (progress ${progress ?? 'unknown'}); check list_album`) + (notes ? ` — ${notes}` : '')
    );
  }

  async record(camera: CameraName, action: 'start' | 'stop'): Promise<string> {
    let switched: string | undefined;
    if (action === 'start') {
      this.core.guards.assertNoNdLock('recording video');
      this.core.guards.assertNoOperation('recording video');
      this.core.guards.assertCameraFree(camera, 'recording video');
      ({ switched } = await this.modeFor(camera, 'video', undefined, 'recording video'));
      await this.setShootingTech('video');
    }
    const tele = camera === 'tele';
    const cmd = action === 'start' ? (tele ? Cmd.CAMERA_TELE_START_RECORD : Cmd.CAMERA_WIDE_START_RECORD) : tele ? Cmd.CAMERA_TELE_STOP_RECORD : Cmd.CAMERA_WIDE_STOP_RECORD;
    const want = action === 'start' ? 'running' : 'idle|stopped';
    await sendConfirmed(this.core, cmd, action === 'start' ? { encodeType: 1 } : {}, `${action} recording`, {
      confirm: () => new RegExp(`^${camera}:(${want})$`).test(this.state.capture.record ?? ''),
    });
    return `${camera} recording ${action === 'start' ? 'started' : 'stopped'}${switched ? ` — ${switched}` : ''}`;
  }

  async timelapse(camera: CameraName, action: 'start' | 'stop', intervalS?: number, totalS?: number): Promise<string> {
    let switched: string | undefined;
    if (action === 'start') {
      this.core.guards.assertNoNdLock('a timelapse');
      this.core.guards.assertNoOperation('a timelapse');
      this.core.guards.assertCameraFree(camera, 'a timelapse');
      ({ switched } = await this.modeFor(camera, 'timelapse', 'timelapseIntervalTime', 'a timelapse'));
      await this.setShootingTech('timelapse');
      if (intervalS !== undefined) await this.setSetting(camera, 'timelapseIntervalTime', intervalS);
      if (totalS !== undefined) await this.setSetting(camera, 'timelapseTotalTime', totalS);
    }
    const tele = camera === 'tele';
    const cmd =
      action === 'start'
        ? tele
          ? Cmd.CAMERA_TELE_START_TIMELAPSE_PHOTO
          : Cmd.CAMERA_WIDE_START_TIMELAPSE_PHOTO
        : tele
          ? Cmd.CAMERA_TELE_STOP_TIMELAPSE_PHOTO
          : Cmd.CAMERA_WIDE_STOP_TIMELAPSE_PHOTO;
    const want = action === 'start' ? 'running' : 'idle|stopped';
    await sendConfirmed(this.core, cmd, {}, `${action} timelapse`, {
      confirm: () => new RegExp(`^${camera}:(${want})$`).test(this.state.capture.timelapse ?? ''),
    });
    return `${camera} timelapse ${action === 'start' ? 'started' : 'stopped'}${switched ? ` — ${switched}` : ''}`;
  }
}
