/**
 * Mosaics, as tools: the same for every driver. Everything here is deterministic: the layout, what
 * each panel has collected and which comes next are computed, never left to the agent.
 */
import { z } from 'zod';
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';
import type { FieldSize, MountMode, NativeMosaic } from '../../astro/mosaic.js';
import { pickDevice } from '../../astro/acquisition/devices.js';
import type { FactsSource } from '../../astro/acquisition/index.js';
import { collected } from '../../night/progress.js';
import type { NightServices } from '../../night/index.js';
import { deleteProject, ensureProject, existingProject, findProject, loadProjects, mosaicProgress, nextPanel, panelFilters, parentKey, previewLayout, type MosaicProject } from '../../night/mosaics.js';
import { findProgramTarget, loadSettings, updateTarget } from '../../night/program.js';
import { targetKey } from '../../astro/rest.js';
import { enqueueMosaic } from '../../processing/queue.js';
import { text, type ToolFn } from './common.js';

export interface MosaicDriver {
  field(): FieldSize;
  facts: FactsSource;
  /** run the firmware's own mosaic for a project made for it */
  startNative(project: MosaicProject, native: NativeMosaic & { wireScale?: number }): Promise<string>;
}

const summary = (p: MosaicProject) => ({ project: p.id, target: p.displayName, layout: `${p.nx} × ${p.ny}`, execution: p.execution, overlapPct: Math.round(p.overlap * 100), orientation: p.orientation, filter: p.filter, goalPerPanelMin: Math.round(p.goalPerPanelS / 60), coverage: p.studio?.coveragePct });

