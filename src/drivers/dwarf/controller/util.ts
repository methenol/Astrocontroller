/**
 * Constants and pure helpers shared by the controller components: firmware value tables, the
 * exposure/filter/white-balance vocabulary, and small numeric helpers.
 */
import { OPERATION_STATE, ASTRO_STATE } from '../protocol.js';
import type { ParamDef } from '../http.js';
import type { CameraName } from '../stacking.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Upper end of the focuser travel (seen 702 at the far stop, 2026-10-12). */
export const FOCUS_MAX = 702;

/** The firmware's camera id: 0 = tele, 1 = wide. */
export const camId = (c: CameraName) => (c === 'wide' ? 1 : 0);

/** Firmware time limits on a motor move or reset ("overtime"): the axis stopped early, not an error in the request. */
export const MOTOR_OVERTIME: ReadonlySet<number> = new Set([-14510, -14511, -14512, -14513, -14514, -14515, -14521, -14522]);

/** Motor position reads answer this while the axis has no reference (after power-on, or tracking). */
export const MOTOR_NO_REFERENCE = -14520;

export const opState = (n: unknown) => OPERATION_STATE[Number(n ?? 0)] ?? `state_${n}`;
export const astroState = (n: unknown) => ASTRO_STATE[Number(n ?? 0)] ?? `state_${n}`;

/** A device switch as the APK encodes it: `DeviceSwitchState` has OFF 0, ON 1, and `isOn(state) = state == 1`. */
export const deviceOn = (state: unknown): boolean => Number(state ?? 0) === 1;

export const FILTERS = ['VIS (no filter / UV-IR cut)', 'Astro (IR pass)', 'Duo-Band (Ha/OIII)'];
export const WB_SCENES = ['Incandescent', 'Warm Fluorescent', 'Fluorescent', 'Sunlight', 'Cloudy', 'Shadow', 'Twilight'];

/** Filter index from a name ("Ha", "Astro", "VIS", …) or a digit. */
export function resolveFilter(v: unknown): number {
  const s = String(v).toLowerCase();
  if (/^\d$/.test(s)) {
    const i = Number(s);
    if (i < FILTERS.length) return i;
  }
  if (s.includes('duo') || s.includes('ha') || s.includes('narrow') || s.includes('dual')) return 2;
  if (s.includes('astro') || s.includes('ir pass') || s.includes('irpass')) return 1;
  if (s.includes('vis') || s.includes('none') || s.includes('normal') || s.includes('uv')) return 0;
  throw new Error(`unknown filter "${v}" (use VIS, Astro, or Duo-Band)`);
}

/** Seconds of an exposure label: "1/100" → 0.01, "15" → 15. */
export function exposureLabelSeconds(name: string): number {
  if (name.includes('/')) {
    const [a, b] = name.split('/').map(Number);
    return a / b;
  }
  return Number(name);
}

/** The exposure option matching a label exactly, else the nearest in log time. */
export function matchExposure(values: Array<{ name: string; value: number }>, want: unknown): { name: string; value: number } {
  if (!values.length) throw new Error('the camera lists no exposure options in this mode');
  const s = String(want).trim().toLowerCase().replace(/s(ec(onds?)?)?$/, '').trim();
  const exact = values.find((v) => v.name.toLowerCase() === s);
  if (exact) return exact;
  const target = exposureLabelSeconds(s);
  if (!Number.isFinite(target) || target <= 0) throw new Error(`exposure "${want}" not understood; use e.g. "1/100", "0.5", "15" or "auto"`);
  // a label that is not a time (dist NaN) never wins: NaN would otherwise stick as the nearest
  const dist = (v: { name: string }) => {
    const d = Math.abs(Math.log(exposureLabelSeconds(v.name) / target));
    return Number.isFinite(d) ? d : Infinity;
  };
  const best = values.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  if (dist(best) === Infinity) throw new Error(`exposure "${want}" not offered: the camera lists ${values.map((v) => v.name).join(', ')}`);
  return best;
}

/** The allowed value nearest to `want` (all of them when the list is empty: `want` itself). */
export function nearest(allowed: number[], want: number): number {
  return allowed.length ? allowed.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)) : want;
}

export function describeParam(def: ParamDef, live?: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { current: live ?? def.currentValue };
  if (def.valueType === 3) out.type = 'bool';
  else if (def.values) out.options = def.values;
  else if (def.minValue !== undefined) out.range = `${def.minValue}..${def.maxValue}`;
  return out;
}

export const snake = (s: string) => s.replace(/([A-Z])/g, '_$1').toLowerCase();

export function bodyMode(v: unknown): 'eq' | 'altaz' | 'unknown' {
  return v === 1 ? 'eq' : v === 2 ? 'altaz' : 'unknown';
}

export function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export { timezoneOffsetHours } from '../../../util/time.js';
