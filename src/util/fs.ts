/** File helpers shared across the application. */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Write through a temporary file in the same directory and rename it into place, so a crash or a
 * full disk never leaves a truncated file behind. Creates the directory when it is missing.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the write's own error is the one worth reporting */
    }
    throw err;
  }
}
