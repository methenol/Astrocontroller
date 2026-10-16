/**
 * Tele dark masters. The firmware does not answer the start (11021; verified 2026-10-03: 20 x 15 s
 * and 20 x 30 s masters saved, no reply), so completion is detected from the master file appearing
 * (or being rewritten) in CALI_FRAME/dark/cam_0 on the SD card, with its state notification as a
 * hint to look again. Only an immediate refusal is reported by the start; state.darkCapture
 * follows the rest.
 */
import { errMsg, logger } from '../../log.js';
import { listDir } from '../ftp.js';
import type { Notification } from '../link.js';
import { errorText } from '../protocol.js';
import { request, sendStop, type Core } from './core.js';
import type { DarkCaptureState } from './state.js';
import { sleep } from './util.js';

const log = logger('dwarf');

/** fw 1.5.3 dark commands (not in the published protocol). */
const CMD_DARK_START = 11021;
const CMD_DARK_STOP = 11022;
const CMD_DARK_LIST = 11023;
const DARK_DIR = '/Astronomy/CALI_FRAME/dark/cam_0';
const LIST_MS = 15_000;
const STOP_MS = 10_000;
const LIST_ATTEMPTS = 3;
/** the master is written this long after the last frame at most */
const MASTER_WRITE_MS = 60_000;
/** no master after twice the capture time plus this: report the outcome as unknown */
const GIVE_UP_EXTRA_MS = 300_000;
/** the master cannot exist before this share of frames × exposure has passed */
const EARLIEST_SHARE = 0.9;

export interface DarkMaster {
  expIndex: number;
  gainIndex: number;
  binIndex: number;
  exposure: string;
  gain: string;
  bin: string;
  temperatureC?: number;
}

export interface DarkRequest {
  expIndex: number;
  gainIndex: number;
  binIndex: number;
  frames: number;
  exposureS: number;
  gain: number;
}

type SdFile = Awaited<ReturnType<typeof listDir>>[number];

export class Darks {
  /** refusalWaitMs: how long to wait for an immediate refusal of the (never acknowledged) start */
  readonly darkTiming = { checkEveryMs: 20_000, listRetryMs: 3_000, refusalWaitMs: 8_000 };
  /** Lists a folder on the SD card (FTP; tests replace it). */
  listSdDir: typeof listDir = listDir;
  /** the running capture: look for its master now / end its bookkeeping */
  private active: { check(): void; finish(patch: Partial<DarkCaptureState>): void } | null = null;
  /** a capture is between its checks and its "running" state (listing the SD card): a second start is refused */
  private starting = false;

  constructor(private readonly core: Core) {}

  private get state() {
    return this.core.store.state;
  }

  /** The tele camera's dark masters as the firmware lists them: its own index codes plus readable names. */
  async list(): Promise<DarkMaster[]> {
    const r = await request(this.core, CMD_DARK_LIST, {}, { timeout: LIST_MS });
    return ((r?.results ?? []) as Array<Record<string, any>>).map((d) => ({
      expIndex: Number(d.expIndex ?? 0),
      gainIndex: Number(d.gainIndex ?? 0),
      binIndex: Number(d.binIndex ?? 0),
      exposure: String(d.expName ?? ''),
      gain: String(d.gainName ?? ''),
      bin: String(d.binName ?? ''),
      temperatureC: d.temperature ?? undefined,
    }));
  }

  /** The firmware's dark state left "running": look for the master now. */
  onFirmwareEnded(): void {
    this.active?.check();
  }

