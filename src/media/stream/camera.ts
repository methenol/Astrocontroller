/**
 * RTSP camera → ffmpeg → MJPEG, run by a supervisor that checks its health once a second.
 *
 * What the telescope does (verified on fw 1.5.3, 2026-10-02/03), and what the supervisor does about it:
 *  - It serves very few RTSP sessions, and an abandoned one blocks video for everyone: exactly one
 *    reader per camera, closed with SIGINT (ffmpeg sends TEARDOWN) and SIGKILL after 3 s if it hangs.
 *  - It often goes silent on an open session instead of closing it: after a long-exposure still,
 *    calibration, motion or a mode change. A session with no frame for 8 s (12 s for a new one) is
 *    closed and reopened, with backoff 1 → 15 s; one frame resets everything. Expected pauses (the
 *    mount moving, GoTo / calibration / stacking, a still being taken) are waited out first.
 *  - A long manual exposure (≥ 1 s) stops a camera's video: set back to auto once per episode.
 *  - In the astro modes the telescope serves the tele on RTSP or on its astro preview (:8092), and
 *    switches between them by itself (fw 1.5.3, 2026-10-17, DSO mode: RTSP at 28 fps, then minutes
 *    later RTSP 454 and the live view on :8092 at ~1 fps). So there the tele tries RTSP, and keeps
 *    :8092 open as a standby whenever RTSP is not delivering: its frames are shown as soon as RTSP
 *    has been quiet for 2 s, so neither a dropped session nor a probe ever freezes the view. Two
 *    refused sessions mark the mode as serving no RTSP; it is probed again after 1 min, backing off
 *    to 5 min, and a single refusal ends a probe. While a tele stack runs the tele view is the stack
 *    preview and no RTSP is opened. Nothing is persisted, and Normal mode always has RTSP video.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../../config.js';
import { logger, errMsg } from '../../log.js';
import type { CameraName, Dwarf } from '../../dwarf/device.js';
import { JpegSplitter } from './jpeg.js';
import { Source, type Frame } from './source.js';

const log = logger('stream');

/** The shooting mode with RTSP video on both cameras. */
const NORMAL_MODE = 1;
const TICK_MS = 1000;
/** A live session with no frame for this long is reopened. */
const STALL_MS = 8000;
/** A new session gets this long to deliver its first frame. */
const FIRST_FRAME_MS = 12000;
const MAX_BACKOFF_MS = 15000;
/** A reader told to stop is killed after this long. */
const KILL_AFTER_MS = 3000;
/** A reader that has not confirmed its exit after this long is given up on. */
const CLOSING_GIVE_UP_MS = 6000;
/** No stall is declared this soon after the mount moved. */
const MOTION_GRACE_MS = 4000;
/** A recovery attempt in progress blocks another for at most this long. */
const RECOVERY_GUARD_MS = 20000;
/** Telescope calls made during recovery are abandoned after this long. */
const RECOVERY_CALL_MS = 6000;
/** A reconnect request leaves a session alone that delivered a frame this recently. */
const RECONNECT_IF_QUIET_MS = 3000;
/** fullResFrame takes a frame up to this old. */
const FULL_RES_MAX_AGE_MS = 1500;
const FULL_RES_TIMEOUT_MS = 20000;
/** Tele RTSP probes that never deliver a frame before a mode is taken as having none. */
const SILENT_PROBES_NO_RTSP = 2;
/** A mode taken as having no tele RTSP is probed again after this long, doubling up to the max. */
const RTSP_REPROBE_MS = 60000;
const RTSP_REPROBE_MAX_MS = 300000;
/** In astro modes the :8092 standby's frames are shown once RTSP has been quiet this long. */
const PREVIEW_TAKEOVER_MS = 2000;
/** While reconnecting, a warning every this many attempts (the first is logged at info). */
const WARN_EVERY_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;
/** ffmpeg stderr kept for the error report. */
const ERR_TAIL_CHARS = 400;
/** ffmpeg noise about the H.265 feed's missing references, not an error worth reporting. */
const DECODER_NOISE = /POC|RPS|Could not find ref|NALU/;

