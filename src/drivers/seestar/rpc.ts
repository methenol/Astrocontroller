/**
 * The Seestar's control link: JSON-RPC over TCP (port 4700), one JSON object per CRLF-terminated
 * line. Requests carry an `id` the reply echoes ({id, method, code, result, error}); the scope also
 * pushes unsolicited events ({Event, state, ...}) on the same socket, between replies.
 *
 * The link connects, runs the firmware 7.18+ handshake (auth.ts), heartbeats every 4 s like the
 * official app, and reconnects with a backoff when the socket drops or goes silent. It is the same
 * whether the address is the scope on the LAN or a ZWO Telescope Network tunnel on loopback.
 *
 * Events: 'connected' (after the handshake), 'disconnected' (reason), 'event' (SeestarEvent),
 * 'authFailed' (message), 'health'.
 */
import net from 'node:net';
import { errMsg, logger } from '../../log.js';
import { SafeEmitter } from '../../util/events.js';
import { handshake, type HandshakeResult } from './auth.js';

const log = logger('seestar');

/** the official app's heartbeat (SocketManager) */
const HEARTBEAT_MS = 4000;
/** lines kept for the wire log, and the longest kept whole */
const WIRE_LINES = 2000;
const WIRE_LINE_MAX = 2000;
/** nothing at all received for this long (heartbeat replies included): the link is dead */
const SILENT_AFTER_MS = 15_000;
const CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** a line longer than this is not JSON-RPC: drop the buffer instead of growing without bound */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface RpcResponse {
  id: number;
  method?: string;
  code: number;
  result?: unknown;
  error?: string;
  [k: string]: unknown;
}

/** An event the scope pushed: `Event` names it, `state` is its stage (start, working, complete, fail, cancel…). */
export interface SeestarEvent {
  Event: string;
  state?: string;
  code?: number;
  error?: string;
  timestamp?: string;
  /** when we received it (ms epoch) */
  at: number;
  [k: string]: unknown;
}

