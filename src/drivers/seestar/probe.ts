/**
 * The Seestar's test cohorts for the collection quality engine (astro/acquisition/probe.ts), shot
 * without a stack: the filter wheel, the stack gain and the LIVE exposure are set to the point's,
 * and the next raw (Bayer) subs of the tele's live view are taken off the picture socket and
 * written as FITS (with the pointing, exposure, gain and filter) into the job's temp folder. The
 * first sub after a change is dropped: it was exposing under the old settings. The wheel, gain and
 * live exposure go back afterwards, whatever happens.
 *
 * When the firmware does not hold a live exposure that long (it reads back something else), the
 * point is shot as a short stack instead: its subs are copied off the scope into the temp folder
 * and the stack's session is then deleted from the scope, so no dataset is left behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, logger } from '../../log.js';
import { deviceLibrary } from '../../library/device-library.js';
import type { ProbeDriver, ProbeShot } from '../../astro/acquisition/probe.js';
import { bayerFits } from './capture.js';
import { framePixels, IMG_TYPE } from './frames.js';
import type { Seestar } from './device.js';
import type { SeestarMedia } from './web.js';

const log = logger('seestar.probe');

const WHEEL_SETTLE_MS = 2_500;
/** a stacked probe's subs are waited for this long beyond their exposures */
const STACK_SLACK_MS = 120_000;
const POLL_MS = 2_000;
const FILE_MAX_BYTES = 64 * 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function seestarProbeDriver(scope: Seestar, media: SeestarMedia | undefined, stackGain: () => number): ProbeDriver {
  const wheel = async () => {
    const [pos, names] = await Promise.all([scope.raw('get_wheel_position'), scope.raw('get_wheel_slot_name')]);
    return { position: typeof pos.result === 'number' ? pos.result : null, slots: Array.isArray(names.result) ? (names.result as unknown[]).map(String) : [] };
  };
  const slotOf = (slots: string[], filter: string) => {
    const want = filter.toLowerCase().replace(/[^a-z]/g, '');
    return slots.findIndex((n) => n.toLowerCase().replace(/[^a-z]/g, '') === want || (want.startsWith('lp') && /^lp/i.test(n)) || (/ircut|uvir|none/.test(want) && /ir/i.test(n)));
  };

  return {
    busy() {
      const st = scope.state;
      if (!st.connected || st.released) return 'the Seestar is not connected';
      if (st.mount.parked) return 'the arm is parked';
      if (scope.isStacking()) return 'a stack is running: stop_stacking first (test cohorts are shot before the stack)';
      return null;
    },

    async shoot(o: ProbeShot) {
      const notes: string[] = [];
      const before = { wheel: await wheel().catch(() => null), gain: scope.state.view.gain, liveMs: await scope.liveExposureMs('tele').catch(() => null) };
      const gain = stackGain();
      try {
        // the filter
        if (before.wheel?.slots.length) {
          const i = slotOf(before.wheel.slots, o.filter);
          if (i < 0) throw new Error(`no filter ${o.filter} in the wheel (${before.wheel.slots.join(', ')})`);
          if (before.wheel.position !== i) {
            await scope.raw('set_wheel_position', [i]);
            await sleep(WHEEL_SETTLE_MS);
          }
        }
        await scope.ensureLiveView();
        await scope.setGain(gain);
        await scope.setExposure({ continuousMs: o.subS * 1000 }, 'tele');
        const held = await scope.liveExposureMs('tele').catch(() => null);
        if (held !== null && Math.abs(held - o.subS * 1000) > 1) {
          notes.push(`the live view holds ${held / 1000}s, not ${o.subS}s: shot as a short stack, deleted from the scope after`);
          return await stacked(o, notes);
        }
        const files: string[] = [];
        await scope.withFullRes('tele', 'a quality probe', async () => {
          // the first frame after the change was exposing under the old settings
          for (let n = 0; n < o.count + 1; n++) {
            if (o.signal.aborted) throw new Error('cancelled');
            const f = await scope.grabRaw('tele', o.subS * 1000 + 60_000);
            if (n === 0 || f.header.imgType !== IMG_TYPE.preview) continue;
            const { width, height } = f.header;
            const px = framePixels(f.payload, width * height * 2, `raw frame of ${f.payload.length} B`);
            const st = scope.state;
            const file = path.join(o.dir, `probe_${o.filter}_${o.subS}s_${String(files.length + 1).padStart(2, '0')}.fit`);
            fs.writeFileSync(
              file,
              bayerFits(px, width, height, {
                CREATOR: `ZWO ${st.device.model ?? 'Seestar'} via Astrocontroller (quality probe)`,
                IMAGETYP: 'Light',
                'DATE-OBS': new Date(f.at - o.subS * 1000).toISOString().replace('Z', ''),
                EXPTIME: o.subS,
                GAIN: gain,
                FILTER: o.filter,
                BAYERPAT: 'GRBG',
                ...(st.mount.raHours !== undefined && st.mount.decDeg !== undefined ? { RA: Math.round(st.mount.raHours * 15 * 1e5) / 1e5, DEC: Math.round(st.mount.decDeg * 1e5) / 1e5 } : {}),
                ...(st.focus.position !== undefined ? { FOCUSPOS: st.focus.position } : {}),
                OBJECT: o.target,
              }),
            );
            files.push(file);
            o.progress(`${o.filter} ${o.subS}s: sub ${files.length}/${o.count}`);
          }
        });
        return { files, how: `${files.length} raw sub(s) off the live view at ${o.subS}s, gain ${gain}`, notes };
      } finally {
        await scope.setExposure({ continuousMs: before.liveMs ?? 1000 }, 'tele').catch((e) => log.warn(`live exposure not put back: ${errMsg(e)}`));
        if (before.gain !== undefined) await scope.setGain(before.gain).catch((e) => log.warn(`gain not put back: ${errMsg(e)}`));
        if (before.wheel?.position !== null && before.wheel?.position !== undefined) await scope.raw('set_wheel_position', [before.wheel.position]).catch((e) => log.warn(`filter wheel not put back: ${errMsg(e)}`));
      }
    },
  };

  /** The fallback: a short stack at the point's sub, its subs copied off, its session deleted. */
  async function stacked(o: ProbeShot, notes: string[]) {
    if (!media) throw new Error('the scope\'s storage is not reachable: cannot fetch a stacked probe');
    const startedAt = Date.now();
    await scope.setExposure({ stackMs: o.subS * 1000 }, 'tele');
    await scope.startStack(true);
    try {
      const until = Date.now() + o.count * (o.subS * 1000 + 5_000) + STACK_SLACK_MS;
      while (Date.now() < until && (scope.state.stack.stacked ?? 0) + (scope.state.stack.dropped ?? 0) < o.count) {
        if (o.signal.aborted) throw new Error('cancelled');
        await sleep(POLL_MS);
      }
    } finally {
      await scope.stopStack().catch((e) => log.warn(`probe stack not stopped: ${errMsg(e)}`));
    }
    await sleep(5_000);
    const s = await deviceLibrary().resolveSession('latest');
    const began = s.startedAt ? Date.parse(s.startedAt) : NaN;
    if (Number.isFinite(began) && began < startedAt - 120_000) throw new Error(`the newest session on the scope (${s.folder}) is older than the probe: it saved no subs (the Seestar must keep its sub-frames)`);
    const subs = (await media.storage.sessionSubs(s.folder)).slice(-o.count);
    const files: string[] = [];
    for (const p of subs) {
      const dev = p.startsWith('/') ? p : `/SEESTAR/${p}`;
      const file = path.join(o.dir, path.basename(p));
      fs.writeFileSync(file, await deviceLibrary().album.fetch(dev, FILE_MAX_BYTES));
      files.push(file);
    }
    const del = await deviceLibrary().deleteSession(s).catch((e) => ({ deleted: false, note: errMsg(e) }));
    if (!del.deleted) notes.push(`the probe stack ${s.folder} could not be deleted from the scope: ${del.note ?? 'unknown'} — delete it by hand`);
    return { files, how: `a ${files.length}-sub stack at ${o.subS}s, copied off and deleted from the scope`, notes };
  }
}
