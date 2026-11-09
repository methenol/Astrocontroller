/**
 * Client for AstroPhoto Studio's programmatic API (/api/v1). Plain fetch + node:http streams,
 * no native dependencies (keeps the controller portable, e.g. to Termux).
 *
 * Nothing about the server's pipeline is hard-coded here: profiles, presets and job kinds come
 * from GET /api/v1, so the server can change them.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { errMsg } from '../log.js';
import { splitCredentials, withoutCredentials } from '../util/url.js';
import type { StudioMosaicReport } from '../night/mosaics.js';

export interface StudioJob {
  id: string;
  kind: string;
  label?: string;
  dataset?: string;
  folders: string[];
  state: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled' | 'interrupted';
  progress: number;
  message?: string;
  stage?: string;
  profile?: string;
  client_ref?: string;
  position?: number;
  starts_in?: number | null;
  active?: number;
  stage_eta?: number | null;
  total_eta?: number | null;
  typical_total?: number | null;
  created?: number;
  started?: number | null;
  ended?: number | null;
  outputs: Array<{ kind: string; name: string; bytes: number; url: string }>;
  /** a done job's result; a mosaic job's has `mosaic`, what it measured */
  result?: { mosaic?: StudioMosaicReport; [k: string]: unknown };
  duplicate?: boolean;
  traceback?: string;
}

export interface StudioInfo {
  version: string;
  api: number;
  devices: { default?: string; gpus?: Array<{ name?: string; [k: string]: unknown }>; [k: string]: unknown };
  images_root: string;
  uploads_root: string;
  default_profile: string;
  profiles: Record<string, { label: string; stack_params: Record<string, unknown>; effective: Record<string, unknown> }>;
  presets: Record<string, Record<string, unknown>>;
  job_kinds: Record<string, string>;
  queue: { running: number; queued: number };
}

export interface ResolveResult {
  folders: string[];
  exists: boolean;
  n_fits: number;
  bytes?: number;
  object?: string;
  filter?: string;
  total_min?: number;
}

export class StudioError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const CALL_TIMEOUT_MS = 20000;
const HEALTH_TIMEOUT_MS = 5000;
/** The first GET /api/v1 imports PyTorch on the server. */
const INFO_TIMEOUT_MS = 60000;
const SUBMIT_TIMEOUT_MS = 60000;
/** An upload that moves no bytes for this long is abandoned. */
const UPLOAD_IDLE_MS = 120000;
const DOWNLOAD_TIMEOUT_MS = 600000;
const ERROR_BODY_CHARS = 300;

export const studioEnabled = () => !!config.studio.url;

/** The server address, and its credentials (user:password in ASTROPHOTO_URL) as an Authorization header. */
function server(): { base: string; headers: Record<string, string> } {
  if (!config.studio.url) throw new StudioError('ASTROPHOTO_URL is not set: processing is off');
  const { url, authorization } = splitCredentials(config.studio.url);
  return { base: url, headers: authorization ? { authorization } : {} };
}

function unreachable(err: unknown): StudioError {
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return new StudioError(`AstroPhoto Studio unreachable at ${withoutCredentials(config.studio.url)} (${cause ?? errMsg(err)})`);
}

/** The server's own explanation of an error: FastAPI's {detail}, else the start of the body. */
function detailOf(data: unknown, text: string): string {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  if (detail !== undefined) return JSON.stringify(detail).slice(0, ERROR_BODY_CHARS);
  return text.slice(0, ERROR_BODY_CHARS);
}

