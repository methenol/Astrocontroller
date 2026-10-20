/** Field parsers shared by the source loaders. */
import fs from 'node:fs';
import { prettyId } from '../../astro/designations.js';
import type { Rec } from './types.js';
import type { Row } from './fetch.js';

/** A number, or undefined for an empty or non-numeric field (never 0 for a blank one). */
export function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Rounds to `d` decimals; undefined stays undefined. */
export const round = (n: number | undefined, d: number): number | undefined => (n === undefined ? undefined : Math.round(n * 10 ** d) / 10 ** d);

/** "05:35:17.3" → 5.588; "-05:23:28" → -5.391; "-00:30:00" keeps its sign. NaN when malformed. */
export function sexa(s: string): number {
  const t = s.trim();
  const sign = t.startsWith('-') ? -1 : 1;
  const parts = t.replace(/^[+-]/, '').split(/[: ]+/);
  if (parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d*)?$/.test(p))) return NaN;
  const [a, b = 0, c = 0] = parts.map(Number);
  // catalogs round up to "60.0" (OpenNGC: IC 3322A at +07:12:60.0)
  if (b > 60 || c > 60) return NaN;
  return sign * (a + b / 60 + c / 3600);
}

/** The computed J2000 position of a VizieR row, RA in hours; null when missing. */
export function pos(row: Row): { ra: number; dec: number } | null {
  const ra = num(row._RAJ2000);
  const dec = num(row._DEJ2000);
  return ra === undefined || dec === undefined ? null : { ra: ra / 15, dec };
}

/** "NGC2327", "IC 2177", "M 42", "G2" (Gum) and friends inside free-text cross-id fields. */
export function crossIds(text: string): string[] {
  const out: string[] = [];
  // "M 1-36" is Minkowski, not Messier 1: a hyphenated number is kept whole
  for (const m of text.matchAll(/\b(NGC|IC|M|Sh ?2-|vdB|Ced|LBN|LDN|RCW|Gum|Cr|Mel)\s?(\d+[A-Za-z]?)(?:-\s?(\d+))?(?![\w-])/g)) {
    const p = m[1].replace(/\s/g, '');
    if (p === 'Sh2-') out.push(`Sh2-${m[2]}`);
    else if (m[3]) {
      if (p === 'M') out.push(`M ${m[2]}-${m[3]}`);
    } else out.push(`${p} ${m[2]}`);
  }
  return out;
}

const OPENNGC_IDS = /^(C|B|Cl|SH 2|LBN|LDN|vdB|Mel|Cr|Abell|Arp|UGC|PGC|ESO|MCG|CGCG|PK|PN G|RCW|Ced|Gum|HCG|Tr|Pal)\s?[-+]?\d/i;
const OPENNGC_COLUMNS = ['Name', 'Type', 'RA', 'Dec', 'Const', 'MajAx', 'MinAx', 'PosAng', 'B-Mag', 'V-Mag', 'SurfBr', 'M', 'NGC', 'IC', 'Identifiers', 'Common names'] as const;

export function prettyOpenNgcId(t: string): string {
  return t
    .replace(/^SH 2-0*/, 'Sh2-')
    .replace(/^Cl 0*(\d)/, 'Cr $1') // OpenNGC's "Cl" is Collinder
    .replace(/^(C|B|Mel|Cr|LBN|LDN|PGC|UGC|Arp|Abell|RCW|Ced|Gum|HCG|Tr|Pal) 0*(\d)/, '$1 $2');
}

const firstNumber = (list: string) => list.split(',')[0].trim().replace(/^0+(?=\d)/, '');

/** One OpenNGC CSV (NGC.csv or addendum.csv): its objects, and its "Dup" rows as [alias, target]. */
export function parseOpenNgc(text: string, name = 'OpenNGC'): { records: Rec[]; aliases: [string, string][] } {
  const lines = text.split(/\r?\n/);
  const head = lines[0].split(';').map((h) => h.trim());
  const missing = OPENNGC_COLUMNS.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`${name}: columns missing: ${missing.join(', ')}`);
  const at = Object.fromEntries(OPENNGC_COLUMNS.map((c) => [c, head.indexOf(c)])) as Record<(typeof OPENNGC_COLUMNS)[number], number>;
  const records: Rec[] = [];
  const aliases: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = line.split(';');
    const get = (c: (typeof OPENNGC_COLUMNS)[number]) => (f[at[c]] ?? '').trim();
    const type = get('Type');
    const id = prettyOpenNgcId(prettyId(get('Name')));
    if (type === 'Dup') {
      // a second designation of another entry: an alias of that one
      const target = get('M') ? `M ${Number(get('M'))}` : get('NGC') ? `NGC ${firstNumber(get('NGC'))}` : get('IC') ? `IC ${firstNumber(get('IC'))}` : '';
      if (target) aliases.push([id, target]);
      continue;
    }
    if (!get('RA') || type === 'NonEx') continue;
    const ids: string[] = [];
    if (get('M')) ids.push(`M ${Number(get('M'))}`);
    for (const t of get('Identifiers').split(',').map((s) => s.trim())) if (OPENNGC_IDS.test(t)) ids.push(prettyOpenNgcId(t));
    records.push({
      id,
      type,
      ra: sexa(get('RA')),
      dec: sexa(get('Dec')),
      con: get('Const') || undefined,
      maj: num(get('MajAx')),
      min: num(get('MinAx')),
      pa: num(get('PosAng')),
      mag: num(get('V-Mag')) ?? num(get('B-Mag')),
      sb: num(get('SurfBr')),
      ids,
      names: get('Common names').split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return { records, aliases };
}

export const readOpenNgc = (file: string) => parseOpenNgc(fs.readFileSync(file, 'utf8'), file);
