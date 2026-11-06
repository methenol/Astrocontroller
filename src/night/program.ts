/**
 * The owner's program: the targets they want collected and for how long, and how the nightly plan
 * is to be made (night/solver.ts). Both are the owner's settings, edited in the Plan tab or by the
 * agent on their request (plan_program), and kept in DATA_DIR/plan/.
 *
 * A program target is a goal, not a booking: the solver works it into whichever nights and hours
 * suit it best, and stops scheduling it once the integration collected (library + journal,
 * night/progress.ts) reaches the goal, unless the owner asked to keep collecting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';
import { findObject, displayName, gotoLabel } from '../astro/catalog.js';
import { restSettings } from '../astro/rest.js';

const log = logger('program');

export const PRIORITIES = [1, 2, 3, 4, 5] as const;
export const PRIORITY_LABEL: Record<number, string> = { 1: 'low', 2: 'below normal', 3: 'normal', 4: 'high', 5: 'top' };

export interface ProgramTarget {
  id: string;
  /** the catalog id ("NGC 224"), or the owner's name for a custom position */
  name: string;
  displayName: string;
  /** the name goto_target is given (it names the session folder) */
  gotoName: string;
  raHours: number;
  decDeg: number;
  /** total integration wanted, minutes (summed over nights) */
  goalMin: number;
  /** 1 low … 5 top */
  priority: number;
  /** false: kept in the list, never scheduled */
  enabled: boolean;
  /** keep scheduling it after the goal is met (at a reduced value) */
  keepCollecting: boolean;
  /** this target's own minimum altitude, above the plan's */
  minAltitude?: number;
  /** "auto" (the planner's best of the scope's filters) or a filter name */
  filter: string;
  /** only schedule it from this date (YYYY-MM-DD), e.g. after a moon phase */
  notBefore?: string;
  /** the owner's note to the agent about this target (framing, mosaic, filter…) */
  notes: string;
  addedAt: string;
}

const MoonRule = z.object({
  /** the separation required at full Moon, degrees */
  distanceDeg: z.number().min(0).max(180),
  /** how fast the requirement relaxes away from full Moon: days from full at which it halves */
  widthDays: z.number().min(0.5).max(30),
});

export const PlanSettingsSchema = z.object({
  /** where the plan's night starts and ends: a twilight, or a local HH:MM */
  windowStart: z.string().regex(/^(astro-dusk|nautical-dusk|sunset|\d{1,2}:\d{2})$/),
  windowEnd: z.string().regex(/^(astro-dawn|nautical-dawn|sunrise|\d{1,2}:\d{2})$/),
  /** minutes added to the start and end (negative = earlier) */
  startOffsetMin: z.number().int().min(-180).max(180),
  endOffsetMin: z.number().int().min(-180).max(180),
  minAltitude: z.number().min(0).max(80),
  /** the site's obstruction map (map_obstructions) and tonight's blocked views */
  useHorizon: z.boolean(),
  /** a target is only put in a block at least this long */
  minBlockMin: z.number().int().min(10).max(240),
  /** 0 = no limit: a target keeps its block while it stays the best */
  maxBlockMin: z.number().int().min(0).max(720),
  /** minutes a switch costs (GoTo, centring, focus); null = learned from the journal */
  overheadMin: z.number().min(0).max(60).nullable(),
  /** fraction of stacking time that becomes integration (sub cadence × frames kept); null = learned */
  efficiency: z.number().min(0.1).max(1).nullable(),
  /** how much better (fraction) another target must be before the plan leaves the current one */
  switchHysteresis: z.number().min(0).max(2),
  /** forecast observability (0–100) below which an hour is not scheduled */
  weatherMinScore: z.number().min(0).max(100),
  useForecast: z.boolean(),
  moonAvoidance: z.boolean(),
  /** broadband targets (galaxies, clusters, reflection nebulae) and emission targets through a line filter */
  moonBroadband: MoonRule,
  moonNarrowband: MoonRule,
  /** fill hours no program target can use with the catalog planner's best targets */
  fillers: z.boolean(),
  fillerTypes: z.array(z.string()),
  /** the catalog filter the fillers (and the Plan tab's suggestions) are drawn with: frame fill, magnitude, size */
  fillerMinFovPercent: z.number().min(0).max(100),
  fillerMaxMagnitude: z.number().min(0).max(20).nullable(),
  fillerMinSizeArcmin: z.number().min(0).max(600).nullable(),
  fillerMaxSizeArcmin: z.number().min(0).max(1200).nullable(),
  /** a filler's value relative to a normal-priority program target (0–1) */
  fillerWeight: z.number().min(0).max(1),
});
export type PlanSettings = z.infer<typeof PlanSettingsSchema>;

