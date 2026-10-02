/**
 * Deep-sky catalog from OpenNGC (CC-BY-SA 4.0, github.com/mattiaverga/OpenNGC):
 * NGC/IC plus the addendum (Messier-only, Caldwell, Barnard, Sharpless…).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';

const log = logger('catalog');

export interface DsoObject {
  id: string; // "NGC 224"
  aliases: string[]; // ["M 31", "Andromeda Galaxy", ...]
  type: string;
  typeName: string;
  raHours: number;
  decDeg: number;
  constellation: string;
  majorArcmin?: number;
  minorArcmin?: number;
  mag?: number;
  surfaceBrightness?: number;
}

export const TYPE_NAMES: Record<string, string> = {
  '*': 'star',
  '**': 'double star',
  '*Ass': 'stellar association',
  OCl: 'open cluster',
  GCl: 'globular cluster',
  'Cl+N': 'cluster with nebula',
  G: 'galaxy',
  GPair: 'galaxy pair',
  GTrpl: 'galaxy triplet',
  GGroup: 'galaxy group',
  PN: 'planetary nebula',
  HII: 'emission nebula (HII)',
  DrkN: 'dark nebula',
  EmN: 'emission nebula',
  Neb: 'nebula',
  RfN: 'reflection nebula',
  SNR: 'supernova remnant',
  Nova: 'nova',
  Other: 'other',
};

export const TYPE_GROUPS: Record<string, string[]> = {
  galaxy: ['G', 'GPair', 'GTrpl', 'GGroup'],
  nebula: ['HII', 'EmN', 'Neb', 'RfN', 'Cl+N', 'SNR', 'DrkN'],
  emission: ['HII', 'EmN', 'Cl+N', 'SNR', 'PN'],
  planetary: ['PN'],
  cluster: ['OCl', 'GCl', 'Cl+N', '*Ass'],
  globular: ['GCl'],
  open_cluster: ['OCl'],
  supernova_remnant: ['SNR'],
  reflection: ['RfN'],
};

let objects: DsoObject[] | null = null;
const index = new Map<string, DsoObject>();

/** "M31", "m 31", "Messier 31" → "M31"; "NGC 0224" → "NGC224"; names lowercased. */
export function normalizeName(s: string): string {
  let t = s.trim().toLowerCase();
  t = t.replace(/^messier\s*/, 'm').replace(/^caldwell\s*/, 'c').replace(/^sharpless\s*2?-?\s*/, 'sh2-').replace(/^sh\s*2\s*-?\s*/, 'sh2-');
  const m = t.match(/^(m|ngc|ic|c|b|sh2-|ldn|lbn|vdb|mel|cr|pgc|ugc|abell|arp)\s*0*(\d+)\s*([a-z]?)$/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return t.replace(/[^a-z0-9+-]+/g, ' ').trim();
}

function parseRa(s: string): number {
  const [h, m, sec] = s.split(':').map(Number);
  return h + m / 60 + sec / 3600;
}

function parseDec(s: string): number {
  const sign = s.startsWith('-') ? -1 : 1;
  const [d, m, sec] = s.replace(/^[+-]/, '').split(':').map(Number);
  return sign * (d + m / 60 + sec / 3600);
}

function prettyId(raw: string): string {
  const m = raw.match(/^([A-Za-z]+?)(\d+)(.*)$/);
  if (!m) return raw;
  const prefix = m[1] === 'Sh2' ? 'Sh2-' : `${m[1]} `;
  return `${prefix}${Number(m[2])}${m[3]}`;
}

function loadFile(file: string, out: DsoObject[]): void {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = lines[0].split(';');
  const col = (n: string) => head.indexOf(n);
  const ci = {
    name: col('Name'), type: col('Type'), ra: col('RA'), dec: col('Dec'), cons: col('Const'), maj: col('MajAx'), min: col('MinAx'),
    b: col('B-Mag'), v: col('V-Mag'), sb: col('SurfBr'), m: col('M'), ids: col('Identifiers'), common: col('Common names'),
  };
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = line.split(';');
    const type = f[ci.type];
    if (!f[ci.ra] || type === 'Dup' || type === 'NonEx') continue;
    const aliases: string[] = [];
    if (f[ci.m]) aliases.push(`M ${Number(f[ci.m])}`);
    for (const id of (f[ci.ids] ?? '').split(',')) {
      const t = id.trim();
      if (/^(C|B|SH 2|LBN|LDN|vdB|Mel|Cr|Abell|Arp) ?-?\d/i.test(t)) aliases.push(t.replace(/^SH 2-/, 'Sh2-').replace(/^C 0*/, 'C ').replace(/^B 0*/, 'B '));
    }
    for (const n of (f[ci.common] ?? '').split(',')) if (n.trim()) aliases.push(n.trim());
    const num = (i: number) => (f[i] ? Number(f[i]) : undefined);
    out.push({
      id: prettyId(f[ci.name]),
      aliases,
      type,
      typeName: TYPE_NAMES[type] ?? type,
      raHours: parseRa(f[ci.ra]),
      decDeg: parseDec(f[ci.dec]),
      constellation: f[ci.cons],
      majorArcmin: num(ci.maj),
      minorArcmin: num(ci.min),
      mag: num(ci.v) ?? num(ci.b),
      surfaceBrightness: num(ci.sb),
    });
  }
}

