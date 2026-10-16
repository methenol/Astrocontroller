/** Firmware error codes as text: the name, and a hint on what to do where one is known. */
import { getErrorMessage } from '@alikh/dwarflab-sdk';
import { FIRMWARE_ERRORS } from '../error-codes.js';

const HINTS: Readonly<Record<number, string>> = Object.freeze({
  [-1]: 'rejected by firmware — the device is in the wrong shooting mode/technique for this command, or still busy closing a stack that was just stopped (wait ~20 s and retry before changing modes)',
  [-14520]: 'motors must be homed first (motors_home); a failed calibration also leaves them in this state',
  [-14519]: 'mechanical limit reached (rotation travel is about 0–315°)',
  [-15106]: 'the current exposure is too long for contrast autofocus — in DSO mode use autofocus mode=astro (needs stars), or switch to Normal mode / a shorter exposure',
  [-11530]: 'dark temperature mismatch: the dark masters were taken at another sensor temperature. The stack still runs with force=true (without dark calibration; AstroPhoto Studio calibrates afterwards), or capture new darks at this temperature (dark_frames). autoCalibration=false alone does not get past it (2026-10-12)',
  [-11504]: 'calibration failed: the plate-solve did not succeed (usually too few usable stars: cloud, obstruction, dew or daylight)',
  [-11505]: 'GoTo failed: the slew or the plate-solve that verifies it did not end on the target. Seen 2026-10-04 with the scope on an EQ wedge while the firmware was still in Alt-Az mode (polar alignment not completed), so its level-mount model could not reach targets: complete polar_alignment so EQ mode engages, or level the mount',
  [-11511]: 'a successful calibration is needed first',
  [-11516]: 'polar-alignment (EQ) solving failed: the plate-solves at the two positions did not succeed (usually too few stars: cloud or obstruction)',
  [-11513]: 'GoTo is needed before live stacking',
});

export function errorText(code: number): string {
  const name = FIRMWARE_ERRORS[code];
  const sdk = getErrorMessage(code);
  const base = name ?? (sdk && !sdk.startsWith('Unknown error') ? sdk : `unknown error`);
  const hint = HINTS[code];
  return `${base} (${code})${hint ? ` — ${hint}` : ''}`;
}
