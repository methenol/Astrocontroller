/**
 * The catalogs merged into catalog/objects.tsv, in merge order: the first catalog that has an
 * object names it. Each loader turns its download into records; sizes are arcmin, positions J2000.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONSTELLATIONS, greekSymbol, isDesignation } from '../../astro/designations.js';
import { type Downloader, writeAtomic } from './fetch.js';
import { extendedTol } from './merge.js';
import { crossIds, ledaNames, num, pos, prettyGalaxyName, readOpenNgc, round, simbadId, simbadName, simbadObjects, type SimbadObject } from './parse.js';
import type { NearMatch, Rec, Source } from './types.js';

const OPENNGC_RAW = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files';
const IAU_CSN = 'https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt';
/** Speed of light (km/s) and the Hubble constant (km/s/Mpc) for Abell cluster sizes from redshift. */
const C_KMS = 299792;
const H0 = 70;
/** Abell's distance class 4 ends at a tenth-brightest member of m10 = 16.4 (Abell 1958): the cut for the supplementary clusters, which have no class. */
const ABELL_D4_M10 = 16.4;
/** Abell's planetary nebulae are Abell 1–86: an Abell cluster's "Abell N" alias starts above them. */
const ABELL_PN_MAX = 86;
/** HyperLEDA galaxies smaller than this (D25, arcmin) only add names to galaxies already listed, unless a classic catalog lists them. */
const LEDA_NEW_MIN_ARCMIN = 1;
/** Half-light radius → the extent a dwarf galaxy shows in a long exposure (as for the Harris globulars). */
const HALF_LIGHT_TO_DIAMETER = 4;

const NEBULAE = ['HII', 'EmN', 'Neb', 'RfN', 'Cl+N', 'SNR'];
const GALAXIES = ['G', 'GPair', 'GTrpl', 'GGroup'];

const vis3 = (n: number | undefined, map: Readonly<Record<number, number>>) => (n === undefined ? undefined : map[n]);
const pick = (map: Readonly<Record<string, number>>, k: string) => (Object.hasOwn(map, k) ? map[k] : undefined);

/** A circle's diameter (arcmin) from its area (square degrees). */
const areaDiameter = (deg2: number | undefined) => (deg2 && deg2 > 0 ? round(2 * Math.sqrt(deg2 / Math.PI) * 60, 1) : undefined);
/** Lynds-style opacity 1–6 → brightness class (dark nebulae: 1 = most opaque). */
const opacityClass = (op: number | undefined) => (op === undefined ? undefined : op >= 5 ? 1 : op >= 3 ? 2 : 3);

/**
 * Nearby dwarfs: sizes from different catalogs (half-light, Holmberg, D25) disagree widely, so a
 * position match only needs the sizes within 8×, which still keeps a background galaxy at the
 * centre of a degree-wide spheroidal apart from it.
 */
const dwarfNear: NearMatch = {
  types: GALAXIES,
  tol: (rec, o) => (o.maj && rec.maj && Math.max(o.maj, rec.maj) / Math.min(o.maj, rec.maj) > 8 ? null : 0.25 * Math.max(o.maj ?? 2, rec.maj ?? 2) + 1),
};

const CONSTELLATION_NAMES = new Set(CONSTELLATIONS.map(([, name]) => name));

// SIMBAD: every identifier of the objects a filter on one of them selects (one row per identifier).
const SIMBAD_COLUMNS = ['oid', 'ra', 'dec', 'otype', 'galdim_majaxis', 'galdim_minaxis', 'galdim_angle', 'hit', 'alt'] as const;
const simbadQuery = (hit: string, alt?: string) =>
  'SELECT b.oid, b.ra, b.dec, b.otype, b.galdim_majaxis, b.galdim_minaxis, b.galdim_angle, f.id AS hit, d.id AS alt ' +
  `FROM ident AS f JOIN basic AS b ON b.oid = f.oidref JOIN ident AS d ON d.oidref = f.oidref WHERE (${hit})${alt ? ` AND (${alt})` : ''}`;
/** The SIMBAD identifiers this database keeps, for the "alt" side of the names query (the rest are star, IR and radio surveys). */
const SIMBAD_DSO_IDS = ['NGC %', 'IC %', 'M %', 'SH %', 'LBN %', 'LDN %', 'Barnard %', 'VdB %', 'VdBH %', 'Ced %', 'RCW %', 'GUM %', 'PN G%', 'PN A66%', 'SNR G%', 'PGC %', 'LEDA %', 'UGC %', 'UGCA %', 'ESO %', 'MCG%', 'CGCG %', 'ACO %', 'HCG %', 'Arp %', 'DDO %', 'KDG %', 'VV %', 'Mrk %', 'Cl Collinder%', 'Cl Melotte%', 'Cl Trumpler%', 'LHA %']
  .map((p) => `d.id LIKE '${p}'`).join(' OR ');
/** SIMBAD object types whose identifiers are the object itself (a nebula or cluster), not the star that lights it. */
const SIMBAD_EXTENDED = /^(?:HII|SNR|PN|PN\?|AG\?|RNe|DNe|ISM|Cld|GNe|EmO|MoC|SFR|OpC|Cl\*|GlC|As\*|glb|bub|G|GiG|GiC|GiP|BiC|IG|PaG|GrG|CGG|ClG|SCG|EmG|SBG|H2G|bCG|LSB|AGN|SyG|Sy1|Sy2|LIN|BLL)$/;
const SIMBAD_TYPE: Readonly<Record<string, string>> = { SNR: 'SNR', PN: 'PN', RNe: 'RfN', DNe: 'DrkN', OpC: 'Cl+N', 'Cl*': 'Cl+N' };

