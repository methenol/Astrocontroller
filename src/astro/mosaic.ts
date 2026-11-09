/**
 * Mosaic geometry: the target sets the footprint, the camera sets the panels. Pure and deterministic,
 * so the same target and optics always give the same panel centres, night after night.
 *
 * Offsets are laid out on a tangent plane at the footprint's centre and projected back to RA/Dec:
 * adding a fixed RA step would ignore the convergence of the meridians near the poles.
 */
import type { DsoObject } from './catalog.js';

/** arcminutes */
export interface FieldSize {
  w: number;
  h: number;
}

export interface Footprint extends FieldSize {
  raHours: number;
  decDeg: number;
  /** the rectangle's width axis, degrees from east through north (the camera's width axis) */
  angleDeg: number;
  source: 'catalog' | 'override';
}

/** How the sensor sits on the sky: only an EQ mount with a known angle keeps a rectangle where it was planned. */
export type Orientation = 'known' | 'unknown' | 'rotating';
export type MountMode = 'eq' | 'altaz' | 'unknown';

export interface LayoutPanel {
  id: string;
  ix: number;
  iy: number;
  raHours: number;
  decDeg: number;
}

export interface MosaicLayout {
  /** false: the target fits one frame */
  needed: boolean;
  nx: number;
  ny: number;
  overlap: number;
  /** the field each panel is planned to deliver */
  panelField: FieldSize;
  orientation: Orientation;
  footprint: Footprint;
  panels: LayoutPanel[];
  notes: string[];
}

/** Catalog diameters understate how far an extended nebula's faint emission reaches. */
const EXTENDED_MARGIN = 1.25;
const COMPACT_MARGIN = 1.1;
const EXTENDED_TYPES: readonly string[] = ['HII', 'EmN', 'SNR', 'Neb', 'RfN', 'Cl+N', 'DrkN'];
/** Rotation under an alt-az mount eats into the planned overlap. */
const ROTATING_EXTRA_OVERLAP = 0.1;
const MAX_OVERLAP = 0.6;

/** Panels needed along one axis (the guide's N = 1 + ⌈(T − F) / (F(1 − o))⌉, at least 1). */
export function panelCount(target: number, field: number, overlap: number): number {
  return Math.max(1, 1 + Math.ceil((target - field) / (field * (1 - overlap)) - 1e-9));
}

/** The rectangle (w, h, along the camera's axes) around an ellipse of semi-axes a, b whose major axis has position angle pa. */
function ellipseBox(a: number, b: number, paDeg: number, cameraDeg: number): FieldSize {
  const pa = (paDeg * Math.PI) / 180;
  const cam = (cameraDeg * Math.PI) / 180;
  // sky axes (east, north): the major axis lies at (sin pa, cos pa); the camera's width axis at (cos cam, sin cam)
  const u = [Math.sin(pa), Math.cos(pa)];
  const v = [Math.cos(pa), -Math.sin(pa)];
  const half = (e: number[]) => Math.hypot(a * (u[0] * e[0] + u[1] * e[1]), b * (v[0] * e[0] + v[1] * e[1]));
  return { w: 2 * half([Math.cos(cam), Math.sin(cam)]), h: 2 * half([-Math.sin(cam), Math.cos(cam)]) };
}

export interface FootprintInput {
  major?: number;
  minor?: number;
  posAngle?: number;
  type?: string;
  raHours: number;
  decDeg: number;
}

/** The sky rectangle to cover, or null when the catalog gives no size and none was asked for (one frame is all that can be justified). */
export function targetFootprint(o: FootprintInput, cameraAngleDeg: number | null, override?: Partial<FieldSize>): Footprint | null {
  const angleDeg = cameraAngleDeg ?? 0;
  if (override?.w && override?.h) return { w: override.w, h: override.h, raHours: o.raHours, decDeg: o.decDeg, angleDeg, source: 'override' };
  if (!o.major) return null;
  const margin = EXTENDED_TYPES.includes(o.type ?? '') ? EXTENDED_MARGIN : COMPACT_MARGIN;
  const a = (o.major * margin) / 2;
  const b = ((o.minor || o.major) * margin) / 2;
  // without a position angle and a camera angle the target can lie any way across the frame: its full length on both axes
  const box = o.posAngle !== undefined && cameraAngleDeg !== null ? ellipseBox(a, b, o.posAngle, cameraAngleDeg) : { w: 2 * a, h: 2 * a };
  return { ...box, raHours: o.raHours, decDeg: o.decDeg, angleDeg, source: 'catalog' };
}

export const footprintOf = (o: DsoObject): FootprintInput => ({ major: o.majorArcmin, minor: o.minorArcmin, posAngle: o.posAngle, type: o.type, raHours: o.raHours, decDeg: o.decDeg });

