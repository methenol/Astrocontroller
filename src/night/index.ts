/**
 * The night: the owner's program, tonight's plan, and the journal of what was done, put together
 * for a driver. Every driver builds one (drivers/<id>/runtime.ts) with its own journal probe; the
 * rest is the same for the Dwarf and the Seestar, with or without Starfront's autonomous nights.
 *
 *   program ──► plan (solver) ──► duty samples / night_plan ──► the agent acts
 *      ▲                                                              │
 *      └──── progress, overhead, efficiency ◄── journal ◄── recorder ◄┘ (the telescope's state)
 */
import { config } from '../config.js';
import { logger } from '../log.js';
import * as weather from '../astro/weather.js';
import type { Site } from '../astro/sky.js';
import type { DutyDevice, DutyLoop } from '../agent/duty.js';
import { Journal } from './journal.js';
import { JournalRecorder, type JournalProbe } from './recorder.js';
import { PlanService } from './service.js';
import { nightKey } from './clock.js';

const log = logger('night');

export interface NightServices {
  journal: Journal;
  recorder: JournalRecorder;
  plan: PlanService;
  /** the night a moment belongs to (null without a location) */
  nightOf(at?: number): string | null;
  start(): void;
  stop(): void;
}

export interface NightDeps {
  site: () => Site | null;
  fovArcmin: () => { w: number; h: number };
  probe: JournalProbe;
  duty: DutyLoop;
  nightsEnabled?: () => boolean;
}

export function createNight(d: NightDeps): NightServices {
  const journal = new Journal();
  let plan: PlanService | null = null;
  const tz = config.observer.timezone;
  const conditions = async () => {
    const s = d.site();
    return s ? weather.conditionsAt(s, tz) : null;
  };
  const recorder = new JournalRecorder({ journal, probe: d.probe, site: d.site, conditions, planBlockFor: (t, at) => plan?.blockFor(t, at) ?? null });
  plan = new PlanService({
    site: d.site,
    fovArcmin: d.fovArcmin,
    journal,
    active: () => recorder.active(),
    duty: d.duty,
    nightsEnabled: d.nightsEnabled,
    notify: (text) => d.duty.event(text, true),
  });
  const nightOf = (at = Date.now()) => {
    const s = d.site();
    if (!s) return null;
    try {
      return nightKey(s, new Date(at));
    } catch {
      return null;
    }
  };

  // what happens to the night as a whole goes in its journal: the duty, and everything it is woken for
  let dutyStatus = d.duty.status().status;
  const onDutyState = (st: { status: string; objective?: string; endedReason?: string; pausedReason?: string; untilLabel?: string }) => {
    if (st.status === dutyStatus) return;
    const night = nightOf();
    dutyStatus = st.status as typeof dutyStatus;
    if (!night) return;
    const text = st.status === 'active' ? `duty on${st.untilLabel ? ` until ${st.untilLabel}` : ''}: ${(st.objective ?? '').split('\n')[0].slice(0, 160)}` : st.status === 'paused' ? `duty paused: ${st.pausedReason ?? ''}` : `duty ended: ${st.endedReason ?? ''}`;
    journal.event(night, 'duty', text);
  };
  const onDutyEvent = (text: string) => {
    const night = nightOf();
    if (night) journal.event(night, /roof/i.test(text) ? 'roof' : 'event', text);
  };

  return {
    journal,
    recorder,
    plan,
    nightOf,
    start() {
      d.duty.on('state', onDutyState);
      d.duty.on('event', onDutyEvent);
      recorder.start();
      plan!.start();
      log.info('night plan and journal running');
    },
    stop() {
      d.duty.off('state', onDutyState);
      d.duty.off('event', onDutyEvent);
      plan!.stop();
      recorder.stop();
    },
  };
}

/** A driver's duty device with the night plan's lines added to every sample. */
export function withNightPlan(device: DutyDevice, night: () => NightServices | null): DutyDevice {
  return {
    get state() {
      return device.state;
    },
    requireLocation: () => device.requireLocation(),
    measure: (now) => [...device.measure(now), ...(night()?.plan.dutyLines(now) ?? [])],
    watch: (now, event) => device.watch(now, event),
    closeOut: () => device.closeOut(),
  };
}

export { PLAN_OBJECTIVE } from './service.js';
