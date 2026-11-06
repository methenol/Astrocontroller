/** The agent's duty loop (closed-loop control while unattended). The owner starts, pauses and stops a duty; the agent only reads it and paces its samples. */
import { z } from 'zod';
import { text, type ToolContext, type ToolFn } from './common.js';

export function registerDutyTools(tool: ToolFn, { duty }: Pick<ToolContext, 'duty'>): void {
  tool(
    'duty',
    'Your duty loop: while on duty, Astrocontroller wakes you with the objective and fresh measurements every few minutes and on events, so ending your turn never ends the work. The owner starts a duty (the duty bar, running the night plan, or a mode they turned on); only the owner pauses or stops one, and it ends at its end time. status: the duty as it stands. next_check: choose when the next sample comes (in_s 30-900) when the default does not fit, e.g. 60 s while sweeping for clear sky, 600 s while a long stack runs fine; this replaces waiting.',
    {
      action: z.enum(['status', 'next_check']),
      in_s: z.number().optional().describe('next_check: seconds until the next sample (30-900)'),
      reason: z.string().optional().describe('next_check: why this time'),
    },
    async ({ action, in_s, reason }) => {
      if (!duty) throw new Error('the duty loop is not available in this process');
      switch (action) {
        case 'status':
          return text(duty.status());
        case 'next_check': {
          if (in_s === undefined) throw new Error('in_s is required');
          const r = duty.nextCheck(in_s, reason);
          return text(`next sample in ${r.inS} s (${r.at}) after this turn ends, or sooner on an event. End your turn when you are done with this one.`);
        }
      }
    },
  );
}
