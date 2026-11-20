/**
 * Keeping focus equivalent through a filter change: when a driver changes the tele filter, the
 * focuser moves by the measured offset between the two filters (model.ts), so a focus found
 * through one filter stays the best focus through the other.
 *
 * In this order, every step settled before the next (the scope reports a move before the wheel or
 * the focuser has come to rest, and a frame or a stack that starts in that moment is the old
 * setting's):
 *   1. the position before the change;
 *   2. the change itself, then the wheel's settle;
 *   3. the position again — when the scope moved the focuser by itself on the change it applies
 *      its own compensation, and a second shift on top would double it: left as it is, and said;
 *   4. the shift, then the focuser's settle.
 *
 * It does nothing when either filter's offset is unknown (nothing to go on), or while a stack is
 * collecting (a focuser move mid-stack ruins frames: the stack's own refocus handles that).
 */
import { errMsg, logger } from '../../log.js';
import { offsetStatus, shiftBetween } from './model.js';

const log = logger('focus-offsets');

/** a focuser that moved more than this by itself across the change did its own compensation */
const SELF_MOVE_UNITS = 2;

export interface FocuserAccess {
  /** the device key the offsets are filed under (deviceKey(spec, serial)); null when not known */
  device(): Promise<string | null>;
  position(): Promise<number | null>;
  moveTo(position: number): Promise<number | null>;
  /** why the focuser must not move now (a stack collecting), else null */
  blocked(): string | null;
  /** the scope's temperature now, for an offset that follows temperature */
  tempC(): number | undefined;
  /** after the filter change, before the position is read again */
  filterSettleMs: number;
  /** after the focuser move */
  focusSettleMs: number;
  min?: number;
  max?: number;
}

/** What a filter change did to the focus, for the tool's answer and the log. */
export interface FollowResult {
  moved: boolean;
  shift: number | null;
  from?: number | null;
  to?: number | null;
  line: string | null;
}

export type FilterFollower = (fromFilter: string, toFilter: string, change: () => Promise<void>) => Promise<FollowResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function filterFocusFollower(a: FocuserAccess): FilterFollower {
  return async (fromFilter, toFilter, change) => {
    if (fromFilter === toFilter) {
      await change();
      return { moved: false, shift: 0, line: null };
    }
    let shift: number | null = null;
    try {
      const dev = await a.device();
      if (dev) shift = shiftBetween(offsetStatus(dev), fromFilter, toFilter, a.tempC());
    } catch (e) {
      log.debug(`offset ${fromFilter} → ${toFilter} not read: ${errMsg(e)}`);
    }
    if (shift === null) {
      await change();
      await sleep(a.filterSettleMs);
      return { moved: false, shift: null, line: `no focus offset measured between ${fromFilter} and ${toFilter} (focus_offsets): the focuser was not moved` };
    }
    const step = Math.round(shift);
    if (!step) {
      await change();
      await sleep(a.filterSettleMs);
      return { moved: false, shift, line: null };
    }
    const why = a.blocked();
    if (why) {
      await change();
      await sleep(a.filterSettleMs);
      return { moved: false, shift, line: `the ${fromFilter} → ${toFilter} focus offset (${step > 0 ? '+' : ''}${step}) was not applied: ${why}` };
    }
    const before = await a.position().catch(() => null);
    await change();
    await sleep(a.filterSettleMs);
    const after = await a.position().catch(() => null);
    if (before !== null && after !== null && Math.abs(after - before) > SELF_MOVE_UNITS) {
      log.warn(`the focuser moved by itself on ${fromFilter} → ${toFilter} (${before} → ${after}): the scope compensates on its own, the offset (${step}) is not applied on top`);
      return { moved: false, shift, from: before, to: after, line: `the scope moved the focuser itself on the filter change (${before} → ${after}): its own compensation, the measured offset (${step > 0 ? '+' : ''}${step}) not added on top` };
    }
    const start = after ?? before;
    if (start === null) return { moved: false, shift, line: `the focuser position is unknown: the ${fromFilter} → ${toFilter} offset (${step > 0 ? '+' : ''}${step}) was not applied` };
    const target = Math.max(a.min ?? 0, Math.min(a.max ?? Number.MAX_SAFE_INTEGER, start + step));
    try {
      const at = (await a.moveTo(target)) ?? target;
      await sleep(a.focusSettleMs);
      const line = `focus ${start} → ${at} to stay equivalent through ${toFilter} (measured offset ${fromFilter} → ${toFilter}: ${step > 0 ? '+' : ''}${step})`;
      log.info(line);
      return { moved: true, shift, from: start, to: at, line };
    } catch (e) {
      return { moved: false, shift, from: start, line: `the ${fromFilter} → ${toFilter} offset (${step > 0 ? '+' : ''}${step}) could not be applied: ${errMsg(e)}` };
    }
  };
}
