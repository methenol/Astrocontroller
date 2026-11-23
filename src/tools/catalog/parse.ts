/** Field parsers shared by the source loaders. */
import fs from 'node:fs';
import { CONSTELLATIONS, isDesignation, prettyId } from '../../astro/designations.js';
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

/** "ESO409-015" → "ESO 409-15": a catalog prefix glued to its number, as UNGC and HyperLEDA write them. */
function spaced(prefix: string, rest: string): string {
  return `${prefix} ${rest.replace(/(^|-)0+(?=\d)/g, '$1')}`;
}

// SIMBAD writes designations padded ("NGC  2579", "SH  2-155", "PN A66   21"): its catalog
// acronyms → this database's spelling. Catalogs not listed (stars, IR and radio surveys) are not used.
const SIMBAD_IDS: readonly (readonly [RegExp, (m: RegExpExecArray) => string])[] = [
  [/^(NGC|IC) (\d+)([A-Z]?)$/, (m) => `${m[1]} ${Number(m[2])}${m[3]}`],
  [/^M (\d+)$/, (m) => `M ${Number(m[1])}`],
  [/^SH 2-(\d+)$/, (m) => `Sh2-${Number(m[1])}`],
  [/^(LBN|LDN|RCW|UGC|UGCA|HCG|Arp|DDO|KDG|VV|Mrk|VCC|FCC|KK|KKH|KKR) (\d+)([A-Za-z]?)$/, (m) => `${m[1]} ${Number(m[2])}${m[3]}`],
  [/^Barnard (\d+)([A-Za-z]?)$/, (m) => `B ${Number(m[1])}${m[2]}`],
  [/^VdB (\d+)$/, (m) => `vdB ${Number(m[1])}`],
  [/^VdBH (\d+)([a-z]?)$/, (m) => `vdBH ${Number(m[1])}${m[2]}`],
  [/^Ced (\d+)([a-z]?)$/, (m) => `Ced ${Number(m[1])}${m[2]}`],
  [/^GUM (\d+)([a-z]?)$/, (m) => `Gum ${Number(m[1])}${m[2]}`],
  [/^PN A66 (\d+)$/, (m) => `Abell ${Number(m[1])}`],
  [/^PN G(\d{3}\.\d[+-]\d{2}\.\d)$/, (m) => `PN G${m[1]}`],
  [/^SNR G(\d{3}\.\d[+-]\d{2}\.\d)$/, (m) => `SNR G${m[1]}`],
  [/^(?:PGC|LEDA) (\d+)$/, (m) => `PGC ${Number(m[1])}`],
  [/^ESO (\d+)-(\d+)([A-Z]?)$/, (m) => `ESO ${Number(m[1])}-${Number(m[2])}${m[3]}`],
  [/^MCG ?([+-]\d+-\d+-\d+)$/, (m) => `MCG ${m[1]}`],
  [/^CGCG (\d+-\d+)$/, (m) => spaced('CGCG', m[1])],
  [/^ACO (\d+)$/, (m) => `ACO ${Number(m[1])}`],
  [/^ACO S (\d+)$/, (m) => `ACO S${Number(m[1])}`],
  [/^Cl (Collinder|Melotte|Trumpler) (\d+)$/, (m) => `${{ Collinder: 'Cr', Melotte: 'Mel', Trumpler: 'Tr' }[m[1]]} ${Number(m[2])}`],
  [/^Cl (Berkeley|King|Stock|Czernik|Dolidze) (\d+)$/, (m) => `${m[1]} ${Number(m[2])}`],
  [/^LHA (120|115)-N (\d+)([A-Z]?)$/, (m) => `LHA ${m[1]}-N ${Number(m[2])}${m[3]}`],
  // planetaries found since the big catalogs, named in SIMBAD as "NAME PN Kn 61", "NAME PN StDr 138"
  [/^NAME PN ([A-Z][A-Za-z]{0,5}) (\d+)$/, (m) => `${m[1]} ${Number(m[2])}`],
];

/** A SIMBAD identifier in this database's spelling ("NGC  2579" → "NGC 2579", "SH  2-155" → "Sh2-155"), or null for catalogs not used here. */
export function simbadId(raw: string): string | null {
  const s = raw.replace(/\s+/g, ' ').trim();
  for (const [re, to] of SIMBAD_IDS) {
    const m = re.exec(s);
    if (m) return to(m);
  }
  return null;
}

const CONSTELLATION_NAMES = new Set(CONSTELLATIONS.map(([, name]) => name));
const CONSTELLATION_BY_ABBR = new Map(CONSTELLATIONS.map(([abbr, name]) => [abbr.toLowerCase(), name]));

/** Words that mark a SIMBAD "NAME" as a part or a feature of an object, not what observers call it. */
const PART_WORDS = /\b(?:IRS|companion|core|clump|knot|filament|jet|shell|lobe|ridge|outflow|region|part|source|center|centre|component)\b/i;

/**
 * A SIMBAD "NAME …" identifier as a common name ("NAME the Witch Head Nebula" → "Witch Head
 * Nebula"), or null for the ones that are designations, sub-region labels or survey ids
 * ("NAME [BM89] L1082C", "NAME Mon R2 IRS3", "NAME Cygnus Loop Northern Shell").
 */
