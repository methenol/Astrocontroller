/**
 * The night plan's instructions in the words of the driver this process runs: the Dwarf's target
 * procedure is its system prompt's P2 (live_stacking, tele_visibility, star_sharpness), the
 * Seestar's is P3 (start_stacking / stop_stacking). One text for both had the Dwarf told to call
 * Seestar tools and skip its own steps.
 */
import { config } from '../config.js';

/** What the block says to collect with, and whether the target's settings still need measuring. */
export interface TargetSettings {
  filter?: string;
  gain?: number;
  subS?: number;
  /** the gain is the firmware's (a Seestar): not set */
  gainFixed?: boolean;
  /** the collection quality engine's say: measure after focusing, before the stack */
  measure?: 'needed' | 'more' | 'refresh';
  /** the target's catalog name, for acquisition_quality */
  name?: string;
}

/** The quality step between the focus and the stack. */
export const measureStep = (o: TargetSettings | undefined): string =>
  o?.measure
    ? `acquisition_quality action=measure target=${o.name ?? '<its name>'}${o.measure === 'refresh' ? ' refresh=true' : ''} (the target's settings are ${o.measure === 'needed' ? 'not measured yet' : o.measure === 'more' ? 'not settled' : 'measured under another sky'}: it shoots a few test cohorts without a dataset; poll action=status until done and collect with the settings it returns, not the ones below), `
    : '';

export interface DriverSteps {
  /** the target procedure for a goto name, with the block's settings */
  target: (gotoName: string, o?: TargetSettings) => string;
  /** stop the running stack */
  stop: string;
  /** refocus while stacking: stop, focus again, collect again */
  refocus: string;
  /** what tells the agent a target is blocked */
  blockedBy: string;
  /** the duty's end */
  end: string;
}

const DWARF: DriverSteps = {
  target: (n, o) => `run P2 on it: goto_target name=${n} one_click=true, tele_visibility, autofocus mode=astro, star_sharpness, star_focus, star_sharpness, ${measureStep(o)}live_stacking action=start${o?.subS ? ` exposure=${o.subS}` : ''}${o?.gain !== undefined && !o.gainFixed ? ` gain=${o.gain}` : ''}${o?.filter ? ` filter=${o.filter}` : ''} (every step, in order)`,
  stop: 'live_stacking action=stop',
  refocus: 'live_stacking action=stop, then P2 steps 4–8 (autofocus mode=astro, star_sharpness, star_focus, star_sharpness, live_stacking action=start)',
  blockedBy: 'tele_visibility says BLOCKED, or the owner says so',
  end: 'live_stacking action=stop, park (move_motors pitch_deg=2.5), and transfer the night\'s sessions that are not in the library yet',
};

const SEESTAR: DriverSteps = {
  target: (n, o) => {
    const f = o?.filter;
    return `run P3 on it: the settings${o?.subS ? ` (set_camera_setting setting=exposure value=${o.subS}${f ? `, filter ${f}` : ''})` : f ? ` (filter ${f})` : ''}, goto_target name=${n}${f ? ` lp_filter=${/^lp/i.test(f) ? 'true' : 'false'}` : ''}, autofocus, star_focus, ${measureStep(o)}start_stacking (every step, in order)`;
  },
  stop: 'stop_stacking',
  refocus: 'stop_stacking, autofocus, star_focus, start_stacking (the same stack continues)',
  blockedBy: 'tele_visibility says BLOCKED, the frame shows an obstruction, or the owner says so',
  end: "stop_stacking, park, and transfer the night's sessions that are not in the library yet",
};

export const driverSteps = (driver: string = config.telescope.driver): DriverSteps => (driver === 'seestar' ? SEESTAR : DWARF);

/** The duty objective of a night-plan run, for this process's driver. */
export function planObjective(driver: string = config.telescope.driver): string {
  const d = driverSteps(driver);
  return [
    "Carry out tonight's night plan (the Plan tab) until its end, maximising collection quality and integration time on the owner's program targets. A target that is not centred, is not at the absolute best focus, or is collected with incorrect settings (exposure, gain, filter) is unusable and a complete waste of collection. The target procedure is how quality is collected: run every step of it on every target; time spent on its steps is never lost time.",
    `1. Every sample shows the plan's current block. Be on that target: ${d.target('<its goto name>')}. A mosaic block is worked panel by panel as its sample line says; autofocus at the block's start, not at each panel. Nothing is stacked before the plan starts; before that, get ready (connect, open the arm).`,
    `2. When the plan moves to the next block, ${d.stop} and move to its target the same way. Follow the plan rather than choosing targets yourself; night_plan action=now says what to do at any time. The target you are working is locked to the end of its block: forecast updates and re-solves plan around it.`,
    `3. If the target is blocked (${d.blockedBy}) or clouded, tell the plan: night_plan action=obscured target=<name> cause=obstruction|cloud, then go to the target it gives. night_plan action=alternates lists other parts of the sky; a cloud bank in one direction: night_plan action=sky_hold quadrant=N|E|S|W minutes=<n>.`,
    "4. Collection quality is the planner's to drive: it decides, per target, whether the settings must be measured (never measured, not settled, stale after a few weeks, or measured under a very different sky) and which test cohorts to shoot, and puts the measure step into the target procedure above when it is due. Run it where it stands — after the focus, before the stack — wait for it (acquisition_quality action=status), and collect with the settings it returns. When the procedure has no measure step, the block's settings are already the measured ones (or the planner's stand-in). You may also re-measure a target yourself (acquisition_quality action=measure refresh=true) or submit more data (action=submit session=latest) whenever the sky, the Moon, the altitude or the subs give a reason: the engine re-solves from all of it.",
    '5. Record what matters for the owner in the journal (journal action=note): why a target was left, focus or tracking trouble, a change of settings and the measurement behind it.',
    `6. At the end of the duty: ${d.end}.`,
  ].join('\n');
}
