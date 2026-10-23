/**
 * Where the vision tools get an image from: a live camera ("tele" | "wide"), the live stack
 * ("stack"), a file on the SD card ("device:<path>", album images and FITS), or a local file in
 * the library, captures or workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import { fetchFile } from '../../drivers/dwarf/http.js';
import type { CameraName } from '../../drivers/dwarf/device.js';
import { isFits } from '../fits.js';
import type { CameraSource, StreamHub } from '../streams.js';
import { decode, isFlatJpeg } from './decode.js';
import type { FloatImage } from './types.js';

/** Normal mode: the one shooting mode with tele video. */
const NORMAL_MODE_ID = 1;
const log = logger('images');

/** Live frames are only trusted this long after the mount last moved (motion blur). */
const MOTION_SETTLE_MS = 1500;
/** At or above this exposure there is no live stream: a real still is taken instead. */
const STILL_EXPOSURE_S = 1;
/** The live view is reconnected this long after a still (the session tends to go silent). */
const LIVE_VIEW_RESTART_MS = 1500;
/** Grey placeholder frames skipped before taking whatever arrives. */
const MAX_PLACEHOLDER_RETRIES = 4;
/** Beyond the exposure itself, how long a still keeps the live video paused. */
const STILL_PAUSE_EXTRA_MS = 20_000;
/** A cached live frame up to this old is good enough once the mount has settled. */
const LIVE_MAX_AGE_MS = 3000;
const FIRST_FRAME_TIMEOUT_MS = 30_000;
const RETRY_FRAME_TIMEOUT_MS = 10_000;
/** The live stack's preview is refreshed per sub: one up to this old is current. */
const STACK_MAX_AGE_MS = 15_000;
const STACK_FRAME_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isCamera = (s: string): s is CameraName => s === 'tele' || s === 'wide';

/** True when `p` is `root` or inside it (not merely a path that starts with the same characters). */
function inside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The real path when it exists (symlinks followed), else the path as given. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * A local file under the library, captures or workspace folders; nothing outside them is readable,
 * through a symlink either.
 */
export function resolveLocalPath(p: string): string {
  const roots = [config.paths.library, config.paths.captures, config.paths.workspace];
  const within = (full: string) => roots.some((r) => inside(r, full) && inside(real(r), real(full)));
  if (path.isAbsolute(p)) {
    const full = path.resolve(p);
    if (within(full)) return full;
    throw new Error(`path ${p} is outside the library/captures/workspace folders`);
  }
  for (const r of roots) {
    const full = path.resolve(r, p);
    if (!inside(r, full)) throw new Error(`path ${p} leaves the library/captures/workspace folders`);
    if (!fs.existsSync(full)) continue;
    if (!within(full)) throw new Error(`path ${p} links outside the library/captures/workspace folders`);
    return full;
  }
  throw new Error(`file not found: ${p} (looked in library, captures, workspace)`);
}

/** An SD-card path as the telescope's HTTP server wants it (under /DWARF3), never with "..". */
export function devicePath(p: string): string {
  const full = p.startsWith('/DWARF3') ? p : `/DWARF3${p.startsWith('/') ? '' : '/'}${p}`;
  if (full.split('/').includes('..')) throw new Error(`bad device path ${p}`);
  return full;
}

/** Take one still with whatever the camera is set to, and decode it. */
async function still(hub: StreamHub, camera: CameraName, label: string): Promise<FloatImage> {
  const item = await hub.dwarf.takePhoto(camera);
  if (!item) throw new Error(`took a ${label} ${camera} photo but could not find it in the album`);
  const img = await decode(await fetchFile(item.filePath), `${camera} still ${label} (${item.filePath})`);
  img.capturedAt = item.modificationTime * 1000;
  return img;
}

function restartLiveView(cam: CameraSource): void {
  setTimeout(() => {
    try {
      cam.retryRtsp();
    } catch (e) {
      log.warn(`the live view did not restart after a still: ${errMsg(e)}`);
    }
  }, LIVE_VIEW_RESTART_MS).unref();
}

/**
 * One still at its own exposure: set it, shoot, put the camera back. An exclusive operation, so
 * nothing else changes the camera meanwhile; the live view keeps its own setting afterwards.
 */
