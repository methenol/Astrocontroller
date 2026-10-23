/**
 * Anonymous FTP on the telescope (port 21). Its root is the SD card's DWARF3 folder, so HTTP album
 * paths like "/DWARF3/Astronomy/X/stacked.jpg" map to FTP "/Astronomy/X/stacked.jpg".
 *
 * One bad file never ends a transfer: each file gets 3 attempts (FTP errors reconnect, e.g. the
 * telescope's occasional unparsable EPSV reply; NAS errors such as a stale SMB handle are waited
 * out), and files that still fail are reported in `failed` while the rest continue. Files land as
 * `<name>.part` and are renamed when complete, so a half-copied file is never taken for a whole one.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client, FileType } from 'basic-ftp';
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import { assertLinked } from './gate.js';

export interface FtpEntry {
  name: string;
  size: number;
  isDir: boolean;
  modifiedAt?: string;
}

export interface DownloadProgress {
  file: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface DownloadResult {
  files: number;
  bytes: number;
  skipped: number;
  failed: Array<{ remote: string; error: string }>;
}

const FTP_TIMEOUT_MS = 30000;
export const FILE_ATTEMPTS = 3;
const RECONNECT_PAUSE_MS = 2000;
/** a stale NAS handle is waited out for this long × the attempt number */
const NAS_RETRY_MS = 3000;
/** the system stat fallback */
const STAT_TIMEOUT_MS = 10_000;
/** Progress is reported at most this often (each report goes out to every open web UI). */
const PROGRESS_EVERY_MS = 500;
/** Errors of the local (NAS) side that a short pause usually clears (a stale SMB handle, verified 2026-10-04). */
const TRANSIENT_FS = new Set(['EBADF', 'ESTALE', 'EIO', 'EAGAIN', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET']);
const FTP_ERROR = /ftp|EPSV|PASV|data socket/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TransferCancelled extends Error {
  constructor() {
    super('transfer cancelled');
  }
}

/** An SD-card path as FTP sees it (the DWARF3 folder is the root); ".." is refused. */
export function toFtpPath(devicePath: string): string {
  let p = devicePath.replace(/\\/g, '/');
  if (p.startsWith('/DWARF3/')) p = p.slice('/DWARF3'.length);
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.split('/').includes('..')) throw new Error(`bad device path ${devicePath}`);
  return p.replace(/\/+$/, '') || '/';
}

async function openClient(): Promise<Client> {
  assertLinked();
  const client = new Client(FTP_TIMEOUT_MS);
  try {
    await client.access({ host: config.dwarf.host, port: config.dwarf.ftpPort, user: 'anonymous', password: 'astrocontroller@', secure: false });
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await openClient();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function listWith(c: Client, devicePath: string): Promise<FtpEntry[]> {
  const items = await c.list(toFtpPath(devicePath));
  return items.map((i) => ({ name: i.name, size: i.size, isDir: i.type === FileType.Directory, modifiedAt: i.rawModifiedAt }));
}

export function listDir(devicePath: string): Promise<FtpEntry[]> {
  return withClient((c) => listWith(c, devicePath));
}

/** Several listings over one FTP connection (the telescope serves few at a time); listings run one after another. */
export function withLister<T>(fn: (list: (devicePath: string) => Promise<FtpEntry[]>) => Promise<T>): Promise<T> {
  return withClient((c) => fn((p) => listWith(c, p)));
}

/**
 * Size of a local file, or -1 if it is absent. Docker Desktop's file sharing of a macOS SMB mount
 * refuses Node's stat (EBADF) on some NAS files (the DWARF's factory masters dated 2037, verified
 * 2026-10-04) while the system stat reads them fine: fall back to it before calling the file unreadable.
 */
function localSize(file: string): number {
  if (!fs.existsSync(file)) return -1;
  try {
    return fs.statSync(file).size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (!['EBADF', 'ENOENT', 'ESTALE', 'EIO'].includes(code)) throw err;
    const out = execFileSync('stat', ['-c', '%s', file], { encoding: 'utf8', timeout: STAT_TIMEOUT_MS }).trim();
    // empty output would read as size 0: only a plain number counts
    if (!/^\d+$/.test(out)) throw err;
    return Number(out);
  }
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort: a leftover .part is overwritten next time */
  }
}

/** A throttled progress reporter: the last report of a file always goes out. */
function throttle(onProgress: (p: DownloadProgress) => void): (p: DownloadProgress, force?: boolean) => void {
  let last = 0;
  return (p, force = false) => {
    const now = Date.now();
    if (!force && now - last < PROGRESS_EVERY_MS) return;
    last = now;
    onProgress(p);
  };
}

/** One FTP session that reconnects on demand. */
class Session {
  private client: Client | null = null;

  async get(): Promise<Client> {
    this.client ??= await openClient();
    return this.client;
  }

  async reconnect(): Promise<void> {
    this.close();
    await sleep(RECONNECT_PAUSE_MS);
    this.client = await openClient();
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }
}

/**
 * Copy one file with retries. Returns 'skipped' when an identical-size copy is already there.
 * `size` (when known) is what the local copy is compared against.
 */
async function copyFile(
  s: Session,
  remote: string,
  local: string,
  size: number | undefined,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
): Promise<'copied' | 'skipped'> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= FILE_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new TransferCancelled();
    const tmp = `${local}.part`;
    try {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      if (size !== undefined && localSize(local) === size) return 'skipped';
      const c = await s.get();
      // a cancel ends the file in flight at once, not after it has finished
      const onAbort = () => s.close();
      signal?.addEventListener('abort', onAbort, { once: true });
      c.trackProgress((info) => onBytes(info.bytes));
      try {
        // a cancel that came while connecting has already fired: it is not waited on, it ends the file now
        if (signal?.aborted) throw new TransferCancelled();
        await c.downloadTo(tmp, remote);
      } finally {
        c.trackProgress();
        signal?.removeEventListener('abort', onAbort);
      }
      if (signal?.aborted) throw new TransferCancelled();
      // a data connection cut short can still end "successfully": only a whole file is renamed into place
      const got = localSize(tmp);
      if (size !== undefined && got !== size) throw new Error(`incomplete download: ${got} of ${size} bytes`);
      fs.renameSync(tmp, local);
      return 'copied';
    } catch (err) {
      removeQuietly(tmp);
      if (err instanceof TransferCancelled || signal?.aborted) throw new TransferCancelled();
      lastErr = err;
      if (attempt === FILE_ATTEMPTS) break;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      // the local side: wait out a stale NAS handle; the FTP side: a fresh connection
      if (TRANSIENT_FS.has(code) && !FTP_ERROR.test(errMsg(err))) await sleep(NAS_RETRY_MS * attempt);
      else await s.reconnect().catch(() => undefined);
    }
  }
  const code = (lastErr as NodeJS.ErrnoException | undefined)?.code;
  throw new Error(`${code ? `${code}: ` : ''}${errMsg(lastErr)}`);
}

