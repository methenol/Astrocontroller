/**
 * The catalogs merged into catalog/objects.tsv, in merge order: the first catalog that has an
 * object names it. Each loader turns its download into records; sizes are arcmin, positions J2000.
 */
import fs from 'node:fs';
import path from 'node:path';
import { greekSymbol } from '../../astro/designations.js';
import { type Downloader, writeAtomic } from './fetch.js';
import { extendedTol } from './merge.js';
import { crossIds, num, pos, readOpenNgc, round } from './parse.js';
import type { Rec, Source } from './types.js';

const OPENNGC_RAW = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files';
const IAU_CSN = 'https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt';
/** Speed of light (km/s) and the Hubble constant (km/s/Mpc) for Abell cluster sizes from redshift. */
const C_KMS = 299792;
const H0 = 70;

const NEBULAE = ['HII', 'EmN', 'Neb', 'RfN', 'Cl+N', 'SNR'];

const vis3 = (n: number | undefined, map: Readonly<Record<number, number>>) => (n === undefined ? undefined : map[n]);
const pick = (map: Readonly<Record<string, number>>, k: string) => (Object.hasOwn(map, k) ? map[k] : undefined);

export interface SourceEnv {
  /** the catalog directory (OpenNGC CSVs live here) */
  dir: string;
  fresh: boolean;
  download: Downloader;
}

export function sources(env: SourceEnv): Source[] {
  const { dir, fresh, download } = env;
  const vizier = download.vizier.bind(download);
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
      key: 'green',
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
      key: 'barnard',
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
      key: 'rc3',
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
          const am = alt.match(/^(UGC|ESO|MCG|CGCG|UGCA|DDO|IRAS|Mrk|MRK) ?(.+)$/);
          if (am) ids.push(am[1] === 'UGC' ? `UGC ${Number(am[2])}` : `${am[1]} ${am[2].replace(/\s+/g, '')}`);
          const d25 = num(row.D25);
          const r25 = num(row.R25);
          const maj = d25 !== undefined ? 10 ** d25 / 10 : undefined;
          const id = ids.find((x) => /^(NGC|IC|UGC) /.test(x)) ?? ids[0];
          if (!id) return [];
          return [{ id, type: 'G', ...p, maj: round(maj, 2), min: maj !== undefined && r25 !== undefined ? round(maj / 10 ** r25, 2) : undefined, pa: num(row.PA), mag: num(row.BT) ?? num(row.Bmag), ids: ids.filter((x) => x !== id), names: [] }];
        }),
      }),
    },
    {
      key: 'pgc',
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
      key: 'arp',
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
      title: 'Abell galaxy clusters (ACO, distance class ≤ 4)',
      cite: 'Abell G.O., Corwin H.G., Olowin R.P., A catalog of rich clusters of galaxies, 1989 (VizieR VII/110A)',
      load: async () => {
        const rows = [
          ...(await vizier('VII/110A/table3', ['ACO', 'Dclass', 'z'], { Dclass: '<=4' })),
          ...(await vizier('VII/110A/table4', ['ACO', 'Dclass', 'z'], { Dclass: '<=4' })),
        ];
        const records = rows.flatMap((row) => {
          const p = pos(row);
          if (!p) return [];
          const z = num(row.z);
          // a quarter of the Abell diameter (2 × 1.5 h⁻¹ Mpc, the bright core), from the redshift when there is one
          const maj = z ? round(((2 * (1.5 / (H0 / 100))) / ((z * C_KMS) / H0)) * (180 / Math.PI) * 60 * 0.25, 0) : undefined;
          return [{ id: `ACO ${Number(row.ACO)}`, type: 'GClstr', ...p, maj, ids: [], names: [] }];
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
  ];
}
