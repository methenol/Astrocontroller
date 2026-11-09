/**
 * The observing journal: one file per night (DATA_DIR/journal/<night>.json, the night being the
 * local date of its sunset), holding
 *
 * - sessions: one per visit to a target, with its timeline (GoTo, focus, stack start, rejections,
 *   stack end…), samples of the stack's progress, and its statistics (time to get on target, focus,
 *   stacking, frames kept and rejected, integration, altitude, the Moon, the sky);
 * - events: what happened to the night as a whole (duty, roof, link, plan changes, holds);
 * - notes: the owner's and the agent's.
 *
 * The recorder (night/recorder.ts) writes sessions from the telescope's state, whatever the driver;
 * the plan (night/progress.ts) reads them back for what was collected and what a switch costs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { errMsg, logger } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';
import { SafeEmitter } from '../util/events.js';

const log = logger('journal');

export type MarkKind =
  | 'goto-start'
  | 'goto-done'
  | 'goto-failed'
  | 'focus-start'
  | 'focus-done'
  | 'focus-failed'
  | 'finefocus-start'
  | 'finefocus-done'
  | 'stack-start'
  | 'reject'
  | 'stack-end'
  | 'obscured'
  | 'link-lost'
  | 'link-back'
  | 'note'
  | 'event';

export interface Mark {
  at: number;
  kind: MarkKind;
  text?: string;
  /** rejections in this burst, frames at stack end */
  n?: number;
  /** the focuser position (focus-done) */
  value?: number;
}

export interface StackQuality {
  at: number;
  stars?: number;
  hfrPx?: number | null;
  background?: number;
  note?: string;
}

export interface SessionStats {
  /** GoTo start to on target (slew, plate solve, centring), seconds */
  acquireS?: number;
  gotoAttempts?: number;
  /** autofocus and fine focus, seconds */
  focusS?: number;
  focusPosition?: number;
  /** first stack start to the last stack end, seconds */
  stackS?: number;
  framesTaken?: number;
  stacked?: number;
  rejected?: number;
  rejectionPct?: number;
  subS?: number;
  gain?: number;
  filter?: string;
  camera?: string;
  /** stacked frames × sub length (or the integration the scope reports) */
  integrationS?: number;
  /** integration per minute of stacking wall time, percent */
  efficiencyPct?: number;
  altStart?: number;
  altEnd?: number;
  altMax?: number;
  azStart?: number;
  moonSepDeg?: number;
  moonIllumPct?: number;
  moonAltDeg?: number;
  /** forecast observability (0–100) at the session's start */
  sky?: number;
  quality?: StackQuality;
}

export interface JournalSession {
  id: string;
  target: string;
  displayName?: string;
  startedAt: number;
  endedAt?: number;
  status: 'active' | 'done' | 'aborted' | 'failed';
  endReason?: string;
  /** the plan block it was carrying out, when the plan had one for it */
  planBlockId?: string;
  planned?: boolean;
  marks: Mark[];
  /** the stack every few minutes: frames kept and rejected, altitude */
  samples: Array<{ at: number; stacked: number; rejected: number; alt?: number }>;
  stats: SessionStats;
}

export interface JournalNote {
  id: string;
  at: number;
  author: 'user' | 'agent';
  text: string;
  target?: string;
}

export interface NightEvent {
  at: number;
  kind: string;
  text: string;
  target?: string;
}

export interface JournalNight {
  night: string;
  sessions: JournalSession[];
  events: NightEvent[];
  notes: JournalNote[];
}

export interface NightSummary {
  night: string;
  sessions: number;
  targets: string[];
  integrationMin: number;
  stacked: number;
  rejected: number;
  acquireMin: number;
  focusMin: number;
  notes: number;
  firstAt: number | null;
  lastAt: number | null;
}

const NIGHT = /^\d{4}-\d{2}-\d{2}$/;
const SAVE_DELAY_MS = 2_000;
const MAX_EVENTS = 400;
const MAX_MARKS = 400;
const MAX_SAMPLES = 300;

const id = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function summarize(n: JournalNight): NightSummary {
  const sum = (f: (s: JournalSession) => number | undefined) => n.sessions.reduce((a, s) => a + (f(s) ?? 0), 0);
  const ats = [...n.sessions.map((s) => s.startedAt), ...n.events.map((e) => e.at)];
  const ends = [...n.sessions.map((s) => s.endedAt ?? s.startedAt), ...n.events.map((e) => e.at)];
  return {
    night: n.night,
    sessions: n.sessions.length,
    targets: [...new Set(n.sessions.map((s) => s.displayName ?? s.target))],
    integrationMin: Math.round(sum((s) => s.stats.integrationS) / 60),
    stacked: sum((s) => s.stats.stacked),
    rejected: sum((s) => s.stats.rejected),
    // to a tenth: a one-click GoTo takes under half a minute, so whole minutes read 0
    acquireMin: Math.round(sum((s) => s.stats.acquireS) / 6) / 10,
    focusMin: Math.round(sum((s) => s.stats.focusS) / 60),
    notes: n.notes.length,
    firstAt: ats.length ? Math.min(...ats) : null,
    lastAt: ends.length ? Math.max(...ends) : null,
  };
}

export class Journal extends SafeEmitter {
  private readonly cache = new Map<string, JournalNight>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  readonly dir: string;

  constructor(opts: { dir?: string } = {}) {
    super();
    this.dir = opts.dir ?? path.join(config.paths.data, 'journal');
  }

  private file(night: string): string {
    return path.join(this.dir, `${night}.json`);
  }

