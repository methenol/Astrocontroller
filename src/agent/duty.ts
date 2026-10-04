/**
 * The agent as a closed-loop controller.
 *
 * An LLM turn ends when the model stops calling tools, and nothing happens after that until
 * someone writes again. On 2026-10-03 that is how the night was lost: the agent slept, or wrote a
 * summary and stopped. This module is the controller's clock and sensors; the agent stays the
 * controller, deciding every action:
 *
 * - Duty: an objective from the user (or the agent on the user's request) with an optional end
 *   time ("until", e.g. astronomical dawn). While on duty, each time the agent's turn ends the next
 *   sample is scheduled (DUTY_INTERVAL_S, or what the agent asked for with duty next_check, 30 s to
 *   15 min); at that time the agent is woken with the objective and fresh measurements. It cannot
 *   end a duty before its end time; only the user can stop or pause it.
 * - Events: things the agent started that end on their own (a dark master, a transfer, processing,
 *   a stack the scope stopped) wake it as they happen, on duty or not. On duty, so do connection
 *   loss, low battery, charging and a hung camera service.
 *
 * Wakes are ordinary prompts marked as automatic, delivered only while the agent is idle (an
 * event during a turn waits for the turn to end), so they never interrupt work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import type { Dwarf } from '../dwarf/device.js';
import type { AgentBridge } from './omp.js';
import * as library from '../library/transfer.js';
import * as processing from '../processing/queue.js';
import * as dhttp from '../dwarf/http.js';
import * as sky from '../astro/sky.js';

const log = logger('duty');
const MIN_S = 30;
const MAX_S = 900;

export interface DutyState {
  status: 'off' | 'active' | 'paused';
  objective?: string;
  startedAt?: number;
  startedBy?: 'user' | 'agent';
  /** end of the duty (ms); the agent cannot complete it earlier */
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
}

export class DutyLoop extends EventEmitter {
  state: DutyState = { status: 'off', intervalS: config.agent.dutyIntervalS, wakes: 0 };
  private events: PendingEvent[] = [];
  private deliverTimer: NodeJS.Timeout | null = null;
  private file = path.join(config.paths.data, 'duty.json');
  private wasBusy = false;
  private delivering = false;
  /**
   * The user pressed Stop: no automatic wake of any kind until they write to the agent again.
   * Otherwise an event (or a duty's final wake) revived whatever was left in the agent's todo list:
   * on 2026-10-04 it finished a wind-down the user had interrupted two hours earlier and shut the
   * telescope down.
   */
  private userStopped = false;

  constructor(
    private readonly dwarf: Dwarf,
    private readonly agent: AgentBridge,
  ) {
    super();
    this.load();
    agent.on('status', () => this.onAgentStatus());
    setInterval(() => this.tick(), 1000).unref();
    this.watch();
  }

