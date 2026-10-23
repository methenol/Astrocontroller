/**
 * A Seestar on loopback for the driver tests: the JSON-RPC control port (with the firmware 7.18+
 * handshake when a public key is given) and an image port that answers get_stacked_img /
 * get_current_img with whatever frame the test set.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export type Reply = { code?: number; result?: unknown; error?: string } | null;
/** null = no reply (the request times out) */
export type Handler = (params: unknown, scope: FakeSeestar) => Reply | Promise<Reply>;

export function testKeys(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export class FakeSeestar {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly handlers = new Map<string, Handler>();
  /** the image port's reply to get_stacked_img / get_current_img */
  frames: { stacked?: Buffer; preview?: Buffer } = {};
  /** firmware 7.18+: ask for the signed challenge */
  publicPem: string | null = null;
  /** answer get_verify_str with 103 (older firmware) */
  noHandshakeMethod = false;
  /** stop answering test_connection */
  silent = false;
  verified = 0;
  private challenge = '';
  private readonly server = net.createServer((s) => this.serve(s));
  private readonly imageServer = net.createServer((s) => this.serveImages(s));
  private readonly socks = new Set<net.Socket>();

  async listen(): Promise<{ port: number; imagePort: number }> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => this.imageServer.listen(0, '127.0.0.1', r));
    return { port: this.port, imagePort: this.imagePort };
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get imagePort(): number {
    return (this.imageServer.address() as AddressInfo).port;
  }

  get connections(): number {
    return [...this.socks].filter((s) => !s.destroyed && s.localPort === this.port).length;
  }

  on(method: string, h: Handler): this {
    this.handlers.set(method, h);
    return this;
  }

  /** Push an event to every control connection. */
  event(e: Record<string, unknown>): void {
    for (const s of this.socks) if (!s.destroyed && s.localPort === this.port) s.write(`${JSON.stringify({ Timestamp: '1', ...e })}\r\n`);
  }

  /** Drop every connection (the scope rebooted, the tunnel went away). */
  kick(): void {
    for (const s of this.socks) s.destroy();
  }

  async close(): Promise<void> {
    this.kick();
    await Promise.all([new Promise((r) => this.server.close(r)), new Promise((r) => this.imageServer.close(r))]);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method).filter((m) => m !== 'test_connection');
  }

  private track(s: net.Socket): void {
    this.socks.add(s);
    s.on('close', () => this.socks.delete(s));
    s.on('error', () => {});
  }

  private serve(s: net.Socket): void {
    this.track(s);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) void this.answer(s, JSON.parse(line) as { id: number; method: string; params?: unknown });
      }
    });
  }

  private async answer(s: net.Socket, m: { id: number; method: string; params?: unknown }): Promise<void> {
    this.calls.push({ method: m.method, params: m.params });
    const reply = await this.reply(m.method, m.params);
    if (reply === null || s.destroyed) return;
    s.write(`${JSON.stringify({ jsonrpc: '2.0', Timestamp: '1', method: m.method, id: m.id, code: reply.code ?? 0, ...(reply.result !== undefined ? { result: reply.result } : {}), ...(reply.error ? { error: reply.error } : {}) })}\r\n`);
  }

  private async reply(method: string, params: unknown): Promise<Reply> {
    if (method === 'test_connection') return this.silent ? null : { result: 'server connected!' };
    if (method === 'get_verify_str') {
      if (this.noHandshakeMethod) return { code: 103, error: 'method not found' };
      if (!this.publicPem) return { result: { str: '' } };
      this.challenge = crypto.randomBytes(16).toString('hex');
      return { result: { str: this.challenge } };
    }
    if (method === 'verify_client') {
      const p = params as { sign: string; data: string };
      const ok = !!this.publicPem && p.data === this.challenge && crypto.verify('sha1', Buffer.from(p.data), { key: this.publicPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(p.sign, 'base64'));
      if (ok) this.verified++;
      return ok ? { result: 0 } : { code: 109, error: 'verify failed' };
    }
    if (method === 'pi_is_verified') return { result: true };
    const h = this.handlers.get(method);
    return h ? h(params, this) : { result: 0 };
  }

  private serveImages(s: net.Socket): void {
    this.track(s);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl).trim()) as { id: number; method: string };
        buf = buf.slice(nl + 1);
        this.calls.push({ method: `image:${m.method}`, params: undefined });
        s.write(`${JSON.stringify({ id: m.id, method: m.method, code: 0, result: 0 })}\r\n`);
        const f = m.method === 'get_stacked_img' ? this.frames.stacked : m.method === 'get_current_img' ? this.frames.preview : undefined;
        if (f) s.write(f);
      }
    });
  }
}
