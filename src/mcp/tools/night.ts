/**
 * The night plan, the owner's program and the journal, as tools: the same for every driver.
 * night_plan is what the agent follows on duty; plan_program edits the owner's targets on their
 * request; journal reads what happened and keeps notes.
 */
import { z } from 'zod';
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';
import type { NightServices } from '../../night/index.js';
import { addTarget, loadSettings, removeTarget, saveSettings, updateTarget, PlanSettingsSchema } from '../../night/program.js';
import { hm, dur } from '../../night/clock.js';
import type { Block } from '../../night/solver.js';
import type { PlannedNight } from '../../night/service.js';
import { summarize, type JournalNight } from '../../night/journal.js';
import { text, type ToolFn } from './common.js';

const QUADRANT = z.enum(['N', 'E', 'S', 'W']);

/** A local "HH:MM" tonight (evening or the morning after) or a local/ISO date-time, as ms. */
function timeArg(v: string | undefined, night: string): number | undefined {
  if (!v) return undefined;
  const tz = config.observer.timezone;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    let date = night;
    if (h < 12) {
      const d = new Date(`${night}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      date = d.toISOString().slice(0, 10);
    }
    return sky.parseLocal(`${date}T${m[1].padStart(2, '0')}:${m[2]}`, tz).getTime();
  }
  return sky.parseLocal(v, tz).getTime();
}

const blockLine = (b: Block) =>
  b.kind === 'target'
    ? {
        id: b.id,
        time: `${hm(b.start)}–${hm(b.end)}`,
        target: b.target!.displayName,
        goto_name: b.target!.gotoName,
        source: b.target!.source,
        filter: b.target!.filter,
        expectedMin: b.expectedMin,
        overheadMin: b.overheadMin,
        alt: b.alt ? `${Math.round(b.alt.start)}°→${Math.round(b.alt.end)}° (max ${Math.round(b.alt.max)}°)` : undefined,
        quadrant: b.quadrant,
        moon: b.moon ? `up ${b.moon.upMin} min, ≥${b.moon.sepDeg}° away (${b.moon.illumPct}%)` : 'down',
        sky: b.sky,
        past: b.past || undefined,
        pinned: b.pinned || undefined,
        reason: b.reason,
        notes: b.target!.notes,
        alternates: b.alternates.map((a) => `${a.gotoName} (${a.quadrant}, alt ${a.alt}°, ${a.source}, usable ${dur(a.usableMin)})`),
      }
    : { id: b.id, time: `${hm(b.start)}–${hm(b.end)}`, kind: b.kind, reason: b.reason, past: b.past || undefined };

function planText(p: PlannedNight) {
  return {
    night: p.night,
    window: `${hm(p.window.start)} → ${hm(p.window.end)}`,
    solved: `${hm(p.generatedAt)} (${p.reason})`,
    moon: `${p.moon.illumPct}% ${p.moon.phase}`,
    learned: `switch overhead ${p.learned.overheadMin} min (${p.learned.overheadSource}), stacking efficiency ${Math.round(p.learned.efficiency * 100)}% (${p.learned.efficiencySource})`,
    horizon: p.horizon,
    totals: p.totals,
    blocks: p.blocks.map(blockLine),
    program: p.outlook.map((o) => ({ target: o.displayName, goto_name: o.gotoName, priority: o.priority, goal: o.goalMin, collected: o.collectedMin, tonight: o.plannedMin, toGo: o.remainingMin, status: o.status, reason: o.reason })),
    holds: p.holds.map((h) => ({ id: h.id, kind: h.kind, target: h.displayName, quadrant: h.quadrant, until: h.until ? hm(h.until) : 'end of night', reason: h.reason, how: h.note, by: h.by })),
    notes: p.notes.length ? p.notes : undefined,
  };
}

export function registerNightTools(tool: ToolFn, night: NightServices): void {
  const plan = night.plan;

  tool(
    'night_plan',
    "Tonight's plan: the night from the plan's start (astronomical dusk) to its end (dawn) cut into blocks, each given to the target that makes the most of it — the owner's program first (by priority and what each still needs), catalog fillers where nothing of the program is usable — after altitude, the site's obstruction map, the Moon (separation by phase and filter), the forecast and the switch overhead. On duty, follow it. now: what to do this minute (the current block, the next, whether the scope is on plan). show: the whole night with alternates per block and why each program target is or is not on tonight's plan. replan: solve the rest of the night again now. obscured: the target is blocked (cause=obstruction: a tree, a building; also filed as a blocked view for the horizon) or clouded (cause=cloud); it is held until it clears (or for minutes / until) and the answer is the plan's new now, with a filler or another target in its place. alternates: the best targets from now in other parts of the sky (quadrant= to ask for one; exclude= names to leave out). sky_hold: a part of the sky is out (a cloud bank in the east: quadrant=E minutes=60). skip: not tonight. pin: this target from..until (default now, for the minimum block). release: lift a hold (by its id, target or quadrant).",
    {
      action: z.enum(['now', 'show', 'replan', 'obscured', 'alternates', 'sky_hold', 'skip', 'pin', 'release']),
      target: z.string().optional().describe('obscured / skip / pin / release: the target (its goto name, catalog name, or program name)'),
      cause: z.enum(['obstruction', 'cloud', 'other']).optional().describe('obscured: what blocks it (default obstruction)'),
      minutes: z.number().min(5).max(720).optional().describe('obscured / sky_hold: how long to hold'),
      from: z.string().optional().describe('pin: local HH:MM tonight or a date-time; default now'),
      until: z.string().optional().describe('obscured / sky_hold / pin: local HH:MM tonight or a date-time'),
      quadrant: QUADRANT.optional().describe('alternates / sky_hold / release: N (315–45° azimuth), E, S, W'),
      exclude: z.array(z.string()).optional().describe('alternates: targets to leave out'),
      reason: z.string().optional(),
      id: z.string().optional().describe('release: the hold id'),
    },
    async (a) => {
      const n = plan.currentNight().night;
      switch (a.action) {
        case 'now':
          return text(await plan.nowView());
        case 'show':
          return text(planText(await plan.plan()));
        case 'replan':
          return text(planText(await plan.replan(a.reason ?? 'asked by the agent')));
        case 'obscured': {
          if (!a.target) throw new Error('obscured needs target');
          const r = await plan.obscured(a.target, { cause: a.cause, minutes: a.minutes, until: timeArg(a.until, n), reason: a.reason, by: 'agent' });
          night.recorder.noteObscured(a.target, `obscured (${a.cause ?? 'obstruction'})${a.reason ? `: ${a.reason}` : ''}`);
          return text({ held: `${r.hold.displayName} until ${r.hold.until ? hm(r.hold.until) : 'the end of the night'}`, how: r.hold.note, hold: r.hold.id, now: r.now });
        }
        case 'alternates':
          return text(await plan.alternates({ quadrant: a.quadrant, exclude: a.exclude }));
        case 'sky_hold': {
          if (!a.quadrant) throw new Error('sky_hold needs quadrant');
          const h = await plan.skyHold(a.quadrant, { minutes: a.minutes, until: timeArg(a.until, n), reason: a.reason, by: 'agent' });
          return text({ held: `${a.quadrant} sky until ${h.until ? hm(h.until) : '?'}`, hold: h.id, now: await plan.nowView() });
        }
        case 'skip': {
          if (!a.target) throw new Error('skip needs target');
          const h = await plan.skip(a.target, { reason: a.reason, by: 'agent' });
          return text({ skipped: h.displayName, now: await plan.nowView() });
        }
        case 'pin': {
          if (!a.target) throw new Error('pin needs target');
          const h = await plan.pin(a.target, { from: timeArg(a.from, n), until: timeArg(a.until, n), reason: a.reason, by: 'agent' });
          return text({ pinned: `${h.displayName} ${hm(h.from)}–${hm(h.until)}`, now: await plan.nowView() });
        }
        case 'release': {
          const ref = a.id ?? a.target ?? a.quadrant;
          if (!ref) throw new Error('release needs id, target or quadrant');
          return text({ released: await plan.release(ref), now: await plan.nowView() });
        }
      }
    },
  );

  tool(
    'plan_program',
    "The owner's program: the targets they want collected and the integration they want on each, which the night plan works into the nights that suit them. Change it only on the owner's request. list: each target with its goal, priority, what is collected so far (library + journal) and tonight's outlook. add: a target (catalog name, or a custom position with ra_hours/dec_deg) with goal_hours and priority (1 low … 5 top, default 3). update / remove: by name. suggest: targets worth adding for tonight's window (types, min_fov_percent, max_magnitude), with a goal suggestion — for when the owner asks what to add. settings: show the plan settings, or change them with settings={…} (window, minAltitude, minBlockMin, weatherMinScore, moon rules, fillers, autoRun…).",
    {
      action: z.enum(['list', 'add', 'update', 'remove', 'settings', 'suggest']),
      types: z.array(z.string()).optional().describe('suggest: galaxy, emission, nebula, planetary, cluster, globular, open_cluster, supernova_remnant, reflection, dark, galaxy_cluster'),
      min_fov_percent: z.number().min(0).max(100).optional().describe('suggest: at least this percent of the tele frame width'),
      max_magnitude: z.number().optional().describe('suggest'),
      name: z.string().optional(),
      goal_hours: z.number().min(0).max(1000).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      enabled: z.boolean().optional(),
      keep_collecting: z.boolean().optional(),
      min_altitude: z.number().min(0).max(85).optional(),
      filter: z.string().optional().describe('"auto" (the planner\'s best of the scope\'s filters) or a filter name'),
      not_before: z.string().optional().describe('YYYY-MM-DD'),
      notes: z.string().optional().describe("the owner's note on this target (framing, filter…)"),
      ra_hours: z.number().min(0).lt(24).optional(),
      dec_deg: z.number().min(-90).max(90).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    },
    async (a) => {
      const today = sky.localDate(new Date(), config.observer.timezone);
      const patch = {
        goalMin: a.goal_hours !== undefined ? Math.round(a.goal_hours * 60) : undefined,
        priority: a.priority,
        enabled: a.enabled,
        keepCollecting: a.keep_collecting,
        minAltitude: a.min_altitude,
        filter: a.filter,
        notBefore: a.not_before,
        notes: a.notes,
      };
      switch (a.action) {
        case 'list':
          return text(await plan.programView());
        case 'suggest':
          return text(await plan.suggestions({ types: a.types, minFovPercent: a.min_fov_percent, maxMagnitude: a.max_magnitude, limit: 15 }));
        case 'add': {
          if (!a.name) throw new Error('add needs name');
          const t = addTarget({ name: a.name, raHours: a.ra_hours, decDeg: a.dec_deg, ...patch }, today);
          plan.changed('the program changed');
          return text({ added: t, note: 'the plan is solved again in a few seconds (night_plan action=show)' });
        }
        case 'update': {
          if (!a.name) throw new Error('update needs name');
          const t = updateTarget(a.name, patch);
          plan.changed('the program changed');
          return text({ updated: t });
        }
        case 'remove': {
          if (!a.name) throw new Error('remove needs name');
          const t = removeTarget(a.name);
          plan.changed('the program changed');
          return text({ removed: t.displayName });
        }
        case 'settings': {
          if (!a.settings) return text(loadSettings());
          const parsed = PlanSettingsSchema.partial().safeParse(a.settings);
          if (!parsed.success) throw new Error(`settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
          const s = saveSettings(parsed.data);
          plan.changed('the settings changed');
          return text(s);
        }
      }
    },
  );

  tool(
    'journal',
    "The observing journal: per night, each target's session as a timeline (GoTo and the time to get on target, autofocus and fine focus with the position it ended on, stack start, rejections, stack end, link drops, notes) with its statistics (frames kept and rejected, integration, efficiency, altitude, the Moon, the sky, the stack's stars and HFR), the night's events (duty, roof, plan changes, holds, what you were woken for) and the notes of the owner and of you. read: a night (night=YYYY-MM-DD, 'tonight' or 'last'; target= for one target's sessions). nights: the nights on record with a summary. target: every session of one target across nights. note: add a note (text, optionally target) — write down what the owner should know tomorrow.",
    {
      action: z.enum(['read', 'nights', 'target', 'note']),
      night: z.string().optional().describe("YYYY-MM-DD (the date of the evening), 'tonight' (default) or 'last' (the last night with sessions)"),
      target: z.string().optional(),
      text: z.string().optional().describe('note: the note'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (a) => {
      const j = night.journal;
      const pick = (v?: string) => {
        if (!v || v === 'tonight') return night.nightOf() ?? sky.localDate(new Date(), config.observer.timezone);
        if (v === 'last') return j.nights().find((k) => j.night(k).sessions.length) ?? j.nights()[0];
        return v;
      };
      const compact = (n: JournalNight, target?: string) => {
        const key = target?.toLowerCase();
        const sessions = n.sessions.filter((s) => !key || s.target.toLowerCase() === key || (s.displayName ?? '').toLowerCase() === key);
        return {
          night: n.night,
          summary: summarize(n),
          sessions: sessions.map((s) => ({
            target: s.displayName ?? s.target,
            time: `${hm(s.startedAt)}–${s.endedAt ? hm(s.endedAt) : 'now'}`,
            status: s.status,
            endReason: s.endReason,
            planned: s.planned,
            stats: s.stats,
            timeline: s.marks.map((m) => `${hm(m.at)} ${m.kind}${m.text ? `: ${m.text}` : ''}`),
          })),
          events: target ? undefined : n.events.slice(-(a.limit ?? 60)).map((e) => `${hm(e.at)} [${e.kind}] ${e.text}`),
          notes: n.notes.filter((x) => !key || !x.target || x.target.toLowerCase() === key).map((x) => `${hm(x.at)} (${x.author}${x.target ? `, ${x.target}` : ''}) ${x.text}`),
        };
      };
      switch (a.action) {
        case 'read': {
          const k = pick(a.night);
          if (!k) return text('the journal is empty');
          return text(compact(j.night(k), a.target));
        }
        case 'nights':
          return text(j.nights().slice(0, a.limit ?? 30).map((k) => summarize(j.night(k))));
        case 'target': {
          if (!a.target) throw new Error('target needs target');
          const key = a.target.toLowerCase();
          const rows = j
            .recentSessions(365)
            .filter((s) => s.target.toLowerCase() === key || (s.displayName ?? '').toLowerCase() === key)
            .slice(0, a.limit ?? 50)
            .map((s) => ({ night: s.night, time: `${hm(s.startedAt)}–${s.endedAt ? hm(s.endedAt) : 'now'}`, status: s.status, stats: s.stats }));
          return text({ target: a.target, sessions: rows, integrationMin: Math.round(rows.reduce((p, r) => p + (r.stats.integrationS ?? 0), 0) / 60) });
        }
        case 'note': {
          if (!a.text) throw new Error('note needs text');
          const k = night.nightOf() ?? sky.localDate(new Date(), config.observer.timezone);
          return text(j.addNote(k, { text: a.text, author: 'agent', target: a.target }));
        }
      }
    },
  );
}
