/**
 * The Seestar's image storage (/boot/Image on the scope: MyWorks/, darklibrary/, …), and the
 * library's view of it (device-library.ts).
 *
 *   listing   JSON-RPC, stateful on the scope: get_img_file_page_number({dir}) selects a directory
 *             and returns its page count, get_img_file_page_name({page}) lists a page (20 entries,
 *             0-based) of the selected one. Listings run one at a time.
 *   files     the scope's HTTP server (SEESTAR_HTTP_PORT) serves the storage from its root with
 *             byte ranges: exact sizes, FITS headers without the pixels, resumed downloads.
 *
 * The scope keeps a target's subs in one folder however many nights it was shot
 * (MyWorks/<target>_sub/Light_<target>_<exp>s_<filter>_<YYYYMMDD-HHMMSS>.fit) and its stacks
 * beside it (MyWorks/<target>/Stacked_<n>_<target>_<exp>s_<filter>_<ts>.fit + .jpg + _thn.jpg). A
 * session here is one target, camera, sub length and filter over one night (noon to noon), named
 * like the Dwarf's so the library, pooling and processing take it as it is:
 *
 *   SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-53-45_IRCUT
 *
 * The dark master of its sub length (darklibrary/<exp>s/MasterDark_….fit) goes to
 * CALI_FRAME/dark/seestar_<cam_0|cam_1>. Album paths are /SEESTAR/<storage path>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import type { DeviceLibrary, DownloadProgress, DownloadResult, MediaItem } from '../../library/device-library.js';
import { isTransferredFolder, type DeviceSessionEntry } from '../../library/sessions.js';
import { calibrationCamera } from '../../processing/queue.js';
import type { Seestar } from './device.js';

const log = logger('seestar.storage');

const HTTP_TIMEOUT_MS = 30_000;
const STALL_MS = 60_000;
export const FILE_ATTEMPTS = 3;
const RETRY_MS = 2000;
const HEADER_BYTES = 2880 * 3;
const ROOT = 'MyWorks';
const DARKS = 'darklibrary';
const ALBUM_PREFIX = '/SEESTAR/';
const CACHE_MS = 30_000;
const NIGHT_SHIFT_MS = 12 * 3600_000;
const LIGHT = /^Light_(.+)_([\d.]+)s_([A-Za-z0-9-]+)_(\d{8})-(\d{6})\.fits?$/i;
const STACK = /^Stacked_(\d+)_(.+)_([\d.]+)s_([A-Za-z0-9-]+)_(\d{8})-(\d{6})\.(fits?|jpg)$/i;
const MEDIA = { photo: 1, video: 2, astro: 4 } as const;

export interface SeestarEntry {
  name: string;
  isDir: boolean;
  /** bytes, from the listing's size_k (rounded): HTTP gives the exact size */
  size: number;
  /** the scope's local time, "2026-10-28 05:53:46" */
  date?: string;
  fileCount?: number;
}

export class TransferCancelled extends Error {
  constructor() {
    super('transfer cancelled');
    this.name = 'TransferCancelled';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function localSize(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

function anySignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** FITS header cards (80-character records up to END) as KEY → value. */
export function parseFitsHeader(buf: Buffer): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (let i = 0; i + 80 <= buf.length; i += 80) {
    const card = buf.toString('latin1', i, i + 80);
    const key = card.slice(0, 8).trim();
    if (key === 'END') break;
    if (card[8] !== '=' || !key) continue;
    const raw = card.slice(10);
    const str = /^\s*'((?:[^']|'')*)'/.exec(raw);
    if (str) {
      out[key] = str[1]!.replace(/''/g, "'").trimEnd();
      continue;
    }
    const v = raw.split('/')[0]!.trim();
    if (v === 'T' || v === 'F') out[key] = v === 'T';
    else if (v !== '' && Number.isFinite(Number(v))) out[key] = Number(v);
    else if (v) out[key] = v;
  }
  return out;
}

