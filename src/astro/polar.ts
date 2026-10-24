/**
 * Polar alignment corrections in the user's terms: pitch the telescope up or down, rotate it
 * clockwise or counter-clockwise. Each driver maps its own error signs the way its maker's app does:
 *
 *   dwarf    ResStartEqSolving aziErr/altErr (DWARFLAB app, EQModeFragment): aziErr > 0 → "rotate the
 *            tripod head clockwise", otherwise counterclockwise; altErr > 0 → "tilt it upward",
 *            otherwise downward; by |err| degrees
 *   seestar  EqModePA x/y in degrees (Seestar app, EQModeChangeViewModel): y ≥ 0 → up arrow, otherwise
 *            down; x ≥ 0 → right arrow (taken as clockwise), otherwise left (counter-clockwise)
 */

/** Decimals shown for a correction (as the Seestar app shows it); an axis that rounds to 0 needs no turn. */
const SHOWN_DECIMALS = 1;

export interface PolarCorrection {
  /** degrees to pitch: positive = up */
  pitchDeg: number;
  /** degrees to rotate: positive = clockwise */
  rotateDeg: number;
}

export const dwarfCorrection = (aziErr: number, altErr: number): PolarCorrection => ({
  pitchDeg: altErr > 0 ? Math.abs(altErr) : -Math.abs(altErr),
  rotateDeg: aziErr > 0 ? Math.abs(aziErr) : -Math.abs(aziErr),
});

export const seestarCorrection = (x: number, y: number): PolarCorrection => ({
  pitchDeg: y >= 0 ? Math.abs(y) : -Math.abs(y),
  rotateDeg: x >= 0 ? Math.abs(x) : -Math.abs(x),
});

const deg = (d: number) => `${Math.abs(d).toFixed(SHOWN_DECIMALS)}°`;
const shown = (d: number) => Number(Math.abs(d).toFixed(SHOWN_DECIMALS)) > 0;

/** "pitch up 1.0°, rotate 3.0° clockwise" (an axis that is on is left out). */
export function correctionText(c: PolarCorrection): string {
  const steps: string[] = [];
  if (shown(c.pitchDeg)) steps.push(`pitch ${c.pitchDeg > 0 ? 'up' : 'down'} ${deg(c.pitchDeg)}`);
  if (shown(c.rotateDeg)) steps.push(`rotate ${deg(c.rotateDeg)} ${c.rotateDeg > 0 ? 'clockwise' : 'counter-clockwise'}`);
  return steps.length ? steps.join(', ') : 'no adjustment needed';
}

/** The web UI's readout line: the total error and the correction. */
export function polarSummary(c: PolarCorrection): string {
  const total = Math.hypot(c.pitchDeg, c.rotateDeg);
  const text = correctionText(c);
  return `Polar alignment error ${deg(total)}: ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
