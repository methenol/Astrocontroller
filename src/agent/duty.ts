/**
 * The agent as a closed-loop controller.
 *
 * An LLM turn ends when the model stops calling tools, and nothing happens after that until
 * someone writes again. On 2026-10-03 that is how the night was lost: the agent slept, or wrote a
 * summary and stopped. This module is the controller's clock and sensors; the agent stays the
 * controller, deciding every action:
 *
 * - Duty: an objective from the user (the duty bar, the night plan, or a mode the user turned on)
 *   with an optional end time ("until", e.g. astronomical dawn). While on duty, each time the
 *   agent's turn ends the next sample is scheduled (DUTY_INTERVAL_S, or what the agent asked for
 *   with duty next_check, 30 s to 15 min); at that time the agent is woken with the objective and
 *   fresh measurements. The agent never starts, pauses or stops a duty: only the user does, and it
 *   ends at its end time. Interrupting the agent (Esc in chat) only ends its turn; the duty runs on
 *   and the next sample or event wakes it.
 * - Events: things the agent started that end on their own (a dark master, a transfer, processing,
 *   a stack the scope stopped) wake it as they happen, on duty or not. On duty, so do connection
 *   loss, low battery, charging and a hung camera service (duty/sensors.ts).
 *
 * Wakes are ordinary prompts marked as automatic, delivered only while the agent is idle (an
 * event during a turn waits for the turn to end), so they never interrupt work.
 */
import { estop } from '../safety/estop.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import type { ObserverLocation } from '../config.js';
import type { AgentBridge } from './omp.js';
import { measurements } from './duty/measurements.js';
import { watchSensors, type EventSink } from './duty/sensors.js';
import { clampInterval, clock, parseUntil } from './duty/time.js';
import { writeFileAtomic } from '../util/fs.js';
import { SafeEmitter } from '../util/events.js';

const log = logger('duty');

/** After a restart, the first sample of a resumed duty follows this long after start-up. */
const RESUME_DELAY_MS = 20_000;
/** Events are delivered this long after they arrive (a burst goes out as one wake). */
const EVENT_BATCH_MS = 3_000;
/** A wake that could not be delivered is tried again this much later. */
const WAKE_RETRY_MS = 60_000;
/** Events kept while the agent cannot be woken; the oldest are dropped. */
const MAX_EVENTS = 30;
const TICK_MS = 1_000;

export interface DutyState {
  status: 'off' | 'active' | 'paused';
  objective?: string;
  startedAt?: number;
  startedBy?: 'user';
  /** what started it on the owner's behalf when no one pressed Start (the plan's nightly run, Starfront's nights) */
  startedVia?: string;
  /** end of the duty (ms) */
  until?: number;
  untilLabel?: string;
  intervalS: number;
  nextWakeAt?: number;
  /** the agent's choice for the next sample (one wake) */
  requestedNextS?: number;
  requestReason?: string;
  lastWakeAt?: number;
  wakes: number;
  pausedReason?: string;
  endedAt?: number;
  endedReason?: string;
}

interface PendingEvent {
  at: number;
  text: string;
  /** a step of a mode the owner turned on (Starfront's autonomous nights): carried out, not just noted */
  order?: boolean;
}

type WakeKind = 'tick' | 'event' | 'event-only' | 'final';

/** The telescope as the duty loop sees it, whatever the driver (each driver's adapter: drivers/<id>/duty.ts). */
export interface DutyDevice {
  readonly state: { released?: boolean };
  /** keep waking the agent while the telescope is released (the agent connects it again itself with its connect tool) */
  wakeWhileReleased?(): boolean;
  /** the owner's autonomous mode is on (Starfront's nights): the only thing besides an active duty that may wake the agent unprompted */
  autonomous?(): boolean;
  requireLocation(): ObserverLocation;
  /** the telescope's lines in a sample's measurements */
  measure(now: number): string[];
  /** the driver's telescope sensors (events worth waking the agent for); returns the function that stops them */
  watch(now: () => number, event: EventSink): () => void;
  /** how a duty is closed out at its end, in the driver's tool names */
  closeOut(): string;
}
export type DutyAgent = Pick<AgentBridge, 'ready' | 'busy' | 'note' | 'prompt' | 'on' | 'off'>;

