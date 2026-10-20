/** The album: media counts and listings, and deleting items. */
import { call } from './client.js';

export const MEDIA_TYPES: Readonly<Record<number, string>> = Object.freeze({
  0: 'all',
  1: 'photo',
  2: 'video',
  3: 'burst',
  4: 'astro',
  5: 'panorama',
});

const ASTRO_MEDIA = 4;
const PHOTO_MEDIA = 1;

export interface MediaItem {
  fileName: string;
  filePath: string;
  fileSize: number;
  mediaType: number;
  modificationTime: number;
  thumbnailPath?: string;
  camId?: number;
  astroTargetName?: string;
  astroSubType?: number;
  subType?: number;
  astroImageDetails?: { srcDir?: string; shotsStacked?: number; shotsTaken?: number; totalExp?: number; params?: Record<string, unknown>; [k: string]: unknown };
  exifInfo?: Record<string, unknown>;
  [k: string]: unknown;
}

export const getMediaCounts = (): Promise<Array<{ mediaType: number; count: number }>> => call('POST', '/album/list/mediaCounts');

export const listMedia = (mediaType: number, pageIndex = 0, pageSize = 20): Promise<MediaItem[]> =>
  call<MediaItem[]>('POST', '/album/list/mediaInfos', { mediaType, pageIndex, pageSize });

export interface DeleteOutcome {
  filePath: string;
  deleted: boolean;
  /** why it was not deleted, or what was assumed */
  note?: string;
}

interface DeleteEntry {
  mediaType: number;
  filePath: string;
  fileName: string;
  subType: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A capture session folder (DWARF_RAW_<camera>_…), or a file directly in one. */
const SESSION_FOLDER = /^DWARF_RAW_(TELE|WIDE)_/;

/**
 * The session folder an astro path names: the folder itself or its stacked image. The device's
 * lookup by path does not find the sessions' album entries (2026-10-13: every DWARF_RAW_ session
 * answered null, and a delete sent as a photo removed only stacked.jpg and left the FITS).
 */
export function astroSessionOf(filePath: string): string | undefined {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.at(-1) && SESSION_FOLDER.test(parts.at(-1)!)) return parts.at(-1);
  if (parts.at(-2) && SESSION_FOLDER.test(parts.at(-2)!)) return parts.at(-2);
  return undefined;
}

/** The delete entry for one path: from its album entry where the device has one. */
async function deleteEntry(item: { filePath: string; mediaType?: number }): Promise<{ entry: DeleteEntry; note?: string }> {
  const info = await call<MediaItem | null>('POST', '/album/getMediaInfoByFilePath', { filePath: item.filePath }).catch(() => null);
  const session = astroSessionOf(item.filePath);
  const mediaType = num(info?.mediaType) ?? item.mediaType ?? (session ? ASTRO_MEDIA : PHOTO_MEDIA);
  const parts = item.filePath.split('/').filter(Boolean);
  // an astro session's album entry is named after its folder; any other item after its file
  const fallbackName = (mediaType === ASTRO_MEDIA ? (session ?? parts.at(-2)) : parts.at(-1)) ?? '';
  return {
    entry: {
      mediaType,
      filePath: str(info?.filePath) ?? item.filePath,
      fileName: str(info?.fileName) ?? fallbackName,
      subType: num(info?.astroSubType) ?? num(info?.subType) ?? 0,
    },
    note: info ? undefined : `no album entry found; sent as media type ${mediaType}, name "${fallbackName}"`,
  };
}

/**
 * Delete album items. The body must be `{datas:[{mediaType, filePath, fileName, subType}]}`: a bare
 * array is answered `{data:null}` and deletes nothing (verified 2026-10-11, as in the SDK). Each
 * path's album entry is looked up first so the type, name and astro sub-type are the device's own.
 * The outcome is per path, from the device's answer; a path it does not confirm is not deleted,
 * and when nothing at all was deleted this throws (an empty or null answer is not a success).
 */
export async function deleteMedia(items: Array<{ filePath: string; mediaType?: number }>): Promise<DeleteOutcome[]> {
  if (items.length === 0) return [];
  const prepared: Array<{ entry: DeleteEntry; note?: string }> = [];
  for (const i of items) prepared.push(await deleteEntry(i));
  const datas = prepared.map((p) => p.entry);
  const answer = await call<Array<{ filePath?: unknown; isSuccess?: unknown }> | null>('POST', '/album/delete', { datas });
  const byPath = new Map<string, boolean>();
  for (const r of Array.isArray(answer) ? answer : []) {
    if (r && typeof r.filePath === 'string') byPath.set(r.filePath, r.isSuccess === true);
  }
  const out = items.map((i, k): DeleteOutcome => {
    const ok = byPath.get(datas[k].filePath) ?? byPath.get(i.filePath);
    const note = [ok === undefined ? 'the telescope did not confirm this path' : ok ? '' : 'the telescope refused to delete it', prepared[k].note ?? ''].filter(Boolean).join('; ');
    return { filePath: i.filePath, deleted: ok === true, ...(note ? { note } : {}) };
  });
  if (!out.some((o) => o.deleted)) {
    throw new Error(`nothing was deleted: ${out.map((o) => `${o.filePath} (${o.note})`).join(', ')}. Check the paths against list_album.`);
  }
  return out;
}
