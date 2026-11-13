/**
 * The Dwarf's test cohorts for the collection quality engine (astro/acquisition/probe.ts). The
 * Dwarf has no raw single shot in DSO mode (its photos are processed JPEGs), so a point is a short
 * tele stack at the point's exposure, gain and filter, stopped once its subs are on the SD card:
 * they are copied into the job's temp folder, and the stack's whole session (subs, stack, album
 * entry) is then deleted from the scope, so no DWARF_RAW dataset is left and nothing reaches the
 * journal (it ignores stacks while a probe runs) or the transfers.
 *
 * The stack is started forced: the firmware otherwise refuses it when its dark master was taken at
 * another sensor temperature (-11530, seen 2026-11-13 on C 20) or is missing, and the probe only
 * wants the raw subs (they are saved uncalibrated either way; the analysis reads the dark itself).
 */
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, logger } from '../../log.js';
import { deviceLibrary } from '../../library/device-library.js';
import type { ProbeDriver, ProbeShot } from '../../astro/acquisition/probe.js';
import { dwarfSessionSubs } from './acquisition.js';
import type { Dwarf } from './device.js';

const log = logger('dwarf.probe');

const POLL_MS = 2_000;
/** beyond the subs' exposures: the start (mode switch, settle after a stop), the first frame's reference, read-out */
const START_SLACK_MS = 90_000;
const FILE_MAX_BYTES = 64 * 1024 * 1024;
/** the session folder appears on the card a little after the stop */
const AFTER_STOP_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function dwarfProbeDriver(dwarf: Dwarf): ProbeDriver {
  return {
    busy() {
      const st = dwarf.state;
      if (!st.connected || st.released) return 'the Dwarf is not connected';
      if (st.ndLock) return 'the ND filter is fitted for darks';
      if (st.stacking.tele.state === 'running') return 'a tele stack is running: live_stacking action=stop first (test cohorts are shot before the stack)';
      if (st.darkCapture && /running|capturing/.test(String((st.darkCapture as { state?: string }).state ?? ''))) return 'dark frames are being taken';
      return null;
    },

    async shoot(o: ProbeShot) {
      const notes: string[] = [];
      const startedAt = Date.now();
      // every sub is saved raw, the stacker's reference frame too: no extra sub is shot
      const frames = o.count;
      // forced: the probe needs the raw subs, never the Dwarf's own dark-calibrated stack, so a dark
      // master of another sensor temperature (-11530) or none of this pair must not refuse it
      await dwarf.startStackingWith('tele', { exposure: o.subS, gain: o.gain, filter: o.filter, frames, force: true, startedBy: 'agent' });
      try {
        const until = Date.now() + frames * (o.subS * 1000 + 3_000) + START_SLACK_MS;
        let last = -1;
        while (Date.now() < until) {
          if (o.signal.aborted) throw new Error('cancelled');
          const tele = dwarf.state.stacking.tele;
          const n = tele.currentCount ?? 0;
          if (n !== last) {
            last = n;
            if (n) o.progress(`${o.filter} gain ${o.gain} ${o.subS}s: sub ${n}/${frames}`);
          }
          if (n >= frames || tele.state !== 'running') break;
          await sleep(POLL_MS);
        }
      } finally {
        if (dwarf.state.stacking.tele.state === 'running') await dwarf.stopStacking('tele', true).catch((e) => log.warn(`probe stack not stopped: ${errMsg(e)}`));
      }
      await sleep(AFTER_STOP_MS);
      const s = await deviceLibrary().resolveSession('latest');
      const began = s.startedAt ? Date.parse(s.startedAt) : NaN;
      if (Number.isFinite(began) && began < startedAt - 120_000) throw new Error(`the newest session on the card (${s.folder}) is older than the probe: the stack saved no subs`);
      const subs = (await dwarfSessionSubs(s.folder)).slice(-o.count);
      const files: string[] = [];
      try {
        for (const p of subs) {
          const file = path.join(o.dir, path.basename(p));
          fs.writeFileSync(file, await deviceLibrary().album.fetch(p, FILE_MAX_BYTES));
          files.push(file);
        }
      } finally {
        const del = await deviceLibrary().deleteSession(s).catch((e) => ({ deleted: false, note: errMsg(e) }));
        if (!del.deleted) notes.push(`the probe session ${s.folder} could not be deleted from the card: ${del.note ?? 'unknown'} — delete it (delete_album_items) so it is not transferred`);
      }
      return { files, how: `a ${frames}-sub stack at ${o.subS}s, gain ${o.gain}, ${o.filter}: ${files.length} sub(s) copied, the session deleted from the card`, notes };
    },
  };
}
