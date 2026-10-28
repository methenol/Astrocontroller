/**
 * The Dwarf 3's storage for the library: its SD card over FTP (sessions under /Astronomy, the
 * calibration masters under /Astronomy/CALI_FRAME) and its album HTTP API.
 */
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { downloadFiles, downloadOne, withLister, type FtpEntry } from './ftp.js';
import type { DeviceLibrary } from '../../library/device-library.js';
import { isTransferredFolder, parseSessionFolder, type DeviceSession, type DeviceSessionEntry } from '../../library/sessions.js';

const log = logger('library');

const CALIBRATION_KINDS = ['dark', 'flat', 'bias'] as const;
const isFits = (name: string) => name.toLowerCase().endsWith('.fits');
/** stacked-16_*.fits is the scope's own stack; failed_*.fits (kept) are subs its stacker rejected. */
const isSub = (e: Pick<FtpEntry, 'name'>) => isFits(e.name) && !e.name.startsWith('stacked');
const newestFirst = (a: DeviceSession, b: DeviceSession) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
const album = () => import('./http.js');

async function listSessions(withCounts: boolean): Promise<{ sessions: DeviceSessionEntry[]; otherFolders: string[] }> {
  return withLister(async (list) => {
    const dirs = (await list('/Astronomy')).filter((e) => e.isDir);
    const sessions: DeviceSessionEntry[] = [];
    const otherFolders: string[] = [];
    for (const d of dirs) {
      const s = parseSessionFolder(d.name);
      if (!s) {
        otherFolders.push(d.name);
        continue;
      }
      const entry: DeviceSessionEntry = { ...s, transferred: isTransferredFolder(s.folder) };
      if (withCounts) {
        const files = await list(s.path).catch((err) => {
          log.debug(`could not list ${s.path}: ${errMsg(err)}`);
          return [] as FtpEntry[];
        });
        entry.fitsCount = files.filter((f) => isFits(f.name)).length;
        entry.sizeMB = Math.round(files.reduce((a, f) => a + f.size, 0) / 1e6);
      }
      sessions.push(entry);
    }
    sessions.sort(newestFirst);
    return { sessions, otherFolders };
  });
}

/**
 * Where an album file lands: Astronomy/… mirrors the card, anything else goes to _photos/<day>.
 * Throws for a path that would leave the library.
 */
function albumLocalPath(devicePath: string, day: string): string {
  const rel = devicePath.replace(/\\/g, '/').replace(/^\/?DWARF3\//, '').replace(/^\/+/, '');
  const parts = rel.split('/');
  if (!rel || parts.some((p) => p === '..' || p === '.' || p === '')) throw new Error(`bad device path ${devicePath}`);
  const root = path.resolve(config.paths.library);
  const local = parts[0] === 'Astronomy' ? path.resolve(root, ...parts) : path.resolve(root, '_photos', day, parts[parts.length - 1]);
  const inside = path.relative(root, local);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`bad device path ${devicePath}`);
  return local;
}

export const dwarfLibrary: DeviceLibrary = {
  label: 'DWARFLAB Dwarf 3',
  listSessions,
  async resolveSession(folderOrLatest) {
    if (folderOrLatest === 'latest') {
      const { sessions } = await listSessions(false);
      if (!sessions[0]) throw new Error('no astronomy sessions on the telescope');
      return sessions[0];
    }
    const folder = folderOrLatest.replace(/\/+$/, '').replace(/^.*\/(?=DWARF_RAW_)/, '');
    const s = parseSessionFolder(folder);
    if (!s || !s.folder.startsWith('DWARF_RAW_')) throw new Error(`not a DWARF session folder: ${folderOrLatest}`);
    return s;
  },
  async copySession(s, o, onProgress, signal) {
    const dest = path.join(config.paths.library, s.folder);
    const plan: Array<{ remoteDir: string; localDir: string; filter?: (e: FtpEntry) => boolean; optional?: boolean }> = [
      { remoteDir: s.path, localDir: dest, filter: (e) => o.includeSubframes || !isSub(e) },
    ];
    if (o.includeCalibration) {
      const cam = s.camera === 'wide' ? 'cam_1' : 'cam_0';
      for (const kind of CALIBRATION_KINDS) {
        // a camera without masters of one kind is normal
        plan.push({ remoteDir: `/Astronomy/CALI_FRAME/${kind}/${cam}`, localDir: path.join(config.paths.library, 'CALI_FRAME', kind, cam), optional: true });
      }
    }
    const res = await downloadFiles(plan, onProgress, signal);
    return { ...res, calibrationDir: o.includeCalibration ? path.join(config.paths.library, 'CALI_FRAME') : null };
  },
  isSessionLight: (s, remote) => remote.startsWith(`${s.path}/`) && isSub({ name: path.posix.basename(remote) }),
  async deleteSession(s) {
    const [r] = await (await album()).deleteMedia([{ filePath: `/DWARF3${s.path}`, mediaType: 4 }]);
    return { deleted: r.deleted, ...(r.note ? { note: r.note } : {}) };
  },
  downloadOne,
  albumLocalPath,
  album: {
    counts: async () => (await album()).getMediaCounts(),
    list: async (type, page, size) => (await album()).listMedia(type, page, size),
    isDevicePath: (p) => p.startsWith('/DWARF3/') && !p.split('/').some((s) => s === '..' || s === '.'),
    fetch: async (p, maxBytes) => {
      const h = await album();
      return h.fetchFile(p, h.FILE_TIMEOUT_MS, maxBytes);
    },
    delete: async (items) => (await album()).deleteMedia(items),
  },
};
