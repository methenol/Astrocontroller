/**
 * The night's schedule: blocks of time from the plan's start (astronomical dusk) to its end (dawn),
 * each given to the target that makes the most of it.
 *
 * It is a dispatch scheduler, the kind observatories run (ACP Scheduler, N.I.N.A.'s Target
 * Scheduler): the night is cut into 10-minute slots, and every target gets a merit curve over them,
 * 0–1, the product of independent answers:
 *
 * - **altitude** — above the plan's minimum, the target's own, and the site's obstruction map in
 *   its direction; then √sin(alt), the airmass the light comes through;
 * - **field rotation** — an alt-az head loses its zenith (planner.keyholeWeight);
 * - **the Moon** — while it is up, a Lorentzian avoidance: the separation required is
 *   D / (1 + (days from full / W)²), D and W per filter class (wide for broadband, tight for a line
 *   filter), and what is left of a moonlit minute for this target through its glass (detect.ts);
 * - **the sky** — the hourly forecast: an hour below the plan's floor is advisory, not a wall —
 *   it is still scheduled (the forecast is often wrong, and a gap in the cloud is worth taking),
 *   at a fraction of its merit and with its expected yield scaled by the forecast, and the block
 *   says to check the sky (sky_check) and ask for an alternate if its target is clouded; poor
 *   seeing costs a galaxy or a planetary more than an emission nebula, poor transparency costs
 *   broadband more than a line filter.
 *
 * A target with a goal (the program, then the fillers in progress) whose need fits in a stretch of
 * the night is first given the stretch where it stands best, and is not started before it, so its
 * time is collected high in the sky.
 *
 * Walking the slots in order, each target is valued at the current slot as
 *   base × mean merit over the next minimum block × urgency,
 * where base is the owner's priority and how far it is from its goal (catalog fillers: their
 * planner score, scaled down), raised when its season is closing on what it still needs (its
 * usable time over the coming weeks, from how the sky shifts ~3.94 min a night), and urgency
 * rises as its remaining usable time tonight shrinks toward what it still needs (the one about
 * to set goes first). The running target is
 * kept unless another beats it by the hysteresis margin, and never before it has had its minimum
 * block, counted from when the scope went to it, across re-solves. The target being worked is
 * locked to the end of its block (SolveInput.lock): only a hold on it, a pin, its goal or its
 * leaving the sky ends that early. A switch costs the overhead (GoTo, centring, focus, learned from
 * the journal) before any integration counts. A target leaves when its goal is met, it sets, or a
 * hold takes it out.
 *
 * Each block carries alternates in other quadrants of the sky, for when its target is blocked or
 * clouded, and every program target an outlook: planned tonight, collected, still to go, or why
 * it is not on tonight's plan.
 */
import * as sky from '../astro/sky.js';
import { keyholeWeight } from '../astro/planner.js';
import type { Horizon } from '../astro/horizon.js';
import type { HourConditions } from '../astro/weather.js';
import type { Mount } from '../astro/exposure.js';
import type { PlanSettings } from './program.js';
import { hm } from './clock.js';

export const SLOT_MIN = 10;
const SLOT_MS = SLOT_MIN * 60e3;
export const MOON_HORIZON = -0.8333;
const SYNODIC_DAYS = 29.53;
/** below this fraction of the required separation a moonlit slot is lost; at the requirement it is whole */
const MOON_HARD_FRACTION = 0.6;
/** degrees above the limit over which a rising target fades in */
const LIMIT_RAMP_DEG = 4;
const PRIORITY_VALUE: Record<number, number> = { 1: 0.5, 2: 0.75, 3: 1, 4: 1.5, 5: 2.25 };
/** a goal met with keepCollecting: valued at this fraction */
const KEEP_COLLECTING_VALUE = 0.3;
const URGENCY_WEIGHT = 0.6;
/** how much a closing season raises a program target's value (at need ≥ what its season still offers) */
const SEASON_WEIGHT = 0.8;
/** the season is looked at this far ahead, every SEASON_STEP_D nights */
const SEASON_DAYS = 90;
const SEASON_STEP_D = 10;
/** of the nights ahead, the fraction expected clear enough to use, and the share of one a target gets among the others */
export const CLEAR_NIGHTS = 0.45;
export const NIGHT_SHARE = 0.5;
/** the sidereal day is shorter than the solar: the sky at a clock time runs this much ahead each night */
const SIDEREAL_SHIFT_MS = 235.9e3;
/** seeing / transparency: 7Timer indices (1 best … 8 worst), the ramp's good and bad ends, and the most they cost */
const SEEING_GOOD = 4;
const SEEING_BAD = 7;
const TRANS_GOOD = 3;
const TRANS_BAD = 7;
const SEEING_MAX_COST = 0.3;
const TRANS_MAX_COST = 0.3;
/** a filler gets at most this much of one night */
const FILLER_CAP_MIN = 240;
/** how much a filler's value rises as it nears its goal (at the goal: this much more) */
const FILLER_PROGRESS_WEIGHT = 0.5;
/** a filler being collected keeps at least this much of its value (the capture rest can take its score to nothing) */
const FILLER_STARTED_FLOOR = 0.25;
/** a filler's window stays where it has at least this share of its best merit tonight; so does its claim over new fillers */
const FILLER_PEAK_SHARE = 0.9;
/** an alternate in the block's own quadrant must be this far around the sky to clear a vertical obstruction */
const OWN_QUADRANT_AZ_CLEAR = 15;
/** alternates offered per block */
const ALTERNATES = 4;
/** an hour the forecast puts below the floor keeps this share of its merit (advisory: still planned, fillers and all) */
const CLOUDY_MERIT = 0.25;

export type Quadrant = 'N' | 'E' | 'S' | 'W';
export const quadrantOf = (az: number): Quadrant => {
  const a = ((az % 360) + 360) % 360;
  return a >= 315 || a < 45 ? 'N' : a < 135 ? 'E' : a < 225 ? 'S' : 'W';
};

export interface Candidate {
  key: string;
  name: string;
  displayName: string;
  gotoName: string;
  raHours: number;
  decDeg: number;
  source: 'program' | 'filler';
  programId?: string;
  priority?: number;
  goalMin?: number;
  /** minutes already collected (library + journal, tonight's included) */
  collectedMin?: number;
  keepCollecting?: boolean;
  minAltitude?: number;
  /** the filter it is planned through, as the planner chose it */
  filter?: string;
  /** a line filter: the narrowband Moon rule */
  narrowband?: boolean;
  /** what is left of a moonlit minute for it tonight (detect.moonlitKeep), 0–1 */
  moonKeep: number;
  /** a filler's planner score (0–100) */
  fillerScore?: number;
  type?: string;
  /** 0–1: how much its result depends on the seeing (detect.seeingSensitivity) */
  seeingSens?: number;
  notes?: string;
  /** shot as a mosaic: the scheduler sees one target; which panel comes next is get_next_mosaic_panel's */
  mosaic?: { projectId: string; panels: number; execution: 'panels' | 'native' };
}

