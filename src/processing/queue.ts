/**
 * Processing outbox: sessions waiting to be processed by AstroPhoto Studio, persisted in
 * DATA_DIR/processing.json so nothing is lost across restarts or while the server is out of
 * reach (a field session: the items wait, and go out once the server answers again).
 *
 * For each item the reconciler:
 *   1. decides how the server gets the data (ASTROPHOTO_DATA_ACCESS):
 *        shared  the server reads the same library (the NAS), found at ASTROPHOTO_LIBRARY_PATH
 *        upload  the subs (+ shotsInfo.json, + the CALI_FRAME masters of that camera) are uploaded
 *                to the server's uploads folder, mirroring the library layout; resumable
 *        auto    shared when the server already sees every sub of the session, else upload
 *   2. submits the job (idempotent: the server dedupes on client_ref, so a lost reply is harmless)
 *   3. polls it until it finishes, then copies the outputs into <session>/processed/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger, errMsg } from '../log.js';
import * as studio from './studio.js';

const log = logger('processing');

export type ItemState = 'waiting' | 'uploading' | 'submitted' | 'done' | 'failed' | 'cancelled';

export interface ProcessingItem {
  id: string;
  sessions: string[];
  target: string;
  profile: string;
  kind: string;
  origin: string;
  createdAt: number;
  state: ItemState;
  generation: number;
  access?: 'shared' | 'upload';
  upload?: { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number };
  studioJobId?: string;
  studio?: { state: string; progress: number; message?: string; position?: number; startsInS?: number | null; etaS?: number | null; activeS?: number };
  outputs?: string[];
  message?: string;
  lastError?: string;
  attempts: number;
  finishedAt?: number;
}

export const processingBus = new EventEmitter();
const file = () => path.join(config.paths.data, 'processing.json');
let items: ProcessingItem[] = [];
let loaded = false;
let running = false;
let again = false;
let timer: NodeJS.Timeout | null = null;
let lastReach: { ok: boolean; at: number; version?: string; error?: string } = { ok: false, at: 0 };
const aborts = new Map<string, AbortController>();

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    items = JSON.parse(fs.readFileSync(file(), 'utf8')).items ?? [];
    for (const it of items) if (it.state === 'uploading') it.state = 'waiting'; // resumes
  } catch {
    items = [];
  }
}

function save(): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 1));
  fs.renameSync(tmp, file());
}

function changed(it: ProcessingItem): void {
  save();
  processingBus.emit('item', { ...it });
}

export function listItems(limit = 50): ProcessingItem[] {
  load();
  return [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function getItem(id: string): ProcessingItem | undefined {
  load();
  return items.find((i) => i.id === id || i.studioJobId === id);
}

export function reachability() {
  return { url: config.studio.url || null, ...lastReach };
}

/** Queue sessions (DWARF_RAW_… folder names in the library; several = one target over several nights). */
export function enqueueProcessing(o: { sessions: string[]; target: string; profile?: string; kind?: string; origin?: string }): ProcessingItem {
  load();
  if (!config.studio.url) throw new Error('ASTROPHOTO_URL is not set in .env: processing is off');
  for (const s of o.sessions) {
    if (!fs.existsSync(path.join(config.paths.library, s))) throw new Error(`session not in the library: ${s}`);
  }
  const key = [...o.sessions].sort().join('|');
  const dup = items.find((i) => [...i.sessions].sort().join('|') === key && ['waiting', 'uploading', 'submitted'].includes(i.state));
  if (dup) return dup;
  const it: ProcessingItem = {
    id: `proc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    sessions: o.sessions,
    target: o.target,
    profile: o.profile || config.studio.profile,
    kind: o.kind || 'all',
    origin: o.origin || 'agent',
    createdAt: Date.now(),
    state: 'waiting',
    generation: 0,
    attempts: 0,
    message: 'waiting to be sent to AstroPhoto Studio',
  };
  items.push(it);
  changed(it);
  log.info(`queued processing of ${it.target} (${it.sessions.join(', ')}), profile ${it.profile}`);
  kick();
  return it;
}

export async function cancelItem(id: string): Promise<ProcessingItem> {
  const it = getItem(id);
  if (!it) throw new Error(`no processing item ${id}`);
  aborts.get(it.id)?.abort();
  if (it.studioJobId && it.state === 'submitted') await studio.cancel(it.studioJobId);
  it.state = 'cancelled';
  it.finishedAt = Date.now();
  it.message = 'cancelled';
  changed(it);
  return it;
}

/** Send a failed/cancelled item again (a new job on the server). */
export function retryItem(id: string): ProcessingItem {
  const it = getItem(id);
  if (!it) throw new Error(`no processing item ${id}`);
  if (!['failed', 'cancelled'].includes(it.state)) throw new Error(`item is ${it.state}; only failed or cancelled items can be retried`);
  Object.assign(it, { state: 'waiting', generation: it.generation + 1, studioJobId: undefined, studio: undefined, lastError: undefined, attempts: 0, finishedAt: undefined, message: 'waiting to be sent again' });
  changed(it);
  kick();
  return it;
}

export function startProcessing(): void {
  load();
  if (!config.studio.url) {
    log.info('ASTROPHOTO_URL not set: processing in AstroPhoto Studio is off');
    return;
  }
  log.info(`AstroPhoto Studio at ${config.studio.url} (profile ${config.studio.profile}, data access ${config.studio.dataAccess}, auto-process ${config.studio.autoProcess})`);
  timer = setInterval(kick, Math.max(10, config.studio.pollS) * 1000);
  timer.unref();
  kick();
}

export function stopProcessing(): void {
  if (timer) clearInterval(timer);
  for (const a of aborts.values()) a.abort();
}

export function kick(): void {
  if (running) {
    again = true;
    return;
  }
  running = true;
  void reconcile()
    .catch((e) => log.warn(`processing reconcile: ${errMsg(e)}`))
    .finally(() => {
      running = false;
      if (again) {
        again = false;
        kick();
      }
    });
}

async function reconcile(): Promise<void> {
  const open = items.filter((i) => ['waiting', 'uploading', 'submitted'].includes(i.state));
  if (!open.length && Date.now() - lastReach.at < 300000) return;
  try {
    const h = await studio.health();
    if (!lastReach.ok) log.info(`AstroPhoto Studio reachable (${h.version})`);
    lastReach = { ok: true, at: Date.now(), version: h.version };
  } catch (e) {
    if (lastReach.ok || !lastReach.at) log.warn(errMsg(e));
    lastReach = { ok: false, at: Date.now(), error: errMsg(e) };
    return;
  }
  for (const it of open) {
    try {
      if (it.state === 'submitted') await poll(it);
      else await send(it);
    } catch (e) {
      if ((it.state as ItemState) === 'cancelled') {
        changed(it);
        continue;
      }
      it.attempts++;
      it.lastError = errMsg(e);
      // a refusal (bad profile, no subs) does not get better by itself; network trouble does
      const permanent = e instanceof studio.StudioError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 404 && e.status !== 409;
      if (permanent || it.attempts >= 10) {
        it.state = 'failed';
        it.finishedAt = Date.now();
        it.message = `failed: ${it.lastError}`;
      } else {
        if (it.state === 'uploading') it.state = 'waiting';
        it.message = `will retry (${it.attempts}/10): ${it.lastError}`;
      }
      log.warn(`${it.target}: ${it.message}`);
      changed(it);
    }
  }
}

const posix = (...p: string[]) => path.posix.join(...p.filter(Boolean));
const isSub = (f: string) => /\.fits?$/i.test(f) && !/^stacked/i.test(f);

function localSubs(session: string): string[] {
  return fs.readdirSync(path.join(config.paths.library, session)).filter(isSub);
}

/** The session's path as the server sees it, when it shares the library. */
function sharedPath(session: string): string {
  const base = config.studio.libraryPath;
  return base.startsWith('/') ? posix(base, session) : posix(base, session) || session;
}

async function send(it: ProcessingItem): Promise<void> {
  let access = config.studio.dataAccess === 'auto' ? undefined : config.studio.dataAccess;
  if (access !== 'upload') {
    const counts = it.sessions.map((s) => localSubs(s).length);
    let seen: studio.ResolveResult | null = null;
    try {
      seen = await studio.resolve({ paths: it.sessions.map(sharedPath) });
    } catch (e) {
      if (!(e instanceof studio.StudioError && e.status === 404)) throw e;
    }
    const total = counts.reduce((a, b) => a + b, 0);
    if (seen?.exists && seen.n_fits >= total) access = 'shared';
    else if (access === 'shared') {
      it.message = `waiting: the server does not see the session yet (${seen?.n_fits ?? 0} of ${total} subs at ${it.sessions.map(sharedPath).join(', ')})`;
      changed(it);
      return;
    } else access = 'upload';
  }
  it.access = access;
  if (access === 'upload') await uploadSessions(it);
  const ref = `${it.id}.${it.generation}`;
  const sp = config.studio.stackParams;
  const res = await studio.submit({
    paths: access === 'upload' ? it.sessions.map((s) => posix('library', s)) : it.sessions.map(sharedPath),
    source: access === 'upload' ? 'uploads' : 'images',
    kind: it.kind,
    profile: it.profile,
    stack_params: Object.keys(sp).length ? sp : undefined,
    params: Object.keys(config.studio.params).length ? config.studio.params : undefined,
    preset: config.studio.preset || undefined,
    client_ref: ref,
    origin: 'automation',
    label: it.sessions.length > 1 ? `${it.target} (${it.sessions.length} sessions)` : it.target,
  });
  it.state = 'submitted';
  it.studioJobId = res.id;
  it.attempts = 0;
  it.lastError = undefined;
  applyJob(it, res);
  log.info(`${it.target}: submitted as Studio job ${res.id} (${access}, profile ${it.profile})${res.duplicate ? ' (already there)' : ''}`);
  changed(it);
}

async function uploadSessions(it: ProcessingItem): Promise<void> {
  const lib = config.paths.library;
  const want: Array<{ local: string; remote: string; size: number }> = [];
  const add = (rel: string) => {
    const local = path.join(lib, rel);
    if (fs.existsSync(local)) want.push({ local, remote: posix('library', rel.split(path.sep).join('/')), size: fs.statSync(local).size });
  };
  const cams = new Set<string>();
  for (const s of it.sessions) {
    for (const f of localSubs(s)) add(path.join(s, f));
    add(path.join(s, 'shotsInfo.json'));
    cams.add(/^DWARF_RAW_WIDE/i.test(s) ? 'cam_1' : 'cam_0');
  }
  for (const kind of ['dark', 'flat', 'bias']) {
    for (const cam of cams) {
      const d = path.join(lib, 'CALI_FRAME', kind, cam);
      if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (/\.fits?$/i.test(f)) add(path.join('CALI_FRAME', kind, cam, f));
    }
  }
  const have = new Map<string, number>();
  for (const prefix of [...it.sessions.map((s) => posix('library', s)), posix('library', 'CALI_FRAME')]) {
    for (const f of (await studio.uploads(prefix)).files) have.set(f.path, f.bytes);
  }
  const todo = want.filter((w) => have.get(w.remote) !== w.size);
  const bytesTotal = want.reduce((a, w) => a + w.size, 0);
  let bytesDone = bytesTotal - todo.reduce((a, w) => a + w.size, 0);
  it.state = 'uploading';
  it.upload = { filesDone: want.length - todo.length, filesTotal: want.length, bytesDone, bytesTotal };
  it.message = `uploading ${todo.length} files (${(todo.reduce((a, w) => a + w.size, 0) / 1e9).toFixed(2)} GB) to the server`;
  changed(it);
  const ac = new AbortController();
  aborts.set(it.id, ac);
  let lastEmit = 0;
  try {
    for (const w of todo) {
      if (ac.signal.aborted) throw new Error('upload cancelled');
      await studio.uploadFile(w.local, w.remote, (n) => {
        bytesDone += n;
        it.upload!.bytesDone = bytesDone;
        if (Date.now() - lastEmit > 2000) {
          lastEmit = Date.now();
          processingBus.emit('item', { ...it });
        }
      }, ac.signal);
      it.upload.filesDone++;
    }
  } finally {
    aborts.delete(it.id);
  }
  if ((it.state as ItemState) === 'cancelled') throw new Error('upload cancelled');
  it.message = 'uploaded';
  changed(it);
}

function applyJob(it: ProcessingItem, j: studio.StudioJob): void {
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

async function poll(it: ProcessingItem): Promise<void> {
  let j: studio.StudioJob;
  try {
    j = await studio.job(it.studioJobId!);
  } catch (e) {
    if (e instanceof studio.StudioError && e.status === 404) {
      // the server lost the job (history cleared): send it again
      Object.assign(it, { state: 'waiting', generation: it.generation + 1, studioJobId: undefined, message: 'the server no longer knows the job; sending it again' });
      changed(it);
      return;
    }
    throw e;
  }
  const before = JSON.stringify(it.studio);
  applyJob(it, j);
  if (j.state === 'done') {
    it.outputs = config.studio.fetchOutputs ? await fetchOutputs(it, j) : j.outputs.map((o) => `${config.studio.url}${o.url}`);
    it.state = 'done';
    it.finishedAt = Date.now();
    it.message = `done in ${Math.round((j.active ?? 0) / 60)} min${it.outputs.length ? `: ${it.outputs.map((o) => path.basename(o)).join(', ')}` : ''}`;
    log.info(`${it.target}: processing finished (${it.message})`);
  } else if (j.state === 'interrupted' && it.generation < 3) {
    // the server restarted mid-job: queue it again
    Object.assign(it, { state: 'waiting', generation: it.generation + 1, studioJobId: undefined, message: 'interrupted by a server restart; sending it again' });
  } else if (['error', 'cancelled', 'interrupted'].includes(j.state)) {
    it.state = j.state === 'cancelled' ? 'cancelled' : 'failed';
    it.finishedAt = Date.now();
    it.lastError = j.message;
    it.message = `${j.state} on the server: ${j.message ?? ''}`;
    log.warn(`${it.target}: ${it.message}`);
  }
  if (JSON.stringify(it.studio) !== before || it.state !== 'submitted') changed(it);
}

async function fetchOutputs(it: ProcessingItem, j: studio.StudioJob): Promise<string[]> {
  const dir = path.join(config.paths.library, it.sessions[0], 'processed');
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const o of j.outputs) {
    const dest = path.join(dir, o.name);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== o.bytes) await studio.download(o.url, dest);
    out.push(dest);
  }
  return out;
}
