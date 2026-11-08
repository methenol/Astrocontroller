/**
 * Looking a target up beyond the local catalog: what SIMBAD and Wikipedia say about it, and what it
 * looks like (a survey plate framed like the scope's field, or a published photo, often Hubble's).
 * Public endpoints only, no keys. CDS (SIMBAD) was unreachable for days at a time (2026-11-01), so
 * every source is best effort and the others still answer without it.
 */
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../../config.js';
import { describe as describeObject, findObject, type DsoObject } from '../../astro/catalog.js';
import { horizonOf, maskFor } from '../../astro/horizon.js';
import { targetSeason } from '../../astro/season.js';
import * as sky from '../../astro/sky.js';
import { errMsg } from '../../log.js';
import { saveCapture, text, withImage, type ToolFn } from './common.js';

const TIMEOUT_MS = 20_000;
const SIMBAD_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_PX = 1280;
// Wikimedia refuses clients without a descriptive User-Agent
const HEADERS = { 'User-Agent': 'Astrocontroller/1.0 (smart-telescope agent; object lookup)' };

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
const SIMBAD_MIRROR_TAP = 'https://simbad.harvard.edu/simbad/sim-tap/sync';
const WIKI_REST = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const NASA_IMAGES = 'https://images-api.nasa.gov/search';
const SKYVIEW = 'https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl';

export interface ResearchContext {
  /** the main camera's field in degrees */
  fov(): { h: number; v: number };
  /** the observer's site; target_season is registered only with it */
  site?: () => sky.Site;
}

