/**
 * The Seestar agent's album, image, camera and focus tools: the Dwarf's tool names and arguments
 * (mcp/tools/media.ts, camera.ts, motion.ts, darks.ts), so skills and notes written for one
 * telescope read the same with the other, carried out with the Seestar's storage (storage.ts),
 * live views (hub.ts), image sockets and photo capture (capture.ts).
 *
 * Image sources: tele | wide (the next full-resolution frame of that camera, borrowing it when the
 * other one is selected) | stack (the stacked image) | preview (one live tele sub) |
 * device:/SEESTAR/<storage path> | a library, captures or workspace path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { deviceLibrary } from '../../library/device-library.js';
import * as library from '../../library/transfer.js';
import { analyze, crop as cropImage, decode, type FloatImage } from '../../media/images.js';
import { resolveLocalPath } from '../../media/image/load.js';
import { cropArg, capturedLine, imageResult, localTime, text, type ToolFn } from '../../mcp/tools/common.js';
import { median } from '../../util/stats.js';
import { BURST_MAX } from './capture.js';
import type { Seestar } from './device.js';
import { measureSeestar, NOMINAL_FOV, seestarFocusSweep } from './focus.js';
import type { SeestarMedia } from './web.js';

const DEVICE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const FITS_HEADER_KEYS = /EXPTIME|EXPOSURE|GAIN|DATE|OBJECT|^RA$|^DEC$|CCD-TEMP|FILTER|BAYER|TELESCOP|FOCALLEN|FOCUSPOS|WIDECAM/;
const MEDIA_TYPES: Record<string, number> = { all: 0, photo: 1, video: 2, astro: 4 };
const TYPE_NAMES: Record<number, string> = { 1: 'photo', 2: 'video', 4: 'astro' };

const cameraArg = z.enum(['tele', 'wide']).describe('tele = the telephoto, wide = the wide-angle lens');

/** An image from any of the sources above. `encoded` is the original JPEG when there is one. */
export async function seestarImage(source: string, scope: Seestar, media: SeestarMedia): Promise<{ img: FloatImage; encoded?: Buffer }> {
  if (source === 'tele' || source === 'wide') return media.liveFrame(source);
  if (source === 'stack' || source === 'preview') {
    if (source === 'preview' && scope.exposing !== 'tele') return scope.withCamera('tele', 'a tele preview', async () => ({ img: (await scope.grabImage('tele', 'preview')).image }));
    return { img: (await scope.grabImage('tele', source === 'stack' ? 'stacked' : 'preview')).image };
  }
  if (source.startsWith('device:')) {
    const p = source.slice('device:'.length);
    const devicePath = p.startsWith('/SEESTAR/') ? p : `/SEESTAR/${p.replace(/^\/+/, '')}`;
    const buf = await deviceLibrary().album.fetch(devicePath, DEVICE_FILE_MAX_BYTES);
    return { img: await decode(buf, devicePath), encoded: /\.jpe?g$/i.test(devicePath) ? buf : undefined };
  }
  const local = resolveLocalPath(source);
  const buf = await fs.promises.readFile(local);
  return { img: await decode(buf, local), encoded: /\.jpe?g$/i.test(local) ? buf : undefined };
}

