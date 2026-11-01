/** The Dwarf 3 as the night journal sees it (night/recorder.ts): GoTo, autofocus, the star-focus sweep and the tele stack. */
import { analyze, loadImage } from '../../media/images.js';
import type { StreamHub } from '../../media/streams.js';
import type { JournalProbe, OpState, ScopeSnapshot } from '../../night/recorder.js';
import { PARAMS_RANGE } from './wire/generated/params.generated.js';
import type { Dwarf } from './device.js';

const ACTIVE = new Set(['running', 'plate_solving', 'stopping']);

/** Sub length from the firmware's exposure index ("15" → 15 s, "1/100" → 0.01 s). */
function expSeconds(index: number | undefined): number | undefined {
  if (index === undefined) return undefined;
  const name = PARAMS_RANGE.expValues.find((e) => e.value === index)?.name;
  if (!name) return undefined;
  const [a, b] = name.split('/').map(Number);
  const s = b ? a / b : a;
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

export function dwarfProbe(dwarf: Dwarf, hub: StreamHub): JournalProbe {
  return {
    snapshot(): ScopeSnapshot {
      const st = dwarf.state;
      const tele = st.stacking.tele;
      // the Dwarf reports no GoTo result: one that ends tracking got there
      const goto: OpState = ACTIVE.has(st.goto.state) ? 'running' : st.tracking.state === 'running' ? 'complete' : 'failed';
      const af = ACTIVE.has(st.autofocus.astro ?? '') || ACTIVE.has(st.autofocus.state) ? 'running' : 'complete';
      const taken = tele.currentCount;
      const stacked = tele.stackedCount;
      return {
        connected: st.connected && !st.released,
        goto: { state: goto, target: st.goto.target ?? st.pointing?.target },
        autofocus: { state: af },
        fineFocus: { running: !!st.focusTune?.running, result: st.focusTune?.best ? `best ${st.focusTune.best.position} (HFR ${st.focusTune.best.hfrPx.toFixed(2)} px)` : undefined },
        focusPosition: st.focusPosition,
        stack: {
          running: tele.state === 'running',
          target: tele.target ?? st.tracking.target ?? st.goto.target,
          stacked,
          rejected: taken !== undefined && stacked !== undefined ? Math.max(0, taken - stacked) : undefined,
          subS: expSeconds(tele.expIndex),
          camera: 'tele',
          integrationS: tele.stackedTimeS && tele.stackedTimeS > 0 ? tele.stackedTimeS : undefined,
        },
        pointing: st.pointing?.raHours !== undefined && st.pointing.decDeg !== undefined ? { raHours: st.pointing.raHours, decDeg: st.pointing.decDeg } : undefined,
      };
    },
    on: (e, f) => dwarf.on(e, f),
    off: (e, f) => dwarf.off(e, f),
    async assessStack() {
      if (!dwarf.state.connected) return null;
      const { img } = await loadImage('stack', hub);
      const a = analyze(img, 'tele');
      return { stars: a.stars.count, hfrPx: a.stars.medianHfrPx ?? null, background: Math.round(a.stats.median * 1000) / 1000 };
    },
  };
}
