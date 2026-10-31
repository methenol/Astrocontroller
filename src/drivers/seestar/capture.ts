/**
 * Photos, bursts and timelapses. The scope has no photo command (the app's shutter keeps a frame
 * on the phone), so a photo is the next exposure the camera completes: the live colour JPEG at
 * full resolution, or with raw the camera's 16-bit Bayer sub (the RAW transfer mode for that one
 * frame) saved as FITS beside a stretched JPEG. They land in the library:
 *
 *   <library>/_photos/<YYYY-MM-DD>/Seestar_<tele|wide>_<YYYYMMDD-HHMMSS>.jpg (+ .fit)
 *   <library>/_photos/<YYYY-MM-DD>/Timelapse_<tele|wide>_<YYYYMMDD-HHMMSS>.mp4
 *
 * The date is the observer's. A wide photo borrows the wide camera (withCamera) and the selection
 * comes back afterwards; the frame is shown on that camera's live view too.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import type { MediaItem } from '../../library/device-library.js';
import { autoStretch, toJpeg } from '../../media/images.js';
import { writeFileAtomic } from '../../util/fs.js';
import type { Seestar } from './device.js';
import { frameImage, framePixels, IMG_TYPE, JPEG_SOI, type Camera, type Frame } from './frames.js';

const log = logger('seestar.capture');

const FRAME_TIMEOUT_MS = 45_000;
export const BURST_MAX = 50;
const TIMELAPSE_MIN_INTERVAL_S = 1;
const TIMELAPSE_DEFAULT_INTERVAL_S = 5;
const TIMELAPSE_FPS = 24;

function localParts(at: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: config.observer.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
}

function photoPath(kind: string, camera: Camera, ext: string, at = new Date()): string {
  const p = localParts(at);
  const dir = path.join(config.paths.library, '_photos', `${p.year}-${p.month}-${p.day}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${kind}_${camera}_${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`);
  let file = `${base}${ext}`;
  for (let n = 2; fs.existsSync(file); n++) file = `${base}_${n}${ext}`;
  return file;
}

/** A 16-bit FITS of one Bayer frame (little-endian words in, FITS big-endian signed words out). */
export function bayerFits(px: Buffer, width: number, height: number, cards: Record<string, string | number | boolean>): Buffer {
  const all: Record<string, string | number | boolean> = { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height, BZERO: 32768, BSCALE: 1, ...cards };
  const lines = Object.entries(all).map(([k, v]) => {
    const val = typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : typeof v === 'number' ? String(v).padStart(20) : `'${String(v).replace(/'/g, "''").padEnd(8)}'`;
    return `${k.padEnd(8)}= ${val}`.padEnd(80).slice(0, 80);
  });
  lines.push('END'.padEnd(80));
  const header = Buffer.from(lines.join('').padEnd(Math.ceil(lines.length / 36) * 2880), 'latin1');
  const n = width * height;
  const data = Buffer.alloc(Math.ceil((n * 2) / 2880) * 2880);
  for (let i = 0; i < n; i++) data.writeInt16BE(px.readUInt16LE(i * 2) - 32768, i * 2);
  return Buffer.concat([header, data]);
}

export interface Shot {
  jpeg: Buffer;
  raw?: Frame;
}

export class SeestarCapture {
  private lapse: { camera: Camera; dir: string; frames: number; intervalS: number; endsAt: number | null; timer: NodeJS.Timeout; startedAt: number } | null = null;

  constructor(
    private readonly scope: Seestar,
    /** show a frame just taken on that camera's live view */
    private readonly show: (camera: Camera, jpeg: Buffer) => void,
  ) {}

  private assertCanShoot(): void {
    if (!this.scope.state.connected) throw new Error('the Seestar is not connected');
    if (this.scope.state.mount.parked) throw new Error('the arm is parked: open it (Home) to take a photo');
  }

  /** The next full-resolution frame of a camera (the colour JPEG, or with raw the Bayer sub). */
  async frame(camera: Camera, raw = false): Promise<Shot> {
    await this.scope.ensureLiveView();
    return this.scope.withCamera(camera, `a ${camera} photo`, () =>
      this.scope.withFullRes(camera, `a ${camera} photo`, async () => {
        const f = raw ? await this.scope.grabRaw(camera) : (await this.scope.grabImage(camera, 'preview', FRAME_TIMEOUT_MS)).frame;
        const shot: Shot = f.payload.subarray(0, 2).equals(JPEG_SOI) ? { jpeg: f.payload } : { jpeg: await toJpeg(autoStretch(await frameImage(f, camera))), raw: f };
        this.show(camera, shot.jpeg);
        return shot;
      }),
    );
  }