  /** A night's journal (an empty one when nothing was recorded). */
  night(night: string): JournalNight {
    if (!NIGHT.test(night)) throw new Error(`"${night}" is not a night (YYYY-MM-DD)`);
    const hit = this.cache.get(night);
    if (hit) return hit;
    let n: JournalNight = { night, sessions: [], events: [], notes: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(night), 'utf8')) as Partial<JournalNight>;
      n = { night, sessions: Array.isArray(raw.sessions) ? raw.sessions : [], events: Array.isArray(raw.events) ? raw.events : [], notes: Array.isArray(raw.notes) ? raw.notes : [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${this.file(night)}: ${errMsg(e)}`);
    }
    this.cache.set(night, n);
    return n;
  }

  /** The nights with a journal, newest first. */
  nights(): string[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      /* none yet */
    }
    const keys = new Set([...files.map((f) => f.replace(/\.json$/, '')).filter((k) => NIGHT.test(k)), ...this.cache.keys()]);
    return [...keys].filter((k) => {
      const n = this.night(k);
      return n.sessions.length || n.events.length || n.notes.length;
    }).sort().reverse();
  }

  /** The most recent nights' sessions, newest night first (for what the plan learns from). */
  recentSessions(nights = 30): Array<JournalSession & { night: string }> {
    return this.nights().slice(0, nights).flatMap((k) => this.night(k).sessions.map((s) => ({ ...s, night: k })));
  }

  changed(night: string): void {
    this.dirty.add(night);
    this.emit('change', night);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const k of this.dirty) {
      const n = this.cache.get(k);
      if (!n) continue;
      try {
        writeFileAtomic(this.file(k), JSON.stringify(n, null, 1));
      } catch (e) {
        log.warn(`could not save the journal of ${k}: ${errMsg(e)}`);
      }
    }
    this.dirty.clear();
  }

  event(night: string, kind: string, text: string, at = Date.now(), target?: string): void {
    const n = this.night(night);
    n.events.push({ at, kind, text: text.slice(0, 600), ...(target ? { target } : {}) });
    if (n.events.length > MAX_EVENTS) n.events.splice(0, n.events.length - MAX_EVENTS);
    this.changed(night);
  }

  addNote(night: string, o: { text: string; author: 'user' | 'agent'; target?: string; at?: number }): JournalNote {
    const text = o.text.trim();
    if (!text) throw new Error('a note needs text');
    const note: JournalNote = { id: id('note'), at: o.at ?? Date.now(), author: o.author, text: text.slice(0, 4000), ...(o.target ? { target: o.target } : {}) };
    const n = this.night(night);
    n.notes.push(note);
    // the note shows on the timeline of the session it was written during
    const s = n.sessions.find((x) => x.status === 'active' && (!o.target || x.target === o.target));
    if (s) this.mark(night, s, { at: note.at, kind: 'note', text: text.slice(0, 120) });
    this.changed(night);
    return note;
  }

  updateNote(night: string, noteId: string, text: string): JournalNote {
    const note = this.night(night).notes.find((x) => x.id === noteId);
    if (!note) throw new Error(`no note ${noteId} in ${night}`);
    if (!text.trim()) throw new Error('a note needs text');
    note.text = text.trim().slice(0, 4000);
    this.changed(night);
    return note;
  }

  deleteNote(night: string, noteId: string): void {
    const n = this.night(night);
    const i = n.notes.findIndex((x) => x.id === noteId);
    if (i < 0) throw new Error(`no note ${noteId} in ${night}`);
    n.notes.splice(i, 1);
    this.changed(night);
  }

  openSession(night: string, o: { target: string; displayName?: string; at?: number; planBlockId?: string; planned?: boolean }): JournalSession {
    const s: JournalSession = {
      id: id('ses'),
      target: o.target,
      displayName: o.displayName,
      startedAt: o.at ?? Date.now(),
      status: 'active',
      planBlockId: o.planBlockId,
      planned: o.planned,
      marks: [],
      samples: [],
      stats: {},
    };
    this.night(night).sessions.push(s);
    this.changed(night);
    return s;
  }

  mark(night: string, s: JournalSession, m: Mark): void {
    s.marks.push(m);
    if (s.marks.length > MAX_MARKS) s.marks.splice(0, s.marks.length - MAX_MARKS);
    this.changed(night);
  }

  sample(night: string, s: JournalSession, x: JournalSession['samples'][number]): void {
    s.samples.push(x);
    // long sessions keep every other sample of their first half
    if (s.samples.length > MAX_SAMPLES) s.samples = s.samples.filter((_, i) => i % 2 === 0 || i > s.samples.length / 2);
    this.changed(night);
  }

  closeSession(night: string, s: JournalSession, status: JournalSession['status'], reason: string, at = Date.now()): void {
    if (s.status !== 'active') return;
    s.status = status;
    s.endedAt = at;
    s.endReason = reason;
    this.changed(night);
    this.emit('session', night, s);
  }

  /**
   * Sessions still "active" in a night other than `current`: the server was down when that night
   * ended. They are closed at their last entry, so a timeline never runs on into the next day.
   */
  closeStale(current: string | null): number {
    let n = 0;
    for (const k of this.nights()) {
      if (k === current) continue;
      for (const s of this.night(k).sessions) {
        if (s.status !== 'active') continue;
        const last = Math.max(s.startedAt, ...s.marks.map((m) => m.at), ...s.samples.map((x) => x.at));
        this.closeSession(k, s, s.marks.some((m) => m.kind === 'stack-start') ? 'done' : 'aborted', 'the night ended while Astrocontroller was not running', last);
        n++;
      }
    }
    return n;
  }

  summary(night: string): NightSummary {
    return summarize(this.night(night));
  }
}
