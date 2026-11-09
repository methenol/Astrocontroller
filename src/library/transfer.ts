/** Background transfers from the telescope's storage into the imagery library (layout: sessions.ts; the device side: device-library.ts). */
import { estop } from '../safety/estop.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { errMsg } from '../log.js';
import { enqueueMosaic, enqueueProcessing } from '../processing/queue.js';
import { roiForTarget } from '../processing/roi.js';
import { mosaicProgress, panelOf } from '../night/mosaics.js';
import { collected } from '../night/progress.js';
import { deviceLibrary } from './device-library.js';
import { startJob, type FailedFile, type Job } from './jobs.js';
import { isTransferred, sessionLocalDir, librarySessionsLike, filterFromNames, sessionDevice, SESSION_META, type DeviceSession } from './sessions.js';
import { writeFileAtomic } from '../util/fs.js';

export { jobBus, listJobs, getJob, cancelJob, cancelActiveJobs, type Job } from './jobs.js';
export { parseSessionFolder, listDeviceSessions, sessionLocalDir, librarySessionsFor, listLibrary, isTransferred, type DeviceSession } from './sessions.js';

/** A session named by folder (or a path ending in one), or the newest on the telescope for "latest". */
const resolveSession = (folderOrLatest: string): Promise<DeviceSession> => deviceLibrary().resolveSession(folderOrLatest);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export interface TransferOptions {
  includeCalibration: boolean;
  includeSubframes: boolean;
  process?: boolean;
  profile?: string;
  pool?: boolean;
  origin?: Job['origin'];
}

/** The session's light frames among the files that failed (not its stacked-16 FITS, nor calibration masters). */
export function missingLights(s: DeviceSession, failed: FailedFile[]): FailedFile[] {
  const lib = deviceLibrary();
  return failed.filter((f) => lib.isSessionLight(s, f.remote));
}

/**
 * Processing in AstroPhoto Studio, queued once every light frame is here (it waits in the local
 * outbox while the server is unreachable); a calibration master that failed to copy does not block it.
 */
function queueProcessing(s: DeviceSession, failed: FailedFile[], opts: TransferOptions): unknown {
  if (!opts.includeSubframes || !(opts.process ?? config.studio.autoProcess) || !config.studio.url) return undefined;
  const lightsMissing = missingLights(s, failed);
  if (lightsMissing.length) return `not queued: ${lightsMissing.length} light frame(s) are still missing; run the transfer again`;
  // a mosaic's panel is not an image of its own: the project is processed as one, once every panel has its integration
  const mosaic = panelOf(s.target);
  if (mosaic) {
    if (!mosaicProgress(mosaic.project, collected(null, { filterOf: () => mosaic.project.filter })).integrated) return `not queued: ${s.target} is a panel of mosaic ${mosaic.project.id}, which still has panels to finish`;
    try {
      return enqueueMosaic(mosaic.project, opts.profile, opts.origin === 'ui' ? 'ui-transfer' : 'transfer');
    } catch (err) {
      return `not queued: ${errMsg(err)}`;
    }
  }
  // pool: this night together with every earlier library session of the target that stacks with it
  // (the same camera, the same maker's scope, the same filter: a Duo-Band night and an Astro night are two images)
  const pooled = (opts.pool ?? config.studio.poolSessions) ? librarySessionsLike(s.folder) : [];
  const sessions = pooled.includes(s.folder) ? pooled : [...pooled, s.folder];
  // the files are here whatever happens next: a refusal to queue is reported, it does not fail the transfer
  try {
    return enqueueProcessing({ sessions, target: s.target, profile: opts.profile, origin: opts.origin === 'ui' ? 'ui-transfer' : 'transfer', roiCropPercent: roiForTarget(s.target) });
  } catch (err) {
    return `not queued: ${errMsg(err)}`;
  }
}

