/**
 * The Seestar's image storage (/boot/Image on the scope: MyWorks/, darklibrary/, …).
 *
 *   listing   JSON-RPC, and stateful on the scope: get_img_file_page_number({dir}) selects the
 *             directory and returns its page count, get_img_file_page_name({page}) lists a page
 *             (20 entries, 0-based) of the selected one. Listings therefore run one at a time.
 *   files     the scope's HTTP server (SEESTAR_HTTP_PORT) serves the storage from its root, with
 *             byte ranges: exact sizes, FITS headers without the pixels, and resumed downloads.
 *             A directory has no listing over HTTP.
 *
 * Paths are relative to the storage root ("MyWorks/M 31_sub/Light_….fit").
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import type { Seestar } from './device.js';

const HTTP_TIMEOUT_MS = 30_000;
/** one file's body may take this long without a byte arriving */
const STALL_MS = 60_000;
export const FILE_ATTEMPTS = 3;
const RETRY_MS = 2000;
const HEADER_BYTES = 2880 * 3;

export interface SeestarEntry {
  name: string;
  isDir: boolean;
  /** bytes, from the listing's size_k (rounded): HTTP gives the exact size */
  size: number;
  /** the scope's local time, "2026-10-28 05:53:46" */
  date?: string;
  /** a directory's file count */
  fileCount?: number;
}

export class TransferCancelled extends Error {
  constructor() {
    super('transfer cancelled');
    this.name = 'TransferCancelled';
  }
}

export class SeestarFiles {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly scope: Seestar,
    private readonly host: () => string = () => config.seestar.host,
  ) {}

  /** One storage path as a URL: each segment encoded, nothing that leaves the root. */
  url(rel: string): string {
    const parts = rel.replace(/^\/+/, '').split('/');
    if (!parts.length || parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`bad Seestar path ${rel}`);
    return `http://${this.host()}:${config.seestar.httpPort}/${parts.map(encodeURIComponent).join('/')}`;
  }

  /** A directory's entries (every page). */
  list(dir: string): Promise<SeestarEntry[]> {
    const run = this.queue.then(async () => {
      const pages = await this.scope.call('get_img_file_page_number', { dir });
      const n = typeof pages.result === 'number' ? pages.result : 0;
      const out: SeestarEntry[] = [];
      for (let page = 0; page < n; page++) {
        const r = await this.scope.call('get_img_file_page_name', { page });
        for (const e of Array.isArray(r.result) ? (r.result as Array<Record<string, unknown>>) : []) {
          if (typeof e.name !== 'string') continue;
          out.push({
            name: e.name,
            isDir: e.is_dir === true,
            size: typeof e.size_k === 'number' ? e.size_k * 1024 : 0,
            date: typeof e.date === 'string' ? e.date : undefined,
            fileCount: typeof e.file_cnt === 'number' ? e.file_cnt : undefined,
          });
        }
      }
      return out;
    });
    // the next listing waits for this one, whatever its outcome
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The exact size of a file. */
  async size(rel: string, signal?: AbortSignal): Promise<number> {
    const res = await fetch(this.url(rel), { method: 'HEAD', signal: anySignal(signal, HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
    const n = Number(res.headers.get('content-length'));
    if (!Number.isFinite(n)) throw new Error(`no size for ${rel}`);
    return n;
  }

  /** The first bytes of a file (a FITS header), or the whole file up to maxBytes. */
  async read(rel: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(this.url(rel), { headers: { Range: `bytes=0-${maxBytes - 1}` }, signal: anySignal(signal, HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }

  /** A whole file, refused when it is larger than maxBytes. */
  async readAll(rel: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(this.url(rel), { signal: anySignal(signal, HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) {
      await res.body?.cancel();
      throw new Error(`${rel} is ${Math.round(len / 1e6)} MB, over the ${Math.round(maxBytes / 1e6)} MB this reads`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Delete one file (delete_image). The scope answers 0 for a path it does not have as well, so
   * the outcome is checked over HTTP: true once the file is gone.
   */
  async delete(rel: string): Promise<boolean> {
    this.url(rel); // refuses a path that leaves the storage
    await this.scope.call('delete_image', [rel]);
    const res = await fetch(this.url(rel), { method: 'HEAD', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }).catch(() => null);
    return res?.status === 404;
  }

  /** A FITS header's cards, as KEY → value (strings unquoted). */
  async fitsHeader(rel: string, signal?: AbortSignal): Promise<Record<string, string | number | boolean>> {
    return parseFitsHeader(await this.read(rel, HEADER_BYTES, signal));
  }

  /**
   * Copy one file into the library, resuming a partial copy (<local>.part) and renaming only a
   * whole one into place. 'skipped' when a copy of the same size is already there.
   */
  async download(rel: string, local: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<{ outcome: 'copied' | 'skipped'; size: number }> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= FILE_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new TransferCancelled();
      const tmp = `${local}.part`;
      try {
        fs.mkdirSync(path.dirname(local), { recursive: true });
        const size = await this.size(rel, signal);
        if (localSize(local) === size) return { outcome: 'skipped', size };
        let have = localSize(tmp) ?? 0;
        if (have > size) {
          fs.rmSync(tmp, { force: true });
          have = 0;
        }
        if (have < size) await this.fetchInto(rel, tmp, have, size, onBytes, signal);
        const got = localSize(tmp);
        if (got !== size) throw new Error(`incomplete download: ${got ?? 0} of ${size} bytes`);
        fs.renameSync(tmp, local);
        return { outcome: 'copied', size };
      } catch (err) {
        if (err instanceof TransferCancelled || signal?.aborted) throw new TransferCancelled();
        lastErr = err;
        // the partial file is kept: the next attempt resumes it
        if (attempt < FILE_ATTEMPTS) await sleep(RETRY_MS * attempt);
      }
    }
    throw new Error(errMsg(lastErr));
  }

  private async fetchInto(rel: string, tmp: string, from: number, size: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let stall = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(this.url(rel), { headers: from > 0 ? { Range: `bytes=${from}-${size - 1}` } : {}, signal: ctl.signal });
      // a server that ignores the range sends the whole file: start over
      const resumed = from > 0 && res.status === 206;
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${rel}`);
      const out = fs.createWriteStream(tmp, { flags: resumed ? 'a' : 'w' });
      let done = resumed ? from : 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(stall);
          stall = setTimeout(() => ctl.abort(), STALL_MS);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
          done += chunk.length;
          onBytes(done);
        }
      } finally {
        await new Promise<void>((r) => out.end(r));
      }
    } catch (err) {
      if (signal?.aborted) throw new TransferCancelled();
      throw err;
    } finally {
      clearTimeout(stall);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** FITS header cards (80-character records up to END) as KEY → value. */
export function parseFitsHeader(buf: Buffer): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (let i = 0; i + 80 <= buf.length; i += 80) {
    const card = buf.toString('latin1', i, i + 80);
    const key = card.slice(0, 8).trim();
    if (key === 'END') break;
    if (card[8] !== '=' || !key) continue;
    const raw = card.slice(10);
    const str = /^\s*'((?:[^']|'')*)'/.exec(raw);
    if (str) {
      out[key] = str[1].replace(/''/g, "'").trimEnd();
      continue;
    }
    const v = raw.split('/')[0].trim();
    if (v === 'T' || v === 'F') out[key] = v === 'T';
    else if (v !== '' && Number.isFinite(Number(v))) out[key] = Number(v);
    else if (v) out[key] = v;
  }
  return out;
}

function localSize(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

function anySignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