  async capture(o: DarkRequest): Promise<void> {
    const { guards, stacks, link } = this.core;
    for (const k of ['expIndex', 'gainIndex', 'binIndex', 'frames', 'gain'] as const) {
      if (!Number.isInteger(o[k]) || o[k] < 0) throw new Error(`dark capture: ${k} must be a whole number ≥ 0 (got ${o[k]})`);
    }
    if (o.frames < 1) throw new Error('dark capture: frames must be at least 1');
    if (!Number.isFinite(o.exposureS) || o.exposureS <= 0) throw new Error(`dark capture: exposure must be a positive number of seconds (got ${o.exposureS})`);
    if (this.starting || this.state.darkCapture?.state === 'running') throw new Error('a dark capture is already running (dark_frames action=status)');
    if (!this.state.ndLock) {
      throw new Error('refused: darks need the ND filter over the lenses and the motion lock (dark_frames action=nd_fitted operator_confirmed=true once the operator has fitted it). Nothing was captured.');
    }
    guards.assertNoOperation('a dark capture');
    if (stacks.owns('tele') || guards.stackOwnsCamera('tele')) throw new Error('refused: the tele camera is live stacking; stop it first. Nothing was captured.');
    // The finished master is recognised as a file that is new or rewritten since now: without this
    // listing an older master of the same exposure and gain would be taken for the new one.
    this.starting = true;
    let listing: SdFile[];
    try {
      listing = await this.listWithRetry();
    } finally {
      this.starting = false;
    }
    // the listing took a while: the filter may have been removed (nd_removed) meanwhile
    if (!this.state.ndLock) throw new Error('refused: the ND lock was released while the capture was being prepared; nothing was captured. Fit the filter again (dark_frames action=nd_fitted) to capture.');
    const before = new Map(listing.map((f) => [f.name, fileKey(f)]));
    const want = new RegExp(`^dark_exp_${o.exposureS.toFixed(6).replace('.', '\\.')}_gain_${o.gain}_.*stack_${o.frames}\\.fits$`, 'i');
    const now = Date.now();
    const runMs = o.frames * o.exposureS * 1000;
    this.core.store.publish({
      darkCapture: { state: 'running', fwState: undefined, exposureS: o.exposureS, gain: o.gain, frames: o.frames, sensorC: this.state.cmosTempC.tele, startedAt: now, expectedEndAt: now + runMs + MASTER_WRITE_MS, progress: 0 },
    });

    const finish = (patch: Partial<DarkCaptureState>) => {
      // the watchers go in any case: a state that is no longer running must not leave them polling
      clearInterval(timer);
      link.off('notification', onPowerOff);
      if (this.active === mine) this.active = null;
      const cur = this.state.darkCapture;
      if (cur?.state !== 'running') return;
      const done = { ...cur, ...patch, remainingS: 0, finishedAt: Date.now() };
      log.info(`dark capture ${o.exposureS} s / gain ${o.gain}: ${done.state}${done.master ? ` (${done.master})` : ''}${done.error ? ` — ${done.error}` : ''}`);
      this.core.store.publish({ darkCapture: done });
    };
    let checking = false;
    const check = async () => {
      if (checking) return;
      if (this.state.darkCapture?.state !== 'running') return finish({});
      checking = true;
      try {
        const files = await this.listSdDir(DARK_DIR);
        const hit = files.find((f) => want.test(f.name) && before.get(f.name) !== fileKey(f));
        if (hit) finish({ state: 'done', progress: 100, master: hit.name });
        else if (Date.now() > now + runMs * 2 + GIVE_UP_EXTRA_MS) finish({ state: 'unknown', error: 'no new master appeared in CALI_FRAME; check dark_frames action=list' });
      } catch {
        /* FTP busy: next round */
      } finally {
        checking = false;
      }
    };
    const mine = { check: () => void check(), finish };
    this.active = mine;
    // a power-off ends the capture; a dropped Wi-Fi link does not (the telescope carries on)
    const onPowerOff = (n: Notification) => {
      if (n.name === 'powerOff') finish({ state: 'failed', error: 'the telescope powered off during the capture' });
    };
    link.on('notification', onPowerOff);
    // the master can only exist after frames x exposure: look from EARLIEST_SHARE of that on
    const timer = setInterval(() => {
      if (Date.now() >= now + runMs * EARLIEST_SHARE) void check();
    }, this.darkTiming.checkEveryMs);
    timer.unref();
    // in case a firmware version does answer: a refusal comes back at once
    const r = await request(this.core, CMD_DARK_START, { expIndex: o.expIndex, gainIndex: o.gainIndex, binIndex: o.binIndex, capSize: o.frames }, { bestEffort: true, allowError: true, timeout: this.darkTiming.refusalWaitMs }).catch(() => null);
    const code = Number(r?.code ?? 0);
    if (code < 0) {
      finish({ state: 'failed', error: errorText(code) });
      throw new Error(`the telescope refused the dark capture: ${errorText(code)}`);
    }
  }

  async stop(): Promise<void> {
    await sendStop(this.core, CMD_DARK_STOP, STOP_MS);
    this.active?.finish({ state: 'stopped' });
    this.core.store.changed();
  }

  private async listWithRetry(): Promise<SdFile[]> {
    let err = '';
    for (let i = 0; i < LIST_ATTEMPTS; i++) {
      try {
        return await this.listSdDir(DARK_DIR);
      } catch (e) {
        err = errMsg(e);
        if (i < LIST_ATTEMPTS - 1) await sleep(this.darkTiming.listRetryMs);
      }
    }
    throw new Error(`could not list ${DARK_DIR} over FTP (${err}), so the finished master could not be recognised; nothing was started. Try again in a minute.`);
  }
}

const fileKey = (f: SdFile) => `${f.size}|${f.modifiedAt ?? ''}`;