/** The scope's file listing and HTTP server. Paths are relative to the storage root. */
export class SeestarFiles {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly scope: Pick<Seestar, 'call'>,
    private readonly host: () => string = () => config.seestar.host,
    private readonly httpPort: number = config.seestar.httpPort,
  ) {}

  url(rel: string): string {
    const parts = rel.replace(/^\/+/, '').split('/');
    if (!parts.length || parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`bad Seestar path ${rel}`);
    return `http://${this.host()}:${this.httpPort}/${parts.map(encodeURIComponent).join('/')}`;
  }

  list(dir: string): Promise<SeestarEntry[]> {
    const run = this.queue.then(async () => {
      const pages = await this.scope.call('get_img_file_page_number', { dir });
      const n = typeof pages.result === 'number' ? pages.result : 0;
      const out: SeestarEntry[] = [];
      for (let page = 0; page < n; page++) {
        const r = await this.scope.call('get_img_file_page_name', { page });
        for (const e of Array.isArray(r.result) ? (r.result as Array<Record<string, unknown>>) : []) {
          if (typeof e.name !== 'string') continue;
          out.push({
            name: e.name,
            isDir: e.is_dir === true,
            size: typeof e.size_k === 'number' ? e.size_k * 1024 : 0,
            date: typeof e.date === 'string' ? e.date : undefined,
            fileCount: typeof e.file_cnt === 'number' ? e.file_cnt : undefined,
          });
        }
      }
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async size(rel: string, signal?: AbortSignal): Promise<number> {
    const res = await fetch(this.url(rel), { method: 'HEAD', signal: anySignal(signal, HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
    const n = Number(res.headers.get('content-length'));
    if (!Number.isFinite(n)) throw new Error(`no size for ${rel}`);
    return n;
  }

  async read(rel: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(this.url(rel), { headers: { Range: `bytes=0-${maxBytes - 1}` }, signal: anySignal(signal, HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }

  async readAll(rel: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(this.url(rel), { signal: anySignal(signal, HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) {
      await res.body?.cancel();
      throw new Error(`${rel} is ${Math.round(len / 1e6)} MB, over the ${Math.round(maxBytes / 1e6)} MB this reads`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** delete_image answers 0 for a missing path too: the outcome is checked over HTTP. */
  async delete(rel: string): Promise<boolean> {
    this.url(rel);
    await this.scope.call('delete_image', [rel]);
    const res = await fetch(this.url(rel), { method: 'HEAD', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }).catch(() => null);
    return res?.status === 404;
  }

  async fitsHeader(rel: string, signal?: AbortSignal): Promise<Record<string, string | number | boolean>> {
    return parseFitsHeader(await this.read(rel, HEADER_BYTES, signal));
  }

  /** Copy a file into the library, resuming <local>.part; 'skipped' when the same size is already there. */
  async download(rel: string, local: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<{ outcome: 'copied' | 'skipped'; size: number }> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= FILE_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new TransferCancelled();
      const tmp = `${local}.part`;
      try {
        fs.mkdirSync(path.dirname(local), { recursive: true });
        const size = await this.size(rel, signal);
        if (localSize(local) === size) return { outcome: 'skipped', size };
        let have = localSize(tmp) ?? 0;
        if (have > size) {
          fs.rmSync(tmp, { force: true });
          have = 0;
        }
        if (have < size) await this.fetchInto(rel, tmp, have, size, onBytes, signal);
        const got = localSize(tmp);
        if (got !== size) throw new Error(`incomplete download: ${got ?? 0} of ${size} bytes`);
        fs.renameSync(tmp, local);
        return { outcome: 'copied', size };
      } catch (err) {
        if (err instanceof TransferCancelled || signal?.aborted) throw new TransferCancelled();
        lastErr = err;
        if (attempt < FILE_ATTEMPTS) await sleep(RETRY_MS * attempt);
      }
    }
    throw new Error(errMsg(lastErr));
  }

  private async fetchInto(rel: string, tmp: string, from: number, size: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let stall = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(this.url(rel), { headers: from > 0 ? { Range: `bytes=${from}-${size - 1}` } : {}, signal: ctl.signal });
      const resumed = from > 0 && res.status === 206;
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${rel}`);
      const out = fs.createWriteStream(tmp, { flags: resumed ? 'a' : 'w' });
      let done = resumed ? from : 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(stall);
          stall = setTimeout(() => ctl.abort(), STALL_MS);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
          done += chunk.length;
          onBytes(done);
        }
      } finally {
        await new Promise<void>((r) => out.end(r));
      }
    } catch (err) {
      if (signal?.aborted) throw new TransferCancelled();
      throw err;
    } finally {
      clearTimeout(stall);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

// ---- sessions and the album ---------------------------------------------------------------------

interface SessionInfo {
  session: DeviceSessionEntry;
  subDir: string;
  subs: SeestarEntry[];
  stackDir: string;
  filter: string;
  night: string;
}

interface StackFile {
  target: string;
  frames: number;
  exp: string;
  filter: string;
  stamp: string;
}

const stampOf = (d: string, t: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}-${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}`;

/** The observing night a local "YYYY-MM-DD-hh-mm-ss" belongs to: the date of the evening it started. */
export function nightOf(stamp: string): string {
  const [y, mo, d, h, mi, s] = stamp.split('-').map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - NIGHT_SHIFT_MS).toISOString().slice(0, 10);
}

/** A wall-clock time in a time zone ("2026-10-28 05:53:46") as epoch seconds. */
export function zonedEpochS(local: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T-](\d{2})[:-](\d{2})[:-](\d{2})/.exec(local);
  if (!m) return 0;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const seen = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - (seen - asUtc)) / 1000);
}

export function parseLight(name: string): { target: string; exp: string; filter: string; stamp: string } | null {
  const m = LIGHT.exec(name);
  return m ? { target: m[1]!, exp: m[2]!, filter: m[3]!, stamp: stampOf(m[4]!, m[5]!) } : null;
}

export function parseStack(name: string): StackFile | null {
  const m = STACK.exec(name);
  return m ? { frames: Number(m[1]), target: m[2]!, exp: m[3]!, filter: m[4]!, stamp: stampOf(m[5]!, m[6]!) } : null;
}

const bare = ({ fitsCount: _f, sizeMB: _m, transferred: _t, ...s }: DeviceSessionEntry) => s;
const sessionKey = (target: string, exp: string, filter: string, night: string) => `${target}|${Number(exp)}|${filter}|${night}`;

export type SeestarStorage = DeviceLibrary & {
  /** a session's subs as storage paths, in time order */
  sessionSubs(folder: string): Promise<string[]>;
};

export function seestarStorage(files: SeestarFiles): SeestarStorage {
  let cache: { at: number; infos: SessionInfo[]; other: string[] } | null = null;
  let albumCache: { at: number; items: MediaItem[] } | null = null;
  const headers = new Map<string, { wide: boolean; gain: number }>();

  async function headerOf(rel: string): Promise<{ wide: boolean; gain: number }> {
    const known = headers.get(rel);
    if (known) return known;
    const h = await files.fitsHeader(rel).catch((e) => {
      log.debug(`no FITS header for ${rel}: ${errMsg(e)}`);
      return {} as Record<string, unknown>;
    });
    const v = { wide: h.WIDECAM === 1 || h.WIDECAM === true, gain: typeof h.GAIN === 'number' ? h.GAIN : 0 };
    headers.set(rel, v);
    return v;
  }

  async function scan(force = false): Promise<{ infos: SessionInfo[]; other: string[] }> {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
    const top = await files.list(ROOT);
    const infos: SessionInfo[] = [];
    const other: string[] = [];
    for (const dir of top.filter((e) => e.isDir)) {
      if (!dir.name.endsWith('_sub')) {
        if (!top.some((e) => e.name === `${dir.name}_sub`)) other.push(dir.name);
        continue;
      }
      const subDir = `${ROOT}/${dir.name}`;
      const groups = new Map<string, { target: string; exp: string; filter: string; night: string; subs: SeestarEntry[]; first: string }>();
      for (const f of await files.list(subDir)) {
        const l = !f.isDir && parseLight(f.name);
        if (!l) continue;
        const night = nightOf(l.stamp);
        const key = sessionKey(l.target, l.exp, l.filter, night);
        const g = groups.get(key) ?? { target: l.target, exp: l.exp, filter: l.filter, night, subs: [], first: l.stamp };
        g.subs.push(f);
        if (l.stamp < g.first) g.first = l.stamp;
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        const firstSub = g.subs.find((f) => parseLight(f.name)?.stamp === g.first)!;
        const h = await headerOf(`${subDir}/${firstSub.name}`);
        const cam = h.wide ? 'WIDE' : 'TELE';
        const folder = `SEESTAR_RAW_${cam}_${g.target}_EXP_${Number(g.exp)}_GAIN_${h.gain}_${g.first}_${g.filter}`;
        const startedAt = `${g.first.slice(0, 10)}T${g.first.slice(11).replace(/-/g, ':')}`;
        infos.push({
          session: {
            folder,
            path: folder,
            camera: h.wide ? 'wide' : 'tele',
            target: g.target,
            exposureS: Number(g.exp),
            gain: h.gain,
            startedAt,
            fitsCount: g.subs.length,
            sizeMB: Math.round(g.subs.reduce((a, f) => a + f.size, 0) / 1e6),
            transferred: isTransferredFolder(folder),
          },
          subDir,
          subs: g.subs.sort((a, b) => a.name.localeCompare(b.name)),
          stackDir: `${ROOT}/${dir.name.slice(0, -'_sub'.length)}`,
          filter: g.filter,
          night: g.night,
        });
      }
    }
    infos.sort((a, b) => (b.session.startedAt ?? '').localeCompare(a.session.startedAt ?? ''));
    cache = { at: Date.now(), infos, other };
    return cache;
  }

  async function find(folder: string): Promise<SessionInfo> {
    for (const force of [false, true]) {
      const hit = (await scan(force)).infos.find((i) => i.session.folder === folder);
      if (hit) return hit;
    }
    throw new Error(`no session ${folder} on the Seestar`);
  }

  async function stacksOf(info: SessionInfo): Promise<SeestarEntry[]> {
    const listed = await files.list(info.stackDir).catch(() => [] as SeestarEntry[]);
    return listed.filter((f) => {
      const st = !f.isDir && parseStack(f.name);
      return !!st && st.target === info.session.target && Number(st.exp) === info.session.exposureS && st.filter === info.filter && nightOf(st.stamp) === info.night;
    });
  }

  async function darksFor(expS: number): Promise<Array<SeestarEntry & { rel: string }>> {
    const dirs = await files.list(DARKS).catch(() => [] as SeestarEntry[]);
    const dir = dirs.find((d) => d.isDir && parseFloat(d.name) === expS);
    if (!dir) return [];
    return (await files.list(`${DARKS}/${dir.name}`)).filter((f) => !f.isDir && /\.fits?$/i.test(f.name)).map((f) => ({ ...f, rel: `${DARKS}/${dir.name}/${f.name}` }));
  }

  async function copyAll(plan: Array<{ remote: string; local: string; size: number }>, onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<DownloadResult> {
    const out: DownloadResult = { files: 0, bytes: 0, skipped: 0, failed: [] };
    const bytesTotal = plan.reduce((a, p) => a + p.size, 0);
    let bytesDone = 0;
    let lastReport = 0;
    for (const [i, item] of plan.entries()) {
      const base = bytesDone;
      try {
        const r = await files.download(
          item.remote,
          item.local,
          (n) => {
            if (Date.now() - lastReport < 500) return;
            lastReport = Date.now();
            onProgress({ file: item.remote, filesDone: i, filesTotal: plan.length, bytesDone: base + n, bytesTotal });
          },
          signal,
        );
        if (r.outcome === 'skipped') out.skipped++;
        else out.files++;
        out.bytes += r.size;
      } catch (err) {
        if (err instanceof TransferCancelled) throw err;
        out.failed.push({ remote: item.remote, error: errMsg(err) });
      }
      bytesDone = base + item.size;
      onProgress({ file: item.remote, filesDone: i + 1, filesTotal: plan.length, bytesDone, bytesTotal });
    }
    return out;
  }

  const storagePath = (devicePath: string): string => {
    if (!devicePath.startsWith(ALBUM_PREFIX)) throw new Error(`not a Seestar path: ${devicePath}`);
    const rel = devicePath.slice(ALBUM_PREFIX.length);
    if (!rel || /[\\\0]/.test(rel) || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error(`bad Seestar path ${devicePath}`);
    return rel;
  };

  async function albumItems(): Promise<MediaItem[]> {
    if (albumCache && Date.now() - albumCache.at < CACHE_MS) return albumCache.items;
    const tz = config.observer.timezone;
    const { infos } = await scan();
    const sessionOf = (st: StackFile) => infos.find((i) => i.session.target === st.target && i.session.exposureS === Number(st.exp) && i.filter === st.filter && i.night === nightOf(st.stamp))?.session.folder;
    const items: MediaItem[] = [];
    for (const dir of (await files.list(ROOT)).filter((e) => e.isDir && !e.name.endsWith('_sub'))) {
      const listed = await files.list(`${ROOT}/${dir.name}`);
      const names = new Set(listed.map((f) => f.name));
      for (const f of listed) {
        if (f.isDir || /_thn\.jpg$/i.test(f.name)) continue;
        const rel = `${ROOT}/${dir.name}/${f.name}`;
        const base = f.name.replace(/\.[^.]+$/, '');
        const thumb = `${ALBUM_PREFIX}${ROOT}/${dir.name}/${base}_thn.jpg`;
        const at = f.date ? zonedEpochS(f.date, tz) : 0;
        const st = parseStack(f.name);
        if (st) {
          if (/\.fits?$/i.test(f.name) && names.has(`${base}.jpg`)) continue;
          items.push({
            fileName: f.name,
            filePath: `${ALBUM_PREFIX}${rel}`,
            fileSize: f.size,
            mediaType: MEDIA.astro,
            modificationTime: at,
            thumbnailPath: thumb,
            astroTargetName: st.target,
            astroImageDetails: { srcDir: sessionOf(st), shotsStacked: st.frames, totalExp: st.frames * Number(st.exp), params: { exp: Number(st.exp), filter: st.filter } },
          });
          continue;
        }
        const video = /\.(mp4|avi|mov)$/i.test(f.name);
        if (!video && !/\.(jpe?g|png|tiff?|fits?)$/i.test(f.name)) continue;
        items.push({ fileName: f.name, filePath: `${ALBUM_PREFIX}${rel}`, fileSize: f.size, mediaType: video ? MEDIA.video : MEDIA.photo, modificationTime: at, thumbnailPath: video ? thumb : undefined });
      }
    }
    items.sort((a, b) => b.modificationTime - a.modificationTime);
    albumCache = { at: Date.now(), items };
    return items;
  }

  const forget = () => {
    cache = null;
    albumCache = null;
  };

  return {
    label: 'ZWO Seestar',
    async sessionSubs(folder) {
      const info = await find(folder);
      return info.subs.map((f) => `${info.subDir}/${f.name}`);
    },
    async listSessions(withCounts) {
      const { infos, other } = await scan(true);
      const sessions = infos.map((i) => {
        const s = { ...i.session, transferred: isTransferredFolder(i.session.folder) };
        if (!withCounts) {
          delete s.fitsCount;
          delete s.sizeMB;
        }
        return s;
      });
      return { sessions, otherFolders: other };
    },
    async resolveSession(folderOrLatest) {
      if (folderOrLatest === 'latest') {
        const first = (await scan(true)).infos[0];
        if (!first) throw new Error('no astronomy sessions on the Seestar');
        return bare(first.session);
      }
      const folder = folderOrLatest.replace(/\/+$/, '').replace(/^.*\/(?=SEESTAR_RAW_)/, '');
      if (!folder.startsWith('SEESTAR_RAW_')) throw new Error(`not a Seestar session: ${folderOrLatest}`);
      return bare((await find(folder)).session);
    },
    async copySession(s, o, onProgress, signal) {
      const info = await find(s.folder);
      const dest = path.join(config.paths.library, s.folder);
      const plan: Array<{ remote: string; local: string; size: number }> = [];
      if (o.includeSubframes) for (const f of info.subs) plan.push({ remote: `${info.subDir}/${f.name}`, local: path.join(dest, f.name), size: f.size });
      for (const f of await stacksOf(info)) plan.push({ remote: `${info.stackDir}/${f.name}`, local: path.join(dest, f.name), size: f.size });
      let calibrationDir: string | null = null;
      if (o.includeCalibration) {
        const cam = calibrationCamera(s.folder);
        calibrationDir = path.join(config.paths.library, 'CALI_FRAME');
        for (const d of await darksFor(s.exposureS ?? 0)) plan.push({ remote: d.rel, local: path.join(calibrationDir, 'dark', cam, d.name), size: d.size });
      }
      const res = await copyAll(plan, onProgress, signal);
      return { ...res, calibrationDir };
    },
    isSessionLight: (_s, remote) => remote.includes('_sub/') && !!parseLight(path.posix.basename(remote)),
    async deleteSession(s) {
      const info = await find(s.folder);
      const doomed = [...info.subs.map((f) => `${info.subDir}/${f.name}`), ...(await stacksOf(info)).map((f) => `${info.stackDir}/${f.name}`)];
      const withThumbs = doomed.flatMap((p) => [p, p.replace(/\.[^.]+$/, '_thn.jpg')]);
      let failed = 0;
      for (const p of withThumbs) {
        const r = await files.delete(p).catch(() => false);
        if (!r && !p.endsWith('_thn.jpg')) failed++;
      }
      forget();
      return failed ? { deleted: false, note: `${failed} of ${doomed.length} files could not be deleted` } : { deleted: true };
    },
    async downloadOne(devicePath, localFile, signal) {
      await files.download(storagePath(devicePath), localFile, () => undefined, signal);
    },
    albumLocalPath(devicePath, _day) {
      const rel = storagePath(devicePath);
      const root = path.resolve(config.paths.library);
      const local = path.resolve(root, ...rel.split('/'));
      const inside = path.relative(root, local);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`bad device path ${devicePath}`);
      return local;
    },
    album: {
      async counts() {
        const items = await albumItems();
        const by = new Map<number, number>();
        for (const i of items) by.set(i.mediaType, (by.get(i.mediaType) ?? 0) + 1);
        return [{ mediaType: 0, count: items.length }, ...[...by].map(([mediaType, count]) => ({ mediaType, count }))];
      },
      async list(type, page, size) {
        const items = (await albumItems()).filter((i) => !type || i.mediaType === type);
        return items.slice(page * size, page * size + size);
      },
      isDevicePath: (p) => {
        try {
          storagePath(p);
          return true;
        } catch {
          return false;
        }
      },
      fetch: (p, maxBytes) => files.readAll(storagePath(p), maxBytes),
      async delete(items) {
        const out = [];
        for (const it of items) {
          try {
            const rel = storagePath(it.filePath);
            const st = parseStack(path.posix.basename(rel));
            const base = rel.replace(/\.[^.]+$/, '');
            const all = st ? [`${base}.fit`, `${base}.jpg`, `${base}_thn.jpg`] : [rel, `${base}_thn.jpg`];
            const ok = await files.delete(rel);
            for (const p of all) if (p !== rel) await files.delete(p).catch(() => false);
            out.push({ filePath: it.filePath, deleted: ok, ...(ok ? {} : { note: 'the Seestar did not delete it' }) });
          } catch (err) {
            out.push({ filePath: it.filePath, deleted: false, note: errMsg(err) });
          }
        }
        forget();
        return out;
      },
    },
  };
}