/** What the coming weeks hold for a target: its season, and the nights it should still take. */
export interface Season {
  /** integration minutes it can still expect, all nights ahead (clear fraction and share applied) */
  capacityMin: number;
  /** the last night ahead (YYYY-MM-DD) it is still usable for at least an hour */
  endsAround: string | null;
  /** clear nights it should take to finish, at what it gets on a usable night */
  nightsToGoal: number | null;
  /** 0–1: its need against what its season still offers */
  urgency: number;
}

export interface Hold {
  id: string;
  /** hold: obscured or unwanted for a while; skip: not tonight; pin: this target in this time; sky: a part of the sky is out */
  kind: 'hold' | 'skip' | 'pin' | 'sky';
  target?: string;
  displayName?: string;
  quadrant?: Quadrant;
  from: number;
  /** null: to the end of the night */
  until: number | null;
  reason: string;
  by: 'user' | 'agent';
  createdAt: number;
  cause?: 'obstruction' | 'cloud' | 'other';
  /** how the hold ends, in words ("rising (E): clear of the obstruction about 23:50") */
  note?: string;
  markedAlt?: number;
  markedAz?: number;
}

export interface Alternate {
  key: string;
  displayName: string;
  gotoName: string;
  raHours: number;
  decDeg: number;
  source: Candidate['source'];
  quadrant: Quadrant;
  az: number;
  alt: number;
  /** minutes it is usable from the block's start */
  usableMin: number;
  value: number;
  reason: string;
}

/** What the Tonight tab says of a target, for the hours of its block: can tonight's sky bring it up, does it fit, what subs. */
export interface TargetAdvice {
  framing: string;
  detect: string;
  detectReason: string;
  surfaceBrightness: number | null;
  sub: { subS: number; rangeS: [number, number] | null; subs: number; integrationMin: number; line: string } | null;
  /** the acquisition planner's capture settings for the block (astro/acquisition) */
  acquisition?: {
    device: string;
    filter: string;
    gain: number;
    subS: number;
    frames: number;
    ditherEverySubs: number;
    /** worst sky background over the block, % of the range above black */
    backgroundPct: number;
    coreClips: boolean;
    starSaturationMag: number;
    snrTonight: number;
    hoursToGood: number;
    suggestedGoalMin: number;
    /** sky noise² / read noise² at this sub (sub_length's swamp factor) against the one wanted, and the sub efficiency */
    swamp: number;
    swampWanted: number;
    efficiencyPct: number;
    line: string;
    /** the tool calls that apply the settings on this driver */
    apply: string;
    /**
     * The collection quality engine (astro/acquisition/quality.ts): whether these settings were
     * measured on this target or are the model's stand-in until it is, and what to measure.
     */
    quality?: {
      status: 'established' | 'needed' | 'more' | 'refresh' | 'unsolvable';
      source: 'measured' | 'model';
      line: string;
      /** points to shoot after focusing (acquisition_quality action=measure), and roughly how long */
      points: number;
      aboutMin: number;
      measuredAt?: number;
    };
  };
}

export interface BlockTarget {
  key: string;
  name: string;
  displayName: string;
  gotoName: string;
  raHours: number;
  decDeg: number;
  source: Candidate['source'];
  programId?: string;
  filter?: string;
  notes?: string;
  advice?: TargetAdvice;
  mosaic?: Candidate['mosaic'];
}

export interface Block {
  id: string;
  kind: 'target' | 'gap' | 'weather';
  start: number;
  end: number;
  target?: BlockTarget;
  /** minutes at the block's start spent getting on target (0 when it continues the running one) */
  overheadMin: number;
  /** integration minutes it should yield */
  expectedMin: number;
  alt?: { start: number; end: number; max: number };
  az?: { start: number; end: number };
  quadrant?: Quadrant;
  moon?: { sepDeg: number; upMin: number; illumPct: number };
  /** mean forecast observability over the block, null without a forecast */
  sky: number | null;
  merit: number;
  pinned?: boolean;
  /** an earlier part of the night, kept from the plan in force then */
  past?: boolean;
  /** the forecast has (part of) the block below the plan's floor: advisory, the block is still planned */
  clouds?: { cloudyMin: number; sky: number | null; floor: number; advisory: string };
  reason: string;
  alternates: Alternate[];
}

export interface TargetOutlook {
  key: string;
  programId?: string;
  displayName: string;
  gotoName: string;
  source: Candidate['source'];
  priority?: number;
  goalMin?: number;
  collectedMin: number;
  plannedMin: number;
  remainingMin: number | null;
  /** minutes it is usable tonight (up, clear of the Moon, forecast-clear) */
  usableMin: number;
  status: 'scheduled' | 'complete' | 'not-up' | 'moon' | 'weather' | 'held' | 'outcompeted' | 'disabled' | 'waiting';
  reason: string;
  bestFrom: number | null;
  bestUntil: number | null;
  season?: Season;
}

export interface SlotInfo {
  t: number;
  sunAlt: number;
  moonAlt: number;
  /** forecast observability 0–100, null without a forecast */
  sky: number | null;
  /** the forecast has this slot below the plan's floor (advisory) */
  cloudy?: boolean;
  seeingIdx?: number;
  transparencyIdx?: number;
  temperatureC?: number;
}

export interface SolveInput {
  site: sky.Site;
  start: Date;
  end: Date;
  /** schedule from here (now, during the night); the window's start otherwise */
  from?: Date;
  candidates: Candidate[];
  settings: PlanSettings;
  overheadMin: number;
  efficiency: number;
  holds?: Hold[];
  horizon?: Horizon;
  conditions?: (t: Date) => HourConditions | undefined;
  mount?: Mount;
  /** the target the scope is on now, and since when (it is continued without a switch cost) */
  current?: { key: string; since: number } | null;
  /** the target being worked stays until this time, whatever else the solve finds (it must be `current`) */
  lock?: { key: string; until: number } | null;
  /** the next block of the plan in force: on a routine re-solve its target holds it by the hysteresis margin */
  incumbent?: { key: string; start: number; end: number } | null;
  /** program targets that are in the program but not candidates tonight, with why */
  excluded?: Array<Pick<TargetOutlook, 'key' | 'programId' | 'displayName' | 'gotoName' | 'priority' | 'goalMin' | 'collectedMin' | 'status' | 'reason'>>;
  /** blocks before `from` kept from the plan in force then */
  history?: Block[];
  idPrefix?: string;
  /** the observer's zone, for the times in the reasons */
  timezone?: string;
}

export interface Solved {
  slots: SlotInfo[];
  /** the altitude of each scheduled or program target at every slot, degrees (the Plan tab's chart) */
  tracks: Array<{ key: string; displayName: string; source: Candidate['source']; alt: number[] }>;
  blocks: Block[];
  outlook: TargetOutlook[];
  moon: { illumPct: number; daysFromFull: number };
  notes: string[];
}

