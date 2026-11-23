/** Downloads into a cache directory: VizieR tables and SIMBAD TAP queries as rows keyed by column name. */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../util/fs.js';

/** VizieR's ASU-TSV service: CDS first, then its mirror at the CfA (same tables, same output). */
export const VIZIER_MIRRORS: readonly string[] = ['https://vizier.cds.unistra.fr/viz-bin/asu-tsv', 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv'];
/** SIMBAD's synchronous TAP service: CDS first, then its mirror at the CfA. */
export const SIMBAD_TAP_MIRRORS: readonly string[] = ['https://simbad.cds.unistra.fr/simbad/sim-tap/sync', 'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync'];
const DOWNLOAD_TIMEOUT_MS = 600_000;
/** Attempts per mirror: VizieR's mirrors drop their database connection for a few seconds at a time. */
const ATTEMPTS = 6;
const BACKOFF_MS = 3000;

/** Writes through a temporary file, so an interrupted run never leaves a truncated file behind. */
export const writeAtomic = writeFileAtomic;

export type Row = Record<string, string>;

/**
 * What is wrong with a VizieR response, or null when it is a table. VizieR answers a failed
 * query with HTTP 200 and "#INFO Error=…" lines ("The database is not currently reachable"),
 * which must not be cached as the table.
 */
export function vizierError(text: string): string | null {
  const err = /^#INFO\s+Error=(.*\S)/m.exec(text);
  if (err) return err[1].trim();
  if (/^\s*</.test(text)) return 'an HTML or XML page instead of a table';
  // even an empty result has its header line; a mirror that lost its database mid-query sends none
  if (!text.split(/\r?\n/).some((l) => l.trim() && !l.startsWith('#'))) return 'no table in the response';
  return null;
}

/** Parses VizieR's TSV: comment lines, then a header, a units line, a dashes line, then data. */
export function parseVizierTsv(text: string, table: string, columns: readonly string[]): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  if (lines.length < 3) throw new Error(`${table}: not a VizieR table (${lines.length} non-comment lines)`);
  const head = lines[0].split('\t').map((h) => h.trim());
  const missing = columns.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`${table}: columns missing from the download: ${missing.join(', ')}`);
  return lines.slice(3).map((l) => {
    const f = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, (f[i] ?? '').trim()]));
  });
}

/** A TAP TSV field: strings come quoted, with "" for a quote inside. */
const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
};

/** What is wrong with a TAP TSV response for these columns, or null when it is the table. */
export function tapError(text: string, columns: readonly string[]): string | null {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  if (/^\s*</.test(first)) {
    const info = /<INFO[^>]*name="QUERY_STATUS"[^>]*>([^<]*)/i.exec(text);
    return info ? `query failed: ${info[1].trim()}` : 'an HTML or XML page instead of a table';
  }
  const head = first.split('\t').map(unquote);
  const missing = columns.filter((c) => !head.includes(c));
  return missing.length ? `columns missing from the result: ${missing.join(', ')}` : null;
}

/** Parses a TAP TSV result: a header line of column names, then one row per line. */
export function parseTapTsv(text: string, name: string, columns: readonly string[]): Row[] {
  const err = tapError(text, columns);
  if (err) throw new Error(`${name}: ${err}`);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('\t').map(unquote);
  return lines.slice(1).map((l) => {
    const f = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, unquote(f[i] ?? '')]));
  });
}

export class Downloader {
  constructor(
    private readonly cacheDir: string,
    private readonly fresh: boolean,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly out: (s: string) => void = (s) => process.stdout.write(s),
    private readonly backoffMs = BACKOFF_MS,
  ) {}

  /**
   * The cached copy of a download, fetching it when missing (or always, when fresh). `urls` are
   * mirrors of one another, tried in order; `check` names what is wrong with a response that
   * arrived but is not the data (an error page), which is retried and never cached.
   */
  async text(name: string, urls: string | readonly string[], check: (text: string) => string | null = () => null): Promise<string> {
    const file = path.join(this.cacheDir, name);
    if (!this.fresh && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    this.out(`  downloading ${name}… `);
    const failures: string[] = [];
    for (const url of typeof urls === 'string' ? [urls] : urls) {
      const host = new URL(url).host;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          const res = await this.fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
          // a client error will not change on retry: on to the next mirror
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            // a TAP service explains a rejected query in the body ("Incorrect ADQL query: …")
            const why = /QUERY_STATUS[^>]*>([^<]{1,200})/.exec(await res.text().catch(() => ''));
            failures.push(`${host}: HTTP ${res.status}${why ? ` (${why[1].trim()})` : ''}`);
            break;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          const bad = check(text);
          if (bad) throw new Error(bad);
          writeAtomic(file, text);
          this.out(`${(text.length / 1e6).toFixed(1)} MB${host === new URL(typeof urls === 'string' ? urls : urls[0]).host ? '' : ` (from ${host})`}\n`);
          return text;
        } catch (err) {
          if (attempt >= ATTEMPTS) failures.push(`${host}: ${(err as Error).message}`);
          else await new Promise((r) => setTimeout(r, this.backoffMs * attempt));
        }
      }
    }
    this.out('failed\n');
    throw new Error(`${name}: ${failures.join('; ')}`);
  }

  /** A VizieR table as rows keyed by column name, with computed J2000 positions in _RAJ2000/_DEJ2000 (degrees). */
  async vizier(table: string, columns: readonly string[], filter: Readonly<Record<string, string>> = {}): Promise<Row[]> {
    const q = new URLSearchParams({ '-source': table, '-out.max': 'unlimited', '-out': columns.join(','), '-out.add': '_RAJ,_DEJ', '-oc.form': 'dec', ...filter });
    const text = await this.text(`${table.replace(/\//g, '_')}.tsv`, VIZIER_MIRRORS.map((m) => `${m}?${q}`), vizierError);
    // tables without coordinates come without _RAJ2000/_DEJ2000: pos() returns null for those rows
    return parseVizierTsv(text, table, columns);
  }

  /** The rows of an ADQL query on SIMBAD, cached under `name`. */
  async simbad(name: string, adql: string, columns: readonly string[]): Promise<Row[]> {
    const q = new URLSearchParams({ request: 'doQuery', lang: 'adql', format: 'tsv', maxrec: '2000000', query: adql });
    const text = await this.text(`simbad-${name}.tsv`, SIMBAD_TAP_MIRRORS.map((m) => `${m}?${q}`), (t) => tapError(t, columns));
    return parseTapTsv(text, `SIMBAD ${name}`, columns);
  }
}
