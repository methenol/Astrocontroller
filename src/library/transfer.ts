/**
 * Background transfers from the telescope SD card into the imagery library.
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
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import { listDir, downloadFiles, downloadOne, type FtpEntry } from '../dwarf/ftp.js';
import { enqueueProcessing } from '../processing/queue.js';

const log = logger('library');

export interface Job {
  id: string;
  kind: string;
  description: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress?: { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number; file?: string };
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export const jobBus = new EventEmitter();
const jobs = new Map<string, Job & { abort: AbortController }>();
let queue: Promise<void> = Promise.resolve();

export function listJobs(): Job[] {
  return [...jobs.values()].map(({ abort: _a, ...j }) => j).sort((a, b) => b.startedAt - a.startedAt).slice(0, 30);
}

export function getJob(id: string): Job | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  const { abort: _a, ...rest } = j;
  return rest;
}

export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || (j.status !== 'running' && j.status !== 'queued')) return false;
  j.abort.abort();
  j.status = 'cancelled';
  jobBus.emit('job', getJob(id));
  return true;
}

function startJob(kind: string, description: string, run: (job: Job, signal: AbortSignal) => Promise<unknown>): Job {
  const id = `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const job: Job & { abort: AbortController } = { id, kind, description, status: 'queued', startedAt: Date.now(), abort: new AbortController() };
  jobs.set(id, job);
  jobBus.emit('job', getJob(id));
  // FTP on the telescope is single-threaded in practice: run jobs one at a time.
  queue = queue.then(async () => {
    if (job.abort.signal.aborted) return;
    job.status = 'running';
    jobBus.emit('job', getJob(id));
    try {
      job.result = await run(job, job.abort.signal);
      job.status = 'done';
      log.info(`${description}: done`);
    } catch (err) {
      job.status = job.abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = errMsg(err);
      log.warn(`${description}: ${job.error}`);
    }
    job.finishedAt = Date.now();
    jobBus.emit('job', getJob(id));
  });
  return getJob(id)!;
}

// ---------------------------------------------------------------------------
// Device sessions
// ---------------------------------------------------------------------------

export interface DeviceSession {
  folder: string;
  path: string;
  camera: 'tele' | 'wide';
  target: string;
  exposureS?: number;
  gain?: number;
  startedAt?: string;
}

/** DWARF_RAW_TELE_NGC 281_EXP_15_GAIN_60_2026-10-01-22-20-58-268 */
export function parseSessionFolder(folder: string): DeviceSession | null {
  const m = folder.match(/^DWARF_RAW_(TELE|WIDE)_(.+?)_EXP_([\d.]+)_GAIN_(\d+)_(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})/);
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

export async function listDeviceSessions(withCounts = true) {
  const dirs = (await listDir('/Astronomy')).filter((e) => e.isDir);
  const sessions: Array<DeviceSession & { fitsCount?: number; sizeMB?: number; transferred?: boolean }> = [];
  for (const d of dirs) {
    const s = parseSessionFolder(d.name);
    if (!s) continue;
    const entry: (typeof sessions)[number] = { ...s, transferred: fs.existsSync(sessionLocalDir(s)) };
    if (withCounts) {
      const files = await listDir(s.path).catch(() => [] as FtpEntry[]);
      const fits = files.filter((f) => f.name.toLowerCase().endsWith('.fits'));
      entry.fitsCount = fits.length;
      entry.sizeMB = Math.round(files.reduce((a, f) => a + f.size, 0) / 1e6);
    }
    sessions.push(entry);
  }
  sessions.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const other = dirs.filter((d) => !parseSessionFolder(d.name)).map((d) => d.name);
  return { sessions, otherFolders: other };
}

export function sessionLocalDir(s: DeviceSession): string {
  return path.join(config.paths.library, s.folder);
}

/** Library sessions of one target (the target name in the folder), optionally one camera. */
export function librarySessionsFor(target: string, camera?: 'tele' | 'wide'): string[] {
  const root = config.paths.library;
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((d) => parseSessionFolder(d))
    .filter((s): s is DeviceSession => !!s && s.target === target && (!camera || s.camera === camera) && fs.statSync(path.join(root, s.folder)).isDirectory())
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    .map((s) => s.folder);
}