interface Curve {
  c: Candidate;
  merit: Float64Array;
  /** merit for placing a goal's window: altitude, rotation and Moon; the forecast only where it is below the floor (hourly steps above it must not outweigh the arc) */
  place: Float64Array;
  alt: Float64Array;
  az: Float64Array;
  moonSep: Float64Array;
  /** up and above every limit, whatever the Moon and sky */
  geom: Uint8Array;
  /** geom and the Moon allows it */
  geomMoon: Uint8Array;
  season: Season | null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** A catalog filler with integration towards its goal, and more still to collect: finished before a new one begins. */
export const fillerInProgress = (c: Candidate): boolean => c.source === 'filler' && (c.collectedMin ?? 0) > 0 && (c.goalMin ?? 0) > (c.collectedMin ?? 0);
const ramp = (idx: number, good: number, bad: number) => clamp01((idx - good) / (bad - good));
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Days from full Moon from its illuminated fraction (0 new … 1 full). */
export function daysFromFull(illum: number): number {
  const phaseDeg = (Math.acos(Math.max(-1, Math.min(1, 1 - 2 * illum))) * 180) / Math.PI; // 0 new … 180 full
  return ((180 - phaseDeg) / 360) * SYNODIC_DAYS;
}

/** The separation the Moon avoidance asks for, degrees. */
export function moonRequiredSep(rule: { distanceDeg: number; widthDays: number }, dFull: number): number {
  return rule.distanceDeg / (1 + (dFull / rule.widthDays) ** 2);
}

/** 0–1: what the Moon leaves of a slot for a target at this separation. */
export function moonFactor(sepDeg: number, requiredDeg: number, keep: number): number {
  const sepQ = sepDeg >= requiredDeg ? 1 : sepDeg <= requiredDeg * MOON_HARD_FRACTION ? 0 : (sepDeg - requiredDeg * MOON_HARD_FRACTION) / (requiredDeg * (1 - MOON_HARD_FRACTION));
  return sepQ * clamp01(keep);
}

/**
 * A target's season from tonight on: on night N the sky at a clock time is tonight's sky
 * N × 3.94 min later, so tonight's window is sampled shifted by that (the window's own length
 * and the Moon are taken as tonight's; the Moon averages out over a month). Each night's usable
 * minutes become integration through the clear-night fraction and a target's share of a night.
 */
export function seasonOf(input: Pick<SolveInput, 'site' | 'start' | 'end' | 'settings' | 'horizon' | 'efficiency'>, c: Candidate): Season {
  const { site, settings, horizon } = input;
  const step = 20 * 60e3;
  let capacity = 0;
  let endsAround: string | null = null;
  let perUsableNight = 0;
  let usableNights = 0;
  for (let d = 0; d <= SEASON_DAYS; d += SEASON_STEP_D) {
    let min = 0;
    for (let t = input.start.getTime(); t < input.end.getTime(); t += step) {
      const aa = sky.altAz(site, c.raHours, c.decDeg, new Date(t + d * SIDEREAL_SHIFT_MS));
      const lim = Math.max(settings.minAltitude, c.minAltitude ?? 0, settings.useHorizon && horizon ? horizon.limit(aa.azimuth) : 0);
      if (aa.altitude >= lim) min += step / 60e3;
    }
    const yieldMin = Math.min(min, 6 * 60) * input.efficiency * NIGHT_SHARE;
    if (d > 0) capacity += yieldMin * CLEAR_NIGHTS * SEASON_STEP_D;
    if (min >= 60) {
      endsAround = new Date(input.start.getTime() + d * 86_400e3).toISOString().slice(0, 10);
      perUsableNight += yieldMin;
      usableNights++;
    }
  }
  const need = Math.max(0, (c.goalMin ?? 0) - (c.collectedMin ?? 0));
  const per = usableNights ? perUsableNight / usableNights : 0;
  return {
    capacityMin: Math.round(capacity),
    endsAround: endsAround && endsAround !== new Date(input.start.getTime() + SEASON_DAYS * 86_400e3).toISOString().slice(0, 10) ? endsAround : null,
    nightsToGoal: need <= 0 ? 0 : per > 0 ? Math.ceil(need / per) : null,
    urgency: need <= 0 ? 0 : capacity <= 0 ? 1 : clamp01(need / capacity),
  };
}

const currentKeyOf = (input: SolveInput) => input.current?.key ?? null;

function slotsOf(input: SolveInput): SlotInfo[] {
  const { site, start, end, conditions, settings } = input;
  const out: SlotInfo[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += SLOT_MS) {
    const mid = new Date(Math.min(t + SLOT_MS / 2, end.getTime()));
    const c = settings.useForecast ? conditions?.(mid) : undefined;
    const obs = c && Number.isFinite(c.observability) ? Math.round(c.observability) : null;
    out.push({
      t,
      sunAlt: r1(sky.bodyAlt(site, 'Sun', mid)),
      moonAlt: r1(sky.bodyAlt(site, 'Moon', mid)),
      sky: obs,
      cloudy: obs !== null && obs < settings.weatherMinScore ? true : undefined,
      seeingIdx: c?.seeingIdx,
      transparencyIdx: c?.transparencyIdx,
      temperatureC: c?.temperatureC,
    });
  }
  return out;
}

function curves(input: SolveInput, slots: SlotInfo[], illum: number): Curve[] {
  const { site, settings, horizon, mount = 'alt-az' } = input;
  const dFull = daysFromFull(illum);
  const moonPos = slots.map((s) => sky.bodyRaDec(site, 'Moon', new Date(s.t + SLOT_MS / 2)));
  return input.candidates.map((c) => {
    const n = slots.length;
    const cv: Curve = { c, merit: new Float64Array(n), place: new Float64Array(n), alt: new Float64Array(n), az: new Float64Array(n), moonSep: new Float64Array(n), geom: new Uint8Array(n), geomMoon: new Uint8Array(n), season: null };
    const rule = c.narrowband ? settings.moonNarrowband : settings.moonBroadband;
    const req = moonRequiredSep(rule, dFull);
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      const when = new Date(s.t + SLOT_MS / 2);
      const aa = sky.altAz(site, c.raHours, c.decDeg, when);
      cv.alt[i] = aa.altitude;
      cv.az[i] = aa.azimuth;
      const lim = Math.max(settings.minAltitude, c.minAltitude ?? 0, settings.useHorizon && horizon ? horizon.limit(aa.azimuth) : 0);
      const sep = sky.separationDeg(c.raHours, c.decDeg, moonPos[i].raHours, moonPos[i].decDeg);
      cv.moonSep[i] = sep;
      if (aa.altitude < lim) continue;
      cv.geom[i] = 1;
      const altQ = clamp01((aa.altitude - lim) / LIMIT_RAMP_DEG + 0.25) * Math.sqrt(Math.max(0, Math.sin((aa.altitude * Math.PI) / 180)));
      const kh = keyholeWeight(aa.altitude, mount);
      const moonQ = settings.moonAvoidance && s.moonAlt > MOON_HORIZON ? moonFactor(sep, req, c.moonKeep) : 1;
      if (moonQ > 0) cv.geomMoon[i] = 1;
      // below the floor is advisory: the hour stays plannable, worth a fraction of a clear one
      const wxQ = s.sky === null ? 1 : (0.4 + 0.6 * (s.sky / 100)) * (s.cloudy ? CLOUDY_MERIT : 1);
      const seeQ = s.seeingIdx === undefined ? 1 : 1 - SEEING_MAX_COST * (c.seeingSens ?? 0.4) * ramp(s.seeingIdx, SEEING_GOOD, SEEING_BAD);
      const trQ = s.transparencyIdx === undefined ? 1 : 1 - TRANS_MAX_COST * (c.narrowband ? 0.4 : 1) * ramp(s.transparencyIdx, TRANS_GOOD, TRANS_BAD);
      cv.merit[i] = altQ * kh * moonQ * wxQ * seeQ * trQ;
      cv.place[i] = altQ * kh * moonQ * (s.cloudy ? CLOUDY_MERIT : 1);
    }
    if (c.source === 'program') cv.season = seasonOf(input, c);
    return cv;
  });
}

