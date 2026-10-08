/**
 * Search and filtering over the whole object database (the Database tab and the search_catalog
 * tool), including "up now" / "up tonight" filters. Visibility for tens of thousands of objects
 * uses a fast altitude (sidereal time + spherical trig, no precession or refraction: good to
 * ~0.5°, plenty for a filter); one object's details use the exact ephemeris.
 */
import * as A from 'astronomy-engine';
import { catalog, normalizeName, matchRank, prominence, displayName, gotoLabel, TYPE_GROUPS, TYPE_NAMES, catalogSources, type DsoObject } from './catalog.js';
import { nightWindow, altAz, moonState, separationDeg, visibility, fmtTime, type Site } from './sky.js';
import { CONSTELLATIONS } from './designations.js';

export interface CatalogQuery {
  q?: string;
  /** group names (galaxy, nebula, …) or type codes (G, HII, …) */
  types?: string[];
  constellation?: string;
  /** source catalog key (openngc, sh2, rc3…) or a list: messier, caldwell */
  catalog?: string;
  maxMag?: number;
  minSize?: number;
  maxSize?: number;
  /** only objects with a common name */
  named?: boolean;
  /** "now": above minAlt now; "tonight": at least minHours above minAlt during darkness */
  up?: 'now' | 'tonight';
  minAlt?: number;
  minHours?: number;
  sort?: 'relevance' | 'name' | 'mag' | 'size' | 'altitude' | 'hours' | 'transit' | 'ra';
  offset?: number;
  limit?: number;
}

const D2R = Math.PI / 180;

interface Sky {
  site: Site;
  tz: string;
  now: Date;
  start: Date;
  end: Date;
  /** local sidereal time (hours) now and at each sample across the dark window */
  lstNow: number;
  samples: { t: Date; lst: number }[];
  stepH: number;
}

let skyCache: { key: string; at: number; sky: Sky } | null = null;

/** Tonight's sampling grid, cached for 10 minutes per site. */
function skyFor(site: Site, tz: string): Sky {
  const key = `${site.lat},${site.lon}`;
  const nowMs = Date.now();
  if (skyCache && skyCache.key === key && nowMs - skyCache.at < 10 * 60e3) return { ...skyCache.sky, now: new Date(nowMs), lstNow: lst(new Date(nowMs), site.lon) };
  const now = new Date(nowMs);
  const w = nightWindow(site, now);
  const start = w.darkStart && w.darkStart > now ? w.darkStart : now;
  const end = w.darkEnd && w.darkEnd > start ? w.darkEnd : new Date(start.getTime() + 8 * 3600e3);
  const stepH = 0.25;
  const samples: Sky['samples'] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += stepH * 3600e3) samples.push({ t: new Date(t), lst: lst(new Date(t), site.lon) });
  const sky = { site, tz, now, start, end, lstNow: lst(now, site.lon), samples, stepH };
  skyCache = { key, at: nowMs, sky };
  return sky;
}

function lst(d: Date, lonDeg: number): number {
  return (((A.SiderealTime(d) + lonDeg / 15) % 24) + 24) % 24;
}

function fastAlt(latDeg: number, raH: number, decDeg: number, lstH: number): number {
  const h = (lstH - raH) * 15 * D2R;
  const phi = latDeg * D2R;
  const dec = decDeg * D2R;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h)) / D2R;
}

interface Vis {
  altNow: number;
  maxAlt: number;
  bestAt: Date;
  hoursUp: number;
}

function quickVis(o: DsoObject, sky: Sky, minAlt: number): Vis {
  let maxAlt = -90;
  let bestAt = sky.start;
  let n = 0;
  for (const s of sky.samples) {
    const a = fastAlt(sky.site.lat, o.raHours, o.decDeg, s.lst);
    if (a > maxAlt) {
      maxAlt = a;
      bestAt = s.t;
    }
    if (a >= minAlt) n++;
  }
  return { altNow: fastAlt(sky.site.lat, o.raHours, o.decDeg, sky.lstNow), maxAlt, bestAt, hoursUp: n * sky.stepH };
}

function typeSet(types: string[] | undefined): Set<string> | null {
  if (!types?.length) return null;
  const s = new Set<string>();
  for (const t of types) for (const code of TYPE_GROUPS[t.toLowerCase()] ?? [t]) s.add(code);
  return s;
}

