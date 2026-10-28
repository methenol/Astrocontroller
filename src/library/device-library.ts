/**
 * The telescope's own storage as the library sees it, whatever the driver: its capture sessions,
 * its album, and copying files off it. The running driver registers its implementation at start
 * (the Dwarf's is FTP + its album HTTP API, the Seestar's its file-listing RPC + HTTP file server);
 * sessions.ts and transfer.ts only go through this.
 */
import type { DownloadProgress, DownloadResult, FtpEntry } from '../drivers/dwarf/ftp.js';
import type { DeleteOutcome, MediaItem } from '../drivers/dwarf/http/album.js';
import type { DeviceSession, DeviceSessionEntry } from './sessions.js';

export type { DownloadProgress, DownloadResult, FtpEntry, DeleteOutcome, MediaItem };

export interface SessionCopyOptions {
  includeSubframes: boolean;
  includeCalibration: boolean;
}

export interface DeviceLibrary {
  /** "DWARFLAB Dwarf 3", "ZWO Seestar": for messages */
  readonly label: string;
  /** The capture sessions on the telescope, newest first. */
  listSessions(withCounts: boolean): Promise<{ sessions: DeviceSessionEntry[]; otherFolders: string[] }>;
  /** A session by its folder name (or a path ending in one), or the newest for "latest". */
  resolveSession(folderOrLatest: string): Promise<DeviceSession>;
  /** Copy one session (and optionally the camera's calibration masters) into its library folder. */
  copySession(s: DeviceSession, o: SessionCopyOptions, onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<DownloadResult & { calibrationDir: string | null }>;
  /** Whether a remote path the copy reported is one of the session's light frames. */
  isSessionLight(s: DeviceSession, remote: string): boolean;
  /** Delete a whole session from the telescope (frames, stack, album entry). */
  deleteSession(s: DeviceSession): Promise<{ deleted: boolean; note?: string }>;
  /** Copy one album file. */
  downloadOne(devicePath: string, localFile: string, signal?: AbortSignal): Promise<void>;
  /** Where an album file lands in the library (throws for a path that would leave it). */
  albumLocalPath(devicePath: string, day: string): string;
  album: {
    counts(): Promise<Array<{ mediaType: number; count: number }>>;
    list(mediaType: number, page: number, pageSize: number): Promise<MediaItem[]>;
    /** a path the album lists, safe to fetch */
    isDevicePath(p: string): boolean;
    fetch(devicePath: string, maxBytes: number): Promise<Buffer>;
    delete(items: Array<{ filePath: string; mediaType?: number }>): Promise<DeleteOutcome[]>;
  };
}

let current: DeviceLibrary | null = null;
let fallback: (() => DeviceLibrary) | null = null;

/** The running driver's storage (set at driver start). */
export function setDeviceLibrary(lib: DeviceLibrary): void {
  current = lib;
}

/** The storage used before a driver registers one (the Dwarf's: the default driver, and the tests). */
export function setDefaultDeviceLibrary(make: () => DeviceLibrary): void {
  fallback = make;
}

export function deviceLibrary(): DeviceLibrary {
  if (!current) {
    if (!fallback) throw new Error('no telescope storage is registered');
    current = fallback();
  }
  return current;
}
