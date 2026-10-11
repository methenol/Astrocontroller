import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { encodePacket, decodePacket, MessageType } from '@alikh/dwarflab-sdk';
import { requestType, responseType, decodeWith, decodeNotification, errorText, type ProtoType } from './protocol.js';
import { logger, errMsg } from '../log.js';
import { assertLinked, gate } from './gate.js';
import { wire, cmdName } from './wirelog.js';

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

/**
 * The telescope accepts the connection but executes nothing: its command service has hung
 * (verified 2026-10-10 on fw 1.5.3: the socket stayed open and answered keepalive pings for
 * 3.5 hours while not one command was answered; only a power cycle cleared it).
 */
export class TelescopeUnresponsiveError extends Error {
  readonly unresponsive = true;
}

/** True for errors that mean the telescope cannot be reached or does not execute commands. */
export function isLinkFailure(err: unknown): boolean {
  if (err instanceof TelescopeUnresponsiveError) return true;
  const m = errMsg(err);
  return /telescope not connected|connection closed|link stopped|reconnecting|address changed/.test(m);
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
  /**
   * Which reply belongs to this request. Replies carry no request id (fw 1.5.3), so replies to the
   * same command are matched in order; a late reply to a timed-out request would otherwise be handed
   * to the next caller (e.g. one motor axis's position to a read of the other axis).
   */
  match?: (reply: Record<string, unknown>) => boolean;
}

export interface Notification {
  cmd: number;
  name: string;
  data: Record<string, unknown>;
  ts: number;
}

export type LinkState = 'released' | 'connecting' | 'connected' | 'unresponsive' | 'contended';

export interface LinkHealth {
  state: LinkState;
  /** when the current state began */
  since: number;
  /** a human explanation of the state, for the UI, the agent and tool errors */
  detail: string;
  lastReplyAgoS: number | null;
  lastTrafficAgoS: number | null;
  unansweredCommands: number;
  reconnects: number;
}

interface Pending {
  resolve: (v: Record<string, unknown> | null) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  opts: RequestOptions;
  resType?: ProtoType;
}

/** Firmware command used to probe the command service: cheap, always answered by healthy firmware. */
const PROBE_CMD = 16405;
/** Keepalive cadence; the firmware answers each text "ping" with "pong". */
const PING_EVERY_MS = 10_000;
/** No traffic at all (not even pong) for this long: the socket is dead (half-open TCP, Wi-Fi gone). */
const DEAD_SOCKET_MS = 35_000;
/** No binary packet for this long while connected: probe the command service. */
const PROBE_IF_QUIET_MS = 25_000;
const PROBE_TIMEOUT_MS = 10_000;
/** Declared unresponsive after this many unanswered commands AND this long without any packet. */
const STRIKES = 3;
const SILENCE_MS = 60_000;
/** A connection that lasted this long resets the reconnect backoff. */
const STABLE_MS = 30_000;
/** Connections dropped within this time of opening count toward contention. */
const SHORT_MS = 10_000;

/**
 * Single long-lived control connection to the telescope (port 9900).
 *
 * Firmware facts this relies on (verified on DWARF 3 fw 1.5.3):
 * - replies come back as type 3 with the same cmd; clientId is not echoed, so
 *   we match replies FIFO per command (optionally narrowed by `match`);
 * - long operations (motor run-to/reset) reply only when the motion completes;
 * - ONE control client at a time, newest wins: a new connection closes the previous
 *   one at once (1006). Two clients that both reconnect knock each other off for ever,
 *   so repeated short-lived connections back off hard and are reported as contention;
 * - the command service can hang while the socket stays open and keeps answering pings.
 *   A health monitor detects it, fails commands fast with an explanation, and keeps
 *   probing until the telescope answers again.
 */
