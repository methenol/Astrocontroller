/** The float image every vision tool works on, and what is known about the optics. */

export interface FloatImage {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Float32Array; // interleaved, 0..1
  linear: boolean; // raw sensor data that needs a stretch to look right
  source: string;
  camera?: 'tele' | 'wide';
  header?: Record<string, unknown>;
  /** When the pixels were captured (ms epoch), if known. */
  capturedAt?: number;
  /** Set on a crop: the width of the whole frame it was cut from (the plate scale is that frame's). */
  frameWidth?: number;
}

/** A region: fractions of the frame when every value is ≤ 1, otherwise pixels. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Horizontal field of view of each lens (full 3840-px sensor width). */
const FOV_DEG = { tele: 2.95, wide: 45.06 };

/** Arcsec per pixel for a frame of this width taken with this lens; the pixel size a star is measured in. */
export const plateScaleArcsecPerPx = (camera: 'tele' | 'wide', widthPx: number): number => (FOV_DEG[camera] * 3600) / widthPx;

/** Arcsec per pixel of an image, a crop included (its pixels are the whole frame's). */
export const imagePlateScale = (img: FloatImage, camera: 'tele' | 'wide'): number => plateScaleArcsecPerPx(camera, img.frameWidth ?? img.width);

/** Which lens a source name or file path came from, when it says. */
export function guessCamera(src: string): 'tele' | 'wide' | undefined {
  const s = src.toLowerCase();
  if (s === 'stack') return 'tele';
  // the most specific evidence first: the session folder, the calibration folder, then a lone word
  // ("tele" inside "telescope" or a user's folder name says nothing)
  const session = /dwarf_raw_(tele|wide)_/.exec(s)?.[1];
  if (session) return session as 'tele' | 'wide';
  const cam = /(?:^|[/\\])cam_([01])(?:[/\\]|$)/.exec(s)?.[1];
  if (cam) return cam === '1' ? 'wide' : 'tele';
  const word = (w: string) => new RegExp(`(?:^|[^a-z])${w}(?:[^a-z]|$)`).test(s);
  if (word('tele')) return 'tele';
  if (word('wide')) return 'wide';
  return undefined;
}
