/**
 * PROMPT_TRANSFER_ON_CHARGE: when the telescope is plugged in to charge (brought back inside at the
 * end of a night) and its SD card holds sessions that are not in the library yet, wake the agent
 * with the end-of-session routine: park, transfer (processing queues itself), shut down when the
 * transfers are done.
 *
 * Fires on the change not charging → charging (the last known value survives a dropped connection,
 * so carrying the scope inside and reconnecting counts). Never while it is imaging: a power bank
 * plugged in during a field session must not end it.
 */
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import type { Dwarf } from '../dwarf/device.js';
import type { AgentBridge } from './omp.js';
import * as library from '../library/transfer.js';

const log = logger('charge');

/** Let a wobbly connector settle, and the state refresh, before acting. */
const SETTLE_MS = 20000;
/** The routine runs at most once in this long. */
const COOLDOWN_MS = 30 * 60000;

export type ChargeDevice = Pick<Dwarf, 'state' | 'isBusy' | 'isTracking' | 'on' | 'off'>;
export type ChargeAgent = Pick<AgentBridge, 'note' | 'prompt'>;

export interface ChargeWatchOptions {
  settleMs?: number;
  cooldownMs?: number;
  /** Folders on the SD card with subs that are not in the library yet. */
  pendingSessions?: () => Promise<string[]>;
  now?: () => number;
}

async function untransferredSessions(): Promise<string[]> {
  const { sessions } = await library.listDeviceSessions(true);
  return sessions.filter((s) => !s.transferred && (s.fitsCount ?? 0) > 0).map((s) => s.folder);
}

export function endOfSessionPrompt(battery: number | undefined, pending: string[]): string {
  return [
    '[Automatic event from Astrocontroller, not typed by the user]',
    `The telescope was just plugged in to charge (battery ${battery ?? '?'}%). The user enabled PROMPT_TRANSFER_ON_CHARGE, which means: run the end-of-session routine now, without asking.`,
    `Sessions on the SD card that are not in the library yet: ${pending.join(', ')}.`,
    '1. Park the scope: move_motors pitch_deg=2.5 (motors_home first if it is not homed).',
    '2. transfer_session for each of those sessions. Processing in AstroPhoto Studio queues itself after each transfer.',
    '3. Follow the transfers with jobs until all are done. If one fails, retry it once; if it fails again, do NOT shut down: report it and stop.',
    '4. Check processing_status that the sessions are queued or processing.',
    '5. Shut the telescope down: power action=shutdown.',
    '6. Write a short summary: what was transferred, processing profile and ETA.',
  ].join('\n');
}

export class ChargeWatch {
  private last: boolean | undefined;
  private lastFired = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private started = false;
  private readonly settleMs: number;
  private readonly cooldownMs: number;
  private readonly pending: () => Promise<string[]>;
  private readonly now: () => number;
  private readonly onState = () => this.follow();

  constructor(
    private readonly dwarf: ChargeDevice,
    private readonly agent: ChargeAgent,
    opts: ChargeWatchOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? SETTLE_MS;
    this.cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
    this.pending = opts.pendingSessions ?? untransferredSessions;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.dwarf.on('state', this.onState);
  }

  stop(): void {
    this.started = false;
    this.dwarf.off('state', this.onState);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private follow(): void {
    const charging = this.dwarf.state.charging;
    if (charging === undefined || !this.dwarf.state.connected) return;
    const prev = this.last;
    this.last = charging;
    if (prev !== false || !charging || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, this.settleMs);
    this.timer.unref();
  }

  /** Decide and, when due, wake the agent. Returns whether it was woken (exported for tests). */
  async check(): Promise<boolean> {
    if (this.checking) return false;
    this.checking = true;
    try {
      return await this.run();
    } finally {
      this.checking = false;
    }
  }

  private async run(): Promise<boolean> {
    const st = this.dwarf.state;
    if (!st.charging || !st.connected) return false;
    if (this.now() - this.lastFired < this.cooldownMs) return false;
    // tracking is imaging too (a timelapse or video on a tracked target), and parking would end it
    const busy = this.dwarf.isBusy() ?? (this.dwarf.isTracking() ? 'tracking' : null);
    if (busy) {
      log.info(`plugged in to charge while ${busy}: not starting the end-of-session routine`);
      return false;
    }
    let pending: string[];
    try {
      pending = await this.pending();
    } catch (e) {
      log.warn(`plugged in to charge, but listing the SD card failed: ${errMsg(e)}`);
      return false;
    }
    if (!pending.length) {
      log.info('plugged in to charge; every session is already in the library');
      return false;
    }
    try {
      this.agent.note('info', `Telescope plugged in to charge: ${pending.length} session(s) to transfer, starting the end-of-session routine`);
      await this.agent.prompt(endOfSessionPrompt(this.dwarf.state.battery, pending));
    } catch (e) {
      log.warn(`could not wake the agent: ${errMsg(e)}`);
      return false;
    }
    this.lastFired = this.now();
    log.info(`plugged in to charge: agent woken for ${pending.length} session(s)`);
    return true;
  }
}

/** Start watching when PROMPT_TRANSFER_ON_CHARGE is on; returns the watch (to stop at shutdown), or null. */
export function watchCharging(dwarf: Dwarf, agent: AgentBridge): ChargeWatch | null {
  if (!config.agent.promptOnCharge) return null;
  const w = new ChargeWatch(dwarf, agent);
  w.start();
  return w;
}
