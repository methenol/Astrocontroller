import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info;

export const logBus = new EventEmitter();
const ring: LogEntry[] = [];
const RING_SIZE = 500;

export function recentLogs(limit = 200): LogEntry[] {
  return ring.slice(-limit);
}

function emit(level: LogLevel, scope: string, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, scope, msg };
  if (LEVELS[level] >= threshold) {
    const line = `${new Date(entry.ts).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  }
  if (level === 'debug') return;
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  logBus.emit('log', entry);
}

export function logger(scope: string) {
  return {
    debug: (msg: string) => emit('debug', scope, msg),
    info: (msg: string) => emit('info', scope, msg),
    warn: (msg: string) => emit('warn', scope, msg),
    error: (msg: string) => emit('error', scope, msg),
  };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
