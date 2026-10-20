import fs from 'node:fs';

/** One line of data/telescope-wire.log. */
export interface WireLine {
  t: number;
  dir: '>' | '<' | '~' | '!' | 'x';
  name: string;
  data: Record<string, unknown>;
  flags: string;
}

const LINE = /^(\S+) ([<>~!x]) (\S+)((?: \[[^\]]*\]| \([^)]*\))*)(?: (\{.*\}))?$/;

/** Parse a wire log; lines the logger truncated (…) keep what parses, or an empty payload. */
export function readWireLog(file: string): WireLine[] {
  const out: WireLine[] = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    let data: Record<string, unknown> = {};
    if (m[5]) {
      try {
        data = JSON.parse(m[5]);
      } catch {
        data = { _truncated: m[5] };
      }
    }
    out.push({ t: Date.parse(m[1]), dir: m[2] as WireLine['dir'], name: m[3], data, flags: m[4].trim() });
  }
  return out;
}

export const at = (iso: string) => Date.parse(iso);
