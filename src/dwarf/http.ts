/**
 * Telescope HTTP APIs: JSON on :8082, SD-card files on :80.
 *
 * Parameter IDs in /shootingMode/getParamAndSetting are packed int64s (> 2^53),
 * so responses are parsed with large integers kept as strings.
 */
import { config } from '../config.js';

const api = () => `http://${config.dwarf.host}:${config.dwarf.httpPort}`;

/** JSON.parse that keeps integers with 16+ digits as strings. */
function parseBigSafe(text: string): unknown {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  const res = await fetch(api() + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  const json = parseBigSafe(text) as { code: number; data: T; message?: string };
  if (json.code !== 0) throw new Error(`device API ${path} returned code ${json.code}${json.message ? `: ${json.message}` : ''}`);
  return json.data;
}

export interface DeviceInfo {
  deviceName: string;
  deviceId: number;
  sn: string;
  macAddress: string;
  staIpAddress?: string;
  staWifiName?: string;
  staWifiPwd?: string;
  devicePwd?: string;
  wifiConnectedMode?: number;
  sdCardInfo?: { availableSize: number; totalSize: number; hasSdcard: boolean };
  [k: string]: unknown;
}

export const getDeviceInfo = () => call<DeviceInfo>('POST', '/deviceInfo');

export interface FirmwareInfo {
  name: string;
  fwMajorVersion: number;
  fwMinorVersion: number;
  fwPatchVersion: number;
  fwBuildVersion: number;
}

export async function getFirmware(): Promise<{ version: string; raw: FirmwareInfo }> {
  const raw = await call<FirmwareInfo>('GET', '/getDefaultParamsConfig');
  return { version: `${raw.fwMajorVersion}.${raw.fwMinorVersion}.${raw.fwPatchVersion}.${raw.fwBuildVersion}`, raw };
}

export interface ShootingModeDef {
  id: number;
  name: string;
  parentId: number;
  shootingTechnology: Array<{ id: number; cameraIds: number[] }>;
}

let modesCache: ShootingModeDef[] | null = null;
export async function getShootingModes(): Promise<ShootingModeDef[]> {
  if (modesCache) return modesCache;
  const data = await call<{ shootingModes: ShootingModeDef[] }>('GET', '/shootingMode/getSupportedShootingModes');
  modesCache = data.shootingModes;
  return modesCache;
}

export const SHOOTING_TECH_NAMES: Record<number, string> = {
  1: 'single_photo',
  2: 'stacking',
  3: 'burst',
  4: 'video',
  5: 'timelapse',
  6: 'panorama',
};

export async function resolveShootingMode(nameOrId: string | number): Promise<ShootingModeDef> {
  const modes = await getShootingModes();
  const key = String(nameOrId).trim().toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = { astro: 'dso', deepsky: 'dso', photo: 'normal', daytime: 'normal', video: 'normal', tracking: 'autotracking', sun: 'sun', moon: 'moon', planets: 'planet', milkyway: 'milkyway', startrails: 'startrail' };
  const target = aliases[key] ?? key;
  const found = modes.find((m) => String(m.id) === target || m.name.toLowerCase().replace(/[\s/_-]+/g, '') === target);
  if (!found) throw new Error(`unknown shooting mode "${nameOrId}". Available: ${modes.map((m) => m.name).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------------------
// Camera parameter schema
// ---------------------------------------------------------------------------

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

const schemaCache = new Map<number, { at: number; schema: ParamSchema }>();

export function invalidateParamSchema(): void {
  schemaCache.clear();
}

export async function getParamSchema(modeId: number): Promise<ParamSchema> {
  const hit = schemaCache.get(modeId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.schema;
  const data = await call<Record<string, any>>('POST', '/shootingMode/getParamAndSetting', { modeId, cameraId: 0 });
  const schema: ParamSchema = { modeId, cameras: {}, device: {}, modeParams: {}, techSettings: {} };
  for (const cam of data.cameraParams ?? []) {
    const bucket: Record<string, ParamDef> = {};
    for (const p of cam.generalParams ?? []) bucket[p.name] = p;
    for (const p of Object.values(cam.specialParams ?? {}) as ParamDef[]) bucket[p.name] = p;
    schema.cameras[cam.cameraId] = bucket;
  }
  const byName = (list: ParamDef[] | undefined, suffix = ''): Record<string, ParamDef> =>
    Object.fromEntries((list ?? []).map((p) => [`${p.name}${suffix}`, p]));
  schema.device = byName(data.deviceParams?.generalParams);
  schema.modeParams = byName(data.shootingModeParams?.generalParams);
  // Tech settings come per camera: 15 = shared, 0 = tele, 1 = wide (e.g. stackCount exists for both).
  for (const group of data.shootingTechSettings ?? []) {
    Object.assign(schema.techSettings, byName(group.generalParams, group.cameraId === 1 ? '_wide' : ''));
  }
  schemaCache.set(modeId, { at: Date.now(), schema });
  return schema;
}

export async function rawParamSettings(modeId: number): Promise<unknown> {
  return call('POST', '/shootingMode/getParamAndSetting', { modeId, cameraId: 0 });
}

// ---------------------------------------------------------------------------
// Album
// ---------------------------------------------------------------------------

export const MEDIA_TYPES: Record<number, string> = {
  0: 'all',
  1: 'photo',
  2: 'video',
  3: 'burst',
  4: 'astro',
  5: 'panorama',
};

export interface MediaItem {
  fileName: string;
  filePath: string;
  fileSize: number;
  mediaType: number;
  modificationTime: number;
  thumbnailPath?: string;
  camId?: number;
  astroTargetName?: string;
  astroImageDetails?: Record<string, any>;
  exifInfo?: Record<string, unknown>;
  [k: string]: unknown;
}

export const getMediaCounts = () => call<Array<{ mediaType: number; count: number }>>('POST', '/album/list/mediaCounts');

export const listMedia = (mediaType: number, pageIndex = 0, pageSize = 20) =>
  call<MediaItem[]>('POST', '/album/list/mediaInfos', { mediaType, pageIndex, pageSize });

export const deleteMedia = (items: Array<{ filePath: string; mediaType: number }>) =>
  call<Array<{ filePath: string; isSuccess: boolean }>>('POST', '/album/delete', items);

/** URL for a file on the SD card (served from :80, rooted at the card). */
export function fileUrl(devicePath: string): string {
  const p = devicePath.startsWith('/') ? devicePath : `/${devicePath}`;
  return `http://${config.dwarf.host}${p.split('/').map(encodeURIComponent).join('/')}`;
}

export async function fetchFile(devicePath: string, timeoutMs = 60000): Promise<Buffer> {
  const res = await fetch(fileUrl(devicePath), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${devicePath}`);
  return Buffer.from(await res.arrayBuffer());
}
