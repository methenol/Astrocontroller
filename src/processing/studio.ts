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
import { config } from '../config.js';

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

export const studioEnabled = () => !!config.studio.url;

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 20000): Promise<T> {
  if (!config.studio.url) throw new StudioError('ASTROPHOTO_URL is not set: processing is off');
  let res: Response;
  try {
    res = await fetch(`${config.studio.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new StudioError(`AstroPhoto Studio unreachable at ${config.studio.url} (${cause ?? (err as Error).message})`);
  }
  const textBody = await res.text();
  let data: any = null;
  try {
    data = textBody ? JSON.parse(textBody) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new StudioError(`Studio ${method} ${path}: HTTP ${res.status} ${data?.detail ?? textBody.slice(0, 300)}`, res.status);
  return data as T;
}

export const health = () => call<{ ok: boolean; version: string; busy: boolean; queued: number }>('GET', '/api/v1/health', undefined, 5000);
export const info = () => call<StudioInfo>('GET', '/api/v1', undefined, 60000); // first call imports PyTorch
export const resolve = (body: { paths: string[]; source?: 'images' | 'uploads' }) => call<ResolveResult>('POST', '/api/v1/datasets/resolve', body);
export const submit = (body: Record<string, unknown>) => call<StudioJob & { dataset_info?: ResolveResult }>('POST', '/api/v1/jobs', body, 60000);
export const job = (id: string) => call<StudioJob>('GET', `/api/v1/jobs/${encodeURIComponent(id)}`);
export const jobs = (q: { state?: string; client_ref?: string; limit?: number } = {}) =>
  call<{ jobs: StudioJob[] }>('GET', `/api/v1/jobs?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`);
export const cancel = (id: string) => call<StudioJob>('POST', `/api/v1/jobs/${encodeURIComponent(id)}/cancel`);
export const queue = () => call<{ running: StudioJob[]; queued: StudioJob[]; drains_in: number | null; external: unknown[] }>('GET', '/api/v1/queue');
export const move = (id: string, position: number) => call<{ queue: string[] }>('POST', '/api/v1/queue/move', { id, position });
export const uploads = (prefix: string) => call<{ root: string; files: Array<{ path: string; bytes: number }> }>('GET', `/api/v1/uploads?prefix=${encodeURIComponent(prefix)}`);

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Stream one local file to <uploads>/<remotePath> on the server. */
export function uploadFile(localFile: string, remotePath: string, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const url = new URL(`${config.studio.url}/api/v1/uploads/${encPath(remotePath)}`);
  const size = fs.statSync(localFile).size;
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': size }, signal }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => (res.statusCode && res.statusCode < 300 ? resolve() : reject(new StudioError(`upload ${remotePath}: HTTP ${res.statusCode} ${body.slice(0, 200)}`, res.statusCode))));
    });
    req.setTimeout(120000, () => req.destroy(new StudioError(`upload ${remotePath}: timed out`)));
    req.on('error', reject);
    const rs = fs.createReadStream(localFile);
    rs.on('data', (c) => onBytes?.(c.length));
    rs.on('error', reject);
    rs.pipe(req);
  });
}

/** Download a job output (url from StudioJob.outputs) to a local file. */
export async function download(urlPath: string, localFile: string): Promise<void> {
  const res = await fetch(`${config.studio.url}${urlPath}`, { signal: AbortSignal.timeout(600000) });
  if (!res.ok || !res.body) throw new StudioError(`download ${urlPath}: HTTP ${res.status}`, res.status);
  const tmp = `${localFile}.part`;
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
  fs.renameSync(tmp, localFile);
}
