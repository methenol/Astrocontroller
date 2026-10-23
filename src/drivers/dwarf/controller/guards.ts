/**
 * What may run on the telescope right now. Every refusal the controller makes comes from here:
 *
 * - One long operation at a time (calibration, GoTo, homing, a motor move, autofocus, polar
 *   alignment, a focus sweep). A second one is refused, not interleaved; inside an operation the
 *   nested calls it makes are let through. While one runs the controller sends nothing of its own
 *   (polls, live-view fixes), so the firmware has its command service to itself: background
 *   commands landing in the middle of a calibration were the leading suspect for the command
 *   service hanging (2026-10-10 03:04: stuck after its first plate solve, hung until a power cycle).
 * - A camera belongs to its stack while the stack runs, is starting, or is being prepared: its
 *   exposure, gain and filter must not change and no still may be taken (2026-10-12: the live-video
 *   watchdog set the wide exposure to auto 3 s after each wide stack start; the stack then shot
 *   6 frames/s and rejected every one, all night). Focus and mount motion are refused likewise.
 * - The ND lock: while the magnetic ND filter sits on the lenses for darks, any motion knocks it
 *   off and light frames are worthless. Persisted, so a restart mid-session keeps it. A running
 *   dark capture owns the tele camera like a stack does.
 */
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { errMsg, logger } from '../../../log.js';
import type { StackTracker, CameraName } from '../stacking.js';
import { CAMERAS } from '../stacking.js';
import type { StateStore } from './state.js';
import { writeFileAtomic } from '../../../util/fs.js';

const log = logger('dwarf');

export class Guards {
  private readonly opContext = new AsyncLocalStorage<string>();
  private readonly prepContext = new AsyncLocalStorage<CameraName>();
  private activeOp: { label: string; since: number } | null = null;
  private readonly preparing = new Set<CameraName>();
  /** when the last operation ended: background traffic waits a moment after one */
  lastOpEndedAt = 0;

  constructor(
    private readonly store: StateStore,
    private readonly stacks: StackTracker,
    private readonly ndLockFile: string,
  ) {
    this.loadNdLock();
  }

  // ---- long operations -----------------------------------------------------

  get operation(): string | null {
    return this.activeOp?.label ?? null;
  }

  /** Inside the running operation (its own nested calls). */
  get insideOperation(): boolean {
    return this.opContext.getStore() !== undefined;
  }

