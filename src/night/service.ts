/**
 * The night plan as a service that runs for weeks: it keeps tonight's schedule solved
 * (night/solver.ts) and fresh, for the Plan tab, the agent's night_plan tool and every duty sample.
 *
 * - A new night is solved when it is first asked for, and at the latest in the afternoon before it.
 * - During the night the rest of it is solved again when something it was solved from changes: the
 *   forecast was refetched, a session ended (what is collected moved), a hold was set or ran out,
 *   the program or the settings were edited; and every half hour regardless. What is past is kept
 *   as it was planned, so the Plan tab shows the night as a whole.
 * - The target being worked is locked to the end of its block: a re-solve plans around it. Only a
 *   hold on it (obscured, a sky hold, a skip), a pin, its goal or its leaving the sky ends that early.
 * - Holds are the plan's say from the night itself: a target obscured (by a tree or a cloud: a
 *   filler takes its place until it clears), skipped for the night, pinned to a time, or a part of
 *   the sky out for a while.
 * - The plan never starts a duty by itself: the owner starts it (the Plan tab's run, the duty bar),
 *   or Starfront's autonomous nights do when the roof opens (agent/starfront.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, planDefaults } from '../config.js';
import { errMsg, logger } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';
import { SafeEmitter } from '../util/events.js';
import * as sky from '../astro/sky.js';
import * as weather from '../astro/weather.js';
import { findObject, displayName, gotoLabel } from '../astro/catalog.js';
import { planNight, chooseGlass, framing } from '../astro/planner.js';
import { subPlan } from '../astro/exposure.js';
import { classifyFilter, moonlitKeep, detectFor, seeingSensitivity } from '../astro/detect.js';
import { horizonFor, type Horizon } from '../astro/horizon.js';
import { recordBlocked, clearsAt } from '../astro/sightings.js';
import { targetKey, loadRest, restSettings, restState } from '../astro/rest.js';
import type { HourConditions } from '../astro/weather.js';
import { addTarget, loadProgram, loadSettings, type PlanSettings, type ProgramTarget } from './program.js';
import { planWindow, nightKey, hm, dur, type PlanWindow } from './clock.js';
import { buildCalendar, type CalendarOptions } from './calendar.js';
import { solveNight, alternatesAt, rankCandidates, quadrantOf, SLOT_MIN, type Block, type BlockTarget, type Candidate, type Hold, type Quadrant, type Solved, type Alternate, type SolveInput, type TargetAdvice } from './solver.js';
import { collected, learn, type Learned } from './progress.js';
import { adviseFor, targetInfo, type FactsSource, type LiveFacts } from '../astro/acquisition/index.js';
import type { Journal, JournalSession } from './journal.js';

const log = logger('plan');

const TICK_MS = 60_000;
/** the rest of the night is solved again at least this often while it lasts */
const REFRESH_MS = 30 * 60_000;
/** a session ending, a hold, an edit: solved again this long after (a burst is one solve) */
const DEBOUNCE_MS = 5_000;
/** the next night is solved from this local hour */
const PREPARE_HOUR = 12;
/** the night counts as under way this long before the plan starts (time to open the arm and connect) */
const LEAD_MS = 15 * 60_000;
/** an obscured target with no end given is held this long when it is setting or the cause is cloud */
const HOLD_DEFAULT_MIN = 45;
/** an obstruction's top is taken to be this much above where the target was seen blocked */
const CLEAR_RISE_DEG = 4;
/** the azimuth half-width an obstruction hold covers at the horizon (it widens with 1/cos alt, as a frame does) */
const OBSTRUCTION_AZ_HALF_DEG = 3;
const OBSTRUCTION_AZ_MAX_DEG = 12;
/** an obstruction hold is not ended by its own clear check sooner than this (the target was just seen blocked) */
const HOLD_MIN_MS = 10 * 60_000;
/** catalog targets the fillers (and Find targets) are drawn from */
const FILLER_POOL = 120;
/** a catalog target with at least this much integration counts as started: it is finished before new ones begin */
const FILLER_STARTED_MIN = 10;
/** refocus once the forecast temperature has moved this much since the last focus, or after this long */
const REFOCUS_DELTA_C = 2;
const REFOCUS_MAX_MIN = 120;
/** the stack is flagged when, over the last REJECT_WINDOW_MIN, more than this fraction of at least REJECT_MIN_FRAMES frames was rejected */
const REJECT_WINDOW_MIN = 15;
const REJECT_FLAG = 0.5;
const REJECT_MIN_FRAMES = 6;
const NIGHTS_KEPT = 90;
/** re-solves nothing about the night has really changed for: the next block's target keeps its place by the switch margin */
const ROUTINE_REASONS = new Set(['the forecast was updated', 'half-hourly refresh', 'a session ended']);

export interface PlannedNight extends Solved {
  night: string;
  generatedAt: number;
  reason: string;
  window: { start: number; end: number };
  twilight: { sunset: number | null; astroDusk: number | null; astroDawn: number | null; sunrise: number | null };
  moon: Solved['moon'] & { phase: string };
  learned: Learned & { overheadSource: 'settings' | 'journal' | 'default'; efficiencySource: 'settings' | 'journal' | 'default' };
  horizon: string | null;
  forecast: { fetchedAt: string | null; stale: boolean } | null;
  holds: Hold[];
  totals: { programMin: number; fillerMin: number; gapMin: number; weatherMin: number };
}

interface NightFile {
  plan: PlannedNight | null;
  holds: Hold[];
  /** the target being worked, and until when it stays */
  lock?: { key: string; until: number } | null;
}

/**
 * What each target has collected towards its goal: through the filter the owner set for it in the
 * program (an Astro night does not count towards a Duo-Band goal); a target on "auto", and a
 * filler, counts every filter.
 */
function programProgress(journal: Journal | null): ReturnType<typeof collected> {
  const filters = new Map<string, string>();
  for (const t of loadProgram()) {
    const key = targetKey(t.name);
    if (t.filter && t.filter !== 'auto' && !filters.has(key)) filters.set(key, t.filter);
  }
  return collected(journal, { filterOf: (key) => filters.get(key) });
}

/** The catalog filter of fillers and suggestions (unset fields: the plan settings'). */
export interface TargetFilter {
  types?: string[];
  minFovPercent?: number;
  maxMagnitude?: number;
  minSizeArcmin?: number;
  maxSizeArcmin?: number;
}

export interface NowView {
  night: string;
  phase: 'before' | 'night' | 'after';
  at: number;
  block: Block | null;
  next: Block | null;
  minutesLeft: number | null;
  /** what the scope is on now, from the journal */
  scopeOn: string | null;
  onPlan: boolean | null;
  instruction: string;
}

export interface PlanDeps {
  site: () => sky.Site | null;
  /** the tele field of view, arcminutes */
  fovArcmin: () => { w: number; h: number };
  journal: Journal;
  /** the session the journal is recording now */
  active?: () => { night: string; session: JournalSession } | null;
  /** told when the plan changes what the agent should do now (a duty event) */
  notify?: (text: string) => void;
  now?: () => number;
  dir?: string;
  /** what the scope says about itself, for the capture settings of each block (acquisition planner) */
  facts?: FactsSource;
  /** the forecast, for tests */
  conditions?: () => Promise<((t: Date) => HourConditions | undefined) | null>;
  forecastStamp?: () => Promise<{ fetchedAt: string; stale: boolean } | null>;
}

