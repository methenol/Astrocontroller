/**
 * The object database: catalog/objects.tsv, built by `npm run catalog` (src/tools/build-catalog.ts)
 * from OpenNGC (CC-BY-SA 4.0, github.com/mattiaverga/OpenNGC) and the VizieR catalogs listed in
 * catalog/sources.json: Sharpless, LBN, LDN, Barnard, vdB, Cederblad, RCW, Strasbourg-ESO and
 * Macquarie/AAO/Strasbourg (MASH) PNe, Green SNRs, Dias open clusters, Harris globulars, RC3 and
 * the Principal Galaxies Catalogue (PGC/LEDA), Arp, Hickson, Abell clusters, the Bright Star
 * Catalogue and the IAU star names.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import { normalizeName, isDesignation, typeName } from './designations.js';

export { normalizeName, typeName, typeGroup, TYPE_NAMES, TYPE_GROUPS } from './designations.js';

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

/** objects.tsv columns, in order. */
const COLUMNS = 14;
const MESSIER = /^M \d+$/;
const CALDWELL = /^C \d+$/;

interface Loaded {
  objects: DsoObject[];
  sources: { built?: string; sources: SourceInfo[] };
  index: Map<string, DsoObject>;
}

let loaded: Loaded | null = null;
/** normalised keys of each object, for substring search */
const keysOf = new WeakMap<DsoObject, string[]>();
/** normalised common names of each object, for the fuzzy fallback of findObject */
const namesOf = new WeakMap<DsoObject, string[]>();

const optNum = (s: string | undefined): number | undefined => {
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** One objects.tsv row, or null when it is not a usable object (no id, or no position). */
export function parseRow(line: string): DsoObject | null {
  const f = line.split('\t');
  if (f.length < COLUMNS - 2 || !f[0]) return null;
  const raHours = Number(f[2]);
  const decDeg = Number(f[3]);
  if (f[2] === '' || f[3] === '' || !Number.isFinite(raHours) || !Number.isFinite(decDeg) || raHours < 0 || raHours >= 24 || Math.abs(decDeg) > 90) return null;
  // proper names before Bayer-style ones that some catalogs list as common names ("Sadr" before "gam Cyg")
  const names = f[11] ? f[11].split('|').filter(Boolean).sort((x, y) => Number(isDesignation(x)) - Number(isDesignation(y))) : [];
  const ids = f[12] ? f[12].split('|').filter(Boolean) : [];
  const lead = ids.filter((a) => MESSIER.test(a) || CALDWELL.test(a));
  return {
    id: f[0],
    aliases: [...lead, ...names, ...ids.filter((a) => !lead.includes(a))],
    type: f[1],
    typeName: typeName(f[1]),
    raHours,
    decDeg,
    constellation: f[4] ?? '',
    majorArcmin: optNum(f[5]),
    minorArcmin: optNum(f[6]),
    posAngle: optNum(f[7]),
    mag: optNum(f[8]),
    surfaceBrightness: optNum(f[9]),
    brightClass: optNum(f[10]),
    names,
    sources: f[13] ? f[13].split(',').filter(Boolean) : [],
  };
}

function loadObjects(file: string): DsoObject[] {
  const out: DsoObject[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const o = parseRow(line);
    if (o) out.push(o);
    else skipped++;
  }
  if (skipped) log.warn(`${skipped} unusable rows in ${file} were skipped (no id or no position)`);
  return out;
}

function loadSources(file: string): Loaded['sources'] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { built?: unknown; sources?: unknown };
    const sources = Array.isArray(j.sources) ? j.sources.filter((x): x is SourceInfo => !!x && typeof x === 'object' && typeof (x as SourceInfo).key === 'string' && typeof (x as SourceInfo).title === 'string') : [];
    return { built: typeof j.built === 'string' ? j.built : undefined, sources };
  } catch {
    return { sources: [] }; // optional
  }
}

/** Popular nicknames the catalogs don't carry (catalog/nicknames.csv, user-editable): "nickname;catalog id" per line. */
function addNicknames(file: string, index: Map<string, DsoObject>): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [nick, id] = line.split(';').map((x) => x.trim());
    const key = nick ? normalizeName(nick) : '';
    const target = key && id ? index.get(normalizeName(id)) : undefined;
    if (!target) continue;
    if (!target.aliases.includes(nick)) {
      target.aliases.push(nick);
      target.names.push(nick);
      keysOf.get(target)?.push(key);
      namesOf.get(target)?.push(key);
    }
    if (!index.has(key)) index.set(key, target);
  }
}

