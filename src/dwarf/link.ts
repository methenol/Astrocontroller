import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { encodePacket, decodePacket, MessageType } from '@alikh/dwarflab-sdk';
import { requestType, responseType, decodeWith, decodeNotification, errorText, type ProtoType } from './protocol.js';
import { logger, errMsg } from '../log.js';
import { assertLinked } from './gate.js';

const log = logger('link');

export class DwarfCommandError extends Error {
  constructor(
    readonly cmd: number,
    readonly code: number,
    readonly response: Record<string, unknown>,
  ) {
    super(`command ${cmd} failed: ${errorText(code)}`);
  }
}

export interface RequestOptions {
  /** Override the request message type. */
  reqType?: ProtoType;
  /** Override the response message type. */
  resType?: ProtoType;
  /** ms to wait for the reply (default 15 s). */
  timeout?: number;
  /** Resolve with the payload even if code < 0 (default false → throw). */
  allowError?: boolean;
  /** Resolve null on timeout instead of throwing (fire-and-forget commands). */
  bestEffort?: boolean;
}

export interface Notification {
  cmd: number;
  name: string;
  data: Record<string, unknown>;
  ts: number;
}

interface Pending {
  resolve: (v: Record<string, unknown> | null) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  opts: RequestOptions;
  resType?: ProtoType;
}

/**
 * Single long-lived control connection to the telescope (port 9900).
 *
 * Firmware facts this relies on (verified on DWARF 3 fw 1.5.3):
 * - replies come back as type 3 with the same cmd; clientId is not echoed, so
 *   we match replies FIFO per command;
 * - long operations (motor run-to/reset) reply only when the motion completes;
 * - the device drops secondary clients while the official DWARFLAB app holds
 *   its session, so reconnects back off and are logged clearly.
 */