export function registerSeestarMediaTools(tool: ToolFn, scope: Seestar, media: SeestarMedia): void {
  const arcsecPerPx = (img: FloatImage) => ((scope.state.fov ?? NOMINAL_FOV).h * 3600) / (img.frameWidth ?? img.width);

  // ---- the album ------------------------------------------------------------

  tool(
    'list_album',
    "List what is on the Seestar's storage: stacks (astro, with target, frames stacked, sub length, filter and the session they belong to), videos and photos. type: all | photo | video | astro.",
    { type: z.enum(['all', 'photo', 'video', 'astro']).optional(), page: z.number().int().min(0).optional(), page_size: z.number().int().min(1).max(50).optional() },
    async ({ type, page, page_size }) => {
      const a = deviceLibrary().album;
      const [counts, items] = await Promise.all([a.counts(), a.list(MEDIA_TYPES[type ?? 'all']!, page ?? 0, page_size ?? 15)]);
      return text({
        counts: Object.fromEntries(counts.map((c) => [c.mediaType === 0 ? 'all' : (TYPE_NAMES[c.mediaType] ?? c.mediaType), c.count])),
        items: items.map((m) => ({
          path: m.filePath,
          type: TYPE_NAMES[m.mediaType] ?? m.mediaType,
          time: localTime(m.modificationTime * 1000),
          sizeMB: +(m.fileSize / 1e6).toFixed(1),
          target: m.astroTargetName,
          astro: m.astroImageDetails ? { session: m.astroImageDetails.srcDir, stacked: m.astroImageDetails.shotsStacked, totalExposureS: m.astroImageDetails.totalExp, ...m.astroImageDetails.params } : undefined,
        })),
      });
    },
  );

  tool(
    'delete_album_items',
    "Delete items from the Seestar's storage (paths as list_album gives them). A stack goes with its JPEG and thumbnail, but its subs stay (delete those with the session: library tools). Destructive — never on your own: only the files the user told you to delete; set confirm=true.",
    { paths: z.array(z.string()).min(1), confirm: z.literal(true) },
    async ({ paths }) => text(await deviceLibrary().album.delete(paths.map((filePath) => ({ filePath })))),
  );

  // ---- looking at images ----------------------------------------------------

  tool(
    'view_image',
    'Show an image to you. source: tele | wide (the next full-resolution frame of that camera) | stack | preview (one live tele sub) | "device:/SEESTAR/MyWorks/…" (a stack, sub, photo on the Seestar) | a library/captures path. FITS are debayered and auto-stretched; a Seestar stack is colour. Use crop to zoom (fractions 0..1).',
    { source: z.string(), crop: cropArg, max_size: z.number().int().min(256).max(2048).optional(), stretch: z.boolean().optional() },
    async ({ source, crop, max_size, stretch }) => {
      let { img } = await seestarImage(source, scope, media);
      const header = img.header ? Object.fromEntries(Object.entries(img.header).filter(([k]) => FITS_HEADER_KEYS.test(k))) : undefined;
      if (crop) img = cropImage(img, crop);
      return imageResult(img, path.basename(source), { stretch, maxSize: max_size, note: header ? `FITS header: ${JSON.stringify(header)}` : undefined });
    },
  );

  tool(
    'analyze_image',
    'Measure an image numerically: background level & noise, saturation, star count, median star HFR/FWHM (focus quality) and roundness (tracking quality), colour balance, with a plain-language assessment. source: tele | wide | stack | preview | device:<path> | library path.',
    { source: z.string(), crop: cropArg },
    async ({ source, crop }) => {
      let { img } = await seestarImage(source, scope, media);
      if (crop) img = cropImage(img, crop);
      const tele = source === 'stack' || source === 'preview' || source === 'tele' || source.startsWith('device:');
      return text({ captured: capturedLine(img) || undefined, ...analyze(img, undefined, tele ? arcsecPerPx(img) : undefined) });
    },
  );

  tool(
    'view_camera',
    'Look through a camera now: the next full-resolution frame from tele or wide (a view is started if none runs and the arm is open; the other camera is borrowed for the frame and given back).',
    { camera: cameraArg.optional(), crop: cropArg, max_size: z.number().int().min(256).max(2048).optional() },
    async ({ camera, crop, max_size }) => {
      let { img } = await seestarImage(camera ?? 'tele', scope, media);
      if (crop) img = cropImage(img, crop);
      return imageResult(img, `${camera ?? 'tele'} live`, { maxSize: max_size, note: capturedLine(img) || undefined });
    },
  );

  tool(
    'analyze_subs',
    "Quality check of the newest raw subs (FITS) of a session on the Seestar, while it stacks: per sub the star count, HFR/FWHM (focus), roundness (tracking / field rotation), background, saturation and sensor temperature. Judge focus drift, trailing, dew or cloud from real subs rather than the stretched stack. Each sub is ~16 MB over the tunnel (~7 s).",
    { count: z.number().int().min(1).max(6).optional().describe('newest N subs (default 3)'), session: z.string().optional().describe('SEESTAR_RAW_… session; default the newest') },
    async ({ count, session }) => {
      const s = await deviceLibrary().resolveSession(session ?? 'latest');
      const names = await media.storage.sessionSubs(s.folder);
      const album = deviceLibrary().album;
      const subs = [];
      for (const rel of names.slice(-(count ?? 3))) {
        const name = path.posix.basename(rel);
        const img = await decode(await album.fetch(`/SEESTAR/${rel}`, DEVICE_FILE_MAX_BYTES), name);
        const scale = arcsecPerPx(img);
        const a = analyze(img, 'tele', scale);
        subs.push({
          file: name,
          sensorC: typeof img.header?.['CCD-TEMP'] === 'number' ? +(img.header['CCD-TEMP'] as number).toFixed(1) : undefined,
          stars: a.stars.count,
          hfrPx: a.stars.medianHfrPx,
          fwhmArcsec: a.stars.medianHfrPx !== undefined ? +(a.stars.medianHfrPx * 2 * scale).toFixed(2) : undefined,
          roundness: a.stars.medianRoundness,
          background: a.stats.median,
          saturatedPct: a.saturatedPercent,
          notes: a.assessment.length ? a.assessment : undefined,
        });
      }
      return text({
        session: s.folder,
        camera: s.camera,
        subsOnScope: names.length,
        median: { stars: medianOf(subs.map((x) => x.stars)), hfrPx: medianOf(subs.map((x) => x.hfrPx)), roundness: medianOf(subs.map((x) => x.roundness)), background: medianOf(subs.map((x) => x.background)) },
        subs,
      });
    },
  );

  // ---- the camera -----------------------------------------------------------

  tool(
    'take_photo',
    'Take a photo: the next full-resolution live frame in colour (JPEG), saved in the library under _photos/<date>; raw=true takes the 16-bit Bayer sub instead (FITS beside a stretched JPEG; a 16 MB transfer). The arm must be open. count > 1 takes a burst (colour frames). The other camera is borrowed for the shot and given back.',
    { camera: cameraArg.optional(), count: z.number().int().min(1).max(BURST_MAX).optional(), raw: z.boolean().optional() },
    async ({ camera, count, raw }) => {
      const cam = camera ?? 'tele';
      if (count && count > 1) return text({ result: await media.capture.burst(cam, count) });
      return text(await media.capture.photo(cam, { raw }));
    },
  );

  tool(
    'video_recording',
    "Record the tele camera's video onto the Seestar (MyWorks/Scenery_video, listed by list_album and transferable). action start | stop.",
    { action: z.enum(['start', 'stop']) },
    async ({ action }) => text({ result: await scope.record(action === 'start'), recording: action === 'start' }),
  );

  tool(
    'timelapse',
    'A timelapse from the live view: a colour frame every interval_s (default 5) for total_s (default: until stopped), made into an MP4 in the library under _photos/<date>. action start | stop | status.',
    { action: z.enum(['start', 'stop', 'status']), camera: cameraArg.optional(), interval_s: z.number().min(1).max(3600).optional(), total_s: z.number().min(10).optional() },
    async ({ action, camera, interval_s, total_s }) => {
      if (action === 'status') return text(media.capture.timelapseStatus());
      return text({ result: await media.capture.timelapse(camera ?? 'tele', action === 'start', interval_s, total_s) });
    },
  );

  tool(
    'stacking_status',
    'Live-stacking progress: frames stacked and dropped, integration so far, target, the view and stack state, the last stacking error, and the sessions on the Seestar. Use view_image source=stack to see it, analyze_subs to judge the raw subs.',
    {},
    async () => {
      await scope.refreshState().catch(() => {});
      const st = scope.state;
      const expS = (st.deviceState as { setting?: { exp_ms?: { stack_l?: number } } } | undefined)?.setting?.exp_ms?.stack_l;
      const sessions = await library.listDeviceSessions(false).catch(() => null);
      return text({
        target: st.view.target,
        view: { state: st.view.state, mode: st.view.mode, stage: st.view.stage },
        stack: { ...st.stack, integrationS: expS && st.stack.stacked ? Math.round((st.stack.stacked * expS) / 1000) : undefined, subLengthS: expS ? expS / 1000 : undefined },
        busy: scope.isBusy(),
        cameras: { selected: scope.selected, exposing: scope.exposing },
        newestSession: sessions?.sessions[0]?.folder,
      });
    },
  );

  // ---- focus ----------------------------------------------------------------

  tool(
    'star_sharpness',
    'Measure focus on the stars in one full-resolution tele frame now: median HFR (px and arcsec), FWHM, roundness, star count, with a verdict. Needs stars in view (a star-mode view, the arm open, at night).',
    {},
    async () => {
      const { sharp } = await measureSeestar(scope);
      return text({ focuserPosition: scope.state.focus.position, ...sharp });
    },
  );

  tool(
    'star_focus',
    "Tune focus on the stars: step the focuser around a position (default where it is), measure every step on a full-resolution tele frame, fit the curve, and stop on the sharpest. Blocks for a few minutes. Run the Seestar's autofocus first for the wide search; this is the fine one (±10 steps at step 1 by default). bestAtEdge = the peak is at the sweep's edge: run it again centred on the best position.",
    { center: z.number().int().min(0).optional(), range: z.number().int().min(5).max(300).optional().describe('focus steps either side (default 10)'), step: z.number().int().min(1).max(100).optional().describe('focus steps between samples (default 1)'), apply: z.boolean().optional() },
    async (o) => {
      const r = await seestarFocusSweep(scope, o);
      const { finalImage: _img, ...rest } = r;
      return text(rest);
    },
  );

  // ---- darks ----------------------------------------------------------------

  tool(
    'dark_frames',
    "The Seestar's dark library: it makes a master dark for each sub length by itself (auto_master_dark, with the arm closed) the first time it stacks at that length, and keeps it in darklibrary/<length>s. action list | status: the masters it has; ensure_auto: turn auto_master_dark on.",
    { action: z.enum(['list', 'status', 'ensure_auto']) },
    async ({ action }) => {
      if (action === 'ensure_auto') {
        await scope.setSetting({ auto_master_dark: true });
        return text({ result: 'auto_master_dark is on: the Seestar makes the master dark for a new sub length before it stacks' });
      }
      const r = await scope.raw('get_dark_files');
      const groups = ((r.result as { list?: Array<{ files?: Array<{ name: string; count: number; exposure_sec?: number }> }> })?.list ?? []).flatMap((g) => g.files ?? []);
      const auto = ((await scope.settings()) as { auto_master_dark?: boolean } | undefined)?.auto_master_dark;
      return text({ autoMasterDark: auto, masters: groups.map((g) => ({ subLengthS: g.exposure_sec ?? parseFloat(g.name), files: g.count, folder: `darklibrary/${g.name}` })) });
    },
  );
}

function medianOf(xs: Array<number | undefined>): number | undefined {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? median(v) : undefined;
}
