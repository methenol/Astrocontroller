/**
 * The control link: JSON-RPC over TCP (port 4700), one JSON object per CRLF line.
 *
 *   → { id, method, params? }                               request
 *   ← { jsonrpc, Timestamp, id, method, code, result|error } reply
 *   ← { Event, state, ... }                                  notification
 *
 * The link behaves like the official app: a test_connection heartbeat every 2 s, the connection is
 * dropped after 15 s of silence, a request is given 20 s (60 s for a view start/stop), and a dropped
 * link is redialled with a backoff of 1 → 30 s. It stays open from start() to stop(); the owner is
 * told through 'connected', 'disconnected', 'event', 'authFailed' and 'health'.
 */
import net from 'node:net';
import { SafeEmitter } from '../../util/events.js';
import { errMsg, logger } from '../../log.js';
import { handshake, type RpcResponse, type Send } from './auth.js';

const log = logger('seestar.link');

export const DEFAULT_TIMEOUT_MS = 20_000;
export const VIEW_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 8_000;
const HEARTBEAT_MS = 2_000;
const SILENT_AFTER_MS = 15_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const WIRE_LINES = 2000;
const WIRE_CHARS = 2000;
const FIRST_ID = 10_000;
const MAX_ID = 2 ** 31 - 1;

export class SeestarRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly detail: string,
    readonly response: RpcResponse,
  ) {
    super(`${method} failed: code ${code} (${detail})`);
    this.name = 'SeestarRpcError';
  }
}

export interface LinkHealth {
  host: string;
  port: number;
  connected: boolean;
  authenticated: boolean;
  authRequired: boolean;
  lastRxAt: number | null;
  connectedAt: number | null;
  reconnects: number;
  lastError: string | null;
}

export interface LinkOptions {
  host: string;
  port: number;
  loadKey: () => string;
  /** test seam: how a socket is made */
  connect?: (host: string, port: number) => net.Socket;
  heartbeatMs?: number;
  silentAfterMs?: number;
  backoffMinMs?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** resolve with the reply even when its code is non-zero */
  allowError?: boolean;
}

export interface SeestarEvent {
  Event?: string;
  event?: string;
  state?: string;
  at: number;
  [k: string]: unknown;
}