/** Goals to start from, minutes: a cluster is bright, an easy target wants a couple of hours, a faint one many. */
const GOAL_CLUSTER_MIN = 60;
const GOAL_EASY_MIN = 120;
const GOAL_FAINT_MIN = 300;
const GOAL_UNKNOWN_MIN = 180;
const CLUSTER_TYPES = new Set(['OCl', 'GCl', '*Ass']);
function goalFor(type: string | undefined, bucket: string): number {
  if (type && CLUSTER_TYPES.has(type)) return GOAL_CLUSTER_MIN;
  return bucket === 'EASY' ? GOAL_EASY_MIN : bucket === 'NEEDS_INTEG' || bucket === 'SKIP_TONIGHT' ? GOAL_FAINT_MIN : GOAL_UNKNOWN_MIN;
}
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const azDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

export const PLAN_OBJECTIVE = [
  "Carry out tonight's night plan (the Plan tab) until its end, maximising integration on the owner's program targets.",
  "1. Every sample shows the plan's current block. Be on that target: goto_target name=<its goto name>, autofocus, star_focus, start_stacking. Nothing is stacked before the plan starts; before that, get ready (connect, open the arm).",
  '2. When the plan moves to the next block, stop_stacking and move to its target the same way. Follow the plan rather than choosing targets yourself; night_plan action=now says what to do at any time. The target you are working is locked to the end of its block: forecast updates and re-solves plan around it.',
  '3. If the target is blocked (tele_visibility, view_camera) or clouded, tell the plan: night_plan action=obscured target=<name> cause=obstruction|cloud, then go to the target it gives. night_plan action=alternates lists other parts of the sky; a cloud bank in one direction: night_plan action=sky_hold quadrant=N|E|S|W minutes=<n>.',
  '4. Record what matters for the owner in the journal (journal action=note): why a target was left, focus or tracking trouble, what you saw.',
  '5. At the end of the duty: stop stacking, park, and transfer the night\'s sessions that are not in the library yet.',
].join('\n');

export class PlanService extends SafeEmitter {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, NightFile>();
  private readonly now: () => number;
  private readonly dir: string;
  private lastForecast: string | null = null;
  private lastBlockId: string | null = null;
  /** the forecast lookup of the last solve, for the duty samples' temperature checks */
  private lastConditions: ((t: Date) => HourConditions | undefined) | null = null;
  private readonly onSession = () => this.soon('a session ended');

  constructor(private readonly d: PlanDeps) {
    super();
    this.now = d.now ?? Date.now;
    this.dir = d.dir ?? path.join(config.paths.data, 'plan', 'nights');
  }

  start(): void {
    if (this.timer) return;
    this.d.journal.on('session', this.onSession);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 3_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
    this.d.journal.off('session', this.onSession);
  }

  // ---------------------------------------------------------------- persistence
  private file(night: string): string {
    return path.join(this.dir, `${night}.json`);
  }

