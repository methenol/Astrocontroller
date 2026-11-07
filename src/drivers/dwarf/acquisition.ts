/**
 * What the Dwarf says about itself for the acquisition planner: its name (the model), its mount
 * mode, the DSO exposures and gains its parameter schema offers, and the dark masters it holds
 * (it refuses a deep-sky sub without one). The schema and the dark list are read at most every
 * FACTS_TTL_MS, and only while connected; without them the device spec stands in.
 */
import { errMsg, logger } from '../../log.js';
import type { DarkFrameRef, FactsSource, LiveFacts } from '../../astro/acquisition/index.js';
import { listDir } from './ftp.js';
import { resolveShootingMode } from './http.js';
import type { Dwarf } from './device.js';

const log = logger('dwarf.acquisition');
const FACTS_TTL_MS = 10 * 60_000;

/** "15", "1/2", "0.5" → seconds; "auto" and the like → undefined. */
function seconds(label: unknown): number | undefined {
  const s = String(label).trim();
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(s.replace(/s$/i, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function dwarfFacts(dwarf: Dwarf): FactsSource {
  let cache: { at: number; v: Partial<LiveFacts> } | null = null;
  return async () => {
    const st = dwarf.state;
    const base = {
      driver: 'dwarf' as const,
      model: st.device.name ?? undefined,
      serial: st.device.serial ?? undefined,
      eqMode: st.bodyMode === 'eq' ? true : st.bodyMode === 'altaz' ? false : undefined,
    };
    if (!st.connected) return { ...base, ...cache?.v };
    if (cache && Date.now() - cache.at < FACTS_TTL_MS) return { ...base, ...cache.v };
    const v: Partial<LiveFacts> = {};
    try {
      const dso = await resolveShootingMode('dso');
      const s = (await dwarf.cameraSettings('tele', dso.id)).settings as { exposure?: { options?: unknown[] }; gain?: { options?: unknown; note?: string } };
      const exp = (s.exposure?.options ?? []).map(seconds).filter((x): x is number => x !== undefined);
      if (exp.length) v.exposureOptionsS = exp;
      const range = s.gain?.note?.match(/(\d+)-(\d+)/);
      if (range) v.gainRange = [Number(range[1]), Number(range[2])];
      const gains = Array.isArray(s.gain?.options) ? (s.gain.options as unknown[]).filter((g): g is number => typeof g === 'number') : [];
      if (gains.length) v.gainOptions = gains;
    } catch (err) {
      log.debug(`DSO parameter schema not read: ${errMsg(err)}`);
    }
    try {
      v.darks = (await dwarf.darkFrameList()).map((d) => ({ exposureS: seconds(d.exposure) ?? NaN, gain: Number(d.gain) })).filter((d) => Number.isFinite(d.exposureS));
    } catch (err) {
      log.debug(`dark list not read: ${errMsg(err)}`);
    }
    cache = { at: Date.now(), v };
    return { ...base, ...v };
  };
}

/** The dark frames on the SD card (CALI_FRAME/dark/cam_0), as device paths with what their names say. */
export async function dwarfDarkFrames(): Promise<DarkFrameRef[]> {
  const out: DarkFrameRef[] = [];
  for (const [dir, kind] of [
    ['/Astronomy/CALI_FRAME/dark/cam_0', 'dark'],
    ['/Astronomy/CALI_FRAME/bias/cam_0', 'bias'],
  ] as const) {
    const files = await listDir(dir).catch((err) => {
      log.debug(`${dir} not listed: ${errMsg(err)}`);
      return [];
    });
    for (const f of files) {
      if (f.isDir || !/\.fits?$/i.test(f.name)) continue;
      const m = f.name.match(/^(?:dark|bias)_(?:exp_([\d.]+)_)?gain_(\d+)_bin_\d+(?:_(-?\d+)C)?(?:_stack_(\d+))?\.fits?$/i);
      out.push({
        path: `/DWARF3${dir}/${f.name}`,
        kind,
        exposureS: m?.[1] !== undefined ? Number(m[1]) : kind === 'bias' ? 0 : undefined,
        gain: m ? Number(m[2]) : undefined,
        tempC: m?.[3] !== undefined ? Number(m[3]) : undefined,
        stackCount: m?.[4] !== undefined ? Number(m[4]) : undefined,
      });
    }
  }
  return out;
}

/** A session's light subs on the SD card, oldest first, as device paths (the scope's own rejects left out). */
export async function dwarfSessionSubs(folder: string): Promise<string[]> {
  const stamp = (n: string) => n.match(/(\d{8}-\d{9})/)?.[1] ?? n;
  return (await listDir(`/Astronomy/${folder}`))
    .filter((f) => !f.isDir && /\.fits$/i.test(f.name) && !/^(stacked|failed_)/i.test(f.name))
    .sort((a, b) => stamp(a.name).localeCompare(stamp(b.name)))
    .map((f) => `/DWARF3/Astronomy/${folder}/${f.name}`);
}
