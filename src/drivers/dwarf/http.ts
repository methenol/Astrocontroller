/**
 * Telescope HTTP APIs: JSON on :8082, SD-card files on :80.
 *
 * Parameter IDs in /shootingMode/getParamAndSetting are packed int64s (> 2^53), so responses are
 * parsed with large integers kept as strings (http/json.ts).
 */
import { invalidateShootingModes } from './http/device.js';
import { invalidateParamSchema } from './http/params.js';
import { resetApiHealth } from './http/client.js';

export { parseBigSafe } from './http/json.js';
export { type ApiHealth, apiHealth, timeoutExplanation, fileUrl, fetchFile, API_TIMEOUT_MS, FILE_TIMEOUT_MS } from './http/client.js';
export { type DeviceInfo, type FirmwareInfo, type ShootingModeDef, getDeviceInfo, redactDeviceInfo, getFirmware, getShootingModes, resolveShootingMode, SHOOTING_TECH_NAMES } from './http/device.js';
export { type ParamDef, type ParamSchema, getParamSchema, invalidateParamSchema, buildParamSchema } from './http/params.js';
export { type MediaItem, type DeleteOutcome, MEDIA_TYPES, getMediaCounts, listMedia, deleteMedia } from './http/album.js';

/** Another telescope address: nothing cached about the old device applies. */
export function forgetDevice(): void {
  invalidateShootingModes();
  invalidateParamSchema();
  resetApiHealth();
}