  /** Run `fn` as the one long operation; nested calls (a move that homes first) run inside it. */
  async exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.insideOperation) return fn();
    if (this.activeOp) {
      throw new Error(
        `refused: the telescope is busy ${this.activeOp.label} (started ${Math.round((Date.now() - this.activeOp.since) / 1000)} s ago); wait for it to finish or stop it first — commands interleaved with a running operation can hang the telescope's command service`,
      );
    }
    this.activeOp = { label, since: Date.now() };
    this.store.publish({ operation: label });
    try {
      return await this.opContext.run(label, fn);
    } finally {
      this.activeOp = null;
      this.lastOpEndedAt = Date.now();
      this.store.publish({ operation: undefined });
    }
  }

  /** Refuse `what` while another caller's operation runs (from inside the operation it is allowed). */
  assertNoOperation(what: string): void {
    if (this.activeOp && !this.insideOperation) {
      throw new Error(`refused: the telescope is busy ${this.activeOp.label}; ${what} now would interfere — wait for it to finish`);
    }
  }

  /** Another caller's operation is running. */
  foreignOperation(): boolean {
    return !!this.activeOp && !this.insideOperation;
  }

  // ---- camera ownership ----------------------------------------------------

  /** A stack is starting, running, or being prepared on this camera. */
  stackOwnsCamera(cam: CameraName): boolean {
    return this.stacks.owns(cam) || this.preparing.has(cam);
  }

  /**
   * Run a stack's preparation (its settings writes, then the start) as the owner of the camera.
   * A second preparation of the same camera is refused before anything is sent.
   */
  async preparingStack<T>(cam: CameraName, fn: () => Promise<T>): Promise<T> {
    if (this.stackOwnsCamera(cam)) {
      throw new Error(`the ${cam} camera is already live stacking or starting a stack (stacking_status); stop it first to restart`);
    }
    this.preparing.add(cam);
    try {
      return await this.prepContext.run(cam, fn);
    } finally {
      this.preparing.delete(cam);
    }
  }

  /** A running dark capture (tele only) owns the camera: no setting may change under it. */
  darkCaptureOwns(cam: CameraName): boolean {
    return cam === 'tele' && this.store.state.darkCapture?.state === 'running';
  }

  /** Refuse anything that changes what a camera shoots (settings, a still); the stack's own preparation passes. */
  assertCameraFree(cam: CameraName, what: string): void {
    const preparingElsewhere = this.preparing.has(cam) && this.prepContext.getStore() !== cam;
    if (this.stacks.owns(cam) || preparingElsewhere) {
      throw new Error(`refused: the ${cam} camera is live stacking (or a stack on it is starting); ${what} now would change or interrupt the stack. Stop the stack first.`);
    }
    if (this.darkCaptureOwns(cam)) {
      throw new Error(`refused: a dark capture is running on the tele camera; ${what} now would spoil the master. Wait for it (dark_frames action=status) or stop it first.`);
    }
  }

  /** Focus moves blur every following sub of a tele stack. */
  assertFocusFree(what: string): void {
    this.assertNoOperation(what);
    if (this.stackOwnsCamera('tele')) {
      throw new Error(`refused: the tele camera is live stacking (or a stack on it is starting); ${what} now would blur every following sub. Stop the stack first.`);
    }
  }

  /** Moving the mount under a stack (running or starting) smears every following sub. */
  assertNoStackForMotion(): void {
    const cam = CAMERAS.find((c) => this.stackOwnsCamera(c));
    if (cam) throw new Error(`refused: the ${cam} camera is live stacking (or a stack start was just sent); moving the mount now would ruin it. Stop it first (live_stacking action=stop).`);
  }

  // ---- ND lock -------------------------------------------------------------

  /** A lock file that exists but cannot be read keeps the lock: the filter may well be fitted. */
  private loadNdLock(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.ndLockFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`cannot read ${this.ndLockFile}: ${errMsg(e)}; keeping the ND lock on`);
      this.store.state.ndLock = (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { since: Date.now(), note: 'lock file unreadable' };
      return;
    }
    try {
      const v: unknown = JSON.parse(text);
      const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      this.store.state.ndLock = {
        since: typeof o.since === 'number' && Number.isFinite(o.since) ? o.since : Date.now(),
        note: typeof o.note === 'string' ? o.note : '',
      };
    } catch {
      log.warn(`${this.ndLockFile} is not valid JSON; keeping the ND lock on`);
      this.store.state.ndLock = { since: Date.now(), note: 'lock file unreadable' };
    }
  }

  setNdLock(on: boolean, note = ''): void {
    if (on) {
      const lock = this.store.state.ndLock ?? { since: Date.now(), note };
      writeFileAtomic(this.ndLockFile, JSON.stringify(lock));
      this.store.publish({ ndLock: lock });
      log.info(`ND filter fitted: motion and light frames locked (${note})`);
    } else {
      fs.rmSync(this.ndLockFile, { force: true });
      this.store.publish({ ndLock: null });
      log.info('ND filter removed: lock released');
    }
  }

  assertNoNdLock(what: string): void {
    if (!this.store.state.ndLock) return;
    throw new Error(
      `refused: ${what} while the ND filter is fitted for darks — any motion knocks the magnetic filter off, and light frames would be black. When the operator has removed the filter, call dark_frames action=nd_removed operator_confirmed=true, then motors_home (a hand-tilted scope has lost its motor position).`,
    );
  }
}