async function stillAtExposure(hub: StreamHub, camera: CameraName, exposureS: number): Promise<FloatImage> {
  if (!Number.isFinite(exposureS) || exposureS <= 0) throw new Error(`exposure must be a positive number of seconds (got ${exposureS})`);
  const dwarf = hub.dwarf;
  // checked before the exposure is changed: the still itself would refuse only after it
  dwarf.assertNoOperation('a still with its own exposure');
  dwarf.assertNoNdLock('a still with its own exposure');
  dwarf.assertCameraFree(camera, 'a still with its own exposure');
  return dwarf.exclusive(`taking a ${exposureS}s ${camera} still`, async () => {
    const cam = hub.camera(camera);
    // the still stops this camera's live video: tell the stream supervisor, and reconnect it after
    cam.expectPause(exposureS * 1000 + STILL_PAUSE_EXTRA_MS);
    const before = await dwarf.exposureSeconds(camera).catch(() => null);
    try {
      await dwarf.setSetting(camera, 'exposure', String(exposureS));
      return await still(hub, camera, `${exposureS}s`);
    } finally {
      // Back to the previous short exposure, or auto: never leave a long manual exposure on a live camera.
      const back = before === null || before >= STILL_EXPOSURE_S ? 'auto' : String(before);
      await dwarf.setSetting(camera, 'exposure', back).catch((e) => log.warn(`could not restore the ${camera} exposure to ${back}: ${errMsg(e)}`));
      restartLiveView(cam);
    }
  });
}

/** A live frame captured after the mount settled, never an older cached one, and never a placeholder. */
async function liveFrame(hub: StreamHub, camera: CameraName, fullRes: boolean): Promise<{ img: FloatImage; encoded: Buffer }> {
  const cam = hub.camera(camera);
  const settleUntil = hub.lastMotionAt() + MOTION_SETTLE_MS;
  if (Date.now() < settleUntil) await sleep(settleUntil - Date.now());
  const grab = async (maxAge: number, timeout: number) => (fullRes ? cam.fullResFrame() : cam.snapshot(maxAge, timeout));
  let frame = await grab(Math.max(0, Math.min(LIVE_MAX_AGE_MS, Date.now() - settleUntil)), FIRST_FRAME_TIMEOUT_MS);
  // The live stream occasionally carries flat grey placeholder frames; wait for a real one.
  for (let i = 0; i < MAX_PLACEHOLDER_RETRIES && (await isFlatJpeg(frame.jpeg)); i++) frame = await grab(0, RETRY_FRAME_TIMEOUT_MS);
  const img = await decode(frame.jpeg, camera);
  img.capturedAt = frame.at;
  return { img, encoded: frame.jpeg };
}

/**
 * Load an image. `encoded` is the original JPEG/PNG when there is one (to show it without
 * re-encoding). `exposureS` on a live camera takes one still at that exposure.
 */
export async function loadImage(source: string, hub: StreamHub, opts: { fullRes?: boolean; exposureS?: number } = {}): Promise<{ img: FloatImage; encoded?: Buffer }> {
  if (isCamera(source)) {
    if (opts.exposureS !== undefined) return { img: await stillAtExposure(hub, source, opts.exposureS) };
    // At long manual exposures there is no live stream: take a real still instead.
    const exp = await hub.dwarf.exposureSeconds(source).catch(() => null);
    if (exp !== null && exp >= STILL_EXPOSURE_S) return { img: await still(hub, source, `${exp}s`) };
    // the tele in DSO mode has no video, only the stack preview while a stack runs: a still instead
    // (also while the stream is still finding that out after a mode change or a restart)
    const st = hub.dwarf.state;
    const noTeleVideo = source === 'tele' && st.shootingMode !== undefined && st.shootingMode.id !== NORMAL_MODE_ID && hub.camera(source).status().phase !== 'live';
    if (noTeleVideo && st.stacking.tele.state !== 'running' && st.stacking.wide.state !== 'running') {
      return { img: await still(hub, source, `${st.shootingMode?.name ?? 'astro'}-mode`) };
    }
    return liveFrame(hub, source, !!opts.fullRes);
  }
  if (source === 'stack') {
    const f = await hub.stack.snapshot(STACK_MAX_AGE_MS, STACK_FRAME_TIMEOUT_MS);
    const img = await decode(f.jpeg, source);
    img.capturedAt = f.at;
    return { img, encoded: f.jpeg };
  }
  let buf: Buffer;
  let label: string;
  if (source.startsWith('device:')) {
    label = devicePath(source.slice('device:'.length));
    buf = await fetchFile(label);
  } else {
    label = resolveLocalPath(source);
    buf = await fs.promises.readFile(label);
  }
  const img = await decode(buf, label);
  return { img, encoded: isFits(buf) ? undefined : buf };
}
