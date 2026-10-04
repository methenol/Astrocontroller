/**
 * Anonymous FTP on the telescope (port 21). Its root is the SD card's DWARF3
 * folder, so HTTP album paths like "/DWARF3/Astronomy/X/stacked.jpg" map to
 * FTP "/Astronomy/X/stacked.jpg".
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client, FileType } from 'basic-ftp';
import { config } from '../config.js';

export interface FtpEntry {
  name: string;
  size: number;
  isDir: boolean;
  modifiedAt?: string;
}

export function toFtpPath(devicePath: string): string {
  let p = devicePath.replace(/\\/g, '/');
  if (p.startsWith('/DWARF3/')) p = p.slice('/DWARF3'.length);
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/+$/, '') || '/';
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client(30000);
  try {
    await client.access({ host: config.dwarf.host, user: 'anonymous', password: 'astrocontroller@', secure: false });
    return await fn(client);
  } finally {
    client.close();
  }
}

export function listDir(devicePath: string): Promise<FtpEntry[]> {
  return withClient(async (c) => {
    const items = await c.list(toFtpPath(devicePath));
    return items.map((i) => ({
      name: i.name,
      size: i.size,
      isDir: i.type === FileType.Directory,
      modifiedAt: i.rawModifiedAt,
    }));
  });
}

export interface DownloadProgress {
  file: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

/** Errors of the local (NAS) side that a short pause usually clears (a stale SMB handle, verified 2026-10-04). */
const TRANSIENT_FS = new Set(['EBADF', 'ESTALE', 'EIO', 'EAGAIN', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET']);
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const out = execFileSync('stat', ['-c', '%s', file], { encoding: 'utf8', timeout: 10000 }).trim();
    const n = Number(out);
    if (!Number.isFinite(n)) throw err;
    return n;
  }
}

async function openClient(): Promise<Client> {
  const client = new Client(30000);
  await client.access({ host: config.dwarf.host, user: 'anonymous', password: 'astrocontroller@', secure: false });
  return client;
}

/**
 * Download files from one or more remote directories (non-recursive per dir, pass
 * subdirectories explicitly). Skips files already present with the same size.
 *
 * One bad file never ends the transfer: each file gets 3 attempts (FTP errors reconnect,
 * e.g. the telescope's occasional unparsable EPSV reply; NAS errors such as a stale SMB handle
 * are waited out), and files that still fail are reported in `failed` while the rest continue.
 */
export async function downloadFiles(
  jobs: Array<{ remoteDir: string; localDir: string; filter?: (e: FtpEntry) => boolean; optional?: boolean }>,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ files: number; bytes: number; skipped: number; failed: Array<{ remote: string; error: string }> }> {
  let c = await openClient();
  const reconnect = async () => {
    c.close();
    await sleepMs(2000);
    c = await openClient();
  };
  try {
    const plan: Array<{ remote: string; local: string; size: number }> = [];
    for (const job of jobs) {
      const remoteDir = toFtpPath(job.remoteDir);
      let items;
      for (let attempt = 1; ; attempt++) {
        try {
          items = await c.list(remoteDir);
          break;
        } catch (err) {
          if (attempt >= 3) {
            if (job.optional) break;
            throw err;
          }
          await reconnect();
        }
      }
      for (const i of items ?? []) {
        if (i.type !== FileType.File) continue;
        const e: FtpEntry = { name: i.name, size: i.size, isDir: false };
        if (job.filter && !job.filter(e)) continue;
        plan.push({ remote: `${remoteDir}/${i.name}`, local: path.join(job.localDir, i.name), size: i.size });
      }
    }
    const bytesTotal = plan.reduce((a, b) => a + b.size, 0);
    let bytesDone = 0;
    let files = 0;
    let skipped = 0;
    const failed: Array<{ remote: string; error: string }> = [];
    for (const [idx, item] of plan.entries()) {
      if (signal?.aborted) throw new Error('transfer cancelled');
      const base = bytesDone;
      let lastErr = '';
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        if (signal?.aborted) throw new Error('transfer cancelled');
        try {
          fs.mkdirSync(path.dirname(item.local), { recursive: true });
          const existing = localSize(item.local);
          if (existing === item.size) {
            skipped++;
          } else {
            c.trackProgress((info) => {
              onProgress({ file: item.remote, filesDone: idx, filesTotal: plan.length, bytesDone: base + info.bytes, bytesTotal });
            });
            const tmp = `${item.local}.part`;
            await c.downloadTo(tmp, item.remote);
            c.trackProgress();
            fs.renameSync(tmp, item.local);
            files++;
          }
          ok = true;
        } catch (err) {
          c.trackProgress();
          const code = (err as NodeJS.ErrnoException).code ?? '';
          lastErr = `${code ? `${code}: ` : ''}${(err as Error).message}`;
          if (signal?.aborted) throw new Error('transfer cancelled');
          if (attempt < 3) {
            // the local side: wait out a stale NAS handle; the FTP side: a fresh connection
            if (TRANSIENT_FS.has(code) && !/ftp|EPSV|PASV|data socket/i.test(lastErr)) await sleepMs(3000 * attempt);
            else await reconnect().catch(() => {});
          }
        }
      }
      bytesDone = base + item.size;
      if (!ok) failed.push({ remote: item.remote, error: lastErr });
      onProgress({ file: item.remote, filesDone: idx + 1, filesTotal: plan.length, bytesDone, bytesTotal });
    }
    return { files, bytes: bytesDone, skipped, failed };
  } finally {
    c.close();
  }
}

export function downloadOne(devicePath: string, localFile: string): Promise<void> {
  return withClient(async (c) => {
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    await c.downloadTo(localFile, toFtpPath(devicePath));
  });
}
