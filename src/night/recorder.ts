/**
 * The journal's recorder: it watches the telescope's state through a small per-driver probe
 * (drivers/<id>/journal.ts) and writes what happened as sessions, whatever started it (the agent,
 * the web UI, the scope itself).
 *
 * A session opens when a GoTo starts toward a target (or a stack starts on one with no GoTo), and
 * collects that visit's timeline: the GoTo and how long it took to get on target, autofocus and the
 * fine focus with the position they ended on, the stack's start, its rejections (bursts within a
 * couple of minutes are one mark), its end, link drops. It closes when the next target's GoTo or
 * stack starts, or once it has sat idle after its stack ended, or at the end of the night.
 */
import { logger, errMsg } from '../log.js';
import { findObject, displayName } from '../astro/catalog.js';
import * as sky from '../astro/sky.js';
import type { HourConditions } from '../astro/weather.js';
import type { Journal, JournalSession, StackQuality } from './journal.js';
import { nightKey } from './clock.js';

const log = logger('journal');

export type OpState = 'idle' | 'running' | 'complete' | 'failed';

/** The telescope as the journal sees it: the same small shape for every driver. */
export interface ScopeSnapshot {
  connected: boolean;
  goto: { state: OpState; target?: string };
  autofocus: { state: OpState };
  /** the fine focus on the stars (star_focus sweep) */
  fineFocus: { running: boolean; result?: string };
  focusPosition?: number;
  stack: {
    running: boolean;
    target?: string;
    /** frames kept by the stacker so far, and rejected */
    stacked?: number;
    rejected?: number;
    subS?: number;
    gain?: number;
    filter?: string;
    camera?: string;
    /** the integration the scope itself reports, seconds (else stacked × subS) */
    integrationS?: number;
    error?: string;
  };
  /** where the scope points, J2000, when it knows */
  pointing?: { raHours: number; decDeg: number };
}

export interface JournalProbe {
  snapshot(): ScopeSnapshot;
  on(event: 'state', f: () => void): unknown;
  off(event: 'state', f: () => void): unknown;
  /** measure the stack the scope holds (stars, HFR, background); null when it cannot */
  assessStack?(): Promise<Omit<StackQuality, 'at'> | null>;
}

export interface RecorderDeps {
  journal: Journal;
  probe: JournalProbe;
  site: () => sky.Site | null;
  /** the forecast at a moment, for the session's sky score */
  conditions?: () => Promise<((t: Date) => HourConditions | undefined) | null>;
  /** the plan's block for a target now, so a session is tied to it */
  planBlockFor?: (target: string, at: number) => { id: string } | null;
  now?: () => number;
  /** settle the state this long before diffing (a burst of state events is one change) */
  settleMs?: number;
}

/** An idle session (its stack ended) closes after this long. */
const IDLE_CLOSE_MS = 20 * 60_000;
/** Rejections within this long of the last are one burst on the timeline. */
const REJECT_BURST_MS = 120_000;
/** A stack sample every this long. */
const SAMPLE_MS = 5 * 60_000;
const TICK_MS = 30_000;
const ASSESS_TIMEOUT_MS = 45_000;

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

export class JournalRecorder {
  private prev: ScopeSnapshot | null = null;
  private current: { night: string; s: JournalSession; idleSince?: number; lastSampleAt?: number; lastRejectAt?: number; gotoAt?: number; focusAt?: number; fineAt?: number; stackAt?: number; baseRejected?: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private settle: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly onState = () => this.schedule();

  constructor(private readonly d: RecorderDeps) {
    this.now = d.now ?? Date.now;
  }

  start(): void {
    const closed = this.d.journal.closeStale(this.nightNow());
    if (closed) log.info(`journal: closed ${closed} session(s) left open by a night that ended while the server was down`);
    this.d.probe.on('state', this.onState);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.observe();
  }

  stop(): void {
    this.d.probe.off('state', this.onState);
    if (this.timer) clearInterval(this.timer);
    if (this.settle) clearTimeout(this.settle);
    this.timer = this.settle = null;
    this.d.journal.flush();
  }

  /** The session being recorded now, if any. */
  active(): { night: string; session: JournalSession } | null {
    return this.current && this.current.s.status === 'active' ? { night: this.current.night, session: this.current.s } : null;
  }

  private schedule(): void {
    const ms = this.d.settleMs ?? 250;
    if (ms <= 0) return this.observe();
    if (this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = null;
      this.observe();
    }, ms);
    this.settle.unref?.();
  }

  private nightNow(): string | null {
    const site = this.d.site();
    if (!site) return null;
    try {
      return nightKey(site, new Date(this.now()));
    } catch {
      return null;
    }
  }

