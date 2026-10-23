/** The camera parameter schema per shooting mode: ids, ranges and current values behind every setting. */
import { call } from './client.js';

export interface ParamDef {
  name: string;
  paramId: string;
  valueType: number; // 0 int range, 1 enum, 3 bool
  currentValue?: unknown;
  defaultValue?: unknown;
  minValue?: number;
  maxValue?: number;
  step?: number;
  values?: Array<number | { name: string; value: number }>;
  modes?: number[];
  currentMode?: number;
  ctModeValues?: number[];
  sceneModeValues?: number[];
  range?: Array<{ minValue: number; maxValue: number; techId: number }>;
}

export interface ParamSchema {
  modeId: number;
  cameras: Record<number, Record<string, ParamDef>>; // cameraId → name → def
  device: Record<string, ParamDef>;
  modeParams: Record<string, ParamDef>; // DSO-specific (stackCount, autoCalibration…)
  techSettings: Record<string, ParamDef>; // burst/timelapse settings
}

/** The answer of /shootingMode/getParamAndSetting, as far as it is read. */
interface RawParamSettings {
  cameraParams?: Array<{ cameraId: number; generalParams?: ParamDef[]; specialParams?: Record<string, ParamDef> }>;
  deviceParams?: { generalParams?: ParamDef[] };
  shootingModeParams?: { generalParams?: ParamDef[] };
  shootingTechSettings?: Array<{ cameraId: number; generalParams?: ParamDef[] }>;
}

/** Tech-setting groups per camera: 15 = shared, 0 = tele, 1 = wide (stackCount exists for both). */
const WIDE_CAMERA_ID = 1;
/** Current values change with every setting, but ranges and ids do not: kept this long. */
const SCHEMA_TTL_MS = 10 * 60_000;

const cache = new Map<number, { at: number; schema: Promise<ParamSchema> }>();

export function invalidateParamSchema(): void {
  cache.clear();
}

const isParam = (p: unknown): p is ParamDef => !!p && typeof p === 'object' && typeof (p as ParamDef).name === 'string';

const byName = (list: unknown, suffix = ''): Record<string, ParamDef> =>
  Object.fromEntries((Array.isArray(list) ? list : []).filter(isParam).map((p) => [`${p.name}${suffix}`, p]));

export function buildParamSchema(modeId: number, data: RawParamSettings | null | undefined): ParamSchema {
  const schema: ParamSchema = { modeId, cameras: {}, device: {}, modeParams: {}, techSettings: {} };
  for (const cam of data?.cameraParams ?? []) {
    if (!cam || typeof cam.cameraId !== 'number') continue;
    schema.cameras[cam.cameraId] = { ...byName(cam.generalParams), ...byName(Object.values(cam.specialParams ?? {})) };
  }
  schema.device = byName(data?.deviceParams?.generalParams);
  schema.modeParams = byName(data?.shootingModeParams?.generalParams);
  for (const group of data?.shootingTechSettings ?? []) {
    if (group) Object.assign(schema.techSettings, byName(group.generalParams, group.cameraId === WIDE_CAMERA_ID ? '_wide' : ''));
  }
  return schema;
}

/** The schema for a mode, cached for SCHEMA_TTL_MS; concurrent callers share one request. */
export function getParamSchema(modeId: number, now = Date.now()): Promise<ParamSchema> {
  const hit = cache.get(modeId);
  if (hit && now - hit.at < SCHEMA_TTL_MS) return hit.schema;
  const schema = call<RawParamSettings>('POST', '/shootingMode/getParamAndSetting', { modeId, cameraId: 0 }).then((d) => buildParamSchema(modeId, d));
  const entry = { at: now, schema };
  cache.set(modeId, entry);
  schema.catch(() => {
    if (cache.get(modeId) === entry) cache.delete(modeId);
  });
  return schema;
}