const isMessier = (o: DsoObject) => o.aliases.some((a) => /^M \d+$/.test(a));
const isCaldwell = (o: DsoObject) => o.aliases.some((a) => /^C \d+$/.test(a));

const r1 = (n: number) => Math.round(n * 10) / 10;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function row(o: DsoObject, v: Vis | undefined, tz: string) {
  return {
    id: o.id,
    name: displayName(o),
    aliases: o.aliases.slice(0, 8),
    type: o.type,
    typeName: o.typeName,
    raHours: Math.round(o.raHours * 1e5) / 1e5,
    decDeg: Math.round(o.decDeg * 1e4) / 1e4,
    constellation: o.constellation,
    majorArcmin: o.majorArcmin ?? null,
    minorArcmin: o.minorArcmin ?? null,
    mag: o.mag ?? null,
    brightClass: o.brightClass ?? null,
    sources: o.sources,
    altitudeNow: v ? Math.round(v.altNow) : null,
    maxAltitudeTonight: v ? Math.round(v.maxAlt) : null,
    hoursUpTonight: v ? r1(v.hoursUp) : null,
    bestTime: v ? fmtTime(v.bestAt, tz) : null,
  };
}

export type CatalogRow = ReturnType<typeof row>;

/**
 * Filter, sort and page the database. Without a site, visibility filters and sorts are refused
 * and rows carry no altitudes.
 */
export function queryCatalog(query: CatalogQuery, site: Site | null, tz: string) {
  const all = catalog();
  const q = query.q ? normalizeName(query.q) : '';
  const types = typeSet(query.types);
  const con = query.constellation?.toLowerCase();
  const cat = query.catalog?.toLowerCase();
  const minAlt = query.minAlt ?? 20;
  const needVis = !!query.up || ['altitude', 'hours', 'transit'].includes(query.sort ?? '');
  if (needVis && !site) throw new Error('visibility filters need the observer location (OBSERVER_LATITUDE / OBSERVER_LONGITUDE)');
  const sky = site ? skyFor(site, tz) : null;

  const hits: { o: DsoObject; rank: number; vis?: Vis }[] = [];
  for (const o of all) {
    if (types && !types.has(o.type)) continue;
    if (con && o.constellation.toLowerCase() !== con) continue;
    if (cat && !(cat === 'messier' ? isMessier(o) : cat === 'caldwell' ? isCaldwell(o) : o.sources.includes(cat))) continue;
    if (query.maxMag !== undefined && !(o.mag !== undefined && o.mag <= query.maxMag)) continue;
    if (query.minSize !== undefined && !((o.majorArcmin ?? 0) >= query.minSize)) continue;
    if (query.maxSize !== undefined && !(o.majorArcmin !== undefined && o.majorArcmin <= query.maxSize)) continue;
    if (query.named && !o.names.length && !isMessier(o) && !isCaldwell(o)) continue;
    let rank = 0;
    if (q) {
      const m = matchRank(o, q);
      if (m === null) continue;
      rank = m;
    }
    let vis: Vis | undefined;
    if (needVis && sky) {
      // cheap reject: never reaches minAlt at this latitude
      if (90 - Math.abs(sky.site.lat - o.decDeg) < minAlt) continue;
      vis = quickVis(o, sky, minAlt);
      if (query.up === 'now' && vis.altNow < minAlt) continue;
      if (query.up === 'tonight' && vis.hoursUp < (query.minHours ?? 1)) continue;
    }
    hits.push({ o, rank, vis });
  }

  const sort = query.sort ?? 'relevance';
  const by: Record<string, (a: (typeof hits)[number], b: (typeof hits)[number]) => number> = {
    relevance: (a, b) => a.rank - b.rank || prominence(b.o) - prominence(a.o),
    name: (a, b) => collator.compare(displayName(a.o), displayName(b.o)),
    mag: (a, b) => (a.o.mag ?? 99) - (b.o.mag ?? 99),
    size: (a, b) => (b.o.majorArcmin ?? 0) - (a.o.majorArcmin ?? 0),
    altitude: (a, b) => b.vis!.altNow - a.vis!.altNow,
    hours: (a, b) => b.vis!.hoursUp - a.vis!.hoursUp || b.vis!.maxAlt - a.vis!.maxAlt,
    transit: (a, b) => a.vis!.bestAt.getTime() - b.vis!.bestAt.getTime() || b.vis!.maxAlt - a.vis!.maxAlt,
    ra: (a, b) => a.o.raHours - b.o.raHours,
  };
  hits.sort(by[sort] ?? by.relevance);

  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const page = hits.slice(offset, offset + limit).map((h) => row(h.o, h.vis ?? (sky ? quickVis(h.o, sky, minAlt) : undefined), tz));
  return {
    total: hits.length,
    offset,
    limit,
    window: sky ? { start: fmtTime(sky.start, tz), end: fmtTime(sky.end, tz), minAltitude: minAlt } : null,
    items: page,
  };
}