export class DwarfLink extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending[]>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private stopped = false;
  private shortLived = 0;
  private openedAt = 0;
  readonly clientId = `astrocontroller_${Date.now().toString(36)}`;
  connected = false;

  constructor(
    private host: string,
    private readonly port: number,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown(new Error('link stopped'));
  }

  /** Force a fresh connection (used by the reconnect tool). */
  reconnect(): void {
    assertLinked();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown(new Error('reconnecting'));
    this.backoff = 1000;
    this.open();
  }

  /** Point the link at another address (set from the web UI); reconnects at once unless stopped. */
  retarget(host: string): void {
    if (host === this.host) return;
    this.host = host;
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const wasConnected = this.connected;
    this.teardown(new Error(`telescope address changed to ${host}`));
    if (wasConnected) this.emit('disconnected');
    this.backoff = 1000;
    this.shortLived = 0;
    this.open();
  }

  waitConnected(timeoutMs = 10000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('connected', ok);
        reject(new Error(`telescope not connected (ws://${this.host}:${this.port}). Is it powered on, and is the official DWARFLAB app closed?`));
      }, timeoutMs);
      const ok = () => {
        clearTimeout(t);
        resolve();
      };
      this.once('connected', ok);
    });
  }

  private open(): void {
    if (this.stopped) return;
    const url = `ws://${this.host}:${this.port}/`;
    const ws = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.openedAt = Date.now();
      this.backoff = 1000;
      log.info(`connected to ${url}`);
      this.keepalive = setInterval(() => {
        try {
          ws.send('ping');
        } catch {
          /* closed */
        }
      }, 15000);
      this.emit('connected');
    });

    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (!isBinary) return; // "pong" keepalive replies
      try {
        this.handlePacket(new Uint8Array(raw));
      } catch (err) {
        log.warn(`bad packet: ${errMsg(err)}`);
      }
    });

    ws.on('error', (err) => log.debug(`socket error: ${errMsg(err)}`));

    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      const lived = this.openedAt ? Date.now() - this.openedAt : 0;
      const wasConnected = this.connected;
      this.teardown(new Error(`connection closed (${code})`));
      if (wasConnected) {
        if (lived < 3000) {
          this.shortLived++;
          if (this.shortLived === 3 || this.shortLived % 20 === 0) {
            log.warn('telescope keeps dropping the connection ~1s after connect — another client (usually the official DWARFLAB app) holds the session. Close it to give control to Astrocontroller.');
          }
        } else {
          this.shortLived = 0;
          log.warn(`disconnected (${code})`);
        }
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private teardown(reason: Error): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) {
      ws.removeAllListeners('message');
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    for (const queue of this.pending.values()) {
      for (const p of queue) {
        clearTimeout(p.timer);
        if (p.opts.bestEffort) p.resolve(null);
        else p.reject(reason);
      }
    }
    this.pending.clear();
  }

  private handlePacket(bytes: Uint8Array): void {
    const pkt = decodePacket(bytes);
    if (pkt.type === MessageType.NOTIFICATION) {
      const { name, data } = decodeNotification(pkt.cmd, pkt.data);
      const n: Notification = { cmd: pkt.cmd, name, data, ts: Date.now() };
      this.emit('notification', n);
      return;
    }
    const queue = this.pending.get(pkt.cmd);
    const p = queue?.shift();
    if (queue && queue.length === 0) this.pending.delete(pkt.cmd);
    const decoded = decodeWith(p?.resType ?? responseType(pkt.cmd), pkt.data);
    this.emit('reply', { cmd: pkt.cmd, data: decoded });
    if (!p) return;
    clearTimeout(p.timer);
    const code = typeof decoded.code === 'number' ? decoded.code : 0;
    if (code < 0 && !p.opts.allowError && !p.opts.bestEffort) {
      p.reject(new DwarfCommandError(pkt.cmd, code, decoded));
    } else {
      p.resolve(decoded);
    }
  }

  /** Send a command and wait for its reply. */
  async request(cmd: number, params: Record<string, unknown> = {}, opts: RequestOptions = {}): Promise<Record<string, unknown> | null> {
    assertLinked();
    if (!this.connected) await this.waitConnected(opts.timeout ? Math.min(opts.timeout, 10000) : 10000);
    const ws = this.ws;
    if (!ws) throw new Error('telescope not connected');
    const reqType = opts.reqType ?? requestType(cmd);
    let payload: Uint8Array = new Uint8Array(0);
    if (reqType) {
      payload = reqType.encode(reqType.create(params)).finish();
    } else if (Object.keys(params).length > 0) {
      throw new Error(`no request type registered for command ${cmd}; pass reqType`);
    }
    const packet = encodePacket(cmd, MessageType.REQUEST, payload, this.clientId, 1);
    // Generous by default: the scope's Wi-Fi spikes past 200 ms and busy firmware answers late.
    const timeout = opts.timeout ?? 15000;
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        resolve,
        reject,
        opts,
        resType: opts.resType,
        timer: setTimeout(() => {
          const q = this.pending.get(cmd);
          const i = q ? q.indexOf(entry) : -1;
          if (q && i >= 0) q.splice(i, 1);
          if (opts.bestEffort) resolve(null);
          else reject(new Error(`command ${cmd} timed out after ${Math.round(timeout / 1000)}s`));
        }, timeout),
      };
      const q = this.pending.get(cmd) ?? [];
      q.push(entry);
      this.pending.set(cmd, q);
      ws.send(packet, (err) => {
        if (err) {
          clearTimeout(entry.timer);
          const qq = this.pending.get(cmd);
          if (qq) qq.splice(qq.indexOf(entry), 1);
          if (opts.bestEffort) resolve(null);
          else reject(err);
        }
      });
    });
  }

  /** Wait for a notification matching `pred`, or time out. */
  waitFor(pred: (n: Notification) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<Notification> {
    return new Promise((resolve, reject) => {
      const onN = (n: Notification) => {
        if (pred(n)) {
          cleanup();
          resolve(n);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for telescope`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('notification', onN);
        signal?.removeEventListener('abort', onAbort);
      };
      this.on('notification', onN);
      signal?.addEventListener('abort', onAbort);
    });
  }
}
