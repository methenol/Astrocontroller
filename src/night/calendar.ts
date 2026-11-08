/**
 * The Calendar tab: for each target the coming year of nights, how many hours each is up and clear
 * of the Moon, which nights are its optimal ones, and whether the integration still wanted fits in
 * the time it has left.
 *
 * A night "can collect" with at least the plan's shortest block above the limit, inside the plan's
 * window. It is "optimal" with at least OPTIMAL_FRACTION of the target's longest night of the year
 * (the rule season.ts reads best months with). Expected hours use the night plan's season factors
 * (solver.ts): a target's share of a night, and the fraction of nights that turn out clear. Each
 * target is worked out on its own, so two targets cannot both really have the same night's share.
 *
 * The per-night tables are geometry and the Moon: they hold for the whole night, so they are kept
 * until the night or the plan's settings change. What has been collected is read fresh every time.
 */
import { config, planDefaults } from '../config.js';
import * as sky from '../astro/sky.js';
import { findObject, displayName, gotoLabel, type DsoObject } from '../astro/catalog.js';
import { queryCatalog, type CatalogQuery } from '../astro/catalog-search.js';
import { chooseGlass } from '../astro/planner.js';
import { classifyFilter } from '../astro/detect.js';
import { targetKey, restSettings } from '../astro/rest.js';
import type { Horizon } from '../astro/horizon.js';
import { planWindow, nightKey } from './clock.js';
import { loadProgram, type PlanSettings, type ProgramTarget } from './program.js';
import type { Collected } from './progress.js';
import { CLEAR_NIGHTS, daysFromFull, MOON_HORIZON, moonFactor, moonRequiredSep, NIGHT_SHARE } from './solver.js';

const DAY_MS = 86_400e3;
const SLOT_MS = 15 * 60e3;
const NIGHTS = 365;
/** the nights sent to the page; the rest of the year only feeds the windows */
const SHOWN_NIGHTS = 180;
const OPTIMAL_FRACTION = 0.8;
/** a break this short does not end a window */
const GAP_NIGHTS = 3;
/** the hours of one night that count towards what a target can expect */
const MAX_HOURS_PER_NIGHT = 6;
const CLOSING_NIGHTS = 30;
const OPENING_NIGHTS = 120;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const PINNED_LIMIT = 200;
/** with no goal to decide it by, the glass is chosen for a half-lit Moon */
const SEASON_MOON = 0.5;
const YIELD_EVERY = 8;

export type NightRun = [number, number];
export type CalendarGroup = 'closing' | 'peak' | 'opening' | 'later';
export type CalendarVerdict = 'done' | 'on-track' | 'tight' | 'short' | 'no-window' | 'no-goal';

interface SkyNight {
  date: string;
  start: number;
  end: number;
  hours: number;
  moonPercent: number;
  moon: Array<{ raHours: number; decDeg: number; alt: number }>;
}

