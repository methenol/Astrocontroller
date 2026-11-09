/** The Dwarf 3 as the night journal sees it (night/recorder.ts): GoTo, autofocus, the star-focus sweep and the tele stack. */
import { analyze, loadImage } from '../../media/images.js';
import type { StreamHub } from '../../media/streams.js';
import type { JournalProbe, OpState, ScopeSnapshot } from '../../night/recorder.js';
import { PARAMS_RANGE } from './wire/generated/params.generated.js';
import { astroState } from './controller/util.js';
import type { TelescopeState } from './controller/state.js';
import type { Dwarf } from './device.js';

const ACTIVE = new Set(['running', 'plate_solving', 'stopping']);
/** A one-click GoTo's stage reads as ended about 40 ms before tracking is reported: not an end until this long has passed. */
const ONE_CLICK_END_GRACE_MS = 2_000;
/** The horizon survey's slews (media/horizon/survey.ts) are not visits to a target. */
const SURVEY_ANCHOR = /^survey anchor\b/i;

interface OneClickStage {
  state?: number;
  targetName?: string;
}

/** A one-click GoTo reports only as oneClickGotoState, never as gotoState: is it moving, and toward what? */
function oneClickGoto(st: TelescopeState): { running: boolean; target?: string } {
  const oc = st.oneClickGoto as { astroCalibrationState?: OneClickStage; astroGotoState?: OneClickStage; astroTrackingState?: OneClickStage; at?: number } | undefined;
  const stage = oc?.astroCalibrationState ?? oc?.astroGotoState;
  const target = (stage ?? oc?.astroTrackingState)?.targetName;
  return { running: !!stage && (ACTIVE.has(astroState(stage.state)) || Date.now() - (oc?.at ?? 0) < ONE_CLICK_END_GRACE_MS), target };
}

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
      const oneClick = oneClickGoto(st);
      const surveying = SURVEY_ANCHOR.test(oneClick.target ?? '');
      const goto: OpState = surveying ? 'idle' : ACTIVE.has(st.goto.state) || oneClick.running ? 'running' : st.tracking.state === 'running' ? 'complete' : 'failed';
      const af = ACTIVE.has(st.autofocus.astro ?? '') || ACTIVE.has(st.autofocus.state) ? 'running' : 'complete';
      const taken = tele.currentCount;
      const stacked = tele.stackedCount;
      return {
        connected: st.connected && !st.released,
        goto: { state: goto, target: (surveying ? undefined : oneClick.target) ?? st.goto.target ?? st.pointing?.target },
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
