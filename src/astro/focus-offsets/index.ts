/**
 * Filter focus offsets: per device, how far the best focus through each filter lies from the best
 * focus through its reference filter — measured once on a star field near the zenith (the night
 * plan's focus-calibration block, calibrate.ts), kept per device (store.ts, model.ts), and applied
 * whenever a driver changes the tele filter, so the focus stays equivalent (follow.ts).
 */
export { calibrationJob, calibrating, cancelCalibration, startCalibration, sweepOrder, bracketOf, MAX_REF_DRIFT, type CalibrationDevice, type CalibrationDriver, type CalibrationJob, type CalibrationRun } from './calibrate.js';
export { filterFocusFollower, type FilterFollower, type FocuserAccess, type FollowResult } from './follow.js';
export { convertPosition, filterOffset, offsetOf, offsetStatus, shiftBetween, SETTLED_MAX, SETTLED_MIN, SETTLED_SEM, STALE_DAYS, type DeviceOffsetStatus, type FilterOffset } from './model.js';
export { allDeviceOffsets, deviceOffsets, forgetOffsets, noteDevice, recordAttempt, recordMeasurement, reloadOffsets, type CalibrationAttempt, type DeviceOffsets, type OffsetMeasurement, type OffsetSweep } from './store.js';

/** The reference filter of a set: the broadband one autofocus works best in (IRCUT, VIS), else the first broadband, else the first. */
export function referenceFilter(filters: Array<{ name: string; band?: string }>): string | null {
  if (!filters.length) return null;
  return (filters.find((f) => /^(ircut|vis|uv.?ir|none|l|lum)/i.test(f.name)) ?? filters.find((f) => f.band === 'broadband') ?? filters[0]).name;
}
