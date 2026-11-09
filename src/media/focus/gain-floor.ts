/**
 * The lowest gain a short tele still is shot at unless the caller names one.
 *
 * Agent sessions 2026-11-04..09: every blank result with a known gain was at 40 or 60, and none of
 * the 83 results at gain 80 or above was blank (4 s at 80 and 0.5 s at 120 both worked). A low imaging
 * gain left behind by a stack is right for its long subs and black at these exposures.
 */
const FLOOR_LONG = 80;
const FLOOR_SUBSECOND = 120;

/** `exposureS` null (the camera's own, unknown) gets the safe, higher floor. */
export function stillGainFloor(exposureS: number | null): number {
  return exposureS !== null && exposureS >= 1 ? FLOOR_LONG : FLOOR_SUBSECOND;
}
