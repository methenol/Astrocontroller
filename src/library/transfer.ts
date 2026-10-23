/** Background transfers from the telescope SD card into the imagery library (layout: sessions.ts). */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { errMsg } from '../log.js';
import { downloadFiles, downloadOne, type FtpEntry } from '../drivers/dwarf/ftp.js';
import { deleteMedia } from '../drivers/dwarf/http.js';
import { enqueueProcessing } from '../processing/queue.js';
import { startJob, type FailedFile, type Job } from './jobs.js';
import { isTransferred, listDeviceSessions, parseSessionFolder, sessionLocalDir, librarySessionsFor, SESSION_META, type DeviceSession } from './sessions.js';
import { writeFileAtomic } from '../util/fs.js';

export { jobBus, listJobs, getJob, cancelJob, cancelActiveJobs, type Job } from './jobs.js';
export { parseSessionFolder, listDeviceSessions, sessionLocalDir, librarySessionsFor, listLibrary, isTransferred, type DeviceSession } from './sessions.js';

const CALIBRATION_KINDS = ['dark', 'flat', 'bias'] as const;

const isFits = (name: string) => name.toLowerCase().endsWith('.fits');
/** stacked-16_*.fits is the scope's own stack; failed_*.fits (kept) are subs its stacker rejected. */
const isSub = (e: FtpEntry) => isFits(e.name) && !e.name.startsWith('stacked');

/** A session named by folder (or a path ending in one), or the newest on the card for "latest". */
async function resolveSession(folderOrLatest: string): Promise<DeviceSession> {
  if (folderOrLatest === 'latest') {
    const { sessions } = await listDeviceSessions(false);
    if (!sessions[0]) throw new Error('no astronomy sessions on the telescope');
    return sessions[0];
  }
  const folder = folderOrLatest.replace(/\/+$/, '').replace(/^.*\/(?=DWARF_RAW_)/, '');
  const s = parseSessionFolder(folder);
  if (!s) throw new Error(`not a DWARF session folder: ${folderOrLatest}`);
  return s;
}

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
  return failed.filter((f) => f.remote.startsWith(`${s.path}/`) && isSub({ name: path.posix.basename(f.remote), size: 0, isDir: false }));
}

/**
 * Processing in AstroPhoto Studio, queued once every light frame is here (it waits in the local
 * outbox while the server is unreachable); a calibration master that failed to copy does not block it.
 */
function queueProcessing(s: DeviceSession, failed: FailedFile[], opts: TransferOptions): unknown {
  if (!opts.includeSubframes || !(opts.process ?? config.studio.autoProcess) || !config.studio.url) return undefined;
  const lightsMissing = missingLights(s, failed);
  if (lightsMissing.length) return `not queued: ${lightsMissing.length} light frame(s) are still missing; run the transfer again`;
  // pool: this night together with every earlier session of the target in the library
  const pooled = (opts.pool ?? config.studio.poolSessions) ? librarySessionsFor(s.target, s.camera) : [];
  const sessions = pooled.includes(s.folder) ? pooled : [...pooled, s.folder];
  // the files are here whatever happens next: a refusal to queue is reported, it does not fail the transfer
  try {
    return enqueueProcessing({ sessions, target: s.target, profile: opts.profile, origin: opts.origin === 'ui' ? 'ui-transfer' : 'transfer' });
  } catch (err) {
    return `not queued: ${errMsg(err)}`;
  }
}

/** Copy one session (and optionally the camera's calibration masters) into the library. */
export async function transferSession(folderOrLatest: string, opts: TransferOptions): Promise<Job> {
  const s = await resolveSession(folderOrLatest);
  const dest = sessionLocalDir(s);
  return startJob(
    'transfer_session',
    `transfer ${s.target} (${s.folder})`,
    async (job) => {
      fs.mkdirSync(dest, { recursive: true });
      const plan: Array<{ remoteDir: string; localDir: string; filter?: (e: FtpEntry) => boolean; optional?: boolean }> = [
        { remoteDir: s.path, localDir: dest, filter: (e) => opts.includeSubframes || !isSub(e) },
      ];
      if (opts.includeCalibration) {
        const cam = s.camera === 'wide' ? 'cam_1' : 'cam_0';
        for (const kind of CALIBRATION_KINDS) {
          // a camera without masters of one kind is normal
          plan.push({ remoteDir: `/Astronomy/CALI_FRAME/${kind}/${cam}`, localDir: path.join(config.paths.library, 'CALI_FRAME', kind, cam), optional: true });
        }
      }
      const res = await downloadFiles(plan, (p) => job.progress(p), job.signal);
      writeFileAtomic(
        path.join(dest, SESSION_META),
        JSON.stringify(
          {
            ...s,
            shotsInfo: readJson(path.join(dest, 'shotsInfo.json')),
            transferredAt: new Date().toISOString(),
            // files that could not be copied: a session with any is not complete in the library
            failedFiles: res.failed.length,
            calibrationDir: opts.includeCalibration ? path.join(config.paths.library, 'CALI_FRAME') : null,
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
 * Delete sessions from the telescope's SD card through the album API — the device's own way, which
 * wipes the whole session package (frames, stack, thumbnail) together with its album entry.
 * A session that is not complete in the library is refused unless `force`: deleting it would lose
 * data that was never copied. One bad session does not stop the others.
 */
export async function deleteDeviceSessions(folders: string[], opts: { force?: boolean } = {}): Promise<SessionDeleteOutcome[]> {
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
      const [r] = await deleteMedia([{ filePath: `/DWARF3${s.path}`, mediaType: 4 }]);
      out.push({ folder: s.folder, deleted: r.deleted, ...(r.note ? { note: r.note } : {}) });
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
 * Where an album file lands: Astronomy/… mirrors the card, anything else goes to _photos/<today>.
 * Throws for a path that would leave the library.
 */
export function albumLocalPath(devicePath: string, day = localDay()): string {
  const rel = devicePath.replace(/\\/g, '/').replace(/^\/?DWARF3\//, '').replace(/^\/+/, '');
  const parts = rel.split('/');
  if (!rel || parts.some((p) => p === '..' || p === '.' || p === '')) throw new Error(`bad device path ${devicePath}`);
  const root = path.resolve(config.paths.library);
  const local = parts[0] === 'Astronomy' ? path.resolve(root, ...parts) : path.resolve(root, '_photos', day, parts[parts.length - 1]);
  const inside = path.relative(root, local);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`bad device path ${devicePath}`);
  return local;
}

/** Copy individual album files (photos/videos/stacked images) into the library; one bad file does not stop the rest. */
export function transferFiles(devicePaths: string[], origin?: Job['origin']): Job {
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
          await downloadOne(f.remote, f.local, job.signal);
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