  // ---------------------------------------------------------------- persistence
  private load(): void {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DutyState;
      this.state = { ...this.state, ...s, intervalS: s.intervalS || config.agent.dutyIntervalS };
      if (this.state.status === 'active' && this.state.until && Date.now() > this.state.until) {
        this.end('its end time passed while Astrocontroller was not running');
      } else if (this.state.status === 'active') {
        // first sample shortly after the agent is back
        this.state.nextWakeAt = Date.now() + 20000;
        log.info(`duty resumed after restart: ${this.state.objective}`);
      }
    } catch {
      /* no duty yet */
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1));
    } catch (e) {
      log.warn(`cannot save duty state: ${errMsg(e)}`);
    }
    this.emit('state', this.status());
  }

  status(): DutyState & { pendingEvents: number; heldByStop: boolean } {
    return { ...this.state, pendingEvents: this.events.length, heldByStop: this.userStopped };
  }

  // ---------------------------------------------------------------- control
  /** until: 'dawn' (astronomical dawn of the current/next night), 'none', 'HH:MM' local, or an ISO time. */
  start(o: { objective: string; until?: string; intervalS?: number; by: 'user' | 'agent' }): DutyState {
    const objective = o.objective.trim();
    if (!objective) throw new Error('objective required');
    const until = this.parseUntil(o.until);
    const prev = this.state;
    if (o.by === 'agent' && prev.status === 'active' && prev.until && (!until || until.at < prev.until)) {
      // the agent can extend a duty, never cut it short
      throw new Error(`a duty is already active until ${prev.untilLabel}; the agent can only extend it (give an end time after that), or the user can change it in the web UI`);
    }
    this.state = {
      status: 'active',
      objective,
      startedAt: Date.now(),
      startedBy: o.by,
      until: until?.at,
      untilLabel: until?.label,
      intervalS: clamp(o.intervalS ?? config.agent.dutyIntervalS),
      wakes: 0,
      // the agent is starting it inside a turn: the first sample follows that turn's end
      nextWakeAt: o.by === 'agent' ? undefined : Date.now(),
    };
    if (o.by === 'user') this.userStopped = false;
    log.info(`duty started by the ${o.by}: "${objective}"${until ? ` until ${until.label}` : ''}`);
    this.agent.note('info', `Duty started${until ? ` until ${until.label}` : ''}: ${objective}`);
    this.save();
    return this.state;
  }

  /** Stop pressed on the agent: pause the duty and hold every automatic wake. */
  userStop(): void {
    this.userStopped = true;
    this.pause('you stopped the agent');
    this.emit('state', this.status());
  }

  /** The user wrote to the agent: automatic wakes may resume. */
  userSpoke(): void {
    if (!this.userStopped) return;
    this.userStopped = false;
    this.emit('state', this.status());
  }

  pause(reason: string): void {
    if (this.state.status !== 'active') return;
    this.state.status = 'paused';
    this.state.pausedReason = reason;
    this.state.nextWakeAt = undefined;
    log.info(`duty paused: ${reason}`);
    this.agent.note('info', `Duty paused (${reason}). Resume it in the duty bar.`);
    this.save();
  }

  resume(): void {
    if (this.state.status !== 'paused') throw new Error('duty is not paused');
    if (this.state.until && Date.now() > this.state.until) {
      this.end('its end time passed while paused');
      throw new Error('the duty ended while paused (end time passed)');
    }
    this.state.status = 'active';
    this.state.pausedReason = undefined;
    this.state.nextWakeAt = Date.now();
    this.userStopped = false;
    this.agent.note('info', 'Duty resumed');
    this.save();
  }

  stop(by: 'user' | 'agent', reason: string): void {
    if (this.state.status === 'off') return;
    this.end(`${by === 'user' ? 'stopped by the user' : 'completed by the agent'}: ${reason}`);
  }

  private end(reason: string): void {
    this.state.status = 'off';
    this.state.endedAt = Date.now();
    this.state.endedReason = reason;
    this.state.nextWakeAt = undefined;
    log.info(`duty ended — ${reason}`);
    this.agent.note('info', `Duty ended — ${reason}`);
    this.save();
  }

  /** The agent asks to be woken after a chosen time instead of the default interval (this wake only). */
  nextCheck(seconds: number, reason?: string): { inS: number; at: string } {
    if (this.state.status !== 'active') throw new Error('no active duty: next_check only applies while on duty');
    const s = clamp(seconds);
    this.state.requestedNextS = s;
    this.state.requestReason = reason;
    this.save();
    return { inS: s, at: this.clock(Date.now() + s * 1000) };
  }

  /** The agent says the objective is done. Refused before the duty's end time. */
  complete(report: string): void {
    if (this.state.status === 'off') throw new Error('no active duty');
    if (this.state.until && Date.now() < this.state.until) {
      throw new Error(`refused: this duty runs until ${this.state.untilLabel} (set by ${this.state.startedBy === 'user' ? 'the user' : 'you on the user\'s request'}). Until then keep controlling: act on the measurements, and end your turn when everything is on track; you will be woken for the next sample. If you need something from the user, ask in chat; the duty continues meanwhile.`);
    }
    this.stop('agent', report.slice(0, 300));
  }

  /** Wake now (UI button). */
  wakeNow(): void {
    if (this.state.status === 'active') this.state.nextWakeAt = Date.now();
    else if (this.events.length) this.scheduleDelivery(0);
  }

  // ---------------------------------------------------------------- events
  /** Queue an event for the agent. onlyOnDuty: dropped when not on duty. */
  event(text: string, onlyOnDuty = false): void {
    if (onlyOnDuty && this.state.status !== 'active') return;
    this.events.push({ at: Date.now(), text });
    if (this.events.length > 30) this.events.shift();
    log.info(`event for the agent: ${text}`);
    this.scheduleDelivery(3000);
    this.emit('state', this.status());
  }

  private scheduleDelivery(ms: number): void {
    if (this.deliverTimer) return;
    this.deliverTimer = setTimeout(() => {
      this.deliverTimer = null;
      if (!this.agent.ready || this.agent.busy || this.userStopped) return; // delivered when the turn ends / the user writes
      void this.wake(this.state.status === 'active' ? 'event' : 'event-only');
    }, ms);
  }

  // ---------------------------------------------------------------- scheduling
  private onAgentStatus(): void {
    const busy = this.agent.busy;
    if (this.wasBusy && !busy) {
      // a turn just ended: the next sample counts from here
      if (this.state.status === 'active') {
        const s = this.state.requestedNextS ?? this.state.intervalS;
        this.state.nextWakeAt = Date.now() + s * 1000;
        this.state.requestedNextS = undefined;
        this.state.requestReason = undefined;
        this.save();
      }
      if (this.events.length) this.scheduleDelivery(3000);
    }
    this.wasBusy = busy;
  }

  private tick(): void {
    const st = this.state;
    if (st.status !== 'active') return;
    const now = Date.now();
    if (st.until && now >= st.until) {
      const label = st.untilLabel;
      this.events.push({ at: now, text: `the duty's end time (${label}) has been reached` });
      void this.wake('final'); // composes its message before it yields
      this.end(`end time reached (${label})`);
      return;
    }
    if (this.dwarf.state.released) return; // the user has the telescope
    if (st.nextWakeAt && now >= st.nextWakeAt && this.agent.ready && !this.agent.busy) void this.wake('tick');
  }

  private async wake(kind: 'tick' | 'event' | 'event-only' | 'final'): Promise<void> {
    if (this.delivering || this.userStopped) return;
    this.delivering = true;
    const events = this.events.splice(0);
    try {
      const text = kind === 'event-only' ? this.eventMessage(events) : this.dutyMessage(kind, events);
      this.state.lastWakeAt = Date.now();
      // rescheduled when the turn ends; this one only covers a wake that never starts a turn
      this.state.nextWakeAt = Date.now() + this.state.intervalS * 1000;
      if (kind !== 'event-only') this.state.wakes++;
      this.save();
      await this.agent.prompt(text, [], 'followUp');
    } catch (e) {
      // not delivered: keep the events, try again at the next sample
      this.events.unshift(...events);
      if (this.state.status === 'active') this.state.nextWakeAt = Date.now() + 60000;
      log.warn(`could not wake the agent: ${errMsg(e)}`);
    } finally {
      this.delivering = false;
      this.emit('state', this.status());
    }
  }

  private clock(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-GB', { timeZone: config.observer.timezone, hour: '2-digit', minute: '2-digit' });
  }

  private eventLines(events: PendingEvent[]): string[] {
    return events.map((e) => `- ${this.clock(e.at)} ${e.text}`);
  }

  private eventMessage(events: PendingEvent[]): string {
    return [
      '[Astrocontroller event: automatic, not typed by the user]',
      ...this.eventLines(events),
      '',
      'If this belongs to a task the user gave you and that is still in progress, take its next step. Otherwise, or if unsure, end your turn: do not start anything new, and do not resume plans from earlier conversations, on an automatic message.',
    ].join('\n');
  }

  private dutyMessage(kind: 'tick' | 'event' | 'final', events: PendingEvent[]): string {
    const st = this.state;
    const next = this.clock(Date.now() + st.intervalS * 1000);
    const lines = [
      `[Astrocontroller duty ${kind === 'final' ? 'END' : 'sample'}: automatic, not typed by the user]`,
      `Objective from the user${st.untilLabel ? `, in force until ${st.untilLabel}` : ''}: ${st.objective}`,
    ];
    if (events.length) lines.push('', 'Events since your last turn:', ...this.eventLines(events));
    lines.push('', 'Measurements now:', ...this.measurements());
    lines.push('');
    if (kind === 'final') {
      lines.push('The duty window has ended. Carry out the end steps that the objective above states, if it states any, exactly as written, and nothing else; then report what was done, from tool results. Do not start anything the objective does not name (no shutdown, transfer or processing unless it says so).');
    } else {
      lines.push(
        `You are the controller for this objective. Compare the measurements with the objective and act on any deviation now, with tools. When everything is on track, end your turn: the next sample is at ${next} (duty next_check picks another time, 30 s to 15 min), or sooner if an event happens.`,
      );
    }
    return lines.join('\n');
  }

  /** A compact reading of everything the controller can measure. */
  private measurements(): string[] {
    const d = this.dwarf.state;
    const now = Date.now();
    const out: string[] = [];
    const tz = config.observer.timezone;
    try {
      const loc = this.dwarf.requireLocation();
      const site = { lat: loc.lat, lon: loc.lon, elev: loc.elev };
      const w = sky.nightWindow(site);
      const sun = sky.bodyAlt(site, 'Sun');
      const dawn = w.astroDawn ? w.astroDawn.getTime() : null;
      out.push(`- time ${this.clock(now)}; Sun altitude ${sun.toFixed(0)}°${sun < -18 ? ' (dark)' : ''}; astronomical dawn ${sky.fmtTime(w.astroDawn, tz) ?? '?'}${dawn && dawn > now ? ` (in ${fmtMin(dawn - now)})` : ''}`);
    } catch {
      out.push(`- time ${this.clock(now)}`);
    }
    if (d.released) out.push('- telescope: RELEASED by the user (Disconnect in the web UI); nothing can be sent until they press Connect');
    else if (!d.connected) out.push('- telescope: NOT CONNECTED');
    else {
      const m = d.motors;
      out.push(`- telescope: connected; battery ${d.battery ?? '?'}%${d.charging ? ' (charging)' : ''}; mode ${d.shootingMode?.name ?? '?'}; ${this.dwarf.isTracking() ? 'tracking' : 'not tracking'}; motors ${m.homed ? `rotation ${m.rotationDeg}°, pitch ${m.pitchDeg}°` : 'no reference (normal while tracking)'}; SD ${d.storage ? `${d.storage.availableGB.toFixed(1)} GB free` : '?'}; sensor ${d.cmosTempC.tele ?? '?'} °C`);
      const h = dhttp.apiHealth();
      if (h.cameraService !== 'ok') out.push(`- camera service: ${h.cameraService} (${h.consecutiveTimeouts} timeouts in a row, ${h.timingOutForMin} min)`);
    }
    for (const cam of ['tele', 'wide'] as const) {
      const s = d.stacking[cam];
      if (s.state === 'running') {
        out.push(`- ${cam} stacking: running${s.target ? ` on ${s.target}` : ''}, ${s.stackedCount ?? 0} stacked of ${s.currentCount ?? 0} taken${s.totalCount ? ` (target ${s.totalCount})` : ''}, last progress ${s.updatedAt ? `${Math.round((now - s.updatedAt) / 1000)} s ago` : 'none yet'}`);
      } else if (cam === 'tele') {
        out.push(`- tele stacking: ${s.state}${s.stoppedAt ? ` since ${this.clock(s.stoppedAt)}` : ''}`);
      }
    }
    const dc = d.darkCapture;
    if (dc?.state === 'running') out.push(`- dark capture: running (${dc.exposureS} s × ${dc.frames}, about ${dc.expectedEndAt ? fmtMin(Math.max(0, dc.expectedEndAt - now)) : '?'} left)`);
    if (d.ndLock) out.push('- ND filter fitted: motion locked');
    const jobs = library.listJobs().filter((j) => j.status === 'running' || j.status === 'queued');
    if (jobs.length) out.push(`- transfers: ${jobs.map((j) => `${j.description} ${j.status}${j.progress ? ` ${j.progress.filesDone}/${j.progress.filesTotal} files` : ''}`).join('; ')}`);
    const proc = processing.listItems(10).filter((i) => !['done', 'failed', 'cancelled'].includes(i.state));
    if (proc.length) out.push(`- processing: ${proc.map((i) => `${i.target} ${i.state}${i.studio ? ` ${Math.round(i.studio.progress * 100)}% ${i.studio.message ?? ''}` : ''}`).join('; ')}`);
    return out;
  }

  // ---------------------------------------------------------------- sensors
  private watch(): void {
    const d = this.dwarf;
    let stack = { tele: d.state.stacking.tele.state, wide: d.state.stacking.wide.state };
    let dark = d.state.darkCapture?.state;
    let connected = d.state.connected;
    let charging = d.state.charging;
    let batteryBand = band(d.state.battery);
    let cameraHung = false;
    d.on('state', () => {
      const s = d.state;
      for (const cam of ['tele', 'wide'] as const) {
        const now = s.stacking[cam].state;
        if (stack[cam] === 'running' && now !== 'running') {
          const ctl = d.stackControl[cam];
          const requested = ctl.stopRequestedAt && Date.now() - ctl.stopRequestedAt < 180000;
          if (!requested) {
            const x = s.stacking[cam];
            const msg = `${cam} live stacking ended without a stop command (${x.stackedCount ?? '?'} stacked of ${x.currentCount ?? '?'} taken${x.totalCount ? `, frame target ${x.totalCount}` : ''}): the frame target was reached, or the scope stopped it`;
            this.event(msg, ctl.startedBy !== 'agent');
          }
        }
        stack[cam] = now;
      }
      const dc = s.darkCapture?.state;
      if (dark === 'running' && dc && dc !== 'running') {
        const x = s.darkCapture!;
        this.event(dc === 'done' ? `dark master saved: ${x.master} (${x.exposureS} s, gain ${x.gain}, ${x.frames} frames)` : `dark capture ${x.exposureS} s ended: ${dc}${x.error ? ` — ${x.error}` : ''}`);
      }
      dark = dc;
      if (connected !== s.connected && !s.released) {
        this.event(s.connected ? 'the telescope connection is back' : 'the telescope connection was lost', true);
      }
      connected = s.connected;
      if (charging !== undefined && s.charging !== undefined && charging !== s.charging) {
        this.event(s.charging ? `the telescope is now charging (battery ${s.battery ?? '?'}%)` : `the telescope is no longer charging (battery ${s.battery ?? '?'}%)`, true);
      }
      charging = s.charging ?? charging;
      const b = band(s.battery);
      if (b < batteryBand) this.event(`battery down to ${s.battery}%`, true);
      batteryBand = b;
      const hung = dhttp.apiHealth().cameraService === 'NOT RESPONDING';
      if (hung && !cameraHung) this.event("the telescope's camera service is NOT RESPONDING (camera calls time out); see the system prompt, 'When tools fail'", true);
      cameraHung = hung;
    });
    library.jobBus.on('job', (j: library.Job) => {
      if (!['done', 'partial', 'failed', 'cancelled'].includes(j.status)) return;
      if (j.status === 'cancelled' && d.state.released) return;
      const err = j.error ? `: ${j.error.slice(0, 300)}` : '';
      this.event(`transfer job ${j.id} (${j.description}) ${j.status}${err}${(j.result as { processing?: { id?: string } } | undefined)?.processing?.id ? '; processing queued' : ''}`, j.origin !== 'agent');
    });
    const seen = new Map<string, string>();
    processing.processingBus.on('item', (it: processing.ProcessingItem) => {
      if (seen.get(it.id) === it.state) return;
      seen.set(it.id, it.state);
      if (it.state !== 'done' && it.state !== 'failed') return;
      const mine = it.origin === 'agent' || it.origin === 'transfer';
      this.event(`processing ${it.id} (${it.target}, ${it.profile}) ${it.state}${it.state === 'failed' && it.lastError ? `: ${it.lastError.slice(0, 200)}` : ''}${it.outputs?.length ? `; outputs: ${it.outputs.length} file(s)` : ''}`, !mine);
    });
  }

  private parseUntil(v: string | undefined): { at: number; label: string } | undefined {
    if (!v || v === 'none') return undefined;
    const tz = config.observer.timezone;
    if (v === 'dawn') {
      const loc = this.dwarf.requireLocation();
      const w = sky.nightWindow({ lat: loc.lat, lon: loc.lon, elev: loc.elev });
      const dawn = w.astroDawn ?? w.darkEnd;
      if (!dawn) throw new Error('no astronomical dawn found for this location');
      return { at: dawn.getTime(), label: `astronomical dawn ${sky.fmtTime(dawn, tz)}` };
    }
    let at: number;
    if (/^\d{1,2}:\d{2}$/.test(v)) {
      // the next occurrence of that local time
      const [hh, mm] = v.split(':').map(Number);
      const now = Date.now();
      const today = sky.parseLocal(new Date(now).toLocaleDateString('en-CA', { timeZone: tz }) + `T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz).getTime();
      at = today > now ? today : today + 86400e3;
    } else {
      at = sky.parseLocal(v, tz).getTime();
    }
    if (!Number.isFinite(at) || at <= Date.now()) throw new Error(`end time "${v}" is not in the future`);
    return { at, label: new Date(at).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }) };
  }
}

const clamp = (s: number) => Math.max(MIN_S, Math.min(MAX_S, Math.round(s)));
const band = (b?: number) => (b === undefined ? 9 : b <= 10 ? 0 : b <= 15 ? 1 : b <= 25 ? 2 : 9);
const fmtMin = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