/** A target's value to the plan before its hours are weighed: the owner's priority and how far it is from its goal (with its season), a filler's planner score scaled down. */
function baseValue(cv: Curve, settings: PlanSettings): number {
  const c = cv.c;
  if (c.source === 'filler') {
    const score = clamp01((c.fillerScore ?? 50) / 100);
    if (!fillerInProgress(c)) return settings.fillerWeight * score;
    const done = clamp01((c.collectedMin ?? 0) / (c.goalMin ?? 1));
    return settings.fillerWeight * Math.min(1, Math.max(FILLER_STARTED_FLOOR, score) * (1 + FILLER_PROGRESS_WEIGHT * done));
  }
  const p = PRIORITY_VALUE[c.priority ?? 3] ?? 1;
  const goal = c.goalMin ?? 0;
  const left = Math.max(0, goal - (c.collectedMin ?? 0));
  if (left <= 0) return c.keepCollecting ? p * KEEP_COLLECTING_VALUE : 0;
  return p * (0.6 + 0.4 * clamp01(goal ? left / goal : 1)) * (1 + SEASON_WEIGHT * (cv.season?.urgency ?? 0));
}

/** What the plan can do with one candidate tonight, by the same scoring the scheduler uses. */
export interface CandidateRank {
  key: string;
  /** minutes it is usable from `from` to the end (up, clear of obstructions and holds, the Moon allowing it; hours the forecast puts below the floor count, at their lower merit) */
  usableMin: number;
  /** its longest usable run */
  bestFrom: number | null;
  bestUntil: number | null;
  /** mean merit (0–1) over its usable slots: altitude, rotation, Moon, sky */
  meanMerit: number;
  /** mean forecast observability over its usable slots, null without a forecast */
  sky: number | null;
  /** base value × mean merit × its usable share of the night: how much the plan wants it tonight */
  value: number;
  /** why it is not usable at all, when it is not */
  why: string | null;
}

/**
 * Every candidate of a solve ranked by what the plan could do with it tonight, from `from`: the
 * merit curves and the base value the scheduler itself uses, so a list built from this agrees with
 * the plan (whatever it scheduled ranks among the best of it).
 */
export function rankCandidates(input: SolveInput): CandidateRank[] {
  const illum = sky.moonState(input.site, new Date((input.start.getTime() + input.end.getTime()) / 2)).illuminationPercent / 100;
  const slots = slotsOf(input);
  const from = Math.max(input.start.getTime(), input.from?.getTime() ?? input.start.getTime());
  const first = Math.max(0, slots.findIndex((x) => x.t + SLOT_MS > from));
  const holds = input.holds ?? [];
  const nightMin = Math.max(SLOT_MIN, (slots.length - first) * SLOT_MIN);
  return curves(input, slots, illum).map((cv) => {
    let n = 0;
    let sum = 0;
    let skySum = 0;
    let skyN = 0;
    let run = 0;
    let runFrom = 0;
    let best = 0;
    let bestFrom: number | null = null;
    let bestUntil: number | null = null;
    for (let i = first; i < slots.length; i++) {
      const ok = cv.merit[i] > 0 && !heldAt(holds, cv, i, slots[i].t);
      if (!ok) {
        run = 0;
        continue;
      }
      n++;
      sum += cv.merit[i];
      if (slots[i].sky !== null) {
        skySum += slots[i].sky!;
        skyN++;
      }
      if (!run) runFrom = slots[i].t;
      run++;
      if (run > best) {
        best = run;
        bestFrom = runFrom;
        bestUntil = Math.min(slots[i].t + SLOT_MS, input.end.getTime());
      }
    }
    const usableMin = n * SLOT_MIN;
    const meanMerit = n ? sum / n : 0;
    const geom = cv.geom.slice(first).some(Boolean);
    const moon = cv.geomMoon.slice(first).some(Boolean);
    const why = n ? null : !geom ? 'not above the limits (minimum altitude, obstructions) in the plan window' : !moon ? 'the Moon is too close whenever it is up' : 'held whenever it is up';
    return {
      key: cv.c.key,
      usableMin,
      bestFrom,
      bestUntil,
      meanMerit: Math.round(meanMerit * 100) / 100,
      sky: skyN ? Math.round(skySum / skyN) : null,
      value: Math.round(baseValue(cv, input.settings) * meanMerit * Math.min(1, usableMin / Math.min(nightMin, Math.max(input.settings.minBlockMin, 1) * 3)) * 1000) / 1000,
      why,
    };
  });
}

/** Whether a hold takes a target (or the patch of sky it is in) out of a slot. */
function heldAt(holds: Hold[], cv: Curve, i: number, t: number): Hold | null {
  for (const h of holds) {
    if (h.kind === 'pin') continue;
    if (t + SLOT_MS <= h.from || (h.until !== null && t >= h.until)) continue;
    if (h.kind === 'sky') {
      if (h.quadrant && quadrantOf(cv.az[i]) === h.quadrant) return h;
      continue;
    }
    if (h.target && h.target === cv.c.key) return h;
  }
  return null;
}

interface Run {
  cv: Curve;
  startIdx: number;
  endIdx: number; // exclusive
  overheadMin: number;
  expectedMin: number;
  pinned: boolean;
  /** slots it has already run before this solve (the running target's), towards its minimum block */
  ranSlots?: number;
}

