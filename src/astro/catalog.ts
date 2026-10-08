/**
 * The object database: catalog/objects.tsv, built by `npm run catalog` (src/tools/build-catalog.ts)
 * from OpenNGC (CC-BY-SA 4.0, github.com/mattiaverga/OpenNGC) and the VizieR catalogs listed in
 * catalog/sources.json: Sharpless, LBN, LDN, Barnard, vdB, Cederblad, RCW, Strasbourg-ESO PNe,
 * Green SNRs, Dias open clusters, Harris globulars, RC3 galaxies, Arp, Hickson, Abell clusters,
 * the Bright Star Catalogue and the IAU star names.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import { normalizeName, isDesignation, TYPE_NAMES, TYPE_GROUPS } from './designations.js';

export { normalizeName, TYPE_NAMES, TYPE_GROUPS };

const log = logger('catalog');

export interface DsoObject {
  id: string; // "NGC 224"
  aliases: string[]; // ["M 31", "Andromeda Galaxy", "UGC 454", ...]: Messier and Caldwell first, then common names, then other designations
  type: string;
  typeName: string;
  raHours: number;
  decDeg: number;
  constellation: string;
  majorArcmin?: number;
  minorArcmin?: number;
  posAngle?: number;
  mag?: number;
  surfaceBrightness?: number;
  /** brightness class for objects without a magnitude (Sharpless, Lynds, RCW…): 1 bright, 2 moderate, 3 faint; dark nebulae: 1 = most opaque */
  brightClass?: number;
  /** common names ("Andromeda Galaxy") */
  names: string[];
  /** source catalogs (keys of catalog/sources.json) */
  sources: string[];
}

export interface SourceInfo {
  key: string;
  title: string;
  cite: string;
  records: number;
  added: number;
  merged: number;
}

let objects: DsoObject[] | null = null;
let sourceInfo: { built?: string; sources: SourceInfo[] } = { sources: [] };
const index = new Map<string, DsoObject>();
/** normalised keys of each object, for substring search */
const keysOf = new WeakMap<DsoObject, string[]>();

function loadObjects(file: string): DsoObject[] {
  const out: DsoObject[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    const n = (s: string) => (s === '' ? undefined : Number(s));
    // proper names before Bayer-style ones that some catalogs list as common names ("Sadr" before "gam Cyg")
    const names = f[11] ? f[11].split('|').sort((x, y) => Number(isDesignation(x)) - Number(isDesignation(y))) : [];
    const ids = f[12] ? f[12].split('|') : [];
    const lead = ids.filter((a) => /^[MC] \d+$/.test(a));
    out.push({
      id: f[0],
      aliases: [...lead, ...names, ...ids.filter((a) => !lead.includes(a))],
      type: f[1],
      typeName: TYPE_NAMES[f[1]] ?? f[1],
      raHours: Number(f[2]),
      decDeg: Number(f[3]),
      constellation: f[4],
      majorArcmin: n(f[5]),
      minorArcmin: n(f[6]),
      posAngle: n(f[7]),
      mag: n(f[8]),
      surfaceBrightness: n(f[9]),
      brightClass: n(f[10]),
      names,
      sources: f[13] ? f[13].split(',') : [],
    });
  }
  return out;
}