  /** Diff the probe's state against the last one and write what changed (the timer and the tests call it too). */
  observe(): void {
    let cur: ScopeSnapshot;
    try {
      cur = this.d.probe.snapshot();
    } catch (e) {
      log.debug(`journal probe: ${errMsg(e)}`);
      return;
    }
    const prev = this.prev;
    this.prev = structuredClone(cur);
    const night = this.nightNow();
    if (!night) return;
    const t = this.now();

    if (prev && prev.connected !== cur.connected) {
      this.d.journal.event(night, 'link', cur.connected ? 'telescope connected' : 'telescope connection lost', t);
      if (this.current) this.mark({ at: t, kind: cur.connected ? 'link-back' : 'link-lost' });
    }
    if (!cur.connected) return;

    // ---- GoTo
    const gotoStarted = cur.goto.state === 'running' && prev?.goto.state !== 'running';
    if (gotoStarted) {
      const target = cur.goto.target ?? cur.stack.target ?? 'unknown target';
      const same = this.current && norm(this.current.s.target) === norm(target) && this.current.s.status === 'active';
      if (!same) this.open(night, target, t);
      this.current!.gotoAt = t;
      this.current!.s.stats.gotoAttempts = (this.current!.s.stats.gotoAttempts ?? 0) + 1;
      this.mark({ at: t, kind: 'goto-start', text: `GoTo ${target}` });
    }
    if (prev?.goto.state === 'running' && cur.goto.state !== 'running' && this.current) {
      const c = this.current;
      const ok = cur.goto.state === 'complete';
      const secs = c.gotoAt ? Math.round((t - c.gotoAt) / 1000) : undefined;
      this.mark({ at: t, kind: ok ? 'goto-done' : 'goto-failed', text: ok ? `on target${secs !== undefined ? ` in ${fmtS(secs)}` : ''}` : `GoTo ${cur.goto.state === 'failed' ? 'failed' : 'ended'}` });
      if (secs !== undefined) c.s.stats.acquireS = (c.s.stats.acquireS ?? 0) + secs;
      if (ok) this.position(c.s, t, 'start');
      c.gotoAt = undefined;
    }

    // ---- focus
    if (cur.autofocus.state === 'running' && prev?.autofocus.state !== 'running') {
      this.ensure(night, cur, t);
      this.current!.focusAt = t;
      this.mark({ at: t, kind: 'focus-start', text: 'autofocus' });
    }
    if (prev?.autofocus.state === 'running' && cur.autofocus.state !== 'running' && this.current) {
      const c = this.current;
      const ok = cur.autofocus.state !== 'failed';
      const secs = c.focusAt ? Math.round((t - c.focusAt) / 1000) : 0;
      c.s.stats.focusS = (c.s.stats.focusS ?? 0) + secs;
      if (ok && cur.focusPosition !== undefined) c.s.stats.focusPosition = cur.focusPosition;
      this.mark({ at: t, kind: ok ? 'focus-done' : 'focus-failed', text: ok ? `autofocus ${cur.focusPosition !== undefined ? `at ${cur.focusPosition}` : 'done'} (${fmtS(secs)})` : 'autofocus failed', value: ok ? cur.focusPosition : undefined });
      c.focusAt = undefined;
    }
    if (cur.fineFocus.running && !prev?.fineFocus.running) {
      this.ensure(night, cur, t);
      this.current!.fineAt = t;
      this.mark({ at: t, kind: 'finefocus-start', text: 'fine focus on the stars' });
    }
    if (prev?.fineFocus.running && !cur.fineFocus.running && this.current) {
      const c = this.current;
      const secs = c.fineAt ? Math.round((t - c.fineAt) / 1000) : 0;
      c.s.stats.focusS = (c.s.stats.focusS ?? 0) + secs;
      if (cur.focusPosition !== undefined) c.s.stats.focusPosition = cur.focusPosition;
      this.mark({ at: t, kind: 'finefocus-done', text: `fine focus${cur.focusPosition !== undefined ? ` at ${cur.focusPosition}` : ''}${cur.fineFocus.result ? `: ${cur.fineFocus.result.slice(0, 140)}` : ''} (${fmtS(secs)})`, value: cur.focusPosition });
      c.fineAt = undefined;
    }
    if (prev && cur.focusPosition !== undefined && this.current && !cur.fineFocus.running && cur.autofocus.state !== 'running' && cur.focusPosition !== prev.focusPosition && this.current.s.stats.focusPosition !== undefined) {
      // a hand move after the focus: the position it is collecting on
      this.current.s.stats.focusPosition = cur.focusPosition;
    }

    // ---- stacking
    const stackStarted = cur.stack.running && !prev?.stack.running;
    if (stackStarted) {
      const target = cur.stack.target ?? this.current?.s.target ?? cur.goto.target ?? 'unknown target';
      if (!this.current || this.current.s.status !== 'active' || norm(this.current.s.target) !== norm(target)) this.open(night, target, t);
      const c = this.current!;
      c.stackAt = t;
      c.idleSince = undefined;
      c.baseRejected = cur.stack.rejected ?? 0;
      Object.assign(c.s.stats, { subS: cur.stack.subS ?? c.s.stats.subS, gain: cur.stack.gain ?? c.s.stats.gain, filter: cur.stack.filter ?? c.s.stats.filter, camera: cur.stack.camera ?? c.s.stats.camera });
      if (c.s.stats.altStart === undefined) this.position(c.s, t, 'start');
      this.mark({ at: t, kind: 'stack-start', text: `stacking${cur.stack.subS ? ` ${cur.stack.subS} s subs` : ''}${cur.stack.filter ? `, ${cur.stack.filter}` : ''}${prev === null ? ' (already running when the recorder started)' : ''}` });
      void this.skyAt(c.s, t);
    }
    if (cur.stack.running && this.current) {
      const c = this.current;
      const rej = cur.stack.rejected ?? 0;
      const was = prev?.stack.running ? (prev.stack.rejected ?? 0) : rej;
      if (rej > was) {
        const last = c.s.marks[c.s.marks.length - 1];
        if (last?.kind === 'reject' && c.lastRejectAt && t - c.lastRejectAt < REJECT_BURST_MS) {
          last.n = (last.n ?? 0) + (rej - was);
          last.text = `${last.n} frame${last.n === 1 ? '' : 's'} rejected`;
          this.d.journal.changed(c.night);
        } else this.mark({ at: t, kind: 'reject', n: rej - was, text: `${rej - was} frame${rej - was === 1 ? '' : 's'} rejected` });
        c.lastRejectAt = t;
      }
      this.stackStats(c.s, cur, t);
    }
    if (prev?.stack.running && !cur.stack.running && this.current) {
      const c = this.current;
      this.stackStats(c.s, prev.stack.stacked !== undefined && (cur.stack.stacked ?? 0) < prev.stack.stacked ? prev : cur, t);
      this.position(c.s, t, 'end');
      const st = c.s.stats;
      this.mark({ at: t, kind: 'stack-end', n: st.stacked, text: `stack ended: ${st.stacked ?? 0} kept, ${st.rejected ?? 0} rejected${st.integrationS ? `, ${fmtS(st.integrationS)} integrated` : ''}${cur.stack.error ? ` — ${cur.stack.error}` : ''}` });
      c.stackAt = undefined;
      c.idleSince = t;
      this.sampleNow(c, cur, t);
      void this.assess(c.night, c.s);
    }
  }

