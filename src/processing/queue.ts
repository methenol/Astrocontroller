/**
 * Processing outbox: sessions waiting to be processed by AstroPhoto Studio (persisted by
 * store.ts; a field session's items wait, and go out once the server answers again).
 *
 * For each item the reconciler:
 *   1. decides how the server gets the data (ASTROPHOTO_DATA_ACCESS):
 *        shared  the server reads the same library (the NAS), found at ASTROPHOTO_LIBRARY_PATH
 *        upload  the subs (+ shotsInfo.json, + the CALI_FRAME masters of that camera) are uploaded
 *                to the server's uploads folder, mirroring the library layout; resumable
 *        auto    shared when the server already sees every sub of the session, else upload
 *   2. submits the job (idempotent: the server dedupes on client_ref, so a lost reply is harmless)
 *   3. polls it until it finishes, then copies the outputs into <session>/processed/.
 *
 * Cancelling or retrying an item while a step is in flight is safe: every step re-checks that the
 * item is still the same live generation after each await, and a job the server accepted after
 * a cancel is cancelled there too.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import { isPlainName } from '../library/sessions.js';
import * as studioApi from './studio.js';
import { OutboxStore, isOpen, type ProcessingItem } from './store.js';
import { withoutCredentials } from '../util/url.js';
import { SafeEmitter } from '../util/events.js';

export type { ItemState, ProcessingItem } from './store.js';

const log = logger('processing');

/** Sends/polls that fail this many times in a row fail the item. */
const MAX_ATTEMPTS = 10;
/** A server restart mid-job is resent this many times. */
const MAX_RESENDS = 3;
/** With nothing open, the server's reachability is re-checked this often. */
const IDLE_RECHECK_MS = 300000;
/** Upload progress goes to the UI at most this often. */
const PROGRESS_EMIT_MS = 2000;
const MIN_POLL_S = 10;
const CALIBRATION_KINDS = ['dark', 'flat', 'bias'];
/** Longest target name accepted (it labels the job on the server). */
const MAX_TARGET_CHARS = 200;

export type StudioClient = Pick<typeof studioApi, 'health' | 'resolve' | 'submit' | 'job' | 'cancel' | 'uploads' | 'uploadFile' | 'download'>;

/** The item was cancelled or retried while this step was in flight: stop quietly. */
class Superseded extends Error {
  constructor() {
    super('superseded');
  }
}

const posix = (...p: string[]) => path.posix.join(...p.filter(Boolean));
const isFitsName = (f: string) => /\.fits?$/i.test(f);
const isSub = (f: string) => isFitsName(f) && !/^stacked/i.test(f);
const sessionKey = (sessions: string[]) => [...sessions].sort().join('|');

/** The session's path as the server sees it, when it shares the library. */
function sharedPath(session: string): string {
  return posix(config.studio.libraryPath, session);
}

function localSubs(session: string): string[] {
  const dir = path.join(config.paths.library, session);
  try {
    return fs.readdirSync(dir).filter(isSub);
  } catch (err) {
    throw new Error(`session folder ${dir} is unreadable: ${errMsg(err)}`);
  }
}

/** Size of a local file, or undefined when it is not there. */
function sizeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** A refusal (bad profile, no subs) does not get better by itself; network trouble does. */
function isPermanent(e: unknown): boolean {
  return e instanceof studioApi.StudioError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 404 && e.status !== 409;
}

