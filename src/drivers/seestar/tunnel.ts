/**
 * The ZWO Telescope Network transport. seestar-portfwd (seestar-portfwd/ in this project) logs in
 * to the ZWO account, opens the ThroughTek Kalay P2P tunnel to the telescope and forwards its
 * native services (4700 control, 4800/4804 images, 4554/4555 RTSP, 80 ← files, …), so the control
 * code above it is the same one that talks to a scope on the LAN.
 *
 * The scope serves **one remote session**, so exactly one tunnel may exist and it has to be given
 * back when we are done with it. Three ways to drive it, best first:
 *
 *  - **supervisor** (the Docker setup): the tunnel container runs a supervisor that owns the
 *    session, retries it and releases it. Connect and Disconnect are its `POST /connect` and
 *    `POST /disconnect`, so pressing either in the web UI really does take the scope and hand it
 *    back. It also holds the session only while this class keeps refreshing its lease: if
 *    Astrocontroller dies, the tunnel does not sit on the telescope.
 *  - **command** (SEESTAR_TUNNEL_COMMAND, no Docker): we run it as our own child, restart it when
 *    it exits, and SIGINT it on stop, which makes it release the session.
 *  - **unmanaged**: you run the tunnel yourself; we only watch the forwarded control port.
 *
 * A supervisor that does not answer (an older image without one) degrades to the unmanaged rule —
 * the port is watched and the reason is reported in `detail`.
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
/** how long a control request may take before we call the supervisor lost */
const CONTROL_TIMEOUT_MS = 2500;
/** /disconnect waits for the backend to confirm the release; ask for a bounded wait */
const DISCONNECT_WAIT_S = 6;
/** refresh the lease well inside its lifetime */
const LEASE_REFRESH_MS = 30_000;

export type TunnelPhase = 'unmanaged' | 'starting' | 'up' | 'down' | 'releasing' | 'stopped' | 'failed';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** what the container's supervisor reported on the last status poll */
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
  /** something here drives the tunnel: a supervisor we command, or a child we spawned */
  managed: boolean;
  command: string | null;
  /** the forwarded control port answers */
  portOpen: boolean;
  since: number;
  restarts: number;
  lastExit: string | null;
  /** the last lines the tunnel printed (its "tunnel ready" line, login errors…) */
  output: string[];
  /** one line for the UI: why the tunnel is not up, when it is not */
  detail: string | null;
  supervisor: SupervisorState | null;
}

export interface TunnelSupervisorOptions {
  host: string;
  port: number;
  /** sent as Authorization: Bearer <token> when the container sets SEESTAR_TUNNEL_CONTROL_TOKEN */
  token?: string;
  /** hold the session only while we keep asking; 0 = until Disconnect */
  leaseS: number;
}

export interface TunnelOptions {
  host: string;
  port: number;
  command: string;
  cwd?: string;
  readyTimeoutS: number;
  /** the variables seestar-portfwd reads */
  env: Record<string, string>;
  /** the container's supervisor: Connect and Disconnect become its API calls */
  supervisor?: TunnelSupervisorOptions | null;
  /** tests */
  spawnFn?: typeof spawn;
  probeFn?: (host: string, port: number) => Promise<boolean>;
  fetchFn?: typeof fetch;
  /** how often the tunnel polls the supervisor and the forwarded port */
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
  /** the managed tunnel printed its banner since it was launched */
  private bannerSeen = false;
  /** the last connect/lease request we sent the supervisor */
  private leaseAt = 0;
  /** the request the shutdown path waits for (Disconnect has to reach the container) */
  private pending: Promise<unknown> = Promise.resolve();
  /** logged once, not on every poll */
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

  start(): void {
    if (this.running) {
      // already driving it, but the supervisor may have given up: Connect has to be heard again
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

  /**
   * Stop. `release` (the default) hands the scope back; a process shutdown passes false and leaves
   * the session with the supervisor, whose lease outlives a restart: a redeploy then costs no
   * session, and the scope's P2P agent is not made to start its minutes-long recovery for nothing.
   */
  stop(release = true): void {
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
    // The supervisor keeps the session for someone else to hold it: tell it we are done. A lost
    // request is not fatal (its lease expires by itself), but this is the polite, immediate way.
    if (this.supUrl && release) this.ask('disconnect');
    else if (this.supUrl) log.info('ZWO tunnel left to the supervisor for a restart (its lease expires by itself)');
    if (this.o.command || this.supUrl) this.set('stopped');
  }

  /** Let a shutdown wait for the disconnect request to leave. */
  async flush(timeoutMs = 1500): Promise<void> {
    await Promise.race([this.pending, sleep(timeoutMs)]);
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

  // ---- the container's supervisor -------------------------------------------------------------

  /** Fire a control request; the shutdown path awaits it through flush(). */
  private ask(route: 'connect' | 'disconnect', extra?: Record<string, unknown>): void {
    const url = this.supUrl;
    if (!url) return;
    const body: Record<string, unknown> = { ...extra };
    if (route === 'connect' && this.supOpts?.leaseS) body.leaseS = this.supOpts.leaseS;
    if (route === 'disconnect') body.waitS = DISCONNECT_WAIT_S;
    if (route === 'connect') this.leaseAt = Date.now();
    const fetchFn = this.o.fetchFn ?? fetch;
    this.pending = this.request(fetchFn, `${url}/${route}`, route === 'connect' ? CONTROL_TIMEOUT_MS : CONTROL_TIMEOUT_MS + DISCONNECT_WAIT_S * 1000, body);
  }

  private async request(fetchFn: typeof fetch, url: string, timeoutMs: number, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const headers = this.supHeaders(true);
    try {
      const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok && !json) {
        this.lost(`POST ${url} answered ${res.status}`);
        return null;
      }
      this.controlLost = false;
      return obj(json) ?? null;
    } catch (e) {
      this.lost(`POST ${url}: ${errMsg(e)}`);
      return null;
    }
  }

  private lost(why: string): void {
    // one line per episode: the poll runs every few seconds and the container may simply be down
    if (this.controlLost) return;
    this.controlLost = true;
    this.sup = this.sup ? { ...this.sup, reachable: false } : null;
    this.detail(why);
    log.warn(`the ZWO tunnel's supervisor is not reachable: ${why}`);
  }

  /** Fold the supervisor's own state into what the UI and the agent see. */
  private applySupervisor(raw: Record<string, unknown>): void {
    const phase = str(raw.phase) ?? null;
    const desired = str(raw.desired) ?? null;
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
    if (output) {
      this.st.output = output.slice(-LOG_LINES);
    }
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
    this.detail(next === 'up' ? null : this.sup.lastError ?? this.sup.lastExit ?? null);
    this.set(next);
  }

  // ---- the command mode: our own child ----------------------------------------------------------

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
        const res = await fetchFn(url, { method: 'GET', headers: this.supHeaders(false), signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
        if (res.ok) state = obj(await res.json().catch(() => null));
        else this.lost(`GET ${url} answered ${res.status}`);
      } catch (e) {
        this.lost(`GET ${url}: ${errMsg(e)}`);
      }
      if (state) this.applySupervisor(state);
      else if (open && this.st.phase !== 'up') this.set('up'); // no supervisor: fall back to the port
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

  /** The supervisor is a container-to-container API; the bearer token is optional there too. */
  private supHeaders(post: boolean): Record<string, string> {
    const h: Record<string, string> = post ? { 'content-type': 'application/json' } : { accept: 'application/json' };
    if (this.supOpts?.token) h.authorization = `Bearer ${this.supOpts.token}`;
    return h;
  }
}
