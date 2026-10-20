/** The SD-card album, looking at and measuring images, and checking a session's raw subs. */
import path from 'node:path';
import { z } from 'zod';
import { round } from '../../dwarf/device.js';
import * as http from '../../dwarf/http.js';
import { listDir } from '../../dwarf/ftp.js';
import { analyze, crop as cropImage, loadImage } from '../../media/images.js';
import * as library from '../../library/transfer.js';
import { median } from '../../util/stats.js';
import { cameraArg, capturedLine, cropArg, imageResult, localTime, text, type ToolContext, type ToolFn } from './common.js';

const FITS_HEADER_KEYS = /EXPTIME|GAIN|DATE|OBJECT|RA|DEC|CCD-TEMP|FILTER|BAYER|INSTRUME|FOCAL|TELESCOP/;

export function registerMediaTools(tool: ToolFn, { hub }: ToolContext): void {
  tool(
    'list_album',
    'List media on the telescope SD card. type: all | photo | video | burst | astro | panorama. Astro entries include target, exposure, gain, filter, frames stacked and the session folder.',
    { type: z.enum(['all', 'photo', 'video', 'burst', 'astro', 'panorama']).optional(), page: z.number().int().min(0).optional(), page_size: z.number().int().min(1).max(50).optional() },
    async ({ type, page, page_size }) => {
      const mt = Number(Object.entries(http.MEDIA_TYPES).find(([, n]) => n === (type ?? 'all'))?.[0] ?? 0);
      const [counts, items] = await Promise.all([http.getMediaCounts(), http.listMedia(mt, page ?? 0, page_size ?? 15)]);
      return text({
        counts: Object.fromEntries(counts.map((c) => [http.MEDIA_TYPES[c.mediaType] ?? c.mediaType, c.count])),
        items: items.map((m) => ({
          path: m.filePath,
          camera: m.camId === 1 ? 'wide' : 'tele',
          type: http.MEDIA_TYPES[m.mediaType] ?? m.mediaType,
          time: localTime(m.modificationTime * 1000),
          sizeMB: round(m.fileSize / 1e6, 1),
          target: m.astroTargetName,
          astro: m.astroImageDetails
            ? { session: m.astroImageDetails.srcDir, stacked: m.astroImageDetails.shotsStacked, taken: m.astroImageDetails.shotsTaken, totalExposureS: m.astroImageDetails.totalExp, ...m.astroImageDetails.params }
            : undefined,
          exif: m.exifInfo,
        })),
      });
    },
  );

  tool(
    'view_image',
    'Show an image to you. source: "device:/DWARF3/…" (album JPG/PNG or FITS subframe on the telescope), or a library/captures path. FITS and 16-bit stacks are debayered and auto-stretched. Use crop to zoom (fractions 0..1).',
    { source: z.string(), crop: cropArg, max_size: z.number().int().min(256).max(2048).optional(), stretch: z.boolean().optional() },
    async ({ source, crop, max_size, stretch }) => {
      let { img } = await loadImage(source, hub);
      const header = img.header ? Object.fromEntries(Object.entries(img.header).filter(([k]) => FITS_HEADER_KEYS.test(k))) : undefined;
      if (crop) img = cropImage(img, crop);
      return imageResult(img, path.basename(source), { stretch, maxSize: max_size, note: header ? `FITS header: ${JSON.stringify(header)}` : undefined });
    },
  );

  tool(
    'analyze_image',
    'Measure an image numerically: background level & noise, saturation, sharpness, star count, median star HFR/FWHM (focus quality) and roundness (tracking quality), colour balance, with a plain-language assessment. source: tele | wide | stack | device:<path> | library path.',
    {
      source: z.string(),
      crop: cropArg,
      camera: cameraArg.optional().describe('which lens took it, for plate scale'),
      exposure_s: z.number().positive().max(60).optional().describe('for tele/wide: analyse ONE still at this exposure (e.g. 2 s to count stars at night), restoring the camera setting afterwards'),
    },
    async ({ source, crop, camera, exposure_s }) => {
      const live = source === 'tele' || source === 'wide';
      let { img } = await loadImage(source, hub, { exposureS: live ? exposure_s : undefined });
      if (crop) img = cropImage(img, crop);
      return text({ captured: capturedLine(img) || undefined, ...analyze(img, camera ?? (live ? source : undefined)) });
    },
  );

  tool(
    'delete_album_items',
    'Delete album items from the telescope SD card (paths as the album lists them; an astro session is deleted whole by its album entry, e.g. /DWARF3/Astronomy/<session>/stacked.jpg). Destructive — never on your own: only the files the user told you to delete; set confirm=true. The type is read from the album; media_type (1 photo, 2 video, 3 burst, 4 astro, 5 panorama) only when the album has no entry.',
    { paths: z.array(z.string()).min(1), media_type: z.number().int().min(1).max(5).optional(), confirm: z.literal(true) },
    async ({ paths, media_type }) => text(await http.deleteMedia(paths.map((p) => ({ filePath: p, mediaType: media_type })))),
  );

  tool(
    'analyze_subs',
    'Quality check of the newest RAW subframes (FITS) of an imaging session on the SD card, while it runs: per sub the star count, HFR/FWHM (focus), roundness (tracking / field rotation), background, saturation, sensor temperature and whether the scope rejected it (failed_). Use during live stacking to judge focus drift, trailing, dew or cloud from real subs rather than the stretched stack preview. Each sub is ~16 MB over Wi-Fi.',
    {
      count: z.number().int().min(1).max(6).optional().describe('newest N subs (default 3)'),
      session: z.string().optional().describe('DWARF_RAW_… folder; default the newest session'),
    },
    async ({ count, session }) => {
      const folder = session ? session.replace(/\/+$/, '').split('/').pop()! : (await library.listDeviceSessions(false)).sessions[0]?.folder;
      if (!folder) throw new Error('no astronomy sessions on the SD card');
      const parsed = library.parseSessionFolder(folder);
      if (!parsed) throw new Error(`not a DWARF session folder: ${folder}`);
      // the plate scale (arcsec figures) is the camera's that took the session
      const files = (await listDir(`/Astronomy/${folder}`)).filter((f) => !f.isDir && /\.fits$/i.test(f.name) && !/^stacked/i.test(f.name));
      const stamp = (n: string) => n.match(/(\d{8}-\d{9})/)?.[1] ?? n;
      files.sort((a, b) => stamp(a.name).localeCompare(stamp(b.name)));
      const subs = [];
      for (const f of files.slice(-(count ?? 3))) {
        const { img } = await loadImage(`device:/DWARF3/Astronomy/${folder}/${f.name}`, hub);
        const a = analyze(img, parsed.camera);
        subs.push({
          file: f.name,
          rejectedByScope: f.name.startsWith('failed_'),
          sensorC: sensorTemp(f.name),
          stars: a.stars.count,
          hfrPx: a.stars.medianHfrPx,
          fwhmArcsec: a.stars.medianFwhmArcsec,
          roundness: a.stars.medianRoundness,
          background: a.stats.median,
          saturatedPct: a.saturatedPercent,
          notes: a.assessment.length ? a.assessment : undefined,
        });
      }
      return text({
        session: folder,
        camera: parsed.camera,
        subsOnCard: files.length,
        rejectedOnCard: files.filter((f) => f.name.startsWith('failed_')).length,
        median: { stars: medianOf(subs.map((s) => s.stars)), hfrPx: medianOf(subs.map((s) => s.hfrPx)), roundness: medianOf(subs.map((s) => s.roundness)), background: medianOf(subs.map((s) => s.background)) },
        subs,
      });
    },
  );
}

/** The sensor temperature in a sub's name ("…_-3C.fits"); 0 °C is a temperature, not a missing one. */
function sensorTemp(name: string): number | undefined {
  const m = /_(-?\d+)C\.fits$/i.exec(name);
  return m ? Number(m[1]) : undefined;
}

/** The median of the subs that have the value. */
function medianOf(xs: Array<number | undefined>): number | undefined {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? median(v) : undefined;
}