const STATUSES = new Set<DutyState['status']>(['off', 'active', 'paused']);

/** The saved duty with each field kept only when it has the right type (a hand-edited file must not break the clock). */
function savedDuty(raw: unknown): Partial<DutyState> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!STATUSES.has(o.status as DutyState['status'])) return null;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const by = o.startedBy === 'user' ? o.startedBy : undefined;
  return {
    status: o.status as DutyState['status'],
    objective: str('objective'),
    startedAt: num('startedAt'),
    startedBy: by,
    startedVia: str('startedVia'),
    until: num('until'),
    untilLabel: str('untilLabel'),
    intervalS: num('intervalS'),
    nextWakeAt: num('nextWakeAt'),
    requestedNextS: num('requestedNextS'),
    requestReason: str('requestReason'),
    lastWakeAt: num('lastWakeAt'),
    wakes: num('wakes'),
    pausedReason: str('pausedReason'),
    endedAt: num('endedAt'),
    endedReason: str('endedReason'),
  };
}

export class DutyLoop extends SafeEmitter {
  state: DutyState = { status: 'off', intervalS: config.agent.dutyIntervalS, wakes: 0 };

  private events: PendingEvent[] = [];
  private deliverTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private wasBusy = false;
  private wasReady = false;
  private delivering = false;
  /** The END wake, composed at the end time, that could not be delivered: sent as written once the agent can take it. */
  private finalPending: string | null = null;
  /** the next sample is the first of a new session or a new duty: say so, and that nothing earlier applies */
  private fresh = false;
  private readonly now: () => number;
  private readonly stopSensors: () => void;
  private readonly onStatus = () => this.onAgentStatus();

  constructor(
    private readonly scope: DutyDevice,
    private readonly agent: DutyAgent,
    opts: { now?: () => number; tickMs?: number; file?: string } = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.file = opts.file ?? path.join(config.paths.data, 'duty.json');
    this.load();
    agent.on('status', this.onStatus);
    if (opts.tickMs !== 0) {
      this.tickTimer = setInterval(() => this.tick(), opts.tickMs ?? TICK_MS);
      this.tickTimer.unref();
    }
    this.stopSensors = watchSensors(scope, this.now, (text, onlyOnDuty) => this.event(text, onlyOnDuty));
  }

