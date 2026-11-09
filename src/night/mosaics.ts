/**
 * Mosaic projects: one target, one fixed set of panels, and what each panel has collected.
 *
 * The layout is decided once and kept, so a later night continues the same panels. The integration
 * is never stored here: each panel is shot under its own name, so the journal and the library
 * count it exactly as they count a target (kept subs, each session once, surviving a restart).
 * All that is kept is what AstroPhoto Studio measured afterwards: the frames its own grading refused
 * and the panels whose sky it found missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';
import { findObject } from '../astro/catalog.js';
import { targetKey } from '../astro/rest.js';
import { chooseExecution, footprintOf, layoutMosaic, targetFootprint, type Execution, type FieldSize, type Footprint, type MountMode, type NativeMosaic, type Orientation } from '../astro/mosaic.js';
import { sameFilter } from '../astro/acquisition/devices.js';
import { allLibrarySessions, sessionFilter } from '../library/sessions.js';
import type { Collected } from './progress.js';
import { effectiveSwitch, type PlanSettings, type ProgramTarget } from './program.js';

const log = logger('mosaic');

/** The minutes spent on a panel before moving on, so the panels stay balanced without a GoTo every few minutes. */
export const PANEL_CHUNK_MIN = 30;
/** Fields within this fraction are the same optics. */
const SAME_FIELD = 0.02;

export interface MosaicPanel {
  id: string;
  /** the name it is shot under (it names the session folder) */
  name: string;
  raHours: number;
  decDeg: number;
  /** seconds of its collected integration Studio's grading refused */
  rejectedS?: number;
  /** Studio found sky missing near this panel, or could not use it */
  revisit?: boolean;
  /** Studio's measurement of where the panel landed */
  offsetArcmin?: number;
}

export interface MosaicProject {
  id: string;
  targetKey: string;
  programId?: string;
  name: string;
  displayName: string;
  gotoName: string;
  execution: Execution;
  /** native only: the frames covered along each axis, for the firmware */
  nativeScale?: { x: number; y: number };
  overlap: number;
  goalPerPanelS: number;
  filter: string;
  field: FieldSize;
  orientation: Orientation;
  footprint: Footprint;
  nx: number;
  ny: number;
  panels: MosaicPanel[];
  createdAt: string;
  studio?: { at: string; jobId?: string; coveragePct?: number; outputs?: string[] };
}

export interface PanelProgress extends MosaicPanel {
  acceptedS: number;
  remainingS: number;
  done: boolean;
}

export interface MosaicProgress {
  panels: PanelProgress[];
  acceptedS: number;
  goalS: number;
  remainingS: number;
  percent: number;
  complete: boolean;
  /** every panel has its integration, whatever Studio says about its coverage */
  integrated: boolean;
}

const file = () => path.join(config.paths.data, 'plan', 'mosaics.json');
const isProject = (x: unknown): x is MosaicProject => {
  const p = x as MosaicProject | null;
  return !!p && typeof p.id === 'string' && typeof p.targetKey === 'string' && Array.isArray(p.panels) && p.panels.length > 0;
};