export function solveNight(input: SolveInput): Solved {
  const { site, settings } = input;
  const notes: string[] = [];
  const mid = new Date((input.start.getTime() + input.end.getTime()) / 2);
  const illum = sky.moonState(site, mid).illuminationPercent / 100;
  const allSlots = slotsOf(input);
  const hhmm = (t: number | null) => (t === null ? '–' : hm(t, input.timezone));
  const from = Math.max(input.start.getTime(), input.from?.getTime() ?? input.start.getTime());
  const firstIdx = Math.max(0, allSlots.findIndex((s) => s.t + SLOT_MS > from));
  const cvs = curves(input, allSlots, illum);
  const holds = input.holds ?? [];
  const n = allSlots.length;
  const minBlockSlots = Math.max(1, Math.round(settings.minBlockMin / SLOT_MIN));
  const maxBlockSlots = settings.maxBlockMin > 0 ? Math.max(minBlockSlots, Math.round(settings.maxBlockMin / SLOT_MIN)) : Infinity;
  const slotYield = SLOT_MIN * input.efficiency;
  /** what a slot yields of a clear one: an hour the forecast puts below the floor is expected to give its observability's share */
  const slotW = allSlots.map((s) => (s.cloudy ? clamp01((s.sky ?? 0) / 100) : 1));
  const wSum = (a: number, b: number) => {
    let k = 0;
    for (let j = a; j < b && j < n; j++) k += slotW[j];
    return k;
  };

  // what each target still needs tonight, in integration minutes
  const remaining = new Map<Curve, number>();
  for (const cv of cvs) {
    const c = cv.c;
    if (c.source === 'filler') remaining.set(cv, fillerInProgress(c) ? Math.min(FILLER_CAP_MIN, (c.goalMin ?? 0) - (c.collectedMin ?? 0)) : FILLER_CAP_MIN);
    else {
      const left = Math.max(0, (c.goalMin ?? 0) - (c.collectedMin ?? 0));
      remaining.set(cv, left > 0 ? left : c.keepCollecting ? FILLER_CAP_MIN : 0);
    }
  }
  const usable = (cv: Curve, i: number) => cv.merit[i] > 0 && !heldAt(holds, cv, i, allSlots[i].t);
  /** integration minutes still to be had for a target from slot i to the end */
  const available = (cv: Curve, i: number) => {
    let k = 0;
    for (let j = i; j < n; j++) if (usable(cv, j)) k += slotW[j];
    return k * slotYield;
  };
  const base = (cv: Curve) => baseValue(cv, settings);

  // pinned blocks first: they are the owner's (or the agent's) word
  const pins: Run[] = [];
  for (const h of holds.filter((x) => x.kind === 'pin' && x.target)) {
    const cv = cvs.find((x) => x.c.key === h.target);
    if (!cv) continue;
    const a = Math.max(firstIdx, allSlots.findIndex((s) => s.t + SLOT_MS > h.from));
    const until = h.until ?? input.end.getTime();
    let b = allSlots.findIndex((s) => s.t >= until);
    if (b < 0) b = n;
    if (a < 0 || b <= a) continue;
    pins.push({ cv, startIdx: a, endIdx: b, overheadMin: 0, expectedMin: 0, pinned: true });
  }
  const pinnedAt = (i: number) => pins.find((p) => i >= p.startIdx && i < p.endIdx) ?? null;

  // the running target goes on from where it is: it is not a new block that has to earn its place
  // (not before the night has started: what the scope is doing while it gets ready is not the plan's)
  const runningCv = from > input.start.getTime() && input.current ? (cvs.find((x) => x.c.key === input.current!.key) ?? null) : null;
  const running = runningCv && usable(runningCv, firstIdx) && (remaining.get(runningCv) ?? 0) > 0 && !pinnedAt(firstIdx) ? runningCv : null;
  const lock = running && input.lock?.key === running.c.key ? input.lock : null;
  const lockedAt = (i: number) => !!lock && allSlots[i].t < lock.until;

  // Where each goal's time belongs: walking the night forward alone would take a target the moment it
  // clears, low in the sky, when what it needs fits in its best hours. The program first, then the
  // fillers in progress, most valued first: each gets the contiguous stretch of its need with the most
  // merit, and until then the sky goes to whatever else stands best. A target that needs more than any
  // stretch it has tonight gets no window: it takes all it can, as it comes.
  const opensAt = new Map<Curve, number>();
  const taken = new Uint8Array(n);
  for (const p of pins) taken.fill(1, p.startIdx, p.endIdx);
  // what the lock holds is not there for the other targets' windows
  for (let i = firstIdx; running && i < n && lockedAt(i) && usable(running, i) && !pinnedAt(i); i++) taken[i] = 1;
  const programFirst = (cv: Curve) => (cv.c.source === 'program' ? 0 : 1);
  const withGoals = cvs.filter((cv) => (cv.c.source === 'program' || fillerInProgress(cv.c)) && (remaining.get(cv) ?? 0) > 0 && cv.c.key !== currentKeyOf(input)).sort((a, b) => programFirst(a) - programFirst(b) || base(b) - base(a));
  const peakOf = new Map<Curve, number>();
  for (const cv of cvs) {
    let peak = 0;
    for (let j = firstIdx; j < n; j++) if (usable(cv, j)) peak = Math.max(peak, cv.place[j]);
    peakOf.set(cv, peak);
  }
  const nearPeak = (cv: Curve, i: number) => cv.place[i] > 0 && cv.place[i] >= FILLER_PEAK_SHARE * (peakOf.get(cv) ?? 0);
  for (const cv of withGoals) {
    const wallMin = (remaining.get(cv) ?? 0) / input.efficiency + input.overheadMin;
    let len = Math.min(maxBlockSlots, Math.max(minBlockSlots, Math.ceil(wallMin / SLOT_MIN)));
    const isFiller = cv.c.source === 'filler';
    if (isFiller) {
      // a filler keeps to its own good hours, and takes what is left of them when the program has the rest
      let near = 0;
      for (let j = firstIdx; j < n; j++) if (usable(cv, j) && nearPeak(cv, j)) near++;
      len = Math.min(len, Math.max(minBlockSlots, near));
    }
    let bestStart = -1;
    for (;;) {
      let bestSum = 0;
      for (let s = firstIdx; s + len <= n; s++) {
        let sum = 0;
        let ok = true;
        for (let j = s; j < s + len && ok; j++) {
          ok = !taken[j] && usable(cv, j);
          sum += cv.place[j];
        }
        if (ok && sum > bestSum) {
          bestSum = sum;
          bestStart = s;
        }
      }
      if (bestStart >= 0 || !isFiller || len <= minBlockSlots) break;
      len--;
    }
    if (bestStart < 0) continue;
    taken.fill(1, bestStart, bestStart + len);
    opensAt.set(cv, bestStart);
  }

  const runs: Run[] = [];
  const st: { cur: Run | null } = { cur: running ? { cv: running, startIdx: firstIdx, endIdx: firstIdx, overheadMin: 0, expectedMin: 0, pinned: false, ranSlots: Math.max(0, Math.floor((from - input.current!.since) / SLOT_MS)) } : null };
  const currentKey = input.current?.key ?? null;
  const yieldOf = (r: Run, slots: number) => Math.max(0, wSum(r.startIdx, r.startIdx + slots) * SLOT_MIN - r.overheadMin) * input.efficiency;
  const close = () => {
    if (!st.cur) return;
    // the running target, replaced in the very first slot: it has no block
    if (st.cur.endIdx <= st.cur.startIdx) {
      st.cur = null;
      return;
    }
    st.cur.expectedMin = yieldOf(st.cur, st.cur.endIdx - st.cur.startIdx);
    remaining.set(st.cur.cv, Math.max(0, (remaining.get(st.cur.cv) ?? 0) - st.cur.expectedMin));
    runs.push(st.cur);
    st.cur = null;
  };
  const switchCost = (cv: Curve, i: number) => (i === firstIdx && cv.c.key === currentKey ? 0 : input.overheadMin);

  for (let i = firstIdx; i < n; i++) {
    const pin = pinnedAt(i);
    if (pin) {
      if (st.cur !== pin) {
        close();
        const prev = runs[runs.length - 1];
        pin.overheadMin = prev && prev.cv === pin.cv && prev.endIdx === i ? 0 : switchCost(pin.cv, i);
        st.cur = pin;
      }
      if (i === pin.endIdx - 1) close();
      continue;
    }
    if (st.cur && st.cur.pinned) close();
    const live: Run | null = st.cur;
    const curRun = live ? i - live.startIdx : 0;
    const curLen = curRun + (live?.ranSlots ?? 0);
    const curLeft = live ? (remaining.get(live.cv) ?? 0) - yieldOf(live, curRun) : 0;
    const curUsable = !!live && usable(live.cv, i) && curLeft > 0;
    // a block keeps its minimum length unless its target can no longer be shot; the locked one, its whole block
    if (live && curUsable && (curLen < minBlockSlots || (live.cv === running && lockedAt(i)))) {
      live.endIdx = i + 1;
      continue;
    }
    const open: Array<{ cv: Curve; v: number; waiting: boolean }> = [];
    const look = Math.min(minBlockSlots, n - i);
    for (const cv of cvs) {
      const isCur = !!live && live.cv === cv;
      const need = isCur ? curLeft : (remaining.get(cv) ?? 0);
      if (need <= 0) continue;
      // not before its window; a little early only when nothing is running and no minimum block would fit before it
      const opens = opensAt.get(cv);
      const waiting = !isCur && opens !== undefined && i < opens && (i <= opens - minBlockSlots || !!(live && curUsable));
      // the forecast alone never makes a gap: in an hour below the floor a waiting target may run if nothing else can
      if (waiting && !allSlots[i].cloudy) continue;
      if (isCur ? !curUsable : !usable(cv, i)) continue;
      if (isCur && curLen >= maxBlockSlots) continue;
      let sum = 0;
      let ok = true;
      for (let j = i; j < i + look; j++) {
        // a new block needs its target usable for the whole minimum block (or what it needs, if less)
        if (!usable(cv, j)) {
          if (!isCur && (j - i) * slotYield < Math.min(need, look * slotYield)) ok = false;
          break;
        }
        sum += cv.merit[j];
      }
      if (!ok) continue;
      const meanMerit = sum / look;
      // a filler has no goal to race the night for: the one about to set is not worth more for it
      const urgency = cv.c.source === 'filler' ? 0 : clamp01(need / Math.max(slotYield, available(cv, i)));
      // past its good hours a filler in progress is one filler among the others: better placed ones may take over
      const value = fillerInProgress(cv.c) && !nearPeak(cv, i) ? settings.fillerWeight * clamp01((cv.c.fillerScore ?? 50) / 100) : base(cv);
      let v = value * meanMerit * (1 + URGENCY_WEIGHT * urgency);
      if (isCur || (input.incumbent?.key === cv.c.key && allSlots[i].t >= input.incumbent.start && allSlots[i].t < input.incumbent.end)) v *= 1 + settings.switchHysteresis;
      open.push({ cv, v, waiting });
    }
    const ready = open.filter((x) => !x.waiting);
    const choices = ready.length ? ready : open;
    // a filler being collected, in its good hours, goes before starting another; the program still competes on its value
    const anyStarted = choices.some((x) => fillerInProgress(x.cv.c) && nearPeak(x.cv, i));
    let best: { cv: Curve; v: number } | null = null;
    for (const x of choices) {
      if (anyStarted && x.cv.c.source === 'filler' && !fillerInProgress(x.cv.c)) continue;
      if (!best || x.v > best.v) best = x;
    }
    if (!best || best.v <= 0) {
      close();
      continue;
    }
    if (live && live.cv === best.cv) {
      live.endIdx = i + 1;
      continue;
    }
    close();
    const prevRun = runs[runs.length - 1];
    const contiguous = prevRun && prevRun.cv === best.cv && prevRun.endIdx === i;
    st.cur = { cv: best.cv, startIdx: i, endIdx: i + 1, overheadMin: contiguous ? 0 : switchCost(best.cv, i), expectedMin: 0, pinned: false };
  }
  close();

  // ---- blocks: the runs, and what is between them
  const prefix = input.idPrefix ?? 'b';
  const blocks: Block[] = [];
  const meanSky = (a: number, b: number) => {
    const xs = allSlots.slice(a, b).map((s) => s.sky).filter((x): x is number => x !== null);
    return xs.length ? Math.round(xs.reduce((p, q) => p + q, 0) / xs.length) : null;
  };
  let cursor = firstIdx;
  // a gap is nothing usable (limits, the Moon, holds, every goal met): the forecast alone never makes one
  const pushGap = (a: number, b: number) => {
    const cloudyMin = allSlots.slice(a, b).filter((s) => s.cloudy).length * SLOT_MIN;
    blocks.push({
      id: `${prefix}${blocks.length}`,
      kind: 'gap',
      start: Math.max(allSlots[a].t, from),
      end: Math.min(allSlots[b - 1].t + SLOT_MS, input.end.getTime()),
      overheadMin: 0,
      expectedMin: 0,
      sky: meanSky(a, b),
      merit: 0,
      reason: `no target in the program or the fillers is usable then (below the limits, the Moon, holds, or every goal met)${cloudyMin ? `; the forecast is also below ${settings.weatherMinScore}/100 for ${cloudyMin} min of it` : ''}`,
      alternates: [],
    });
  };
  /** the advisory a block carries when the forecast has part of it below the floor */
  const cloudsOf = (a: number, b: number, target: string): Block['clouds'] => {
    const cloudyMin = allSlots.slice(a, b).filter((s) => s.cloudy).length * SLOT_MIN;
    if (!cloudyMin) return undefined;
    const xs = allSlots.slice(a, b).filter((s) => s.cloudy).map((s) => s.sky!);
    const sky = xs.length ? Math.round(xs.reduce((p, q) => p + q, 0) / xs.length) : null;
    const whole = cloudyMin >= (b - a) * SLOT_MIN;
    return {
      cloudyMin,
      sky,
      floor: settings.weatherMinScore,
      advisory: `clouds forecast (${sky}/100, below the ${settings.weatherMinScore}/100 floor) for ${whole ? 'the whole block' : `${cloudyMin} min of it`}: advisory — check the sky (sky_check) before and during it; if ${target} is obscured, night_plan action=obscured cause=cloud for an alternate (or night_plan action=alternates for a clear part of the sky); capture settings favour shorter subs so a passing cloud costs less`,
    };
  };
  for (const r of runs.sort((a, b) => a.startIdx - b.startIdx)) {
    if (r.startIdx > cursor) pushGap(cursor, r.startIdx);
    blocks.push(blockOf(r, `${prefix}${blocks.length}`));
    cursor = r.endIdx;
  }
  if (cursor < n) pushGap(cursor, n);

  function blockOf(r: Run, id: string): Block {
    const { cv } = r;
    const a = r.startIdx;
    const b = r.endIdx;
    const alts = Array.from(cv.alt.slice(a, b));
    let moonUp = 0;
    let minSep = 180;
    for (let j = a; j < b; j++) {
      if (allSlots[j].moonAlt > MOON_HORIZON) {
        moonUp += SLOT_MIN;
        minSep = Math.min(minSep, cv.moonSep[j]);
      }
    }
    const merit = alts.length ? Array.from(cv.merit.slice(a, b)).reduce((p, q) => p + q, 0) / alts.length : 0;
    const q = quadrantOf(cv.az[Math.floor((a + b - 1) / 2)]);
    const c = cv.c;
    const why: string[] = [];
    if (r.pinned) why.push('pinned');
    if (c.source === 'program') {
      const left = Math.max(0, (c.goalMin ?? 0) - (c.collectedMin ?? 0));
      why.push(`program, priority ${c.priority ?? 3}`, left > 0 ? `${Math.round(left)} of ${c.goalMin} min still to collect` : 'goal met, collecting more');
      if (cv.season && cv.season.urgency >= 0.5) why.push(`its season is closing${cv.season.endsAround ? ` (usable until about ${cv.season.endsAround})` : ''}`);
    } else if (fillerInProgress(c)) why.push(`filler in progress (${Math.round(c.collectedMin ?? 0)} of ${c.goalMin} min collected, planner score ${Math.round(c.fillerScore ?? 0)})`);
    else why.push(`filler (planner score ${Math.round(c.fillerScore ?? 0)})`);
    why.push(`alt ${Math.round(alts[0])}°→${Math.round(alts[alts.length - 1])}° (max ${Math.round(Math.max(...alts))}°), ${q}`);
    if (moonUp) why.push(`Moon up ${moonUp} min, ≥${Math.round(minSep)}° away`);
    const clouds = cloudsOf(a, b, c.displayName);
    if (clouds) why.push(clouds.advisory);
    return {
      id,
      kind: 'target',
      start: Math.max(allSlots[a].t, from),
      end: Math.min(allSlots[b - 1].t + SLOT_MS, input.end.getTime()),
      target: { key: c.key, name: c.name, displayName: c.displayName, gotoName: c.gotoName, raHours: c.raHours, decDeg: c.decDeg, source: c.source, programId: c.programId, filter: c.filter, mosaic: c.mosaic, notes: c.notes || undefined },
      overheadMin: r.overheadMin,
      expectedMin: Math.round(r.expectedMin),
      alt: { start: r1(alts[0]), end: r1(alts[alts.length - 1]), max: r1(Math.max(...alts)) },
      az: { start: Math.round(cv.az[a]), end: Math.round(cv.az[b - 1]) },
      quadrant: q,
      moon: moonUp ? { sepDeg: Math.round(minSep), upMin: moonUp, illumPct: Math.round(illum * 100) } : undefined,
      sky: meanSky(a, b),
      merit: Math.round(merit * 100) / 100,
      pinned: r.pinned || undefined,
      clouds,
      reason: why.join('; '),
      alternates: alternatesFor(cvs, cv, a, b, minBlockSlots),
    };
  }

  function alternatesFor(all: Curve[], own: Curve | null, a: number, b: number, minSlots: number): Alternate[] {
    // where things stand when the block starts: on a long block the middle can be another part of the sky
    const atIdx = a;
    const ownQ = own ? quadrantOf(own.az[atIdx]) : null;
    const ownAz = own ? own.az[atIdx] : null;
    const rows: Alternate[] = [];
    /** new fillers rank after the program and the fillers in progress; azimuth at the block's start */
    const info = new Map<Alternate, { newFiller: boolean; azMid: number }>();
    for (const cv of all) {
      if (cv === own) continue;
      let k = 0;
      for (let j = a; j < n && usable(cv, j); j++) k++;
      if (k < Math.min(minSlots, b - a)) continue;
      if (cv.c.source === 'program' && base(cv) <= 0) continue;
      const meanMerit = Array.from(cv.merit.slice(a, a + k)).reduce((p, q) => p + q, 0) / k;
      const q = quadrantOf(cv.az[atIdx]);
      const c = cv.c;
      const row: Alternate = {
        key: c.key,
        displayName: c.displayName,
        gotoName: c.gotoName,
        raHours: c.raHours,
        decDeg: c.decDeg,
        source: c.source,
        quadrant: q,
        az: Math.round(cv.az[a]),
        alt: Math.round(cv.alt[a]),
        usableMin: k * SLOT_MIN,
        value: Math.round(Math.max(base(cv), 0.05) * meanMerit * 100) / 100,
        reason: `${c.source === 'program' ? `program (priority ${c.priority ?? 3})` : fillerInProgress(c) ? 'filler in progress' : 'filler'}, ${q} at alt ${Math.round(cv.alt[a])}°, usable ${Math.round((k * SLOT_MIN) / 6) / 10} h`,
      };
      rows.push(row);
      info.set(row, { newFiller: c.source === 'filler' && !fillerInProgress(c), azMid: cv.az[atIdx] });
    }
    const rank = (r: Alternate) => (info.get(r)!.newFiller ? 1 : 0);
    rows.sort((x, y) => rank(x) - rank(y) || y.value - x.value);
    const azClear = (r: Alternate) => ownAz !== null && Math.abs(((info.get(r)!.azMid - ownAz + 540) % 360) - 180) >= OWN_QUADRANT_AZ_CLEAR;
    const out: Alternate[] = [];
    const seen = new Set<Quadrant>();
    // the best of each other quadrant (cloud over part of the sky), then one in the block's own quadrant
    // but around the sky from it (a vertical obstruction), then whatever is left by value
    for (const pass of [0, 1, 2]) {
      for (const r of rows) {
        if (out.length >= ALTERNATES || out.includes(r)) continue;
        if (pass === 0 && (seen.has(r.quadrant) || r.quadrant === ownQ)) continue;
        if (pass === 1 && (r.quadrant !== ownQ || seen.has(r.quadrant) || !azClear(r))) continue;
        seen.add(r.quadrant);
        out.push(r);
      }
    }
    return out;
  }

  // ---- outlook per program target
  const outlook: TargetOutlook[] = [];
  for (const cv of cvs.filter((x) => x.c.source === 'program')) {
    const c = cv.c;
    const planned = blocks.filter((b) => b.target?.key === c.key).reduce((p, b) => p + b.expectedMin, 0);
    let use = 0;
    let bestFrom: number | null = null;
    let bestUntil: number | null = null;
    let run = 0;
    let runFrom = 0;
    let bestRun = 0;
    for (let i = firstIdx; i < n; i++) {
      // usable here: up, the Moon allowing it, and the forecast above the floor
      if (cv.merit[i] > 0 && !allSlots[i].cloudy) {
        use += SLOT_MIN;
        if (!run) runFrom = allSlots[i].t;
        run++;
        if (run > bestRun) {
          bestRun = run;
          bestFrom = runFrom;
          bestUntil = Math.min(allSlots[i].t + SLOT_MS, input.end.getTime());
        }
      } else run = 0;
    }
    const goal = c.goalMin ?? 0;
    const collectedMin = Math.round(c.collectedMin ?? 0);
    const left = Math.max(0, goal - collectedMin);
    const anyGeom = cv.geom.slice(firstIdx).some(Boolean);
    const anyMoon = cv.geomMoon.slice(firstIdx).some(Boolean);
    const anyHeld = holds.some((h) => (h.kind === 'hold' || h.kind === 'skip') && h.target === c.key && (h.until === null || h.until > from));
    let status: TargetOutlook['status'];
    let reason: string;
    if (planned > 0) {
      status = 'scheduled';
      const bs = blocks.filter((b) => b.target?.key === c.key);
      reason = `${bs.map((b) => `${hhmm(b.start)}–${hhmm(b.end)}`).join(', ')}: about ${Math.round(planned)} min${left > 0 ? `, ${Math.max(0, Math.round(left - planned))} min to go after tonight` : ''}`;
    } else if (left <= 0 && !c.keepCollecting) {
      status = 'complete';
      reason = `goal of ${goal} min reached (${collectedMin} min collected)`;
    } else if (!anyGeom) {
      status = 'not-up';
      reason = `not above the limits tonight (minimum altitude ${Math.max(settings.minAltitude, c.minAltitude ?? 0)}°${settings.useHorizon && input.horizon ? ' and the obstruction map' : ''})`;
    } else if (!anyMoon) {
      status = 'moon';
      reason = `the Moon (${Math.round(illum * 100)}%) is too close whenever it is up`;
    } else if (!use) {
      status = 'weather';
      reason = 'up, but the forecast is below the floor whenever it is (advisory: it can still be planned then, other targets made more of those hours)';
    } else if (anyHeld) {
      status = 'held';
      reason = 'held: ' + holds.filter((h) => h.target === c.key).map((h) => h.reason).join('; ');
    } else {
      status = 'outcompeted';
      reason = `usable ${Math.round(use / 6) / 10} h tonight (best ${hhmm(bestFrom)}–${hhmm(bestUntil)}), but other targets made more of those hours`;
    }
    outlook.push({
      key: c.key,
      programId: c.programId,
      displayName: c.displayName,
      gotoName: c.gotoName,
      source: c.source,
      priority: c.priority,
      goalMin: goal,
      collectedMin,
      plannedMin: Math.round(planned),
      remainingMin: Math.max(0, Math.round(left - planned)),
      usableMin: use,
      status,
      reason,
      bestFrom,
      bestUntil,
      season: cv.season ?? undefined,
    });
  }
  for (const x of input.excluded ?? []) outlook.push({ source: 'program', plannedMin: 0, remainingMin: x.goalMin !== undefined ? Math.max(0, x.goalMin - x.collectedMin) : null, usableMin: 0, bestFrom: null, bestUntil: null, ...x });

  // ---- history: the night so far, from the plan that was in force
  // only this window's: a block of another night (a plan filed under the wrong night) is not history
  const kept = (input.history ?? [])
    .filter((b) => b.end > input.start.getTime() && b.start < from)
    .map((b) => {
      const end = Math.min(b.end, from);
      // a block cut short by the re-plan yields its share of what it was planned for
      const share = b.end > b.start ? Math.max(0, (end - b.start) / 60e3 - b.overheadMin) / Math.max(1, (b.end - b.start) / 60e3 - b.overheadMin) : 0;
      return { ...b, end, past: true, expectedMin: Math.round(b.expectedMin * Math.min(1, share)) };
    });
  const first = blocks[0];
  const last = kept[kept.length - 1];
  if (first && last && first.kind === last.kind && first.target?.key === last.target?.key && last.end >= first.start - 1000) {
    first.start = last.start;
    kept.pop();
  }
  if (!input.conditions || !settings.useForecast) notes.push('no forecast: scheduled on geometry and the Moon alone');
  if (!input.candidates.some((c) => c.source === 'program')) notes.push('the program is empty: the night is filled from the catalog planner (add targets in the Plan tab)');

  const shown = new Set([...blocks, ...kept].map((b) => b.target?.key).filter(Boolean));
  const tracks = cvs.filter((cv) => cv.c.source === 'program' || shown.has(cv.c.key)).map((cv) => ({ key: cv.c.key, displayName: cv.c.displayName, source: cv.c.source, alt: Array.from(cv.alt, (a) => Math.round(a)) }));
  return {
    slots: allSlots,
    tracks,
    blocks: [...kept, ...blocks].filter((b) => b.end > b.start),
    outlook,
    moon: { illumPct: Math.round(illum * 100), daysFromFull: r1(daysFromFull(illum)) },
    notes,
  };
}

