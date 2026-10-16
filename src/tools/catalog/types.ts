/** One record from a source catalog, before merging. */
export interface Rec {
  id: string;
  type: string;
  /** hours, J2000 */
  ra: number;
  /** degrees, J2000 */
  dec: number;
  con?: string;
  /** arcmin */
  maj?: number;
  min?: number;
  pa?: number;
  mag?: number;
  sb?: number;
  /** visual brightness class for objects without a magnitude: 1 bright, 2 moderate, 3 faint (dark nebulae: opacity) */
  vis?: number;
  /** other designations */
  ids: string[];
  /** common names */
  names: string[];
}

/** A merged object: a record plus the sources that contributed to it. */
export interface Obj extends Rec {
  sources: string[];
}

/** How to match records not found by designation: candidate types and a position tolerance (arcmin, null = not the same). */
export interface NearMatch {
  types: readonly string[];
  tol: (rec: Rec, o: Obj) => number | null;
}

export interface Loaded {
  records: Rec[];
  /** [alias, target designation]: extra designations of objects in this source */
  aliases?: readonly (readonly [string, string])[];
}

export interface Source {
  key: string;
  title: string;
  cite: string;
  near?: NearMatch;
  load: () => Promise<Loaded>;
}
