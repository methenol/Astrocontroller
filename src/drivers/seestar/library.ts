/**
 * The Seestar's storage for the library (device-library.ts), from its file listing and HTTP server
 * (files.ts).
 *
 * The scope keeps a target's subs in one folder however many nights it was shot
 * (MyWorks/<target>_sub/Light_<target>_<exp>s_<filter>_<YYYYMMDD-HHMMSS>.fit, the scope's local
 * time) and its stacks beside it (MyWorks/<target>/Stacked_<n>_<target>_<exp>s_<filter>_<ts>.fit
 * with a .jpg and a _thn.jpg). A session here is one target, camera, sub length and filter over one
 * night (noon to noon), named like the Dwarf's so the library, pooling and processing take it as
 * it is:
 *
 *   SEESTAR_RAW_TELE_M 31_EXP_60_GAIN_200_2026-10-27-21-53-45_IRCUT
 *
 * Its library folder gets the night's subs and stacks; the dark master of its sub length
 * (darklibrary/<exp>s/MasterDark_….fit) goes to CALI_FRAME/dark/seestar_<cam_0|cam_1>, apart from
 * the Dwarf's masters when the two share a library.
 *
 * Album paths are /SEESTAR/<storage path>.
 */
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import type { DeviceLibrary, DownloadProgress, DownloadResult, MediaItem } from '../../library/device-library.js';
import { isTransferredFolder, type DeviceSessionEntry } from '../../library/sessions.js';
import { calibrationCamera } from '../../processing/queue.js';
import { SeestarFiles, TransferCancelled, type SeestarEntry } from './files.js';

const log = logger('library');

const ROOT = 'MyWorks';
const DARKS = 'darklibrary';
const ALBUM_PREFIX = '/SEESTAR/';
/** sessions and the album are listed again after this long */
const CACHE_MS = 30_000;
const NIGHT_SHIFT_MS = 12 * 3600_000;

const LIGHT = /^Light_(.+)_([\d.]+)s_([A-Za-z0-9-]+)_(\d{8})-(\d{6})\.fits?$/i;
const STACK = /^Stacked_(\d+)_(.+)_([\d.]+)s_([A-Za-z0-9-]+)_(\d{8})-(\d{6})\.(fits?|jpg)$/i;
const MEDIA = { photo: 1, video: 2, astro: 4 } as const;

interface SessionInfo {
  session: DeviceSessionEntry;
  /** the storage folder of its subs, and the subs */
  subDir: string;
  subs: SeestarEntry[];
  stackDir: string;
  filter: string;
  night: string;
}

interface StackFile {
  name: string;
  dir: string;
  target: string;
  frames: number;
  exp: string;
  filter: string;
  stamp: string;
}

