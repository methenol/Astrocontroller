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
import { listDir } from './ftp.js';
import type { Dwarf } from './device.js';

const log = logger('dwarf.probe');

const POLL_MS = 2_000;
/** beyond the subs' exposures: the start (mode switch, settle after a stop), the first frame's reference, read-out */
const START_SLACK_MS = 90_000;
const FILE_MAX_BYTES = 64 * 1024 * 1024;
/** the session folder appears on the card a little after the stop */
const AFTER_STOP_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** how long the subs may take to appear on the card once the stack has counted them */
const SAVE_WAIT_MS = 60_000;

async function astronomyFolders(): Promise<string[]> {
  return (await listDir('/Astronomy')).filter((f) => f.isDir).map((f) => f.name);
}

/** The exposure a Dwarf session folder is named for (…_EXP_15_GAIN_60_…), seconds; null when it says none. */
export function sessionExposureS(folder: string): number | null {
  const v = Number(folder.match(/_EXP_([\d.]+)_GAIN_/)?.[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Until a session folder new since `before`, of this point's exposure and gain, holds `frames` subs. */
async function waitForSubs(before: Set<string>, o: ProbeShot, frames: number): Promise<void> {
  const re = new RegExp(`^DWARF_RAW_TELE_.*_EXP_${String(o.subS).replace('.', '\\.')}_GAIN_${o.gain}_`);
  const until = Date.now() + SAVE_WAIT_MS;
  while (Date.now() < until && !o.signal.aborted) {
    try {
      const fresh = (await astronomyFolders()).filter((n) => !before.has(n) && re.test(n));
      for (const f of fresh) if ((await dwarfSessionSubs(f)).length >= frames) return;
    } catch (e) {
      log.debug(`probe: card not listed: ${errMsg(e)}`);
    }
    await sleep(3_000);
  }
  log.warn(`probe: the ${o.subS}s gain ${o.gain} subs did not appear on the card within ${SAVE_WAIT_MS / 1000}s; stopping the stack anyway`);
}

export function dwarfProbeDriver(dwarf: Dwarf): ProbeDriver {
  return {
    busy() {
      const st = dwarf.state;
      if (!st.connected || st.released) return 'the Dwarf is not connected';
      if (st.stacking.tele.state === 'running') return 'a tele stack is running: live_stacking action=stop first (test cohorts are shot before the stack)';
      if (st.darkCapture && /running|capturing/.test(String((st.darkCapture as { state?: string }).state ?? ''))) return 'dark frames are being taken';
      return null;
    },

    async shoot(o: ProbeShot) {
      const notes: string[] = [];
      const startedAt = Date.now();
      // one more frame than needed: the stacker's first is its reference. A 1-frame stack never
      // counts a frame nor saves a sub (2026-11-14 C 20: 220 s of a 120 s 1-frame stack, no session on the card)
      const frames = o.count + 1;
      // forced: the probe needs the raw subs, never the Dwarf's own dark-calibrated stack, so a dark
      // master of another sensor temperature (-11530) or none of this pair must not refuse it
      const before = new Set(await astronomyFolders().catch(() => [] as string[]));
      await dwarf.startStackingWith('tele', { exposure: o.subS, gain: o.gain, filter: o.filter, frames, force: true, startedBy: 'agent' });
      const shotStart = Date.now();
      let counted = false;
      try {
        const until = shotStart + frames * (o.subS * 1000 + 3_000) + START_SLACK_MS;
        let last = -1;
        while (Date.now() < until) {
          if (o.signal.aborted) throw new Error('cancelled');
          const tele = dwarf.state.stacking.tele;
          // a count is only this stack's once its exposures can have elapsed: the firmware repeats
          // the previous stack's last progress after a start (2026-11-13 C 20: "sub 1/1" 9 s into a
          // 90 s sub, the stack stopped before it saved anything)
          const possible = Math.floor((Date.now() - shotStart) / (o.subS * 1000));
          const n = Math.min(tele.currentCount ?? 0, possible);
          if (n !== last) {
            last = n;
            if (n) o.progress(`${o.filter} gain ${o.gain} ${o.subS}s: sub ${n}/${frames}`);
          }
          if (n >= frames) {
            counted = true;
            break;
          }
          // a stack that ends before its exposures can have elapsed is the start settling, not the end
          if (tele.state !== 'running' && Date.now() - shotStart > Math.max(30_000, o.subS * 1000)) break;
          await sleep(POLL_MS);
        }
        // the count comes when a frame is taken, before the firmware writes it: a stop then leaves no
        // session on the card (2026-11-14 C 20, 1-sub 120s point: 0 subs). Wait for the subs themselves.
        if (counted) await waitForSubs(before, o, o.count);
      } finally {
        if (dwarf.state.stacking.tele.state === 'running') await dwarf.stopStacking('tele', true).catch((e) => log.warn(`probe stack not stopped: ${errMsg(e)}`));
      }
      await sleep(AFTER_STOP_MS);
      const s = await deviceLibrary().resolveSession('latest');
      const began = s.startedAt ? Date.parse(s.startedAt) : NaN;
      if (Number.isFinite(began) && began < startedAt - 120_000) throw new Error(`the newest session on the card (${s.folder}) is older than the probe: the stack saved no subs`);
      // the firmware can acknowledge an exposure and stack at another: the Mini's 1 s points were shot
      // at 15 s (session EXP_15) and recorded as 1 s, their sky 15× too bright (2026-11-26)
      const shotAt = sessionExposureS(s.folder);
      if (shotAt !== null && Math.abs(shotAt - o.subS) > 0.01 * o.subS) {
        await deviceLibrary().deleteSession(s).catch(() => undefined);
        throw new Error(`the scope stacked at ${shotAt}s, not the ${o.subS}s asked for (session ${s.folder}): the point is not measured`);
      }
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
