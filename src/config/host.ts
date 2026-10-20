/** The telescope address set from the web UI: kept in DATA_DIR/telescope.json and wins over DWARF_HOST. */
import fs from 'node:fs';
import { writeFileAtomic } from '../util/fs.js';

const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** An IPv4 address or a DNS host name. */
export function validHost(h: string): boolean {
  if (!(h.length > 0 && h.length <= 253)) return false;
  const labels = h.split('.');
  if (!labels.every((l) => l.length <= 63 && LABEL.test(l))) return false;
  // all digits is an IPv4 address, never a name: four octets of 0-255 (a typo such as 192.168.1 or 300.1.1.1 is refused)
  if (labels.every((l) => /^\d+$/.test(l))) return labels.length === 4 && labels.every((l) => Number(l) <= 255);
  return true;
}

export class HostOverride {
  constructor(
    private readonly file: string,
    readonly envHost: string,
  ) {}

  /** The saved address, if there is a valid one. */
  load(): string | null {
    try {
      const saved: unknown = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as { host?: unknown } | null)?.host;
      return typeof saved === 'string' && validHost(saved) ? saved : null;
    } catch {
      return null;
    }
  }

  /** Save `host` (atomically), or drop the override for '' or the .env address. Returns the address now in use. */
  set(input: string): string {
    const host = input.trim();
    if (host === '' || host === this.envHost) {
      fs.rmSync(this.file, { force: true });
      return this.envHost;
    }
    if (!validHost(host)) throw new Error(`"${host}" is not an IP address or host name`);
    writeFileAtomic(this.file, JSON.stringify({ host, since: Date.now() }));
    return host;
  }
}