export class DwarfLink extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending[]>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private monitor: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private stopped = true;
  private openedAt = 0;
  private lastPingAt = 0;
  /** last frame of any kind (binary packet or text pong) on the current socket */
  private lastRxAt = 0;
  /** last binary packet (reply or notification): the command service is alive */
  private lastPacketAt = 0;
  private everAnswered = false;
  private strikes = 0;
  private probing = false;
  private lastProbeAt = 0;
  private failedProbes = 0;
  private unresponsiveSince = 0;
  private lastUnresponsiveLog = 0;
  /** open times of recent connections that ended within SHORT_MS */
  private shortDrops: number[] = [];
  private contendedSince = 0;
  private reconnects = 0;
  private stateSince = Date.now();
  private lastState: LinkState = 'released';
  readonly clientId = `astrocontroller_${Date.now().toString(36)}`;
  /** the socket is open (it may still be unresponsive: see `usable`) */
  connected = false;

  constructor(
    private host: string,
    private readonly port: number,
  ) {
    super();
    this.setMaxListeners(100);
  }

  /** Connected and the telescope is executing commands. */
  get usable(): boolean {
    return this.connected && !this.unresponsiveSince;
  }

  start(): void {
    this.stopped = false;
    this.backoff = 1000;
    this.shortDrops = [];
    this.contendedSince = 0;
    this.monitor ??= setInterval(() => this.checkHealth(), 2500);
    this.open();
    this.publish();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    const wasConnected = this.connected;
    this.teardown(new Error('link stopped'));
    this.unresponsiveSince = 0;
    this.strikes = 0;
    this.contendedSince = 0;
    if (wasConnected) this.emit('disconnected');
    this.publish();
  }

  /** Force a fresh connection (used by the reconnect tool). */
  reconnect(): void {
    assertLinked();
    if (this.stopped) {
      this.start();
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const wasConnected = this.connected;
    this.teardown(new Error('reconnecting'));
    if (wasConnected) this.emit('disconnected');
    this.backoff = 1000;
    this.open();
    this.publish();
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
    this.shortDrops = [];
    this.contendedSince = 0;
    this.unresponsiveSince = 0;
    this.strikes = 0;
    this.everAnswered = false;
    this.open();
    this.publish();
  }

  waitConnected(timeoutMs = 10000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('connected', ok);
        reject(new Error(`telescope not connected (ws://${this.host}:${this.port}). ${this.health().detail}`));
      }, timeoutMs);
      const ok = () => {
        clearTimeout(t);
        resolve();
      };
      this.once('connected', ok);
    });
  }

  // ---------------------------------------------------------------- health

  health(): LinkHealth {
    const now = Date.now();
    const state = this.currentState();
    let detail: string;
    switch (state) {
      case 'released':
        detail = 'released by the user (Disconnect in the web UI)';
        break;
      case 'connected':
        detail = 'connected; the telescope is answering commands';
        break;
      case 'connecting':
        detail = this.lastState === 'connecting' && now - this.stateSince > 20000
          ? `cannot reach the telescope at ${this.host}:${this.port} for ${Math.round((now - this.stateSince) / 1000)} s (powered off, out of Wi-Fi range, or a different address); retrying`
          : 'connecting';
        break;
      case 'contended':
        detail = `the telescope keeps closing the connection within seconds (${this.shortDrops.length} times since ${clock(this.contendedSince)}). Almost always another client is taking it: the telescope accepts one controller at a time and each new connection closes the previous one. Close the DWARFLAB app (or any other controller) on every phone/tablet. Astrocontroller retries once a minute instead of fighting for it.`;
        break;
      case 'unresponsive': {
        const mins = Math.max(1, Math.round((now - this.unresponsiveSince) / 60000));
        const net = this.lastRxAt && now - this.lastRxAt < DEAD_SOCKET_MS;
        detail = net
          ? `the telescope's command service is HUNG: it accepts the connection and answers network keepalives, but has not answered or executed any command for ${mins} min (since ${clock(this.unresponsiveSince)}). Nothing sent to it is executed — not even a reboot. It needs a physical power cycle (hold the power button until it turns off, then turn it on). Astrocontroller keeps probing and resumes by itself when it answers. This says nothing about the sky.`
          : `the telescope has not answered anything for ${mins} min (since ${clock(this.unresponsiveSince)}), including network keepalives: it is likely off, rebooting, or off the Wi-Fi. Astrocontroller keeps retrying and resumes by itself.`;
        break;
      }
    }
    return {
      state,
      since: this.stateSince,
      detail,
      lastReplyAgoS: this.lastPacketAt ? Math.round((now - this.lastPacketAt) / 1000) : null,
      lastTrafficAgoS: this.lastRxAt ? Math.round((now - this.lastRxAt) / 1000) : null,
      unansweredCommands: this.strikes,
      reconnects: this.reconnects,
    };
  }

  private currentState(): LinkState {
    if (this.stopped || gate.released) return 'released';
    if (this.unresponsiveSince) return 'unresponsive';
    if (this.contendedSince) return 'contended';
    return this.connected ? 'connected' : 'connecting';
  }

  /** Emit 'health' when the state changes. */
  private publish(): void {
    const state = this.currentState();
    if (state === this.lastState) return;
    this.lastState = state;
    this.stateSince = Date.now();
    this.emit('health', this.health());
  }

  private checkHealth(): void {
    const ws = this.ws;
    if (this.stopped || !ws || !this.connected) return;
    const now = Date.now();
    // A connection that has held: whatever was knocking us off has stopped.
    if (now - this.openedAt >= STABLE_MS && (this.shortDrops.length || this.backoff > 1000)) {
      this.backoff = 1000;
      this.shortDrops = [];
      if (this.contendedSince) {
        this.contendedSince = 0;
        log.info('control is back: the connection has held for 30 s');
        this.publish();
      }
    }
    if (now - this.lastPingAt >= PING_EVERY_MS) {
      this.lastPingAt = now;
      try {
        ws.send('ping');
      } catch {
        /* closing */
      }
    }
    // Nothing at all, not even pong: the socket is dead without a close (half-open TCP).
    if (now - this.lastRxAt > DEAD_SOCKET_MS) {
      log.warn(`no traffic from the telescope for ${Math.round((now - this.lastRxAt) / 1000)} s (not even keepalive replies): dropping the dead connection`);
      wire('!', `dead socket: no traffic for ${Math.round((now - this.lastRxAt) / 1000)} s; terminating`);
      this.strike(true);
      ws.terminate();
      return;
    }
    // Quiet command service: ask it something.
    const quietFor = now - Math.max(this.lastPacketAt, this.openedAt);
    const probeDue = this.unresponsiveSince ? now - this.lastProbeAt >= 15_000 : quietFor >= PROBE_IF_QUIET_MS;
    if (probeDue && !this.probing) void this.probe();
  }

  private async probe(): Promise<void> {
    this.probing = true;
    this.lastProbeAt = Date.now();
    const sent = Date.now();
    try {
      const r = await this.send(PROBE_CMD, {}, { timeout: PROBE_TIMEOUT_MS, bestEffort: true, allowError: true });
      if (r) {
        this.failedProbes = 0;
        return;
      }
      if (this.lastPacketAt >= sent) return;
      this.failedProbes++;
      this.strike(false);
      // While hung, a fresh session every few probes: some stalls are tied to the session.
      if (this.unresponsiveSince && this.failedProbes % 4 === 0 && this.connected) {
        log.info('telescope still not answering: trying a fresh connection');
        this.ws?.terminate();
      }
    } catch {
      /* the socket went away: the close handler takes over */
    } finally {
      this.probing = false;
    }
  }

  /** An unanswered command (or a dead socket). Enough of them with no packet at all: unresponsive. */
  private strike(deadSocket: boolean): void {
    this.strikes++;
    if (this.unresponsiveSince) return;
    const silent = Date.now() - Math.max(this.lastPacketAt, this.everAnswered ? 0 : this.openedAt);
    if ((this.strikes >= STRIKES && silent >= SILENCE_MS) || (deadSocket && this.strikes >= STRIKES)) this.declareUnresponsive();
  }

  private declareUnresponsive(): void {
    this.unresponsiveSince = Date.now();
    this.lastUnresponsiveLog = Date.now();
    this.publish();
    const detail = this.health().detail;
    log.error(`TELESCOPE NOT RESPONDING: ${detail}`);
    wire('!', `NOT RESPONDING: ${detail}`);
    this.failPending(new TelescopeUnresponsiveError(`telescope not responding: ${detail}`));
    this.emit('unresponsive', new TelescopeUnresponsiveError(`telescope not responding: ${detail}`));
  }

  /** Any packet from the command service. */
  private markAlive(): void {
    this.lastPacketAt = Date.now();
    this.everAnswered = true;
    this.strikes = 0;
    this.failedProbes = 0;
    if (this.unresponsiveSince) {
      const mins = Math.round((Date.now() - this.unresponsiveSince) / 60000);
      this.unresponsiveSince = 0;
      log.info(`the telescope is answering commands again (after ${mins} min)`);
      wire('!', `answering again after ${mins} min`);
      this.publish();
      this.emit('responsive');
    }
  }

  // ---------------------------------------------------------------- socket

  private open(): void {
    if (this.stopped) return;
    const url = `ws://${this.host}:${this.port}/`;
    const ws = new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 64 * 1024 * 1024 });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    this.reconnects++;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.openedAt = Date.now();
      this.lastRxAt = Date.now();
      this.lastPingAt = 0;
      log.info(`connected to ${url}`);
      wire('!', `connected to ${url}`);
      this.publish();
      this.emit('connected');
      // A connection is only useful if the command service answers: probe soon, unless the
      // controller's own post-connect queries have already been answered (no duplicate traffic).
      setTimeout(() => {
        if (this.ws === ws && this.connected && !this.probing && this.lastPacketAt < this.openedAt) void this.probe();
      }, 1500);
    });

    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (this.ws !== ws) return;
      this.lastRxAt = Date.now();
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
      const now = Date.now();
      const lived = this.connected && this.openedAt ? now - this.openedAt : 0;
      const wasConnected = this.connected;
      wire('!', `connection closed (${code}) after ${Math.round(lived / 1000)} s`);
      this.teardown(new Error(`connection closed (${code})`));
      if (wasConnected) {
        if (lived < SHORT_MS) this.noteShortDrop(now);
        log.warn(`disconnected (${code}) after ${Math.round(lived / 1000)} s`);
        this.emit('disconnected');
      }
      this.publish();
      this.scheduleReconnect();
    });
  }

  private noteShortDrop(now: number): void {
    this.shortDrops = this.shortDrops.filter((t) => now - t < 180_000);
    this.shortDrops.push(now);
    if (this.shortDrops.length >= 3 && !this.contendedSince) {
      this.contendedSince = now;
      this.publish();
      log.warn(`CONTENDED: ${this.health().detail}`);
      this.emit('contended');
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Under contention every reconnect knocks the other client off (and it us): wait long.
    const delay = this.contendedSince ? 60_000 : this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
      this.publish();
    }, delay);
  }

  private failPending(reason: Error): void {
    for (const queue of this.pending.values()) {
      for (const p of queue) {
        clearTimeout(p.timer);
        p.reject(reason);
      }
    }
    this.pending.clear();
  }

  private teardown(reason: Error): void {
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
    // A transient drop must not fail long operations that the telescope carries on with by itself
    // (a GoTo continues; its notifications arrive on the next connection): best-effort waits end
    // quietly, everything else fails.
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
    this.markAlive();
    if (pkt.type === MessageType.NOTIFICATION) {
      const { name, data } = decodeNotification(pkt.cmd, pkt.data);
      const n: Notification = { cmd: pkt.cmd, name, data, ts: Date.now() };
      wire('~', name, data);
      this.emit('notification', n);
      return;
    }
    const queue = this.pending.get(pkt.cmd);
    const decodedDefault = decodeWith(responseType(pkt.cmd), pkt.data);
    let idx = -1;
    if (queue) {
      idx = queue.findIndex((p) => {
        if (!p.opts.match) return true;
        const d = p.resType ? decodeWith(p.resType, pkt.data) : decodedDefault;
        return p.opts.match(d);
      });
    }
    const p = idx >= 0 ? queue!.splice(idx, 1)[0] : undefined;
    if (queue && queue.length === 0) this.pending.delete(pkt.cmd);
    const decoded = p?.resType ? decodeWith(p.resType, pkt.data) : decodedDefault;
    this.emit('reply', { cmd: pkt.cmd, data: decoded });
    wire('<', `${cmdName(pkt.cmd)}${p ? '' : ' (no request waiting)'}`, decoded);
    if (!p) return;
    clearTimeout(p.timer);
    const code = typeof decoded.code === 'number' ? decoded.code : 0;
    if (code < 0 && !p.opts.allowError && !p.opts.bestEffort) {
      p.reject(new DwarfCommandError(pkt.cmd, code, decoded));
    } else {
      p.resolve(decoded);
    }
  }

  /** Send a command and wait for its reply. Fails at once while the telescope is not responding. */
  async request(cmd: number, params: Record<string, unknown> = {}, opts: RequestOptions = {}): Promise<Record<string, unknown> | null> {
    assertLinked();
    if (this.unresponsiveSince) {
      const now = Date.now();
      if (now - this.lastUnresponsiveLog > 300_000) {
        this.lastUnresponsiveLog = now;
        log.warn(`still not responding: ${this.health().detail}`);
      }
      throw new TelescopeUnresponsiveError(`telescope not responding: ${this.health().detail}`);
    }
    if (this.contendedSince && !this.connected) throw new Error(`telescope not connected: ${this.health().detail}`);
    return this.send(cmd, params, opts);
  }

  private async send(cmd: number, params: Record<string, unknown>, opts: RequestOptions): Promise<Record<string, unknown> | null> {
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
    const sentAt = Date.now();
    wire('>', `${cmdName(cmd)}${opts.bestEffort ? ' [best-effort]' : ''}`, params);
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
          if (q && q.length === 0) this.pending.delete(cmd);
          // A command that should have been answered, with nothing at all from the telescope since:
          // evidence the command service has stopped (best-effort commands often get no reply).
          if (!opts.bestEffort && this.lastPacketAt < sentAt && cmd !== PROBE_CMD) this.strike(false);
          wire('x', `${cmdName(cmd)} no reply in ${Math.round(timeout / 1000)} s${this.lastPacketAt < sentAt ? ' (nothing received since)' : ''}`);
          if (opts.bestEffort) resolve(null);
          else reject(new Error(`command ${cmd} timed out after ${Math.round(timeout / 1000)}s${this.lastPacketAt < sentAt ? ' (nothing at all received from the telescope since it was sent)' : ''}`));
        }, timeout),
      };
      const q = this.pending.get(cmd) ?? [];
      q.push(entry);
      this.pending.set(cmd, q);
      ws.send(packet, (err) => {
        if (err) {
          clearTimeout(entry.timer);
          const qq = this.pending.get(cmd);
          const i = qq ? qq.indexOf(entry) : -1;
          if (qq && i >= 0) qq.splice(i, 1);
          if (opts.bestEffort) resolve(null);
          else reject(err);
        }
      });
    });
  }

  /** Wait for a notification matching `pred`, or time out. Fails early if the telescope stops responding. */
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
      const onDead = (e: Error) => {
        cleanup();
        reject(e);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for telescope`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('notification', onN);
        this.off('unresponsive', onDead);
        signal?.removeEventListener('abort', onAbort);
      };
      this.on('notification', onN);
      this.on('unresponsive', onDead);
      signal?.addEventListener('abort', onAbort);
    });
  }
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + ' UTC';
}