/** Facets for the filter controls: types, constellations and source catalogs with counts. */
export function catalogMeta() {
  const all = catalog();
  const types = new Map<string, number>();
  const cons = new Map<string, number>();
  let messier = 0;
  let caldwell = 0;
  for (const o of all) {
    types.set(o.type, (types.get(o.type) ?? 0) + 1);
    cons.set(o.constellation, (cons.get(o.constellation) ?? 0) + 1);
    if (isMessier(o)) messier++;
    if (isCaldwell(o)) caldwell++;
  }
  const info = catalogSources();
  const bySource = new Map<string, number>();
  for (const o of all) for (const s of o.sources) bySource.set(s, (bySource.get(s) ?? 0) + 1);
  return {
    total: all.length,
    built: info.built ?? null,
    groups: Object.entries(TYPE_GROUPS).map(([key, codes]) => ({ key, count: codes.reduce((n, c) => n + (types.get(c) ?? 0), 0) })),
    types: [...types].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, name: TYPE_NAMES[code] ?? code, count })),
    constellations: CONSTELLATIONS.map(([abbr, name]) => ({ abbr, name, count: cons.get(abbr) ?? 0 })).filter((c) => c.count),
    lists: [
      { key: 'messier', title: 'Messier', count: messier },
      { key: 'caldwell', title: 'Caldwell', count: caldwell },
    ],
    sources: info.sources.map((s) => ({ key: s.key, title: s.title, cite: s.cite, objects: bySource.get(s.key) ?? 0 })),
  };
}

/** One object in full, with tonight's exact visibility and an altitude curve across the night. */
export function objectDetails(o: DsoObject, site: Site | null, tz: string, opts: { minAlt: number; fovArcmin?: { w: number; h: number } }) {
  const base = {
    ...row(o, undefined, tz),
    aliases: o.aliases,
    names: o.names,
    posAngle: o.posAngle ?? null,
    surfaceBrightness: o.surfaceBrightness ?? null,
    gotoName: gotoLabel(o),
    sources: o.sources,
    sourceTitles: catalogSources().sources.filter((s) => o.sources.includes(s.key)).map((s) => s.title),
    fitsTeleFov: o.majorArcmin && opts.fovArcmin ? `${Math.round((o.majorArcmin / opts.fovArcmin.w) * 100)}% of the tele frame width` : null,
  };
  if (!site) return { ...base, tonight: null };
  const sky = skyFor(site, tz);
  const now = altAz(site, o.raHours, o.decDeg);
  const vis = visibility(site, o.raHours, o.decDeg, sky.start, sky.end, opts.minAlt, 15);
  const moon = moonState(site, new Date((sky.start.getTime() + sky.end.getTime()) / 2));
  const curve = sky.samples.map((s) => ({ t: s.t.toISOString(), local: fmtTime(s.t, tz), alt: Math.round(altAz(site, o.raHours, o.decDeg, s.t).altitude * 10) / 10 }));
  return {
    ...base,
    altitudeNow: r1(now.altitude),
    azimuthNow: r1(now.azimuth),
    tonight: {
      start: fmtTime(sky.start, tz),
      end: fmtTime(sky.end, tz),
      minAltitude: opts.minAlt,
      maxAltitude: vis.maxAlt,
      bestTime: fmtTime(vis.maxAltAt, tz),
      hoursAboveMin: vis.hoursAboveMin,
      from: fmtTime(vis.firstAbove, tz),
      until: fmtTime(vis.lastAbove, tz),
      moonIllumination: moon.illuminationPercent,
      moonSeparationDeg: Math.round(separationDeg(o.raHours, o.decDeg, moon.raHours, moon.decDeg)),
      curve,
    },
  };
}