export function loadProjects(): MosaicProject[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read the mosaic projects: ${errMsg(e)}`);
    return [];
  }
  try {
    const list = (JSON.parse(raw) as { projects?: unknown }).projects;
    return Array.isArray(list) ? list.filter(isProject) : [];
  } catch (e) {
    // the panels of a mosaic in progress must not be forgotten by overwriting the file: it is set aside
    const aside = `${file()}.bad-${Date.now()}`;
    log.warn(`the mosaic projects are not valid JSON (${errMsg(e)}): moved to ${aside}`);
    try {
      fs.renameSync(file(), aside);
    } catch {
      /* the next save replaces it */
    }
    return [];
  }
}

function saveProjects(projects: MosaicProject[]): void {
  writeFileAtomic(file(), JSON.stringify({ projects }, null, 1));
}

export function findProject(ref: string, projects = loadProjects()): MosaicProject | undefined {
  const key = targetKey(ref);
  return projects.find((p) => p.id === ref) ?? projects.find((p) => p.targetKey === key);
}

const sameField = (a: FieldSize, b: FieldSize) => Math.abs(a.w - b.w) <= SAME_FIELD * b.w && Math.abs(a.h - b.h) <= SAME_FIELD * b.h;

/** The project of a target for these optics, if one exists. */
export function existingProject(key: string, field: FieldSize, projects = loadProjects()): MosaicProject | undefined {
  return projects.find((p) => p.targetKey === key && sameField(p.field, field));
}

export interface PlanContext {
  field: FieldSize;
  mount: MountMode;
  eqMode?: boolean;
  native?: NativeMosaic;
  settings: Pick<PlanSettings, 'mosaicOverlapPct' | 'mosaicMaxPanels' | 'mosaicAllowNative' | 'mosaicCameraAngleDeg'>;
  override?: Partial<FieldSize>;
  overlapPct?: number;
  cameraAngleDeg?: number | null;
}

/** The layout a target would get, without keeping anything. Null: the catalog has no size for it. */
export function previewLayout(t: Pick<ProgramTarget, 'name' | 'raHours' | 'decDeg'>, c: PlanContext) {
  const o = findObject(t.name);
  const angle = c.cameraAngleDeg === undefined ? c.settings.mosaicCameraAngleDeg : c.cameraAngleDeg;
  const footprint = targetFootprint({ ...(o ? footprintOf(o) : {}), raHours: t.raHours, decDeg: t.decDeg }, angle, c.override);
  if (!footprint) return null;
  const layout = layoutMosaic(footprint, c.field, { overlap: (c.overlapPct ?? c.settings.mosaicOverlapPct) / 100, mount: c.mount, cameraAngleDeg: angle });
  return { layout, execution: chooseExecution(layout, c.field, c.native, { allowNative: c.settings.mosaicAllowNative, eqMode: c.eqMode }) };
}

/** A panel's name: the target's, plus the panel. It names the session folder, so the library knows the panel by it. */
export const panelName = (gotoName: string, id: string) => `${gotoName} ${id}`;

/** Keep a target's project, creating it (once) when the target needs one. Null when it fits one frame, or is over the panel limit. */
export function ensureProject(t: ProgramTarget, c: PlanContext, today: string): MosaicProject | null {
  const projects = loadProjects();
  const key = targetKey(t.name);
  const have = existingProject(key, c.field, projects);
  if (have) return have;
  const plan = previewLayout(t, c);
  if (!plan?.layout.needed) return null;
  const { layout, execution } = plan;
  if (layout.panels.length > c.settings.mosaicMaxPanels) {
    log.warn(`${t.displayName}: a ${layout.nx} × ${layout.ny} mosaic is over the limit of ${c.settings.mosaicMaxPanels} panels: not made`);
    return null;
  }
  const taken = new Set(projects.map((p) => p.id));
  const base = `${key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-mosaic`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const native = execution.execution === 'native';
  const p: MosaicProject = {
    id,
    targetKey: key,
    programId: t.id,
    name: t.name,
    displayName: t.displayName,
    gotoName: t.gotoName,
    execution: execution.execution,
    ...(execution.scale ? { nativeScale: execution.scale } : {}),
    overlap: layout.overlap,
    goalPerPanelS: Math.round(t.goalMin * 60),
    filter: t.filter || 'auto',
    field: c.field,
    orientation: layout.orientation,
    footprint: layout.footprint,
    nx: layout.nx,
    ny: layout.ny,
    // the firmware moves between its own fields: to the scheduler that is one set of subs, at the footprint's centre
    panels: native ? [{ id: 'P1', name: t.gotoName, raHours: t.raHours, decDeg: t.decDeg }] : layout.panels.map((x) => ({ id: x.id, name: panelName(t.gotoName, x.id), raHours: x.raHours, decDeg: x.decDeg })),
    createdAt: today,
  };
  saveProjects([...projects, p]);
  log.info(`${t.displayName}: ${native ? 'native mosaic' : `${layout.nx} × ${layout.ny} mosaic`} ${id} (${execution.why})`);
  return p;
}

/** The project in force for a program target, by the owner's settings (global, then the target's own). */
export function isMosaicOn(t: Pick<ProgramTarget, 'mosaic'>, settings: Pick<PlanSettings, 'mosaicEnabled'>): boolean {
  return effectiveSwitch(settings.mosaicEnabled, t.mosaic);
}

export function replaceProject(p: MosaicProject): void {
  saveProjects(loadProjects().map((x) => (x.id === p.id ? p : x)));
}

/** Forget a project with nothing collected (its layout may be chosen again). */
export function deleteProject(id: string): void {
  saveProjects(loadProjects().filter((x) => x.id !== id));
}

/** Where every panel stands, from what the journal and the library have collected. */
export function mosaicProgress(p: MosaicProject, got: ReadonlyMap<string, Pick<Collected, 'totalMin'>>): MosaicProgress {
  const panels = p.panels.map((x): PanelProgress => {
    const acceptedS = Math.max(0, (got.get(targetKey(x.name))?.totalMin ?? 0) * 60 - (x.rejectedS ?? 0));
    const short = Math.max(0, p.goalPerPanelS - acceptedS);
    const remainingS = x.revisit ? Math.max(short, PANEL_CHUNK_MIN * 60) : short;
    return { ...x, acceptedS, remainingS, done: remainingS <= 0 };
  });
  const goalS = p.goalPerPanelS * panels.length;
  const remainingS = panels.reduce((a, x) => a + x.remainingS, 0);
  const acceptedS = Math.max(0, goalS - remainingS);
  return {
    panels,
    acceptedS,
    goalS,
    remainingS,
    percent: goalS ? Math.round((acceptedS / goalS) * 1000) / 10 : 0,
    complete: panels.every((x) => x.done),
    integrated: panels.every((x) => x.acceptedS >= p.goalPerPanelS),
  };
}

export interface NextPanel {
  panel: PanelProgress;
  /** minutes of stacking before asking again */
  stackMinutes: number;
}

/**
 * The panel to shoot now: those Studio wants again first, then the one furthest behind, staying on
 * the current panel for a chunk so the balance does not cost a GoTo every few minutes.
 */
export function nextPanel(prog: MosaicProgress, opts: { currentId?: string; keepCollecting?: boolean } = {}): NextPanel | null {
  const open = prog.panels.filter((x) => !x.done);
  const pool = open.length ? open : opts.keepCollecting ? prog.panels : [];
  if (!pool.length) return null;
  const least = Math.min(...pool.map((x) => x.acceptedS));
  const current = pool.find((x) => x.id === opts.currentId);
  const chunkS = PANEL_CHUNK_MIN * 60;
  const panel = current && !pool.some((x) => x.revisit && !current.revisit) && current.acceptedS - least < chunkS ? current : [...pool].sort((a, b) => Number(!!b.revisit) - Number(!!a.revisit) || a.acceptedS - b.acceptedS)[0];
  return { panel, stackMinutes: open.length ? Math.max(1, Math.ceil(Math.min(chunkS, panel.remainingS) / 60)) : PANEL_CHUNK_MIN };
}

/** The key of the program target a session name belongs to: its parent's for a panel. */
export function parentKey(name: string, projects = loadProjects()): string {
  const key = targetKey(name);
  return projects.find((p) => p.panels.some((x) => targetKey(x.name) === key))?.targetKey ?? key;
}

/** The project and panel a session's target name is, if it is a panel of one. */
export function panelOf(name: string, projects = loadProjects()): { project: MosaicProject; panel: MosaicPanel } | null {
  const key = targetKey(name);
  for (const project of projects) {
    const panel = project.panels.find((x) => targetKey(x.name) === key);
    if (panel) return { project, panel };
  }
  return null;
}

/** The filter each panel counts through (the project's: an Astro night does not count towards a Duo-Band mosaic). */
export function panelFilters(projects = loadProjects()): Array<[string, string]> {
  return projects.filter((p) => p.filter !== 'auto').flatMap((p) => p.panels.map((x): [string, string] => [targetKey(x.name), p.filter]));
}

export interface MosaicManifest {
  project_id: string;
  target: string;
  execution: Execution;
  overlap: number;
  footprint: { ra_deg: number; dec_deg: number; width_arcmin: number; height_arcmin: number; angle_deg: number };
  panels: Array<{ id: string; ra_deg: number; dec_deg: number; sessions: string[] }>;
}

/** What Studio is told about a project: the sky it should cover, and the library sessions of each panel. */
export function manifestFor(p: MosaicProject): MosaicManifest {
  const sessions = allLibrarySessions();
  return {
    project_id: p.id,
    target: p.displayName,
    execution: p.execution,
    overlap: p.overlap,
    footprint: { ra_deg: p.footprint.raHours * 15, dec_deg: p.footprint.decDeg, width_arcmin: p.footprint.w, height_arcmin: p.footprint.h, angle_deg: p.footprint.angleDeg },
    panels: p.panels.map((x) => ({
      id: x.id,
      ra_deg: x.raHours * 15,
      dec_deg: x.decDeg,
      sessions: sessions.filter((s) => targetKey(s.target) === targetKey(x.name) && s.camera === 'tele' && (p.filter === 'auto' || sameFilter(sessionFilter(s.folder), p.filter))).map((s) => s.folder),
    })),
  };
}

export interface StudioMosaicReport {
  panels?: Array<{ id: string; accepted_sec?: number; input_sec?: number; offset_arcmin?: number; status?: string }>;
  coverage?: { percent?: number; revisit?: string[] };
}

/** Keep what Studio measured: the feedback that decides what still has to be shot. */
export function applyStudioReport(projectId: string, report: StudioMosaicReport, ref: { jobId?: string; outputs?: string[] }, now = new Date()): MosaicProject | null {
  const p = findProject(projectId);
  if (!p) return null;
  const byId = new Map((report.panels ?? []).map((x) => [x.id, x]));
  const revisit = new Set(report.coverage?.revisit ?? []);
  const panels = p.panels.map((x) => {
    const r = byId.get(x.id);
    return {
      ...x,
      // the report covers every session of the panel, so it replaces the last one
      rejectedS: r ? Math.max(0, (r.input_sec ?? 0) - (r.accepted_sec ?? 0)) : x.rejectedS,
      offsetArcmin: r?.offset_arcmin ?? x.offsetArcmin,
      revisit: revisit.has(x.id) || undefined,
    };
  });
  const next: MosaicProject = { ...p, panels, studio: { at: now.toISOString(), jobId: ref.jobId, coveragePct: report.coverage?.percent, outputs: ref.outputs } };
  replaceProject(next);
  return next;
}