/**
 * Rank alternates for a moment outside the plan's blocks (night_plan action=alternates).
 *
 * The agent asks for these after it looked at the sky (sky_check), often because the block's
 * target is clouded. An hour the forecast puts below its floor is advisory and still planned, so
 * there are rows; they say the forecast has it below the floor and that the sky check decides.
 */
export function alternatesAt(input: SolveInput, at: Date, opts: { exclude?: string[]; quadrant?: Quadrant; limit?: number } = {}): Alternate[] {
  const rows = alternateRows(input, at, opts);
  const c = input.settings.useForecast ? input.conditions?.(at) : undefined;
  if (!c || !Number.isFinite(c.observability) || c.observability >= input.settings.weatherMinScore) return rows;
  const note = `; the forecast has this hour below ${input.settings.weatherMinScore}/100 (advisory: the sky check decides)`;
  return rows.map((r) => ({ ...r, reason: r.reason + note }));
}

function alternateRows(input: SolveInput, at: Date, opts: { exclude?: string[]; quadrant?: Quadrant; limit?: number }): Alternate[] {
  const sub: SolveInput = { ...input, from: at, history: [] };
  const solved = solveNight({ ...sub, candidates: input.candidates.filter((c) => !(opts.exclude ?? []).includes(c.key)) });
  const b = solved.blocks.find((x) => !x.past && x.start <= at.getTime() + SLOT_MS && x.end > at.getTime());
  const fromBlock = b?.target ? [{ key: b.target.key, displayName: b.target.displayName, gotoName: b.target.gotoName, raHours: b.target.raHours, decDeg: b.target.decDeg, source: b.target.source, quadrant: b.quadrant!, az: b.az?.start ?? 0, alt: Math.round(b.alt?.start ?? 0), usableMin: Math.round((b.end - b.start) / 60e3), value: 99, reason: `the plan's best pick from now: ${b.reason}` } satisfies Alternate] : [];
  const rows = [...fromBlock, ...(b?.alternates ?? [])].filter((r) => !opts.quadrant || r.quadrant === opts.quadrant);
  return rows.slice(0, opts.limit ?? 5);
}