async function call<T>(method: string, apiPath: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const { base, headers } = server();
  let res: Response;
  try {
    res = await fetch(`${base}${apiPath}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw unreachable(err);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw unreachable(err);
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new StudioError(`Studio ${method} ${apiPath}: HTTP ${res.status} ${detailOf(data, text)}`, res.status);
  return data as T;
}

const query = (q: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(q).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)])).toString();

export const health = () => call<{ ok: boolean; version: string; busy: boolean; queued: number }>('GET', '/api/v1/health', undefined, HEALTH_TIMEOUT_MS);
export const info = () => call<StudioInfo>('GET', '/api/v1', undefined, INFO_TIMEOUT_MS);
export const resolve = (body: { paths: string[]; source?: 'images' | 'uploads' }) => call<ResolveResult>('POST', '/api/v1/datasets/resolve', body);
export const submit = (body: Record<string, unknown>) => call<StudioJob & { dataset_info?: ResolveResult }>('POST', '/api/v1/jobs', body, SUBMIT_TIMEOUT_MS);
export const submitMosaic = (body: Record<string, unknown>) => call<StudioJob & { dataset_info?: ResolveResult }>('POST', '/api/v1/mosaics', body, SUBMIT_TIMEOUT_MS);
export const job = (id: string) => call<StudioJob>('GET', `/api/v1/jobs/${encodeURIComponent(id)}`);
export const jobs = (q: { state?: string; client_ref?: string; limit?: number } = {}) => call<{ jobs: StudioJob[] }>('GET', `/api/v1/jobs?${query(q)}`);
export const cancel = (id: string) => call<StudioJob>('POST', `/api/v1/jobs/${encodeURIComponent(id)}/cancel`);
export const queue = () => call<{ running: StudioJob[]; queued: StudioJob[]; drains_in: number | null; external: unknown[] }>('GET', '/api/v1/queue');
export const move = (id: string, position: number) => call<{ queue: string[] }>('POST', '/api/v1/queue/move', { id, position });
export const uploads = (prefix: string) => call<{ root: string; files: Array<{ path: string; bytes: number }> }>('GET', `/api/v1/uploads?${query({ prefix })}`);

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Stream one local file to <uploads>/<remotePath> on the server. Settles once, whatever fails first. */
export async function uploadFile(localFile: string, remotePath: string, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<void> {
  if (remotePath.split('/').some((p) => p === '..' || p === '')) throw new StudioError(`bad upload path ${remotePath}`);
  const { base, headers } = server();
  const url = new URL(`${base}/api/v1/uploads/${encPath(remotePath)}`);
  const size = (await fs.promises.stat(localFile)).size;
  if (signal?.aborted) throw new StudioError(`upload ${remotePath}: cancelled`);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const rs = fs.createReadStream(localFile);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        rs.destroy();
        req.destroy();
        reject(err);
      } else resolve();
    };
    const onAbort = () => finish(new StudioError(`upload ${remotePath}: cancelled`));
    const req = mod.request(url, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': size } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        if (body.length < ERROR_BODY_CHARS) body += d;
      });
      res.on('error', (e) => finish(e));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) finish();
        else finish(new StudioError(`upload ${remotePath}: HTTP ${status} ${body.slice(0, ERROR_BODY_CHARS)}`, status));
      });
    });
    req.setTimeout(UPLOAD_IDLE_MS, () => finish(new StudioError(`upload ${remotePath}: no progress for ${UPLOAD_IDLE_MS / 1000} s`)));
    req.on('error', (e) => finish(unreachable(e)));
    rs.on('data', (c) => onBytes?.(c.length));
    rs.on('error', (e) => finish(e));
    signal?.addEventListener('abort', onAbort, { once: true });
    rs.pipe(req);
  });
}

/** Open a job output (a server path from StudioJob.outputs) for streaming; the body is unread. */
export async function openOutput(urlPath: string, signal?: AbortSignal): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  if (!urlPath.startsWith('/')) throw new StudioError(`bad output url ${urlPath}`);
  let res: Response;
  try {
    const { base, headers } = server();
    res = await fetch(`${base}${urlPath}`, { headers, signal });
  } catch (err) {
    throw unreachable(err);
  }
  if (!res.ok || !res.body) {
    // an error page is not read: release the connection now
    await res.body?.cancel().catch(() => undefined);
    throw new StudioError(`download ${urlPath}: HTTP ${res.status}`, res.status);
  }
  return res as Response & { body: ReadableStream<Uint8Array> };
}

/** Download a job output (a server path from StudioJob.outputs) to a local file, via `<file>.part`. */
export async function download(urlPath: string, localFile: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await openOutput(urlPath, sig);
  const tmp = `${localFile}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp), { signal: sig });
    await fs.promises.rename(tmp, localFile);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