export const PLAN_DEFAULTS: PlanSettings = {
  windowStart: 'astro-dusk',
  windowEnd: 'astro-dawn',
  startOffsetMin: 0,
  endOffsetMin: 0,
  minAltitude: config.observer.minAltitudeDeg,
  useHorizon: true,
  minBlockMin: 45,
  maxBlockMin: 0,
  overheadMin: null,
  efficiency: null,
  switchHysteresis: 0.2,
  weatherMinScore: 35,
  useForecast: true,
  moonAvoidance: true,
  moonBroadband: { distanceDeg: 110, widthDays: 10 },
  moonNarrowband: { distanceDeg: 45, widthDays: 6 },
  fillers: true,
  fillerTypes: [],
  fillerMinFovPercent: 10,
  fillerMaxMagnitude: null,
  fillerMinSizeArcmin: null,
  fillerMaxSizeArcmin: null,
  fillerWeight: 0.5,
};

export const ProgramTargetInput = z.object({
  name: z.string().min(1).max(120),
  /** a custom position (J2000) when the name is not in the catalog */
  raHours: z.number().min(0).lt(24).optional(),
  decDeg: z.number().min(-90).max(90).optional(),
  goalMin: z.number().min(0).max(100_000).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  enabled: z.boolean().optional(),
  keepCollecting: z.boolean().optional(),
  minAltitude: z.number().min(0).max(85).nullable().optional(),
  filter: z.string().max(40).optional(),
  notBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(2000).optional(),
});
export type ProgramTargetInput = z.infer<typeof ProgramTargetInput>;

const DEFAULT_GOAL_MIN = 180;
const DEFAULT_PRIORITY = 3;

const dir = () => path.join(config.paths.data, 'plan');
const programFile = () => path.join(dir(), 'program.json');
const settingsFile = () => path.join(dir(), 'settings.json');

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${file}: ${errMsg(e)}`);
    return undefined;
  }
}

const isTarget = (t: unknown): t is ProgramTarget => {
  const x = t as ProgramTarget;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && Number.isFinite(x.raHours) && Number.isFinite(x.decDeg) && Number.isFinite(x.goalMin) && Number.isFinite(x.priority);
};

/** The owner's targets, in the order they added them. A bad file is an empty program, never a failure. */
export function loadProgram(): ProgramTarget[] {
  const raw = readJson(programFile());
  const list = Array.isArray((raw as { targets?: unknown })?.targets) ? (raw as { targets: unknown[] }).targets : [];
  return list.filter(isTarget).map((t) => ({ ...t, keepCollecting: t.keepCollecting ?? false, enabled: t.enabled ?? true, filter: t.filter ?? 'auto', notes: t.notes ?? '' }));
}

function saveProgram(targets: ProgramTarget[]): void {
  writeFileAtomic(programFile(), JSON.stringify({ targets }, null, 1));
}

/** The plan settings: the saved ones over the defaults, each field kept only when valid. */
export function loadSettings(): PlanSettings {
  const raw = readJson(settingsFile());
  const out: PlanSettings = { ...PLAN_DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const field = PlanSettingsSchema.shape[k as keyof PlanSettings];
      if (field && field.safeParse(v).success) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export function saveSettings(patch: Partial<PlanSettings>): PlanSettings {
  const next = PlanSettingsSchema.parse({ ...loadSettings(), ...patch });
  writeFileAtomic(settingsFile(), JSON.stringify(next, null, 1));
  return next;
}

export function resetSettings(): PlanSettings {
  writeFileAtomic(settingsFile(), JSON.stringify(PLAN_DEFAULTS, null, 1));
  return { ...PLAN_DEFAULTS };
}

const newId = () => `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** A program target found by id, catalog name or any of its names. */
export function findProgramTarget(ref: string, targets = loadProgram()): ProgramTarget | undefined {
  const byId = targets.find((t) => t.id === ref);
  if (byId) return byId;
  const o = findObject(ref);
  const key = (o ? o.id : ref).trim().toLowerCase();
  return targets.find((t) => t.name.toLowerCase() === key || t.gotoName.toLowerCase() === ref.trim().toLowerCase() || t.displayName.toLowerCase() === ref.trim().toLowerCase());
}

