import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { Cmd } from './protocol.js';

/**
 * Everything exchanged with the telescope's control service, one line each, so that a hang can be
 * traced back to what preceded it: commands sent (with their parameters), replies, notifications,
 * and the link's own events. Kept in memory (the last entries, for telescope_status and the API)
 * and in data/telescope-wire.log (rotated at 8 MB, one previous file kept).
 *
 * Lines are written in batches, a quarter second apart, so a burst of notifications costs one
 * write rather than one per packet. flushWire() writes what is pending (shutdown).
 */
const MAX_BYTES = 8 * 1024 * 1024;
const RING = 400;
const FLUSH_MS = 250;
/** Pending text beyond this is written at once rather than waiting for the timer. */
const FLUSH_BYTES = 64 * 1024;
/** Payload text kept per line: replies in full (a state read is ~1 KB; cut at 240 chars it hid the wide camera's state, 2026-10-12). */
const REPLY_CHARS = 2000;
const OTHER_CHARS = 240;

const NAMES = new Map<number, string>(Object.entries(Cmd).map(([k, v]) => [v as number, k]));
export const cmdName = (cmd: number): string => NAMES.get(cmd) ?? String(cmd);

export interface WireEntry {
  t: number;
  /** '>' sent, '<' reply, '~' notification, '!' link event, 'x' timeout / unanswered */
  dir: '>' | '<' | '~' | '!' | 'x';
  what: string;
}

function short(v: unknown, max: number): string {
  let s: string | undefined;
  try {
    s = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
  } catch {
    s = String(v);
  }
  if (s === undefined) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** One entry, one line: newlines inside an error text would split it. */
const oneLine = (s: string): string => s.replace(/\r?\n\s*/g, ' ⏎ ');

export class WireLog {
  private readonly ring: WireEntry[] = [];
  private pending: string[] = [];
  private pendingBytes = 0;
  private size = -1;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: () => string,
    private readonly opts: { maxBytes?: number; ring?: number; now?: () => number } = {},
  ) {}

  add(dir: WireEntry['dir'], what: string, data?: unknown): void {
    const t = (this.opts.now ?? Date.now)();
    const text = data === undefined ? what : `${what} ${short(data, dir === '<' ? REPLY_CHARS : OTHER_CHARS)}`;
    const e: WireEntry = { t, dir, what: oneLine(text) };
    this.ring.push(e);
    const keep = this.opts.ring ?? RING;
    if (this.ring.length > keep) this.ring.splice(0, this.ring.length - keep);
    const line = `${new Date(t).toISOString()} ${dir} ${e.what}\n`;
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  /** The most recent entries, oldest first. */
  recent(n: number): WireEntry[] {
    return n > 0 ? this.ring.slice(-n) : [];
  }

  /** Write what is pending now. The log must never break control: write errors are dropped. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const text = this.pending.join('');
    const bytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const file = this.file();
    try {
      if (this.size < 0) this.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (this.size > 0 && this.size + bytes > (this.opts.maxBytes ?? MAX_BYTES)) this.rotate(file);
      fs.appendFileSync(file, text);
      this.size += bytes;
    } catch {
      this.size = -1; // re-read the size next time (the file may have been moved or the disk freed)
    }
  }

  /** Keep one previous file; if it cannot be replaced, start the log afresh rather than stop logging. */
  private rotate(file: string): void {
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      fs.truncateSync(file, 0);
    }
    this.size = 0;
  }
}

const log = new WireLog(() => path.join(config.paths.data, 'telescope-wire.log'));

export function wire(dir: WireEntry['dir'], what: string, data?: unknown): void {
  log.add(dir, what, data);
}

/** Write pending lines to the file now (shutdown). */
export function flushWire(): void {
  log.flush();
}

/** The most recent entries, oldest first. */
export function recentWire(n = 60): WireEntry[] {
  return log.recent(n);
}

/** Readable lines for the agent and the UI. */
export function wireLines(n = 60, opts: { notifications?: boolean } = {}): string[] {
  const src = opts.notifications === false ? log.recent(RING).filter((e) => e.dir !== '~').slice(-n) : log.recent(n);
  return src.map((e) => `${new Date(e.t).toISOString().slice(11, 19)} ${e.dir} ${e.what}`);
}