  /** Stop the clock and every listener (shutdown, tests). The duty itself stays saved. */
  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.deliverTimer) clearTimeout(this.deliverTimer);
    this.tickTimer = this.deliverTimer = null;
    this.agent.off('status', this.onStatus);
    this.stopSensors();
  }

  // ---------------------------------------------------------------- persistence
  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring an unreadable ${this.file}: ${errMsg(e)}`);
      return; // no duty yet
    }
    const saved = savedDuty(raw);
    if (!saved) {
      log.warn(`ignoring ${this.file}: no valid duty status`);
      return;
    }
    if (saved.status !== 'off' && !saved.objective?.trim()) {
      log.warn(`ignoring ${this.file}: an ${saved.status} duty without an objective`);
      return;
    }
    const defined = Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)) as Partial<DutyState>;
    this.state = { ...this.state, ...defined, intervalS: clampInterval(saved.intervalS || config.agent.dutyIntervalS), wakes: saved.wakes ?? 0 } as DutyState;
    if (this.state.status === 'active' && this.state.until && this.now() > this.state.until) {
      this.end('its end time passed while Astrocontroller was not running');
    } else if (this.state.status === 'active') {
      // first sample shortly after the agent is back
      this.state.nextWakeAt = this.now() + RESUME_DELAY_MS;
      log.info(`duty resumed after restart: ${this.state.objective}`);
    }
  }

  private save(): void {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.state, null, 1));
    } catch (e) {
      log.warn(`cannot save duty state: ${errMsg(e)}`);
    }
    this.publish();
  }

  private publish(): void {
    this.emit('state', this.status());
  }

  status(): DutyState & { pendingEvents: number } {
    return { ...this.state, pendingEvents: this.events.length };
  }

  // ---------------------------------------------------------------- control
  /** until: 'dawn' (astronomical dawn of the current/next night), 'none', 'HH:MM' local, or an ISO time. */
  start(o: { objective: string; until?: string; intervalS?: number; by: 'user'; via?: string }): DutyState {
    estop.assertClear();
    const objective = o.objective.trim();
    if (!objective) throw new Error('objective required');
    const until = parseUntil(o.until, this.now(), () => {
      const loc = this.scope.requireLocation();
      return { lat: loc.lat, lon: loc.lon, elev: loc.elev };
    });
    this.state = {
      status: 'active',
      objective,
      startedAt: this.now(),
      startedBy: o.by,
      startedVia: o.via,
      until: until?.at,
      untilLabel: until?.label,
      intervalS: clampInterval(o.intervalS ?? config.agent.dutyIntervalS),
      wakes: 0,
      nextWakeAt: this.now(),
    };
    // the user is directing a new duty: the previous one's undelivered events and END steps no longer apply
    this.dropPending();
    log.info(`duty started by ${o.via ?? `the ${o.by}`}: "${objective}"${until ? ` until ${until.label}` : ''}`);
    this.agent.note('info', `Duty started${o.via ? ` by ${o.via}` : ''}${until ? ` until ${until.label}` : ''}: ${objective}`);
    this.save();
    return this.state;
  }

  /**
   * A new agent session: a fresh start, like a coding agent's. Events and END steps queued for
   * the old conversation are dropped, so its first wake carries nothing from before it.
   */
  newSession(): void {
    this.dropPending();
    this.publish();
  }

  private dropPending(): void {
    if (this.events.length) log.info(`dropping ${this.events.length} event(s) queued before the fresh start`);
    this.events = [];
    this.finalPending = null;
    // their delivery too: it would wake the fresh start with an empty sample of its own
    if (this.deliverTimer) clearTimeout(this.deliverTimer);
    this.deliverTimer = null;
    this.fresh = true;
  }

  pause(reason: string): void {
    if (this.state.status !== 'active') return;
    Object.assign(this.state, { status: 'paused', pausedReason: reason, nextWakeAt: undefined });
    log.info(`duty paused: ${reason}`);
    this.agent.note('info', `Duty paused (${reason}). Resume it in the duty bar.`);
    this.save();
  }

  resume(): void {
    estop.assertClear();
    if (this.state.status !== 'paused') throw new Error('duty is not paused');
    if (this.state.until && this.now() > this.state.until) {
      this.end('its end time passed while paused');
      throw new Error('the duty ended while paused (end time passed)');
    }
    Object.assign(this.state, { status: 'active', pausedReason: undefined, nextWakeAt: this.now() });
    this.agent.note('info', 'Duty resumed');
    this.save();
  }

  /** The user stops the duty (web UI). */
  stop(reason: string): void {
    if (this.state.status === 'off') return;
    this.end(`stopped by the user: ${reason}`);
  }

  private end(reason: string): void {
    Object.assign(this.state, { status: 'off', endedAt: this.now(), endedReason: reason, nextWakeAt: undefined, requestedNextS: undefined, requestReason: undefined });
    log.info(`duty ended — ${reason}`);
    this.agent.note('info', `Duty ended — ${reason}`);
    this.save();
  }

  /** The agent asks to be woken after a chosen time instead of the default interval (this wake only). */
  nextCheck(seconds: number, reason?: string): { inS: number; at: string } {
    if (this.state.status !== 'active') throw new Error('no active duty: next_check only applies while on duty');
    const s = clampInterval(seconds);
    this.state.requestedNextS = s;
    this.state.requestReason = reason;
    this.save();
    return { inS: s, at: clock(this.now() + s * 1000) };
  }

  /** Wake now (UI button). */
  wakeNow(): void {
    if (this.state.status === 'active') this.state.nextWakeAt = this.now();
    else if (this.events.length || this.finalPending !== null) {
      // now, not when a retry wait runs out
      if (this.deliverTimer) clearTimeout(this.deliverTimer);
      this.deliverTimer = null;
      this.scheduleDelivery(0);
    }
  }

  // ---------------------------------------------------------------- events
  /**
   * Queue an event for the agent. Dropped unless a duty is active or the autonomous mode is on:
   * with both off the agent only ever runs on a message from the user. onlyOnDuty: dropped when not
   * on duty even in autonomous mode.
   */
  event(text: string, onlyOnDuty = false): void {
    if (this.state.status !== 'active' && !this.scope.autonomous?.()) return;
    if (onlyOnDuty && this.state.status !== 'active') return;
    this.push({ at: this.now(), text });
  }

  /**
   * A step the owner's standing mode asks for now (Starfront's autonomous nights: the roof check,
   * the roof opening before dark, closing, reopening). Delivered like an event, on duty or not, but
   * the agent is told to carry it out: an ordinary automatic message must not start new work.
   */
  order(text: string): void {
    if (!this.scope.autonomous?.()) return;
    this.push({ at: this.now(), text, order: true });
  }

  private push(e: PendingEvent): void {
    const text = e.text;
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    log.info(`event for the agent: ${text}`);
    // the night's journal keeps what the agent was woken for
    this.emit('event', text);
    this.scheduleDelivery(EVENT_BATCH_MS);
    this.publish();
  }

  private scheduleDelivery(ms: number): void {
    if (this.deliverTimer) return;
    this.deliverTimer = setTimeout(() => {
      this.deliverTimer = null;
      if (!this.agent.ready || this.agent.busy) return; // delivered when the turn ends
      void this.wake(this.finalPending !== null ? 'final' : this.state.status === 'active' ? 'event' : 'event-only');
    }, ms);
    this.deliverTimer.unref();
  }

  // ---------------------------------------------------------------- scheduling
  private onAgentStatus(): void {
    const busy = this.agent.busy;
    const ready = this.agent.ready;
    // the agent (re)started: events queued while it was down go out now, not after some later turn
    if (ready && !this.wasReady && !busy && (this.events.length || this.finalPending !== null)) this.scheduleDelivery(EVENT_BATCH_MS);
    this.wasReady = ready;
    if (this.wasBusy && !busy) {
      // a turn just ended: the next sample counts from here
      if (this.state.status === 'active') {
        const s = this.state.requestedNextS ?? this.state.intervalS;
        Object.assign(this.state, { nextWakeAt: this.now() + s * 1000, requestedNextS: undefined, requestReason: undefined });
        this.save();
      }
      if (this.events.length || this.finalPending !== null) this.scheduleDelivery(EVENT_BATCH_MS);
    }
    this.wasBusy = busy;
  }

  /** The 1 s clock (the timer calls it; tests call it directly). */
  tick(): void {
    const st = this.state;
    if (st.status !== 'active') return;
    const now = this.now();
    if (st.until && now >= st.until) {
      // a wake in flight would swallow the END message: wait for it (this runs again in a second)
      if (this.delivering) return;
      const label = st.untilLabel;
      this.events.push({ at: now, text: `the duty's end time (${label}) has been reached` });
      void this.wake('final'); // composes its message before it yields
      this.end(`end time reached (${label})`);
      return;
    }
    if (this.scope.state.released && !this.scope.wakeWhileReleased?.()) return; // the user has the telescope
    if (st.nextWakeAt && now >= st.nextWakeAt && this.agent.ready && !this.agent.busy) void this.wake('tick');
  }

  private async wake(kind: WakeKind): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    // a retried END wake goes out as it was composed at the end time (its events are in it); later events wait
    const retryFinal = kind === 'final' ? this.finalPending : null;
    this.finalPending = null;
    const events = retryFinal !== null ? [] : this.events.splice(0);
    let text: string | undefined;
    try {
      text = retryFinal ?? (kind === 'event-only' ? this.eventMessage(events) : this.dutyMessage(kind, events));
      this.state.lastWakeAt = this.now();
      // rescheduled when the turn ends; this one only covers a wake that never starts a turn
      this.state.nextWakeAt = this.now() + this.state.intervalS * 1000;
      if (kind !== 'event-only') this.state.wakes++;
      this.save();
      await this.agent.prompt(text, [], 'followUp');
      this.fresh = false;
    } catch (e) {
      // not delivered: keep the events (an END wake: the whole message), try again at the next sample (or, off duty, a little later)
      if (kind === 'final' && text !== undefined) this.finalPending = text;
      else this.events.unshift(...events);
      if (this.state.status === 'active') this.state.nextWakeAt = this.now() + WAKE_RETRY_MS;
      else if (this.events.length || this.finalPending !== null) this.scheduleDelivery(WAKE_RETRY_MS);
      log.warn(`could not wake the agent: ${errMsg(e)}`);
    } finally {
      this.delivering = false;
      this.publish();
    }
  }

  private eventLines(events: PendingEvent[]): string[] {
    return events.map((e) => `- ${clock(e.at)} ${e.order ? 'ORDER (the owner\'s autonomous mode): ' : ''}${e.text}`);
  }

  private eventMessage(events: PendingEvent[]): string {
    const orders = events.some((e) => e.order);
    return [
      '[Astrocontroller event: automatic, not typed by the user]',
      ...this.eventLines(events),
      '',
      orders
        ? "The ORDER lines are steps of a mode the owner turned on and left running (autonomous Starfront nights): carry them out now, exactly as written, then end your turn. For anything else here: if it belongs to a task the user gave you that is still in progress, take its next step; otherwise do not start anything new."
        : 'If this belongs to a task the user gave you and that is still in progress, take its next step. Otherwise, or if unsure, end your turn: do not start anything new, and do not resume plans from earlier conversations, on an automatic message.',
    ].join('\n');
  }

  private dutyMessage(kind: Exclude<WakeKind, 'event-only'>, events: PendingEvent[]): string {
    const st = this.state;
    const next = clock(this.now() + st.intervalS * 1000);
    const lines = [
      `[Astrocontroller duty ${kind === 'final' ? 'END' : 'sample'}: automatic, not typed by the user]`,
      `Objective from the user${st.untilLabel ? `, in force until ${st.untilLabel}` : ''}: ${st.objective}`,
    ];
    if (this.fresh) {
      lines.push(
        '',
        'This is a fresh start: the first sample of this duty. Nothing from earlier sessions or earlier duties applies — no earlier objectives, targets, events, tool results or plans. The objective above is your whole instruction; what the scope is doing now comes from the measurements below and from tools.',
      );
    }
    if (events.length) lines.push('', 'Events since your last turn:', ...this.eventLines(events));
    lines.push('', 'Measurements now:', ...measurements(this.scope, this.now()), '');
    if (kind === 'final') {
      lines.push(
        `The duty window has ended. Carry out the end steps that the objective above states, if it states any, exactly as written; then always close the duty out: ${this.scope.closeOut()}` +
          ' Then report what was done, from tool results. Do not start anything else the objective does not name (no shutdown unless it says so).',
      );
    } else {
      lines.push(
        `You are the controller for this objective. Compare the measurements with the objective and act on any deviation now, with tools. When everything is on track, end your turn: the next sample is at ${next} (duty next_check picks another time, 30 s to 15 min), or sooner if an event happens.`,
      );
    }
    return lines.join('\n');
  }
}