  private stackStats(s: JournalSession, snap: ScopeSnapshot, t: number): void {
    const st = s.stats;
    const stacked = snap.stack.stacked ?? st.stacked ?? 0;
    const rejected = snap.stack.rejected ?? st.rejected ?? 0;
    st.stacked = stacked;
    st.rejected = rejected;
    st.framesTaken = stacked + rejected;
    st.rejectionPct = st.framesTaken ? Math.round((rejected / st.framesTaken) * 1000) / 10 : 0;
    st.integrationS = snap.stack.integrationS ?? (st.subS ? Math.round(stacked * st.subS) : st.integrationS);
    const firstStack = s.marks.find((m) => m.kind === 'stack-start')?.at;
    if (firstStack) st.stackS = Math.round((t - firstStack) / 1000);
    if (st.integrationS && st.stackS) st.efficiencyPct = Math.min(100, Math.round((st.integrationS / st.stackS) * 100));
    const c = this.current;
    if (c && c.s === s && (!c.lastSampleAt || t - c.lastSampleAt >= SAMPLE_MS)) this.sampleNow(c, snap, t);
  }

  private sampleNow(c: NonNullable<JournalRecorder['current']>, snap: ScopeSnapshot, t: number): void {
    c.lastSampleAt = t;
    const alt = this.altOf(c.s.target, snap, t);
    this.d.journal.sample(c.night, c.s, { at: t, stacked: c.s.stats.stacked ?? 0, rejected: c.s.stats.rejected ?? 0, ...(alt !== undefined ? { alt: Math.round(alt * 10) / 10 } : {}) });
  }

  private altOf(target: string, snap: ScopeSnapshot | null, t: number): number | undefined {
    const site = this.d.site();
    if (!site) return undefined;
    const o = findObject(target);
    const rd = o ? { raHours: o.raHours, decDeg: o.decDeg } : snap?.pointing;
    if (!rd) return undefined;
    return sky.altAz(site, rd.raHours, rd.decDeg, new Date(t)).altitude;
  }

