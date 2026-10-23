/** Shooting modes, camera settings, stills/video/timelapse, and looking through a camera. */
import { z } from 'zod';
import { BURST_MAX } from '../../drivers/dwarf/device.js';
import * as http from '../../drivers/dwarf/http.js';
import { crop as cropImage, loadImage } from '../../media/images.js';
import { cameraArg, cropArg, exposureArgSeconds, imageResult, text, type ToolContext, type ToolFn } from './common.js';

export function registerCameraTools(tool: ToolFn, { dwarf, hub }: ToolContext): void {
  tool(
    'set_shooting_mode',
    'Switch the telescope scene mode. Normal = daytime photo/video/burst/timelapse; DSO = deep-sky stacking; Sun/Moon/Planet = solar-system; Milky Way; Star Trail; Auto Tracking = daytime object tracking; Panorama.',
    { mode: z.string().describe('Normal | DSO | Sun | Moon | Planet | Milky Way | Star Trail | Auto Tracking | Panorama (or numeric id)') },
    async ({ mode }) => {
      const m = await dwarf.setShootingMode(mode);
      return text(`shooting mode → ${m.name} (id ${m.id}); techniques: ${m.shootingTechnology.map((t) => http.SHOOTING_TECH_NAMES[t.id]).join(', ')}`);
    },
  );

  tool(
    'get_camera_settings',
    'Current values and allowed options for a camera in the current (or given) shooting mode: exposure, gain, white balance, filter, brightness/contrast/saturation/hue/sharpness, resolution, burst/timelapse/stacking settings, plus device-wide settings (autoShutdown, disableHostSlave).',
    { camera: cameraArg, mode: z.string().optional().describe('shooting mode name/id; default current') },
    async ({ camera, mode }) => {
      const modeId = mode ? (await http.resolveShootingMode(mode)).id : undefined;
      return text(await dwarf.cameraSettings(camera, modeId));
    },
  );

  tool(
    'set_camera_setting',
    'Change one camera setting. exposure: "auto" or seconds like "1/500", "0.5", "15", "60" (nearest supported). gain: number (nearest allowed). white_balance: auto | scene name | kelvin. filter: VIS | Astro | Duo-Band (tele only). Also any setting name from get_camera_settings (brightness, contrast, saturation, hue, sharpness, stackCount, burstCount, timelapseIntervalTime, autoCalibration, and device-wide autoShutdown / disableHostSlave with value true/false).',
    {
      camera: cameraArg,
      setting: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      mode: z.string().optional().describe('apply to this shooting mode instead of the current one (e.g. set DSO exposure while in Normal)'),
      allow_live_stall: z.boolean().optional().describe('required to set a wide-camera exposure ≥ 1 s: that stops the wide live video until exposure is back to auto (only for wide-camera stacking)'),
    },
    async ({ camera, setting, value, mode, allow_live_stall }) => {
      if (camera === 'wide' && /^(exposure|exp|shutter)$/i.test(setting) && typeof value !== 'boolean' && String(value).toLowerCase() !== 'auto') {
        if (exposureArgSeconds(value) >= 1 && !allow_live_stall) {
          throw new Error(
            `a ${value}s manual exposure on the wide camera stops its live video completely (verified). For a night/sky look use sky_check, or view_camera/analyze_image with exposure_s=${value} (one still, settings restored). Pass allow_live_stall=true only for wide-camera stacking. Nothing was changed.`,
          );
        }
      }
      const m = mode ? await http.resolveShootingMode(mode) : undefined;
      const res = await dwarf.setSetting(camera, setting, value, m?.id);
      const modeName = m?.name ?? dwarf.state.shootingMode?.name ?? '?';
      return text(`${res}  [stored in ${modeName} mode — each shooting mode keeps its own camera settings; switching mode (GoTo switches to DSO) uses that mode's values]`);
    },
  );

  tool(
    'take_photo',
    'Take a still photo (count>1 = burst; a burst switches to Normal mode when the current mode has none, and the telescope shoots at least 3) with the tele or wide camera using current settings. Returns the album file path; use view_image with "device:<path>" to inspect it.',
    { camera: cameraArg, count: z.number().int().min(1).max(BURST_MAX).optional() },
    async ({ camera, count }) => {
      if (count && count > 1) return text(await dwarf.burst(camera, count));
      const item = await dwarf.takePhoto(camera);
      return text(item ? { saved: item.filePath, exif: item.exifInfo, thumbnail: item.thumbnailPath } : 'photo taken (album entry not found yet)');
    },
  );

  tool('video_recording', 'Start or stop video recording on a camera.', { camera: cameraArg, action: z.enum(['start', 'stop']) }, async ({ camera, action }) => {
    return text(await dwarf.record(camera, action));
  });

  tool(
    'timelapse',
    'Start or stop a timelapse on a camera. interval_s from {0,1,2,3,4,5,8,10,15,20,25,30,60}; total_s 0 = until stopped.',
    { camera: cameraArg, action: z.enum(['start', 'stop']), interval_s: z.number().min(0).optional(), total_s: z.number().min(0).optional() },
    async ({ camera, action, interval_s, total_s }) => {
      return text(await dwarf.timelapse(camera, action, interval_s, total_s));
    },
  );

  tool(
    'view_camera',
    'Look at what a camera sees right now (returns an image). source: tele | wide | stack (the current live-stacking result). With the camera on auto exposure this is a live frame; with a manual exposure ≥ 1 s (e.g. checking for stars at night) it takes a real still photo at that exposure instead, because the telescope stops its live stream at long exposures; the tele in DSO mode outside a stack has no video at all, so a tele view there is a still photo too. Use crop to zoom into a region; full_resolution grabs a 1920×1080 frame (slower).',
    {
      source: z.enum(['tele', 'wide', 'stack']),
      crop: cropArg,
      full_resolution: z.boolean().optional(),
      max_size: z.number().int().min(256).max(2048).optional().describe('longest edge of the returned image (default 1280)'),
      stretch: z.boolean().optional().describe('auto-stretch faint data'),
      exposure_s: z
        .number()
        .positive()
        .max(60)
        .optional()
        .describe('take ONE still at this exposure (e.g. 2 to see stars at night) and restore the camera setting afterwards; keeps the live view working. Prefer this over changing the camera exposure with set_camera_setting.'),
    },
    async ({ source, crop, full_resolution, max_size, stretch, exposure_s }) => {
      let { img } = await loadImage(source, hub, { fullRes: full_resolution, exposureS: source === 'stack' ? undefined : exposure_s });
      if (crop) img = cropImage(img, crop);
      return imageResult(img, /\bstill\b/.test(img.source) ? img.source : `${source} live`, { stretch, maxSize: max_size });
    },
  );
}
