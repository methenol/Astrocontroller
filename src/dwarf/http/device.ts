/** Device identity, firmware and the shooting modes it supports. */
import { call } from './client.js';

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

export const getDeviceInfo = (): Promise<DeviceInfo> => call<DeviceInfo>('POST', '/deviceInfo');

/** Fields that hold credentials (the Wi-Fi and device passwords): never shown to the agent, the UI or a log. */
const SECRET_FIELD = /pwd|pass(word)?|secret|token|key$/i;

/** The device info without its credentials: each secret field present is replaced by "(hidden)". */
export function redactDeviceInfo(info: DeviceInfo): Record<string, unknown> {
  return Object.fromEntries(Object.entries(info).map(([k, v]) => [k, SECRET_FIELD.test(k) && v !== undefined && v !== '' ? '(hidden)' : v]));
}

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

export const SHOOTING_TECH_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'single_photo',
  2: 'stacking',
  3: 'burst',
  4: 'video',
  5: 'timelapse',
  6: 'panorama',
});

/** Names people use for a mode → the firmware's mode name (normalised: lower case, no separators). */
const MODE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  astro: 'dso',
  deepsky: 'dso',
  photo: 'normal',
  daytime: 'normal',
  video: 'normal',
  tracking: 'autotracking',
  planets: 'planet',
  milkyway: 'milkyway',
  startrails: 'startrail',
});

const normalise = (s: string) => s.trim().toLowerCase().replace(/[\s/_-]+/g, '');

// The mode list is fixed per firmware: fetched once per device (one request shared by concurrent callers).
let modes: Promise<ShootingModeDef[]> | null = null;

export function getShootingModes(): Promise<ShootingModeDef[]> {
  if (modes) return modes;
  const fetching = call<{ shootingModes?: ShootingModeDef[] }>('GET', '/shootingMode/getSupportedShootingModes').then((d) => {
    if (!Array.isArray(d?.shootingModes)) throw new Error('the telescope listed no shooting modes');
    return d.shootingModes;
  });
  modes = fetching;
  // a failed fetch is not kept: the next call asks again (unless a newer fetch already replaced it)
  fetching.catch(() => {
    if (modes === fetching) modes = null;
  });
  return fetching;
}

/** Forget the mode list (another telescope). */
export function invalidateShootingModes(): void {
  modes = null;
}

export async function resolveShootingMode(nameOrId: string | number): Promise<ShootingModeDef> {
  const list = await getShootingModes();
  const key = normalise(String(nameOrId));
  const target = Object.hasOwn(MODE_ALIASES, key) ? MODE_ALIASES[key] : key;
  const found = list.find((m) => String(m.id) === target || normalise(m.name) === target);
  if (!found) throw new Error(`unknown shooting mode "${nameOrId}". Available: ${list.map((m) => m.name).join(', ')}`);
  return found;
}