interface Pending {
  method: string;
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class SeestarLink extends SafeEmitter {
  private socket: net.Socket | null = null;
  private wanted = false;
  private ready = false;
  private buffer = '';
  private nextId = FIRST_ID;
  private readonly pending = new Map<number, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  private silence: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private readonly wire: string[] = [];
  private h: LinkHealth;
  private readonly connectFn: (host: string, port: number) => net.Socket;
  private readonly heartbeatMs: number;
  private readonly silentAfterMs: number;
  private readonly backoffMinMs: number;
  private generation = 0;

  constructor(private readonly opts: LinkOptions) {
    super();
    this.setMaxListeners(50);
    this.connectFn = opts.connect ?? ((host, port) => net.connect({ host, port }));
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.silentAfterMs = opts.silentAfterMs ?? SILENT_AFTER_MS;
    this.backoffMinMs = opts.backoffMinMs ?? BACKOFF_MIN_MS;
    this.backoffMs = this.backoffMinMs;
    this.h = { host: opts.host, port: opts.port, connected: false, authenticated: false, authRequired: false, lastRxAt: null, connectedAt: null, reconnects: 0, lastError: null };
  }

  /** connected and past the handshake */
  get usable(): boolean {
    return this.ready;
  }

  get target(): { host: string; port: number } {
    return { host: this.h.host, port: this.h.port };
  }

  health(): LinkHealth {
    return { ...this.h };
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.backoffMs = this.backoffMinMs;
    this.dial();
  }

  stop(): void {
    this.wanted = false;
    this.clearRetry();
    this.drop('stopped');
  }

  /** Point the link somewhere else (a tunnel that moved); redials when running. */
  retarget(host: string, port = this.h.port): void {
    if (host === this.h.host && port === this.h.port) return;
    this.h.host = host;
    this.h.port = port;
    if (this.wanted) {
      this.drop('retargeted');
      this.clearRetry();
      this.backoffMs = this.backoffMinMs;
      this.dial();
    }
  }

  async request(method: string, params?: unknown, options: RequestOptions = {}): Promise<RpcResponse> {
    if (!this.ready) throw new Error(`${method}: the Seestar is not connected`);
    const reply = await this.send(method, params, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const code = typeof reply.code === 'number' ? reply.code : 0;
    if (code !== 0 && !options.allowError) throw new SeestarRpcError(method, code, describeError(reply), reply);
    return reply;
  }

  /** The last lines on the wire (→ sent, ← reply, ⚡ notification). */
  wireLines(n = 60, { notifications = true } = {}): string[] {
    const lines = notifications ? this.wire : this.wire.filter((l) => !l.includes(' ⚡ '));
    return lines.slice(-n);
  }

  private dial(): void {
    if (!this.wanted || this.socket) return;
    const gen = ++this.generation;
    const { host, port } = this.h;
    log.info(`connecting to ${host}:${port}`);
    let socket: net.Socket;
    try {
      socket = this.connectFn(host, port);
    } catch (err) {
      this.h.lastError = errMsg(err);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!this.h.connected && this.socket === socket) this.drop('connect timeout');
    });
    socket.on('connect', () => {
      if (this.socket !== socket) return;
      socket.setTimeout(0);
      this.h.connected = true;
      this.h.connectedAt = Date.now();
      this.h.lastError = null;
      this.touch();
      void this.establish(gen);
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      this.touch();
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > MAX_LINE_BYTES) {
        this.buffer = '';
        this.drop('oversized line');
        return;
      }
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, '');
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.h.lastError = errMsg(err);
      this.drop(errMsg(err));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.drop('closed by the Seestar');
    });
  }

  private async establish(gen: number): Promise<void> {
    const send: Send = (method, params, timeoutMs) => this.send(method, params, timeoutMs);
    try {
      const r = await handshake(send, this.opts.loadKey);
      if (gen !== this.generation || !this.socket) return;
      this.h.authRequired = r.required;
      this.h.authenticated = r.required ? r.verified : true;
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = errMsg(err);
      this.h.lastError = msg;
      this.h.authenticated = false;
      log.error(`handshake failed: ${msg}`);
      this.emit('authFailed', msg);
      this.drop(`handshake failed: ${msg}`);
      return;
    }
    this.ready = true;
    this.backoffMs = this.backoffMinMs;
    this.startHeartbeat();
    this.emitHealth();
    log.info(`connected to ${this.h.host}:${this.h.port}${this.h.authRequired ? ' (verified)' : ''}`);
    this.emit('connected');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (!this.ready) return;
      this.send('test_connection', undefined, this.silentAfterMs).catch(() => undefined);
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private touch(): void {
    this.h.lastRxAt = Date.now();
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => this.drop(`silent for ${Math.round(this.silentAfterMs / 1000)} s`), this.silentAfterMs);
  }

  private onLine(line: string): void {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(line) as RpcResponse;
    } catch {
      this.record('←', line);
      log.warn(`unparseable line from the Seestar: ${line.slice(0, 120)}`);
      return;
    }
    const name = (msg as { Event?: unknown; event?: unknown }).Event ?? (msg as { event?: unknown }).event;
    const isEvent = typeof name === 'string' && !(typeof msg.id === 'number' && this.pending.has(msg.id));
    if (msg.method !== 'test_connection' || isEvent) this.record(isEvent ? '⚡' : '←', line);
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    if (isEvent) this.emit('event', { ...msg, Event: msg.Event ?? msg.event, at: Date.now() } as SeestarEvent);
  }

  private send(method: string, params: unknown, timeoutMs: number): Promise<RpcResponse> {
    const socket = this.socket;
    if (!socket || !this.h.connected) return Promise.reject(new Error(`${method}: the Seestar is not connected`));
    const id = this.nextId;
    this.nextId = this.nextId >= MAX_ID ? FIRST_ID : this.nextId + 1;
    const body: Record<string, unknown> = { id, method };
    if (params !== undefined) body.params = params;
    const line = JSON.stringify(body);
    if (method !== 'test_connection') this.record('→', line);
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply from the Seestar in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      socket.write(line + '\r\n', (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            reject(new Error(`${method}: ${errMsg(err)}`));
          }
        }
      });
    });
  }

  private record(dir: '→' | '←' | '⚡', line: string): void {
    const text = line.length > WIRE_CHARS ? line.slice(0, WIRE_CHARS) + '…' : line;
    this.wire.push(`${new Date().toISOString()} ${dir} ${text}`);
    if (this.wire.length > WIRE_LINES) this.wire.splice(0, this.wire.length - WIRE_LINES);
  }

  private drop(reason: string): void {
    const socket = this.socket;
    const wasReady = this.ready;
    this.socket = null;
    this.ready = false;
    this.buffer = '';
    this.stopHeartbeat();
    if (this.silence) clearTimeout(this.silence);
    this.silence = null;
    this.generation++;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
    }
    const wasConnected = this.h.connected;
    this.h.connected = false;
    this.h.authenticated = false;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: the connection to the Seestar closed (${reason})`));
    }
    if (wasConnected) log.warn(`disconnected: ${reason}`);
    this.emitHealth();
    if (wasReady) this.emit('disconnected', reason);
    if (this.wanted && reason !== 'stopped') this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retry || this.socket) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.wanted) return;
      this.h.reconnects++;
      this.dial();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private emitHealth(): void {
    this.emit('health', this.health());
  }
}

function describeError(reply: RpcResponse): string {
  const e = reply.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    return JSON.stringify(e);
  }
  if (typeof reply.result === 'string') return reply.result;
  return 'no detail';
}