export function simbadName(raw: string): string | null {
  if (!/^NAME /.test(raw)) return null;
  const s = raw.replace(/\s+/g, ' ').trim().replace(/^NAME (?:the )?/i, '');
  if (s.length < 4 || /[\d[\]()/_]/.test(s) || PART_WORDS.test(s) || isDesignation(s)) return null;
  if (!/[a-z]/.test(s)) return null; // all capitals: an acronym
  if (CONSTELLATION_NAMES.has(s)) return null; // "NAME Vela" on the Vela SNR: the constellation's name, not the object's
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One SIMBAD object, from the rows of a query that joined its identifiers (one row per identifier). */
export interface SimbadObject {
  oid: string;
  ra: number;
  dec: number;
  otype: string;
  maj?: number;
  min?: number;
  pa?: number;
  /** identifiers matched by the query's filter */
  keys: string[];
  /** all identifiers returned for it */
  idents: string[];
}

/** Groups TAP rows (oid, ra, dec, otype, galdim_*, hit: the identifier the query matched, alt: another of its identifiers) by object. Rows without a position are dropped. */
export function simbadObjects(rows: readonly Row[]): SimbadObject[] {
  const byOid = new Map<string, SimbadObject>();
  for (const r of rows) {
    const ra = num(r.ra);
    const dec = num(r.dec);
    if (ra === undefined || dec === undefined) continue;
    let o = byOid.get(r.oid);
    if (!o) {
      const maj = num(r.galdim_majaxis);
      const min = num(r.galdim_minaxis);
      const pa = num(r.galdim_angle);
      o = { oid: r.oid, ra: ra / 15, dec, otype: r.otype, maj: maj && maj > 0 ? round(maj, 2) : undefined, min: min && min > 0 ? round(min, 2) : undefined, pa: pa !== undefined && pa >= 0 && pa < 360 ? pa : undefined, keys: [], idents: [] };
      byOid.set(r.oid, o);
    }
    if (r.hit && !o.keys.includes(r.hit)) o.keys.push(r.hit);
    if (r.alt && !o.idents.includes(r.alt)) o.idents.push(r.alt);
  }
  return [...byOid.values()];
}

// HyperLEDA's alternate names ("UGC12889  MCG8-01-018  CGCG549-13"): the catalogs observers
// search by. A name in brackets is the system the galaxy belongs to, "!" a wrong one, "?" a doubtful one.
const LEDA_NAME = /^(NGC|IC|UGCA|UGC|ESO|MCG|CGCG|MRK|ARP|VV|DDO|KDG|KKH|KKR|KK|VCC|FCC|HCG|FGC)([-+]?\d.*)$/;
const LEDA_PREFIX: Readonly<Record<string, string>> = { MRK: 'Mrk', ARP: 'Arp' };

/** One HyperLEDA alternate name in this database's spelling, or null for a catalog not used here. */
export function ledaName(raw: string): string | null {
  const m = LEDA_NAME.exec(raw.trim());
  if (!m) return null;
  const [, p, rest] = m;
  if (p === 'MCG') return /^[-+]?\d+-\d+-\d+$/.test(rest) ? `MCG ${/^[-+]/.test(rest) ? rest : `+${rest}`}` : null;
  if (p === 'ESO' || p === 'CGCG') return /^\d+-\d+[A-Z]?$/.test(rest) ? spaced(p, rest) : null;
  if (!/^\d+[A-Z]?$/.test(rest)) return null;
  return spaced(LEDA_PREFIX[p] ?? p, rest);
}

/** The usable designations in HyperLEDA's ANames field. */
export const ledaNames = (field: string): string[] => field.split(/\s{2,}/).map(ledaName).filter((x): x is string => x !== null);

/** UNGC and McConnachie spell designations glued or padded ("UGC12894", "ESO 410- G 005", "And XVIII", "MESSIER081"). */
export function prettyGalaxyName(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  let m: RegExpExecArray | null;
  if ((m = /^MESSIER ?0*(\d+)$/i.exec(s))) return `M ${m[1]}`;
  if ((m = /^ESO ?(\d+) ?- ?(?:G|IG|N|\?)? ?(\d+)$/.exec(s))) return `ESO ${Number(m[1])}-${Number(m[2])}`;
  if ((m = /^Holm ?([IVX]+)$/.exec(s))) return `Holmberg ${m[1]}`;
  // a constellation's dwarfs, glued or abbreviated: "And XVIII", "LeoIV", "CVnII", "UMa II", "BootesI"
  if ((m = /^([A-Z][A-Za-z]+?) ?([IVX]+|[A-Z])$/.exec(s))) {
    const con = CONSTELLATION_BY_ABBR.get(m[1].toLowerCase()) ?? (CONSTELLATION_NAMES.has(m[1]) ? m[1] : undefined);
    if (con) return `${con} ${m[2]}`;
  }
  if ((m = /^MRK ?(\d+)$/i.exec(s))) return `Mrk ${Number(m[1])}`;
  if ((m = /^(NGC|IC|UGCA|UGC|DDO|KDG|KKH|KKR|KKSG|KK|AGC|VCC|FCC|LeG|BTS|HIZSS|GR|Maffei|Dw|PGC) ?(\d+)([A-Z]?)$/.exec(s))) return `${m[1]} ${Number(m[2])}${m[3]}`;
  return s;
}