/**
 * Well-known regions no catalog here lists, placed and sized by SIMBAD: the SIMBAD identifier,
 * and the designation, type and names they get here. Ou 4 (the Squid Nebula) is filed in SIMBAD
 * on the double star HD 202214 at its centre, with the nebula's 69′ extent.
 */
export const NAMED_REGIONS: readonly { simbad: string; id: string; type: string; names: readonly string[] }[] = [
  { simbad: 'NAME GUM Nebula', id: 'Gum 12', type: 'HII', names: ['Gum Nebula'] },
  { simbad: 'NAME PN Ou 4', id: 'Ou 4', type: 'EmN', names: ['Squid Nebula'] },
  { simbad: 'NAME Pipe Nebula', id: 'Pipe Nebula', type: 'DrkN', names: [] },
  { simbad: 'NAME Ophiuchus Molecular Cloud', id: 'Rho Ophiuchi Cloud Complex', type: 'Neb', names: ['Ophiuchus Molecular Cloud'] },
  { simbad: 'NAME Polaris Flare', id: 'Polaris Flare', type: 'Neb', names: [] },
  { simbad: 'NAME Virgo Cluster', id: 'Virgo Cluster', type: 'GClstr', names: [] },
];

/**
 * One SIMBAD object as a record named by the first of `keys` (its identifiers the query matched),
 * with its other identifiers in this database's spelling and its common names. A star that SIMBAD
 * files a nebula designation on (the exciting star of a Gum region) gives its position only.
 */
function simbadRecord(o: SimbadObject, keys: readonly string[], type: string): Rec | null {
  const id = keys.map(simbadId).find((x): x is string => x !== null);
  if (!id) return null;
  const extended = SIMBAD_EXTENDED.test(o.otype);
  const ids = extended ? [...new Set(o.idents.map(simbadId).filter((x): x is string => x !== null && x !== id))] : [];
  const names = extended ? [...new Set(o.idents.map(simbadName).filter((x): x is string => x !== null))] : [];
  return { id, type, ra: o.ra, dec: o.dec, maj: extended ? o.maj : undefined, min: extended ? o.min : undefined, pa: extended ? o.pa : undefined, ids, names };
}

export interface SourceEnv {
  /** the catalog directory (OpenNGC CSVs live here) */
  dir: string;
  fresh: boolean;
  download: Downloader;
}

