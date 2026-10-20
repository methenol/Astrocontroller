/**
 * Background jobs (transfers from the telescope). FTP on the telescope is single-threaded in
 * practice, so jobs run one at a time in the order they were queued. Their record is kept in
 * DATA_DIR/jobs.json, so a job's outcome survives a restart; one cut off by a restart is marked
 * failed (interrupted) rather than vanishing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import { FILE_ATTEMPTS } from '../dwarf/ftp.js';
import { SafeEmitter } from '../util/events.js';
import { writeFileAtomic } from '../util/fs.js';

const log = logger('library');

export interface Job {
  id: string;
  kind: string;
  description: string;
  /** partial: finished, but some files could not be copied (listed in result.failed and error) */
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled';
  progress?: { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number; file?: string };
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** who asked for it: the agent is told when its own jobs end */
  origin?: 'agent' | 'ui';
}

export interface FailedFile {
  remote: string;
  error: string;
}

/** Jobs listed to the UI and the agent. */
const LIST_LIMIT = 30;
/** Finished jobs kept in memory; older ones are forgotten. */
const KEEP_FINISHED = 50;
/** Failed files named in a partial job's error. */
const FAILED_NAMED = 5;

type Entry = Job & { abort: AbortController; key?: string };

export const jobBus = new SafeEmitter();
const jobs = new Map<string, Entry>();
let queue: Promise<void> = Promise.resolve();

const active = (j: Job) => j.status === 'queued' || j.status === 'running';

export const INTERRUPTED = 'interrupted: the app restarted before this job finished. Run the same transfer again (files already copied are skipped).';
const STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'partial', 'failed', 'cancelled']);
const jobsFile = () => path.join(config.paths.data, 'jobs.json');
let loadedFrom: string | null = null;

/** The jobs on disk, read once per data directory; jobs that were active when the app stopped are interrupted. */
function load(): void {
  const file = jobsFile();
  if (loadedFrom === file) return;
  loadedFrom = file;
  let saved: unknown;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`jobs: could not read ${file}: ${errMsg(err)}`);
    return;
  }
  if (!Array.isArray(saved)) return;
  let interrupted = 0;
  for (const x of saved as Job[]) {
    if (!x || typeof x.id !== 'string' || jobs.has(x.id) || !STATUSES.has(x.status) || typeof x.startedAt !== 'number') continue;
    const entry: Entry = { ...x, abort: new AbortController() };
    entry.abort.abort();
    if (active(entry)) {
      entry.status = 'failed';
      entry.error = INTERRUPTED;
      entry.finishedAt = entry.finishedAt ?? Date.now();
      interrupted++;
    }
    jobs.set(entry.id, entry);
  }
  if (interrupted) {
    log.warn(`jobs: ${interrupted} job(s) were cut off by a restart`);
    save();
  }
}

function save(): void {
  try {
    writeFileAtomic(jobsFile(), JSON.stringify([...jobs.values()].map(view)));
  } catch (err) {
    log.warn(`jobs: could not save: ${errMsg(err)}`);
  }
}

function view(j: Entry): Job {
  const { abort: _a, key: _k, ...rest } = j;
  return rest;
}

function publish(j: Entry, persist = true): void {
  if (persist) save();
  jobBus.emit('job', view(j));
}

function prune(): void {
  // a running job just cancelled has no finishedAt until its work unwinds: it is the newest, not the oldest
  const finished = [...jobs.values()].filter((j) => !active(j)).sort((a, b) => (b.finishedAt ?? Infinity) - (a.finishedAt ?? Infinity));
  for (const j of finished.slice(KEEP_FINISHED)) jobs.delete(j.id);
}

export function listJobs(): Job[] {
  load();
  return [...jobs.values()].map(view).sort((a, b) => b.startedAt - a.startedAt).slice(0, LIST_LIMIT);
}

export function getJob(id: string): Job | undefined {
  load();
  const j = jobs.get(id);
  return j && view(j);
}

export function cancelJob(id: string): boolean {
  load();
  const j = jobs.get(id);
  if (!j || !active(j)) return false;
  // a queued job never runs; a running one gets finishedAt when its work unwinds
  if (j.status === 'queued') j.finishedAt = Date.now();
  j.abort.abort();
  j.status = 'cancelled';
  publish(j);
  return true;
}

/** Cancel every queued or running job (the user released the telescope). */
export function cancelActiveJobs(): number {
  let n = 0;
  for (const j of [...jobs.values()]) if (cancelJob(j.id)) n++;
  return n;
}

function failedOf(result: unknown): FailedFile[] {
  const f = (result as { failed?: unknown } | null | undefined)?.failed;
  return Array.isArray(f) ? (f as FailedFile[]) : [];
}

function partialError(failed: FailedFile[]): string {
  const named = failed.slice(0, FAILED_NAMED).map((f) => `${f.remote.split('/').pop()} (${f.error})`).join('; ');
  return `${failed.length} file(s) could not be copied after ${FILE_ATTEMPTS} attempts each: ${named}${failed.length > FAILED_NAMED ? '; …' : ''}. Run the same transfer again to retry them (copied files are skipped).`;
}

export interface JobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  progress(p: NonNullable<Job['progress']>): void;
}

/**
 * Queue a job. `run` returns its result; a `failed` array in the result makes the job partial.
 * With a `key`, a queued or running job of the same key is returned instead of queueing the same
 * work twice (a double click, the agent and the UI asking at once).
 */
export function startJob(kind: string, description: string, run: (job: JobHandle) => Promise<unknown>, origin?: Job['origin'], key?: string): Job {
  load();
  if (key !== undefined) {
    const same = [...jobs.values()].find((j) => active(j) && j.key === key);
    if (same) return view(same);
  }
  const id = `job_${randomUUID()}`;
  const entry: Entry = { id, kind, description, status: 'queued', startedAt: Date.now(), origin, key, abort: new AbortController() };
  jobs.set(id, entry);
  prune();
  publish(entry);
  const handle: JobHandle = {
    id,
    signal: entry.abort.signal,
    progress: (p) => {
      if (entry.status !== 'running') return;
      entry.progress = p;
      // progress is not worth a disk write per file; the status changes are
      publish(entry, false);
    },
  };
  // the chain must never reject: a rejected link would skip every job queued after it
  queue = queue.then(() => runEntry(entry, handle, run, description)).catch((err) => log.error(`job queue: ${errMsg(err)}`));
  return view(entry);
}

async function runEntry(entry: Entry, handle: JobHandle, run: (job: JobHandle) => Promise<unknown>, description: string): Promise<void> {
  if (entry.abort.signal.aborted) return;
  entry.status = 'running';
  publish(entry);
  try {
    entry.result = await run(handle);
    const failed = failedOf(entry.result);
    if (entry.abort.signal.aborted) {
      entry.status = 'cancelled';
    } else if (failed.length) {
      entry.status = 'partial';
      entry.error = partialError(failed);
      log.warn(`${description}: partial — ${entry.error}`);
    } else {
      entry.status = 'done';
      log.info(`${description}: done`);
    }
  } catch (err) {
    entry.status = entry.abort.signal.aborted ? 'cancelled' : 'failed';
    entry.error = errMsg(err);
    log.warn(`${description}: ${entry.error}`);
  }
  entry.finishedAt = Date.now();
  publish(entry);
  prune();
}

/** Wait until every queued job has finished (tests and shutdown). */
export function drainJobs(): Promise<void> {
  return queue;
}