/** Add a target (resolved through the catalog, or a custom position), or update it when it is already in the program. */
export function addTarget(input: ProgramTargetInput, today: string): ProgramTarget {
  const targets = loadProgram();
  const existing = findProgramTarget(input.name, targets);
  if (existing) return updateTarget(existing.id, input);
  const o = findObject(input.name);
  if (!o && (input.raHours === undefined || input.decDeg === undefined)) throw new Error(`"${input.name}" is not in the catalog: give its J2000 position (raHours, decDeg) to add it as a custom target`);
  const t: ProgramTarget = {
    id: newId(),
    name: o ? o.id : input.name.trim(),
    displayName: o ? displayName(o) : input.name.trim(),
    gotoName: o ? gotoLabel(o) : input.name.trim(),
    raHours: input.raHours ?? o!.raHours,
    decDeg: input.decDeg ?? o!.decDeg,
    // without a goal of its own: the integration goal of the target rest (Tonight / Plan), else three hours
    goalMin: input.goalMin ?? (restSettings().integrationTargetMin || DEFAULT_GOAL_MIN),
    priority: input.priority ?? DEFAULT_PRIORITY,
    enabled: input.enabled ?? true,
    keepCollecting: input.keepCollecting ?? false,
    minAltitude: input.minAltitude ?? undefined,
    filter: input.filter ?? 'auto',
    notBefore: input.notBefore ?? undefined,
    notes: input.notes ?? '',
    addedAt: today,
  };
  saveProgram([...targets, t]);
  log.info(`program: added ${t.displayName} (${t.goalMin} min, priority ${t.priority})`);
  return t;
}

export function updateTarget(ref: string, patch: Partial<ProgramTargetInput>): ProgramTarget {
  const targets = loadProgram();
  const t = findProgramTarget(ref, targets);
  if (!t) throw new Error(`"${ref}" is not in the program`);
  const next: ProgramTarget = {
    ...t,
    goalMin: patch.goalMin ?? t.goalMin,
    priority: patch.priority ?? t.priority,
    enabled: patch.enabled ?? t.enabled,
    keepCollecting: patch.keepCollecting ?? t.keepCollecting,
    minAltitude: patch.minAltitude === null ? undefined : (patch.minAltitude ?? t.minAltitude),
    filter: patch.filter ?? t.filter,
    notBefore: patch.notBefore === null ? undefined : (patch.notBefore ?? t.notBefore),
    notes: patch.notes ?? t.notes,
  };
  saveProgram(targets.map((x) => (x.id === t.id ? next : x)));
  return next;
}

export function removeTarget(ref: string): ProgramTarget {
  const targets = loadProgram();
  const t = findProgramTarget(ref, targets);
  if (!t) throw new Error(`"${ref}" is not in the program`);
  saveProgram(targets.filter((x) => x.id !== t.id));
  log.info(`program: removed ${t.displayName}`);
  return t;
}

/** Reorder by id (the Plan tab's drag); ids not given keep their order after the given ones. */
export function reorderProgram(ids: string[]): ProgramTarget[] {
  const targets = loadProgram();
  const rank = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...targets].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  saveProgram(sorted);
  return sorted;
}
