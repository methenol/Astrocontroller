/** The agent's duty loop (closed-loop control while unattended). */
import { z } from 'zod';
import { text, type ToolContext, type ToolFn } from './common.js';

export function registerDutyTools(tool: ToolFn, { duty }: Pick<ToolContext, 'duty'>): void {
  tool(
    'duty',
    'Your duty loop: while on duty, Astrocontroller wakes you with the objective and fresh measurements every few minutes and on events, so ending your turn never ends the work. start: when the user gives you an objective to carry out unattended (a night of imaging, a dark library, transfers to see through), start a duty with the user\'s instruction as the objective, word for word, and an end time (until: "dawn" for night imaging unless the user said otherwise, "HH:MM", or "none"). next_check: choose when the next sample comes (in_s 30-900) when the default does not fit, e.g. 60 s while sweeping for clear sky, 600 s while a long stack runs fine; this replaces waiting. status: the duty as it stands. complete: only when the objective is fully done; refused before the end time. Only the user can stop or pause a duty.',
    {
      action: z.enum(['start', 'status', 'next_check', 'complete']),
      objective: z.string().optional().describe("start: the user's instruction, verbatim"),
      until: z.string().optional().describe('start: "dawn" | "HH:MM" (local) | "none"'),
      interval_s: z.number().optional().describe('start: default time between samples (30-900, default from .env)'),
      in_s: z.number().optional().describe('next_check: seconds until the next sample (30-900)'),
      reason: z.string().optional().describe('next_check: why this time'),
      report: z.string().optional().describe('complete: what was achieved, from tool results'),
    },
    async ({ action, objective, until, interval_s, in_s, reason, report }) => {
      if (!duty) throw new Error('the duty loop is not available in this process');
      switch (action) {
        case 'status':
          return text(duty.status());
        case 'start': {
          if (!objective) throw new Error("objective is required: the user's instruction, verbatim");
          const st = duty.start({ objective, until, intervalS: interval_s, by: 'agent' });
          return text({ ...st, note: 'On duty. Carry on now; whenever your turn ends you will be woken for the next sample or on an event.' });
        }
        case 'next_check': {
          if (in_s === undefined) throw new Error('in_s is required');
          const r = duty.nextCheck(in_s, reason);
          return text(`next sample in ${r.inS} s (${r.at}) after this turn ends, or sooner on an event. End your turn when you are done with this one.`);
        }
        case 'complete':
          if (!report) throw new Error('report is required: what was achieved, from tool results');
          duty.complete(report);
          return text('duty completed');
      }
    },
  );
}
