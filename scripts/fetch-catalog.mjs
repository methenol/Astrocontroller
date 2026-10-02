// Downloads the OpenNGC catalog (CC-BY-SA 4.0, https://github.com/mattiaverga/OpenNGC).
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'catalog');
const base = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files';
fs.mkdirSync(dir, { recursive: true });
for (const f of ['NGC.csv', 'addendum.csv']) {
  const res = await fetch(`${base}/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  fs.writeFileSync(path.join(dir, f), Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${path.join(dir, f)}`);
}
