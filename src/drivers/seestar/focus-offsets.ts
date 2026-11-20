/**
 * The Seestar's part in the filter focus offsets (astro/focus-offsets): its filters from the wheel
 * (IRCUT the reference, LP), the fine star-focus sweep for the calibration, and the follower that
 * moves the focuser by the measured offset whenever setSeestarFilter changes the wheel.
 *
 * Through the LP filter a short live exposure shows few stars and its HFR is noise: the LP sweeps
 * run at LP_SWEEP_EXPOSURE_MS (the live exposure is put back after). HFR does not move with
 * exposure, so the two filters' peaks compare.
 */
import { errMsg, logger } from '../../log.js';
import * as sky from '../../astro/sky.js';
import { resolveRig } from '../../astro/acquisition/devices.js';
import { deviceKey } from '../../astro/acquisition/store.js';
import { qualityJob } from '../../astro/acquisition/probe.js';
import { calibrating, filterFocusFollower, referenceFilter, type CalibrationDriver, type FilterFollower } from '../../astro/focus-offsets/index.js';
import { seestarFacts } from './acquisition.js';
import { seestarFocusSweep } from './focus.js';
import { canonicalFilter, seestarWheel, setFilterFollower, setSeestarFilter, WHEEL_SETTLE_MS } from './filters.js';
import type { Seestar } from './device.js';

const log = logger('seestar.focus-offsets');

const LP_SWEEP_EXPOSURE_MS = 5_000;
/** the sweep's own settle after a focuser move (focus.ts) */
const FOCUS_SETTLE_MS = 800;
/** ±10 at step 1, two full-resolution frames a position */
const SWEEP_MIN = 4;

async function deviceOf(facts: ReturnType<typeof seestarFacts>): Promise<{ key: string; label: string }> {
  const rig = resolveRig(await facts());
  return { key: deviceKey(rig.spec.id, rig.serial), label: `${rig.spec.name}${rig.serial ? ` ${rig.serial}` : ''}` };
}

export function seestarFilterFollower(scope: Seestar, facts = seestarFacts(scope)): FilterFollower {
  return filterFocusFollower({
    device: async () => (await deviceOf(facts)).key,
    position: () => scope.focuserPosition('tele'),
    moveTo: (p) => scope.focusTo(p, 'tele'),
    blocked: () => (scope.isStacking() ? 'a stack is collecting (refocus with the stack stopped)' : null),
    tempC: () => scope.state.power.tempC,
    filterSettleMs: WHEEL_SETTLE_MS,
    focusSettleMs: FOCUS_SETTLE_MS,
    min: 0,
    max: scope.state.focus.maxStep ?? 2600,
  });
}

/** Install the follower on the scope: every wheel change from now on keeps the focus equivalent. */
export function installSeestarFilterFocus(scope: Seestar): void {
  setFilterFollower(scope, seestarFilterFollower(scope));
}

export function seestarCalibrationDriver(scope: Seestar, facts = seestarFacts(scope)): CalibrationDriver {
  return {
    driver: 'seestar',
    sweepMin: SWEEP_MIN,
    async device() {
      const d = await deviceOf(facts);
      const w = await seestarWheel(scope);
      const filters = [...new Set(w.slots.map(canonicalFilter).filter((f) => f !== 'dark'))];
      const reference = referenceFilter(filters.map((name) => ({ name, band: name === 'LP' ? 'duo_wide' : 'broadband' })));
      if (!reference) throw new Error(`the wheel reports no filters (${w.slots.join(', ') || 'no slots'})`);
      return { ...d, reference, filters };
    },
    busy() {
      const st = scope.state;
      if (!st.connected || st.released) return 'the Seestar is not connected';
      if (st.mount.parked) return 'the arm is parked';
      if (scope.isStacking()) return 'a stack is running: stop_stacking first';
      const op = scope.isBusy();
      if (op) return `${op} is running`;
      if (qualityJob()?.status === 'running') return 'a collection quality measurement is running';
      if (calibrating()) return 'a focus calibration is running';
      return null;
    },
    async currentFilter() {
      const w = await seestarWheel(scope);
      return w.position !== null && w.slots[w.position] !== undefined ? canonicalFilter(w.slots[w.position]) : null;
    },
    async setFilter(filter) {
      const c = await setSeestarFilter(scope, filter);
      return `wheel → ${c.filter}${c.focus ? `; ${c.focus}` : ''}`;
    },
    async sweep({ center, filter }) {
      await scope.ensureLiveView();
      const lp = filter === 'LP';
      const before = lp ? await scope.liveExposureMs('tele').catch(() => null) : null;
      if (lp && (before === null || before < LP_SWEEP_EXPOSURE_MS)) await scope.setExposure({ continuousMs: LP_SWEEP_EXPOSURE_MS }, 'tele');
      try {
        return await seestarFocusSweep(scope, { center });
      } finally {
        if (lp && before !== null && before < LP_SWEEP_EXPOSURE_MS) await scope.setExposure({ continuousMs: before }, 'tele').catch((e) => log.warn(`live exposure not put back: ${errMsg(e)}`));
      }
    },
    tempC: () => scope.state.power.tempC,
    altDeg() {
      const m = scope.state.mount;
      const loc = scope.location();
      if (m.raHours === undefined || m.decDeg === undefined || !loc) return undefined;
      try {
        return Math.round(sky.altAz(loc, m.raHours, m.decDeg, new Date()).altitude);
      } catch {
        return undefined;
      }
    },
  };
}