/** "20261027", "215345" → "2026-10-27-21-53-45" */
const stampOf = (d: string, t: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}-${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}`;

/** The observing night a local "YYYY-MM-DD-hh-mm-ss" belongs to: the date of the evening it started. */
export function nightOf(stamp: string): string {
  const [y, mo, d, h, mi, s] = stamp.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - NIGHT_SHIFT_MS).toISOString().slice(0, 10);
}

/** A wall-clock time in a time zone ("2026-10-28 05:53:46") as epoch seconds. */
export function zonedEpochS(local: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T-](\d{2})[:-](\d{2})[:-](\d{2})/.exec(local);
  if (!m) return 0;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // the zone's offset at that moment, read back through Intl
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const seen = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - (seen - asUtc)) / 1000);
}

export function parseLight(name: string): { target: string; exp: string; filter: string; stamp: string } | null {
  const m = LIGHT.exec(name);
  return m ? { target: m[1], exp: m[2], filter: m[3], stamp: stampOf(m[4], m[5]) } : null;
}

export function parseStack(name: string): Omit<StackFile, 'name' | 'dir'> | null {
  const m = STACK.exec(name);
  return m ? { frames: Number(m[1]), target: m[2], exp: m[3], filter: m[4], stamp: stampOf(m[5], m[6]) } : null;
}

/** A session without the listing's counts and state (what the library records in session.json). */
const bare = ({ fitsCount: _f, sizeMB: _m, transferred: _t, ...s }: DeviceSessionEntry) => s;

const sessionKey = (target: string, exp: string, filter: string, night: string) => `${target}|${Number(exp)}|${filter}|${night}`;

/** The Seestar's storage: the library's view of it, and what only the Seestar's tools ask. */
export type SeestarStorage = DeviceLibrary & {
  /** a session's subs as storage paths, in time order */
  sessionSubs(folder: string): Promise<string[]>;
};

export function seestarLibrary(files: SeestarFiles): SeestarStorage {
  let cache: { at: number; infos: SessionInfo[]; other: string[] } | null = null;
  let albumCache: { at: number; items: MediaItem[] } | null = null;
  /** first-sub headers already read: name → camera and gain */
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

  /** The stacks of the session's target, sub length, filter and night. */
  async function stacksOf(info: SessionInfo): Promise<SeestarEntry[]> {
    const listed = await files.list(info.stackDir).catch(() => [] as SeestarEntry[]);
    return listed.filter((f) => {
      const st = !f.isDir && parseStack(f.name);
      return !!st && st.target === info.session.target && Number(st.exp) === info.session.exposureS && st.filter === info.filter && nightOf(st.stamp) === info.night;
    });
  }

  /** The dark master(s) for a sub length. */
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
    // nothing that leaves the storage: no empty, "." or ".." segment, no backslash or NUL
    if (!rel || /[\\\0]/.test(rel) || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error(`bad Seestar path ${devicePath}`);
    return rel;
  };

  async function albumItems(): Promise<MediaItem[]> {
    if (albumCache && Date.now() - albumCache.at < CACHE_MS) return albumCache.items;
    const tz = config.observer.timezone;
    const { infos } = await scan();
    const sessionOf = (st: Omit<StackFile, 'name' | 'dir'>) =>
      infos.find((i) => i.session.target === st.target && i.session.exposureS === Number(st.exp) && i.filter === st.filter && i.night === nightOf(st.stamp))?.session.folder;
    const items: MediaItem[] = [];
    for (const dir of (await files.list(ROOT)).filter((e) => e.isDir && !e.name.endsWith('_sub'))) {
      const listed = await files.list(`${ROOT}/${dir.name}`);
      const names = new Set(listed.map((f) => f.name));
      for (const f of listed) {
        if (f.isDir || /_thn\.jpg$/i.test(f.name)) continue;
        const rel = `${ROOT}/${dir.name}/${f.name}`;
        const base = f.name.replace(/\.[^.]+$/, '');
        // the listing leaves the thumbnails out, but stacks and videos have one each
        const thumb = `${ALBUM_PREFIX}${ROOT}/${dir.name}/${base}_thn.jpg`;
        const at = f.date ? zonedEpochS(f.date, tz) : 0;
        const st = parseStack(f.name);
        if (st) {
          // one tile per stack: its JPEG when there is one, else the FITS
          if (st && /\.fits?$/i.test(f.name) && names.has(`${base}.jpg`)) continue;
          const session = sessionOf(st);
          items.push({
            fileName: f.name,
            filePath: `${ALBUM_PREFIX}${rel}`,
            fileSize: f.size,
            mediaType: MEDIA.astro,
            modificationTime: at,
            thumbnailPath: thumb,
            astroTargetName: st.target,
            astroImageDetails: { srcDir: session, shotsStacked: st.frames, totalExp: st.frames * Number(st.exp), params: { exp: Number(st.exp), filter: st.filter } },
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
      // sizes are the listing's (rounded to the KiB) for the progress bar; each file is checked against HTTP's exact one
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
      // each frame and stack goes with its thumbnail
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
      // MyWorks/… mirrors the scope's storage under the library
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
            // a stack goes with its other renderings (.fit / .jpg) and thumbnail; its subs stay (delete the session for those)
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
