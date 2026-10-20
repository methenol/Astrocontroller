/**
 * The merged object database. A record is matched to an existing object by any of its
 * designations, then (for sources that allow it) by position and size; a match adds the record's
 * designations and fills fields the object lacks, otherwise the record becomes a new object.
 */
import { normalizeName, isDesignation } from '../../astro/designations.js';
import type { NearMatch, Obj, Rec } from './types.js';

const DEG = Math.PI / 180;
/** A designation shared by unrelated things (a star's HD number on a nebula entry) must still be this close (arcmin), or their sizes. */
const SAME_DESIGNATION_MIN_ARCMIN = 30;
/** A cross-reference naming something this much smaller or larger names a part, not the object (LDN 1630 lists B 33). */
const PART_SIZE_RATIO = 5;
/** Size assumed for the position search when a record has none (arcmin). */
const DEFAULT_SIZE_ARCMIN = 4;
/** Above this |dec| every RA cell is searched. */
const POLAR_DEC = 85;

/** Great-circle separation in arcmin; RA in hours, dec in degrees. */
export function sepArcmin(ra1: number, d1: number, ra2: number, d2: number): number {
  const a = Math.sin(((d2 - d1) * DEG) / 2) ** 2 + Math.cos(d1 * DEG) * Math.cos(d2 * DEG) * Math.sin(((ra2 - ra1) * 15 * DEG) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / DEG * 60;
}

/** Extended objects: the same if the centres are within a quarter of the larger size (+1′) and the sizes agree within 3×. */
export function extendedTol(rec: Rec, o: Obj): number | null {
  const a = rec.maj;
  const b = o.maj;
  if (!a || !b) return 2;
  if (Math.max(a, b) / Math.min(a, b) > 3) return null;
  return 0.25 * Math.max(a, b) + 1;
}

const sizeRatio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);

export type Outcome = 'added' | 'merged';

export class Catalog {
  readonly objects: Obj[] = [];
  private readonly byKey = new Map<string, Obj>();
  /** 1°×1° cells keyed "raDeg:decDeg" */
  private readonly grid = new Map<string, Obj[]>();

  get(designation: string): Obj | undefined {
    return this.byKey.get(normalizeName(designation));
  }

  /** Merges one record: into the object it matches, or as a new object. Non-finite positions are skipped (null). */
  add(rec: Rec, source: string, near?: NearMatch): Outcome | null {
    if (!Number.isFinite(rec.ra) || !Number.isFinite(rec.dec)) return null;
    const hit = this.byDesignation(rec) ?? (near ? this.nearest(rec, near) : null);
    if (hit) {
      this.mergeInto(hit, rec, source);
      return 'merged';
    }
    this.insert(rec, source);
    return 'added';
  }

  /** Adds `alias` to the object named `target`, unless the alias already names something. */
  alias(alias: string, target: string): boolean {
    const o = this.get(target);
    if (!o || this.get(alias)) return false;
    o.ids.push(alias);
    this.addKeys(o, [alias]);
    return true;
  }

  private byDesignation(rec: Rec): Obj | null {
    for (const d of [rec.id, ...rec.ids]) {
      const hit = this.get(d);
      if (!hit) continue;
      if (sepArcmin(hit.ra, hit.dec, rec.ra, rec.dec) > Math.max(SAME_DESIGNATION_MIN_ARCMIN, (hit.maj ?? 0) + (rec.maj ?? 0))) continue;
      if (d !== rec.id && hit.maj && rec.maj && sizeRatio(hit.maj, rec.maj) > PART_SIZE_RATIO) {
        // the record names a part of itself: that designation is not the record's
        rec.ids = rec.ids.filter((x) => x !== d);
        continue;
      }
      return hit;
    }
    return null;
  }

  /** The candidate with the smallest separation relative to its tolerance, within the tolerance. */
  private nearest(rec: Rec, near: NearMatch): Obj | null {
    // search radius (degrees): tolerances reach up to ~3/4 of a size (3× ratio × 1/4), plus a cell of margin
    const reach = Math.min(180, Math.ceil(((rec.maj ?? DEFAULT_SIZE_ARCMIN) * 0.75 + 2) / 60) + 1);
    const dec0 = Math.floor(rec.dec);
    const ra0 = Math.floor(rec.ra * 15);
    const types = new Set(near.types);
    let best: Obj | null = null;
    let bestScore = Infinity;
    for (let dec = Math.max(-90, dec0 - reach); dec <= Math.min(89, dec0 + reach); dec++) {
      // cells narrow towards the poles: widen the RA span by the cell's widest latitude
      const lat = Math.min(89.999, Math.max(Math.abs(dec), Math.abs(dec + 1)));
      const all = Math.abs(rec.dec) > POLAR_DEC || lat > POLAR_DEC;
      const span = all ? 180 : Math.min(180, Math.ceil(reach / Math.cos(lat * DEG)));
      const ras = span >= 180 ? Array.from({ length: 360 }, (_, i) => i) : Array.from({ length: 2 * span + 1 }, (_, i) => ra0 - span + i);
      for (const raCell of ras) {
        for (const o of this.grid.get(`${((raCell % 360) + 360) % 360}:${dec}`) ?? []) {
          if (!types.has(o.type)) continue;
          const tol = near.tol(rec, o);
          if (tol === null || tol <= 0) continue;
          const sep = sepArcmin(rec.ra, rec.dec, o.ra, o.dec);
          if (sep <= tol && sep / tol < bestScore) {
            best = o;
            bestScore = sep / tol;
          }
        }
      }
    }
    return best;
  }

  private addKeys(o: Obj, list: readonly string[]): void {
    for (const k of list) {
      const key = normalizeName(k);
      if (key && !this.byKey.has(key)) this.byKey.set(key, o);
    }
  }

  private insert(rec: Rec, source: string): Obj {
    const o: Obj = { ...rec, ids: [...rec.ids], names: [...rec.names], sources: [source] };
    this.objects.push(o);
    this.addKeys(o, [o.id, ...o.ids, ...o.names]);
    const k = `${((Math.floor(o.ra * 15) % 360) + 360) % 360}:${Math.min(89, Math.floor(o.dec))}`;
    const cell = this.grid.get(k);
    if (cell) cell.push(o);
    else this.grid.set(k, [o]);
    return o;
  }

  private mergeInto(o: Obj, rec: Rec, source: string): void {
    if (!o.sources.includes(source)) o.sources.push(source);
    const have = new Set([o.id, ...o.ids, ...o.names].map(normalizeName));
    const take = (d: string, list: string[]) => {
      const k = normalizeName(d);
      if (have.has(k)) return;
      list.push(d);
      have.add(k);
    };
    for (const d of [rec.id, ...rec.ids]) take(d, isDesignation(d) ? o.ids : o.names);
    for (const n of rec.names) take(n, o.names);
    o.maj ??= rec.maj;
    // a minor axis only belongs with the major axis it was measured with
    if (o.min === undefined && o.maj === rec.maj) o.min = rec.min;
    o.pa ??= rec.pa;
    o.mag ??= rec.mag;
    o.sb ??= rec.sb;
    o.vis = o.vis === undefined ? rec.vis : rec.vis === undefined ? o.vis : Math.min(o.vis, rec.vis);
    this.addKeys(o, [rec.id, ...rec.ids, ...rec.names]);
  }
}
