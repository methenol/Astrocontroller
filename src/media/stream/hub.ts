/** The three live sources (tele, wide, stack), kept in step with the telescope's state. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import type { CameraName, Dwarf } from '../../drivers/dwarf/device.js';
import { isBlackJpeg } from '../image/decode.js';
import { BlankWatch } from './blank-watch.js';
import { CameraSource } from './camera.js';
import { StackSource } from './stack.js';

/** Frames this soon after the mount moved are not judged. */
const BLANK_MOTION_GRACE_MS = 4000;
const BLANK_EVIDENCE_KEPT = 20;
/** After the link comes back, reconnect once the telescope has settled. */
const RECONNECT_DELAY_MS = 1500;
/** After a mode change, re-check RTSP once the telescope has switched. */
const MODE_CHANGE_DELAY_MS = 2000;

export class StreamHub {
  readonly tele: CameraSource;
  readonly wide: CameraSource;
  readonly stack = new StackSource();
  readonly blank: BlankWatch;
  private stackHeld = false;
  private wasConnected: boolean;
  private lastModeId: number | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly onState = () => this.follow();

  constructor(readonly dwarf: Dwarf) {
    this.tele = new CameraSource('tele', 0, dwarf);
    this.wide = new CameraSource('wide', 1, dwarf);
    // While a tele stack runs, or a mode refuses the tele RTSP, the tele view is the telescope's :8092 preview.
    this.tele.fallback = this.stack;
    this.stack.allowed = () => dwarf.state.connected && !dwarf.state.released;
    this.blank = new BlankWatch({
      frame: () => this.tele.latest,
      isBlack: isBlackJpeg,
      canWatch: () => {
        const st = dwarf.state;
        return st.connected && !st.released && st.darkCapture?.state !== 'running' && !dwarf.stackOwnsCamera('tele') && !dwarf.quietPeriod() && Date.now() - dwarf.lastMotionAt >= BLANK_MOTION_GRACE_MS;
      },
      raiseGain: async () => {
        const r = await dwarf.raiseLiveViewGain('tele');
        return r && `raised the live-view gain from ${r.from} to ${r.to}`;
      },
      reenterCamera: async () => {
        await dwarf.ensureLiveView(true);
        this.tele.retryRtsp();
      },
      rearmCamera: async () => {
        await dwarf.rearmLiveView('tele');
        this.tele.retryRtsp();
      },
      saveEvidence: () => this.saveBlankEvidence(),
    });
    this.wasConnected = dwarf.state.connected;
    dwarf.on('state', this.onState);
  }

  private follow(): void {
    const st = this.dwarf.state;
    // the link coming back: reconnect right away
    if (st.connected && !this.wasConnected) this.later(RECONNECT_DELAY_MS, () => this.retryCameras());
    this.wasConnected = st.connected;
    // after a mode change, re-check RTSP right away instead of waiting for the next retry
    const id = st.shootingMode?.id;
    if (id !== undefined && id !== this.lastModeId) {
      const changed = this.lastModeId !== undefined;
      this.lastModeId = id;
      if (changed) this.later(MODE_CHANGE_DELAY_MS, () => this.retryCameras());
    }
    // keep the stack preview flowing whenever the telescope is stacking
    const stacking = st.stacking.tele.state === 'running' || st.stacking.wide.state === 'running';
    if (stacking !== this.stackHeld) {
      this.stackHeld = stacking;
      this.stack.hold(stacking);
    }
  }

  /** What each feed showed and how the camera was set when the tele went black. */
  private async saveBlankEvidence(): Promise<string> {
    const root = path.join(config.paths.captures, 'blank');
    const name = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(root, name);
    await fs.promises.mkdir(dir, { recursive: true });
    const feeds = { tele: this.tele, preview: this.stack, wide: this.wide };
    for (const [label, src] of Object.entries(feeds)) if (src.latest) await fs.promises.writeFile(path.join(dir, `${label}.jpg`), src.latest.jpeg);
    const st = this.dwarf.state;
    const camera = await this.dwarf.cameraSettings('tele').catch(() => null);
    const report = { at: new Date().toISOString(), mode: st.shootingMode, focus: st.focusPosition, teleStreamType: st.teleStreamType, camera: camera?.settings, streams: this.status() };
    await fs.promises.writeFile(path.join(dir, 'state.json'), JSON.stringify(report, null, 1));
    const old = (await fs.promises.readdir(root)).sort().slice(0, -BLANK_EVIDENCE_KEPT);
    for (const d of old) await fs.promises.rm(path.join(root, d), { recursive: true, force: true });
    return `captures/blank/${name}`;
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  private retryCameras(): void {
    this.tele.retryRtsp();
    this.wide.retryRtsp();
  }

  status() {
    return { tele: this.tele.status(), wide: this.wide.status(), stack: this.stack.status() };
  }

  /**
   * The user released the telescope (Disconnect): drop the stack preview now. The camera readers
   * close themselves within a second (their supervisor sees the link down) and stay closed.
   */
  release(): void {
    this.stack.interrupt();
  }

  /**
   * The telescope's address changed: the stack preview's connection still goes to the old one, so
   * drop it and let it reconnect to the new one. The camera readers follow the control link (they
   * close while it is down and reopen when it comes back at the new address).
   */
  retarget(): void {
    this.stack.interrupt();
  }

  /** Close all readers cleanly (ffmpeg sends RTSP TEARDOWN) before the process exits. */
  shutdown(): void {
    this.dwarf.off('state', this.onState);
    this.blank.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const src of [this.tele, this.wide, this.stack]) src.forceStop();
  }

  lastMotionAt(): number {
    return this.dwarf.lastMotionAt;
  }

  /** A camera's source. */
  camera(name: CameraName): CameraSource {
    return name === 'wide' ? this.wide : this.tele;
  }

  get(name: string): CameraSource | StackSource {
    if (name === 'tele') return this.tele;
    if (name === 'wide') return this.wide;
    if (name === 'stack') return this.stack;
    throw new Error(`unknown stream ${name}`);
  }
}
