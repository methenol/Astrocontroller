/**
 * The Dwarf's part in the filter focus offsets (astro/focus-offsets): its tele filters from the
 * device spec (VIS the reference where it has one, Astro, Duo-Band), the fine star-focus sweep for
 * the calibration (its stills are exposed for the filter: 0.5 s VIS, 1 s Astro, 4 s Duo-Band), and
 * the follower that moves the focuser by the measured offset whenever the tele filter is set
 * (camera.ts: set_camera_setting, live_stacking filter=, the quality probe).
 */
import * as sky from '../../astro/sky.js';
import { resolveRig } from '../../astro/acquisition/devices.js';
import { deviceKey } from '../../astro/acquisition/store.js';
import { qualityJob } from '../../astro/acquisition/probe.js';
import { calibrating, filterFocusFollower, referenceFilter, type CalibrationDriver, type FilterFollower } from '../../astro/focus-offsets/index.js';
import { starFocusSweep } from '../../media/focus.js';
import type { StreamHub } from '../../media/streams.js';
import { dwarfFacts } from './acquisition.js';
import { FILTER_SETTLE_MS, FILTER_NAMES } from './controller/camera.js';
import { FOCUS_MAX, type Dwarf } from './device.js';

/** the sweep's own settle after a focuser move (media/focus/sweep.ts) */
const FOCUS_SETTLE_MS = 700;
/** ±10 at step 1: 21 full tele stills over Wi-Fi at ~22 s, and the verification frame */
const SWEEP_MIN = 9;

async function deviceOf(facts: ReturnType<typeof dwarfFacts>) {
  const rig = resolveRig(await facts());
  return { rig, key: deviceKey(rig.spec.id, rig.serial), label: `${rig.spec.name}${rig.serial ? ` ${rig.serial}` : ''}` };
}

export function dwarfFilterFollower(dwarf: Dwarf, facts = dwarfFacts(dwarf)): FilterFollower {
  return filterFocusFollower({
    device: async () => (await deviceOf(facts)).key,
    position: () => dwarf.settledFocusPosition(),
    moveTo: (p) => dwarf.focusTo(p),
    blocked: () => (dwarf.state.stacking.tele.state === 'running' ? 'a tele stack is collecting (refocus with the stack stopped)' : null),
    tempC: () => dwarf.state.temperatureC,
    filterSettleMs: FILTER_SETTLE_MS,
    focusSettleMs: FOCUS_SETTLE_MS,
    min: 0,
    max: FOCUS_MAX,
  });
}

/** Install the follower: every tele filter change from now on keeps the focus equivalent. */
export function installDwarfFilterFocus(dwarf: Dwarf): void {
  dwarf.setFilterFollower(dwarfFilterFollower(dwarf));
}

export function dwarfCalibrationDriver(dwarf: Dwarf, hub: StreamHub, facts = dwarfFacts(dwarf)): CalibrationDriver {
  return {
    driver: 'dwarf',
    sweepMin: SWEEP_MIN,
    async device() {
      const { rig, key, label } = await deviceOf(facts);
      // the filters the tele can select, in the spec's names
      const filters = rig.filters.map((f) => f.name).filter((n) => FILTER_NAMES.includes(n));
      const reference = referenceFilter(rig.filters.filter((f) => filters.includes(f.name)));
      if (!reference) throw new Error(`${label}: no tele filter in its device spec`);
      return { key, label, reference, filters };
    },
    busy() {
      const st = dwarf.state;
      if (!st.connected || st.released) return 'the Dwarf is not connected';
      if (st.ndLock) return 'the ND filter is fitted for darks';
      if (st.stacking.tele.state === 'running') return 'a tele stack is running: live_stacking action=stop first';
      const op = dwarf.isBusy();
      if (op) return `${op} is running`;
      if (qualityJob()?.status === 'running') return 'a collection quality measurement is running';
      if (calibrating()) return 'a focus calibration is running';
      return null;
    },
    currentFilter: () => dwarf.currentFilterName(),
    setFilter: (filter) => dwarf.setSetting('tele', 'filter', filter),
    sweep: ({ center }) => starFocusSweep({ dwarf, hub }, { center }),
    tempC: () => dwarf.state.temperatureC,
    altDeg() {
      const p = dwarf.state.pointing;
      const loc = dwarf.location();
      if (p?.raHours === undefined || p.decDeg === undefined || !loc) return undefined;
      try {
        return Math.round(sky.altAz(loc, p.raHours, p.decDeg, new Date()).altitude);
      } catch {
        return undefined;
      }
    },
  };
}
