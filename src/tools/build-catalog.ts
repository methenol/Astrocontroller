/**
 * Builds catalog/objects.tsv, the merged object database used by the planner, GoTo and the
 * Database tab, from OpenNGC plus the VizieR catalogs and the IAU star names listed in SOURCES.
 *
 *   npm run catalog            download what is missing into catalog/.cache, then merge
 *   npm run catalog -- --fresh download everything again
 *
 * Merging: every record is matched to an object already in the database by any of its
 * designations (VizieR tables carry cross-identifications: LDN→Barnard, RCW→NGC/Gum, RC3→PGC…),
 * then, for extended objects, by position and size. A match adds the record's designations and
 * fills fields the object lacks; otherwise the record becomes a new object. Sources are merged in
 * the order listed, so the first catalog that has an object names it.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as A from 'astronomy-engine';
import { normalizeName, prettyId, isDesignation, greekSymbol, TYPE_NAMES } from '../astro/designations.js';

const dir = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'catalog');
const cacheDir = path.join(dir, '.cache');
const fresh = process.argv.includes('--fresh');
const VIZIER = 'https://vizier.cds.unistra.fr/viz-bin/asu-tsv';

interface Rec {
  id: string;
  type: string;
  ra: number; // hours, J2000
  dec: number; // degrees, J2000
  con?: string;
  maj?: number; // arcmin
  min?: number;
  pa?: number;
  mag?: number;
  sb?: number;
  /** visual brightness class for objects without a magnitude: 1 bright, 2 moderate, 3 faint (dark nebulae: opacity) */
  vis?: number;
  ids: string[]; // other designations
  names: string[]; // common names
}

interface Obj extends Rec {
  sources: string[];
}

interface Source {
  key: string;
  title: string;
  cite: string;
  /** how to match records not found by designation: candidate types and position tolerance */
  near?: { types: string[]; tol: (r: Rec, o: Obj) => number | null };
  load: () => Promise<Rec[]>;
}

// ------------------------------------------------------------------ download & parse helpers

async function cached(name: string, url: string): Promise<string> {
  const file = path.join(cacheDir, name);
  if (!fresh && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  process.stdout.write(`  downloading ${name}… `);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, text);
      console.log(`${(text.length / 1e6).toFixed(1)} MB`);
      return text;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${name}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** A VizieR table as rows keyed by column name, with computed J2000 positions in _RAJ2000/_DEJ2000 (degrees). */
async function vizier(table: string, columns: string[], filter: Record<string, string> = {}): Promise<Record<string, string>[]> {
  const q = new URLSearchParams({ '-source': table, '-out.max': 'unlimited', '-out': columns.join(','), '-out.add': '_RAJ,_DEJ', '-oc.form': 'dec', ...filter });
  const text = await cached(`${table.replace(/\//g, '_')}.tsv`, `${VIZIER}?${q}`);
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const head = lines[0].split('\t');
  // header, units, dashes, then data
  return lines.slice(3).map((l) => {
    const f = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, (f[i] ?? '').trim()]));
  });
}

const num = (s: string | undefined) => (s === undefined || s === '' || Number.isNaN(Number(s)) ? undefined : Number(s));
const r = (n: number | undefined, d: number) => (n === undefined ? undefined : Math.round(n * 10 ** d) / 10 ** d);

/** "05:35:17.3" → 5.588; "-05:23:28" → -5.391 */
function sexa(s: string): number {
  const sign = s.trim().startsWith('-') ? -1 : 1;
  const [a, b = 0, c = 0] = s.replace(/^[+-]/, '').split(/[: ]+/).map(Number);
  return sign * (a + b / 60 + c / 3600);
}

function pos(row: Record<string, string>): { ra: number; dec: number } | null {
  const ra = num(row._RAJ2000);
  const dec = num(row._DEJ2000);
  return ra === undefined || dec === undefined ? null : { ra: ra / 15, dec };
}