  private load(night: string): NightFile {
    const hit = this.cache.get(night);
    if (hit) return hit;
    let f: NightFile = { plan: null, holds: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(night), 'utf8')) as Partial<NightFile>;
      const plan = raw.plan ?? null;
      // blocks outside the plan's own window (another night's, filed here by mistake) are dropped
      if (plan) plan.blocks = plan.blocks.filter((b) => b.end > plan.window.start && b.start < plan.window.end);
      f = { plan, holds: Array.isArray(raw.holds) ? raw.holds : [], lock: raw.lock ?? null };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${this.file(night)}: ${errMsg(e)}`);
    }
    this.cache.set(night, f);
    return f;
  }

  private save(night: string): void {
    const f = this.cache.get(night);
    if (!f) return;
    try {
      writeFileAtomic(this.file(night), JSON.stringify(f));
      const keys = fs.readdirSync(this.dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - NIGHTS_KEPT))) fs.rmSync(path.join(this.dir, k), { force: true });
    } catch (e) {
      log.warn(`could not save the plan of ${night}: ${errMsg(e)}`);
    }
  }

  // ---------------------------------------------------------------- the night
  private site(): sky.Site {
    const s = this.d.site();
    if (!s) throw new Error('the observer location is not known (OBSERVER_LAT/OBSERVER_LON in .env, or the telescope reports one)');
    return s;
  }

  /** The night the plan is about now: tonight's, or (by day) the coming one. */
  currentNight(): { night: string; window: PlanWindow } {
    const site = this.site();
    const window = planWindow(site, new Date(this.now()), loadSettings());
    return { night: window.night, window };
  }

  /** Tonight's plan, solved first when there is none yet. */
  async plan(): Promise<PlannedNight> {
    const { night } = this.currentNight();
    const f = this.load(night);
    if (f.plan) return f.plan;
    return this.replan('first look at the night');
  }

  /** The plan of a night already solved (null if it never was). */
  planOf(night: string): PlannedNight | null {
    return this.load(night).plan;
  }

  /** Solve the night again from now (from its start, by day); serialized. */
  replan(reason: string): Promise<PlannedNight> {
    const run = this.chain.then(() => this.solve(reason));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private soon(reason: string): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.replan(reason).catch((e) => log.warn(`replan (${reason}): ${errMsg(e)}`));
    }, DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  private async conditions(): Promise<((t: Date) => HourConditions | undefined) | null> {
    if (this.d.conditions) return this.d.conditions();
    return weather.conditionsAt(this.site(), config.observer.timezone);
  }

  /** What the scope says about itself (null without a driver's source or when it fails). */
  private async facts(): Promise<(Partial<LiveFacts> & { driver: LiveFacts['driver'] }) | null> {
    return this.d.facts ? this.d.facts().catch((e) => (log.debug(`device facts: ${errMsg(e)}`), null)) : null;
  }

  private async forecastStamp(): Promise<{ fetchedAt: string; stale: boolean } | null> {
    if (this.d.forecastStamp) return this.d.forecastStamp();
    try {
      const f = await weather.forecast(this.site(), config.observer.timezone);
      return { fetchedAt: f.fetchedAt, stale: f.stale };
    } catch {
      return null;
    }
  }

  /** The candidates of a night: the program's targets, then the catalog planner's best as fillers. */
  private candidates(site: sky.Site, w: PlanWindow, settings: PlanSettings, conditions: ((t: Date) => HourConditions | undefined) | null): { list: Candidate[]; excluded: NonNullable<SolveInput['excluded']> } {
    const defaults = planDefaults();
    const moonIllum = sky.moonState(site, new Date((w.start.getTime() + w.end.getTime()) / 2)).illuminationPercent / 100;
    const glassFilters = defaults.filter ? [defaults.filter] : defaults.filters.length ? defaults.filters : ['none'];
    const progress = programProgress(this.d.journal);
    const list: Candidate[] = [];
    const excluded: NonNullable<SolveInput['excluded']> = [];
    const program = loadProgram();
    // the owner's own say in the target memory (Tonight / Plan: snooze, don't suggest again); a capture's rest is the program's goal here
    const userRests = loadRest().filter((r) => r.role === 'snoozed' || r.role === 'done');
    const restDays = restSettings().restDays;
    for (const t of program) {
      const key = targetKey(t.name);
      const prog = progress.get(key);
      const got = prog?.totalMin ?? 0;
      const row = { key, programId: t.id, displayName: t.displayName, gotoName: t.gotoName, priority: t.priority, goalMin: t.goalMin, collectedMin: got };
      if (!t.enabled) {
        excluded.push({ ...row, status: 'disabled', reason: 'disabled in the program' });
        continue;
      }
      const rest = restState(t.name, w.night, userRests);
      if (rest) {
        excluded.push({ ...row, status: 'held', reason: rest.kind === 'done' ? 'marked "don\'t suggest again" (lift it in the Plan or Tonight tab)' : `snoozed until ${rest.until} (lift it in the Plan or Tonight tab)` });
        continue;
      }
      // collecting on past the goal: the target rest applies, counted from the night the goal was reached
      if (t.keepCollecting && got >= t.goalMin && prog) {
        let sum = 0;
        const reached = Object.keys(prog.byNight).sort().find((n) => (sum += prog.byNight[n]) >= t.goalMin);
        const until = reached ? addDays(reached, restDays) : null;
        if (until && w.night < until) {
          excluded.push({ ...row, status: 'held', reason: `goal met on ${reached}: resting until ${until} (target rest: ${restDays} days) before collecting more` });
          continue;
        }
      }
      if (t.notBefore && t.notBefore > w.night) {
        excluded.push({ ...row, status: 'waiting', reason: `waits until ${t.notBefore}` });
        continue;
      }
      list.push(this.programCandidate(t, key, got, glassFilters, moonIllum));
    }
    if (settings.fillers) {
      try {
        const have = new Set(list.map((c) => c.key));
        for (const c of this.fillerPool(site, w, settings, conditions).candidates) if (!have.has(c.key)) list.push(c);
      } catch (e) {
        log.warn(`fillers: ${errMsg(e)}`);
      }
    }
    return { list, excluded };
  }

  /**
   * The catalog targets the plan may fill free time with: the catalog planner's best for the plan's
   * window through the target filter (Find targets), as plan candidates. The plan's fillers and the
   * Find targets list are both this pool, ranked by the plan's own scoring, so they cannot disagree.
   */
  private fillerPool(site: sky.Site, w: PlanWindow, settings: PlanSettings, conditions: ((t: Date) => HourConditions | undefined) | null, filter?: TargetFilter) {
    const defaults = planDefaults();
    const glassFilters = defaults.filter ? [defaults.filter] : defaults.filters.length ? defaults.filters : ['none'];
    const moonIllum = sky.moonState(site, new Date((w.start.getTime() + w.end.getTime()) / 2)).illuminationPercent / 100;
    // what has integration towards a goal already: the owner's snoozes and "don't suggest again" still win
    const progress = programProgress(this.d.journal);
    const userRests = loadRest().filter((x) => x.role === 'snoozed' || x.role === 'done');
    const inProgram = new Set(loadProgram().map((t) => targetKey(t.name)));
    const restGoal = restSettings().integrationTargetMin;
    const started = new Set<string>();
    for (const [key, c] of progress) {
      if (inProgram.has(key) || c.totalMin < FILLER_STARTED_MIN || (restGoal && c.totalMin >= restGoal)) continue;
      if (!restState(key, w.night, userRests)) started.add(key);
    }
    const p = this.catalogPlan(site, w, settings, conditions, { limit: FILLER_POOL, filter, started });
    const candidates: Candidate[] = [];
    const rows = new Map<string, (typeof p.targets)[number]>();
    for (const r of p.targets) {
      if (r.gated) continue;
      const key = targetKey(r.name);
      if (rows.has(key)) continue;
      // the wider pool must not bring back what the owner rested
      if (restState(r.name, w.night, userRests)) continue;
      rows.set(key, r);
      const o = findObject(r.name);
      const f = String(r.suggestedFilter ?? '').split(' (')[0];
      const got = progress.get(key)?.totalMin ?? 0;
      const goal = restGoal || goalFor(o?.type, r.detectBucket);
      candidates.push({
        key,
        name: r.name,
        displayName: r.displayName,
        gotoName: r.gotoName,
        raHours: r.raHours,
        decDeg: r.decDeg,
        source: 'filler',
        fillerScore: r.score,
        ...(started.has(key) && got < goal ? { goalMin: goal, collectedMin: got } : {}),
        filter: f,
        narrowband: classifyFilter(f) !== 'broadband',
        moonKeep: o ? moonlitKeep(chooseGlass(o, { filters: glassFilters, bortle: defaults.bortle, moonStrength: moonIllum }).d, moonIllum) : 1 - 0.7 * moonIllum,
        type: r.type,
        seeingSens: seeingSensitivity(o?.type),
      });
    }
    return { candidates, rows, resting: p.resting, gated: p.targets.filter((r) => r.gated) };
  }

  /** The catalog planner over the plan's window, through the plan's target filter (fillers and suggestions). */
  private catalogPlan(site: sky.Site, w: PlanWindow, settings: PlanSettings, conditions: ((t: Date) => HourConditions | undefined) | null, o: { limit: number; filter?: TargetFilter; started: ReadonlySet<string> }) {
    const defaults = planDefaults();
    const f = o.filter ?? {};
    const types = f.types ?? settings.fillerTypes;
    return planNight(site, {
      start: w.start,
      end: w.end,
      now: new Date(this.now()),
      minAltitude: settings.minAltitude,
      types: types.length ? types : undefined,
      minFovPercent: (f.minFovPercent ?? settings.fillerMinFovPercent) || undefined,
      maxMagnitude: f.maxMagnitude ?? settings.fillerMaxMagnitude ?? undefined,
      minSizeArcmin: f.minSizeArcmin ?? settings.fillerMinSizeArcmin ?? undefined,
      maxSizeArcmin: f.maxSizeArcmin ?? settings.fillerMaxSizeArcmin ?? undefined,
      limit: o.limit,
      fovArcmin: this.d.fovArcmin(),
      timezone: config.observer.timezone,
      conditions: conditions ?? undefined,
      bortle: defaults.bortle,
      filter: defaults.filter || undefined,
      filters: defaults.filters,
      rig: defaults.rig,
      horizon: settings.useHorizon ? horizonFor(site) : undefined,
      started: o.started,
      spanNight: { blockMin: settings.minBlockMin },
    });
  }

  /**
   * Targets worth adding to the program, for tonight's window through a filter (types, frame fill,
   * magnitude, size): the catalog planner's ranking, without what the program already holds, with
   * a goal suggestion from the planner's integration advice.
   */
  async suggestions(filter: TargetFilter & { limit?: number } = {}): Promise<{ targets: Array<Record<string, unknown>>; resting: Array<{ name: string; displayName: string; penalty: number; reason: string }>; rest: ReturnType<typeof restSettings> }> {
    const now = this.now();
    const { input, w, settings } = await this.inputs(now);
    const site = input.site;
    const pool = this.fillerPool(site, w, settings, this.lastConditions, filter);
    const inProgram = new Set(loadProgram().map((t) => targetKey(t.name)));
    const candidates = pool.candidates.filter((c) => !inProgram.has(c.key));
    // the plan's own scoring, from now (or the plan's start), holds included
    const ranks = new Map(rankCandidates({ ...input, candidates }).map((r) => [r.key, r]));
    const plan = await this.plan().catch(() => null);
    const blocksOf = (key: string) => (plan?.blocks ?? []).filter((b) => b.target?.key === key && !b.past);
    const fov = this.d.fovArcmin();
    const goalDefault = restSettings().integrationTargetMin;
    const facts = await this.facts();
    const end = plan?.window.end ?? w.end.getTime();
    const settingsFor = (c: Candidate, k: { bestFrom: number | null; bestUntil: number | null }) => {
      if (!facts) return null;
      try {
        const from = k.bestFrom ?? Math.max(now, w.start.getTime());
        const to = k.bestUntil ?? end;
        return adviseFor({ facts, site, target: targetInfo(c.name), from: new Date(from), to: new Date(to), conditions: this.lastConditions, journal: this.d.journal, cloudFloor: loadSettings().weatherMinScore }).rec;
      } catch {
        return null;
      }
    };
    const rows = candidates.map((c) => {
      const r = pool.rows.get(c.key)!;
      const k = ranks.get(c.key)!;
      const blocks = blocksOf(c.key);
      const size = Number(String(r.sizeArcmin).split('×')[0]);
      const acq = settingsFor(c, k);
      return {
        name: r.name,
        displayName: r.displayName,
        gotoName: r.gotoName,
        type: r.type,
        constellation: r.constellation,
        sizeArcmin: r.sizeArcmin,
        fillPercent: Number.isFinite(size) && fov.w ? Math.round((size / fov.w) * 100) : null,
        framing: r.framing,
        magnitude: r.magnitude,
        surfaceBrightness: r.surfaceBrightness,
        raHours: r.raHours,
        decDeg: r.decDeg,
        maxAltitude: r.maxAltitude,
        detect: r.detectBucket,
        detectReason: r.detectReason,
        filter: c.filter,
        subSeconds: r.subSeconds,
        subRangeSeconds: r.subRangeSeconds,
        subs: r.subs,
        exposureAdvice: r.exposureAdvice,
        restReason: r.restReason,
        obstructedNow: r.obstructedNow,
        clearsAt: r.clearsAt,
        /** the plan's view: scheduled blocks, else when and how well it is usable tonight */
        scheduled: blocks.map((b) => ({ start: b.start, end: b.end, expectedMin: b.expectedMin })),
        usableMin: k.usableMin,
        usableFrom: k.bestFrom,
        usableUntil: k.bestUntil,
        merit: k.meanMerit,
        sky: k.sky,
        planValue: k.value,
        notUsable: k.why,
        suggestedGoalMin: goalDefault || acq?.integration.suggestedGoalMin || goalFor(findObject(r.name)?.type, r.detectBucket),
        /** the acquisition planner: settings for its best hours tonight, and the hours to a clean picture */
        capture: acq ? { filter: acq.settings.filter, gain: acq.settings.gain, subS: acq.settings.subS, frames: acq.settings.frames, hoursToGood: acq.integration.hoursTo.good, backgroundPct: acq.overexposure.backgroundPct, swamp: acq.subLength.swamp, swampWanted: acq.subLength.wanted, efficiencyPct: acq.subLength.efficiencyPct } : null,
      };
    });
    // what the plan scheduled first (in its order), then by what the plan could make of each
    rows.sort((a, b) => (b.scheduled.length ? 1 : 0) - (a.scheduled.length ? 1 : 0) || (a.scheduled[0]?.start ?? 0) - (b.scheduled[0]?.start ?? 0) || b.planValue - a.planValue);
    return { targets: rows.slice(0, filter.limit ?? 25), resting: pool.resting, rest: restSettings() };
  }

  /**
   * What the Tonight tab says of a scheduled target, for its block: detectability under tonight's
   * sky through its filter, how it fits the frame, and the sub-exposure advice for the hours it has.
   */
  private advise(t: BlockTarget, b: Block, conditions: ((t: Date) => HourConditions | undefined) | null, facts: Awaited<ReturnType<FactsSource>> | null, progress: ReturnType<typeof collected> | null): TargetAdvice | undefined {
    const o = findObject(t.name);
    if (!o) return undefined;
    const defaults = planDefaults();
    const usableMin = Math.max(0, (b.end - b.start) / 60e3 - b.overheadMin);
    const acquisition = facts ? this.acquisition(t, b, usableMin, conditions, facts, progress?.get(t.key)?.totalMin ?? 0) : null;
    // the capture settings' filter is the one the block is shot through (unless the owner fixed one)
    if (acquisition) t.filter = acquisition.filter;
    const d = detectFor(o, { bortle: defaults.bortle, filter: t.filter });
    const mid = new Date((b.start + b.end) / 2);
    const sp = subPlan({ rig: { ...defaults.rig, band: d.band }, bortle: defaults.bortle, transitAlt: b.alt?.max ?? 45, usableMin, moonUp: !!b.moon, windKmh: conditions?.(mid)?.windKmh });
    return {
      framing: framing(o, this.d.fovArcmin()).text,
      detect: d.bucket,
      detectReason: d.reason,
      surfaceBrightness: d.sb === null ? null : Math.round(d.sb * 100) / 100,
      sub: sp ? { subS: sp.subS, rangeS: sp.subRangeS, subs: sp.subs, integrationMin: sp.integrationMin, line: sp.line } : null,
      acquisition: acquisition ?? undefined,
    };
  }

  /** The acquisition planner's settings for a block (null when it cannot say: no catalog row, a window below 10°). */
  private acquisition(t: BlockTarget, b: Block, usableMin: number, conditions: ((t: Date) => HourConditions | undefined) | null, facts: Awaited<ReturnType<FactsSource>>, got: number): NonNullable<TargetAdvice['acquisition']> | null {
    try {
      const program = t.programId ? loadProgram().find((p) => p.id === t.programId) : undefined;
      const owned = program?.filter && program.filter !== 'auto' ? program.filter : undefined;
      const { rec } = adviseFor({ facts, site: this.site(), target: targetInfo(t.name), from: new Date(b.start), to: new Date(b.end), usableMin, conditions, fixed: { filter: owned }, collectedMin: Math.round(got), journal: this.d.journal, cloudFloor: loadSettings().weatherMinScore });
      return {
        device: rec.device.name,
        filter: rec.settings.filter,
        gain: rec.settings.gain,
        subS: rec.settings.subS,
        frames: rec.settings.frames,
        ditherEverySubs: rec.settings.ditherEverySubs,
        backgroundPct: rec.overexposure.backgroundPct,
        coreClips: rec.overexposure.coreClips,
        starSaturationMag: rec.overexposure.starSaturationMag,
        snrTonight: rec.integration.snrTonight,
        hoursToGood: rec.integration.hoursTo.good,
        suggestedGoalMin: rec.integration.suggestedGoalMin,
        swamp: rec.subLength.swamp,
        swampWanted: rec.subLength.wanted,
        efficiencyPct: rec.subLength.efficiencyPct,
        line: rec.why.slice(0, 2).join('; '),
        apply: rec.apply,
      };
    } catch (e) {
      log.debug(`acquisition for ${t.displayName}: ${errMsg(e)}`);
      return null;
    }
  }

  private programCandidate(t: ProgramTarget, key: string, got: number, glassFilters: string[], moonIllum: number): Candidate {
    const o = findObject(t.name);
    let filter = t.filter && t.filter !== 'auto' ? t.filter : undefined;
    let keep = 1 - 0.7 * moonIllum;
    if (o) {
      const defaults = planDefaults();
      if (filter) keep = moonlitKeep(detectFor(o, { bortle: defaults.bortle, filter }), moonIllum);
      else {
        const g = chooseGlass(o, { filters: glassFilters, bortle: defaults.bortle, moonStrength: moonIllum });
        filter = g.filter;
        keep = moonlitKeep(g.d, moonIllum);
      }
    }
    return {
      key,
      name: t.name,
      displayName: t.displayName,
      gotoName: t.gotoName,
      raHours: t.raHours,
      decDeg: t.decDeg,
      source: 'program',
      programId: t.id,
      priority: t.priority,
      goalMin: t.goalMin,
      collectedMin: got,
      keepCollecting: t.keepCollecting,
      minAltitude: t.minAltitude,
      filter,
      narrowband: classifyFilter(filter) !== 'broadband',
      moonKeep: keep,
      type: o?.typeName,
      seeingSens: seeingSensitivity(o?.type),
      notes: t.notes,
    };
  }

  private learned(settings: PlanSettings): PlannedNight['learned'] {
    const l = learn(this.d.journal);
    return {
      ...l,
      overheadMin: settings.overheadMin ?? l.overheadMin,
      efficiency: settings.efficiency ?? l.efficiency,
      overheadSource: settings.overheadMin !== null ? 'settings' : l.overheadLearned ? 'journal' : 'default',
      efficiencySource: settings.efficiency !== null ? 'settings' : l.efficiencyLearned ? 'journal' : 'default',
    };
  }

  /** The inputs of a solve for the current night from `from`. */
  private async inputs(fromMs: number): Promise<{ input: SolveInput; w: PlanWindow; settings: PlanSettings; f: NightFile; learned: PlannedNight['learned']; horizonSummary: string | null; buildMs: number }> {
    const site = this.site();
    const settings = loadSettings();
    const w = planWindow(site, new Date(this.now()), settings);
    const f = this.load(w.night);
    this.expireHolds(w.night, site);
    const conditions = settings.useForecast ? await this.conditions().catch(() => null) : null;
    this.lastConditions = conditions;
    const tc = Date.now();
    const { list, excluded } = this.candidates(site, w, settings, conditions);
    const buildMs = Date.now() - tc;
    const horizon = settings.useHorizon ? horizonFor(site) : undefined;
    const learned = this.learned(settings);
    const active = this.d.active?.();
    const current = active && active.night === w.night ? { key: targetKey(active.session.target), since: active.session.startedAt } : null;
    const input: SolveInput = {
      site,
      start: w.start,
      end: w.end,
      from: new Date(Math.max(w.start.getTime(), fromMs)),
      candidates: list,
      settings,
      overheadMin: learned.overheadMin,
      efficiency: learned.efficiency,
      holds: f.holds,
      horizon,
      conditions: conditions ?? undefined,
      mount: planDefaults().rig.mount,
      current,
      lock: current ? (f.lock ?? null) : null,
      excluded,
      history: f.plan?.blocks ?? [],
      idPrefix: `${w.night}-${Date.now().toString(36)}-`,
      timezone: config.observer.timezone,
    };
    return { input, w, settings, f, learned, horizonSummary: horizon?.summary ?? null, buildMs };
  }

  /**
   * The lock follows the night: the scope on the plan's current block locks that target to the
   * block's end; it ends with the block, or when the scope or the plan has left the target.
   */
  private syncLock(night: string): void {
    const f = this.load(night);
    const now = this.now();
    const active = this.d.active?.();
    const key = active && active.night === night ? targetKey(active.session.target) : null;
    const block = f.plan?.blocks.find((b) => b.start <= now && b.end > now);
    const onBlock = !!key && block?.kind === 'target' && block.target?.key === key;
    const before = f.lock ?? null;
    let lock = before && before.until > now && before.key === key && onBlock ? before : null;
    if (!lock && onBlock) lock = { key: key!, until: block!.end };
    if (lock?.key === before?.key && lock?.until === before?.until) return;
    f.lock = lock;
    this.save(night);
    log.info(lock ? `${block!.target!.displayName} locked until ${hm(lock.until)}` : `lock on ${before!.key} ended`);
  }

  /** The next target block of the plan in force, after the one running now. */
  private nextBlockOf(plan: PlannedNight | null, now: number): SolveInput['incumbent'] {
    const b = plan?.blocks.find((x) => x.kind === 'target' && x.start > now);
    return b?.target ? { key: b.target.key, start: b.start, end: b.end } : null;
  }

  private async solve(reason: string): Promise<PlannedNight> {
    const t0 = Date.now();
    this.syncLock(this.currentNight().night);
    const { input, w, f, learned, horizonSummary, buildMs } = await this.inputs(this.now());
    if (ROUTINE_REASONS.has(reason)) input.incumbent = this.nextBlockOf(f.plan, this.now());
    const t1 = Date.now();
    const solved = solveNight(input);
    const solveMs = Date.now() - t1;
    const facts = await this.facts();
    // what each target has collected: one look at the library for the whole night, not one per block
    const progress = facts ? programProgress(this.d.journal) : null;
    for (const b of solved.blocks) if (b.target && !b.past && !b.target.advice) b.target.advice = this.advise(b.target, b, this.lastConditions, facts, progress);
    const site = this.site();
    const moon = sky.moonState(site, new Date((w.start.getTime() + w.end.getTime()) / 2));
    const stamp = await this.forecastStamp();
    const sumBy = (k: Block['kind'], src?: 'program' | 'filler') => solved.blocks.filter((b) => !b.past && b.kind === k && (!src || b.target?.source === src)).reduce((a, b) => a + (k === 'target' ? b.expectedMin : (b.end - b.start) / 60e3), 0);
    const plan: PlannedNight = {
      ...solved,
      night: w.night,
      generatedAt: this.now(),
      reason,
      window: { start: w.start.getTime(), end: w.end.getTime() },
      twilight: { sunset: w.sunset?.getTime() ?? null, astroDusk: w.astroDusk?.getTime() ?? null, astroDawn: w.astroDawn?.getTime() ?? null, sunrise: w.sunrise?.getTime() ?? null },
      moon: { ...solved.moon, phase: moon.phase },
      learned,
      horizon: horizonSummary,
      forecast: stamp,
      holds: f.holds,
      totals: { programMin: Math.round(sumBy('target', 'program')), fillerMin: Math.round(sumBy('target', 'filler')), gapMin: Math.round(sumBy('gap')), weatherMin: Math.round(sumBy('weather')) },
    };
    const sequence = (p: PlannedNight | null) => (p?.blocks ?? []).filter((b) => b.kind === 'target' && b.end > this.now()).map((b) => b.target!.key).join(',');
    const changedSequence = sequence(f.plan) !== sequence(plan);
    f.plan = plan;
    this.lastForecast = stamp?.fetchedAt ?? this.lastForecast;
    this.save(w.night);
    this.syncLock(w.night);
    log.info(`plan for ${w.night} solved (${reason}) in ${Date.now() - t0} ms (candidates ${buildMs} ms, schedule ${solveMs} ms, the rest waiting on the forecast): ${plan.blocks.filter((b) => b.kind === 'target' && !b.past).length} blocks, ${plan.totals.programMin} min program, ${plan.totals.fillerMin} min fillers`);
    if (changedSequence) this.d.journal.event(w.night, 'plan', `plan ${reason === 'first look at the night' || reason === 'a new night' ? 'made' : `changed (${reason})`}: ${plan.blocks.filter((b) => b.kind === 'target' && !b.past).map((b) => `${b.target!.displayName} ${hm(b.start)}–${hm(b.end)}`).join(', ') || 'no target blocks'}`, this.now());
    this.emit('plan', plan);
    this.followBlock(plan);
    return plan;
  }

  /** The agent is told when the plan's current block changes target (a duty event), once per block. */
  private followBlock(plan: PlannedNight): void {
    const v = this.viewOf(plan, this.now());
    const id = v.block?.target ? `${v.block.target.key}@${v.block.start}` : null;
    if (id === this.lastBlockId) return;
    const prev = this.lastBlockId;
    this.lastBlockId = id;
    if (prev === null || v.phase !== 'night' || !v.block?.target) return;
    this.d.notify?.(`the night plan moved on: ${v.instruction}`);
  }

  private async tick(): Promise<void> {
    let site: sky.Site;
    try {
      site = this.site();
    } catch {
      return;
    }
    try {
      const now = this.now();
      const settings = loadSettings();
      const w = planWindow(site, new Date(now), settings);
      const f = this.load(w.night);
      this.syncLock(w.night);
      const during = now >= w.start.getTime() - LEAD_MS && now < w.end.getTime();
      const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.observer.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
      if (!f.plan) {
        if (during || localHour >= PREPARE_HOUR || now >= w.start.getTime() - 6 * 3600e3) await this.replan('a new night');
      } else if (now < w.end.getTime()) {
        // by day as by night: the coming night is kept solved against the latest forecast
        const stamp = await this.forecastStamp();
        const expired = this.expireHolds(w.night, site);
        if (stamp && stamp.fetchedAt !== this.lastForecast && this.lastForecast !== null) await this.replan('the forecast was updated');
        else if (expired) await this.replan('a hold ran out');
        else if (now - f.plan.generatedAt >= REFRESH_MS) await this.replan('half-hourly refresh');
        else if (during) this.followBlock(f.plan);
        if (stamp) this.lastForecast = stamp.fetchedAt;
      }
    } catch (e) {
      log.warn(`plan tick: ${errMsg(e)}`);
    }
  }

  // ---------------------------------------------------------------- holds
  /** Drop holds that have run out, and end auto holds whose target has risen clear; true if any changed. */
  private expireHolds(night: string, site: sky.Site): boolean {
    const f = this.load(night);
    const now = this.now();
    const before = f.holds.length;
    f.holds = f.holds.filter((h) => {
      if (h.until !== null && h.until <= now) return false;
      if (h.kind === 'hold' && h.cause === 'obstruction' && h.markedAlt !== undefined && h.markedAz !== undefined && h.target && now - h.createdAt >= HOLD_MIN_MS) {
        const o = this.resolve(h.target);
        if (o) {
          // clear of the obstruction it was blocked by (it rose out, or moved past it in azimuth), and above every other limit
          const aa = sky.altAz(site, o.raHours, o.decDeg, new Date(now));
          const lim = Math.max(loadSettings().minAltitude, this.obstructionHorizon(site, h.markedAz, h.markedAlt, now).limit(aa.azimuth));
          if (aa.altitude >= lim) return false;
        }
      }
      return true;
    });
    if (f.holds.length !== before) {
      this.save(night);
      this.d.journal.event(night, 'hold', `${before - f.holds.length} hold(s) ran out`, now);
      return true;
    }
    return false;
  }

  private resolve(ref: string): { key: string; name: string; displayName: string; gotoName: string; raHours: number; decDeg: number } | null {
    const prog = loadProgram().find((t) => t.id === ref || targetKey(t.name) === targetKey(ref) || t.gotoName.toLowerCase() === ref.trim().toLowerCase());
    if (prog) return { key: targetKey(prog.name), name: prog.name, displayName: prog.displayName, gotoName: prog.gotoName, raHours: prog.raHours, decDeg: prog.decDeg };
    const o = findObject(ref);
    if (o) return { key: targetKey(o.id), name: o.id, displayName: displayName(o), gotoName: gotoLabel(o), raHours: o.raHours, decDeg: o.decDeg };
    const fromPlan = this.cache.get(this.currentNight().night)?.plan?.blocks.find((b) => b.target && (b.target.key === targetKey(ref) || b.target.gotoName.toLowerCase() === ref.toLowerCase()))?.target;
    return fromPlan ? { key: fromPlan.key, name: fromPlan.name, displayName: fromPlan.displayName, gotoName: fromPlan.gotoName, raHours: fromPlan.raHours, decDeg: fromPlan.decDeg } : null;
  }

  private addHold(h: Omit<Hold, 'id' | 'createdAt'>): Hold {
    const { night } = this.currentNight();
    const f = this.load(night);
    const hold: Hold = { ...h, id: newId('hold'), createdAt: this.now() };
    // one hold per target and kind: a new one replaces the old
    f.holds = f.holds.filter((x) => !(x.kind === hold.kind && x.target === hold.target && x.quadrant === hold.quadrant));
    f.holds.push(hold);
    this.save(night);
    this.d.journal.event(night, 'hold', `${hold.kind}${hold.displayName ? ` ${hold.displayName}` : ''}${hold.quadrant ? ` ${hold.quadrant} sky` : ''}${hold.until ? ` until ${hm(hold.until)}` : ' for the night'} — ${hold.reason}${hold.note ? `; ${hold.note}` : ''} (${hold.by})`, this.now(), hold.displayName);
    this.emit('holds', f.holds);
    return hold;
  }

  /**
   * The horizon an obstruction hold is judged against: the site's (with tonight's blocked views),
   * raised in the direction the target was blocked to a little above where it was seen blocked:
   * the obstruction's top is at least there, and the frame's top edge has to clear it too.
   */
  private obstructionHorizon(site: sky.Site, az: number, alt: number, at: number): Horizon {
    const base = horizonFor(site, new Date(at));
    const half = Math.min(OBSTRUCTION_AZ_MAX_DEG, OBSTRUCTION_AZ_HALF_DEG / Math.max(0.1, Math.cos((alt * Math.PI) / 180)));
    return {
      limit: (x) => Math.max(base?.limit(x) ?? 0, azDiff(x, az) <= half ? alt + CLEAR_RISE_DEG : 0),
      summary: base?.summary ?? 'obstruction',
    };
  }

  /**
   * A target is obscured now. How long it stays out depends on what is in the way:
   *
   * - an obstruction (a tree, a roofline) stands still while the sky turns. It is filed as a blocked
   *   view (sightings.ts), so the horizon learns it for every target passing there tonight, and the
   *   target is held until its own path takes it clear: a target low in the east rises out of it, one
   *   in the west sinks further behind it (out for the night), one low in the north slides along
   *   it and clears when it has moved past. The hold also ends as soon as the target is seen clear.
   * - a cloud drifts with the wind, not with the sky: nothing is learned about the site, and the
   *   target is held for a while (minutes, or HOLD_DEFAULT_MIN) and then tried again.
   */
  async obscured(ref: string, o: { cause?: Hold['cause']; minutes?: number; until?: number; reason?: string; by: 'user' | 'agent' }): Promise<{ hold: Hold; now: NowView }> {
    const t = this.resolve(ref);
    if (!t) throw new Error(`"${ref}" is neither in the program, the catalog nor tonight's plan`);
    const site = this.site();
    const now = this.now();
    const end = this.currentNight().window.end;
    const aa = sky.altAz(site, t.raHours, t.decDeg, new Date(now));
    const cause = o.cause ?? 'obstruction';
    const given = o.until ?? (o.minutes ? now + o.minutes * 60e3 : null);
    let until: number | null = given;
    let note: string;
    if (cause === 'obstruction') {
      recordBlocked(site, t.name, aa.azimuth, aa.altitude, o.reason ?? 'obscured (night plan)', new Date(now));
      const horizon = this.obstructionHorizon(site, aa.azimuth, aa.altitude, now);
      const clear = clearsAt(site, t.raHours, t.decDeg, loadSettings().minAltitude, horizon, new Date(now + 5 * 60e3), end);
      const soon = sky.altAz(site, t.raHours, t.decDeg, new Date(now + 20 * 60e3));
      const side = quadrantOf(aa.azimuth);
      if (clear) {
        const at = sky.altAz(site, t.raHours, t.decDeg, clear);
        note = at.altitude > aa.altitude + 1 ? `rising (${side}): clear of the obstruction about ${hm(clear)}` : `moving along the obstruction (${side}): past it about ${hm(clear)}`;
      } else note = soon.altitude < aa.altitude ? `setting (${side}): it only sinks further behind the obstruction, out for the rest of the night` : 'does not clear the obstruction before the plan ends';
      if (given === null) until = clear ? clear.getTime() : null;
    } else {
      until ??= now + HOLD_DEFAULT_MIN * 60e3;
      note = `${cause === 'cloud' ? 'cloud' : 'held'}: tried again at ${hm(until)}`;
    }
    const hold = this.addHold({ kind: 'hold', target: t.key, displayName: t.displayName, from: now, until, reason: o.reason ?? `obscured (${cause})`, note, by: o.by, cause, markedAlt: Math.round(aa.altitude * 10) / 10, markedAz: Math.round(aa.azimuth) });
    await this.replan(`${t.displayName} obscured`);
    return { hold, now: await this.nowView() };
  }

  async skip(ref: string, o: { reason?: string; by: 'user' | 'agent' }): Promise<Hold> {
    const t = this.resolve(ref);
    if (!t) throw new Error(`"${ref}" is not known`);
    const hold = this.addHold({ kind: 'skip', target: t.key, displayName: t.displayName, from: this.now(), until: null, reason: o.reason ?? 'skipped tonight', by: o.by });
    await this.replan(`${t.displayName} skipped`);
    return hold;
  }

  /** Put a target in a time (default: from now for the minimum block). It need not be in the program. */
  async pin(ref: string, o: { from?: number; until?: number; reason?: string; by: 'user' | 'agent'; addToCandidates?: boolean }): Promise<Hold> {
    const t = this.resolve(ref);
    if (!t) throw new Error(`"${ref}" is not known`);
    const from = o.from ?? this.now();
    const until = o.until ?? from + loadSettings().minBlockMin * 60e3;
    if (until <= from) throw new Error('a pin must end after it starts');
    const inPlan = (await this.plan()).blocks.some((b) => b.target?.key === t.key) || loadProgram().some((p) => targetKey(p.name) === t.key);
    if (!inPlan) {
      // a pin on a target that is neither in the program nor a filler: it joins the program at low priority, with a goal of the pin's length
      addTarget({ name: t.name, raHours: t.raHours, decDeg: t.decDeg, goalMin: Math.round((until - from) / 60e3), priority: 2, notes: 'added by a pin' }, this.currentNight().night);
    }
    const hold = this.addHold({ kind: 'pin', target: t.key, displayName: t.displayName, from, until, reason: o.reason ?? 'pinned', by: o.by });
    await this.replan(`${t.displayName} pinned`);
    return hold;
  }

  async skyHold(quadrant: Quadrant, o: { minutes?: number; until?: number; reason?: string; by: 'user' | 'agent' }): Promise<Hold> {
    const now = this.now();
    const hold = this.addHold({ kind: 'sky', quadrant, from: now, until: o.until ?? now + (o.minutes ?? HOLD_DEFAULT_MIN) * 60e3, reason: o.reason ?? `the ${quadrant} sky is out (cloud)`, by: o.by, cause: 'cloud' });
    await this.replan(`the ${quadrant} sky held`);
    return hold;
  }

  /** Lift holds by id, or every hold on a target or quadrant. */
  async release(ref: string): Promise<number> {
    const { night } = this.currentNight();
    const f = this.load(night);
    const key = targetKey(ref);
    const before = f.holds.length;
    f.holds = f.holds.filter((h) => !(h.id === ref || h.target === key || h.quadrant === ref.toUpperCase()));
    const n = before - f.holds.length;
    if (!n) throw new Error(`no hold matches "${ref}"`);
    this.save(night);
    this.d.journal.event(night, 'hold', `${n} hold(s) lifted (${ref})`, this.now());
    await this.replan('a hold was lifted');
    return n;
  }

  holds(): Hold[] {
    return this.load(this.currentNight().night).holds;
  }

  // ---------------------------------------------------------------- what to do now
  async nowView(at = this.now()): Promise<NowView> {
    return this.viewOf(await this.plan(), at);
  }

  /** The plan's view of a moment, synchronously from a solved plan (duty samples). */
  viewOf(plan: PlannedNight, at = this.now()): NowView {
    const active = this.d.active?.();
    const scopeOn = active && active.night === plan.night ? active.session.target : null;
    const blocks = plan.blocks;
    const block = blocks.find((b) => b.start <= at && b.end > at) ?? null;
    const next = blocks.find((b) => b.start > at && b.kind === 'target') ?? null;
    const phase: NowView['phase'] = at < plan.window.start ? 'before' : at >= plan.window.end ? 'after' : 'night';
    const onPlan = block?.target && scopeOn ? targetKey(scopeOn) === block.target.key : null;
    const minutesLeft = block ? Math.round((block.end - at) / 60e3) : null;
    const go = (b: Block) => `goto_target name=${b.target!.gotoName}${b.target!.filter ? ` (filter ${b.target!.filter})` : ''}, autofocus, star_focus, start_stacking`;
    let instruction: string;
    if (phase === 'before') {
      const first = blocks.find((b) => b.kind === 'target' && !b.past && b.end > at);
      instruction = `The plan starts at ${hm(plan.window.start)} with ${first?.target ? `${first.target.displayName} (${hm(first.start)}–${hm(first.end)})` : 'no target'}. Nothing is stacked before then; get ready (connect, open the arm).`;
    } else if (phase === 'after') instruction = "The plan's night has ended.";
    else if (!block || block.kind !== 'target') {
      // 'weather' blocks come only from plans solved before the forecast floor became advisory
      const why = block?.kind === 'weather' ? 'the forecast is below the floor' : 'no target is usable';
      instruction = `${why} until ${block ? hm(block.end) : '?'}${next?.target ? `; then ${next.target.displayName} at ${hm(next.start)}` : ''}. Check the sky (sky_check) and, if part of it is clear, night_plan action=alternates.`;
    } else if (onPlan) {
      instruction = `On plan: ${block.target!.displayName} until ${hm(block.end)} (${dur(minutesLeft ?? 0)} left)${next?.target ? `; next ${next.target.displayName} at ${hm(next.start)}` : ''}.`;
    } else if (scopeOn) {
      instruction = `The scope is on ${scopeOn} but the plan says ${block.target!.displayName} since ${hm(block.start)} (until ${hm(block.end)}): stop_stacking and ${go(block)}. If ${block.target!.displayName} is blocked or clouded: night_plan action=obscured target=${block.target!.gotoName}.`;
    } else {
      instruction = `Now: ${block.target!.displayName} (${hm(block.start)}–${hm(block.end)}, ${dur(minutesLeft ?? 0)} left): ${go(block)}.`;
    }
    if (phase === 'night' && block?.target && block.clouds) instruction += ` Clouds forecast (${block.clouds.sky}/100, below the ${block.clouds.floor}/100 floor; advisory): sky_check first; if ${block.target.displayName} is obscured, night_plan action=obscured target=${block.target.gotoName} cause=cloud for an alternate.`;
    if (phase === 'night' && block?.target?.notes) instruction += ` Owner's note on it: ${block.target.notes}`;
    return { night: plan.night, phase, at, block, next, minutesLeft, scopeOn, onPlan, instruction };
  }

  /** The plan's lines in a duty sample. */
  dutyLines(at = this.now()): string[] {
    let plan: PlannedNight | null = null;
    try {
      plan = this.load(this.currentNight().night).plan;
    } catch {
      return [];
    }
    if (!plan) return ['- night plan: not solved yet (night_plan action=show solves it)'];
    const v = this.viewOf(plan, at);
    const lines = [`- night plan: ${v.instruction}`];
    const alts = v.block?.alternates ?? [];
    if (v.phase === 'night' && alts.length) lines.push(`- plan alternates now: ${alts.slice(0, 3).map((a) => `${a.gotoName} (${a.quadrant}, alt ${a.alt}°)`).join(', ')}`);
    if (v.phase === 'night') lines.push(...this.sessionChecks(at));
    const holds = plan.holds.filter((h) => h.until === null || h.until > at);
    if (holds.length) lines.push(`- plan holds: ${holds.map((h) => `${h.kind} ${h.displayName ?? h.quadrant ?? ''}${h.until ? ` until ${hm(h.until)}` : ' for the night'}${h.note ? ` (${h.note})` : ''}`).join('; ')}`);
    return lines;
  }

  /**
   * What the journal says about the stack running now: a focus that is due (the temperature has
   * moved since it, or it is old), none at all, or a stack that is rejecting most of its frames.
   */
  private sessionChecks(at: number): string[] {
    const act = this.d.active?.();
    if (!act) return [];
    const s = act.session;
    const lastStart = [...s.marks].reverse().find((m) => m.kind === 'stack-start');
    const lastEnd = [...s.marks].reverse().find((m) => m.kind === 'stack-end');
    if (!lastStart || (lastEnd && lastEnd.at > lastStart.at)) return [];
    const out: string[] = [];
    const focus = [...s.marks].reverse().find((m) => m.kind === 'focus-done' || m.kind === 'finefocus-done');
    const tempAt = (t: number) => this.lastConditions?.(new Date(t))?.temperatureC;
    if (!focus) out.push(`- focus: none recorded for ${s.displayName ?? s.target} tonight; if the stars look soft (analyze_subs), stop_stacking, autofocus, star_focus, start_stacking`);
    else {
      const ageMin = Math.round((at - focus.at) / 60e3);
      const t0 = tempAt(focus.at);
      const t1 = tempAt(at);
      const dT = t0 !== undefined && t1 !== undefined ? t1 - t0 : null;
      if ((dT !== null && Math.abs(dT) >= REFOCUS_DELTA_C) || ageMin >= REFOCUS_MAX_MIN) {
        const why = dT !== null && Math.abs(dT) >= REFOCUS_DELTA_C ? `the forecast temperature has ${dT < 0 ? 'fallen' : 'risen'} ${Math.abs(dT).toFixed(1)} °C since the focus at ${hm(focus.at)}` : `the last focus was ${dur(ageMin)} ago (${hm(focus.at)})`;
        out.push(`- refocus due: ${why}${focus.value !== undefined ? ` at position ${focus.value}` : ''}; check analyze_subs, and if the stars have grown: stop_stacking, autofocus, star_focus, start_stacking`);
      }
    }
    const recent = s.samples.filter((x) => x.at >= at - REJECT_WINDOW_MIN * 60e3);
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const kept = b.stacked - a.stacked;
      const rej = b.rejected - a.rejected;
      if (kept + rej >= REJECT_MIN_FRAMES && rej / (kept + rej) > REJECT_FLAG) {
        out.push(`- stack rejecting: ${rej} of the last ${kept + rej} frames rejected (${hm(a.at)}–${hm(b.at)}); look (view_camera, analyze_subs): cloud → night_plan action=obscured cause=cloud; trailing or wind → check tracking; soft stars → refocus`);
      }
    }
    return out;
  }

  /** Ranked targets to take instead of the plan's from a moment: other quadrants first. */
  async alternates(o: { at?: number; exclude?: string[]; quadrant?: Quadrant; limit?: number } = {}): Promise<Alternate[]> {
    const at = o.at ?? this.now();
    const { input } = await this.inputs(at);
    const exclude = (o.exclude ?? []).map((x) => this.resolve(x)?.key ?? targetKey(x));
    // the plan's own current target is what the caller is replacing
    const cur = this.viewOf(await this.plan(), at).block?.target?.key;
    return alternatesAt(input, new Date(at), { exclude: cur ? [...exclude, cur] : exclude, quadrant: o.quadrant, limit: o.limit });
  }

  /** Which plan block a target belongs to at a moment (the journal ties sessions to it). */
  blockFor(target: string, at: number): { id: string } | null {
    try {
      const plan = this.load(this.currentNight().night).plan;
      const key = targetKey(target);
      const b = plan?.blocks.find((x) => x.target?.key === key && x.start - 30 * 60e3 <= at && x.end > at);
      return b ? { id: b.id } : null;
    } catch {
      return null;
    }
  }

  /** The program with what each target has collected and what tonight's plan gives it. */
  async programView(): Promise<Array<ProgramTarget & { key: string; collectedMin: number; journalOnlyMin: number; nights: number; lastNight: string | null; tonight: PlannedNight['outlook'][number] | null }>> {
    const progress = programProgress(this.d.journal);
    let plan: PlannedNight | null = null;
    try {
      plan = await this.plan();
    } catch {
      /* no site */
    }
    return loadProgram().map((t) => {
      const key = targetKey(t.name);
      const c = progress.get(key);
      return { ...t, key, collectedMin: c?.totalMin ?? 0, journalOnlyMin: c?.journalOnlyMin ?? 0, nights: c?.nights ?? 0, lastNight: c?.lastNight ?? null, tonight: plan?.outlook.find((x) => x.key === key) ?? null };
    });
  }

  /** The Calendar tab: each target's coming nights, windows and progress towards its goal. */
  async calendar(o: Pick<CalendarOptions, 'filters' | 'programOnly' | 'teleFovWidthArcmin' | 'limit'>): Promise<Awaited<ReturnType<typeof buildCalendar>>> {
    const site = this.site();
    const settings = loadSettings();
    return buildCalendar({ ...o, site, settings, horizon: settings.useHorizon ? horizonFor(site) : undefined, efficiency: this.learned(settings).efficiency, progress: programProgress(this.d.journal), now: this.now() });
  }

  /** The program or the settings changed: solve again shortly. */
  changed(what: string): void {
    this.soon(what);
  }
}

export { quadrantOf, SLOT_MIN, nightKey };
