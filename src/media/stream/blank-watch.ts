/**
 * Notices a tele feed that delivers only black frames, and works through a recovery ladder.
 *
 * 2026-11-09: a stack left the tele on its imaging gain (60). With the exposure on auto (the firmware
 * sat at the same short value throughout) the live view was black while the connection looked
 * perfectly healthy, and the agent rebooted the telescope, which changes neither. So a black feed is
 * treated as its own condition. The steps go from harmless to intrusive, and each waits for a moment
 * when nothing is running. This watch never reboots the telescope and never suggests it.
 */
import { errMsg, logger } from '../../log.js';
import type { Frame } from './source.js';

const log = logger('stream');

const TICK_MS = 5000;
/** A frame older than this says nothing about the feed now. */
const FRESH_MS = 15_000;
/** Black samples in a row, over at least this long, make an episode (single black frames are normal). */
const CONFIRM_SAMPLES = 3;
const CONFIRM_MS = 10_000;
const REENTER_AFTER_MS = 60_000;
const REARM_AFTER_MS = 180_000;
const NOTIFY_AFTER_MS = 360_000;

export interface BlankWatchDeps {
  frame(): Frame | null;
  isBlack(jpeg: Buffer): Promise<boolean>;
  /** Nothing is running that makes black frames expected or forbids touching the camera. */
  canWatch(): boolean;
  /** Raises a too-low live-view gain; says what it did, or null when there was nothing to raise. */
  raiseGain(): Promise<string | null>;
  reenterCamera(): Promise<void>;
  rearmCamera(): Promise<void>;
  /** Saves what the feeds and the camera looked like; returns where. */
  saveEvidence(): Promise<string>;
}

interface Episode {
  since: number;
  step: number;
  did: string[];
  evidence?: string;
  notified: boolean;
}

export class BlankWatch {
  private timer: NodeJS.Timeout | null = null;
  private notify: (text: string) => void = () => {};
  private ticking = false;
  private lastAt = 0;
  private streak = 0;
  private firstBlackAt = 0;
  private episode: Episode | null = null;

  constructor(private readonly deps: BlankWatchDeps) {}

  start(notify: (text: string) => void): void {
    this.notify = notify;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    const e = this.episode;
    return e ? { black: true, sinceS: Math.round((Date.now() - e.since) / 1000), recovery: e.did, evidence: e.evidence } : { black: false };
  }

  /** One look at the feed. Public so the tests can drive the clock. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.deps.canWatch()) return;
      const f = this.deps.frame();
      if (!f || f.at === this.lastAt || now - f.at > FRESH_MS) return;
      this.lastAt = f.at;
      if (await this.deps.isBlack(f.jpeg).catch(() => false)) await this.onBlack(now);
      else this.onPicture(now);
    } catch (e) {
      log.warn(`black-frame watch: ${errMsg(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async onBlack(now: number): Promise<void> {
    if (this.streak++ === 0) this.firstBlackAt = now;
    if (!this.episode && this.streak >= CONFIRM_SAMPLES && now - this.firstBlackAt >= CONFIRM_MS) {
      this.episode = { since: now, step: 0, did: [], notified: false };
      log.warn('tele: the feed is delivering only black frames; starting recovery');
      this.episode.evidence = await this.deps.saveEvidence().catch((e) => {
        log.warn(`could not save the black-frame evidence: ${errMsg(e)}`);
        return undefined;
      });
    }
    if (this.episode) await this.advance(this.episode, now);
  }

  private onPicture(now: number): void {
    this.streak = 0;
    this.firstBlackAt = 0;
    const e = this.episode;
    if (!e) return;
    this.episode = null;
    const line = `tele: picture is back after ${Math.round((now - e.since) / 1000)} s of black frames${e.did.length ? ` (${e.did.join('; ')})` : ''}`;
    log.info(line);
    if (e.notified) this.notify(line);
  }

  /** At most one step per look: the next look shows whether it helped. */
  private async advance(e: Episode, now: number): Promise<void> {
    const elapsed = now - e.since;
    const run = async (what: string, action: () => Promise<string | null | void>) => {
      e.step++;
      try {
        const r = await action();
        if (r === null) return;
        e.did.push(typeof r === 'string' ? r : what);
        log.info(`tele black-frame recovery: ${typeof r === 'string' ? r : what}`);
      } catch (err) {
        log.warn(`tele black-frame recovery, ${what}: ${errMsg(err)}`);
      }
    };
    if (e.step === 0) return run('raise the live-view gain', () => this.deps.raiseGain());
    if (e.step === 1 && elapsed >= REENTER_AFTER_MS) return run('re-entered the camera', () => this.deps.reenterCamera());
    if (e.step === 2 && elapsed >= REARM_AFTER_MS) return run('sent go live and re-entered the camera', () => this.deps.rearmCamera());
    if (e.step === 3 && elapsed >= NOTIFY_AFTER_MS) {
      e.step++;
      e.notified = true;
      this.notify(
        `the tele feed has been black for ${Math.round(elapsed / 60000)} min and automatic recovery did not bring the picture back (tried: ${e.did.join('; ') || 'nothing applied'}).${e.evidence ? ` Evidence: ${e.evidence}.` : ''} Check the sky and the tele with tele_visibility, which shoots at a working exposure and gain. A black feed is not a reason to reboot the telescope.`,
      );
    }
  }
}
