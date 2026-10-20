/** Serialises the merged catalog: objects.tsv (read by src/astro/catalog.ts) and sources.json. */
import * as A from 'astronomy-engine';
import type { Obj } from './types.js';

export const TSV_HEADER = '# id\ttype\tra_h\tdec_deg\tcon\tmaj_arcmin\tmin_arcmin\tpa\tmag\tsb\tvis\tnames\tids\tsources';

// Display order of designations: the ones observers use first.
const ID_ORDER = ['M ', 'C ', 'NGC ', 'IC ', 'Sh2-', 'B ', 'vdB ', 'Cr ', 'Mel ', 'Tr ', 'Arp ', 'HCG ', 'Abell ', 'ACO ', 'LBN ', 'LDN ', 'Ced ', 'RCW ', 'Gum ', 'UGC ', 'PGC ', 'ESO ', 'MCG ', 'CGCG ', 'PN G', 'PK ', 'SNR G', 'HR ', 'HD ', 'HIP '];

export function idRank(s: string): number {
  if (/^[α-ω]\d? /.test(s)) return -2;
  if (/^\d+ [A-Z]/.test(s)) return -1;
  const i = ID_ORDER.findIndex((p) => s.startsWith(p));
  return i < 0 ? ID_ORDER.length : i;
}

const fmt = (n: number | undefined, d: number) => (n === undefined || !Number.isFinite(n) ? '' : String(Math.round(n * 10 ** d) / 10 ** d));
/** RA rounded, wrapped into 0–24 h: 23.9999999 h must not round to 24, which the loader rejects. */
const fmtRa = (h: number) => (Number.isFinite(h) ? fmt((((Math.round(h * 1e6) / 1e6) % 24) + 24) % 24, 6) : '');
/** Tabs, newlines and the list separator would break the row. */
const clean = (s: string) => s.replace(/[\t|\r\n]+/g, ' ').trim();
const unique = (list: readonly string[]) => [...new Set(list.map(clean))].filter(Boolean);

export function tsvRow(o: Obj): string {
  const id = clean(o.id);
  const ids = unique(o.ids).filter((x) => x !== id).sort((a, b) => idRank(a) - idRank(b));
  return [
    id, o.type, fmtRa(o.ra), fmt(o.dec, 5), o.con || A.Constellation(o.ra, o.dec).symbol, fmt(o.maj, 2), fmt(o.min, 2), fmt(o.pa, 0), fmt(o.mag, 2), fmt(o.sb, 2), fmt(o.vis, 0),
    unique(o.names).join('|'), ids.join('|'), o.sources.join(','),
  ].join('\t');
}

export const objectsTsv = (objects: readonly Obj[]) => `${[TSV_HEADER, ...objects.map(tsvRow)].join('\n')}\n`;

export interface SourceStats {
  key: string;
  title: string;
  cite: string;
  records: number;
  added: number;
  merged: number;
}

export const sourcesJson = (built: Date, total: number, sources: readonly SourceStats[]) =>
  `${JSON.stringify({ built: built.toISOString().slice(0, 10), total, sources }, null, 2)}\n`;
