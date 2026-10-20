/**
 * The telescope's JSON API on :8082 and the SD-card file server on :80, with a health record of
 * the camera service behind them.
 */
import { config } from '../../config.js';
import { assertLinked } from '../gate.js';
import { parseBigSafe } from './json.js';

export const API_TIMEOUT_MS = 15_000;
/** A whole SD-card file read: a 16 MB sub over the telescope's Wi-Fi while it live-stacks took over 60 s (2026-10-16 analyze_subs). */
export const FILE_TIMEOUT_MS = 5 * 60_000;
/** A file read into memory is refused past this (a stacked FITS is ~100 MB; a video can be gigabytes). */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** This many timeouts in a row, with no answer between, means the camera service has hung. */
const HUNG_AFTER_TIMEOUTS = 2;

const apiBase = () => `http://${config.dwarf.host}:${config.dwarf.httpPort}`;

/**
 * Health of the telescope's HTTP API, which carries everything camera-related (settings, the
 * parameter schema behind exposure/gain changes, stills). Verified 2026-10-03: its camera service
 * can hang while the control link and the motors keep working; every camera call then times out
 * until the telescope is rebooted.
 */
class ApiHealthRecord {
  lastOkAt = 0;
  timeoutsSinceOk = 0;
  firstTimeoutAt = 0;
  lastTimeoutPath = '';

  answered(now = Date.now()): void {
    this.lastOkAt = now;
    this.timeoutsSinceOk = 0;
    this.firstTimeoutAt = 0;
  }

  timedOut(path: string, now = Date.now()): void {
    if (this.timeoutsSinceOk === 0) this.firstTimeoutAt = now;
    this.timeoutsSinceOk++;
    this.lastTimeoutPath = path;
  }

  reset(): void {
    this.lastOkAt = this.timeoutsSinceOk = this.firstTimeoutAt = 0;
    this.lastTimeoutPath = '';
  }
}

const health = new ApiHealthRecord();

export interface ApiHealth {
  cameraService: 'ok' | 'one recent timeout' | 'NOT RESPONDING';
  consecutiveTimeouts: number;
  timingOutSince: string | null;
  timingOutForMin: number;
  lastTimedOut: string | null;
  lastAnsweredAgoS: number | null;
}

export function apiHealth(now = Date.now()): ApiHealth {
  const n = health.timeoutsSinceOk;
  return {
    cameraService: n >= HUNG_AFTER_TIMEOUTS ? 'NOT RESPONDING' : n > 0 ? 'one recent timeout' : 'ok',
    consecutiveTimeouts: n,
    timingOutSince: health.firstTimeoutAt ? new Date(health.firstTimeoutAt).toISOString() : null,
    timingOutForMin: health.firstTimeoutAt ? Math.round((now - health.firstTimeoutAt) / 60_000) : 0,
    lastTimedOut: health.lastTimeoutPath || null,
    lastAnsweredAgoS: health.lastOkAt ? Math.round((now - health.lastOkAt) / 1000) : null,
  };
}

/** Forget the health record (another telescope address). */
export function resetApiHealth(): void {
  health.reset();
}

/** What a timeout means, for tool errors. */
export function timeoutExplanation(): string {
  const h = apiHealth();
  if (h.consecutiveTimeouts >= HUNG_AFTER_TIMEOUTS) {
    return `The telescope's camera service is NOT RESPONDING: ${h.consecutiveTimeouts} timeouts in a row over ${h.timingOutForMin} min (last: ${h.lastTimedOut}). Settings, stills, sky checks and plate-solving all fail in this state while motion and the control link still work. Probing again will not fix it; a telescope reboot does (power action=reboot, then motors_home). This says nothing about the sky.`;
  }
  return `The telescope's HTTP API did not answer in time (${h.lastTimedOut ?? 'camera call'}). One timeout can be Wi-Fi; if the next camera call also times out, the camera service has hung (see telescope_status.health). This says nothing about the sky.`;
}

const isTimeout = (err: unknown): boolean => {
  const e = err as { name?: unknown; message?: unknown } | null;
  return e?.name === 'TimeoutError' || /timeout/i.test(String(e?.message ?? ''));
};

/** The API's envelope: `code` 0 is success, anything else an error with an optional message. */
interface Envelope<T> {
  code?: unknown;
  data?: T;
  message?: unknown;
}

/** One JSON API call. Throws on transport errors, HTTP errors, unparseable answers and nonzero codes. */
export async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  assertLinked();
  let res: Response;
  let text: string;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if (isTimeout(err)) health.timedOut(path);
    throw err;
  }
  // any answer, even an HTTP error, means the service is alive
  health.answered();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  let json: Envelope<T>;
  try {
    json = parseBigSafe(text) as Envelope<T>;
  } catch {
    throw new Error(`device API ${path} answered with something that is not JSON: ${text.slice(0, 120)}`);
  }
  if (!json || typeof json !== 'object') throw new Error(`device API ${path} answered without an envelope`);
  if (json.code !== 0) throw new Error(`device API ${path} returned code ${String(json.code)}${typeof json.message === 'string' && json.message ? `: ${json.message}` : ''}`);
  return json.data as T;
}

/** A device path that stays on the card: absolute, no `..`, no empty or control characters. */
function cardPath(devicePath: string): string {
  const p = devicePath.startsWith('/') ? devicePath : `/${devicePath}`;
  if (p.split('/').some((s) => s === '..' || s === '.')) throw new Error(`not a card path: ${devicePath}`);
  if (/[\x00-\x1f]/.test(p)) throw new Error(`not a card path: ${JSON.stringify(devicePath)}`);
  return p;
}

/** URL for a file on the SD card (served from :80, rooted at the card). */
export function fileUrl(devicePath: string): string {
  return `http://${config.dwarf.host}${cardPath(devicePath).split('/').map(encodeURIComponent).join('/')}`;
}

export async function fetchFile(devicePath: string, timeoutMs = FILE_TIMEOUT_MS, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
  assertLinked();
  const res = await fetch(fileUrl(devicePath), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status} fetching ${devicePath}`);
  }
  const tooBig = () => new Error(`${devicePath} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB: too large to read into memory (transfer it to the library instead)`);
  const announced = Number(res.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  // counted while reading: a server that announces no length (or the wrong one) is held to the limit too
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooBig();
    }
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts, total);
}
