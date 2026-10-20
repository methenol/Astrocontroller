/** GET JSON from a weather provider, retrying the failures a field connection produces. */
import { scheduler } from 'node:timers/promises';
import { logger, errMsg } from '../../log.js';

const log = logger('weather');

export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Worth trying again: a connect stall, a slow provider, or a server that asked for a resend. */
export function transient(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown }; status?: unknown } | null;
  if (typeof e?.status === 'number') return e.status === 408 || e.status === 429 || e.status >= 500;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true;
  return /ECONN|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO|EALREADY|ETIMEDOUT|UND_ERR|SOCKET_HANG|FETCH_FAILED|TIMEOUT/i.test(`${String(e?.cause?.code ?? '')} ${String(e?.message ?? '')}`);
}

export interface GetJsonOptions {
  timeoutMs?: number;
  attempts?: number;
  deadlineMs?: number;
  /** wait before retry n is n × this */
  backoffMs?: number;
  fetch?: Fetch;
}

const USER_AGENT = 'astrocontroller/0.1';
/** An attempt with less than this left before the deadline is not started. */
const MIN_ATTEMPT_MS = 500;

/**
 * GET and parse JSON, retrying.
 *
 * Open-Meteo answers in under a second when the connection is warm, but the first call after a
 * spell of silence can stall in DNS/TCP for tens of seconds and then answer in 0.7 s (measured
 * repeatedly here). One attempt with a 12 s timeout turned every such stall into a blank weather
 * card, which is what made the Tonight tab fail periodically. So: a longer per-attempt budget,
 * three attempts with a short wait between them, and a deadline on the whole call so a caller with
 * nothing cached is not left waiting indefinitely.
 */
export async function getJson(url: string, opts: GetJsonOptions = {}): Promise<unknown> {
  const { timeoutMs = 20_000, attempts = 3, backoffMs = 1500 } = opts;
  const doFetch = opts.fetch ?? fetch;
  const deadline = Date.now() + (opts.deadlineMs ?? 45_000);
  const host = new URL(url).host;
  let last: unknown;
  let tried = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const left = deadline - Date.now();
    if (left <= MIN_ATTEMPT_MS) break;
    tried = attempt;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, left)), headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new HttpError(`HTTP ${res.status} from ${host}`, res.status);
      }
      // Read the body inside the attempt: a connection that stalls after the headers is a failed
      // attempt, not a success.
      return (await res.json()) as unknown;
    } catch (err) {
      last = err;
      if (!transient(err) || attempt === attempts) break;
      log.debug(`${host}: attempt ${attempt} failed (${errMsg(err)}); retrying`);
      // Wait out the blip before trying again; a retry in the same millisecond sees the same stall.
      await scheduler.wait(backoffMs * attempt);
    }
  }
  const why = last === undefined ? 'no time left to try' : last instanceof HttpError ? last.message : errMsg(last) || 'no response';
  throw new Error(`${host}: ${why} (attempt ${tried} of ${attempts})`);
}