/** Tangent-plane offset (arcminutes east, north) from a centre, as RA hours / Dec degrees. */
export function offsetToSky(raHours: number, decDeg: number, eastArcmin: number, northArcmin: number): { raHours: number; decDeg: number } {
  const xi = (eastArcmin / 60) * (Math.PI / 180);
  const eta = (northArcmin / 60) * (Math.PI / 180);
  const d0 = (decDeg * Math.PI) / 180;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const dra = (Math.atan2(xi, den) * 180) / Math.PI / 15;
  const dec = (Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) * 180) / Math.PI;
  return { raHours: (raHours + dra + 24) % 24, decDeg: dec };
}

export interface LayoutOptions {
  overlap: number;
  mount: MountMode;
  /** the sensor's width axis on the sky, degrees from east through north; null: not measured */
  cameraAngleDeg: number | null;
}

/** The panel grid for a footprint. Panel ids run in a serpentine, so consecutive panels are neighbours on the sky. */
export function layoutMosaic(footprint: Footprint, field: FieldSize, o: LayoutOptions): MosaicLayout {
  const notes: string[] = [];
  const orientation: Orientation = o.mount === 'altaz' ? 'rotating' : o.mount === 'eq' && o.cameraAngleDeg !== null ? 'known' : 'unknown';
  let overlap = o.overlap;
  let panelField = field;
  if (orientation !== 'known') {
    // a rectangle of unknown or changing orientation only reliably covers its short side
    const side = Math.min(field.w, field.h);
    panelField = { w: side, h: side };
    if (orientation === 'rotating') {
      overlap = Math.min(MAX_OVERLAP, overlap + ROTATING_EXTRA_OVERLAP);
      notes.push(`alt-az: the field rotates during a session, so panels are planned as ${side.toFixed(0)}′ squares with ${Math.round(overlap * 100)}% overlap`);
    } else notes.push(`the camera's angle on the sky is not known (needs EQ mode and mosaicCameraAngleDeg), so panels are planned as ${side.toFixed(0)}′ squares`);
  }
  const nx = panelCount(footprint.w, panelField.w, overlap);
  const ny = panelCount(footprint.h, panelField.h, overlap);
  const a = (footprint.angleDeg * Math.PI) / 180;
  const stepX = panelField.w * (1 - overlap);
  const stepY = panelField.h * (1 - overlap);
  const panels: LayoutPanel[] = [];
  let n = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let k = 0; k < nx; k++) {
      const ix = iy % 2 ? nx - 1 - k : k;
      const dx = (ix - (nx - 1) / 2) * stepX;
      const dy = (iy - (ny - 1) / 2) * stepY;
      const sky = offsetToSky(footprint.raHours, footprint.decDeg, dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a));
      panels.push({ id: `P${++n}`, ix, iy, ...sky });
    }
  }
  return { needed: nx * ny > 1, nx, ny, overlap, panelField, orientation, footprint, panels, notes };
}

/** What a telescope can do by itself, from devices/<id>.json. */
export interface NativeMosaic {
  maxScaleX: number;
  maxScaleY: number;
  requiresEq: boolean;
  /** false until the firmware's scale units have been confirmed on this hardware */
  verified: boolean;
}

export type Execution = 'panels' | 'native';

/**
 * Who moves the mount: panel-by-panel GoTo (always possible, tracks each panel) unless the owner
 * allowed the firmware's own mosaic and this one fits inside what the firmware can do.
 */
export function chooseExecution(layout: Pick<MosaicLayout, 'footprint'>, field: FieldSize, native: NativeMosaic | undefined, o: { allowNative: boolean; eqMode?: boolean }): { execution: Execution; scale: { x: number; y: number } | null; why: string } {
  const scale = { x: layout.footprint.w / field.w, y: layout.footprint.h / field.h };
  if (!o.allowNative) return { execution: 'panels', scale: null, why: 'panel-by-panel GoTo (native mosaics are off: mosaicAllowNative)' };
  if (!native) return { execution: 'panels', scale: null, why: 'panel-by-panel GoTo: this telescope has no native mosaic' };
  if (scale.x > native.maxScaleX || scale.y > native.maxScaleY) return { execution: 'panels', scale: null, why: `panel-by-panel GoTo: ${scale.x.toFixed(2)} × ${scale.y.toFixed(2)} frames is beyond the native ${native.maxScaleX} × ${native.maxScaleY}` };
  if (native.requiresEq && !o.eqMode) return { execution: 'panels', scale: null, why: 'panel-by-panel GoTo: the native mosaic needs EQ mode' };
  return { execution: 'native', scale, why: `the telescope's own mosaic at ${scale.x.toFixed(2)} × ${scale.y.toFixed(2)} frames${native.verified ? '' : ' (its scale units are not confirmed on hardware)'}` };
}
