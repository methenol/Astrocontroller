/**
 * focus_offsets: the filter focus offsets as a tool, the same for every driver.
 *
 * - status: this device's offsets per filter (from the reference filter's best focus), how well
 *   each is known, whether the planner still wants a calibration, the job running or the last one;
 * - calibrate: the bracketed sweeps on the field the scope is on (the plan's focus-calibration
 *   block puts the scope on a star field near the zenith first), in the background — poll status;
 * - convert: a best-focus position through one filter as the equivalent through another;
 * - cancel, forget (a filter's or all brackets: a filter swapped, a bad night), show (every bracket).
 */
import { z } from 'zod';
import { calibrating, calibrationJob, cancelCalibration, convertPosition, deviceOffsets, forgetOffsets, noteDevice, offsetStatus, recordAttempt, startCalibration, type CalibrationDriver } from '../../astro/focus-offsets/index.js';
import type { NightServices } from '../../night/index.js';
import { text, type ToolFn } from './common.js';

export interface FocusOffsetContext {
  calibration: CalibrationDriver;
  night?: NightServices | null;
}

export function registerFocusOffsetTools(tool: ToolFn, ctx: FocusOffsetContext): void {
  const device = async () => {
    const d = await ctx.calibration.device();
    noteDevice(d.key, { label: d.label, reference: d.reference, filters: d.filters });
    return d;
  };
  tool(
    'focus_offsets',
    "The filter focus offsets of this telescope: how far the best focus through each filter lies from the best focus through the reference filter (the Seestar's IRCUT, the Dwarf's VIS), measured once and then applied by itself whenever the tele filter changes (set_camera_setting filter, live_stacking filter=, the quality probe): the focuser moves by the difference so a focus found through one filter stays the best through the other. action status: the offsets, how well each is known, and whether the planner still schedules a calibration. action calibrate: on the night plan's focus-calibration block, once the scope is on its star field near the zenith and focused (autofocus, star_focus) — reference, filter, reference … sweeps in the background (~5 sweeps, the Dwarf ~45 min, the Seestar ~15); poll action=status until done; the plan moves on by itself. action convert: position through from_filter → the equivalent through to_filter. action skip reason=<why>: pass on tonight's calibration block (clouded, the field blocked) — the plan goes on with collection and tries another night. action cancel | forget (filter= one filter's brackets, else all) | show (every bracket).",
    {
      action: z.enum(['status', 'calibrate', 'convert', 'skip', 'cancel', 'forget', 'show']),
      reason: z.string().optional().describe('skip: why (cloud, the field blocked)'),
      filters: z.array(z.string()).optional().describe('calibrate: only these filters (default every one but the reference)'),
      field: z.string().optional().describe("calibrate: the field the scope is on (the plan's calibration field), for the record"),
      position: z.number().optional().describe('convert: the best-focus position through from_filter'),
      from_filter: z.string().optional(),
      to_filter: z.string().optional(),
      filter: z.string().optional().describe('forget: only this filter'),
    },
    async (a) => {
      const d = await device();
      if (a.action === 'status') {
        const st = offsetStatus(d.key);
        const j = calibrationJob();
        return text({
          device: d.label,
          reference: d.reference,
          status: st.status,
          summary: st.line,
          filters: st.filters.map((f) => ({ filter: f.filter, offset: f.offset, status: f.status, brackets: f.n, scatter: f.spread, onTheMean: f.sem, perDegC: f.slopePerC ?? undefined, line: f.line })),
          job: j ?? undefined,
          lastAttempt: st.lastAttempt ?? undefined,
          next: j?.status === 'running' ? `running (${j.done}/${j.planned} sweeps, ~${j.aboutMin} min in all): poll again in a few minutes; do not stack, move or focus meanwhile` : st.status === 'settled' ? 'settled: nothing to measure; the offsets are applied on every filter change' : "the night plan schedules a focus-calibration block in the night's first clear, steady hour while it is not settled",
        });
      }
      if (a.action === 'calibrate') {
        const night = ctx.night ?? null;
        const j = await startCalibration({
          driver: ctx.calibration,
          night: () => night?.nightOf() ?? new Date().toISOString().slice(0, 10),
          field: a.field,
          filters: a.filters,
          note: (t) => {
            const n = night?.nightOf();
            if (n) night!.journal.event(n, 'focus', t, Date.now());
          },
          ended: () => night?.plan.changed('the focus calibration ended'),
        });
        night?.plan.changed('the focus calibration started');
        return text({ job: j, next: `running in the background (${j.planned} sweeps, ~${j.aboutMin} min): focus_offsets action=status until done; set duty action=next_check accordingly. Do not stack, move or focus while it runs.` });
      }
      if (a.action === 'skip') {
        if (calibrating()) throw new Error('a calibration is running: action=cancel stops it (what it measured so far is kept)');
        const night = ctx.night?.nightOf() ?? new Date().toISOString().slice(0, 10);
        const why = a.reason ?? 'skipped';
        recordAttempt(d.key, { id: `fo-skip-${Date.now().toString(36)}`, at: Date.now(), endedAt: Date.now(), night, status: 'skipped', valid: 0, note: `skipped: ${why}` });
        if (ctx.night) ctx.night.journal.event(night, 'focus', `focus offset calibration skipped tonight: ${why}`, Date.now());
        ctx.night?.plan.changed('the focus calibration was skipped');
        return text(`tonight's focus calibration skipped (${why}): the plan goes on with collection; it is scheduled again on another night`);
      }
      if (a.action === 'cancel') return text(cancelCalibration() ? 'cancelling: the sweep in progress finishes, the filter is put back' : 'no focus calibration is running');
      if (a.action === 'convert') {
        if (a.position === undefined || !a.from_filter || !a.to_filter) throw new Error('convert needs position, from_filter and to_filter');
        const st = offsetStatus(d.key);
        const from = d.filters.find((f) => f.toLowerCase() === a.from_filter!.toLowerCase()) ?? a.from_filter;
        const to = d.filters.find((f) => f.toLowerCase() === a.to_filter!.toLowerCase()) ?? a.to_filter;
        const c = convertPosition(st, a.position, from, to, ctx.calibration.tempC());
        if (!c) return text({ position: null, why: `no offset measured for ${[from, to].filter((f) => f !== d.reference).join(' / ')} on ${d.label}: ${st.line}` });
        const row = (f: string) => st.filters.find((x) => x.filter === f);
        return text({ from: `${a.position} through ${from}`, to: `${c.position} through ${to}`, shift: c.shift, known: [row(from), row(to)].filter((r) => r && r.status !== 'reference').map((r) => r!.line) });
      }
      if (a.action === 'forget') {
        const n = forgetOffsets(d.key, a.filter);
        ctx.night?.plan.changed('focus offsets forgotten');
        return text(`${n} bracket(s) forgotten${a.filter ? ` for ${a.filter}` : ''} on ${d.label}`);
      }
      const rec = deviceOffsets(d.key);
      return text({ device: d.label, reference: d.reference, measurements: rec?.measurements ?? [], attempts: rec?.attempts ?? [] });
    },
  );
}
