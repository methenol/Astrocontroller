/**
 * The ZWO Telescope Network transport. seestar-portfwd (github.com/Phaeilo/seestar-portfwd) logs in
 * to the ZWO account, opens the ThroughTek Kalay P2P tunnel to the telescope and forwards its native
 * services to 127.0.0.1 (4700 control, 4800/4804 images, 4554/4555 RTSP, 8080 ← 80 files, …), so the
 * control code above it is the same one that talks to a scope on the LAN.
 *
 * With SEESTAR_TUNNEL_COMMAND set, this supervisor runs it (the ZWO account variables are passed on
 * in its environment), restarts it when it exits, and reports it up once it has printed its
 * "tunnel ready" banner and the forwarded control port accepts connections (Docker's port proxy
 * accepts them as soon as the container runs, before the P2P session exists). Without a command
 * the tunnel is yours to run and only the port is watched.
 *
 * Only one remote session per telescope is active: opening this tunnel takes over the session of
 * the official app (and the other way round).
 *
 * Events: 'status' (TunnelStatus).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { errMsg, logger } from '../../log.js';
import { SafeEmitter } from '../../util/events.js';

const log = logger('seestar-tunnel');

const PROBE_MS = 3000;
const RESTART_MIN_MS = 5000;
const RESTART_MAX_MS = 120_000;
/** a tunnel that stayed up this long resets the restart backoff */
const STABLE_MS = 5 * 60_000;
const STOP_GRACE_MS = 5000;
const LOG_LINES = 40;
/** the tunnel binary prints "[*] tunnel ready"; its README calls the banner TUNNEL UP */
const UP_BANNER = /tunnel ready|TUNNEL UP/i;

export type TunnelPhase = 'unmanaged' | 'starting' | 'up' | 'down' | 'stopped' | 'failed';

export interface TunnelStatus {
  phase: TunnelPhase;
  managed: boolean;
  command: string | null;
  /** the forwarded control port answers */
  portOpen: boolean;
  since: number;
  restarts: number;
  lastExit: string | null;
  /** the last lines the tunnel printed (its "tunnel ready" line, login errors…) */
  output: string[];
}

export interface TunnelOptions {
  host: string;
  port: number;
  command: string;
  cwd?: string;
  readyTimeoutS: number;
  /** the variables seestar-portfwd reads */
  env: Record<string, string>;
  /** tests */
  spawnFn?: typeof spawn;
  probeFn?: (host: string, port: number) => Promise<boolean>;
}

export function portOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export class ZwoTunnel extends SafeEmitter {
  private child: ChildProcess | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private restartWait = RESTART_MIN_MS;
  private upAt = 0;
  private running = false;
  /** the managed tunnel printed its banner since it was launched */
  private bannerSeen = false;
  private readonly st: TunnelStatus;

  constructor(private readonly o: TunnelOptions) {
    super();
    this.st = { phase: o.command ? 'stopped' : 'unmanaged', managed: !!o.command, command: o.command || null, portOpen: false, since: Date.now(), restarts: 0, lastExit: null, output: [] };
  }

  status(): TunnelStatus {
    return { ...this.st, output: [...this.st.output] };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.o.command) this.launch();
    this.probeTimer = setInterval(() => void this.probe(), PROBE_MS);
    this.probeTimer.unref?.();
    void this.probe();
  }

  stop(): void {
    this.running = false;
    for (const t of [this.probeTimer, this.restartTimer, this.readyTimer]) if (t) clearTimeout(t);
    this.probeTimer = this.restartTimer = this.readyTimer = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      // Ctrl-C equivalent: seestar-portfwd releases the remote session on SIGINT
      child.kill('SIGINT');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), STOP_GRACE_MS).unref();
    }
    if (this.o.command) this.set('stopped');
  }

  /** Start the tunnel over (the Connect button after a failure, or the agent). */
  restart(): void {
    this.stop();
    this.st.restarts++;
    this.start();
  }

  private set(phase: TunnelPhase): void {
    if (this.st.phase === phase) return;
    this.st.phase = phase;
    this.st.since = Date.now();
    log.info(`ZWO tunnel ${phase}`);
    this.emit('status', this.status());
  }

  private remember(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trimEnd();
      if (!l) continue;
      if (UP_BANNER.test(l)) this.bannerSeen = true;
      this.st.output.push(l);
      log.debug(`tunnel: ${l}`);
    }
    if (this.st.output.length > LOG_LINES) this.st.output.splice(0, this.st.output.length - LOG_LINES);
  }

  private launch(): void {
    this.bannerSeen = false;
    this.set('starting');
    const spawnFn = this.o.spawnFn ?? spawn;
    log.info(`starting the ZWO tunnel: ${this.o.command}`);
    const child = spawnFn(this.o.command, { shell: true, cwd: this.o.cwd || undefined, env: { ...process.env, ...this.o.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (b: Buffer) => this.remember(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => this.remember(b.toString('utf8')));
    child.on('error', (e) => {
      this.st.lastExit = errMsg(e);
      log.error(`the ZWO tunnel could not start: ${errMsg(e)}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.bannerSeen = false;
      this.st.lastExit = signal ? `signal ${signal}` : `exit code ${code}`;
      if (!this.running) return;
      log.warn(`the ZWO tunnel exited (${this.st.lastExit})`);
      if (this.upAt && Date.now() - this.upAt > STABLE_MS) this.restartWait = RESTART_MIN_MS;
      this.upAt = 0;
      this.set('down');
      const wait = this.restartWait;
      this.restartWait = Math.min(this.restartWait * 2, RESTART_MAX_MS);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.st.restarts++;
        if (this.running) this.launch();
      }, wait);
      this.restartTimer.unref?.();
    });
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.st.phase === 'starting') {
        log.error(`the ZWO tunnel did not come up within ${this.o.readyTimeoutS} s; its last output:\n${this.st.output.slice(-10).join('\n')}`);
        this.set('failed');
      }
    }, this.o.readyTimeoutS * 1000);
    this.readyTimer.unref?.();
  }

  private async probe(): Promise<void> {
    const open = await (this.o.probeFn ?? portOpen)(this.o.host, this.o.port).catch(() => false);
    if (!this.running) return;
    const changed = open !== this.st.portOpen;
    this.st.portOpen = open;
    if (open && (!this.o.command || this.bannerSeen)) {
      if (!this.upAt) this.upAt = Date.now();
      this.set('up');
    } else if (this.st.phase === 'up') {
      this.set(this.o.command ? 'down' : 'unmanaged');
    }
    if (changed) this.emit('status', this.status());
  }
}
