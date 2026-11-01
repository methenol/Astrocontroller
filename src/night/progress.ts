/**
 * What has been collected so far, per target, and what the journal has learned about the rig.
 *
 * Two records of a capture exist: the library (sessions transferred off the scope, counted from
 * their kept subs, library/sessions.ts) and the journal (what the scope stacked, recorded live).
 * A night not transferred yet is only in the journal; a night shot before the journal existed is
 * only in the library; a night in both is counted once, from whichever saw more of it.
 *
 * The learned numbers close the loop: a GoTo plus focus that takes 9 minutes at this site, or a
 * stacker that keeps 70 % of the wall time, makes the plan's blocks honest about what they yield.
 */
import { captureLog } from '../library/sessions.js';
import { targetKey } from '../astro/rest.js';
import type { Journal } from './journal.js';
import { nightOfStamp } from './clock.js';

export interface Collected {
  /** minutes of integration, all nights */
  totalMin: number;
  libraryMin: number;
  /** minutes only the journal knows of (not transferred yet) */
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

/** Per target key (rest.targetKey), minutes collected per night from both records. */
export function collected(journal: Pick<Journal, 'recentSessions'> | null, opts: { nights?: number } = {}): Map<string, Collected> {
  const lib = new Map<string, Map<string, number>>();
  for (const c of captureLog()) {
    const night = c.startedAt ? nightOfStamp(c.startedAt) : null;
    if (!night) continue;
    const key = targetKey(c.target);
    const m = lib.get(key) ?? new Map<string, number>();
    m.set(night, (m.get(night) ?? 0) + c.integrationS / 60);
    lib.set(key, m);
  }
  const jour = new Map<string, Map<string, number>>();
  for (const s of journal?.recentSessions(opts.nights ?? 3650) ?? []) {
    const night = s.night;
    if (!night || !s.stats.integrationS) continue;
    const key = targetKey(s.target);
    const m = jour.get(key) ?? new Map<string, number>();
    m.set(night, (m.get(night) ?? 0) + s.stats.integrationS / 60);
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
    const firstGoto = s.marks.find((m) => m.kind === 'goto-start')?.at;
    const firstStack = s.marks.find((m) => m.kind === 'stack-start')?.at;
    if (firstGoto && firstStack && firstStack > firstGoto) {
      const min = (firstStack - firstGoto) / 60e3;
      if (min > 0.5 && min < 60) overheads.push(min);
    }
    if (s.stats.efficiencyPct && s.stats.stackS && s.stats.stackS > 15 * 60) effs.push(s.stats.efficiencyPct / 100);
  }
  return {
    overheadMin: overheads.length >= MIN_SAMPLES ? Math.round(median(overheads) * 10) / 10 : LEARNED_DEFAULTS.overheadMin,
    efficiency: effs.length >= MIN_SAMPLES ? Math.round(Math.max(0.2, Math.min(1, median(effs))) * 100) / 100 : LEARNED_DEFAULTS.efficiency,
    samples: Math.min(overheads.length, effs.length),
  };
}