  /** One photo: the colour frame; with raw, the camera's Bayer sub as FITS beside it. */
  async photo(camera: Camera, o: { raw?: boolean } = {}): Promise<MediaItem & { rawPath?: string; note?: string }> {
    this.assertCanShoot();
    const at = new Date();
    const { jpeg, raw } = await this.frame(camera, !!o.raw);
    const file = photoPath('Seestar', camera, '.jpg', at);
    writeFileAtomic(file, jpeg);
    let rawPath: string | undefined;
    let note: string | undefined;
    if (raw && raw.header.imgType === IMG_TYPE.preview) {
      try {
        const { width, height } = raw.header;
        const px = framePixels(raw.payload, width * height * 2, `raw frame of ${raw.payload.length} B`);
        const st = this.scope.state;
        rawPath = file.replace(/\.jpg$/, '.fit');
        writeFileAtomic(
          rawPath,
          bayerFits(px, width, height, {
            CREATOR: `ZWO ${st.device.model ?? 'Seestar'} via Astrocontroller`,
            IMAGETYP: 'Light',
            'DATE-OBS': new Date(raw.at).toISOString().replace('Z', ''),
            BAYERPAT: 'GRBG',
            WIDECAM: camera === 'wide' ? 1 : 0,
            ...(st.focus.position !== undefined ? { FOCUSPOS: st.focus.position } : {}),
            ...(st.view.target ? { OBJECT: st.view.target } : {}),
          }),
        );
      } catch (e) {
        note = `the colour photo is saved; its raw frame could not be written (${errMsg(e)})`;
        log.info(`photo: ${note}`);
      }
    } else if (o.raw) note = 'colour photo only: no raw frame came from the picture socket';
    return { fileName: path.basename(file), filePath: file, fileSize: jpeg.length, mediaType: 1, modificationTime: Math.round(at.getTime() / 1000), rawPath, note };
  }

  async burst(camera: Camera, count: number): Promise<string> {
    this.assertCanShoot();
    const n = Math.max(1, Math.min(BURST_MAX, Math.round(count)));
    let dir = '';
    for (let i = 0; i < n; i++) {
      const { jpeg } = await this.frame(camera);
      const file = photoPath('Burst', camera, '.jpg');
      writeFileAtomic(file, jpeg);
      dir = path.dirname(file);
    }
    return `${n} photos saved in ${dir}`;
  }

  async timelapse(camera: Camera, on: boolean, intervalS?: number, totalS?: number): Promise<string> {
    if (!on) {
      if (!this.lapse) return 'no timelapse is running';
      return this.finishLapse();
    }
    if (this.lapse) throw new Error(`a timelapse is already running (${this.lapse.frames} frames so far): stop it first`);
    this.assertCanShoot();
    const every = Math.max(TIMELAPSE_MIN_INTERVAL_S, intervalS || TIMELAPSE_DEFAULT_INTERVAL_S);
    const p = localParts(new Date());
    const dir = path.join(config.paths.library, '_photos', `${p.year}-${p.month}-${p.day}`, `.timelapse_${camera}_${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`);
    fs.mkdirSync(dir, { recursive: true });
    const shoot = async () => {
      const l = this.lapse;
      if (!l) return;
      try {
        const { jpeg } = await this.frame(camera);
        fs.writeFileSync(path.join(l.dir, `${String(l.frames).padStart(5, '0')}.jpg`), jpeg);
        l.frames++;
      } catch (e) {
        log.warn(`timelapse frame skipped: ${errMsg(e)}`);
      }
      if (l.endsAt && Date.now() >= l.endsAt) await this.finishLapse().then((r) => log.info(`timelapse: ${r}`), (e) => log.warn(`timelapse: ${errMsg(e)}`));
    };
    const timer = setInterval(() => void shoot(), every * 1000);
    timer.unref();
    this.lapse = { camera, dir, frames: 0, intervalS: every, endsAt: totalS ? Date.now() + totalS * 1000 : null, timer, startedAt: Date.now() };
    void shoot();
    return `Timelapse started: a ${camera} frame every ${every} s${totalS ? ` for ${totalS < 60 ? `${Math.round(totalS)} s` : `${Math.round(totalS / 60)} min`}` : ' until stopped'}`;
  }

  timelapseStatus(): { running: boolean; frames?: number; intervalS?: number; camera?: Camera } {
    return this.lapse ? { running: true, frames: this.lapse.frames, intervalS: this.lapse.intervalS, camera: this.lapse.camera } : { running: false };
  }

  private async finishLapse(): Promise<string> {
    const l = this.lapse;
    if (!l) return 'no timelapse is running';
    this.lapse = null;
    clearInterval(l.timer);
    if (l.frames < 2) {
      fs.rmSync(l.dir, { recursive: true, force: true });
      return `Timelapse stopped with ${l.frames} frame(s): too few for a video`;
    }
    const out = photoPath('Timelapse', l.camera, '.mp4', new Date(l.startedAt));
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(TIMELAPSE_FPS), '-i', path.join(l.dir, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (c: Buffer) => (err += c.toString()));
      ff.on('error', reject);
      ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').pop() ?? ''}`))));
    });
    fs.rmSync(l.dir, { recursive: true, force: true });
    return `Timelapse saved: ${path.basename(out)} (${l.frames} frames)`;
  }

  stop(): void {
    if (this.lapse) clearInterval(this.lapse.timer);
    this.lapse = null;
  }
}