export interface WindowSummary {
  optimal: { current: NightRun | null; next: NightRun | null; runs: NightRun[] };
  collectable: { current: NightRun | null; next: NightRun | null };
  group: CalendarGroup;
  /** nights until this target's next change of state */
  deadline: number | null;
  needH: number;
  expectedOptimalH: number;
  expectedTotalH: number;
  verdict: CalendarVerdict;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const pause = () => new Promise<void>((r) => setImmediate(r));

/** Closes breaks of at most `gap` nights inside a run; the ends of the year stay open. */
export function closeGaps(flags: boolean[], gap = GAP_NIGHTS): boolean[] {
  const out = [...flags];
  for (let i = 0; i < out.length; ) {
    if (out[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !out[j]) j++;
    if (i > 0 && j < out.length && j - i <= gap) out.fill(true, i, j);
    i = j;
  }
  return out;
}

/** The [first, last] night of each run. */
export function nightRuns(flags: boolean[]): NightRun[] {
  const runs: NightRun[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}

/**
 * A target's windows and outlook from its hours per night: `up` above the limit, `clear` of those
 * also workable with the Moon. Night 0 is tonight.
 */
export function summarizeWindows(up: number[], clear: number[], o: { minBlockH: number; goalMin: number; collectedMin: number; efficiency: number }): WindowSummary {
  const peak = Math.max(0, ...up);
  const can = closeGaps(up.map((h) => h >= o.minBlockH));
  const opt = closeGaps(up.map((h) => h >= o.minBlockH && h >= OPTIMAL_FRACTION * peak));
  const canRuns = nightRuns(can);
  const optRuns = nightRuns(opt);
  const canNow = canRuns.find((r) => r[0] === 0) ?? null;
  const canNext = canRuns.find((r) => r[0] > 0) ?? null;
  const optNow = optRuns.find((r) => r[0] === 0) ?? null;
  const optNext = optRuns.find((r) => r[0] > 0) ?? null;

  const span = canNow ?? canNext;
  const perNight = (i: number) => Math.min(clear[i], MAX_HOURS_PER_NIGHT) * o.efficiency * NIGHT_SHARE * CLEAR_NIGHTS;
  let total = 0;
  let optimal = 0;
  if (span) {
    for (let i = span[0]; i <= span[1]; i++) {
      total += perNight(i);
      if (opt[i]) optimal += perNight(i);
    }
  }
  const needH = Math.max(0, o.goalMin - o.collectedMin) / 60;
  let verdict: CalendarVerdict;
  if (o.goalMin <= 0) verdict = 'no-goal';
  else if (needH <= 0) verdict = 'done';
  else if (!span) verdict = 'no-window';
  else verdict = needH <= total * 0.5 ? 'on-track' : needH <= total ? 'tight' : 'short';

  // before its best nights a usable target is on its way in; after them, on its way out
  const rising = !optNow && !!optNext && !!canNow && optNext[0] <= canNow[1];
  let group: CalendarGroup;
  let deadline: number | null;
  if (optNow && optNow[1] <= CLOSING_NIGHTS) [group, deadline] = ['closing', optNow[1]];
  else if (optNow) [group, deadline] = ['peak', optNow[1]];
  else if (canNow && !rising) [group, deadline] = ['closing', canNow[1]];
  else if (rising) [group, deadline] = ['opening', optNext![0]];
  else if (canNext && canNext[0] <= OPENING_NIGHTS) [group, deadline] = ['opening', canNext[0]];
  else [group, deadline] = ['later', canNext?.[0] ?? null];

  return {
    optimal: { current: optNow, next: optNext, runs: optRuns },
    collectable: { current: canNow, next: canNext },
    group,
    deadline,
    needH: r1(needH),
    expectedOptimalH: r1(optimal),
    expectedTotalH: r1(total),
    verdict,
  };
}

async function skyNights(site: sky.Site, settings: PlanSettings, tz: string, from: number): Promise<SkyNight[]> {
  const nights: SkyNight[] = [];
  for (let d = 0; d < NIGHTS; d++) {
    if (d % 30 === 29) await pause();
    const w = planWindow(site, new Date(from + d * DAY_MS), settings, tz);
    const start = w.start.getTime();
    const end = w.end.getTime();
    const moon: SkyNight['moon'] = [];
    for (let t = start; t < end; t += SLOT_MS) {
      const when = new Date(t);
      const p = sky.bodyRaDec(site, 'Moon', when);
      moon.push({ raHours: p.raHours, decDeg: p.decDeg, alt: sky.bodyAlt(site, 'Moon', when) });
    }
    const hours = (end - start) / 3600e3;
    nights.push({ date: w.night, start, end, hours: r1(hours), moonPercent: Math.round(sky.moonState(site, new Date((start + end) / 2)).illuminationPercent), moon });
  }
  return nights;
}

interface HoursInput {
  raHours: number;
  decDeg: number;
  narrowband: boolean;
  minAltitude?: number;
}

function nightHours(t: HoursInput, nights: SkyNight[], site: sky.Site, settings: PlanSettings, horizon?: Horizon): { up: number[]; clear: number[] } {
  const rule = t.narrowband ? settings.moonNarrowband : settings.moonBroadband;
  const up: number[] = [];
  const clear: number[] = [];
  for (const n of nights) {
    const required = moonRequiredSep(rule, daysFromFull(n.moonPercent / 100));
    let upH = 0;
    let clearH = 0;
    n.moon.forEach((m, i) => {
      const at = n.start + i * SLOT_MS;
      const aa = sky.altAz(site, t.raHours, t.decDeg, new Date(at));
      if (aa.altitude < Math.max(settings.minAltitude, t.minAltitude ?? 0, horizon ? horizon.limit(aa.azimuth) : 0)) return;
      const h = Math.min(SLOT_MS, n.end - at) / 3600e3;
      upH += h;
      if (!settings.moonAvoidance || m.alt <= MOON_HORIZON || moonFactor(sky.separationDeg(t.raHours, t.decDeg, m.raHours, m.decDeg), required, 1) > 0) clearH += h;
    });
    up.push(r1(upH));
    clear.push(r1(clearH));
  }
  return { up, clear };
}

// One night's tables. A new night or a changed setting starts a new cache.
let cache: { key: string; nights: Promise<SkyNight[]>; hours: Map<string, { up: number[]; clear: number[] }> } | null = null;

function cacheFor(site: sky.Site, settings: PlanSettings, tz: string, horizon: Horizon | undefined, now: number) {
  const key = JSON.stringify([
    nightKey(site, new Date(now), tz),
    site,
    settings.windowStart,
    settings.windowEnd,
    settings.startOffsetMin,
    settings.endOffsetMin,
    settings.minAltitude,
    settings.moonAvoidance,
    settings.moonBroadband,
    settings.moonNarrowband,
    horizon ? Array.from({ length: 72 }, (_, i) => horizon.limit(i * 5)) : null,
  ]);
  if (cache?.key !== key) cache = { key, nights: skyNights(site, settings, tz, now), hours: new Map() };
  return cache;
}

const narrowbandOf = (o: DsoObject | null, filter: string | undefined): boolean => {
  if (filter && filter !== 'auto') return classifyFilter(filter) !== 'broadband';
  if (!o) return false;
  const d = planDefaults();
  const filters = d.filter ? [d.filter] : d.filters.length ? d.filters : ['none'];
  return classifyFilter(chooseGlass(o, { filters, bortle: d.bortle, moonStrength: SEASON_MOON }).filter) !== 'broadband';
};

export interface CalendarOptions {
  site: sky.Site;
  settings: PlanSettings;
  horizon?: Horizon;
  efficiency: number;
  progress: Map<string, Collected>;
  filters: CatalogQuery;
  programOnly?: boolean;
  teleFovWidthArcmin?: number;
  limit?: number;
  now?: number;
  tz?: string;
}

const hasFilter = (f: CatalogQuery) => Object.values(f).some((v) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length));

/** Everything the Calendar tab shows. */
export async function buildCalendar(o: CalendarOptions) {
  const tz = o.tz ?? config.observer.timezone;
  const now = o.now ?? Date.now();
  const { site, settings, progress, filters } = o;
  const c = cacheFor(site, settings, tz, o.horizon, now);
  const nights = await c.nights;
  const generalGoalMin = restSettings().integrationTargetMin;
  const program = loadProgram();
  const programOf = new Map<string, ProgramTarget>(program.map((t) => [targetKey(t.name), t]));
  const catalogOpts = { teleFovWidthArcmin: o.teleFovWidthArcmin };
  const search = (q: CatalogQuery) => queryCatalog(q, site, tz, catalogOpts);

  // the program and what is already under way come first, then the catalog's best matches
  const pinnedIds = new Set<string>();
  for (const key of [...programOf.keys(), ...(o.programOnly ? [] : progress.keys())]) {
    const obj = findObject(key);
    if (obj) pinnedIds.add(obj.id);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(o.limit ?? DEFAULT_LIMIT)));
  const pinned = pinnedIds.size ? search({ ...filters, ids: pinnedIds, limit: PINNED_LIMIT }).items : [];
  const top = o.programOnly ? null : search({ ...filters, limit });
  const objects = new Map<string, DsoObject>();
  for (const row of [...pinned, ...(top?.items ?? [])]) {
    const obj = findObject(row.id);
    if (obj) objects.set(obj.id, obj);
  }

  let count = 0;
  const make = async (input: { key: string; object: DsoObject | null; entry?: ProgramTarget; name: string; display: string; gotoName: string; raHours: number; decDeg: number }) => {
    if (++count % YIELD_EVERY === 0) await pause();
    const { key, object, entry } = input;
    const narrowband = narrowbandOf(object, entry?.filter);
    const hoursKey = `${input.raHours}|${input.decDeg}|${narrowband}|${entry?.minAltitude ?? ''}`;
    let hours = c.hours.get(hoursKey);
    if (!hours) {
      hours = nightHours({ raHours: input.raHours, decDeg: input.decDeg, narrowband, minAltitude: entry?.minAltitude }, nights, site, settings, o.horizon);
      c.hours.set(hoursKey, hours);
    }
    const got = progress.get(key);
    const goalMin = entry ? entry.goalMin : generalGoalMin;
    const collectedMin = got?.totalMin ?? 0;
    const summary = summarizeWindows(hours.up, hours.clear, { minBlockH: settings.minBlockMin / 60, goalMin, collectedMin, efficiency: o.efficiency });
    return {
      key,
      name: input.name,
      displayName: input.display,
      gotoName: input.gotoName,
      catalogId: object?.id ?? null,
      raHours: input.raHours,
      decDeg: input.decDeg,
      typeName: object?.typeName ?? 'custom position',
      constellation: object?.constellation ?? null,
      mag: object?.mag ?? null,
      majorArcmin: object?.majorArcmin ?? null,
      aliases: object?.aliases.slice(0, 4) ?? [],
      inProgram: !!entry,
      enabled: entry?.enabled ?? true,
      priority: entry?.priority ?? null,
      goalMin,
      goalSource: entry ? 'program' : 'general',
      collectedMin,
      collectedNights: got?.nights ?? 0,
      altitudeNow: Math.round(sky.altAz(site, input.raHours, input.decDeg, new Date(now)).altitude),
      up: hours.up.slice(0, SHOWN_NIGHTS),
      clear: hours.clear.slice(0, SHOWN_NIGHTS),
      ...summary,
    };
  };

  const targets: Array<Awaited<ReturnType<typeof make>>> = [];
  const done = new Set<string>();
  for (const t of program) {
    const key = targetKey(t.name);
    const object = findObject(t.name);
    // a custom position has none of the catalog's fields to filter on
    if (object ? !objects.has(object.id) : hasFilter(filters)) continue;
    done.add(object?.id ?? key);
    targets.push(await make({ key, object, entry: t, name: t.name, display: t.displayName, gotoName: t.gotoName, raHours: t.raHours, decDeg: t.decDeg }));
  }
  for (const object of objects.values()) {
    if (done.has(object.id)) continue;
    targets.push(await make({ key: targetKey(object.id), object, name: object.id, display: displayName(object), gotoName: gotoLabel(object), raHours: object.raHours, decDeg: object.decDeg }));
  }

  return {
    generatedAt: now,
    minAltitude: settings.minAltitude,
    minBlockMin: settings.minBlockMin,
    efficiency: o.efficiency,
    generalGoalMin,
    catalogTotal: top?.total ?? null,
    limit,
    nights: nights.slice(0, SHOWN_NIGHTS).map((n) => ({ date: n.date, hours: n.hours, moonPercent: n.moonPercent })),
    targets,
  };
}