type Phase = 'off' | 'connecting' | 'live' | 'backoff' | 'preview' | 'disconnected';

export class CameraSource extends Source {
  /** Where frames come from while a stack runs or the telescope won't serve RTSP (tele → :8092). */
  fallback: Source | null = null;

  private phase: Phase = 'off';
  private proc: ChildProcess | null = null;
  /** the address the running reader was opened with */
  private procUrl = '';
  /** readers this source stopped on purpose (their exit is not a failure) */
  private readonly stopping = new WeakSet<ChildProcess>();
  /** a reader told to stop that has not exited yet: no new one until it has (one session per camera) */
  private closing: ChildProcess | null = null;
  private closingSince = 0;
  private connectedAt = 0;
  private lastFrameAt = 0;
  private attempts = 0;
  private nextAttemptAt = 0;
  private pauseUntil = 0;
  private lastError = '';
  private previewActive = false;
  /** :8092 frames, shown unless RTSP is delivering (then the standby only stays connected). */
  private readonly onPreviewFrame = (f: Frame) => {
    if (this.phase === 'preview' || Date.now() - this.lastFrameAt > PREVIEW_TAKEOVER_MS) this.frame(f.jpeg);
  };
  private tickTimer: NodeJS.Timeout | null = null;
  private healedThisEpisode = false;
  /** this mode's tele RTSP probes that never delivered a frame (reset on a mode change) */
  private silentProbes = 0;
  private probedMode: number | null = null;
  private learnedNoRtsp: number | null = null;
  private learnedNoRtspAt = 0;
  /** refusals in a row in this mode: each doubles the wait before the next probe */
  private refusals = 0;
  private recovering = false;
  private recoveringSince = 0;

  constructor(
    readonly camera: CameraName,
    private readonly channel: number,
    readonly dwarf: Dwarf,
  ) {
    super(camera);
  }

  get url(): string {
    return `rtsp://${config.dwarf.host}:${config.dwarf.rtspPort}/ch${this.channel}/stream0`;
  }