/** "NGC2327", "IC 2177", "M 42", "G2" (Gum) and friends inside free-text cross-id fields. */
function crossIds(text: string): string[] {
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

// ------------------------------------------------------------------ OpenNGC

const OPENNGC_IDS = /^(C|B|Cl|SH 2|LBN|LDN|vdB|Mel|Cr|Abell|Arp|UGC|PGC|ESO|MCG|CGCG|PK|PN G|RCW|Ced|Gum|HCG|Tr|Pal)\s?[-+]?\d/i;

function prettyOpenNgcId(t: string): string {
  return t
    .replace(/^SH 2-0*/, 'Sh2-')
    .replace(/^Cl 0*(\d)/, 'Cr $1') // OpenNGC's "Cl" is Collinder
    .replace(/^(C|B|Mel|Cr|LBN|LDN|PGC|UGC|Arp|Abell|RCW|Ced|Gum|HCG|Tr|Pal) 0*(\d)/, '$1 $2');
}

function loadOpenNgc(file: string, dups: [string, string][]): Rec[] {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = lines[0].split(';');
  const col = (n: string) => head.indexOf(n);
  const ci = {
    name: col('Name'), type: col('Type'), ra: col('RA'), dec: col('Dec'), cons: col('Const'), maj: col('MajAx'), min: col('MinAx'), pa: col('PosAng'),
    b: col('B-Mag'), v: col('V-Mag'), sb: col('SurfBr'), m: col('M'), ngc: col('NGC'), ic: col('IC'), ids: col('Identifiers'), common: col('Common names'),
  };
  const out: Rec[] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = line.split(';');
    const type = f[ci.type];
    const id = prettyOpenNgcId(prettyId(f[ci.name]));
    if (type === 'Dup') {
      // A second designation of another entry: remember it as an alias of that one.
      const target = f[ci.m] ? `M ${Number(f[ci.m])}` : f[ci.ngc] ? `NGC ${f[ci.ngc].split(',')[0].replace(/^0+/, '')}` : f[ci.ic] ? `IC ${f[ci.ic].split(',')[0].replace(/^0+/, '')}` : '';
      if (target) dups.push([id, target]);
      continue;
    }
    if (!f[ci.ra] || type === 'NonEx') continue;
    const ids: string[] = [];
    if (f[ci.m]) ids.push(`M ${Number(f[ci.m])}`);
    for (const t of (f[ci.ids] ?? '').split(',').map((s) => s.trim())) if (OPENNGC_IDS.test(t)) ids.push(prettyOpenNgcId(t));
    out.push({
      id,
      type,
      ra: sexa(f[ci.ra]),
      dec: sexa(f[ci.dec]),
      con: f[ci.cons] || undefined,
      maj: num(f[ci.maj]),
      min: num(f[ci.min]),
      pa: num(f[ci.pa]),
      mag: num(f[ci.v]) ?? num(f[ci.b]),
      sb: num(f[ci.sb]),
      ids,
      names: (f[ci.common] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

// ------------------------------------------------------------------ position matching tolerances

const NEBULAE = ['HII', 'EmN', 'Neb', 'RfN', 'Cl+N', 'SNR'];

/** Extended objects: same object if the centres are within a quarter of the larger size (+1′) and the sizes agree within 3×. */
function extendedTol(rec: Rec, o: Obj): number | null {
  const a = rec.maj;
  const b = o.maj;
  if (!a || !b) return 2;
  if (Math.max(a, b) / Math.min(a, b) > 3) return null;
  return 0.25 * Math.max(a, b) + 1;
}

// ------------------------------------------------------------------ sources

const vis3 = (n: number | undefined, map: Record<number, number>) => (n === undefined ? undefined : map[n]);

const SOURCES: Source[] = [
  {
    key: 'openngc',
    title: 'OpenNGC (NGC, IC, Messier, Caldwell and addendum)',
    cite: 'Mattia Verga, OpenNGC, CC-BY-SA 4.0, github.com/mattiaverga/OpenNGC',
    load: async () => {
      for (const f of ['NGC.csv', 'addendum.csv']) {
        const file = path.join(dir, f);
        if (!fs.existsSync(file) || fresh) {
          const text = await cached(`openngc-${f}`, `https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/${f}`);
          fs.writeFileSync(file, text);
        }
      }
      return [...loadOpenNgc(path.join(dir, 'NGC.csv'), openNgcDups), ...loadOpenNgc(path.join(dir, 'addendum.csv'), openNgcDups)];
    },
  },
  {
    key: 'harris',
    title: 'Globular clusters (Harris 2010)',
    cite: 'Harris W.E., Catalog of Parameters for Milky Way Globular Clusters, 2010 edition (VizieR VII/202)',
    near: { types: ['GCl'], tol: () => 1.5 },
    load: async () =>
      (await vizier('VII/202/catalog', ['ID', 'Name', 'Vt', 'Rh'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const id = row.ID.replace(/^Pal\s+/, 'Pal ').replace(/\s+/g, ' ');
        const rh = num(row.Rh);
        return [{ id, type: 'GCl', ...p, mag: num(row.Vt), maj: rh ? r(rh * 4, 1) : undefined, ids: [], names: row.Name ? [row.Name] : [] }];
      }),
  },
  {
    key: 'dias',
    title: 'Open clusters (Dias et al. 2002, v3.5)',
    cite: 'Dias W.S., Alessi B.S., Moitinho A., Lepine J.R.D., New catalogue of optically visible open clusters and candidates (VizieR B/ocl)',
    near: { types: ['OCl', 'Cl+N', '*Ass'], tol: (rec, o) => (o.maj && rec.maj && Math.max(o.maj, rec.maj) / Math.min(o.maj, rec.maj) > 3 ? null : 0.2 * Math.max(o.maj ?? 2, rec.maj ?? 2) + 1) },
    load: async () =>
      (await vizier('B/ocl/clusters', ['Cluster', 'Diam', 'Dist', 'Class'])).flatMap((row) => {
        const p = pos(row);
        if (!p || !row.Cluster) return [];
        const id = row.Cluster.replace(/_/g, ' ').replace(/^Collinder /, 'Cr ').replace(/^Melotte /, 'Mel ').replace(/^Trumpler /, 'Tr ');
        return [{ id, type: 'OCl', ...p, maj: num(row.Diam), ids: [], names: [] }];
      }),
  },
  {
    key: 'pn',
    title: 'Planetary nebulae (Strasbourg-ESO catalogue)',
    cite: 'Acker A. et al., Strasbourg-ESO Catalogue of Galactic Planetary Nebulae, 1992 (VizieR V/84)',
    near: { types: ['PN'], tol: () => 0.5 },
    load: async () => {
      const diam = new Map((await vizier('V/84/diam', ['PNG', 'oDiam'])).map((d) => [d.PNG, num(d.oDiam)]));
      return (await vizier('V/84/main', ['PNG', 'Name', 'PK', 'Idents'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const name = row.Name.replace(/\s+/g, ' ').replace(/(\d)- (\d)/, '$1-$2').trim(); // "M 1- 1" -> "M 1-1" (Minkowski)
        const ids = [`PN G${row.PNG}`, ...crossIds(row.Idents)];
        const abell = name.match(/^A(?:bell)? ?(\d+)$/);
        const id = abell ? `Abell ${abell[1]}` : /^(NGC|IC) /.test(name) ? name : `PN G${row.PNG}`;
        if (id !== name && !abell) ids.push(name);
        const d = diam.get(row.PNG);
        return [{ id, type: 'PN', ...p, maj: d ? r(d / 60, 2) : undefined, ids: ids.filter((x) => x !== id), names: [] }];
      });
    },
  },
  {
    key: 'green',
    title: 'Supernova remnants (Green 2024)',
    cite: 'Green D.A., A catalogue of 310 Galactic supernova remnants, 2024 (VizieR VII/297)',
    near: { types: NEBULAE, tol: extendedTol },
    load: async () =>
      (await vizier('VII/297/snrs', ['SNR', 'MajDiam', 'MinDiam', 'Names'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        // Green brackets names that cover only part of the remnant; radio designations ("3C58", "W44", "CTB 1") are ids
        const names = row.Names.split(',').map((s) => s.trim().replace(/^\((.*)\)$/, '$1')).filter(Boolean);
        const radio = (n: string) => /\d/.test(n);
        return [{ id: `SNR G${row.SNR.replace(/^G/, '')}`, type: 'SNR', ...p, maj: num(row.MajDiam), min: num(row.MinDiam), ids: names.filter(radio), names: names.filter((n) => !radio(n)) }];
      }),
  },
  {
    key: 'sh2',
    title: 'Sharpless HII regions (Sh2)',
    cite: 'Sharpless S., A Catalogue of H II Regions, 1959 (VizieR VII/20)',
    near: { types: NEBULAE, tol: extendedTol },
    load: async () =>
      (await vizier('VII/20/catalog', ['Sh2', 'Diam', 'Bright'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        return [{ id: `Sh2-${Number(row.Sh2)}`, type: 'HII', ...p, maj: num(row.Diam), vis: vis3(num(row.Bright), { 3: 1, 2: 2, 1: 3 }), ids: [], names: [] }];
      }),
  },
  {
    key: 'rcw',
    title: 'RCW southern HII regions',
    cite: 'Rodgers A.W., Campbell C.T., Whiteoak J.B., A catalogue of H-alpha emission regions in the southern Milky Way, 1960 (VizieR VII/216)',
    near: { types: NEBULAE, tol: extendedTol },
    load: async () =>
      (await vizier('VII/216/rcw', ['RCW', 'MajAxis', 'MinAxis', 'Br', 'IDs'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const ids = crossIds(row.IDs);
        for (const g of row.IDs.matchAll(/(?:^|;)\s*G(\d+)/g)) ids.push(`Gum ${g[1]}`);
        return [{ id: `RCW ${Number(row.RCW)}`, type: 'HII', ...p, maj: num(row.MajAxis), min: num(row.MinAxis), vis: ({ b: 1, m: 2, f: 3 } as Record<string, number>)[row.Br], ids, names: [] }];
      }),
  },
  {
    key: 'ced',
    title: 'Cederblad bright diffuse nebulae',
    cite: 'Cederblad S., Catalog of Bright Diffuse Galactic Nebulae, 1946 (VizieR VII/231)',
    near: { types: NEBULAE, tol: extendedTol },
    load: async () =>
      (await vizier('VII/231/catalog', ['Ced', 'm_Ced', 'Name', 'Dim1', 'Dim2'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        return [{ id: `Ced ${Number(row.Ced)}${row.m_Ced ?? ''}`, type: 'Neb', ...p, maj: num(row.Dim1), min: num(row.Dim2), ids: crossIds(row.Name), names: [] }];
      }),
  },
  {
    key: 'lbn',
    title: 'Lynds bright nebulae (LBN)',
    cite: 'Lynds B.T., Catalogue of Bright Nebulae, 1965 (VizieR VII/9)',
    near: { types: NEBULAE, tol: extendedTol },
    load: async () =>
      (await vizier('VII/9/catalog', ['Seq', 'Diam1', 'Diam2', 'Bright', 'Name'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const ids: string[] = [];
        // the brightest-known designation: S = Sharpless, C = Cederblad, DG = Dorschner & Gürtler
        const x = row.Name.match(/^(S|C|DG|NGC|IC)\s*(\d+[a-z]?)/);
        if (x) ids.push(x[1] === 'S' ? `Sh2-${Number(x[2])}` : x[1] === 'C' ? `Ced ${x[2]}` : `${x[1]} ${x[2]}`);
        const b = num(row.Bright);
        return [{ id: `LBN ${Number(row.Seq)}`, type: 'Neb', ...p, maj: num(row.Diam1), min: num(row.Diam2), vis: b === undefined ? undefined : b <= 1 ? 1 : b <= 3 ? 2 : 3, ids, names: [] }];
      }),
  },
  {
    key: 'vdb',
    title: 'van den Bergh reflection nebulae (vdB)',
    cite: 'van den Bergh S., A study of reflection nebulae, 1966 (VizieR VII/21)',
    near: { types: NEBULAE, tol: extendedTol },
    load: async () =>
      (await vizier('VII/21/catalog', ['VdB', 'Vmag', 'SurfBr', 'BRadMax', 'RRadMax'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const rad = num(row.BRadMax) ?? num(row.RRadMax);
        return [{ id: `vdB ${Number(row.VdB)}`, type: 'RfN', ...p, maj: rad ? r(rad * 2, 1) : undefined, vis: ({ Br: 1, M: 2, F: 3 } as Record<string, number>)[row.SurfBr], ids: [], names: [] }];
      }),
  },
  {
    key: 'barnard',
    title: 'Barnard dark nebulae',
    cite: 'Barnard E.E., Catalogue of 349 dark objects in the sky, 1927 (VizieR VII/220A)',
    near: { types: ['DrkN'], tol: extendedTol },
    load: async () =>
      (await vizier('VII/220A/barnard', ['Barn', 'Diam'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        return [{ id: `B ${row.Barn.replace(/^0+/, '').trim()}`, type: 'DrkN', ...p, maj: num(row.Diam), ids: [], names: [] }];
      }),
  },
  {
    key: 'ldn',
    title: 'Lynds dark nebulae (LDN)',
    cite: 'Lynds B.T., Catalogue of Dark Nebulae, 1962 (VizieR VII/7A)',
    near: { types: ['DrkN'], tol: extendedTol },
    load: async () =>
      (await vizier('VII/7A/ldn', ['LDN', 'Area', 'Opacity', 'Barn'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const area = num(row.Area);
        const op = num(row.Opacity);
        const ids = row.Barn.split(/[ ,]+/).filter((b) => /^\d+[a-z]?$/i.test(b)).map((b) => `B ${b.replace(/^0+/, '')}`);
        return [{ id: `LDN ${Number(row.LDN)}`, type: 'DrkN', ...p, maj: area ? r(2 * Math.sqrt(area / Math.PI) * 60, 1) : undefined, vis: op === undefined ? undefined : op >= 5 ? 1 : op >= 3 ? 2 : 3, ids, names: [] }];
      }),
  },
  {
    key: 'rc3',
    title: 'Galaxies (RC3, Third Reference Catalogue of Bright Galaxies)',
    cite: 'de Vaucouleurs G. et al., Third Reference Catalogue of Bright Galaxies, 1991 (VizieR VII/155)',
    load: async () =>
      (await vizier('VII/155/rc3', ['name', 'altname', 'PGC', 'type', 'D25', 'R25', 'PA', 'BT', 'Bmag'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const ids: string[] = [];
        const pgc = row.PGC.match(/(\d+)/);
        if (pgc) ids.push(`PGC ${Number(pgc[1])}`);
        const name = row.name.replace(/\s+/g, ' ').trim();
        const nm = name.match(/^(NGC|IC) ?(\d+)\s*([A-Z]?)$/);
        if (nm) ids.unshift(`${nm[1]} ${nm[2]}${nm[3]}`);
        const alt = row.altname.replace(/\s+/g, ' ').trim();
        const am = alt.match(/^(UGC|ESO|MCG|CGCG|UGCA|DDO|IRAS|Mrk|MRK) ?(.+)$/);
        if (am) ids.push(am[1] === 'UGC' ? `UGC ${Number(am[2])}` : `${am[1]} ${am[2].replace(/\s+/g, '')}`);
        const d25 = num(row.D25);
        const r25 = num(row.R25);
        const maj = d25 !== undefined ? 10 ** d25 / 10 : undefined;
        const id = ids.find((x) => /^(NGC|IC|UGC) /.test(x)) ?? ids[0];
        if (!id) return [];
        return [{ id, type: 'G', ...p, maj: r(maj, 2), min: maj !== undefined && r25 !== undefined ? r(maj / 10 ** r25, 2) : undefined, pa: num(row.PA), mag: num(row.BT) ?? num(row.Bmag), ids: ids.filter((x) => x !== id), names: [] }];
      }),
  },
  {
    key: 'arp',
    title: 'Arp peculiar galaxies',
    cite: 'Arp H., Atlas of Peculiar Galaxies, 1966 (VizieR VII/192)',
    near: { types: ['G', 'GPair', 'GTrpl', 'GGroup'], tol: () => 1 },
    load: async () =>
      (await vizier('VII/192/arpord', ['Arp', 'Name', 'Size'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const name = row.Name.replace(/\s+/g, ' ').trim();
        const m = name.match(/^(NGC|IC|UGC|MCG|CGCG|PGC|ESO) ?(\S+)/);
        return [{ id: `Arp ${Number(row.Arp)}`, type: 'G', ...p, maj: num(row.Size), ids: m ? [`${m[1]} ${m[1] === 'UGC' || m[1] === 'NGC' || m[1] === 'IC' ? Number(m[2]) || m[2] : m[2]}`] : [], names: [] }];
      }),
  },
  {
    key: 'hcg',
    title: 'Hickson compact galaxy groups',
    cite: 'Hickson P., Systematic properties of compact groups of galaxies, 1982 (VizieR VII/213)',
    load: async () =>
      (await vizier('VII/213/groups', ['HCG', 'AngSize', 'Totmag'])).flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        return [{ id: `HCG ${Number(row.HCG)}`, type: 'GGroup', ...p, maj: num(row.AngSize), mag: num(row.Totmag), ids: [], names: [] }];
      }),
  },
  {
    key: 'aco',
    title: 'Abell galaxy clusters (ACO, distance class ≤ 4)',
    cite: 'Abell G.O., Corwin H.G., Olowin R.P., A catalog of rich clusters of galaxies, 1989 (VizieR VII/110A)',
    load: async () =>
      [
        ...(await vizier('VII/110A/table3', ['ACO', 'Dclass', 'z'], { Dclass: '<=4' })),
        ...(await vizier('VII/110A/table4', ['ACO', 'Dclass', 'z'], { Dclass: '<=4' })),
      ].flatMap((row) => {
        const p = pos(row);
        if (!p) return [];
        const z = num(row.z);
        // A quarter of the Abell diameter (2 × 1.5 h⁻¹ Mpc, the bright core), from the redshift when there is one.
        const maj = z ? r(((2 * (1.5 / 0.7)) / ((z * 299792) / 70)) * (180 / Math.PI) * 60 * 0.25, 0) : undefined;
        return [{ id: `ACO ${Number(row.ACO)}`, type: 'GClstr', ...p, maj, ids: [], names: [] }];
      }),
  },
  {
    key: 'bsc',
    title: 'Bright stars (Yale Bright Star Catalogue, 5th ed.)',
    cite: 'Hoffleit D., Warren W.H., The Bright Star Catalogue, 5th Revised Ed., 1991 (VizieR V/50)',
    load: async () =>
      (await vizier('V/50/catalog', ['HR', 'Name', 'HD', 'Vmag', 'Multiple', 'ADS'])).flatMap((row) => {
        const p = pos(row);
        if (!p || !row.Vmag) return [];
        const ids: string[] = [];
        const nm = row.Name.match(/^(\d*)\s*([A-Za-z]{2,3})?\s*(\d?)\s*([A-Z][A-Za-z]{2})$/);
        if (nm) {
          const greek = nm[2] ? greekSymbol(nm[2]) : undefined;
          if (greek) ids.push(`${greek}${nm[3]} ${nm[4]}`);
          if (nm[1]) ids.push(`${Number(nm[1])} ${nm[4]}`);
        }
        if (row.HD) ids.push(`HD ${Number(row.HD)}`);
        return [{ id: `HR ${Number(row.HR)}`, type: row.Multiple || row.ADS ? '**' : '*', ...p, mag: num(row.Vmag), ids, names: [] }];
      }),
  },
  {
    key: 'iau',
    title: 'IAU star names (WGSN)',
    cite: 'IAU Working Group on Star Names, IAU Catalog of Star Names (www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt)',
    load: async () => {
      const text = await cached('IAU-CSN.txt', 'https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt');
      const out: Rec[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line || /^[#$]/.test(line)) continue;
        // fixed columns are unreliable across editions: split on 2+ spaces, the name is first
        const f = line.split(/\s{2,}|\t/).map((s) => s.trim());
        const name = f[0];
        const m = line.match(/(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+\d{4}-\d\d-\d\d/);
        if (!name || !m) continue;
        const desig = line.slice(36, 49).trim();
        const hd = line.match(/\s(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+\d{4}-/);
        const ids: string[] = [];
        if (/^(HR|HD|HIP) \d+$/.test(desig)) ids.push(desig);
        if (hd) ids.push(`HD ${hd[1]}`);
        const mag = line.match(/\s(-?\d+\.\d\d)\s+[A-Za-z]{1,2}\s+(?:\d+|_)\s/);
        out.push({ id: name, type: '*', ra: Number(m[1]) / 15, dec: Number(m[2]), mag: mag ? Number(mag[1]) : undefined, ids, names: [] });
      }
      return out;
    },
  },
];
const openNgcDups: [string, string][] = [];

// ------------------------------------------------------------------ merge

const objects: Obj[] = [];
const byKey = new Map<string, Obj>();
const grid = new Map<string, Obj[]>(); // 1°×1° cells
const cell = (raH: number, dec: number) => `${Math.floor(raH * 15)}:${Math.floor(dec)}`;

function addKeys(o: Obj, list: string[]): void {
  for (const k of list) {
    const key = normalizeName(k);
    if (key && !byKey.has(key)) byKey.set(key, o);
  }
}

function sepArcmin(ra1: number, d1: number, ra2: number, d2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((d2 - d1) * rad) / 2) ** 2 + Math.cos(d1 * rad) * Math.cos(d2 * rad) * Math.sin(((ra2 - ra1) * 15 * rad) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a))) * 180 * 60) / Math.PI;
}

function nearest(rec: Rec, near: NonNullable<Source['near']>): Obj | null {
  const reach = Math.min(180, Math.ceil(((rec.maj ?? 4) * 0.5 + 2) / 60) + 1);
  const raSpan = Math.abs(rec.dec) > 85 ? 360 : Math.min(360, Math.ceil(reach / Math.cos((rec.dec * Math.PI) / 180)));
  const types = new Set(near.types);
  let best: Obj | null = null;
  let bestScore = Infinity;
  const ra0 = Math.floor(rec.ra * 15);
  const dec0 = Math.floor(rec.dec);
  for (let dd = -reach; dd <= reach; dd++) {
    for (let dr = -raSpan; dr <= raSpan; dr++) {
      for (const o of grid.get(`${(((ra0 + dr) % 360) + 360) % 360}:${dec0 + dd}`) ?? []) {
        if (!types.has(o.type)) continue;
        const tol = near.tol(rec, o);
        if (tol === null) continue;
        const sep = sepArcmin(rec.ra, rec.dec, o.ra, o.dec);
        if (sep <= tol && sep / tol < bestScore) {
          best = o;
          bestScore = sep / tol;
        }
      }
    }
    if (raSpan >= 360) break;
  }
  return best;
}

function insert(rec: Rec, source: string): Obj {
  const o: Obj = { ...rec, ids: [...rec.ids], names: [...rec.names], sources: [source] };
  objects.push(o);
  addKeys(o, [o.id, ...o.ids, ...o.names]);
  const k = cell(o.ra, o.dec);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k)!.push(o);
  return o;
}

function mergeInto(o: Obj, rec: Rec, source: string): void {
  if (!o.sources.includes(source)) o.sources.push(source);
  const have = new Set([o.id, ...o.ids, ...o.names].map(normalizeName));
  for (const d of [rec.id, ...rec.ids]) if (!have.has(normalizeName(d))) ((isDesignation(d) ? o.ids : o.names).push(d), have.add(normalizeName(d)));
  for (const n of rec.names) if (!have.has(normalizeName(n))) (o.names.push(n), have.add(normalizeName(n)));
  o.maj ??= rec.maj;
  o.min ??= o.maj === rec.maj ? rec.min : undefined;
  o.pa ??= rec.pa;
  o.mag ??= rec.mag;
  o.vis = o.vis === undefined ? rec.vis : rec.vis === undefined ? o.vis : Math.min(o.vis, rec.vis);
  addKeys(o, [rec.id, ...rec.ids, ...rec.names]);
}

function constellation(raH: number, dec: number): string {
  return A.Constellation(raH, dec).symbol;
}

// Display order of designations: the ones observers use first.
const ID_ORDER = ['M ', 'C ', 'NGC ', 'IC ', 'Sh2-', 'B ', 'vdB ', 'Cr ', 'Mel ', 'Tr ', 'Arp ', 'HCG ', 'Abell ', 'ACO ', 'LBN ', 'LDN ', 'Ced ', 'RCW ', 'Gum ', 'UGC ', 'PGC ', 'ESO ', 'MCG ', 'CGCG ', 'PN G', 'PK ', 'SNR G', 'HR ', 'HD ', 'HIP '];
function idRank(s: string): number {
  if (/^[α-ω]\d? /.test(s)) return -2;
  if (/^\d+ [A-Z]/.test(s)) return -1;
  const i = ID_ORDER.findIndex((p) => s.startsWith(p));
  return i < 0 ? ID_ORDER.length : i;
}

const fmt = (n: number | undefined, d: number) => (n === undefined || Number.isNaN(n) ? '' : String(Math.round(n * 10 ** d) / 10 ** d));
const clean = (s: string) => s.replace(/[\t|\r\n]+/g, ' ').trim();

async function main(): Promise<void> {
  const stats: { key: string; title: string; cite: string; records: number; added: number; merged: number }[] = [];
  for (const src of SOURCES) {
    console.log(`${src.key}: ${src.title}`);
    const recs = await src.load();
    let added = 0;
    let merged = 0;
    for (const rec of recs) {
      if (!Number.isFinite(rec.ra) || !Number.isFinite(rec.dec)) continue;
      let hit: Obj | null = null;
      for (const d of [rec.id, ...rec.ids]) {
        hit = byKey.get(normalizeName(d)) ?? null;
        // a designation shared by unrelated things (e.g. a star's HD number on a nebula entry) must still be nearby
        if (hit && sepArcmin(hit.ra, hit.dec, rec.ra, rec.dec) > Math.max(30, (hit.maj ?? 0) + (rec.maj ?? 0))) hit = null;
        // A cross-reference can name something inside the record rather than the record itself (LDN 1630,
        // the whole Orion B cloud, lists B 33, the Horsehead): sizes far apart are not the same object.
        if (hit && d !== rec.id && hit.maj && rec.maj && Math.max(hit.maj, rec.maj) / Math.min(hit.maj, rec.maj) > 5) {
          rec.ids = rec.ids.filter((x) => x !== d);
          hit = null;
        }
        if (hit) break;
      }
      if (!hit && src.near) hit = nearest(rec, src.near);
      if (hit) {
        mergeInto(hit, rec, src.key);
        merged++;
      } else {
        insert(rec, src.key);
        added++;
      }
    }
    if (src.key === 'openngc') {
      for (const [alias, target] of openNgcDups) {
        const o = byKey.get(normalizeName(target));
        if (o && !byKey.has(normalizeName(alias))) {
          o.ids.push(alias);
          addKeys(o, [alias]);
        }
      }
    }
    stats.push({ key: src.key, title: src.title, cite: src.cite, records: recs.length, added, merged });
    console.log(`  ${recs.length} records: ${added} new, ${merged} merged into existing objects`);
  }

  const lines = ['# id\ttype\tra_h\tdec_deg\tcon\tmaj_arcmin\tmin_arcmin\tpa\tmag\tsb\tvis\tnames\tids\tsources'];
  for (const o of objects) {
    const ids = [...new Set(o.ids.map(clean))].filter((x) => x && x !== o.id).sort((a, b) => idRank(a) - idRank(b));
    lines.push([
      clean(o.id), o.type, fmt(o.ra, 6), fmt(o.dec, 5), o.con || constellation(o.ra, o.dec), fmt(o.maj, 2), fmt(o.min, 2), fmt(o.pa, 0), fmt(o.mag, 2), fmt(o.sb, 2), fmt(o.vis, 0),
      [...new Set(o.names.map(clean))].join('|'), ids.join('|'), o.sources.join(','),
    ].join('\t'));
  }
  fs.writeFileSync(path.join(dir, 'objects.tsv'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'sources.json'), `${JSON.stringify({ built: new Date().toISOString().slice(0, 10), total: objects.length, sources: stats }, null, 2)}\n`);

  const byType = new Map<string, number>();
  for (const o of objects) byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
  console.log(`\n${objects.length} objects → ${path.join(dir, 'objects.tsv')}`);
  console.log([...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${TYPE_NAMES[t] ?? t}: ${n}`).join(', '));
}

await main();
