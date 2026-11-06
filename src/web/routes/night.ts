/** The Plan and Journal tabs: tonight's plan, the owner's program, the plan settings, holds, and the journal with its notes. */
import express, { type Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import * as sky from '../../astro/sky.js';
import { addTarget, loadSettings, PlanSettingsSchema, ProgramTargetInput, removeTarget, reorderProgram, resetSettings, saveSettings, updateTarget, PLAN_DEFAULTS } from '../../night/program.js';
import { PLAN_OBJECTIVE } from '../../night/service.js';
import { summarize } from '../../night/journal.js';
import { body, notFound, queryString, route, HttpError } from '../http.js';
import type { WebContext } from '../context.js';

const HoldBody = z.object({
  action: z.enum(['obscured', 'skip', 'pin', 'sky', 'release']),
  target: z.string().min(1).optional(),
  quadrant: z.enum(['N', 'E', 'S', 'W']).optional(),
  cause: z.enum(['obstruction', 'cloud', 'other']).optional(),
  minutes: z.number().min(5).max(720).optional(),
  from: z.number().optional(),
  until: z.number().optional(),
  reason: z.string().max(300).optional(),
  id: z.string().optional(),
});
const NoteBody = z.object({ text: z.string().min(1).max(4000), target: z.string().max(120).optional() });
const OrderBody = z.object({ ids: z.array(z.string()) });
const NIGHT = /^\d{4}-\d{2}-\d{2}$/;

export function nightRoutes({ night, duty }: WebContext): Router {
  const api = express.Router();
  const need = () => {
    if (!night) throw new HttpError(503, 'the night plan is not running in this process');
    return night;
  };
  const today = () => sky.localDate(new Date(), config.observer.timezone);

  // ---- the plan
  api.get(
    '/plan/tonight',
    route(async () => {
      const n = need();
      const plan = await n.plan.plan();
      return { plan, now: n.plan.viewOf(plan), duty: duty.status(), settings: loadSettings() };
    }),
  );
  api.post(
    '/plan/replan',
    route(async () => {
      const n = need();
      const plan = await n.plan.replan('asked in the Plan tab');
      return { plan, now: n.plan.viewOf(plan), settings: loadSettings() };
    }),
  );
  api.get('/plan/now', route(async () => need().plan.nowView()));
  api.get(
    '/plan/night/:night',
    route(async (req) => {
      const k = String(req.params.night);
      if (!NIGHT.test(k)) throw notFound('not a night');
      const p = need().plan.planOf(k);
      if (!p) throw notFound(`no plan was made for ${k}`);
      return p;
    }),
  );
  api.get(
    '/plan/alternates',
    route(async (req) => {
      const q = queryString(req, 'quadrant');
      return need().plan.alternates({ quadrant: q === 'N' || q === 'E' || q === 'S' || q === 'W' ? q : undefined, limit: 8 });
    }),
  );
  api.get(
    '/plan/suggestions',
    route(async (req) => {
      const num = (k: string) => {
        const v = queryString(req, k);
        return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
      };
      const types = queryString(req, 'types');
      return need().plan.suggestions({
        types: types !== undefined ? types.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
        minFovPercent: num('minFovPercent'),
        maxMagnitude: num('maxMagnitude'),
        minSizeArcmin: num('minSizeArcmin'),
        maxSizeArcmin: num('maxSizeArcmin'),
        limit: num('limit'),
      });
    }),
  );
  api.post(
    '/plan/hold',
    route(async (req) => {
      const b = body(req, HoldBody);
      const p = need().plan;
      const by = 'user' as const;
      switch (b.action) {
        case 'obscured':
          if (!b.target) throw new Error('target required');
          return (await p.obscured(b.target, { cause: b.cause, minutes: b.minutes, until: b.until, reason: b.reason, by })).hold;
        case 'skip':
          if (!b.target) throw new Error('target required');
          return p.skip(b.target, { reason: b.reason, by });
        case 'pin':
          if (!b.target) throw new Error('target required');
          return p.pin(b.target, { from: b.from, until: b.until, reason: b.reason, by });
        case 'sky':
          if (!b.quadrant) throw new Error('quadrant required');
          return p.skyHold(b.quadrant, { minutes: b.minutes, until: b.until, reason: b.reason, by });
        case 'release': {
          const ref = b.id ?? b.target ?? b.quadrant;
          if (!ref) throw new Error('id, target or quadrant required');
          return { released: await p.release(ref) };
        }
      }
    }),
  );
  // run tonight's plan now: the owner starts the plan's duty by hand (only Starfront's autonomous nights start one by themselves)
  api.post(
    '/plan/run',
    route(async () => {
      const n = need();
      const plan = await n.plan.plan();
      if (Date.now() >= plan.window.end) throw new Error("tonight's plan has ended");
      return duty.start({ objective: PLAN_OBJECTIVE, until: new Date(plan.window.end).toISOString(), by: 'user' });
    }),
  );

  // ---- the program
  api.get('/plan/program', route(async () => need().plan.programView()));
  api.post(
    '/plan/program',
    route(async (req) => {
      const t = addTarget(body(req, ProgramTargetInput), today());
      need().plan.changed('the program changed');
      return t;
    }),
  );
  api.post(
    '/plan/program/order',
    route(async (req) => {
      const r = reorderProgram(body(req, OrderBody).ids);
      need().plan.changed('the program changed');
      return r;
    }),
  );
  api.post(
    '/plan/program/:id',
    route(async (req) => {
      const t = updateTarget(String(req.params.id), body(req, ProgramTargetInput.partial()));
      need().plan.changed('the program changed');
      return t;
    }),
  );
  api.delete(
    '/plan/program/:id',
    route(async (req) => {
      const t = removeTarget(String(req.params.id));
      need().plan.changed('the program changed');
      return t;
    }),
  );

  // ---- settings
  api.get('/plan/settings', route(async () => ({ settings: loadSettings(), defaults: PLAN_DEFAULTS })));
  api.post(
    '/plan/settings',
    route(async (req) => {
      const s = saveSettings(body(req, PlanSettingsSchema.partial()));
      need().plan.changed('the settings changed');
      return s;
    }),
  );
  api.post(
    '/plan/settings/reset',
    route(async () => {
      const s = resetSettings();
      need().plan.changed('the settings were reset');
      return s;
    }),
  );

  // ---- the journal
  api.get(
    '/journal',
    route(async () => {
      const n = need();
      const tonight = n.nightOf();
      const keys = n.journal.nights();
      if (tonight && !keys.includes(tonight)) keys.unshift(tonight);
      return { tonight, nights: keys.map((k) => summarize(n.journal.night(k))) };
    }),
  );
  api.get(
    '/journal/:night',
    route(async (req) => {
      const k = String(req.params.night);
      if (!NIGHT.test(k)) throw notFound('not a night');
      const n = need();
      const j = n.journal.night(k);
      const active = n.recorder.active();
      return { ...j, summary: summarize(j), active: active?.night === k ? active.session.id : null };
    }),
  );
  api.post(
    '/journal/:night/notes',
    route(async (req) => {
      const k = String(req.params.night);
      if (!NIGHT.test(k)) throw notFound('not a night');
      const b = body(req, NoteBody);
      return need().journal.addNote(k, { text: b.text, target: b.target, author: 'user' });
    }),
  );
  api.post(
    '/journal/:night/notes/:id',
    route(async (req) => need().journal.updateNote(String(req.params.night), String(req.params.id), body(req, NoteBody).text)),
  );
  api.delete(
    '/journal/:night/notes/:id',
    route(async (req) => {
      need().journal.deleteNote(String(req.params.night), String(req.params.id));
      return { ok: true };
    }),
  );

  return api;
}
