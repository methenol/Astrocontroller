/**
 * The Seestar's filter wheel: its slots, which one is in, and the one way the app changes it.
 *
 * Every change goes through setSeestarFilter (set_camera_setting, the quality probe, the focus
 * calibration): it waits for the wheel to come to rest before anything shoots through it, and when
 * the focus offsets between the two filters are measured (astro/focus-offsets) it moves the
 * focuser by the difference, so the focus stays equivalent. The GoTo's lp_filter is the
 * firmware's own choice of slot at the start of a view, before the target procedure's autofocus
 * and star_focus: it is left alone.
 */
import type { FilterFollower } from '../../astro/focus-offsets/index.js';
import type { Seestar } from './device.js';

/** the wheel reports the new slot before it has stopped turning */
export const WHEEL_SETTLE_MS = 2_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Wheel {
  position: number | null;
  slots: string[];
}

export async function seestarWheel(scope: Seestar): Promise<Wheel> {
  const [pos, names] = await Promise.all([scope.raw('get_wheel_position'), scope.raw('get_wheel_slot_name')]);
  return { position: typeof pos.result === 'number' ? pos.result : null, slots: Array.isArray(names.result) ? (names.result as unknown[]).map(String) : [] };
}

/** The slot holding a filter, by its name or the app's name for it (IRCUT, LP, dark); -1 when none. */
export function slotOf(slots: string[], filter: string): number {
  const want = filter.toLowerCase().replace(/[^a-z]/g, '');
  const exact = slots.findIndex((n) => n.toLowerCase().replace(/[^a-z]/g, '') === want);
  if (exact >= 0) return exact;
  return slots.findIndex((n) => (want.startsWith('lp') && /^lp/i.test(n)) || (/ircut|uvir|none/.test(want) && /ir/i.test(n)) || (want === 'dark' && /dark/i.test(n)));
}

/** A slot's name as the app calls the filter (the device spec's IRCUT and LP; dark stays dark). */
export function canonicalFilter(slot: string): string {
  if (/^lp/i.test(slot) || /duo|dual|light.?poll/i.test(slot)) return 'LP';
  if (/dark/i.test(slot)) return 'dark';
  if (/ir|cut|uv|none|clear/i.test(slot)) return 'IRCUT';
  return slot;
}

const followers = new WeakMap<Seestar, FilterFollower>();

/** Install what keeps the focus equivalent through a filter change (the runtime does, once). */
export function setFilterFollower(scope: Seestar, f: FilterFollower | null): void {
  if (f) followers.set(scope, f);
  else followers.delete(scope);
}

export interface FilterChange {
  filter: string;
  wheelPosition: number;
  changed: boolean;
  /** what the change did to the focus, when anything */
  focus?: string;
}

/** Put a filter in, settled; the focus follows by the measured offset (unless `keepFocus` is false or the dark slot is involved). */
export async function setSeestarFilter(scope: Seestar, filter: string, o: { keepFocus?: boolean } = {}): Promise<FilterChange> {
  const w = await seestarWheel(scope);
  const i = slotOf(w.slots, filter);
  if (i < 0) throw new Error(`no filter ${filter}: the wheel has ${w.slots.join(', ') || 'no slots it reports'}`);
  if (w.position === i) return { filter: w.slots[i], wheelPosition: i, changed: false };
  const change = async () => {
    const r = await scope.raw('set_wheel_position', [i]);
    if (r.error) throw new Error(`set_wheel_position ${i}: ${typeof r.error === 'string' ? r.error : JSON.stringify(r.error)}`);
  };
  const from = w.position !== null && w.slots[w.position] !== undefined ? canonicalFilter(w.slots[w.position]) : null;
  const to = canonicalFilter(w.slots[i]);
  const follow = followers.get(scope);
  if (follow && o.keepFocus !== false && from && from !== 'dark' && to !== 'dark') {
    const r = await follow(from, to, change);
    return { filter: w.slots[i], wheelPosition: i, changed: true, ...(r.line ? { focus: r.line } : {}) };
  }
  await change();
  await sleep(WHEEL_SETTLE_MS);
  return { filter: w.slots[i], wheelPosition: i, changed: true };
}
