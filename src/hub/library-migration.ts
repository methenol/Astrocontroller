/**
 * The migrated single-telescope setup kept the library root itself as its library, while every
 * other profile has its own folder in it, named after the profile (<library>/<slug of its name>).
 * This moves that profile's sessions, calibration masters and photos into such a folder too, once, at the hub's start
 * (before any profile's process runs), and repoints the absolute paths its transfer and processing
 * records hold. Other profiles' folders stay where they are.
 *
 * Every move is a rename inside the one library volume: instant, nothing is copied. If one fails,
 * the ones done are put back and the profile keeps the root, so its library is never split.
 */
import fs from 'node:fs';
import path from 'node:path';
import { profileDataDir, slugFor, type HubPaths, type Profile } from './profiles.js';

/** The records that store absolute library paths (transfer destinations, processing outputs). */
const RECORDS = ['jobs.json', 'processing.json'];

export interface LibraryMove {
  from: string;
  to: string;
  moved: number;
  /** entries left at the root: a name the profile's folder already had */
  skipped: string[];
  records: string[];
}

/** Whether a profile still uses the shared library root as its own library. */
export const usesLibraryRoot = (p: Profile, paths: HubPaths): boolean => !!p.libraryDir && path.resolve(p.libraryDir) === path.resolve(paths.library);

/** Rewrite every string that is a path under `from` to the same path under `to`. */
function repoint(v: unknown, from: string, to: string): unknown {
  if (typeof v === 'string') return v === from ? to : v.startsWith(from + path.sep) ? to + v.slice(from.length) : v;
  if (Array.isArray(v)) return v.map((x) => repoint(x, from, to));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, repoint(x, from, to)]));
  return v;
}

/**
 * Move a profile's library from the shared root into <root>/<slug of its name> ("Dwarf 3" →
 * dwarf-3). `others` are the folder names of every other profile's library at the root: theirs,
 * not moved, and not taken for this one. Returns what was done (`to` is the profile's library
 * folder from now on), or null when the profile does not use the root.
 */
export function moveOffLibraryRoot(p: Profile, paths: HubPaths, others: readonly string[]): LibraryMove | null {
  if (!usesLibraryRoot(p, paths)) return null;
  const root = path.resolve(paths.library);
  const folder = slugFor(p.name, new Set(others));
  const dest = path.join(root, folder);
  const keep = new Set([folder, ...others]);
  fs.mkdirSync(dest, { recursive: true });
  const done: string[] = [];
  const skipped: string[] = [];
  try {
    for (const name of fs.readdirSync(root)) {
      if (keep.has(name)) continue;
      if (fs.existsSync(path.join(dest, name))) {
        skipped.push(name);
        continue;
      }
      fs.renameSync(path.join(root, name), path.join(dest, name));
      done.push(name);
    }
  } catch (e) {
    for (const name of done.reverse()) {
      try {
        fs.renameSync(path.join(dest, name), path.join(root, name));
      } catch {
        /* reported below: the error names the move that failed */
      }
    }
    throw e;
  }
  const records: string[] = [];
  const data = profileDataDir(p, paths);
  for (const f of RECORDS) {
    const file = path.join(data, f);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const next = JSON.stringify(repoint(JSON.parse(text), root, dest));
    if (next !== JSON.stringify(JSON.parse(text))) {
      fs.copyFileSync(file, `${file}.bak-library-move`);
      fs.writeFileSync(file, next);
      records.push(file);
    }
  }
  return { from: root, to: dest, moved: done.length, skipped, records };
}
