/**
 * Astronomy sessions: the telescope's capture sessions, on the device and in the library.
 *
 * Library layout: a mirror of the Dwarf's own Astronomy folder, which is what AstroPhoto Studio
 * reads (it finds CALI_FRAME beside the session folders by itself). A Seestar night is laid out the
 * same way, under a SEESTAR_RAW_… name of the same shape (drivers/seestar/library.ts):
 *   <library>/<DWARF|SEESTAR>_RAW_<TELE|WIDE>_<target>_EXP_…/
 *       *.fits / *.fit                raw subframes (failed_*.fits = subs the Dwarf's stacker rejected)
 *       stacked.jpg, stacked-16_*.png/.fits, Stacked_*.fit, img_reference.png, shotsInfo.json, Thumbnail/ …
 *       session.json                  metadata written by us (target, exposure, gain, transfer time)
 *   <library>/CALI_FRAME/<dark|flat|bias>/<cam_0|cam_1>/*.fits     device calibration masters (the Seestar's: seestar_cam_0|1)
 *   <library>/_photos/<YYYY-MM-DD>/…                               daytime photos/videos
 *
 * Which sessions the telescope holds is the running driver's (device-library.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import { deviceLibrary, setDefaultDeviceLibrary } from './device-library.js';
import { dwarfLibrary } from '../drivers/dwarf/library.js';

setDefaultDeviceLibrary(() => dwarfLibrary);

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

const SESSION_FOLDER = /^(DWARF|SEESTAR)_RAW_(TELE|WIDE)_(.+?)_EXP_([\d.]+)_GAIN_(\d+)_(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})/;

/** A single folder name: no separators, no "." or "..", nothing that could leave the library. */
export function isPlainName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/** DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268, SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-53-45_IRCUT */
export function parseSessionFolder(folder: string): DeviceSession | null {
  if (!isPlainName(folder)) return null;
  const m = folder.match(SESSION_FOLDER);
  if (!m) return null;
  return {
    folder,
    // the Dwarf's folder on its card; a Seestar session is not a folder of its own (its library resolves it)
    path: m[1] === 'DWARF' ? `/Astronomy/${folder}` : folder,
    camera: m[2] === 'WIDE' ? 'wide' : 'tele',
    target: m[3],
    exposureS: Number(m[4]),
    gain: Number(m[5]),
    startedAt: `${m[6]}T${m[7]}:${m[8]}:${m[9]}`,
  };
}

const oldestFirst = (a: { startedAt?: string }, b: { startedAt?: string }) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
const isLight = (name: string) => /\.fits?$/i.test(name) && !/^stacked/i.test(name);

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
  return isTransferredFolder(s.folder);
}

export function isTransferredFolder(folder: string): boolean {
  let meta: unknown;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(config.paths.library, folder, SESSION_META), 'utf8'));
  } catch {
    return false;
  }
  const failed = (meta as { failedFiles?: unknown } | null)?.failedFiles;
  return typeof meta === 'object' && meta !== null && (failed === undefined || failed === 0);
}

/** The sessions on the SD card, newest first; `withCounts` also lists each one's files. */
export function listDeviceSessions(withCounts = true): Promise<{ sessions: DeviceSessionEntry[]; otherFolders: string[] }> {
  return deviceLibrary().listSessions(withCounts);
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

/**
 * Every library capture as (target, camera, start time, integration): the integration is the
 * sub length in the folder name times the subs the stacker kept (failed_* are not counted).
 */
export function captureLog(): Array<{ target: string; camera: 'tele' | 'wide'; startedAt?: string; integrationS: number }> {
  return librarySessions().map((s) => {
    let lights = 0;
    try {
      lights = fs.readdirSync(sessionLocalDir(s)).filter((f) => isLight(f) && !f.startsWith('failed_')).length;
    } catch (err) {
      log.debug(`could not read ${s.folder}: ${errMsg(err)}`);
    }
    return { target: s.target, camera: s.camera, startedAt: s.startedAt, integrationS: lights * (s.exposureS ?? 0) };
  });
}

export interface LibrarySession {
  name: string;
  camera: string;
  lights: number;
  rejected: number;
  startedAt?: string;
}

/** Summary of what's in the library: sessions (DWARF_RAW_… / SEESTAR_RAW_… folders) grouped by target. */
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
