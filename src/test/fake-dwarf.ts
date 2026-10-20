import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { encodePacket, decodePacket, MessageType } from '@alikh/dwarflab-sdk';
import { requestType, responseType, protoTypeByName, decodeWith, NOTIFY, type ProtoType } from '../dwarf/protocol.js';

/**
 * An offline stand-in for the DWARF 3 control service (ws port 9900), for tests.
 *
 * It speaks the real wire format: SDK packet framing, the same protobuf request/response/notify
 * types the controller uses, replies as type 3 with the request's cmd and no request id, text
 * "ping" answered with "pong", one control client at a time (a new connection closes the previous
 * one with 1006-like termination). Behaviour per command is scripted by the test.
 */

export interface ReceivedRequest {
  cmd: number;
  /** the `WsModuleId` ordinal the request was framed with — the device routes on this, not on the cmd alone */
  moduleId: number;
  data: Record<string, unknown>;
  t: number;
}

/** What a handler returns: a reply payload (encoded with the command's response type), or nothing to stay silent. */
export type Reply = Record<string, unknown> | undefined | void;
export type Handler = (req: ReceivedRequest, fake: FakeDwarf) => Reply | Promise<Reply>;

const notifyCmdByName = new Map<string, number>(Object.entries(NOTIFY).map(([cmd, n]) => [n.name, Number(cmd)]));

export class FakeDwarf {
  private wss!: WebSocketServer;
  private client: WebSocket | null = null;
  private handlers = new Map<number, Handler>();
  private waiters: Array<{ cmd: number; resolve: (r: ReceivedRequest) => void; after: number }> = [];
  readonly requests: ReceivedRequest[] = [];
  port = 0;
  connections = 0;
  /** delay before every reply and notification reaches the client (ms) */
  latencyMs = 0;
  /** the command service has hung: binary requests are swallowed, pings still answered */
  hung = false;
  /** unhandled commands reply {code: 0} (true) or get no reply (false) */
  replyByDefault = true;

  async start(): Promise<this> {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => this.wss.once('listening', () => resolve()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (ws) => {
      this.connections++;
      // one controller at a time, newest wins
      this.client?.terminate();
      this.client = ws;
      ws.on('message', (raw: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          if (raw.toString() === 'ping') ws.send('pong');
          return;
        }
        if (this.hung) return;
        void this.handle(ws, new Uint8Array(raw));
      });
      ws.on('close', () => {
        if (this.client === ws) this.client = null;
      });
    });
    return this;
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  get connected(): boolean {
    return !!this.client && this.client.readyState === this.client.OPEN;
  }

  /** Script a command. Replaces any earlier handler for it. */
  on(cmd: number, handler: Handler): this {
    this.handlers.set(cmd, handler);
    return this;
  }

  /** Reply to a command with a fixed payload every time. */
  reply(cmd: number, payload: Record<string, unknown>): this {
    return this.on(cmd, () => payload);
  }

  /** Never answer a command (the firmware does this for several). */
  silent(cmd: number): this {
    return this.on(cmd, () => undefined);
  }

  /** Send a notification by name (as in protocol.ts NOTIFY) or cmd number. */
  async notify(which: string | number, data: Record<string, unknown>): Promise<void> {
    const cmd = typeof which === 'number' ? which : notifyCmdByName.get(which);
    if (cmd === undefined) throw new Error(`unknown notification ${which}`);
    // The hand table names most notifications; anything outside it (attitude, the device switches) is
    // encoded with the payload the APK's catalogue declares for that id, which is what the device sends.
    const ref = cmd in NOTIFY ? NOTIFY[cmd]?.type : undefined;
    const payload = cmd in NOTIFY ? (ref ? encode(protoTypeByName(ref), data) : new Uint8Array(0)) : encode(responseType(cmd), data);
    await this.deliver(encodePacket(cmd, MessageType.NOTIFICATION, payload, 'dwarf', 1));
  }

  /** Send a reply packet that answers no request (late replies, duplicates). */
  async unsolicitedReply(cmd: number, payload: Record<string, unknown>, resType?: ProtoType): Promise<void> {
    await this.deliver(encodePacket(cmd, MessageType.REPLY, encode(resType ?? responseType(cmd), payload), 'dwarf', 1));
  }

  /** Send arbitrary bytes as one binary frame (malformed packets). */
  async sendRaw(bytes: Uint8Array): Promise<void> {
    await this.deliver(bytes);
  }

  /** Drop the client's socket without a close handshake (Wi-Fi loss, firmware reboot). */
  dropClient(): void {
    this.client?.terminate();
    this.client = null;
  }

  /** Resolve with the next request for `cmd` (or the earliest one received since `since`). */
  nextRequest(cmd: number, timeoutMs = 5000, since = 0): Promise<ReceivedRequest> {
    const seen = this.requests.find((r) => r.cmd === cmd && r.t >= since);
    if (seen && since) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { cmd, resolve: (r: ReceivedRequest) => (clearTimeout(timer), resolve(r)), after: Date.now() };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`fake telescope: no request ${cmd} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  requestsFor(cmd: number): ReceivedRequest[] {
    return this.requests.filter((r) => r.cmd === cmd);
  }

  private async handle(ws: WebSocket, bytes: Uint8Array): Promise<void> {
    const pkt = decodePacket(bytes);
    const req: ReceivedRequest = { cmd: pkt.cmd, moduleId: pkt.moduleId, data: decodeWith(requestType(pkt.cmd), pkt.data), t: Date.now() };
    this.requests.push(req);
    for (const w of [...this.waiters]) {
      if (w.cmd === req.cmd) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(req);
      }
    }
    const h = this.handlers.get(pkt.cmd);
    // A command the APK declares no response payload for gets no reply, which is what the device owes
    // it; a test that scripts a payload for one still goes through `encode` and fails loudly there.
    const out = h ? await h(req, this) : this.replyByDefault && responseType(pkt.cmd) ? { code: 0 } : undefined;
    if (!out || this.hung || ws !== this.client) return;
    await this.deliver(encodePacket(pkt.cmd, MessageType.REPLY, encode(responseType(pkt.cmd), out), 'dwarf', 1), ws);
  }

  private async deliver(packet: Uint8Array, ws: WebSocket | null = this.client): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (!ws || ws.readyState !== ws.OPEN) return;
    await new Promise<void>((resolve) => ws.send(packet, () => resolve()));
  }
}

function encode(type: ProtoType | undefined, data: Record<string, unknown>): Uint8Array {
  if (!type) {
    if (Object.keys(data).length) throw new Error(`fake telescope: no proto type to encode ${JSON.stringify(data)}`);
    return new Uint8Array(0);
  }
  const t = type as ProtoType & { fromObject?(o: unknown): unknown };
  return type.encode(t.fromObject ? t.fromObject(data) : type.create(data)).finish();
}
