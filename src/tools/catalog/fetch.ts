/** Downloads into a cache directory, and VizieR tables as rows keyed by column name. */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../util/fs.js';

const VIZIER = 'https://vizier.cds.unistra.fr/viz-bin/asu-tsv';
const DOWNLOAD_TIMEOUT_MS = 300_000;
const ATTEMPTS = 3;
const BACKOFF_MS = 3000;

/** Writes through a temporary file, so an interrupted run never leaves a truncated file behind. */
export const writeAtomic = writeFileAtomic;

export type Row = Record<string, string>;

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

export class Downloader {
  constructor(
    private readonly cacheDir: string,
    private readonly fresh: boolean,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly out: (s: string) => void = (s) => process.stdout.write(s),
  ) {}

  /** The cached copy of `url`, downloading it when missing (or always, when fresh). */
  async text(name: string, url: string): Promise<string> {
    const file = path.join(this.cacheDir, name);
    if (!this.fresh && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    this.out(`  downloading ${name}… `);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          // a client error will not change on retry
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { final: true });
          throw err;
        }
        const text = await res.text();
        writeAtomic(file, text);
        this.out(`${(text.length / 1e6).toFixed(1)} MB\n`);
        return text;
      } catch (err) {
        const final = (err as { final?: boolean }).final === true;
        if (final || attempt >= ATTEMPTS) throw new Error(`${name}: ${(err as Error).message} (attempt ${attempt} of ${ATTEMPTS})`);
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
      }
    }
  }

  /** A VizieR table as rows keyed by column name, with computed J2000 positions in _RAJ2000/_DEJ2000 (degrees). */
  async vizier(table: string, columns: readonly string[], filter: Readonly<Record<string, string>> = {}): Promise<Row[]> {
    const q = new URLSearchParams({ '-source': table, '-out.max': 'unlimited', '-out': columns.join(','), '-out.add': '_RAJ,_DEJ', '-oc.form': 'dec', ...filter });
    const text = await this.text(`${table.replace(/\//g, '_')}.tsv`, `${VIZIER}?${q}`);
    // tables without coordinates come without _RAJ2000/_DEJ2000: pos() returns null for those rows
    return parseVizierTsv(text, table, columns);
  }
}
