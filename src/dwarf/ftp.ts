/**
 * Anonymous FTP on the telescope (port 21). Its root is the SD card's DWARF3
 * folder, so HTTP album paths like "/DWARF3/Astronomy/X/stacked.jpg" map to
 * FTP "/Astronomy/X/stacked.jpg".
 */
import fs from 'node:fs';
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

/**
 * Download files from one or more remote directories (non-recursive per dir,
 * pass subdirectories explicitly). Skips files already present with the same size.
 */
export async function downloadFiles(
  jobs: Array<{ remoteDir: string; localDir: string; filter?: (e: FtpEntry) => boolean }>,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ files: number; bytes: number; skipped: number }> {
  return withClient(async (c) => {
    const plan: Array<{ remote: string; local: string; size: number }> = [];
    for (const job of jobs) {
      const remoteDir = toFtpPath(job.remoteDir);
      const items = await c.list(remoteDir);
      for (const i of items) {
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
    for (const [idx, item] of plan.entries()) {
      if (signal?.aborted) throw new Error('transfer cancelled');
      fs.mkdirSync(path.dirname(item.local), { recursive: true });
      const existing = fs.existsSync(item.local) ? fs.statSync(item.local).size : -1;
      if (existing === item.size) {
        skipped++;
        bytesDone += item.size;
      } else {
        const base = bytesDone;
        c.trackProgress((info) => {
          onProgress({ file: item.remote, filesDone: idx, filesTotal: plan.length, bytesDone: base + info.bytes, bytesTotal });
        });
        const tmp = `${item.local}.part`;
        await c.downloadTo(tmp, item.remote);
        c.trackProgress();
        fs.renameSync(tmp, item.local);
        bytesDone = base + item.size;
        files++;
      }
      onProgress({ file: item.remote, filesDone: idx + 1, filesTotal: plan.length, bytesDone, bytesTotal });
    }
    return { files, bytes: bytesDone, skipped };
  });
}

export function downloadOne(devicePath: string, localFile: string): Promise<void> {
  return withClient(async (c) => {
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    await c.downloadTo(localFile, toFtpPath(devicePath));
  });
}