export function registerMosaicTools(tool: ToolFn, night: NightServices, d: MosaicDriver): void {
  const progressMap = () => {
    const filters = new Map(panelFilters());
    return collected(night.journal, { filterOf: (k) => filters.get(k) });
  };
  const context = async () => {
    const facts = await d.facts().catch(() => null);
    const mount: MountMode = facts?.eqMode === true ? 'eq' : facts?.eqMode === false ? 'altaz' : 'unknown';
    const native = facts ? pickDevice(facts).spec.mosaic?.native : undefined;
    return { field: d.field(), mount, eqMode: facts?.eqMode, native, settings: loadSettings() };
  };
  const need = (ref: string) => {
    const p = findProject(ref);
    if (!p) throw new Error(`no mosaic project "${ref}": plan_mosaic makes one, or mosaics are off for this target`);
    return p;
  };

  tool(
    'plan_mosaic',
    "Work out whether a program target needs a mosaic and which panels, from its catalog size and this telescope's frame. Without create it only shows the layout. create=true keeps the project (fixed from then on, so later nights continue the same panels) and turns mosaics on for the target; the program's goal is then per panel. Never invent panel positions: they come from here.",
    {
      target: z.string().describe('a program target (plan_program adds one)'),
      width_arcmin: z.number().positive().optional().describe('the sky to cover, instead of the catalog size (with height_arcmin)'),
      height_arcmin: z.number().positive().optional(),
      overlap_pct: z.number().min(5).max(50).optional(),
      camera_angle_deg: z.number().min(-180).max(180).optional().describe("the sensor's width axis, degrees from east through north, if measured (EQ mode)"),
      create: z.boolean().optional(),
      replace: z.boolean().optional().describe('with create: choose the layout again; only for a project with nothing collected'),
    },
    async (a) => {
      const t = findProgramTarget(a.target);
      if (!t) throw new Error(`"${a.target}" is not in the program: add it with plan_program first`);
      const c = { ...(await context()), override: a.width_arcmin && a.height_arcmin ? { w: a.width_arcmin, h: a.height_arcmin } : undefined, overlapPct: a.overlap_pct, cameraAngleDeg: a.camera_angle_deg };
      const key = targetKey(t.name);
      const existing = existingProject(key, c.field);
      if (existing && a.create && a.replace) {
        if (mosaicProgress(existing, progressMap()).acceptedS > 0) throw new Error(`${existing.id} has integration collected: its panels are fixed`);
        deleteProject(existing.id);
      } else if (existing) return text({ ...summary(existing), note: 'already planned: this layout is fixed', panels: existing.panels.map((x) => ({ id: x.id, name: x.name, ra_hours: x.raHours, dec_deg: x.decDeg })) });
      const plan = previewLayout(t, c);
      if (!plan) return text({ target: t.displayName, mosaic: false, reason: 'the catalog has no size for this target: give width_arcmin and height_arcmin' });
      const { layout, execution } = plan;
      const out = {
        target: t.displayName,
        needed: layout.needed,
        layout: `${layout.nx} × ${layout.ny}`,
        panels: layout.panels.length,
        footprint: `${layout.footprint.w.toFixed(1)}′ × ${layout.footprint.h.toFixed(1)}′ (${layout.footprint.source})`,
        frame: `${c.field.w.toFixed(1)}′ × ${c.field.h.toFixed(1)}′`,
        orientation: layout.orientation,
        execution: execution.execution,
        why: execution.why,
        totalHours: Math.round(((t.goalMin * layout.panels.length) / 60) * 10) / 10,
        notes: layout.notes,
      };
      if (!layout.needed) return text({ ...out, note: 'it fits one frame: no mosaic is needed' });
      if (layout.panels.length > c.settings.mosaicMaxPanels) return text({ ...out, refused: `over the limit of ${c.settings.mosaicMaxPanels} panels (the setting mosaicMaxPanels)` });
      if (!a.create) return text({ ...out, positions: layout.panels.map((x) => ({ id: x.id, ra_hours: x.raHours, dec_deg: x.decDeg })) });
      const p = ensureProject(t, c, sky.localDate(new Date(), config.observer.timezone));
      if (!p) throw new Error('the project could not be made');
      updateTarget(t.id, { mosaic: 'on' });
      night.plan.changed('a mosaic was planned');
      return text({ ...out, ...summary(p) });
    },
  );

  tool(
    'get_mosaic_progress',
    'Where mosaic projects stand: the integration accepted per panel across every night, what is left, and the sky coverage AstroPhoto Studio measured. Complete means accepted integration, not time spent.',
    { project: z.string().optional().describe('a project id or target; none: all') },
    async ({ project }) => {
      const got = progressMap();
      const list = project ? [need(project)] : loadProjects();
      return text(
        list.map((p) => {
          const m = mosaicProgress(p, got);
          return {
            ...summary(p),
            percent: m.percent,
            complete: m.complete,
            acceptedHours: Math.round((m.acceptedS / 3600) * 100) / 100,
            goalHours: Math.round((m.goalS / 3600) * 100) / 100,
            panels: m.panels.map((x) => ({ id: x.id, acceptedMin: Math.round(x.acceptedS / 60), remainingMin: Math.round(x.remainingS / 60), done: x.done, revisit: x.revisit, offsetArcmin: x.offsetArcmin })),
          };
        }),
      );
    },
  );

  tool(
    'get_next_mosaic_panel',
    "The panel to shoot now: its name, position and how many minutes to stack before asking again. goto_target with exactly that name, ra_hours and dec_deg (the name is how the panel's sessions are counted), then start_stacking. A native project is started with start_native_mosaic instead.",
    { project: z.string().describe('a project id or target') },
    async ({ project }) => {
      const p = need(project);
      const m = mosaicProgress(p, progressMap());
      const prog = findProgramTarget(p.name);
      if (p.execution === 'native') return text({ project: p.id, execution: 'native', complete: m.complete, instruction: m.complete ? 'complete' : 'start_native_mosaic; the scope moves between its fields itself' });
      const act = night.recorder.active();
      const onPanel = act && parentKey(act.session.target) === p.targetKey ? p.panels.find((x) => targetKey(x.name) === targetKey(act.session.target)) : undefined;
      const n = nextPanel(m, { currentId: onPanel?.id, keepCollecting: prog?.keepCollecting });
      if (!n) return text({ project: p.id, complete: true, instruction: 'every panel has its integration: nothing more to shoot' });
      return text({
        project: p.id,
        panel: n.panel.id,
        goto: { name: n.panel.name, ra_hours: n.panel.raHours, dec_deg: n.panel.decDeg },
        stack_minutes: n.stackMinutes,
        stay: n.panel.id === onPanel?.id,
        revisit: n.panel.revisit,
        accepted_min: Math.round(n.panel.acceptedS / 60),
        remaining_min: Math.round(n.panel.remainingS / 60),
      });
    },
  );

  tool(
    'start_native_mosaic',
    "Start the telescope's own mosaic for a project planned that way (the setting mosaicAllowNative). The firmware's scale units are not confirmed on hardware unless the device file says so: check the first frames.",
    { project: z.string() },
    async ({ project }) => {
      const p = need(project);
      if (p.execution !== 'native' || !p.nativeScale) throw new Error(`${p.id} is shot panel by panel: get_next_mosaic_panel`);
      const facts = await d.facts();
      const native = pickDevice(facts).spec.mosaic?.native;
      if (!native) throw new Error('this telescope has no native mosaic');
      if (native.requiresEq && !facts.eqMode) throw new Error('the native mosaic needs EQ mode');
      return text({ project: p.id, result: await d.startNative(p, native), warning: native.verified ? undefined : 'the scale units of this command are not confirmed on hardware' });
    },
  );

  tool(
    'process_mosaic',
    'Send a mosaic project to AstroPhoto Studio: every panel stacked, assembled on one canvas and finished as one image. Panels are kept, so only those with new data are stacked again. Studio reports accepted integration and sky coverage back; get_mosaic_progress then shows any panel to shoot again.',
    { project: z.string(), profile: z.string().optional() },
    async ({ project, profile }) => {
      const p = need(project);
      return text(enqueueMosaic(p, profile, 'agent'));
    },
  );
}