export function sources(env: SourceEnv): Source[] {
  const { dir, fresh, download } = env;
  const vizier = download.vizier.bind(download);
  const simbad = async (name: string, hit: string, alt?: string) => simbadObjects(await download.simbad(name, simbadQuery(hit, alt), SIMBAD_COLUMNS));
  /** HyperLEDA's multiple systems ("M"): their names are added, but they never become objects of their own. */
  const ledaMultiple = new Set<string>();
  return [
    {
      key: 'openngc',
      title: 'OpenNGC (NGC, IC, Messier, Caldwell and addendum)',
      cite: 'Mattia Verga, OpenNGC, CC-BY-SA 4.0, github.com/mattiaverga/OpenNGC',
      load: async () => {
        const records: Rec[] = [];
        const aliases: [string, string][] = [];
        for (const f of ['NGC.csv', 'addendum.csv']) {
          const file = path.join(dir, f);
          if (!fs.existsSync(file) || fresh) writeAtomic(file, await download.text(`openngc-${f}`, `${OPENNGC_RAW}/${f}`));
          const part = readOpenNgc(file);
          records.push(...part.records);
          aliases.push(...part.aliases);
        }
        return { records, aliases };
      },
    },
    {
      key: 'harris',
      classifies: true,
      title: 'Globular clusters (Harris 2010)',
      cite: 'Harris W.E., Catalog of Parameters for Milky Way Globular Clusters, 2010 edition (VizieR VII/202)',
      near: { types: ['GCl'], tol: () => 1.5 },
      load: async () => ({
        records: (await vizier('VII/202/catalog', ['ID', 'Name', 'Vt', 'Rh'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const id = row.ID.replace(/^Pal\s+/, 'Pal ').replace(/\s+/g, ' ');
          const rh = num(row.Rh);
          return [{ id, type: 'GCl', ...p, mag: num(row.Vt), maj: rh ? round(rh * 4, 1) : undefined, ids: [], names: row.Name ? [row.Name] : [] }];
        }),
      }),
    },
    {
      key: 'dias',
      classifies: true,
      title: 'Open clusters (Dias et al. 2002, v3.5)',
      cite: 'Dias W.S., Alessi B.S., Moitinho A., Lepine J.R.D., New catalogue of optically visible open clusters and candidates (VizieR B/ocl)',
      near: { types: ['OCl', 'Cl+N', '*Ass'], tol: (rec, o) => (o.maj && rec.maj && Math.max(o.maj, rec.maj) / Math.min(o.maj, rec.maj) > 3 ? null : 0.2 * Math.max(o.maj ?? 2, rec.maj ?? 2) + 1) },
      load: async () => ({
        records: (await vizier('B/ocl/clusters', ['Cluster', 'Diam', 'Dist', 'Class'])).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.Cluster) return [];
          const id = row.Cluster.replace(/_/g, ' ').replace(/^Collinder /, 'Cr ').replace(/^Melotte /, 'Mel ').replace(/^Trumpler /, 'Tr ');
          return [{ id, type: 'OCl', ...p, maj: num(row.Diam), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'pn',
      classifies: true,
      title: 'Planetary nebulae (Strasbourg-ESO catalogue)',
      cite: 'Acker A. et al., Strasbourg-ESO Catalogue of Galactic Planetary Nebulae, 1992 (VizieR V/84)',
      near: { types: ['PN'], tol: () => 0.5 },
      load: async () => {
        const diam = new Map((await vizier('V/84/diam', ['PNG', 'oDiam'])).map((d) => [d.PNG, num(d.oDiam)]));
        const records = (await vizier('V/84/main', ['PNG', 'Name', 'PK', 'Idents'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const name = row.Name.replace(/\s+/g, ' ').replace(/(\d)- (\d)/, '$1-$2').trim(); // "M 1- 1" -> "M 1-1" (Minkowski)
          const ids = [`PN G${row.PNG}`, ...crossIds(row.Idents)];
          const abell = name.match(/^A(?:bell)? ?(\d+)$/);
          const id = abell ? `Abell ${abell[1]}` : /^(NGC|IC) /.test(name) ? name : `PN G${row.PNG}`;
          if (id !== name && !abell) ids.push(name);
          const d = diam.get(row.PNG);
          return [{ id, type: 'PN', ...p, maj: d ? round(d / 60, 2) : undefined, ids: ids.filter((x) => x !== id), names: [] }];
        });
        return { records };
      },
    },
    {
      key: 'mash',
      classifies: true,
      title: 'Planetary nebulae (Macquarie/AAO/Strasbourg Hα survey, MASH I+II)',
      cite: 'Phillipps S. et al., The Macquarie/AAO/Strasbourg Hα Planetary Nebula Catalogue (MASH), 2005 (MNRAS 359, 1001) and MASH-II, 2008 (MNRAS 384, 525; VizieR V/127A)',
      near: { types: ['PN'], tol: () => 0.5 },
      load: async () => {
        const rows = [
          ...(await vizier('V/127A/mash1', ['PNG', 'Name', 'MajDiam', 'MinDiam'])),
          ...(await vizier('V/127A/mash2', ['PNG', 'Name', 'MajDiam', 'MinDiam'])),
        ];
        const records = rows.flatMap((row) => {
          const p = pos(row);
          if (!p || !row.PNG) return [];
          // MASH lists the PNG in galactic coordinates with a leading G ("G209.1-08.2"); the Strasbourg-ESO id is "PN G209.1-08.2"
          const png = row.PNG.replace(/^G/, '').trim();
          const maj = num(row.MajDiam);
          const min = num(row.MinDiam);
          const ids = row.Name ? [row.Name.replace(/\s+/g, ' ').trim()] : [];
          return [{ id: `PN G${png}`, type: 'PN', ...p, maj: maj ? round(maj / 60, 2) : undefined, min: min ? round(min / 60, 2) : undefined, ids, names: [] }];
        });
        return { records };
      },
    },
    {
      key: 'simbad-pn',
      classifies: true,
      title: 'Planetary nebulae (SIMBAD: confirmed PNe with a PN G designation)',
      cite: 'Wenger M. et al., The SIMBAD astronomical database, 2000 (A&AS 143, 9), CDS Strasbourg: objects SIMBAD classifies as planetary nebulae, including the discoveries since the Strasbourg-ESO and MASH catalogues (Kn, Pa, Ou…)',
      near: { types: ['PN'], tol: () => 0.5 },
      load: async () => ({
        records: (await simbad('pn', "f.id LIKE 'PN G%' AND b.otype = 'PN'")).flatMap((o) => simbadRecord(o, o.keys, 'PN') ?? []),
      }),
    },
    {
      key: 'green',
      classifies: true,
      title: 'Supernova remnants (Green 2024)',
      cite: 'Green D.A., A catalogue of 310 Galactic supernova remnants, 2024 (VizieR VII/297)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/297/snrs', ['SNR', 'MajDiam', 'MinDiam', 'Names'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          // Green brackets names that cover only part of the remnant; radio designations ("3C58", "W44", "CTB 1") are ids
          const names = row.Names.split(',').map((s) => s.trim().replace(/^\((.*)\)$/, '$1')).filter(Boolean);
          const radio = (n: string) => /\d/.test(n);
          return [{ id: `SNR G${row.SNR.replace(/^G/, '')}`, type: 'SNR', ...p, maj: num(row.MajDiam), min: num(row.MinDiam), ids: names.filter(radio), names: names.filter((n) => !radio(n)) }];
        }),
      }),
    },
    {
      key: 'sh2',
      classifies: true,
      title: 'Sharpless HII regions (Sh2)',
      cite: 'Sharpless S., A Catalogue of H II Regions, 1959 (VizieR VII/20)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/20/catalog', ['Sh2', 'Diam', 'Bright'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          return [{ id: `Sh2-${Number(row.Sh2)}`, type: 'HII', ...p, maj: num(row.Diam), vis: vis3(num(row.Bright), { 3: 1, 2: 2, 1: 3 }), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'rcw',
      classifies: true,
      title: 'RCW southern HII regions',
      cite: 'Rodgers A.W., Campbell C.T., Whiteoak J.B., A catalogue of H-alpha emission regions in the southern Milky Way, 1960 (VizieR VII/216)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/216/rcw', ['RCW', 'MajAxis', 'MinAxis', 'Br', 'IDs'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const ids = crossIds(row.IDs);
          for (const g of row.IDs.matchAll(/(?:^|;)\s*G(\d+)/g)) ids.push(`Gum ${g[1]}`);
          return [{ id: `RCW ${Number(row.RCW)}`, type: 'HII', ...p, maj: num(row.MajAxis), min: num(row.MinAxis), vis: pick({ b: 1, m: 2, f: 3 }, row.Br), ids, names: [] }];
        }),
      }),
    },
    {
      key: 'gum',
      title: 'Gum southern HII regions',
      cite: 'Gum C.S., A study of diffuse southern H-alpha nebulae, 1955 (MmRAS 67, 155); positions and cross-identifications from SIMBAD (CDS)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await simbad('gum', "f.id LIKE 'GUM %'")).flatMap((o) => simbadRecord(o, o.keys, SIMBAD_TYPE[o.otype] ?? 'HII') ?? []),
      }),
    },
    {
      key: 'henize',
      title: 'Henize nebulae of the Magellanic Clouds (LHA 120-N, LHA 115-N)',
      cite: 'Henize K.G., Catalogues of H-alpha-emission stars and nebulae in the Magellanic Clouds, 1956 (ApJS 2, 315); positions, sizes and cross-identifications from SIMBAD (CDS)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await simbad('henize', "f.id LIKE 'LHA 120-N %' OR f.id LIKE 'LHA 115-N %'")).flatMap((o) => {
          // the numbered nebulae, not their lettered parts (N 159A…W)
          const keys = o.keys.filter((k) => /^LHA 1(?:20|15)-N\s+\d+$/.test(k.replace(/\s+/g, ' ')));
          const rec = keys.length ? simbadRecord(o, keys, SIMBAD_TYPE[o.otype] ?? 'HII') : null;
          if (!rec) return [];
          const m = /^LHA (120|115)-N (\d+)$/.exec(rec.id);
          // what observers write: "LMC N11", "SMC N66"
          if (m) rec.ids.push(`${m[1] === '120' ? 'LMC' : 'SMC'} N${m[2]}`);
          return [rec];
        }),
      }),
    },
    {
      key: 'ced',
      title: 'Cederblad bright diffuse nebulae',
      cite: 'Cederblad S., Catalog of Bright Diffuse Galactic Nebulae, 1946 (VizieR VII/231)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/231/catalog', ['Ced', 'm_Ced', 'Name', 'Dim1', 'Dim2'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          return [{ id: `Ced ${Number(row.Ced)}${row.m_Ced ?? ''}`, type: 'Neb', ...p, maj: num(row.Dim1), min: num(row.Dim2), ids: crossIds(row.Name), names: [] }];
        }),
      }),
    },
    {
      key: 'lbn',
      title: 'Lynds bright nebulae (LBN)',
      cite: 'Lynds B.T., Catalogue of Bright Nebulae, 1965 (VizieR VII/9)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/9/catalog', ['Seq', 'Diam1', 'Diam2', 'Bright', 'Name'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const ids: string[] = [];
          // the brightest-known designation: S = Sharpless, C = Cederblad, DG = Dorschner & Gürtler
          const x = row.Name.match(/^(S|C|DG|NGC|IC)\s*(\d+[a-z]?)/);
          if (x) ids.push(x[1] === 'S' ? `Sh2-${Number(x[2])}` : x[1] === 'C' ? `Ced ${x[2]}` : `${x[1]} ${x[2]}`);
          const b = num(row.Bright);
          return [{ id: `LBN ${Number(row.Seq)}`, type: 'Neb', ...p, maj: num(row.Diam1), min: num(row.Diam2), vis: b === undefined ? undefined : b <= 1 ? 1 : b <= 3 ? 2 : 3, ids, names: [] }];
        }),
      }),
    },
    {
      key: 'vdb',
      classifies: true,
      title: 'van den Bergh reflection nebulae (vdB)',
      cite: 'van den Bergh S., A study of reflection nebulae, 1966 (VizieR VII/21)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/21/catalog', ['VdB', 'Vmag', 'SurfBr', 'BRadMax', 'RRadMax'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const rad = num(row.BRadMax) ?? num(row.RRadMax);
          return [{ id: `vdB ${Number(row.VdB)}`, type: 'RfN', ...p, maj: rad ? round(rad * 2, 1) : undefined, vis: pick({ Br: 1, M: 2, F: 3 }, row.SurfBr), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'vdbh',
      classifies: true,
      title: 'van den Bergh & Herbst southern reflection nebulae (vdBH)',
      cite: 'van den Bergh S., Herbst W., Southern stars embedded in nebulosity, 1975 (AJ 80, 208; VizieR VII/218)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/218/catalog', ['BHe', 'm_BHe', 'IDs', 'Br', 'BDiam', 'RDiam'])).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.BHe) return [];
          const maj = num(row.BDiam) ?? num(row.RDiam);
          return [{ id: `vdBH ${Number(row.BHe)}${row.m_BHe}`, type: 'RfN', ...p, maj, vis: pick({ vBr: 1, Br: 1, M: 2, F: 3, vF: 3 }, row.Br), ids: crossIds(row.IDs), names: [] }];
        }),
      }),
    },
    {
      key: 'magakian',
      classifies: true,
      title: 'Reflection nebulae (Magakian merged catalogue: DG, vdBH, Bernes, RK, GN)',
      cite: 'Magakian T.Yu., Merged catalogue of reflection nebulae, 2003 (A&A 399, 141; VizieR J/A+A/399/141)',
      near: { types: NEBULAE, tol: extendedTol },
      load: async () => ({
        records: (await vizier('J/A+A/399/141/table1', ['Seq', 'DG', 'DG2', '[RK68]', 'VdB', 'VdBH', '[B77]', 'NGC/IC', 'GN', 'Ced', 'Other'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const n = (s: string) => s.replace(/^0+(?=\d)/, '');
          const ced = /^(\d+[a-z]?)/.exec(row.Ced);
          // the designation observers know best first: it names the object when no catalog before this one has it
          // NGC/IC written "N1333", "IC59,IC63", "IC359a" (a part: the object is IC 359)
          const ngcIc = row['NGC/IC'].split(',').flatMap((t) => {
            const m = /^(N|IC)\s*0*(\d+)[a-z]?$/.exec(t.trim());
            return m ? [`${m[1] === 'N' ? 'NGC' : 'IC'} ${m[2]}`] : [];
          });
          const ids = [
            ...ngcIc,
            ...(row.VdB ? [`vdB ${n(row.VdB)}`] : []),
            ...(row.VdBH ? [`vdBH ${n(row.VdBH)}`] : []),
            ...(row.DG ? [`DG ${n(row.DG)}`] : []),
            ...(row.DG2 ? [`DG ${n(row.DG2)}`] : []),
            ...(ced ? [`Ced ${n(ced[1])}`] : []),
            ...(row['[RK68]'] ? [`RK ${n(row['[RK68]'])}`] : []),
            ...(row['[B77]'] ? [`Bernes ${n(row['[B77]'])}`] : []),
            ...(row.GN ? [`GN ${row.GN}`] : []),
            ...crossIds(row.Other),
          ];
          const [id = `[M2003] ${Number(row.Seq)}`, ...rest] = ids;
          return [{ id, type: 'RfN', ...p, ids: rest, names: [] }];
        }),
      }),
    },
    {
      key: 'barnard',
      classifies: true,
      title: 'Barnard dark nebulae',
      cite: 'Barnard E.E., Catalogue of 349 dark objects in the sky, 1927 (VizieR VII/220A)',
      near: { types: ['DrkN'], tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/220A/barnard', ['Barn', 'Diam'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          return [{ id: `B ${row.Barn.replace(/^0+/, '').trim()}`, type: 'DrkN', ...p, maj: num(row.Diam), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'ldn',
      classifies: true,
      title: 'Lynds dark nebulae (LDN)',
      cite: 'Lynds B.T., Catalogue of Dark Nebulae, 1962 (VizieR VII/7A)',
      near: { types: ['DrkN'], tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/7A/ldn', ['LDN', 'Area', 'Opacity', 'Barn'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const area = num(row.Area);
          const op = num(row.Opacity);
          const ids = row.Barn.split(/[ ,]+/).filter((b) => /^\d+[a-z]?$/i.test(b)).map((b) => `B ${b.replace(/^0+/, '')}`);
          return [{ id: `LDN ${Number(row.LDN)}`, type: 'DrkN', ...p, maj: area ? round(2 * Math.sqrt(area / Math.PI) * 60, 1) : undefined, vis: op === undefined ? undefined : op >= 5 ? 1 : op >= 3 ? 2 : 3, ids, names: [] }];
        }),
      }),
    },
    {
      key: 'hartley',
      classifies: true,
      title: 'Southern dark clouds (Hartley et al.)',
      cite: 'Hartley M., Manchester R.N., Smith R.M., Tritton S.B., Goss W.M., A catalogue of southern dark clouds, 1986 (A&AS 63, 27; VizieR VII/191)',
      near: { types: ['DrkN'], tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/191/table1', ['DCld', 'Size1', 'Size2', 'Density'])).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.DCld) return [];
          // density A is the most opaque (Lynds 6), C the least (Lynds ≤ 3)
          return [{ id: `DCld ${row.DCld}`, type: 'DrkN', ...p, maj: num(row.Size1), min: num(row.Size2), vis: pick({ A: 1, B: 2, C: 3 }, row.Density), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'fest',
      classifies: true,
      title: 'Southern dark nebulae (Feitzinger & Stüwe, FeSt)',
      cite: 'Feitzinger J.V., Stüwe J.A., Dark nebulae, globules and cometary globules in the southern Milky Way, 1984 (A&AS 58, 365; VizieR VII/68A)',
      near: { types: ['DrkN'], tol: extendedTol },
      load: async () => ({
        records: (await vizier('VII/68A/darkneb', ['FEST', 'Area', 'OpClass', 'Ident'])).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.FEST) return [];
          // "CG 4": Zealey et al.'s cometary globules
          const ids = [...row.Ident.matchAll(/\bCG ?(\d+)/g)].map((m) => `CG ${Number(m[1])}`);
          return [{ id: `FeSt 1-${Number(row.FEST)}`, type: 'DrkN', ...p, maj: areaDiameter(num(row.Area)), vis: opacityClass(num(row.OpClass)), ids, names: [] }];
        }),
      }),
    },
    {
      key: 'rc3',
      classifies: true,
      title: 'Galaxies (RC3, Third Reference Catalogue of Bright Galaxies)',
      cite: 'de Vaucouleurs G. et al., Third Reference Catalogue of Bright Galaxies, 1991 (VizieR VII/155)',
      load: async () => ({
        records: (await vizier('VII/155/rc3', ['name', 'altname', 'PGC', 'type', 'D25', 'R25', 'PA', 'BT', 'Bmag'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const ids: string[] = [];
          const pgc = row.PGC.match(/(\d+)/);
          if (pgc) ids.push(`PGC ${Number(pgc[1])}`);
          const name = row.name.replace(/\s+/g, ' ').trim();
          const nm = name.match(/^(NGC|IC) ?(\d+)\s*([A-Z]?)$/);
          if (nm) ids.unshift(`${nm[1]} ${nm[2]}${nm[3]}`);
          const alt = row.altname.replace(/\s+/g, ' ').trim();
          // UGCA before UGC: "UGCA 34" is not UGC number "A 34"
          const am = alt.match(/^(UGCA|UGC|ESO|MCG|CGCG|DDO|IRAS|Mrk|MRK) ?(.+)$/);
          if (am) ids.push(`${am[1]} ${am[2].replace(/\s+/g, '').replace(/^0+(?=\d)/, '')}`);
          const d25 = num(row.D25);
          const r25 = num(row.R25);
          const maj = d25 !== undefined ? 10 ** d25 / 10 : undefined;
          const id = ids.find((x) => /^(NGC|IC|UGCA?) /.test(x)) ?? ids[0];
          if (!id) return [];
          return [{ id, type: 'G', ...p, maj: round(maj, 2), min: maj !== undefined && r25 !== undefined ? round(maj / 10 ** r25, 2) : undefined, pa: num(row.PA), mag: num(row.BT) ?? num(row.Bmag), ids: ids.filter((x) => x !== id), names: [] }];
        }),
      }),
    },
    {
      key: 'pgc',
      classifies: true,
      title: 'Galaxies (Principal Galaxies Catalogue, PGC/LEDA)',
      cite: 'Paturel C. et al., Principal Galaxies Catalogue and LEDA, 2003 (A&A 412, 45; VizieR VII/119B)',
      // most PGC entries merge into an RC3/OpenNGC galaxy by their shared "PGC N" designation; this catches the
      // few that lack it, requiring the sizes to agree so a background galaxy at the same spot stays separate
      near: { types: ['G', 'GPair', 'GTrpl', 'GGroup'], tol: (rec, o) => (o.maj && rec.maj && Math.max(o.maj, rec.maj) / Math.min(o.maj, rec.maj) > 3 ? null : 0.5) },
      load: async () => ({
        // the 25 mag/arcsec² isophote; MajAxis>=0.1′ drops the unresolved point-like entries
        records: (await vizier('VII/119B/pgc', ['PGC', 'MType', 'MajAxis', 'MinAxis', 'Btot'], { MajAxis: '>=0.1' })).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.PGC) return [];
          const id = `PGC ${Number(row.PGC)}`;
          return [{ id, type: 'G', ...p, maj: num(row.MajAxis), min: num(row.MinAxis), mag: num(row.Btot), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'leda',
      classifies: true,
      title: 'Galaxies (HyperLEDA: D25 sizes and UGC, ESO, MCG, CGCG, Mrk, DDO… designations)',
      cite: 'Paturel G. et al., HYPERLEDA. I. Identification and designation of galaxies, 2003 (A&A 412, 45; VizieR VII/237)',
      near: { types: GALAXIES, tol: (rec, o) => (o.maj && rec.maj && Math.max(o.maj, rec.maj) / Math.min(o.maj, rec.maj) > 3 ? null : 0.5) },
      // names for the galaxies already here; a new galaxy only when it is ≥ 1′ or a classic catalog lists it
      create: (rec) => !ledaMultiple.has(rec.id) && ((rec.maj ?? 0) >= LEDA_NEW_MIN_ARCMIN || rec.ids.some((x) => /^(?:NGC|IC|UGC|UGCA|DDO|KDG|Arp|VV|Mrk|HCG) /.test(x))),
      load: async () => ({
        // D25 ≥ 0.5′ (logD25 is in 0.1′ units): 160 000 galaxies; the smaller ones are not imaging targets
        records: (await vizier('VII/237/pgc', ['PGC', 'OType', 'logD25', 'logR25', 'PA', 'ANames'], { logD25: '>=0.7' })).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.PGC) return [];
          const id = `PGC ${Number(row.PGC)}`;
          if (row.OType === 'M') ledaMultiple.add(id);
          const d = num(row.logD25);
          const r = num(row.logR25);
          const maj = d === undefined ? undefined : 0.1 * 10 ** d;
          return [{ id, type: 'G', ...p, maj: round(maj, 2), min: maj !== undefined && r !== undefined ? round(maj / 10 ** r, 2) : undefined, pa: num(row.PA), ids: ledaNames(row.ANames), names: [] }];
        }),
      }),
    },
    {
      key: 'lg',
      classifies: true,
      title: 'Local Group dwarf galaxies (McConnachie 2012)',
      cite: 'McConnachie A.W., The observed properties of dwarf galaxies in and around the Local Group, 2012 (AJ 144, 4; VizieR J/AJ/144/4)',
      near: dwarfNear,
      load: async () => ({
        records: (await vizier('J/AJ/144/4/catalog', ['Name', 'OName', 'MType', 'Vmag', 'R1', 'PA', 'Ell'])).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.Name || row.Name === 'The Galaxy') return [];
          const names: string[] = [];
          const ids: string[] = [];
          // "Segue (I)" → "Segue 1"; "Sextans (I)" → "Sextans I"; "WLM (Wolf-Lundmark-Melotte)" → WLM, named Wolf-Lundmark-Melotte
          let name = row.Name.replace(/\s+/g, ' ').trim().replace(/ 3\(A\)$/, ' 3A');
          const first = / \(I\)$/.test(name);
          const paren = / \(([^)]+)\)$/.exec(name);
          if (paren) {
            name = name.slice(0, paren.index);
            if (paren[1] === 'I') name += ' I';
            else names.push(paren[1]);
          }
          name = name.replace(/^Segue I$/, 'Segue 1').replace(/^Segue II$/, 'Segue 2');
          const base = first ? name.replace(/ I$/, '') : name;
          // a constellation's dwarf: "Fornax" is the Fornax Dwarf, not the constellation (Andromeda and Triangulum are M31 and M33)
          if (CONSTELLATION_NAMES.has(base) && !/^S/.test(row.MType)) {
            // "Boötes I" is the name; "Bootes Dwarf" what it was called before Boötes II was found
            if (base !== name) names.push(name);
            names.push(`${base} Dwarf`);
          } else (isDesignation(prettyGalaxyName(name)) ? ids : names).push(prettyGalaxyName(name));
          for (const alt of row.OName.split(',').map((s) => s.trim()).filter(Boolean)) (isDesignation(prettyGalaxyName(alt)) ? ids : names).push(prettyGalaxyName(alt));
          for (const n of [...names]) {
            const sph = /^(.+) dSph$/.exec(n);
            const irr = /^(.+) dIrr$/.exec(n);
            if (sph) names.push(`${sph[1]} Dwarf Spheroidal`);
            if (irr) names.push(`${irr[1]} Dwarf Irregular`);
          }
          if (name === 'Sagittarius dIrr') names.push('Sag DIG');
          const [id, ...rest] = [...ids, ...names];
          const r1 = num(row.R1);
          const ell = num(row.Ell);
          const maj = r1 ? round(r1 * HALF_LIGHT_TO_DIAMETER, 1) : undefined;
          return [{ id, type: 'G', ...p, mag: num(row.Vmag), maj, min: maj && ell !== undefined ? round(maj * (1 - ell), 1) : undefined, pa: num(row.PA), ids: rest.filter(isDesignation), names: rest.filter((x) => !isDesignation(x)) }];
        }),
      }),
    },
    {
      key: 'ungc',
      classifies: true,
      title: 'Galaxies within 11 Mpc (Updated Nearby Galaxy Catalog)',
      cite: 'Karachentsev I.D., Makarov D.I., Kaisina E.I., Updated nearby galaxy catalog, 2013 (AJ 145, 101; VizieR J/AJ/145/101)',
      near: dwarfNear,
      load: async () => ({
        records: (await vizier('J/AJ/145/101/catalog', ['Name', 'a26', 'b/a', 'Bmag'])).flatMap((row) => {
          const p = pos(row);
          if (!p || !row.Name) return [];
          let id = prettyGalaxyName(row.Name);
          if (CONSTELLATION_NAMES.has(id)) id = `${id} Dwarf`;
          const maj = num(row.a26);
          const ba = num(row['b/a']);
          return [{ id, type: 'G', ...p, maj, min: maj && ba ? round(maj * ba, 2) : undefined, mag: num(row.Bmag), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'arp',
      classifies: true,
      title: 'Arp peculiar galaxies',
      cite: 'Arp H., Atlas of Peculiar Galaxies, 1966 (VizieR VII/192)',
      near: { types: ['G', 'GPair', 'GTrpl', 'GGroup'], tol: () => 1 },
      load: async () => ({
        records: (await vizier('VII/192/arpord', ['Arp', 'Name', 'Size'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const name = row.Name.replace(/\s+/g, ' ').trim();
          const m = name.match(/^(NGC|IC|UGC|MCG|CGCG|PGC|ESO) ?(\S+)/);
          return [{ id: `Arp ${Number(row.Arp)}`, type: 'G', ...p, maj: num(row.Size), ids: m ? [`${m[1]} ${m[1] === 'UGC' || m[1] === 'NGC' || m[1] === 'IC' ? Number(m[2]) || m[2] : m[2]}`] : [], names: [] }];
        }),
      }),
    },
    {
      key: 'hcg',
      classifies: true,
      title: 'Hickson compact galaxy groups',
      cite: 'Hickson P., Systematic properties of compact groups of galaxies, 1982 (VizieR VII/213)',
      load: async () => ({
        records: (await vizier('VII/213/groups', ['HCG', 'AngSize', 'Totmag'])).flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          return [{ id: `HCG ${Number(row.HCG)}`, type: 'GGroup', ...p, maj: num(row.AngSize), mag: num(row.Totmag), ids: [], names: [] }];
        }),
      }),
    },
    {
      key: 'aco',
      classifies: true,
      title: 'Abell galaxy clusters (ACO, distance class ≤ 4, with the supplementary southern clusters)',
      cite: 'Abell G.O., Corwin H.G., Olowin R.P., A catalog of rich clusters of galaxies, 1989 (VizieR VII/110A)',
      load: async () => {
        const rows = [
          ...(await vizier('VII/110A/table3', ['ACO', 'Dclass', 'z'], { Dclass: '<=4' })),
          ...(await vizier('VII/110A/table4', ['ACO', 'Dclass', 'z'], { Dclass: '<=4' })),
          // the supplementary clusters (Fornax is Abell S373) have no distance class: the same cut on its defining magnitude
          ...(await vizier('VII/110A/table5', ['ACOS', 'm10', 'z'], { m10: `<=${ABELL_D4_M10}` })),
        ];
        const records = rows.flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const z = num(row.z);
          // a quarter of the Abell diameter (2 × 1.5 h⁻¹ Mpc, the bright core), from the redshift when there is one
          const maj = z ? round(((2 * (1.5 / (H0 / 100))) / ((z * C_KMS) / H0)) * (180 / Math.PI) * 60 * 0.25, 0) : undefined;
          if (row.ACOS) return [{ id: `ACO S${Number(row.ACOS)}`, type: 'GClstr', ...p, maj, ids: [`Abell S${Number(row.ACOS)}`], names: [] }];
          const n = Number(row.ACO);
          // observers write "Abell 1656"; below 87 that is one of Abell's planetaries
          return [{ id: `ACO ${n}`, type: 'GClstr', ...p, maj, ids: n > ABELL_PN_MAX ? [`Abell ${n}`] : [], names: [] }];
        });
        return { records };
      },
    },
    {
      key: 'bsc',
      title: 'Bright stars (Yale Bright Star Catalogue, 5th ed.)',
      cite: 'Hoffleit D., Warren W.H., The Bright Star Catalogue, 5th Revised Ed., 1991 (VizieR V/50)',
      load: async () => ({
        records: (await vizier('V/50/catalog', ['HR', 'Name', 'HD', 'Vmag', 'Multiple', 'ADS'])).flatMap((row) => {
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
      }),
    },
    {
      key: 'iau',
      title: 'IAU star names (WGSN)',
      cite: 'IAU Working Group on Star Names, IAU Catalog of Star Names (www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt)',
      load: async () => {
        const text = await download.text('IAU-CSN.txt', IAU_CSN);
        const out: Rec[] = [];
        for (const line of text.split(/\r?\n/)) {
          if (!line || /^[#$]/.test(line)) continue;
          // fixed columns are unreliable across editions: split on 2+ spaces, the name is first
          const f = line.split(/\s{2,}|\t/).map((s) => s.trim());
          const name = f[0];
          const m = line.match(/(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+\d{4}-\d\d-\d\d/);
          if (!name || !m) continue;
          const desig = f[2] ?? ''; // the designation column ("HR 897", "HD 4308", "XO-5")
          const hd = line.match(/\s(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+\d{4}-/);
          const ids: string[] = [];
          if (/^(HR|HD|HIP) \d+$/.test(desig)) ids.push(desig);
          if (hd) ids.push(`HD ${hd[1]}`);
          const mag = line.match(/\s(-?\d+\.\d\d)\s+[A-Za-z]{1,2}\s+(?:\d+|_)\s/);
          out.push({ id: name, type: '*', ra: Number(m[1]) / 15, dec: Number(m[2]), mag: mag ? Number(mag[1]) : undefined, ids, names: [] });
        }
        return { records: out };
      },
    },
    {
      key: 'regions',
      title: 'Named regions without a catalog entry (Gum Nebula, Squid Nebula, Pipe Nebula, Virgo Cluster…)',
      cite: 'Positions and sizes from SIMBAD (Wenger M. et al. 2000, A&AS 143, 9), CDS Strasbourg',
      load: async () => {
        const wanted = new Map(NAMED_REGIONS.map((r) => [r.simbad.toLowerCase(), r]));
        const found = await simbad('regions', `f.id IN (${NAMED_REGIONS.map((r) => `'${r.simbad.replace(/'/g, "''")}'`).join(', ')})`);
        const records = found.flatMap((o) => {
          const r = o.keys.map((k) => wanted.get(k.replace(/\s+/g, ' ').toLowerCase())).find(Boolean);
          if (!r) return [];
          const ids = SIMBAD_EXTENDED.test(o.otype) ? o.idents.map(simbadId).filter((x): x is string => x !== null && x !== r.id) : [];
          return [{ id: r.id, type: r.type, ra: o.ra, dec: o.dec, maj: o.maj, min: o.min, pa: o.pa, ids: [...new Set(ids)], names: [...r.names] }];
        });
        const missing = NAMED_REGIONS.filter((r) => !records.some((x) => x.id === r.id)).map((r) => r.simbad);
        if (missing.length) console.log(`  not in SIMBAD: ${missing.join(', ')}`);
        return { records };
      },
    },
    {
      key: 'simbad-names',
      title: 'Common names and cross-identifications (SIMBAD)',
      cite: 'Wenger M. et al., The SIMBAD astronomical database, 2000 (A&AS 143, 9), CDS Strasbourg',
      // names only: an object SIMBAD names but no catalog here lists is not added
      create: () => false,
      load: async () => ({
        records: (await simbad('names', "f.id LIKE 'NAME %'", SIMBAD_DSO_IDS)).flatMap((o) => {
          if (!SIMBAD_EXTENDED.test(o.otype)) return [];
          // named by a designation it shares with this database; the names come from all its identifiers
          const ids = [...new Set(o.idents.map(simbadId).filter((x): x is string => x !== null))];
          const names = [...new Set(o.keys.map(simbadName).filter((x): x is string => x !== null))];
          for (const k of o.keys) {
            const id = simbadId(k);
            if (id && !ids.includes(id)) ids.push(id);
          }
          const [id, ...rest] = ids;
          return id && (names.length || rest.length) ? [{ id, type: SIMBAD_TYPE[o.otype] ?? 'Other', ra: o.ra, dec: o.dec, ids: rest, names }] : [];
        }),
      }),
    },
  ];
}