/** Copy one session (and optionally the camera's calibration masters) into the library. */
export async function transferSession(folderOrLatest: string, opts: TransferOptions): Promise<Job> {
  estop.assertClear();
  const s = await resolveSession(folderOrLatest);
  const dest = sessionLocalDir(s);
  return startJob(
    'transfer_session',
    `transfer ${s.target} (${s.folder})`,
    async (job) => {
      fs.mkdirSync(dest, { recursive: true });
      const { calibrationDir, ...res } = await deviceLibrary().copySession(s, opts, (p) => job.progress(p), job.signal);
      // what the session was shot through and with, for pooling and the plan's per-filter progress
      const filter = filterFromNames(s.folder) ?? (readJson(path.join(dest, SESSION_META)) as { filter?: string } | null)?.filter;
      writeFileAtomic(
        path.join(dest, SESSION_META),
        JSON.stringify(
          {
            ...s,
            device: sessionDevice(s.folder),
            filter,
            shotsInfo: readJson(path.join(dest, 'shotsInfo.json')),
            transferredAt: new Date().toISOString(),
            // files that could not be copied: a session with any is not complete in the library
            failedFiles: res.failed.length,
            calibrationDir,
          },
          null,
          2,
        ),
      );
      return { destination: dest, ...res, processing: queueProcessing(s, res.failed, opts) };
    },
    opts.origin,
    // the same session with the same options is one job, however often it is asked for
    `transfer_session:${s.folder}:${opts.includeSubframes}:${opts.includeCalibration}:${opts.process ?? ''}`,
  );
}

export interface SessionDeleteOutcome {
  folder: string;
  deleted: boolean;
  /** why it was not deleted */
  note?: string;
}

/**
 * Delete sessions from the telescope through the device's own delete, which wipes the whole
 * session package (frames, stack, thumbnail) together with its album entry.
 * A session that is not complete in the library is refused unless `force`: deleting it would lose
 * data that was never copied. One bad session does not stop the others.
 */
export async function deleteDeviceSessions(folders: string[], opts: { force?: boolean } = {}): Promise<SessionDeleteOutcome[]> {
  estop.assertClear();
  const out: SessionDeleteOutcome[] = [];
  for (const f of folders) {
    let s: DeviceSession;
    try {
      s = await resolveSession(f);
    } catch (err) {
      out.push({ folder: f, deleted: false, note: errMsg(err) });
      continue;
    }
    if (!opts.force && !isTransferred(s)) {
      out.push({ folder: s.folder, deleted: false, note: 'not fully in the library: transfer it first, or force to delete it anyway' });
      continue;
    }
    try {
      const r = await deviceLibrary().deleteSession(s);
      out.push({ folder: s.folder, ...r });
    } catch (err) {
      out.push({ folder: s.folder, deleted: false, note: errMsg(err) });
    }
  }
  return out;
}

/** Today's date (YYYY-MM-DD) where the observer is: an evening's photos belong to that evening, not to the next UTC day. */
function localDay(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.observer.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** "a.jpg", "a.jpg" → "a.jpg", "a-2.jpg": files of the same name in one request must not overwrite each other. */
export function distinctPaths(locals: string[]): string[] {
  const seen = new Set<string>();
  return locals.map((l) => {
    let out = l;
    const ext = path.extname(l);
    for (let n = 2; seen.has(out); n++) out = `${l.slice(0, l.length - ext.length)}-${n}${ext}`;
    seen.add(out);
    return out;
  });
}

/**
 * Where an album file lands: the driver mirrors its sessions and puts anything else under _photos/<today>.
 * Throws for a path that would leave the library.
 */
export function albumLocalPath(devicePath: string, day = localDay()): string {
  return deviceLibrary().albumLocalPath(devicePath, day);
}

/** Copy individual album files (photos/videos/stacked images) into the library; one bad file does not stop the rest. */
export function transferFiles(devicePaths: string[], origin?: Job['origin']): Job {
  estop.assertClear();
  if (!devicePaths.length) throw new Error('no files to transfer');
  // refuse bad paths before queueing anything
  const remotes = [...new Set(devicePaths)];
  const locals = distinctPaths(remotes.map((p) => albumLocalPath(p)));
  const plan = remotes.map((remote, i) => ({ remote, local: locals[i] }));
  return startJob(
    'transfer_files',
    `transfer ${plan.length} file(s)`,
    async (job) => {
      const files: string[] = [];
      const failed: FailedFile[] = [];
      for (const [i, f] of plan.entries()) {
        if (job.signal.aborted) break;
        try {
          await deviceLibrary().downloadOne(f.remote, f.local, job.signal);
          files.push(f.local);
        } catch (err) {
          if (job.signal.aborted) break;
          failed.push({ remote: f.remote, error: errMsg(err) });
        }
        job.progress({ filesDone: i + 1, filesTotal: plan.length, bytesDone: 0, bytesTotal: 0, file: f.remote });
      }
      return { files, failed };
    },
    origin,
  );
}
