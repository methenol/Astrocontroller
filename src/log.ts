import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_SIZE = 500;

function thresholdFrom(v: string | undefined): number {
  const name = (v ?? '').trim().toLowerCase();
  if (name === '') return LEVELS.info;
  if (Object.hasOwn(LEVELS, name)) return LEVELS[name as LogLevel];
  console.error(`LOG_LEVEL "${v}" is not one of debug | info | warn | error: using info`);
  return LEVELS.info;
}

const threshold = thresholdFrom(process.env.LOG_LEVEL);

/** Every entry at info and above, for the web UI's log view (one listener per open socket). */
export const logBus = new EventEmitter();
logBus.setMaxListeners(0);
const ring: LogEntry[] = [];

export function recentLogs(limit = 200): LogEntry[] {
  return limit > 0 ? ring.slice(-limit) : [];
}

function emit(level: LogLevel, scope: string, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, scope, msg };
  if (LEVELS[level] >= threshold) {
    const line = `${new Date(entry.ts).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }
  if (level === 'debug') return;
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  // logging never throws into the code that logs: a failing listener is reported on stderr only
  for (const fn of logBus.rawListeners('log') as Array<(e: LogEntry) => void>) {
    try {
      fn(entry);
    } catch (err) {
      console.error(`a log listener failed: ${errMsg(err)}`);
    }
  }
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (msg) => emit('debug', scope, msg),
    info: (msg) => emit('info', scope, msg),
    warn: (msg) => emit('warn', scope, msg),
    error: (msg) => emit('error', scope, msg),
  };
}

/** The message of anything thrown: an Error's message, an error-like object's message, or its text. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  const m = (err as { message?: unknown } | null)?.message;
  if (typeof m === 'string' && m) return m;
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}
