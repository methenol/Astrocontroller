/** Star-based focus for the tele camera: the measurement and the focuser sweep. */
export { starSharpness, sharpnessLine, type StarSharpness, type StarSharpnessOptions } from './focus/sharpness.js';
export { measureTele, starFocusSweep, sweepPositions, fitMinimum, checkSweepOptions, type FocusDeps, type FocusSample, type FocusSweepOptions, type FocusSweepResult } from './focus/sweep.js';
