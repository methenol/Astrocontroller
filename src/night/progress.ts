/**
 * What has been collected so far, per target, and what the journal has learned about the rig.
 *
 * The library is the record of what was collected (sessions transferred off the scope, counted
 * from their kept subs, library/sessions.ts): a session the owner deleted from it, or subs they
 * threw out, no longer count, and the plan goes back to collecting them. The journal (what the
 * scope stacked, recorded live) only stands in for the night in progress, whose sessions are still
 * on the scope until the end-of-night transfer: without it a target that reached its goal tonight
 * would be planned again at the next replan. Every earlier night is the library's alone.
 *
 * Only this profile's telescope counts (its library holds its own sessions; one migrated from the
 * shared root can still hold the other maker's), and with a filter wanted for a target, only what
 * was shot through it: a target asked for in Duo-Band has collected nothing towards it from an
 * Astro night. The library knows every session's filter (sessions.ts sessionFilter); the journal
 * knows the Seestar's but not the Dwarf's, so tonight's journal session with no filter counts
 * towards a filter goal (it is the only record there is yet).
 *
 * The learned numbers close the loop: a GoTo plus focus that takes 9 minutes at this site, or a
 * stacker that keeps 70 % of the wall time, makes the plan's blocks honest about what they yield.
 */
import { captureLog } from '../library/sessions.js';
import { targetKey } from '../astro/rest.js';
import type { Journal } from './journal.js';
import { journalNight, nightOfStamp } from './clock.js';
import { config } from '../config.js';
import { sameFilter } from '../astro/acquisition/devices.js';

export interface Collected {
  /** minutes of integration, all nights */
  totalMin: number;
  libraryMin: number;
  /** minutes only the journal knows of (tonight's, not transferred yet) */
  journalOnlyMin: number;
  nights: number;
  lastNight: string | null;
  /** per night, minutes */
  byNight: Record<string, number>;
}

export interface Learned {
  /** minutes from the GoTo to stacking (slew, centring, focus) */
  overheadMin: number;
  /** integration per minute of stacking */
  efficiency: number;
  /** how many sessions they were learned from (0 = defaults) */
  samples: number;
  /** whether each is learned from the journal (enough sessions) or still the default */
  overheadLearned?: boolean;
  efficiencyLearned?: boolean;
}

/** Without a journal to learn from. */
export const LEARNED_DEFAULTS: Learned = { overheadMin: 8, efficiency: 0.75, samples: 0 };
const MIN_SAMPLES = 3;
const LEARN_FROM = 40;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface CollectedOptions {
  nights?: number;
  /** the filter wanted for a target key ("auto" or none: every filter counts) */
  filterOf?: (key: string) => string | undefined;
  /** the maker whose library sessions count (default: this process's telescope); null = every one */
  device?: 'dwarf' | 'seestar' | null;
  /** the night in progress (journal night key), the only one the journal counts (default: now's) */
  tonight?: string;
}

/** Per target key (rest.targetKey), minutes collected per night: the library's, and tonight's from the journal until it is transferred. */
export function collected(journal: Pick<Journal, 'recentSessions'> | null, opts: CollectedOptions = {}): Map<string, Collected> {
  const wanted = (key: string) => {
    const f = opts.filterOf?.(key);
    return f && f !== 'auto' ? f : undefined;
  };
  const device = opts.device === undefined ? config.telescope.driver : opts.device;
  const tonight = opts.tonight ?? journalNight(Date.now());
  const lib = new Map<string, Map<string, number>>();
  for (const c of captureLog()) {
    const night = c.startedAt ? nightOfStamp(c.startedAt) : null;
    if (!night) continue;
    if (device && c.device && c.device !== device) continue;
    const key = targetKey(c.target);
    const want = wanted(key);
    if (want && !sameFilter(c.filter, want)) continue;
    const m = lib.get(key) ?? new Map<string, number>();
    m.set(night, (m.get(night) ?? 0) + c.integrationS / 60);
    lib.set(key, m);
  }
  const jour = new Map<string, Map<string, number>>();
  for (const s of journal?.recentSessions(opts.nights ?? 3650) ?? []) {
    // an earlier night is in the library, or is not collected any more
    if (s.night !== tonight || !s.stats.integrationS) continue;
    const key = targetKey(s.target);
    const want = wanted(key);
    if (want && s.stats.filter && !sameFilter(s.stats.filter, want)) continue;
    const m = jour.get(key) ?? new Map<string, number>();
    m.set(s.night, (m.get(s.night) ?? 0) + s.stats.integrationS / 60);
    jour.set(key, m);
  }
  const out = new Map<string, Collected>();
  for (const key of new Set([...lib.keys(), ...jour.keys()])) {
    const l = lib.get(key) ?? new Map<string, number>();
    const j = jour.get(key) ?? new Map<string, number>();
    const byNight: Record<string, number> = {};
    let total = 0;
    let libraryMin = 0;
    let journalOnly = 0;
    for (const n of new Set([...l.keys(), ...j.keys()])) {
      const a = l.get(n) ?? 0;
      const b = j.get(n) ?? 0;
      const v = Math.max(a, b);
      byNight[n] = Math.round(v);
      total += v;
      libraryMin += a;
      if (b > a) journalOnly += b - a;
    }
    const nights = Object.keys(byNight).sort();
    out.set(key, { totalMin: Math.round(total), libraryMin: Math.round(libraryMin), journalOnlyMin: Math.round(journalOnly), nights: nights.length, lastNight: nights[nights.length - 1] ?? null, byNight });
  }
  return out;
}

/** The rig's switch overhead and stacking efficiency from recent sessions. */
export function learn(journal: Pick<Journal, 'recentSessions'> | null): Learned {
  const sessions = (journal?.recentSessions(30) ?? []).slice(0, LEARN_FROM);
  const overheads: number[] = [];
  const effs: number[] = [];
  for (const s of sessions) {
    // a session opened on a target the scope was already sent to has no GoTo mark: it counts from its start
    const began = s.marks.find((m) => m.kind === 'goto-start')?.at ?? s.startedAt;
    const firstStack = s.marks.find((m) => m.kind === 'stack-start')?.at;
    if (firstStack && firstStack > began) {
      const min = (firstStack - began) / 60e3;
      if (min > 0.5 && min < 60) overheads.push(min);
    }
    if (s.stats.efficiencyPct && s.stats.stackS && s.stats.stackS > 15 * 60) effs.push(s.stats.efficiencyPct / 100);
  }
  return {
    overheadMin: overheads.length >= MIN_SAMPLES ? Math.round(median(overheads) * 10) / 10 : LEARNED_DEFAULTS.overheadMin,
    efficiency: effs.length >= MIN_SAMPLES ? Math.round(Math.max(0.2, Math.min(1, median(effs))) * 100) / 100 : LEARNED_DEFAULTS.efficiency,
    samples: Math.min(overheads.length, effs.length),
    overheadLearned: overheads.length >= MIN_SAMPLES,
    efficiencyLearned: effs.length >= MIN_SAMPLES,
  };
}