  // ---------------------------------------------------------------- lifecycle
  protected startSource(): void {
    this.phase = 'connecting';
    this.nextAttemptAt = 0;
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
      this.tickTimer.unref();
    }
    this.tick();
  }

  protected stopSource(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.setPreview(false);
    this.stopReader('no viewers');
    this.phase = 'off';
  }

  /** A pause the controller causes on purpose (a long-exposure still): don't count it as a stall. */
  expectPause(ms: number): void {
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms);
  }

  /** Reconnect now (a mode change, the link coming back, or a caller that knows video should resume). */
  retryRtsp(): void {
    this.attempts = 0;
    this.nextAttemptAt = 0;
    this.pauseUntil = 0;
    if (this.proc && Date.now() - this.lastFrameAt > RECONNECT_IF_QUIET_MS) this.stopReader('reconnect requested');
    if (this.running) this.tick();
  }

  /**
   * A full-resolution (1920×1080) frame from the single live connection. Never opens a second
   * RTSP session (that would block the stream on the telescope).
   */
  fullResFrame(timeoutMs = FULL_RES_TIMEOUT_MS): Promise<Frame> {
    return this.snapshot(FULL_RES_MAX_AGE_MS, timeoutMs);
  }

  // ---------------------------------------------------------------- supervisor
  private tick(): void {
    if (!this.running) return;
    const now = Date.now();
    const st = this.dwarf.state;
    if (!st.connected) {
      if (this.proc) this.stopReader('telescope disconnected');
      this.setPreview(false);
      this.phase = 'disconnected';
      this.note = 'telescope disconnected; live video resumes when it reconnects';
      this.nextAttemptAt = 0;
      return;
    }
    const mode = st.shootingMode?.id ?? null;
    if (mode !== this.probedMode) {
      this.probedMode = mode;
      this.silentProbes = 0;
      this.learnedNoRtsp = null;
      this.refusals = 0;
    }
    const astroMode = !!this.fallback && mode !== null && mode !== NORMAL_MODE;
    // Mode not known yet (just connected): wait for it, the tele's source depends on it.
    if (this.fallback && mode === null) {
      if (this.proc) this.stopReader('shooting mode unknown');
      this.setPreview(false);
      this.phase = 'backoff';
      this.note = 'waiting for the telescope to report its shooting mode';
      return;
    }
    // a mode refused the tele RTSP a while ago: try it again (a refusal must never strand the view);
    // the standby stays on meanwhile, and one more refusal ends the probe
    if (this.learnedNoRtsp !== null && now - this.learnedNoRtspAt >= this.reprobeMs() && !this.dwarf.quietPeriod()) {
      log.debug(`${this.name}: trying RTSP again in ${st.shootingMode?.name ?? 'this'} mode`);
      this.learnedNoRtsp = null;
      this.silentProbes = SILENT_PROBES_NO_RTSP - 1;
      this.attempts = 0;
      this.nextAttemptAt = 0;
    }
    // tele under a running stack, or in a mode that refused RTSP: the astro preview instead
    const teleStack = !!this.fallback && this.dwarf.stackOwnsCamera(this.camera);
    if (this.fallback && (teleStack || (mode !== null && mode !== NORMAL_MODE && this.learnedNoRtsp === mode))) {
      if (this.proc) this.stopReader(teleStack ? 'a stack owns the tele camera' : `${st.shootingMode?.name} mode has no tele RTSP`);
      this.setPreview(true);
      this.phase = 'preview';
      const name = st.shootingMode?.name ?? 'astro';
      this.note = teleStack
        ? `${name} mode: showing the live stack preview`
        : `${name} mode: the telescope serves the tele view on its astro preview right now (about 1 frame/s)`;
      return;
    }
    // astro modes: the :8092 standby stays connected while RTSP is not delivering, and takes over the view
    this.setPreview(astroMode && now - this.lastFrameAt > PREVIEW_TAKEOVER_MS);
    // the telescope's address changed: a reader still on the old one is replaced at once
    if (this.proc && this.procUrl !== this.url) {
      this.stopReader('telescope address changed');
      this.attempts = 0;
      this.nextAttemptAt = 0;
    }
    if (!this.proc) {
      if (this.closing) {
        // the previous session is still being torn down; never wait on it for ever
        if (now - this.closingSince < CLOSING_GIVE_UP_MS) return;
        log.warn(`${this.name}: previous reader not confirmed gone after ${Math.round((now - this.closingSince) / 1000)} s; continuing`);
        kill(this.closing, 'SIGKILL');
        this.closing = null;
      }
      // No new session while the telescope runs an operation: it stops the video anyway, and the
      // firmware is better left alone until it is done.
      if (this.dwarf.quietPeriod()) {
        this.phase = 'backoff';
        this.note = 'live video paused while the telescope works; it resumes afterwards';
        return;
      }
      if (now >= this.nextAttemptAt) this.connect();
      else this.phase = 'backoff';
      return;
    }
    // a reader is running: is it delivering?
    const fresh = this.lastFrameAt > this.connectedAt;
    const quiet = now - (fresh ? this.lastFrameAt : this.connectedAt);
    if (quiet < (fresh ? STALL_MS : FIRST_FRAME_MS)) return;
    // GoTo / calibration / polar alignment take over the cameras for a while (not stacking: that runs
    // for hours); a wide stack takes the wide camera at long exposures: no video until it ends.
    const wideStack = this.camera === 'wide' && this.dwarf.stackOwnsCamera('wide');
    if (wideStack || now < this.pauseUntil || this.dwarf.quietPeriod() || now - this.dwarf.lastMotionAt < MOTION_GRACE_MS) {
      this.note = 'live video paused while the telescope works; it resumes afterwards';
      return;
    }
    void this.onSilent(fresh, mode);
  }

  /** A telescope call during recovery, never allowed to hang the supervisor. */
  private bounded<T>(p: Promise<T>): Promise<T | null> {
    let t: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => {
      t = setTimeout(() => r(null), RECOVERY_CALL_MS);
      t.unref();
    });
    return Promise.race([p.catch(() => null), timeout]).finally(() => clearTimeout(t));
  }

  private async onSilent(hadFrames: boolean, mode: number | null): Promise<void> {
    if (this.recovering && Date.now() - this.recoveringSince < RECOVERY_GUARD_MS) return;
    this.recovering = true;
    const since = Date.now();
    this.recoveringSince = since;
    const proc = this.proc;
    try {
      // a long manual exposure stops the video in any mode; a stack's exposure is the stack's
      // (the device re-checks the stack ownership right before it sends anything)
      if (!this.healedThisEpisode && !this.dwarf.stackOwnsCamera(this.camera)) {
        const exp = await this.bounded(this.dwarf.autoExposureForLiveView(this.camera));
        if (exp !== null) {
          this.healedThisEpisode = true;
          log.warn(`${this.name}: no video with a ${exp} s manual exposure set: exposure set to auto (long exposures stop the telescope's live video)`);
          this.note = `${this.name} exposure was set to auto to restore live video`;
        }
      }
      // the telescope call took a while: the viewers may have left, the reader been replaced, or video come back
      if (!this.running || this.proc !== proc || this.lastFrameAt >= since) return;
      if (!hadFrames) this.noteSilentProbe(mode);
      this.restart(hadFrames ? 'live video stalled' : 'no video from the new connection');
    } finally {
      this.recovering = false;
    }
  }

  /** The tele in an astro mode: two probes without a frame and this mode has no tele RTSP (until it changes). */
  private noteSilentProbe(mode: number | null): void {
    if (!this.fallback || mode === null || mode === NORMAL_MODE) return;
    if (++this.silentProbes >= SILENT_PROBES_NO_RTSP && this.learnedNoRtsp !== mode) {
      this.learnedNoRtsp = mode;
      this.learnedNoRtspAt = Date.now();
      // the first refusal in this mode is news; the periodic probes that fail again are not
      if (this.refusals++ === 0) log.info(`${this.name}: no RTSP video in ${this.dwarf.state.shootingMode?.name ?? 'this'} mode; using the astro preview and trying RTSP again from time to time`);
    }
  }

  private reprobeMs(): number {
    return Math.min(RTSP_REPROBE_MS * 2 ** Math.max(0, this.refusals - 1), RTSP_REPROBE_MAX_MS);
  }

  private backoffMs(): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempts - 1), MAX_BACKOFF_MS);
  }

  private restart(reason: string): void {
    this.attempts++;
    this.nextAttemptAt = Date.now() + this.backoffMs();
    if (this.attempts === 1) (this.refusals > 0 ? log.debug : log.info)(`${this.name}: ${reason}; reconnecting`);
    else if (this.attempts % WARN_EVERY_ATTEMPTS === 0) {
      log.warn(`${this.name}: ${reason}; still reconnecting (attempt ${this.attempts}, next in ${Math.round(this.backoffMs() / 1000)} s)${this.lastError ? ` — ${this.lastError}` : ''}`);
    }
    this.note = `${reason}; reconnecting${this.attempts > 1 ? ` (attempt ${this.attempts})` : ''}`;
    this.stopReader(reason);
    // re-arm the camera previews on the telescope before the next attempt
    this.dwarf.ensureLiveView(true).catch((e) => log.debug(`${this.name}: live view re-arm: ${errMsg(e)}`));
  }

  private setPreview(on: boolean): void {
    if (!this.fallback || on === this.previewActive) return;
    this.previewActive = on;
    if (on) {
      this.fallback.on('frame', this.onPreviewFrame);
      this.fallback.hold(true);
      log.info(`${this.name}: showing the telescope's astro preview (:8092)`);
    } else {
      this.fallback.off('frame', this.onPreviewFrame);
      this.fallback.hold(false);
    }
  }

  // ---------------------------------------------------------------- the reader
  private connect(): void {
    this.phase = 'connecting';
    this.connectedAt = Date.now();
    const url = this.url;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // Socket timeout 20 s: only a backstop, the supervisor closes a silent session sooner.
      '-rtsp_transport', 'tcp', '-timeout', '20000000',
      // Keep frames decoded with missing references: this feed references missing frames so often
      // that dropping them (-output_corrupt) discarded ~90 % of the video (11.2 MB vs 1.2 MB per 8 s).
      // Grey decoder frames are filtered from agent snapshots instead.
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-i', url,
      // No fps filter (it duplicates the last frame with a fresh timestamp whenever the camera
      // pauses, which made old images look current): every real frame passes, rate-limited below.
      // Native 1920×1080 for the agent; browsers get a downscaled copy (video WebSocket).
      '-an', '-fps_mode', 'passthrough',
      '-q:v', '4', '-f', 'mjpeg', 'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.procUrl = url;
    let frames = 0;
    let lastEmit = 0;
    let ended = false;
    const minGap = 1000 / Math.max(1, config.web.liveFps);
    const splitter = new JpegSplitter((jpeg) => {
      if (this.proc !== proc) return;
      frames++;
      const now = Date.now();
      if (this.phase !== 'live') {
        if (this.attempts > 0 || this.refusals > 0) log.info(`${this.name}: live video is back`);
        this.phase = 'live';
        this.refusals = 0;
      }
      this.lastFrameAt = now;
      this.attempts = 0;
      this.healedThisEpisode = false;
      this.silentProbes = 0;
      this.lastError = '';
      this.note = null;
      if (now - lastEmit < minGap) return; // rate-limit by dropping, never duplicating
      lastEmit = now;
      this.frame(jpeg);
    });
    proc.stdout!.on('data', (c: Buffer) => splitter.push(c));
    let errTail = '';
    proc.stderr!.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-ERR_TAIL_CHARS);
    });
    // 'exit' is not guaranteed after 'error' (ffmpeg missing): both end the reader, once.
    const onEnd = (why: string) => {
      if (ended) return;
      ended = true;
      if (this.proc === proc) this.proc = null;
      if (this.closing === proc) this.closing = null;
      if (this.stopping.has(proc) || !this.running) return;
      // the reader ended by itself (connection refused, RTSP 454, socket timeout, no ffmpeg)
      const msg = errTail.split('\n').filter((l) => l && !DECODER_NOISE.test(l)).pop();
      this.lastError = msg && /454|4XX/.test(msg) ? 'the telescope is not serving this stream right now (RTSP 454)' : (msg ?? why);
      log.debug(`${this.name} ffmpeg ended (${why})${msg ? `: ${msg}` : ''} after ${frames} frames`);
      if (frames === 0) this.noteSilentProbe(this.dwarf.state.shootingMode?.id ?? null);
      this.restart(frames ? 'live video ended' : `could not start live video (${this.lastError})`);
    };
    proc.on('error', (err) => {
      log.error(`${this.name}: ffmpeg not available: ${errMsg(err)}`);
      onEnd(`ffmpeg error: ${errMsg(err)}`);
    });
    proc.on('exit', (code, signal) => onEnd(`ffmpeg exited (${code ?? signal})`));
  }

  /** Close the reader cleanly (SIGINT → TEARDOWN), and for good (SIGKILL after 3 s) if it hangs. */
  private stopReader(reason: string): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.stopping.add(proc);
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    this.closing = proc;
    this.closingSince = Date.now();
    log.debug(`${this.name}: closing reader (${reason})`);
    kill(proc, 'SIGINT');
    const t = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        log.warn(`${this.name}: reader did not stop; killing it`);
        kill(proc, 'SIGKILL');
      }
    }, KILL_AFTER_MS);
    t.unref();
    proc.once('exit', () => {
      clearTimeout(t);
      if (this.closing === proc) this.closing = null;
    });
  }

  override stallHint(): string {
    const parts: string[] = [];
    if (this.note) parts.push(this.note);
    if (this.lastError) parts.push(`RTSP: ${this.lastError}`);
    parts.push("Long manual exposures stop this camera's live view; the mount moving also pauses frames briefly.");
    return parts.join(' ');
  }

  override status() {
    const now = Date.now();
    return {
      ...super.status(),
      phase: this.phase,
      attempts: this.attempts,
      reader: this.proc?.pid ?? null,
      closing: this.closing ? Math.round((now - this.closingSince) / 1000) : null,
      nextAttemptIn: !this.proc && this.nextAttemptAt > now ? Math.round((this.nextAttemptAt - now) / 1000) : 0,
      recovering: this.recovering,
    };
  }
}

function kill(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    proc.kill(signal);
  } catch {
    /* already gone */
  }
}