async function getJson<T>(url: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

/** A JPEG of the image at `url`, long side IMAGE_MAX_PX; `stretch` spreads a flat plate (SkyView's log scaling is grey on grey). */
async function getImage(url: string, stretch = false): Promise<Buffer> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw new Error('image too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
  const img = sharp(buf).resize({ width: IMAGE_MAX_PX, height: IMAGE_MAX_PX, fit: 'inside', withoutEnlargement: true });
  return (stretch ? img.normalise({ lower: 2, upper: 99.9 }) : img).jpeg({ quality: 85 }).toBuffer();
}

const q = (params: Record<string, string | number>) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

/** Names to look the object up by, best first: the common name, then the catalog designations, then what was asked. */
function lookupNames(asked: string, o: DsoObject | null): string[] {
  return [...new Set([...(o?.names ?? []), ...(o ? [o.id, ...o.aliases.filter((a) => /^(M|C) \d/.test(a))] : []), asked].filter(Boolean))];
}

// ---------------------------------------------------------------- SIMBAD

interface TapResult {
  metadata: Array<{ name: string }>;
  data: unknown[][];
}

export function simbadQuery(id: string): string {
  const lit = id.replace(/'/g, "''");
  return [
    // ADQL has no scalar subqueries in the select list: the distance is a join (TOP 1 keeps one row)
    'SELECT TOP 1 b.main_id, b.otype_txt, b.ra, b.dec, b.galdim_majaxis, b.galdim_minaxis, b.morph_type, b.sp_type, b.rvz_redshift, b.rvz_radvel, b.plx_value, f.B, f.V, d.dist, d.unit',
    'FROM basic b JOIN ident i ON i.oidref = b.oid LEFT JOIN allfluxes f ON f.oidref = b.oid LEFT JOIN mesDistance d ON d.oidref = b.oid',
    `WHERE i.id = '${lit}'`,
  ].join(' ');
}

async function simbadAt(tap: string, names: string[]): Promise<Record<string, unknown> | null> {
  for (const id of names) {
    const r = await getJson<TapResult>(`${tap}?${q({ request: 'doQuery', lang: 'adql', format: 'json', query: simbadQuery(id) })}`, SIMBAD_TIMEOUT_MS);
    const row = r.data[0];
    if (!row) continue;
    const { dist, unit, ...rec } = Object.fromEntries(r.metadata.map((m, i) => [m.name, row[i]]).filter(([, v]) => v !== null && v !== ''));
    return { ...rec, ...(dist !== undefined ? { distance: `${dist} ${String(unit ?? '').trim()}`.trim() } : {}) };
  }
  return null;
}

/** SIMBAD at CDS, then its Harvard mirror when CDS does not answer. */
async function simbad(names: string[]): Promise<Record<string, unknown> | null> {
  try {
    return await simbadAt(SIMBAD_TAP, names);
  } catch (e) {
    return simbadAt(SIMBAD_MIRROR_TAP, names).catch((m) => {
      throw new Error(`CDS: ${errMsg(e)}; Harvard mirror: ${errMsg(m)}`);
    });
  }
}

// ---------------------------------------------------------------- Wikipedia

interface WikiSummary {
  type: string;
  title: string;
  description?: string;
  extract?: string;
  originalimage?: { source: string; width: number; height: number };
  content_urls?: { desktop?: { page?: string } };
}

const ASTRO_WORDS = /galax|nebula|cluster|star|supernova|remnant|constellation|quasar|comet|planet|asterism|messier|ngc/i;

/** The object's Wikipedia article: by title first, then by search; disambiguation and off-topic pages are skipped. */
async function wikipedia(names: string[]): Promise<WikiSummary | null> {
  const ok = (s: WikiSummary) => s.type === 'standard' && ASTRO_WORDS.test(`${s.description ?? ''} ${s.extract ?? ''}`);
  for (const n of names) {
    const s = await getJson<WikiSummary>(WIKI_REST + encodeURIComponent(n.replace(/ /g, '_'))).catch(() => null);
    if (s && ok(s)) return s;
  }
  const hits = await getJson<{ query: { search: Array<{ title: string }> } }>(`${WIKI_API}?${q({ action: 'query', list: 'search', srsearch: names[0]!, srlimit: 3, format: 'json' })}`);
  for (const h of hits.query.search) {
    const s = await getJson<WikiSummary>(WIKI_REST + encodeURIComponent(h.title.replace(/ /g, '_'))).catch(() => null);
    if (s && ok(s)) return s;
  }
  return null;
}

/** A Wikimedia thumbnail URL at `width` px instead of the size the API picked. */
export function wikiThumb(src: string, width = IMAGE_MAX_PX): string {
  return src.includes('/thumb/') ? src.replace(/\/\d+px-([^/?]+)(\?.*)?$/, `/${width}px-$1`) : src;
}

// ---------------------------------------------------------------- NASA image library

interface NasaItem {
  title: string;
  center?: string;
  date: string;
  nasaId: string;
  description: string;
  href: string;
}

async function nasaImages(query: string, limit = 5): Promise<NasaItem[]> {
  const r = await getJson<{ collection: { items: Array<{ data: Array<Record<string, string>>; links?: Array<{ href: string; rel: string }> }> } }>(`${NASA_IMAGES}?${q({ q: query, media_type: 'image' })}`);
  return r.collection.items
    .filter((i) => i.data[0] && i.links?.[0])
    .slice(0, limit)
    .map((i) => {
      const d = i.data[0]!;
      // the preview link is ~thumb, ~small or ~medium: ~medium is the largest that is always there
      return { title: d.title ?? '', center: d.center, date: (d.date_created ?? '').slice(0, 10), nasaId: d.nasa_id ?? '', description: (d.description ?? '').replace(/<[^>]+>/g, '').slice(0, 300), href: i.links![0]!.href.replace(/~(thumb|small)\.jpg$/, '~medium.jpg') };
    });
}

// ---------------------------------------------------------------- SkyView

/** A DSS2 red plate centred on ra/dec, `w`×`h` degrees, long side IMAGE_MAX_PX. */
export function skyviewUrl(raHours: number, decDeg: number, w: number, h: number): string {
  const px = (d: number) => Math.max(64, Math.round((IMAGE_MAX_PX * d) / Math.max(w, h)));
  return `${SKYVIEW}?${q({ Position: `${(raHours * 15).toFixed(5)},${decDeg.toFixed(5)}`, Survey: 'DSS2 Red', Pixels: `${px(w)},${px(h)}`, Size: `${w.toFixed(4)},${h.toFixed(4)}`, Return: 'JPEG', Scaling: 'Log' })}`;
}

// ---------------------------------------------------------------- tools

function resolveTarget(name: string | undefined, ra?: number, dec?: number): { label: string; raHours: number; decDeg: number; o: DsoObject | null } {
  if ((ra === undefined) !== (dec === undefined)) throw new Error('give both ra_hours and dec_deg, or a name');
  if (ra !== undefined && dec !== undefined) return { label: name ?? `RA ${sky.hoursToHms(ra)} Dec ${sky.degToDms(dec)}`, raHours: ra, decDeg: dec, o: null };
  if (!name) throw new Error('give a target name or ra_hours + dec_deg');
  const o = findObject(name);
  if (!o) throw new Error(`${name} is not in the local catalog: give ra_hours + dec_deg (object_info finds them on SIMBAD)`);
  return { label: o.names[0] ?? o.id, raHours: o.raHours, decDeg: o.decDeg, o };
}

export function registerResearchTools(tool: ToolFn, ctx: ResearchContext): void {
  tool(
    'object_info',
    'Research a target beyond the local catalog: SIMBAD (object type, morphology, B/V magnitude, size, redshift, radial velocity, parallax, distance) and the Wikipedia summary (what it is, its history and science), plus a list of NASA image-library photos (Hubble, JWST, Spitzer…) to look at with reference_image source=nasa. Public sources, best effort: what does not answer is named. For the open web (observing reports, papers, news) use web_search.',
    { name: z.string().trim().min(1).max(120).describe('catalog designation or common name: "M 33", "NGC 7000", "Heart Nebula"') },
    async ({ name }) => {
      const o = findObject(name);
      const names = lookupNames(name, o);
      const [sim, wiki, nasa] = await Promise.allSettled([simbad(names), wikipedia(names), nasaImages(o?.names[0] ?? name)]);
      const out: Record<string, unknown> = {};
      if (o) out.localCatalog = { summary: describeObject(o), ra: sky.hoursToHms(o.raHours), dec: sky.degToDms(o.decDeg) };
      out.simbad = sim.status === 'fulfilled' ? (sim.value ?? `no SIMBAD identifier matched ${names.join(', ')}`) : `unreachable (${errMsg(sim.reason)})`;
      if (wiki.status === 'fulfilled' && wiki.value) {
        const w = wiki.value;
        out.wikipedia = { title: w.title, description: w.description, extract: w.extract, url: w.content_urls?.desktop?.page, leadImage: w.originalimage ? 'yes: reference_image source=wikipedia' : 'none' };
      } else out.wikipedia = wiki.status === 'fulfilled' ? 'no astronomy article found' : `unreachable (${errMsg(wiki.reason)})`;
      out.nasaImages = nasa.status === 'fulfilled' ? nasa.value.map((n, i) => ({ index: i, title: n.title, center: n.center, date: n.date, nasaId: n.nasaId })) : `unreachable (${errMsg(nasa.reason)})`;
      return text(out);
    },
  );

  tool(
    'reference_image',
    "What a target should look like. source=survey (default): a Digitized Sky Survey (DSS2 red) plate from NASA SkyView centred on the target and framed to the scope's field (or fov_deg), north up and east left: compare its star pattern and the object's extent with your own frame to check centring, framing and rotation. source=wikipedia: the lead photo of the object's Wikipedia article (often Hubble, ESO or a fine amateur image). source=nasa: a NASA image-library photo (Hubble, JWST, Spitzer, Chandra press images); index picks among object_info's nasaImages, query searches something else. Nothing on the telescope moves.",
    {
      name: z.string().trim().min(1).max(120).optional(),
      ra_hours: z.number().min(0).lt(24).optional().describe('J2000, for an object not in the local catalog (survey only)'),
      dec_deg: z.number().min(-90).max(90).optional(),
      source: z.enum(['survey', 'wikipedia', 'nasa']).default('survey'),
      fov_deg: z.number().min(0.05).max(10).optional().describe("survey: the long side in degrees (default: the scope's field)"),
      index: z.number().int().min(0).max(20).default(0).describe('nasa: which hit'),
      query: z.string().trim().min(1).max(200).optional().describe('nasa: search text instead of the target name ("Triangulum Galaxy Hubble", "NGC 604")'),
    },
    async ({ name, ra_hours, dec_deg, source, fov_deg, index, query }) => {
      if (source === 'survey') {
        const t = resolveTarget(name, ra_hours, dec_deg);
        const f = ctx.fov();
        const [w, h] = fov_deg ? (f.h >= f.v ? [fov_deg, (fov_deg * f.v) / f.h] : [(fov_deg * f.h) / f.v, fov_deg]) : [f.h, f.v];
        const jpeg = await getImage(skyviewUrl(t.raHours, t.decDeg, w, h), true);
        const saved = saveCapture(jpeg, `reference_${t.label}`);
        return withImage(jpeg, [`${t.label}: DSS2 red plate from NASA SkyView, ${w.toFixed(2)}°×${h.toFixed(2)}° centred on RA ${sky.hoursToHms(t.raHours)} Dec ${sky.degToDms(t.decDeg)}, north up, east left`, 'A 1990s photographic plate: true for star positions and the bright extent of the object, not for colour or faint detail.', `saved as captures/${saved}`].join('\n'));
      }
      if (!name && !query) throw new Error('give a target name (or query for source=nasa)');
      if (source === 'wikipedia') {
        const o = name ? findObject(name) : null;
        const w = await wikipedia(lookupNames(name!, o));
        if (!w) throw new Error(`no Wikipedia astronomy article found for ${name}`);
        if (!w.originalimage) throw new Error(`the Wikipedia article "${w.title}" has no lead image`);
        const jpeg = await getImage(wikiThumb(w.originalimage.source));
        const saved = saveCapture(jpeg, `reference_${w.title}`);
        return withImage(jpeg, [`${w.title}: lead image of the Wikipedia article (${w.content_urls?.desktop?.page ?? ''}); the file page on Wikimedia Commons names the instrument and the credit`, `saved as captures/${saved}`].join('\n'));
      }
      const o = name ? findObject(name) : null;
      const hits = await nasaImages(query ?? o?.names[0] ?? name!, index + 1);
      const n = hits[index];
      if (!n) throw new Error(`the NASA image library has ${hits.length ? `only ${hits.length} hit(s)` : 'no hits'} for "${query ?? name}"`);
      const jpeg = await getImage(n.href);
      const saved = saveCapture(jpeg, `reference_${n.title}`);
      return withImage(jpeg, [`${n.title} (${n.center ?? 'NASA'}, ${n.date}, ${n.nasaId})`, n.description, `https://images.nasa.gov/details/${encodeURIComponent(n.nasaId)}`, `saved as captures/${saved}`].filter(Boolean).join('\n'));
    },
  );

  const site = ctx.site;
  if (site) {
    tool(
      'target_season',
      "A fixed target's year at this site, from tonight on: for each week, the hours of astronomical darkness it spends above the minimum altitude (raised by the site's obstruction map) and how high it gets, rolled up by month; the best months, the season (the longest run of nights with at least an hour usable, and whether tonight is in it), the night it transits in the middle of darkness (best night), the highest it ever gets here, and whether it is circumpolar or never rises. Deterministic geometry: no forecast, no Moon. For tonight's hour by hour, find_target; for a program target's season against its goal, plan_program/night_plan. Planets, the Moon and comets move: not for them.",
      {
        name: z.string().trim().min(1).max(120).optional(),
        ra_hours: z.number().min(0).lt(24).optional().describe('J2000, for an object not in the local catalog'),
        dec_deg: z.number().min(-90).max(90).optional(),
        min_altitude: z.number().min(0).lt(90).optional().describe('default: the plan minimum altitude'),
        ignore_horizon: z.boolean().optional().describe("true to ignore this site's obstruction map"),
        weekly: z.boolean().optional().describe('true to include every sampled night, not just the months'),
      },
      async ({ name, ra_hours, dec_deg, min_altitude, ignore_horizon, weekly }) => {
        if (name && ra_hours === undefined && sky.bodyByName(name)) throw new Error(`${name} moves against the stars: use sky_conditions for where it is tonight`);
        const t = resolveTarget(name, ra_hours, dec_deg);
        const s = site();
        const mask = ignore_horizon ? null : maskFor(s);
        const r = targetSeason(s, t.raHours, t.decDeg, { minAltitude: min_altitude ?? config.observer.minAltitudeDeg, tz: config.observer.timezone, horizon: mask ? horizonOf(mask) : undefined });
        const { nights, ...rest } = r;
        return text({ target: t.label, ra: sky.hoursToHms(t.raHours), dec: sky.degToDms(t.decDeg), site: { lat: s.lat, lon: s.lon }, ...rest, ...(weekly ? { nights } : {}) });
      },
    );
  }
}
