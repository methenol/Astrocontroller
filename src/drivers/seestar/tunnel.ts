/**
 * The ZWO Telescope Network transport. seestar-portfwd logs in to the ZWO account, opens the
 * ThroughTek P2P tunnel to the telescope and forwards its native services (4700 control, 4800/4804
 * pictures, 4554/4555 RTSP, 80 files) to this host, so the driver speaks to a remote scope exactly
 * as to one on the LAN.
 *
 * The scope serves one remote session, so the tunnel is driven in one of three ways:
 *
 *   supervisor  the tunnel container's HTTP supervisor owns the session: Connect = POST /connect
 *               (with a lease we keep refreshing), Disconnect = POST /disconnect, GET /status polls.
 *   command     SEESTAR_TUNNEL_COMMAND runs as our child; SIGINT makes it release the session.
 *   unmanaged   someone else runs the tunnel; only the forwarded control port is watched.
 *
 * A supervisor that does not answer degrades to the unmanaged rule, with the reason in `detail`.
 * Events: 'status' (TunnelStatus).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { errMsg, logger } from '../../log.js';
import { SafeEmitter } from '../../util/events.js';

const log = logger('seestar.tunnel');

const PROBE_MS = 3000;
const RESTART_MIN_MS = 5000;
const RESTART_MAX_MS = 120_000;
const STABLE_MS = 5 * 60_000;
const STOP_GRACE_MS = 5000;
const LOG_LINES = 40;
const UP_BANNER = /tunnel ready|TUNNEL UP/i;
const CONTROL_TIMEOUT_MS = 2500;
const DISCONNECT_WAIT_S = 6;
const LEASE_REFRESH_MS = 30_000;

export type TunnelPhase = 'unmanaged' | 'starting' | 'up' | 'down' | 'releasing' | 'stopped' | 'failed';

export interface SupervisorState {
  url: string;
  reachable: boolean;
  phase: string | null;
  desired: string | null;
  attempts: number;
  reconnects: number;
  lastError: string | null;
  lastExit: string | null;
  device: { sn?: string; model?: string; status?: string } | null;
  session: { sn?: string; conId?: string | null } | null;
  mode: string | null;
  leaseSeconds: number | null;
  leaseExpiresAt: number | null;
}

export interface TunnelStatus {
  phase: TunnelPhase;
  managed: boolean;
  command: string | null;
  portOpen: boolean;
  since: number;
  restarts: number;
  lastExit: string | null;
  output: string[];
  detail: string | null;
  supervisor: SupervisorState | null;
}

export interface TunnelSupervisorOptions {
  host: string;
  port: number;
  token?: string;
  leaseS: number;
}

export interface TunnelOptions {
  host: string;
  port: number;
  command: string;
  cwd?: string;
  readyTimeoutS: number;
  env: Record<string, string>;
  supervisor?: TunnelSupervisorOptions | null;
  spawnFn?: typeof spawn;
  probeFn?: (host: string, port: number) => Promise<boolean>;
  fetchFn?: typeof fetch;
  probeMs?: number;
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

export class ZwoTunnel extends SafeEmitter {
  private child: ChildProcess | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private restartWait = RESTART_MIN_MS;
  private upAt = 0;
  private running = false;
  private bannerSeen = false;
  private leaseAt = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private controlLost = false;
  private sup: SupervisorState | null = null;
  private readonly supOpts: TunnelSupervisorOptions | null;
  private readonly supUrl: string | null;
  private readonly st: TunnelStatus;

  constructor(private readonly o: TunnelOptions) {
    super();
    this.supOpts = o.command ? null : (o.supervisor ?? null);
    this.supUrl = this.supOpts ? `http://${this.supOpts.host}:${this.supOpts.port}` : null;
    this.st = {
      phase: o.command || this.supOpts ? 'stopped' : 'unmanaged',
      managed: !!o.command || !!this.supOpts,
      command: o.command || null,
      portOpen: false,
      since: Date.now(),
      restarts: 0,
      lastExit: null,
      output: [],
      detail: null,
      supervisor: null,
    };
  }

  status(): TunnelStatus {
    return { ...this.st, output: [...this.st.output], supervisor: this.sup ? { ...this.sup } : null };
  }

  get up(): boolean {
    return this.st.phase === 'up' || (this.st.phase === 'unmanaged' && this.st.portOpen);
  }

  start(): void {
    if (this.running) {
      if (this.supUrl) this.ask('connect');
      return;
    }
    this.running = true;
    this.leaseAt = 0;
    this.controlLost = false;
    if (this.o.command) this.launch();
    else if (this.supUrl) this.ask('connect');
    this.probeTimer = setInterval(() => void this.probe(), this.o.probeMs ?? PROBE_MS);
    this.probeTimer.unref?.();
    void this.probe();
  }

  /** Stop; `release` hands the scope back, false (a process restart) leaves the session with the supervisor. */
  stop(release = true): void {
    this.running = false;
    for (const t of [this.probeTimer, this.restartTimer, this.readyTimer]) if (t) clearTimeout(t);
    this.probeTimer = this.restartTimer = this.readyTimer = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill('SIGINT');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), STOP_GRACE_MS).unref();
    }
    if (this.supUrl && release) this.ask('disconnect');
    else if (this.supUrl) log.info('ZWO tunnel left to the supervisor (its lease expires by itself)');
    if (this.o.command || this.supUrl) this.set('stopped');
  }

  async flush(timeoutMs = 1500): Promise<void> {
    await Promise.race([this.pending, sleep(timeoutMs)]);
  }

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

  private detail(text: string | null): void {
    if (this.st.detail === text) return;
    this.st.detail = text;
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

  private ask(route: 'connect' | 'disconnect'): void {
    const url = this.supUrl;
    if (!url) return;
    const body: Record<string, unknown> = {};
    if (route === 'connect' && this.supOpts?.leaseS) body.leaseS = this.supOpts.leaseS;
    if (route === 'disconnect') body.waitS = DISCONNECT_WAIT_S;
    if (route === 'connect') this.leaseAt = Date.now();
    const timeout = route === 'connect' ? CONTROL_TIMEOUT_MS : CONTROL_TIMEOUT_MS + DISCONNECT_WAIT_S * 1000;
    this.pending = this.post(`${url}/${route}`, timeout, body);
  }

  private async post(url: string, timeoutMs: number, body: Record<string, unknown>): Promise<void> {
    const fetchFn = this.o.fetchFn ?? fetch;
    try {
      const res = await fetchFn(url, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const json = await res.json().catch(() => null);
      if (!res.ok && !json) this.lost(`POST ${url} answered ${res.status}`);
      else this.controlLost = false;
    } catch (e) {
      this.lost(`POST ${url}: ${errMsg(e)}`);
    }
  }

  private lost(why: string): void {
    if (this.controlLost) return;
    this.controlLost = true;
    this.sup = this.sup ? { ...this.sup, reachable: false } : null;
    this.detail(why);
    log.warn(`the ZWO tunnel's supervisor is not reachable: ${why}`);
  }

  private applySupervisor(raw: Record<string, unknown>): void {
    const phase = str(raw.phase);
    const desired = str(raw.desired);
    const output = Array.isArray(raw.output) ? (raw.output as unknown[]).filter((l): l is string => typeof l === 'string') : null;
    const device = obj(raw.device);
    const session = obj(raw.session);
    this.sup = {
      url: this.supUrl ?? '',
      reachable: true,
      phase,
      desired,
      attempts: num(raw.attempts) ?? 0,
      reconnects: num(raw.reconnects) ?? 0,
      lastError: str(raw.lastError),
      lastExit: str(raw.lastExit),
      device: device ? { sn: str(device.sn) ?? undefined, model: str(device.model) ?? undefined, status: str(device.status) ?? undefined } : null,
      session: session ? { sn: str(session.sn) ?? undefined, conId: str(session.conId) } : null,
      mode: str(raw.mode),
      leaseSeconds: num(raw.leaseSeconds),
      leaseExpiresAt: num(raw.leaseExpiresAt),
    };
    this.st.supervisor = this.sup;
    this.st.restarts = this.sup.reconnects;
    this.st.lastExit = this.sup.lastExit;
    if (output) this.st.output = output.slice(-LOG_LINES);
    if (this.controlLost) {
      this.controlLost = false;
      log.info('the ZWO tunnel supervisor answers again');
    }
    const next: TunnelPhase =
      phase === 'connected' ? 'up'
      : phase === 'releasing' ? 'releasing'
      : phase === 'failed' ? 'failed'
      : phase === 'idle' && desired !== 'connected' ? 'stopped'
      : 'starting';
    if (next === 'up' && !this.upAt) this.upAt = Date.now();
    if (next !== 'up') this.upAt = 0;
    this.detail(next === 'up' ? null : (this.sup.lastError ?? this.sup.lastExit ?? null));
    this.set(next);
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
    if (this.running && this.supUrl && Date.now() - this.leaseAt >= LEASE_REFRESH_MS) this.ask('connect');
    const open = await (this.o.probeFn ?? portOpen)(this.o.host, this.o.port).catch(() => false);
    if (!this.running) return;
    const changed = open !== this.st.portOpen;
    this.st.portOpen = open;
    if (this.supUrl) {
      const fetchFn = this.o.fetchFn ?? fetch;
      const url = `${this.supUrl}/status`;
      let state: Record<string, unknown> | null = null;
      try {
        const res = await fetchFn(url, { method: 'GET', headers: this.headers(false), signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
        if (res.ok) state = obj(await res.json().catch(() => null));
        else this.lost(`GET ${url} answered ${res.status}`);
      } catch (e) {
        this.lost(`GET ${url}: ${errMsg(e)}`);
      }
      if (state) this.applySupervisor(state);
      else if (open && this.st.phase !== 'up') this.set('up');
      else if (!open && this.st.phase === 'up') this.set('starting');
      if (changed) this.emit('status', this.status());
      return;
    }
    if (open && (!this.o.command || this.bannerSeen)) {
      if (!this.upAt) this.upAt = Date.now();
      this.set('up');
    } else if (this.st.phase === 'up') {
      this.set(this.o.command ? 'down' : 'unmanaged');
    }
    if (changed) this.emit('status', this.status());
  }

  private headers(post: boolean): Record<string, string> {
    const h: Record<string, string> = post ? { 'content-type': 'application/json' } : { accept: 'application/json' };
    if (this.supOpts?.token) h.authorization = `Bearer ${this.supOpts.token}`;
    return h;
  }
}