  /** The target's altitude (and at the start, its azimuth and the Moon) at the session's start or end. */
  private position(s: JournalSession, t: number, at: 'start' | 'end'): void {
    const site = this.d.site();
    if (!site) return;
    const o = findObject(s.target);
    const rd = o ? { raHours: o.raHours, decDeg: o.decDeg } : this.prev?.pointing;
    if (!rd) return;
    const when = new Date(t);
    const aa = sky.altAz(site, rd.raHours, rd.decDeg, when);
    const alt = Math.round(aa.altitude * 10) / 10;
    if (at === 'start') {
      s.stats.altStart = alt;
      s.stats.azStart = Math.round(aa.azimuth);
      const moon = sky.moonState(site, when);
      s.stats.moonIllumPct = moon.illuminationPercent;
      s.stats.moonAltDeg = moon.altitude;
      s.stats.moonSepDeg = Math.round(sky.separationDeg(rd.raHours, rd.decDeg, moon.raHours, moon.decDeg));
    } else s.stats.altEnd = alt;
    s.stats.altMax = Math.max(s.stats.altMax ?? -90, alt, ...s.samples.map((x) => x.alt ?? -90));
  }

  private async skyAt(s: JournalSession, t: number): Promise<void> {
    try {
      const f = await this.d.conditions?.();
      const c = f?.(new Date(t));
      if (c && Number.isFinite(c.observability)) s.stats.sky = Math.round(c.observability);
    } catch {
      /* no forecast */
    }
  }

  private async assess(night: string, s: JournalSession): Promise<void> {
    if (!this.d.probe.assessStack || !(s.stats.stacked && s.stats.stacked > 0)) return;
    try {
      const q = await Promise.race([this.d.probe.assessStack(), new Promise<null>((r) => setTimeout(() => r(null), ASSESS_TIMEOUT_MS).unref?.())]);
      if (q) {
        s.stats.quality = { at: this.now(), ...q };
        this.d.journal.changed(night);
      }
    } catch (e) {
      log.debug(`stack assessment: ${errMsg(e)}`);
    }
  }

  private open(night: string, target: string, t: number): void {
    if (this.current?.s.status === 'active') this.close(this.current.s.marks.some((m) => m.kind === 'stack-start') ? 'done' : 'aborted', `moved on to ${target}`, t);
    const o = findObject(target);
    const block = this.d.planBlockFor?.(target, t) ?? null;
    const s = this.d.journal.openSession(night, { target, displayName: o ? displayName(o) : target, at: t, planBlockId: block?.id, planned: !!block });
    this.current = { night, s };
    log.info(`journal: ${target} (${block ? 'planned' : 'not in the plan'})`);
  }

  /** A focus outside any session belongs to the target the scope is on. */
  private ensure(night: string, cur: ScopeSnapshot, t: number): void {
    if (this.current?.s.status === 'active') return;
    this.open(night, cur.goto.target ?? cur.stack.target ?? 'unknown target', t);
  }

  private mark(m: Parameters<Journal['mark']>[2]): void {
    if (!this.current) return;
    this.d.journal.mark(this.current.night, this.current.s, m);
  }

  private close(status: JournalSession['status'], reason: string, t = this.now()): void {
    const c = this.current;
    if (!c || c.s.status !== 'active') return;
    if (c.stackAt && this.prev) this.stackStats(c.s, this.prev, t);
    this.d.journal.closeSession(c.night, c.s, status, reason, t);
  }

  /** The timer: samples, idle sessions closing, the night ending. */
  tick(): void {
    const t = this.now();
    const c = this.current;
    if (!c || c.s.status !== 'active') return;
    if (c.idleSince && t - c.idleSince >= IDLE_CLOSE_MS) {
      this.close('done', 'idle after its stack ended', c.idleSince);
      return;
    }
    const night = this.nightNow();
    if (night && night !== c.night) {
      this.close(c.s.marks.some((m) => m.kind === 'stack-start') ? 'done' : 'aborted', 'the night ended', t);
      return;
    }
    if (this.prev?.stack.running && (!c.lastSampleAt || t - c.lastSampleAt >= SAMPLE_MS)) this.sampleNow(c, this.prev, t);
  }

  /** Mark the active session's target as obscured (from the plan's hold). */
  noteObscured(target: string, text: string, t = this.now()): void {
    const c = this.current;
    if (c && c.s.status === 'active' && norm(c.s.target) === norm(target)) this.mark({ at: t, kind: 'obscured', text });
  }
}

function fmtS(s: number): string {
  const v = Math.max(0, Math.round(s));
  if (v >= 3600) return `${Math.floor(v / 3600)} h ${Math.round((v % 3600) / 60)} min`;
  return v >= 60 ? `${Math.floor(v / 60)} min ${v % 60} s` : `${v} s`;
}
