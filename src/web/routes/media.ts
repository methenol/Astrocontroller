/** Live snapshots, the SD-card album, the library, transfers, processing and agent captures. */
import { roiForTarget } from '../../processing/roi.js';
import { estop } from '../../safety/estop.js';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { type Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import { deviceLibrary } from '../../library/device-library.js';
import { decode } from '../../media/images.js';
import { displayJpeg } from '../../mcp/tools/common.js';
import * as library from '../../library/transfer.js';
import * as processing from '../../processing/queue.js';
import * as studio from '../../processing/studio.js';
import { badRequest, body, notFound, queryNumber, queryString, route } from '../http.js';
import type { WebContext } from '../context.js';
import { unsupported, type Capabilities } from '../telescope.js';

const ALBUM_PAGE_SIZE = 24;
const THUMB_TTL_MS = 3600e3;
const THUMB_MAX_BYTES = 2e6;
const THUMB_MAX_ENTRIES = 300;
/** All cached files together stay under this. */
const THUMB_BUDGET_BYTES = 64 * 1024 * 1024;
/** The album viewer shows photos and stacked images, not whole videos (those are transferred). */
const DEVICE_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** the longer side of a FITS rendered for the album's full view */
const FITS_VIEW_SIZE = 2048;
/** A snapshot reuses a frame up to this old, and waits this long for a new one. */
const SNAPSHOT_MAX_AGE_MS = 5000;
const SNAPSHOT_TIMEOUT_MS = 40_000;
/** Items one delete request may name (a page of the album is 24; a night's card holds far fewer). */
const ALBUM_DELETE_MAX = 100;

/** Small album files (thumbnails, stacked JPGs) kept in memory: the SD card is slow over Wi-Fi. */
export class ThumbCache {
  private readonly entries = new Map<string, { buf: Buffer; type: string; at: number }>();
  private bytes = 0;

  get(p: string): { buf: Buffer; type: string } | null {
    const hit = this.entries.get(p);
    if (!hit) return null;
    if (Date.now() - hit.at >= THUMB_TTL_MS) {
      this.drop(p);
      return null;
    }
    return hit;
  }

  put(p: string, buf: Buffer, type: string): void {
    if (buf.length >= THUMB_MAX_BYTES) return;
    this.drop(p);
    this.entries.set(p, { buf, type, at: Date.now() });
    this.bytes += buf.length;
    // the oldest go first, until both the count and the byte budget are met
    while (this.entries.size > THUMB_MAX_ENTRIES || this.bytes > THUMB_BUDGET_BYTES) this.drop(this.entries.keys().next().value!);
  }

  private drop(p: string): void {
    const e = this.entries.get(p);
    if (!e) return;
    this.bytes -= e.buf.length;
    this.entries.delete(p);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** Bytes held (for tests). */
  get size(): number {
    return this.bytes;
  }
}

const contentType = (p: string) => (p.endsWith('.png') ? 'image/png' : p.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');

const TransferBody = z.union([
  z.object({ session: z.string().min(1), subframes: z.boolean().optional(), calibration: z.boolean().optional(), process: z.boolean().optional() }),
  z.object({ paths: z.array(z.string().min(1)).min(1) }),
]);

const ProcessBody = z.object({
  session: z.string().optional(),
  sessions: z.array(z.string()).optional(),
  target: z.string().optional(),
  /** with target: that camera's sessions (required when the target has sessions of both) */
  camera: z.enum(['tele', 'wide']).optional(),
  profile: z.string().optional(),
});

const AlbumDeleteBody = z.object({
  /** album paths as the album lists them (/DWARF3/…, /SEESTAR/…) */
  paths: z.array(z.string().min(1)).min(1).max(ALBUM_DELETE_MAX),
  /** only when the album has no entry for the path (1 photo … 5 panorama) */
  mediaType: z.number().int().min(1).max(5).optional(),
});

const SessionDeleteBody = z.object({
  /** session folders as the telescope lists them (DWARF_RAW_…, SEESTAR_RAW_…) */
  folders: z.array(z.string().min(1)).min(1).max(ALBUM_DELETE_MAX),
  /** delete even a session that is not complete in the library */
  force: z.boolean().optional(),
});

/** A target's library sessions of one camera: one stack never mixes the tele and wide cameras. */
function targetSessions(target: string, camera: 'tele' | 'wide' | undefined): string[] {
  if (camera) return library.librarySessionsFor(target, camera);
  const tele = library.librarySessionsFor(target, 'tele');
  const wide = library.librarySessionsFor(target, 'wide');
  if (tele.length && wide.length) throw badRequest(`${target} has tele and wide sessions: give camera (tele or wide)`);
  return tele.length ? tele : wide;
}

export function mediaRoutes({ scope }: WebContext, thumbs: ThumbCache): Router {
  const api = express.Router();
  const hub = scope.hub;
  const need = (cap: keyof Capabilities, what: string) => {
    if (!scope.capabilities[cap]) throw unsupported(scope, what);
  };
  // the album and its files are the running driver's storage (library/device-library.ts)
  const album = () => deviceLibrary().album;

  api.get(
    '/snapshot/:name',
    route(async (req, res) => {
      const name = String(req.params.name);
      if (!['tele', 'wide', 'stack'].includes(name)) throw notFound(`unknown stream ${name}`);
      if (!(scope.capabilities.video as string[]).includes(name)) throw unsupported(scope, `The ${name} view`);
      const f = await hub.get(name).snapshot(SNAPSHOT_MAX_AGE_MS, SNAPSHOT_TIMEOUT_MS);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.end(f.jpeg);
    }),
  );

  // ---- album on the SD card
  api.get(
    '/album',
    route(async (req) => {
      need('album', 'The SD-card album');
      const a = album();
      const type = queryNumber(req, 'type') ?? 0;
      const page = Math.max(0, Math.floor(queryNumber(req, 'page') ?? 0));
      const [counts, items] = await Promise.all([a.counts(), a.list(type, page, ALBUM_PAGE_SIZE)]);
      // the page size lets the UI tell the last page from a full one
      return { counts, items, pageSize: ALBUM_PAGE_SIZE };
    }),
  );

  api.get(
    '/device-file',
    route(async (req, res) => {
      need('album', 'The SD-card album');
      const a = album();
      const p = queryString(req, 'path') ?? '';
      // the driver encodes each segment and refuses what leaves its storage; this only keeps the route to the album
      if (!a.isDevicePath(p)) throw badRequest('bad path');
      let entry = thumbs.get(p);
      if (!entry) {
        const buf = await a.fetch(p, DEVICE_FILE_MAX_BYTES);
        // a browser shows no FITS (a Seestar stack): it gets the image rendered
        entry = /\.fits?$/i.test(p) ? { buf: await displayJpeg(await decode(buf, p), FITS_VIEW_SIZE), type: 'image/jpeg' } : { buf, type: contentType(p) };
        thumbs.put(p, buf, entry.type);
      }
      res.setHeader('Content-Type', entry.type);
      res.setHeader('Cache-Control', `private, max-age=${THUMB_TTL_MS / 1000}`);
      res.end(entry.buf);
    }),
  );

  // ---- free SD-card space: the device's own album delete (an astro item takes its whole session package)
  api.post(
    '/album/delete',
    route(async (req) => {
      need('album', 'The SD-card album');
      estop.assertClear();
      const b = body(req, AlbumDeleteBody);
      const outcomes = await album().delete(b.paths.map((p) => ({ filePath: p, mediaType: b.mediaType })));
      thumbs.clear(); // a deleted file must not live on in the thumbnail cache
      return { outcomes };
    }),
  );

  // ---- sessions, library, transfers
  api.get(
    '/sessions',
    route(async (req) => {
      need('sessions', 'Listing the sessions on the telescope');
      return library.listDeviceSessions(req.query.counts === '1');
    }),
  );
  api.get('/library', route(async () => ({ root: config.paths.library, targets: library.listLibrary() })));
  api.post(
    '/transfer',
    route(async (req) => {
      need('transfer', 'Transferring from the telescope');
      const b = body(req, TransferBody);
      if ('session' in b) {
        return library.transferSession(b.session, { includeSubframes: b.subframes !== false, includeCalibration: b.calibration !== false, process: b.process, origin: 'ui' });
      }
      return library.transferFiles(b.paths, 'ui');
    }),
  );
  api.post('/jobs/:id/cancel', route(async (req) => ({ cancelled: library.cancelJob(String(req.params.id)) })));

  // Delete whole sessions from the SD card (the library copies are kept): refused for a session
  // that is not complete in the library unless forced.
  api.post(
    '/sessions/delete',
    route(async (req) => {
      need('sessions', 'Deleting sessions on the telescope');
      const b = body(req, SessionDeleteBody);
      const outcomes = await library.deleteDeviceSessions(b.folders, { force: b.force });
      thumbs.clear();
      return { outcomes };
    }),
  );

  // ---- AstroPhoto Studio processing: the local outbox and the server's queue
  api.get(
    '/processing',
    route(async () => {
      const out: Record<string, unknown> = {
        server: processing.reachability(),
        profile: config.studio.profile,
        dataAccess: config.studio.dataAccess,
        autoProcess: config.studio.autoProcess,
        items: processing.listItems(50),
      };
      if (config.studio.url) out.queue = await studio.queue().catch((e) => ({ error: errMsg(e) }));
      return out;
    }),
  );
  api.get(
    '/processing/profiles',
    route(async () => {
      const i = await studio.info();
      return { profiles: i.profiles, default: i.default_profile, configured: config.studio.profile, devices: i.devices, version: i.version };
    }),
  );
  api.post(
    '/processing',
    route(async (req) => {
      const b = body(req, ProcessBody);
      const sessions = [...new Set([...(b.sessions ?? []), ...(b.session ? [b.session] : []), ...(b.target ? targetSessions(b.target, b.camera) : [])].filter(Boolean))];
      if (!sessions.length) throw badRequest('give session(s) or a target with sessions in the library');
      const target = b.target ?? library.parseSessionFolder(sessions[0])?.target ?? sessions[0];
      return processing.enqueueProcessing({ sessions, target, profile: b.profile || undefined, origin: 'ui', roiCropPercent: roiForTarget(target) });
    }),
  );
  // a finished job's output (JPEG, TIFF, JSON), shown in the browser: the library copy, or streamed from the server
  api.get(
    '/processing/:id/outputs/:name',
    route(async (req, res) => {
      const src = processing.outputSource(processing.getItem(String(req.params.id)), String(req.params.name));
      if (!src) throw notFound('no such output');
      if ('local' in src) {
        if (!fs.existsSync(src.local)) throw notFound(`${src.name} is no longer in the library`);
        await new Promise<void>((resolve, reject) => res.sendFile(src.local, (err) => (err && !res.headersSent ? reject(err) : resolve())));
        return;
      }
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const up = await studio.openOutput(src.remote, ac.signal);
      res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/octet-stream');
      const len = up.headers.get('content-length');
      if (len) res.setHeader('Content-Length', len);
      res.setHeader('Content-Disposition', `inline; filename="${src.name.replace(/["\\\r\n]/g, '_')}"`);
      await pipeline(Readable.fromWeb(up.body as never), res).catch(() => undefined);
    }),
  );
  api.post('/processing/:id/cancel', route(async (req) => processing.cancelItem(String(req.params.id))));
  api.post('/processing/:id/retry', route(async (req) => processing.retryItem(String(req.params.id))));

  // ---- what the agent captured (served under /captures)
  api.get(
    '/captures',
    route(async () => {
      const dir = path.join(config.paths.captures, 'agent');
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jpg'))
        .sort()
        .slice(-60)
        .map((f) => ({ path: `agent/${f}`, name: f }));
    }),
  );

  return api;
}

/** The MJPEG stream of one source (tele, wide, stack). */
export function streamRoute({ scope }: Pick<WebContext, 'scope'>): express.RequestHandler {
  return (req, res) => {
    try {
      scope.hub.get(String(req.params.name)).attach(res);
    } catch (err) {
      // plain text: the message carries the requested name, which must never be rendered as HTML
      res.status(404).type('text/plain').send(errMsg(err));
    }
  };
}