export class ProcessingQueue {
  readonly bus = new SafeEmitter();
  private readonly store: OutboxStore;
  private running = false;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastReach: { ok: boolean; at: number; version?: string; error?: string } = { ok: false, at: 0 };
  private readonly aborts = new Map<string, AbortController>();
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly studio: StudioClient,
    dataFile: () => string,
  ) {
    this.store = new OutboxStore(dataFile);
  }

  private changed(it: ProcessingItem): void {
    this.store.save();
    this.bus.emit('item', { ...it });
  }

  listItems(limit = 50): ProcessingItem[] {
    return [...this.store.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  getItem(id: string): ProcessingItem | undefined {
    return this.store.find(id);
  }

  reachability() {
    return { url: config.studio.url ? withoutCredentials(config.studio.url) : null, ...this.lastReach };
  }

  /** Queue sessions (DWARF_RAW_… folder names in the library; several = one target over several nights). */
  enqueue(o: { sessions: string[]; target: string; profile?: string; kind?: string; origin?: string }): ProcessingItem {
    if (!config.studio.url) throw new Error('ASTROPHOTO_URL is not set in .env: processing is off');
    const target = o.target.trim();
    if (!target || target.length > MAX_TARGET_CHARS) throw new Error(`the target name must be 1-${MAX_TARGET_CHARS} characters`);
    const sessions = [...new Set(o.sessions)];
    if (!sessions.length) throw new Error('no sessions to process');
    for (const s of sessions) {
      if (!isPlainName(s)) throw new Error(`not a session folder name: ${s}`);
      if (!fs.existsSync(path.join(config.paths.library, s))) throw new Error(`session not in the library: ${s}`);
    }
    const key = sessionKey(sessions);
    const dup = this.store.items.find((i) => isOpen(i) && sessionKey(i.sessions) === key);
    if (dup) return dup;
    const it: ProcessingItem = {
      id: `proc_${randomUUID()}`,
      sessions,
      target,
      profile: o.profile || config.studio.profile,
      kind: o.kind || 'all',
      origin: o.origin || 'agent',
      createdAt: Date.now(),
      state: 'waiting',
      generation: 0,
      attempts: 0,
      message: 'waiting to be sent to AstroPhoto Studio',
    };
    this.store.add(it);
    this.changed(it);
    log.info(`queued processing of ${it.target} (${it.sessions.join(', ')}), profile ${it.profile}`);
    this.kick();
    return it;
  }

  /** Cancel an open item, here and (when it was submitted) on the server. */
  async cancel(id: string): Promise<ProcessingItem> {
    const it = this.getItem(id);
    if (!it) throw new Error(`no processing item ${id}`);
    if (!isOpen(it)) throw new Error(`item is ${it.state}; only waiting, uploading or submitted items can be cancelled`);
    const jobId = it.state === 'submitted' ? it.studioJobId : undefined;
    // cancelled here first: any step in flight sees it and stops
    Object.assign(it, { state: 'cancelled', finishedAt: Date.now(), message: 'cancelled' });
    this.aborts.get(it.id)?.abort();
    if (jobId) {
      await this.studio.cancel(jobId).catch((e) => {
        it.message = `cancelled here; the server did not take the cancel (${errMsg(e)}), so its job may still run`;
        log.warn(`${it.target}: ${it.message}`);
      });
    }
    this.changed(it);
    return it;
  }

  /** Send a failed/cancelled item again (a new job on the server). */
  retry(id: string): ProcessingItem {
    const it = this.getItem(id);
    if (!it) throw new Error(`no processing item ${id}`);
    if (it.state !== 'failed' && it.state !== 'cancelled') throw new Error(`item is ${it.state}; only failed or cancelled items can be retried`);
    Object.assign(it, { state: 'waiting', generation: it.generation + 1, resends: 0, studioJobId: undefined, studio: undefined, upload: undefined, lastError: undefined, attempts: 0, finishedAt: undefined, message: 'waiting to be sent again' });
    this.changed(it);
    this.kick();
    return it;
  }

  start(): void {
    if (!config.studio.url) {
      log.info('ASTROPHOTO_URL not set: processing in AstroPhoto Studio is off');
      return;
    }
    this.stopped = false;
    log.info(`AstroPhoto Studio at ${withoutCredentials(config.studio.url)} (profile ${config.studio.profile}, data access ${config.studio.dataAccess}, auto-process ${config.studio.autoProcess})`);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.kick(), Math.max(MIN_POLL_S, config.studio.pollS) * 1000);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const a of this.aborts.values()) a.abort();
  }

  /** Reconcile now (or right after the pass in progress). */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.idle = this.reconcile()
      .catch((e) => log.warn(`processing reconcile: ${errMsg(e)}`))
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Resolves when no pass is running (tests). */
  async settled(): Promise<void> {
    while (this.running) await this.idle;
  }

  private async reconcile(): Promise<void> {
    const open = this.store.items.filter(isOpen);
    if (!open.length && Date.now() - this.lastReach.at < IDLE_RECHECK_MS) return;
    try {
      const h = await this.studio.health();
      if (!this.lastReach.ok) log.info(`AstroPhoto Studio reachable (${h.version})`);
      this.lastReach = { ok: true, at: Date.now(), version: h.version };
    } catch (e) {
      if (this.lastReach.ok || !this.lastReach.at) log.warn(errMsg(e));
      this.lastReach = { ok: false, at: Date.now(), error: errMsg(e) };
      return;
    }
    for (const it of open) {
      if (this.stopped) return;
      if (!isOpen(it)) continue; // cancelled while an earlier item was being handled
      const gen = it.generation;
      const live = () => {
        if (it.state === 'cancelled' || it.generation !== gen || this.stopped) throw new Superseded();
      };
      try {
        if (it.state === 'submitted') await this.poll(it, live);
        else await this.send(it, live);
      } catch (e) {
        if (e instanceof Superseded || it.state === 'cancelled' || it.generation !== gen) {
          if (this.stopped && it.state === 'uploading') it.state = 'waiting';
          this.changed(it);
          continue;
        }
        this.failedStep(it, e);
      }
    }
  }

  private failedStep(it: ProcessingItem, e: unknown): void {
    it.attempts++;
    it.lastError = errMsg(e);
    if (isPermanent(e) || it.attempts >= MAX_ATTEMPTS) {
      Object.assign(it, { state: 'failed', finishedAt: Date.now(), message: `failed: ${it.lastError}` });
    } else {
      if (it.state === 'uploading') it.state = 'waiting';
      it.message = `will retry (${it.attempts}/${MAX_ATTEMPTS}): ${it.lastError}`;
    }
    log.warn(`${it.target}: ${it.message}`);
    this.changed(it);
  }

  /** How the server gets the data, or null to wait (shared access, and the server does not see it all yet). */
  private async chooseAccess(it: ProcessingItem, live: () => void): Promise<'shared' | 'upload' | null> {
    const forced = config.studio.dataAccess;
    if (forced === 'upload') return 'upload';
    const total = it.sessions.reduce((a, s) => a + localSubs(s).length, 0);
    let seen: studioApi.ResolveResult | null = null;
    try {
      seen = await this.studio.resolve({ paths: it.sessions.map(sharedPath) });
    } catch (e) {
      if (!(e instanceof studioApi.StudioError && e.status === 404)) throw e;
    }
    live();
    if (seen?.exists && seen.n_fits >= total) return 'shared';
    if (forced !== 'shared') return 'upload';
    it.message = `waiting: the server does not see the session yet (${seen?.n_fits ?? 0} of ${total} subs at ${it.sessions.map(sharedPath).join(', ')})`;
    this.changed(it);
    return null;
  }

  private async send(it: ProcessingItem, live: () => void): Promise<void> {
    const access = await this.chooseAccess(it, live);
    if (!access) return;
    it.access = access;
    if (access === 'upload') await this.uploadSessions(it, live);
    const sp = config.studio.stackParams;
    const res = await this.studio.submit({
      paths: access === 'upload' ? it.sessions.map((s) => posix('library', s)) : it.sessions.map(sharedPath),
      source: access === 'upload' ? 'uploads' : 'images',
      kind: it.kind,
      profile: it.profile,
      stack_params: Object.keys(sp).length ? sp : undefined,
      params: Object.keys(config.studio.params).length ? config.studio.params : undefined,
      preset: config.studio.preset || undefined,
      client_ref: `${it.id}.${it.generation}`,
      origin: 'automation',
      label: it.sessions.length > 1 ? `${it.target} (${it.sessions.length} sessions)` : it.target,
    });
    try {
      live();
    } catch (e) {
      // the server took a job nobody wants any more
      await this.studio.cancel(res.id).catch((err) => log.warn(`${it.target}: could not cancel Studio job ${res.id} after the item was cancelled: ${errMsg(err)}`));
      throw e;
    }
    Object.assign(it, { state: 'submitted', studioJobId: res.id, attempts: 0, lastError: undefined });
    this.applyJob(it, res);
    log.info(`${it.target}: submitted as Studio job ${res.id} (${access}, profile ${it.profile})${res.duplicate ? ' (already there)' : ''}`);
    this.changed(it);
  }

  /** The files the server needs: the subs, shotsInfo.json, and the masters of the sessions' cameras. */
  private uploadPlan(it: ProcessingItem): Array<{ local: string; remote: string; size: number }> {
    const lib = config.paths.library;
    const want: Array<{ local: string; remote: string; size: number }> = [];
    const add = (...rel: string[]) => {
      const size = sizeOf(path.join(lib, ...rel));
      if (size !== undefined) want.push({ local: path.join(lib, ...rel), remote: posix('library', ...rel), size });
    };
    const cams = new Set<string>();
    for (const s of it.sessions) {
      for (const f of localSubs(s)) add(s, f);
      add(s, 'shotsInfo.json');
      cams.add(/^DWARF_RAW_WIDE/i.test(s) ? 'cam_1' : 'cam_0');
    }
    for (const kind of CALIBRATION_KINDS) {
      for (const cam of cams) {
        let files: string[];
        try {
          files = fs.readdirSync(path.join(lib, 'CALI_FRAME', kind, cam));
        } catch {
          continue; // no masters of this kind
        }
        for (const f of files) if (isFitsName(f)) add('CALI_FRAME', kind, cam, f);
      }
    }
    return want;
  }

  private async uploadSessions(it: ProcessingItem, live: () => void): Promise<void> {
    const want = this.uploadPlan(it);
    const have = new Map<string, number>();
    for (const prefix of [...it.sessions.map((s) => posix('library', s)), posix('library', 'CALI_FRAME')]) {
      for (const f of (await this.studio.uploads(prefix)).files) have.set(f.path, f.bytes);
      live();
    }
    const todo = want.filter((w) => have.get(w.remote) !== w.size);
    const bytesTotal = want.reduce((a, w) => a + w.size, 0);
    const todoBytes = todo.reduce((a, w) => a + w.size, 0);
    const upload = { filesDone: want.length - todo.length, filesTotal: want.length, bytesDone: bytesTotal - todoBytes, bytesTotal };
    Object.assign(it, { state: 'uploading', upload, message: `uploading ${todo.length} files (${(todoBytes / 1e9).toFixed(2)} GB) to the server` });
    this.changed(it);
    const ac = new AbortController();
    this.aborts.set(it.id, ac);
    let lastEmit = 0;
    try {
      for (const w of todo) {
        live();
        const before = upload.bytesDone;
        await this.studio.uploadFile(
          w.local,
          w.remote,
          (n) => {
            upload.bytesDone += n;
            if (Date.now() - lastEmit > PROGRESS_EMIT_MS) {
              lastEmit = Date.now();
              this.bus.emit('item', { ...it });
            }
          },
          ac.signal,
        );
        upload.bytesDone = before + w.size;
        upload.filesDone++;
      }
    } catch (e) {
      live();
      throw e;
    } finally {
      this.aborts.delete(it.id);
    }
    live();
    it.message = 'uploaded';
    this.changed(it);
  }

  private applyJob(it: ProcessingItem, j: studioApi.StudioJob): void {
    it.studio = {
      state: j.state,
      progress: Math.round((j.progress ?? 0) * 1000) / 1000,
      message: j.message,
      position: j.position,
      startsInS: j.starts_in,
      etaS: j.total_eta ?? j.stage_eta ?? null,
      activeS: j.active,
    };
    it.message = j.state === 'queued' ? `queued on the server${j.position ? ` (position ${j.position})` : ''}` : `${j.state}: ${j.message ?? ''}`;
  }

  private resend(it: ProcessingItem, message: string): void {
    Object.assign(it, { state: 'waiting', generation: it.generation + 1, resends: (it.resends ?? 0) + 1, studioJobId: undefined, studio: undefined, message });
    // sent again right after this pass, not a poll interval later
    this.again = true;
  }

  private async poll(it: ProcessingItem, live: () => void): Promise<void> {
    let j: studioApi.StudioJob;
    try {
      j = await this.studio.job(it.studioJobId!);
    } catch (e) {
      live();
      if (e instanceof studioApi.StudioError && e.status === 404) {
        this.resend(it, 'the server no longer knows the job; sending it again');
        this.changed(it);
        return;
      }
      throw e;
    }
    live();
    const before = JSON.stringify(it.studio);
    this.applyJob(it, j);
    if (j.state === 'done') {
      const outputs = config.studio.fetchOutputs ? await this.fetchOutputs(it, j, live) : (j.outputs ?? []).map((o) => `${withoutCredentials(config.studio.url)}${o.url}`);
      live();
      Object.assign(it, { outputs, state: 'done', finishedAt: Date.now() });
      it.message = `done in ${Math.round((j.active ?? 0) / 60)} min${outputs.length ? `: ${outputs.map((o) => path.basename(o)).join(', ')}` : ''}`;
      log.info(`${it.target}: processing finished (${it.message})`);
    } else if (j.state === 'interrupted' && (it.resends ?? 0) < MAX_RESENDS) {
      // the server restarted mid-job: queue it again
      this.resend(it, 'interrupted by a server restart; sending it again');
    } else if (j.state === 'error' || j.state === 'cancelled' || j.state === 'interrupted') {
      Object.assign(it, { state: j.state === 'cancelled' ? 'cancelled' : 'failed', finishedAt: Date.now(), lastError: j.message, message: `${j.state} on the server: ${j.message ?? ''}` });
      log.warn(`${it.target}: ${it.message}`);
    }
    if (JSON.stringify(it.studio) !== before || it.state !== 'submitted') this.changed(it);
  }

  /** Copy the job's outputs into <first session>/processed/; names from the server are reduced to plain file names. */
  private async fetchOutputs(it: ProcessingItem, j: studioApi.StudioJob, live: () => void): Promise<string[]> {
    const dir = path.join(config.paths.library, it.sessions[0], 'processed');
    fs.mkdirSync(dir, { recursive: true });
    const out: string[] = [];
    const ac = new AbortController();
    this.aborts.set(it.id, ac);
    try {
      for (const o of j.outputs ?? []) {
        live();
        const dest = this.outputFile(it, dir, o);
        if (!dest) continue;
        if (sizeOf(dest) !== o.bytes) await this.studio.download(o.url, dest, ac.signal);
        out.push(dest);
      }
    } finally {
      this.aborts.delete(it.id);
    }
    return out;
  }

  /** Where a server output goes, or null for one with an unusable name. */
  private outputFile(it: ProcessingItem, dir: string, o: studioApi.StudioJob['outputs'][number]): string | null {
    const name = path.posix.basename(String(o.name ?? '').replace(/\\/g, '/'));
    if (!isPlainName(name) || typeof o.url !== 'string') {
      log.warn(`${it.target}: skipped a server output with an unusable name ${JSON.stringify(o.name)}`);
      return null;
    }
    return path.join(dir, name);
  }
}

const outbox = new ProcessingQueue(studioApi, () => path.join(config.paths.data, 'processing.json'));

export const processingBus = outbox.bus;
export const listItems = (limit?: number) => outbox.listItems(limit);
export const getItem = (id: string) => outbox.getItem(id);
export const reachability = () => outbox.reachability();
export const enqueueProcessing = (o: Parameters<ProcessingQueue['enqueue']>[0]) => outbox.enqueue(o);
export const cancelItem = (id: string) => outbox.cancel(id);
export const retryItem = (id: string) => outbox.retry(id);
export const startProcessing = () => outbox.start();
export const stopProcessing = () => outbox.stop();
export const kick = () => outbox.kick();
