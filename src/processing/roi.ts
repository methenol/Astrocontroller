/**
 * The crop percentage a processing request carries. AstroPhoto Studio does the cropping; all the
 * controller contributes is how much of the frame the target needs, from the target database.
 */
import { findObject } from '../astro/catalog.js';
import type { FieldSize } from '../astro/mosaic.js';
import { effectiveSwitch, findProgramTarget, loadSettings } from '../night/program.js';

let frameField: () => FieldSize | null = () => null;

/** The driver's frame size (arcminutes), for turning a catalog size into a share of the frame. */
export function setFrameField(f: () => FieldSize | null): void {
  frameField = f;
}

export interface RoiCrop {
  /** what is sent: the percentage of the frame's width and height kept, just outside the recommendation */
  percent: number;
  /** the percentage of the frame the target itself spans */
  recommendedPercent: number;
  fillPct: number;
}

/**
 * The share of the frame to keep for a target of this size. Measured on the frame's short side,
 * since the catalog does not say how the target lies across the frame: there the target has to fit.
 * Null when the target already fills enough of the frame, or there is nothing worth cropping.
 */
export function roiCropPercent(majorArcmin: number | undefined, field: FieldSize, o: { maxFillPct: number; marginPct: number }): RoiCrop | null {
  if (!majorArcmin || !(field.w > 0 && field.h > 0)) return null;
  const fillPct = (majorArcmin / Math.max(field.w, field.h)) * 100;
  if (fillPct > o.maxFillPct) return null;
  const recommendedPercent = (majorArcmin / Math.min(field.w, field.h)) * 100;
  const percent = Math.ceil(recommendedPercent * (1 + o.marginPct / 100));
  return percent < 100 ? { percent, recommendedPercent: Math.round(recommendedPercent * 10) / 10, fillPct: Math.round(fillPct * 10) / 10 } : null;
}

/** The crop to request for a target by the owner's settings (global, then the target's own), or undefined for none. */
export function roiForTarget(target: string): number | undefined {
  const settings = loadSettings();
  if (!effectiveSwitch(settings.roiCropEnabled, findProgramTarget(target)?.roiCrop)) return undefined;
  const field = frameField();
  const o = findObject(target);
  if (!field || !o) return undefined;
  return roiCropPercent(o.majorArcmin, field, { maxFillPct: settings.roiCropMaxFillPct, marginPct: settings.roiCropMarginPct })?.percent;
}