export function catalog(): DsoObject[] {
  if (objects) return objects;
  const list: DsoObject[] = [];
  loadFile(path.join(config.paths.catalog, 'NGC.csv'), list);
  loadFile(path.join(config.paths.catalog, 'addendum.csv'), list);
  for (const o of list) {
    for (const k of [o.id, ...o.aliases]) {
      const key = normalizeName(k);
      if (!index.has(key)) index.set(key, o);
    }
  }
  // Popular nicknames OpenNGC doesn't carry.
  const nickFile = path.join(config.paths.catalog, 'nicknames.csv');
  if (fs.existsSync(nickFile)) {
    for (const line of fs.readFileSync(nickFile, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const [nick, id] = line.split(';').map((s) => s.trim());
      const target = id ? index.get(normalizeName(id)) : undefined;
      if (!target) continue;
      if (!target.aliases.includes(nick)) target.aliases.push(nick);
      const key = normalizeName(nick);
      if (!index.has(key)) index.set(key, target);
    }
  }
  objects = list;
  if (list.length === 0) log.warn(`no catalog found in ${config.paths.catalog} — run "npm run catalog"`);
  else log.info(`loaded ${list.length} deep-sky objects`);
  return list;
}

export function findObject(name: string): DsoObject | null {
  catalog();
  const key = normalizeName(name);
  const hit = index.get(key);
  if (hit) return hit;
  // Fuzzy: substring match on common names.
  const q = key.replace(/ nebula| galaxy| cluster/g, '').trim();
  if (q.length < 3) return null;
  return objects!.find((o) => o.aliases.some((a) => normalizeName(a).includes(q))) ?? null;
}

export function searchObjects(query: string, limit = 10): DsoObject[] {
  catalog();
  const q = normalizeName(query);
  const exact = findObject(query);
  const out = exact ? [exact] : [];
  for (const o of objects!) {
    if (out.length >= limit) break;
    if (o === exact) continue;
    if ([o.id, ...o.aliases].some((a) => normalizeName(a).includes(q))) out.push(o);
  }
  return out;
}

export function describe(o: DsoObject): string {
  const names = [o.id, ...o.aliases].slice(0, 4).join(' / ');
  const size = o.majorArcmin ? `${o.majorArcmin}'${o.minorArcmin ? `×${o.minorArcmin}'` : ''}` : 'size n/a';
  return `${names} — ${o.typeName} in ${o.constellation}, ${size}, mag ${o.mag ?? 'n/a'}`;
}
