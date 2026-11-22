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
 * - A running dark capture owns the tele camera like a stack does.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { StackTracker, CameraName } from '../stacking.js';
import { CAMERAS } from '../stacking.js';
import type { StateStore } from './state.js';

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
  ) {}

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
  /** Light captures on either camera wait for a running dark capture: it holds the firmware's DSO mode. */
  assertNoDarkCapture(what: string): void {
    if (this.store.state.darkCapture?.state !== 'running') return;
    throw new Error(`refused: ${what} while a dark capture is running; wait for its master (dark_frames action=status) or stop it (dark_frames action=stop)`);
  }

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
}
