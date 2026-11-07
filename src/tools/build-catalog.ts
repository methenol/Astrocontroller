/**
 * Builds catalog/objects.tsv, the merged object database used by the planner, GoTo and the
 * Database tab, from OpenNGC plus the VizieR catalogs and the IAU star names in catalog/sources.ts.
 *
 *   npm run catalog                download what is missing into catalog/.cache, then merge
 *   npm run catalog -- --fresh     download everything again
 *   npm run catalog -- <dir>       build in another directory
 *
 * Merging: every record is matched to an object already in the database by any of its
 * designations (VizieR tables carry cross-identifications: LDN→Barnard, RCW→NGC/Gum, RC3→PGC…),
 * then, for extended objects, by position and size. A match adds the record's designations and
 * fills fields the object lacks; otherwise the record becomes a new object. Sources are merged in
 * the order listed, so the first catalog that has an object names it. Its type is then weighed
 * against the classifying surveys that matched it (`resolveType`): a general catalog's label gives
 * way when the surveys agree the object is something else.
 */
import path from 'node:path';
import { typeName } from '../astro/designations.js';
import { Downloader, writeAtomic } from './catalog/fetch.js';
import { Catalog, resolveType } from './catalog/merge.js';
import { sources } from './catalog/sources.js';
import { objectsTsv, sourcesJson, type SourceStats } from './catalog/write.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'catalog');
  const fresh = args.includes('--fresh');
  const download = new Downloader(path.join(dir, '.cache'), fresh);

  const catalog = new Catalog();
  const stats: SourceStats[] = [];
  const all = sources({ dir, fresh, download });
  for (const src of all) {
    console.log(`${src.key}: ${src.title}`);
    const { records, aliases = [] } = await src.load();
    let added = 0;
    let merged = 0;
    for (const rec of records) {
      const outcome = catalog.add(rec, src.key, src.near);
      if (outcome === 'added') added++;
      else if (outcome === 'merged') merged++;
    }
    for (const [alias, target] of aliases) catalog.alias(alias, target);
    stats.push({ key: src.key, title: src.title, cite: src.cite, records: records.length, added, merged });
    console.log(`  ${records.length} records: ${added} new, ${merged} merged into existing objects`);
  }

  const { objects } = catalog;
  const surveys = new Set(all.filter((s) => s.classifies).map((s) => s.key));
  let retyped = 0;
  for (const o of objects) {
    const type = resolveType(o, surveys);
    if (type !== o.type) {
      o.type = type;
      retyped++;
    }
  }
  console.log(`\n${retyped} types settled by the classifying surveys`);
  writeAtomic(path.join(dir, 'objects.tsv'), objectsTsv(objects));
  writeAtomic(path.join(dir, 'sources.json'), sourcesJson(new Date(), objects.length, stats));

  const byType = new Map<string, number>();
  for (const o of objects) byType.set(o.type, (byType.get(o.type) ?? 0) + 1);
  console.log(`\n${objects.length} objects → ${path.join(dir, 'objects.tsv')}`);
  console.log([...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${typeName(t)}: ${n}`).join(', '));
}

main().catch((e: unknown) => {
  console.error(`catalog build failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