export class SeestarRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly detail: string | undefined,
    readonly response: RpcResponse,
  ) {
    super(`${method} failed: code ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'SeestarRpcError';
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  /** resolve with a non-zero code instead of throwing */
  allowError?: boolean;
}

export interface RpcLinkOptions {
  host: string;
  port: number;
  /** PEM key for the handshake; null = none configured */
  loadKey: () => string | null;
  /** tests: a socket other than a real TCP connection */
  connect?: (host: string, port: number) => net.Socket;
  heartbeatMs?: number;
  silentAfterMs?: number;
  backoffMinMs?: number;
}

export interface LinkHealth {
  host: string;
  port: number;
  connected: boolean;
  authenticated: boolean;
  /** the scope asked for the handshake (firmware 7.18+) */
  authRequired: boolean | null;
  lastRxAt: number | null;
  connectedAt: number | null;
  reconnects: number;
  lastError: string | null;
}

interface Pending {
  method: string;
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  allowError: boolean;
}

export class SeestarRpc extends SafeEmitter {
  private sock: net.Socket | null = null;
  private buf = '';
  private nextId = 10_000;
  private readonly pending = new Map<number, Pending>();
  private running = false;
  private ready = false;
  private auth: HandshakeResult | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoff: number;
  /** the recent traffic, for the web UI's wire log: [at, direction, line] */
  private readonly wire: Array<[number, '→' | '←' | '⚡', string]> = [];
  private readonly st = { lastRxAt: null as number | null, connectedAt: null as number | null, reconnects: 0, lastError: null as string | null };

  constructor(private o: RpcLinkOptions) {
    super();
    this.backoff = o.backoffMinMs ?? BACKOFF_MIN_MS;
  }

  /** Commands are executed: connected and past the handshake. */
  get usable(): boolean {
    return this.ready;
  }

  get target(): string {
    return `${this.o.host}:${this.o.port}`;
  }

  health(): LinkHealth {
    return {
      host: this.o.host,
      port: this.o.port,
      connected: this.ready,
      authenticated: this.auth?.verified ?? false,
      authRequired: this.auth ? this.auth.required : null,
      ...this.st,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop('stopped');
  }

  /** A new address (the web UI, or the tunnel moved): reconnect there. */
  retarget(host: string, port = this.o.port): void {
    this.o = { ...this.o, host, port };
    if (this.running) {
      this.drop('address changed');
      this.open();
    }
  }

  request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<RpcResponse> {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error(`the Seestar at ${this.target} is not connected`));
    return this.send(method, params, opts);
  }

  // ---- connection ----------------------------------------------------------

  private open(): void {
    if (!this.running || this.sock) return;
    const { host, port } = this.o;
    log.debug(`connecting to ${host}:${port}`);
    const sock = this.o.connect ? this.o.connect(host, port) : net.connect({ host, port });
    this.sock = sock;
    this.buf = '';
    sock.setNoDelay?.(true);
    sock.setKeepAlive?.(true, 10_000);
    const connectTimer = setTimeout(() => sock.destroy(new Error(`no answer from ${host}:${port} within ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS);
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      clearTimeout(connectTimer);
      void this.onSocketOpen(sock);
    });
    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('error', (e) => {
      this.st.lastError = errMsg(e);
      log.debug(`socket error: ${errMsg(e)}`);
    });
    sock.on('close', () => {
      clearTimeout(connectTimer);
      if (this.sock === sock) this.drop(this.st.lastError ?? 'closed by the scope');
    });
  }

  private async onSocketOpen(sock: net.Socket): Promise<void> {
    this.st.lastRxAt = Date.now();
    this.startHeartbeat();
    try {
      this.auth = await handshake((m, p, t) => this.send(m, p, { timeoutMs: t, allowError: true }), this.o.loadKey);
    } catch (e) {
      if (this.sock !== sock) return;
      this.st.lastError = errMsg(e);
      log.error(`Seestar handshake failed: ${errMsg(e)}`);
      this.emit('authFailed', errMsg(e));
      sock.destroy();
      return;
    }
    if (this.sock !== sock) return;
    this.ready = true;
    this.backoff = this.o.backoffMinMs ?? BACKOFF_MIN_MS;
    this.st.connectedAt = Date.now();
    this.st.lastError = null;
    log.info(`connected to the Seestar at ${this.target}${this.auth.required ? ' (handshake verified)' : ''}`);
    this.emit('connected');
    this.emit('health');
  }

  private drop(reason: string): void {
    const sock = this.sock;
    const wasReady = this.ready;
    this.sock = null;
    this.ready = false;
    this.auth = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (sock && !sock.destroyed) sock.destroy();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: the connection to the Seestar closed (${reason})`));
      this.pending.delete(id);
    }
    if (wasReady) {
      log.warn(`Seestar link down: ${reason}`);
      this.emit('disconnected', reason);
      this.emit('health');
    }
    if (this.running && !this.retryTimer) {
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      this.st.reconnects++;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, wait);
      this.retryTimer.unref?.();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const every = this.o.heartbeatMs ?? HEARTBEAT_MS;
    const silentAfter = this.o.silentAfterMs ?? SILENT_AFTER_MS;
    this.heartbeat = setInterval(() => {
      if (!this.sock) return;
      if (this.st.lastRxAt !== null && Date.now() - this.st.lastRxAt > silentAfter) {
        this.drop(`nothing received for ${Math.round(silentAfter / 1000)} s`);
        return;
      }
      this.send('test_connection', undefined, { timeoutMs: every * 2, allowError: true }).catch(() => {});
    }, every);
    this.heartbeat.unref?.();
  }

  // ---- framing -------------------------------------------------------------

  private send(method: string, params: unknown, opts: RequestOptions): Promise<RpcResponse> {
    const sock = this.sock;
    if (!sock || sock.destroyed) return Promise.reject(new Error(`the Seestar at ${this.target} is not connected`));
    const id = this.nextId;
    this.nextId = this.nextId >= 2 ** 31 - 1 ? 10_000 : this.nextId + 1;
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) msg.params = params;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply from the Seestar within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer, allowError: !!opts.allowError });
      const line = JSON.stringify(msg);
      if (method !== 'test_connection') this.record('→', line);
      sock.write(`${line}\r\n`);
    });
  }

  private record(dir: '→' | '←' | '⚡', line: string): void {
    this.wire.push([Date.now(), dir, line.length > WIRE_LINE_MAX ? `${line.slice(0, WIRE_LINE_MAX)}… (${line.length} B)` : line]);
    if (this.wire.length > WIRE_LINES) this.wire.splice(0, this.wire.length - WIRE_LINES);
  }

  /** The last n lines of traffic (requests →, replies ←, events ⚡); heartbeats left out. */
  wireLines(n: number, o: { notifications: boolean }): string[] {
    return this.wire
      .filter(([, dir, line]) => (o.notifications || dir !== '⚡') && !line.includes('"test_connection"'))
      .slice(-n)
      .map(([at, dir, line]) => `${new Date(at).toISOString()} ${dir} ${line}`);
  }

  private onData(chunk: string): void {
    this.st.lastRxAt = Date.now();
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '').trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
    if (this.buf.length > MAX_LINE_BYTES) {
      log.warn(`dropped ${this.buf.length} bytes without a line end from the Seestar`);
      this.buf = '';
    }
  }

  private onLine(line: string): void {
    this.record(line.includes('"Event"') ? '⚡' : '←', line);
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug(`not JSON from the Seestar: ${line.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const m = msg as Record<string, unknown>;
    const name = typeof m.Event === 'string' ? m.Event : typeof m.event === 'string' ? m.event : null;
    if (name !== null) {
      const ev: SeestarEvent = { ...m, Event: name, at: Date.now() };
      delete ev.event;
      this.emit('event', ev);
      return;
    }
    const id = typeof m.id === 'number' ? m.id : Number(m.id);
    const p = this.pending.get(id);
    if (!p) return; // a late reply, or one to a request we no longer wait for
    this.pending.delete(id);
    clearTimeout(p.timer);
    const r: RpcResponse = { ...m, id, code: typeof m.code === 'number' ? m.code : 0 };
    if (r.code !== 0 && !p.allowError) p.reject(new SeestarRpcError(p.method, r.code, typeof r.error === 'string' ? r.error : undefined, r));
    else p.resolve(r);
  }
}