/**
 * Download files from one or more remote directories (non-recursive per dir, pass
 * subdirectories explicitly). Skips files already present with the same size.
 */
export async function downloadFiles(
  jobs: Array<{ remoteDir: string; localDir: string; filter?: (e: FtpEntry) => boolean; optional?: boolean }>,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const s = new Session();
  const report = throttle(onProgress);
  try {
    const plan: Array<{ remote: string; local: string; size: number }> = [];
    for (const job of jobs) {
      const remoteDir = toFtpPath(job.remoteDir);
      let items: Awaited<ReturnType<Client['list']>> | undefined;
      for (let attempt = 1; !items; attempt++) {
        if (signal?.aborted) throw new TransferCancelled();
        try {
          items = await (await s.get()).list(remoteDir);
        } catch (err) {
          if (attempt >= FILE_ATTEMPTS) {
            if (job.optional) break;
            throw err;
          }
          await s.reconnect().catch(() => undefined);
        }
      }
      for (const i of items ?? []) {
        if (i.type !== FileType.File) continue;
        if (job.filter && !job.filter({ name: i.name, size: i.size, isDir: false })) continue;
        plan.push({ remote: `${remoteDir === '/' ? '' : remoteDir}/${i.name}`, local: path.join(job.localDir, path.basename(i.name)), size: i.size });
      }
    }
    const bytesTotal = plan.reduce((a, b) => a + b.size, 0);
    const out: DownloadResult = { files: 0, bytes: 0, skipped: 0, failed: [] };
    let bytesDone = 0;
    for (const [idx, item] of plan.entries()) {
      const base = bytesDone;
      try {
        const r = await copyFile(s, item.remote, item.local, item.size, (n) => report({ file: item.remote, filesDone: idx, filesTotal: plan.length, bytesDone: base + n, bytesTotal }), signal);
        if (r === 'skipped') out.skipped++;
        else out.files++;
        // bytes in the library from this plan: a file that failed is not counted
        out.bytes += item.size;
      } catch (err) {
        if (err instanceof TransferCancelled) throw err;
        out.failed.push({ remote: item.remote, error: errMsg(err) });
      }
      bytesDone = base + item.size;
      report({ file: item.remote, filesDone: idx + 1, filesTotal: plan.length, bytesDone, bytesTotal }, true);
    }
    return out;
  } finally {
    s.close();
  }
}

/** Copy one file (album photo, video, stack) with the same retries and atomic rename as a session. */
export async function downloadOne(devicePath: string, localFile: string, signal?: AbortSignal): Promise<void> {
  const s = new Session();
  try {
    await copyFile(s, toFtpPath(devicePath), localFile, undefined, () => undefined, signal);
  } finally {
    s.close();
  }
}
