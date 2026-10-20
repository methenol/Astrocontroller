/**
 * Astronomy sessions: the telescope's DWARF_RAW_… folders, on the SD card and in the library.
 *
 * Library layout: a mirror of the telescope's own Astronomy folder, which is what AstroPhoto
 * Studio reads (it finds CALI_FRAME beside the session folders by itself):
 *   <library>/DWARF_RAW_<TELE|WIDE>_<target>_EXP_…/
 *       *.fits                        raw subframes (failed_*.fits = subs the scope's stacker rejected)
 *       stacked.jpg, stacked-16_*.png/.fits, img_reference.png, shotsInfo.json, Thumbnail/ …
 *       session.json                  metadata written by us (target, exposure, gain, transfer time)
 *   <library>/CALI_FRAME/<dark|flat|bias>/<cam_0|cam_1>/*.fits     device calibration masters
 *   <library>/_photos/<YYYY-MM-DD>/…                               daytime photos/videos
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import { withLister, type FtpEntry } from '../dwarf/ftp.js';

const log = logger('library');

export interface DeviceSession {
  folder: string;
  path: string;
  camera: 'tele' | 'wide';
  target: string;
  exposureS?: number;
  gain?: number;
  startedAt?: string;
}

export type DeviceSessionEntry = DeviceSession & { fitsCount?: number; sizeMB?: number; transferred?: boolean };

const SESSION_FOLDER = /^DWARF_RAW_(TELE|WIDE)_(.+?)_EXP_([\d.]+)_GAIN_(\d+)_(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})/;

/** A single folder name: no separators, no "." or "..", nothing that could leave the library. */
export function isPlainName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/** DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268 */
export function parseSessionFolder(folder: string): DeviceSession | null {
  if (!isPlainName(folder)) return null;
  const m = folder.match(SESSION_FOLDER);
  if (!m) return null;
  return {
    folder,
    path: `/Astronomy/${folder}`,
    camera: m[1] === 'WIDE' ? 'wide' : 'tele',
    target: m[2],
    exposureS: Number(m[3]),
    gain: Number(m[4]),
    startedAt: `${m[5]}T${m[6]}:${m[7]}:${m[8]}`,
  };
}

const newestFirst = (a: DeviceSession, b: DeviceSession) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
const oldestFirst = (a: { startedAt?: string }, b: { startedAt?: string }) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
const isLight = (name: string) => name.toLowerCase().endsWith('.fits') && !name.startsWith('stacked');

export function sessionLocalDir(s: DeviceSession): string {
  return path.join(config.paths.library, s.folder);
}

/** The metadata file written once a session's transfer has finished: its presence is what "transferred" means. */
export const SESSION_META = 'session.json';

/**
 * Whether a session's transfer finished with every file copied. The folder alone proves nothing (a
 * transfer creates it before copying), and a partial transfer records its failures in the metadata.
 */
export function isTransferred(s: DeviceSession): boolean {
  let meta: unknown;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(sessionLocalDir(s), SESSION_META), 'utf8'));
  } catch {
    return false;
  }
  const failed = (meta as { failedFiles?: unknown } | null)?.failedFiles;
  return typeof meta === 'object' && meta !== null && (failed === undefined || failed === 0);
}

/** The sessions on the SD card, newest first; `withCounts` also lists each one's files. */
export async function listDeviceSessions(withCounts = true): Promise<{ sessions: DeviceSessionEntry[]; otherFolders: string[] }> {
  return withLister(async (list) => {
    const dirs = (await list('/Astronomy')).filter((e) => e.isDir);
    const sessions: DeviceSessionEntry[] = [];
    const otherFolders: string[] = [];
    for (const d of dirs) {
      const s = parseSessionFolder(d.name);
      if (!s) {
        otherFolders.push(d.name);
        continue;
      }
      const entry: DeviceSessionEntry = { ...s, transferred: isTransferred(s) };
      if (withCounts) {
        const files = await list(s.path).catch((err) => {
          log.debug(`could not list ${s.path}: ${errMsg(err)}`);
          return [] as FtpEntry[];
        });
        entry.fitsCount = files.filter((f) => f.name.toLowerCase().endsWith('.fits')).length;
        entry.sizeMB = Math.round(files.reduce((a, f) => a + f.size, 0) / 1e6);
      }
      sessions.push(entry);
    }
    sessions.sort(newestFirst);
    return { sessions, otherFolders };
  });
}

/** The library's session folders, read without failing on one unreadable entry. */
function librarySessions(): DeviceSession[] {
  const root = config.paths.library;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`could not read the library ${root}: ${errMsg(err)}`);
    return [];
  }
  return entries.filter((d) => d.isDirectory()).map((d) => parseSessionFolder(d.name)).filter((s): s is DeviceSession => !!s);
}

/** Library sessions of one target (the target name in the folder), optionally one camera, oldest first. */
export function librarySessionsFor(target: string, camera?: 'tele' | 'wide'): string[] {
  return librarySessions()
    .filter((s) => s.target === target && (!camera || s.camera === camera))
    .sort(oldestFirst)
    .map((s) => s.folder);
}

/** Every library capture as (target, start time), read from the folder names alone. */
export function captureLog(): Array<{ target: string; startedAt?: string }> {
  return librarySessions().map((s) => ({ target: s.target, startedAt: s.startedAt }));
}

export interface LibrarySession {
  name: string;
  camera: string;
  lights: number;
  rejected: number;
  startedAt?: string;
}

/** Summary of what's in the library: sessions (DWARF_RAW_… folders) grouped by target. */
export function listLibrary(): Array<{ target: string; sessions: LibrarySession[] }> {
  const byTarget = new Map<string, LibrarySession[]>();
  for (const s of librarySessions()) {
    let files: string[];
    try {
      files = fs.readdirSync(sessionLocalDir(s)).filter(isLight);
    } catch (err) {
      log.warn(`could not read ${s.folder}: ${errMsg(err)}`);
      continue;
    }
    const rejected = files.filter((f) => f.startsWith('failed_')).length;
    const list = byTarget.get(s.target) ?? [];
    list.push({ name: s.folder, camera: s.camera, lights: files.length - rejected, rejected, startedAt: s.startedAt });
    byTarget.set(s.target, list);
  }
  return [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([target, sessions]) => ({ target, sessions: sessions.sort(oldestFirst) }));
}