/** Load everything into locals first: a failure part-way leaves nothing half-built behind. */
function load(): Loaded {
  const file = path.join(config.paths.catalog, 'objects.tsv');
  const objects = fs.existsSync(file) ? loadObjects(file) : [];
  const sources = loadSources(path.join(config.paths.catalog, 'sources.json'));
  const index = new Map<string, DsoObject>();
  for (const o of objects) {
    const keys = [o.id, ...o.aliases].map(normalizeName);
    keysOf.set(o, keys);
    namesOf.set(o, o.names.map(normalizeName));
    for (const key of keys) if (key && !index.has(key)) index.set(key, o);
  }
  addNicknames(path.join(config.paths.catalog, 'nicknames.csv'), index);
  if (objects.length === 0) log.warn(`no object database at ${file} — run "npm run catalog"`);
  else log.info(`loaded ${objects.length} objects from ${sources.sources.length || '?'} catalogs`);
  return { objects, sources, index };
}

function db(): Loaded {
  loaded ??= load();
  return loaded;
}

export function catalog(): DsoObject[] {
  return db().objects;
}

/** Drop the loaded catalog (tests, or after `npm run catalog`): the next call reloads it. */
export function reloadCatalog(): void {
  loaded = null;
}

export function catalogSources(): { built?: string; sources: SourceInfo[] } {
  return db().sources;
}

/** Shorter than this, a fuzzy query matches too much to mean anything. */
const FUZZY_MIN = 3;

export function findObject(name: string): DsoObject | null {
  const { index, objects } = db();
  const key = normalizeName(name);
  const hit = index.get(key);
  if (hit) return hit;
  // Fuzzy: substring match on common names.
  const q = key.replace(/ nebula| galaxy| cluster/g, '').trim();
  if (q.length < FUZZY_MIN) return null;
  // the most prominent of the matches, not whichever the file happens to list first
  let best: DsoObject | null = null;
  for (const o of objects) if (namesOf.get(o)?.some((a) => a.includes(q)) && (!best || prominence(o) > prominence(best))) best = o;
  return best;
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
  const { objects } = db();
  const q = normalizeName(query);
  if (!q || limit < 1) return [];
  const exact = findObject(query);
  const ranked: [DsoObject, number][] = [];
  for (const o of objects) {
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
  if (o.aliases.some((a) => MESSIER.test(a))) p += 40;
  else if (o.aliases.some((a) => CALDWELL.test(a))) p += 30;
  if (o.names.length) p += 15;
  if (o.mag !== undefined) p += Math.max(0, 15 - o.mag);
  else if (o.brightClass) p += 8 - 2 * o.brightClass;
  if (o.majorArcmin) p += Math.min(10, Math.log2(1 + o.majorArcmin) * 2);
  return p;
}

/** The name people (and the DWARF app) use: Messier, then Caldwell, then a common name, then the id. */
export function displayName(o: DsoObject): string {
  return o.aliases.find((a) => MESSIER.test(a)) ?? o.aliases.find((a) => CALDWELL.test(a)) ?? o.names[0] ?? o.id;
}

/**
 * The label for GoTo, which the scope uses to name the session folder: the DWARF app's choice
 * (Messier, then Caldwell, then the catalog id: its sessions are "C 20", "C 33", "NGC 281") so that
 * nights captured with the app and with us carry the same target name and stack together.
 */
export function gotoLabel(o: DsoObject): string {
  if ((o.type === '*' || o.type === '**') && o.names[0]) return o.names[0]; // "Vega", not "HR 7001"
  return o.aliases.find((a) => MESSIER.test(a)) ?? o.aliases.find((a) => CALDWELL.test(a)) ?? (isDesignation(o.id) ? o.id : o.aliases.find(isDesignation) ?? o.id);
}

export function describe(o: DsoObject): string {
  const names = [o.id, ...o.aliases].slice(0, 4).join(' / ');
  const size = o.majorArcmin ? `${o.majorArcmin}'${o.minorArcmin ? `×${o.minorArcmin}'` : ''}` : 'size n/a';
  return `${names} — ${o.typeName} in ${o.constellation}, ${size}, mag ${o.mag ?? 'n/a'}`;
}