export function transferSession(folderOrLatest: string, opts: { includeCalibration: boolean; includeSubframes: boolean; process?: boolean; profile?: string; pool?: boolean }): Promise<Job> {
  return (async () => {
    let session: DeviceSession | null;
    if (folderOrLatest === 'latest') {
      const { sessions } = await listDeviceSessions(false);
      session = sessions[0] ?? null;
      if (!session) throw new Error('no astronomy sessions on the telescope');
    } else {
      const folder = folderOrLatest.replace(/^.*\/(?=DWARF_RAW_)/, '').replace(/\/$/, '');
      session = parseSessionFolder(folder);
      if (!session) throw new Error(`not a DWARF session folder: ${folderOrLatest}`);
    }
    const s = session;
    const dest = sessionLocalDir(s);
    return startJob('transfer_session', `transfer ${s.target} (${s.folder})`, async (job, signal) => {
      fs.mkdirSync(dest, { recursive: true });
      const fits = (e: FtpEntry) => e.name.toLowerCase().endsWith('.fits');
      // stacked-16_*.fits is the scope's own stack, failed_*.fits the subs its stacker rejected
      // (kept: AstroPhoto Studio grades them and can use their clean parts).
      const isSub = (e: FtpEntry) => fits(e) && !e.name.startsWith('stacked');
      const plan: Array<{ remoteDir: string; localDir: string; filter?: (e: FtpEntry) => boolean }> = [
        { remoteDir: s.path, localDir: dest, filter: (e) => opts.includeSubframes || !isSub(e) },
      ];
      if (opts.includeCalibration) {
        const cam = s.camera === 'wide' ? 'cam_1' : 'cam_0';
        for (const kind of ['dark', 'flat', 'bias']) {
          plan.push({ remoteDir: `/Astronomy/CALI_FRAME/${kind}/${cam}`, localDir: path.join(config.paths.library, 'CALI_FRAME', kind, cam) });
        }
      }
      const res = await downloadFiles(plan, (p) => {
        job.progress = p;
        jobBus.emit('job', getJob(job.id));
      }, signal);
      let shots: unknown = null;
      try {
        shots = JSON.parse(fs.readFileSync(path.join(dest, 'shotsInfo.json'), 'utf8'));
      } catch {
        /* optional */
      }
      fs.writeFileSync(
        path.join(dest, 'session.json'),
        JSON.stringify({ ...s, shotsInfo: shots, transferredAt: new Date().toISOString(), calibrationDir: opts.includeCalibration ? path.join(config.paths.library, 'CALI_FRAME') : null }, null, 2),
      );
      // Queue processing in AstroPhoto Studio (it waits in the local outbox while the server is unreachable).
      let processing: unknown;
      if (opts.includeSubframes && (opts.process ?? config.studio.autoProcess) && config.studio.url) {
        // pool: this night together with every earlier session of the target in the library
        const sessions = opts.pool ?? config.studio.poolSessions ? librarySessionsFor(s.target, s.camera) : [s.folder];
        processing = enqueueProcessing({ sessions: sessions.includes(s.folder) ? sessions : [...sessions, s.folder], target: s.target, profile: opts.profile, origin: 'transfer' });
      }
      return { destination: dest, ...res, processing };
    });
  })();
}

/** Copy individual album files (photos/videos/stacked images) into the library. */
export function transferFiles(devicePaths: string[]): Job {
  return startJob('transfer_files', `transfer ${devicePaths.length} file(s)`, async (job, signal) => {
    const out: string[] = [];
    for (const [i, p] of devicePaths.entries()) {
      if (signal.aborted) throw new Error('cancelled');
      const rel = p.replace(/^\/?DWARF3\//, '');
      const day = new Date().toISOString().slice(0, 10);
      const local = rel.startsWith('Astronomy/') ? path.join(config.paths.library, rel) : path.join(config.paths.library, '_photos', day, path.basename(rel));
      await downloadOne(p, local);
      out.push(local);
      job.progress = { filesDone: i + 1, filesTotal: devicePaths.length, bytesDone: 0, bytesTotal: 0, file: p };
      jobBus.emit('job', getJob(job.id));
    }
    return { files: out };
  });
}

/** Summary of what's in the library: sessions (DWARF_RAW_… folders) grouped by target. */
export function listLibrary(): Array<{ target: string; sessions: Array<{ name: string; camera: string; lights: number; rejected: number; startedAt?: string }> }> {
  const root = config.paths.library;
  if (!fs.existsSync(root)) return [];
  const byTarget = new Map<string, Array<{ name: string; camera: string; lights: number; rejected: number; startedAt?: string }>>();
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    const s = d.isDirectory() ? parseSessionFolder(d.name) : null;
    if (!s) continue;
    const files = fs.readdirSync(path.join(root, d.name)).filter((f) => f.toLowerCase().endsWith('.fits') && !f.startsWith('stacked'));
    const rejected = files.filter((f) => f.startsWith('failed_')).length;
    const list = byTarget.get(s.target) ?? [];
    list.push({ name: d.name, camera: s.camera, lights: files.length - rejected, rejected, startedAt: s.startedAt });
    byTarget.set(s.target, list);
  }
  return [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([target, sessions]) => ({ target, sessions: sessions.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')) }));
}
