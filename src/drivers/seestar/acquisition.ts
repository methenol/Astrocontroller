/**
 * What the Seestar says about itself for the acquisition planner: its model and serial, the optics
 * get_device_state reports, its EQ mode, the gain the stack runs at, whether the firmware offers
 * the 90/120 s subs (exp_ms.more_exposure) and the filter wheel's slots. The wheel is asked at most
 * every WHEEL_TTL_MS, and only while connected; the rest is the folded device state.
 */
import { errMsg, logger } from '../../log.js';
import type { FactsSource } from '../../astro/acquisition/index.js';
import type { Seestar } from './device.js';

const log = logger('seestar.acquisition');
const WHEEL_TTL_MS = 30 * 60_000;

export function seestarFacts(scope: Seestar): FactsSource {
  let wheel: { at: number; slots: string[] } | null = null;
  return async () => {
    const st = scope.state;
    const d = st.device;
    const setting = (st.deviceState as { setting?: { exp_ms?: { more_exposure?: boolean } } } | null)?.setting;
    if (st.connected && !st.released && (!wheel || Date.now() - wheel.at > WHEEL_TTL_MS)) {
      try {
        const r = await scope.raw('get_wheel_slot_name');
        if (Array.isArray(r.result)) wheel = { at: Date.now(), slots: (r.result as unknown[]).map(String) };
      } catch (err) {
        log.debug(`filter wheel not read: ${errMsg(err)}`);
      }
    }
    return {
      driver: 'seestar',
      model: d.model,
      serial: d.serial,
      focalLengthMm: d.focalLengthMm,
      apertureMm: d.focalLengthMm && d.fNumber ? d.focalLengthMm / d.fNumber : undefined,
      pixelUm: d.pixelSizeUm,
      chip: d.chipSize,
      eqMode: st.mount.eqMode,
      gain: st.view.gain,
      moreExposure: setting?.exp_ms?.more_exposure,
      filterSlots: wheel?.slots,
    };
  };
}
