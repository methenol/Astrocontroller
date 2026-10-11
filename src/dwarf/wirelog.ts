import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { Cmd } from './protocol.js';

/**
 * Everything exchanged with the telescope's control service, one line each, so that a hang can be
 * traced back to what preceded it: commands sent (with their parameters), replies, notifications,
 * and the link's own events. Kept in memory (the last entries, for telescope_status and the API)
 * and in data/telescope-wire.log (rotated at 8 MB, one previous file kept).
 */
const FILE = path.join(config.paths.data, 'telescope-wire.log');
const MAX_BYTES = 8 * 1024 * 1024;
const RING = 400;

const NAMES = new Map<number, string>(Object.entries(Cmd).map(([k, v]) => [v as number, k]));
export const cmdName = (cmd: number): string => NAMES.get(cmd) ?? String(cmd);

export interface WireEntry {
  t: number;
  /** '>' sent, '<' reply, '~' notification, '!' link event, 'x' timeout / unanswered */
  dir: '>' | '<' | '~' | '!' | 'x';
  what: string;
}

const ring: WireEntry[] = [];
let size = -1;

function short(v: unknown, max = 240): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function wire(dir: WireEntry['dir'], what: string, data?: unknown): void {
  const e: WireEntry = { t: Date.now(), dir, what: data === undefined ? what : `${what} ${short(data)}` };
  ring.push(e);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  const line = `${new Date(e.t).toISOString()} ${dir} ${e.what}\n`;
  try {
    if (size < 0) size = fs.existsSync(FILE) ? fs.statSync(FILE).size : 0;
    if (size + line.length > MAX_BYTES) {
      fs.renameSync(FILE, `${FILE}.1`);
      size = 0;
    }
    fs.appendFileSync(FILE, line);
    size += line.length;
  } catch {
    /* the log must never break control */
  }
}

/** The most recent entries, oldest first. */
export function recentWire(n = 60): WireEntry[] {
  return ring.slice(-n);
}

/** Readable lines for the agent and the UI. */
export function wireLines(n = 60, opts: { notifications?: boolean } = {}): string[] {
  const src = opts.notifications === false ? ring.filter((e) => e.dir !== '~').slice(-n) : recentWire(n);
  return src.map((e) => `${new Date(e.t).toISOString().slice(11, 19)} ${e.dir} ${e.what}`);
}