export function catalog(): DsoObject[] {
  if (objects) return objects;
  const file = path.join(config.paths.catalog, 'objects.tsv');
  const list = fs.existsSync(file) ? loadObjects(file) : [];
  try {
    sourceInfo = JSON.parse(fs.readFileSync(path.join(config.paths.catalog, 'sources.json'), 'utf8'));
  } catch {
    /* optional */
  }
  for (const o of list) {
    const keys = [o.id, ...o.aliases].map(normalizeName);
    keysOf.set(o, keys);
    for (const key of keys) if (key && !index.has(key)) index.set(key, o);
  }
  // Popular nicknames the catalogs don't carry (user-editable).
  const nickFile = path.join(config.paths.catalog, 'nicknames.csv');
  if (fs.existsSync(nickFile)) {
    for (const line of fs.readFileSync(nickFile, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const [nick, id] = line.split(';').map((s) => s.trim());
      const target = id ? index.get(normalizeName(id)) : undefined;
      if (!target) continue;
      if (!target.aliases.includes(nick)) {
        target.aliases.push(nick);
        target.names.push(nick);
        keysOf.get(target)!.push(normalizeName(nick));
      }
      const key = normalizeName(nick);
      if (!index.has(key)) index.set(key, target);
    }
  }
  objects = list;
  if (list.length === 0) log.warn(`no object database at ${file} — run "npm run catalog"`);
  else log.info(`loaded ${list.length} objects from ${sourceInfo.sources.length || '?'} catalogs`);
  return list;
}

export function catalogSources() {
  catalog();
  return sourceInfo;
}

export function findObject(name: string): DsoObject | null {
  catalog();
  const key = normalizeName(name);
  const hit = index.get(key);
  if (hit) return hit;
  // Fuzzy: substring match on common names.
  const q = key.replace(/ nebula| galaxy| cluster/g, '').trim();
  if (q.length < 3) return null;
  return objects!.find((o) => o.names.some((a) => normalizeName(a).includes(q))) ?? null;
}

/** How well a query matches an object: 0 exact designation/name, 1 prefix, 2 substring; null = no match. */
export function matchRank(o: DsoObject, q: string): number | null {
  let best: number | null = null;
  for (const k of keysOf.get(o) ?? []) {
    if (k === q) return 0;
    if (k.startsWith(q)) best = 1;
    else if (best === null && k.includes(q)) best = 2;
  }
  return best;
}

export function searchObjects(query: string, limit = 10): DsoObject[] {
  catalog();
  const q = normalizeName(query);
  if (!q) return [];
  const exact = findObject(query);
  const ranked: [DsoObject, number][] = [];
  for (const o of objects!) {
    if (o === exact) continue;
    const r = matchRank(o, q);
    if (r !== null) ranked.push([o, r]);
  }
  ranked.sort((a, b) => a[1] - b[1] || prominence(b[0]) - prominence(a[0]));
  return [...(exact ? [exact] : []), ...ranked.slice(0, limit - (exact ? 1 : 0)).map(([o]) => o)];
}

/** Rough "how likely is this the one you meant": Messier/Caldwell, named, bright, big. */
const prominenceOf = new WeakMap<DsoObject, number>();
export function prominence(o: DsoObject): number {
  let p = prominenceOf.get(o);
  if (p === undefined) prominenceOf.set(o, (p = computeProminence(o)));
  return p;
}

function computeProminence(o: DsoObject): number {
  let p = 0;
  if (o.aliases.some((a) => /^M \d+$/.test(a))) p += 40;
  else if (o.aliases.some((a) => /^C \d+$/.test(a))) p += 30;
  if (o.names.length) p += 15;
  if (o.mag !== undefined) p += Math.max(0, 15 - o.mag);
  else if (o.brightClass) p += 8 - 2 * o.brightClass;
  if (o.majorArcmin) p += Math.min(10, Math.log2(1 + o.majorArcmin) * 2);
  return p;
}

/** The name people (and the DWARF app) use: Messier, then Caldwell, then a common name, then the id. */
export function displayName(o: DsoObject): string {
  return o.aliases.find((a) => /^M \d+$/.test(a)) ?? o.aliases.find((a) => /^C \d+$/.test(a)) ?? o.names[0] ?? o.id;
}

/**
 * The label for GoTo, which the scope uses to name the session folder: the DWARF app's choice
 * (Messier, then Caldwell, then the catalog id: its sessions are "C 20", "C 33", "NGC 281") so that
 * nights captured with the app and with us carry the same target name and stack together.
 */
export function gotoLabel(o: DsoObject): string {
  if ((o.type === '*' || o.type === '**') && o.names[0]) return o.names[0]; // "Vega", not "HR 7001"
  return o.aliases.find((a) => /^M \d+$/.test(a)) ?? o.aliases.find((a) => /^C \d+$/.test(a)) ?? (isDesignation(o.id) ? o.id : o.aliases.find(isDesignation) ?? o.id);
}

export function describe(o: DsoObject): string {
  const names = [o.id, ...o.aliases].slice(0, 4).join(' / ');
  const size = o.majorArcmin ? `${o.majorArcmin}'${o.minorArcmin ? `×${o.minorArcmin}'` : ''}` : 'size n/a';
  return `${names} — ${o.typeName} in ${o.constellation}, ${size}, mag ${o.mag ?? 'n/a'}`;
}
