/**
 * A Seestar on loopback for the driver tests: the JSON-RPC control port (with the firmware 7.18+
 * handshake when a public key is given) and the two picture ports (tele 4800, wide 4804) that
 * answer get_stacked_img / get_current_img / begin_streaming with whatever frames the test set.
 *
 * `starSession()` models the firmware's star session: both views run, the selected camera's in
 * ContinuousExposure, the other asleep; a start over a running view is refused (524), a stop
 * ends both; set_setting selected_cam alone swaps nothing.
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

export const S50_PRO = { device: { name: 'S50 Pro', product_model: 'Seestar S50 Pro', focal_len: 260, fnumber: 5.2 }, camera: { chip_size: [2160, 3840], pixel_size_um: 2.9 }, mount: { equ_mode: true, close: false }, focuser: { step: 1000, max_step: 2600 } };

export class FakeSeestar {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly handlers = new Map<string, Handler>();
  /** the picture ports' replies to get_stacked_img / get_current_img, and the frame begin_streaming pushes per camera */
  frames: { stacked?: Buffer; preview?: Buffer; widePreview?: Buffer } = {};
  /** firmware 7.18+: ask for the signed challenge */
  publicPem: string | null = null;
  /** answer get_verify_str with 103 (older firmware) */
  noHandshakeMethod = false;
  /** stop answering test_connection */
  silent = false;
  /** the selected camera's bin (set_camera_bin <int> / get_camera_bin), as the firmware keeps it */
  bin = 1;
  verified = 0;
  /** the settings set_setting merged (what get_setting answers) */
  settings: Record<string, unknown> = { exp_ms: { stack_l: 10_000, continuous: 1000 }, wide_cam: false };
  /** the star session (starSession()): which view is selected and whether it runs */
  session = { selected: 'View', running: false, target: undefined as string | undefined, stage: 'ContinuousExposure' };
  /** how long a view start/stop takes the scope */
  viewDelayMs = 0;
  private challenge = '';
  private readonly server = net.createServer((s) => this.serve(s));
  private readonly imageServer = net.createServer((s) => this.serveImages(s, 'tele'));
  private readonly wideImageServer = net.createServer((s) => this.serveImages(s, 'wide'));
  private readonly socks = new Set<net.Socket>();
  private readonly streaming = new Map<net.Socket, NodeJS.Timeout>();

  async listen(): Promise<{ port: number; imagePort: number; wideImagePort: number }> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => this.imageServer.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => this.wideImageServer.listen(0, '127.0.0.1', r));
    return this.ports;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get imagePort(): number {
    return (this.imageServer.address() as AddressInfo).port;
  }

  get wideImagePort(): number {
    return (this.wideImageServer.address() as AddressInfo).port;
  }

  /** the ports as the driver's `ports` option */
  get ports(): { rpc: number; image: number; wideImage: number } & { port: number; imagePort: number; wideImagePort: number } {
    return { rpc: this.port, image: this.imagePort, wideImage: this.wideImagePort, port: this.port, imagePort: this.imagePort, wideImagePort: this.wideImagePort };
  }

  get connections(): number {
    return [...this.socks].filter((s) => !s.destroyed && s.localPort === this.port).length;
  }

  get imageConnections(): number {
    return [...this.socks].filter((s) => !s.destroyed && (s.localPort === this.imagePort || s.localPort === this.wideImagePort)).length;
  }

  /** which picture sockets are being streamed to */
  get streams(): { tele: boolean; wide: boolean } {
    const on = [...this.streaming.keys()].filter((s) => !s.destroyed);
    return { tele: on.some((s) => s.localPort === this.imagePort), wide: on.some((s) => s.localPort === this.wideImagePort) };
  }

  on(method: string, h: Handler): this {
    this.handlers.set(method, h);
    return this;
  }

  /** The firmware's star session (see the header); `running` starts it as found on connect. */
  starSession(running = true, selected: 'View' | 'SecondView' = 'View'): this {
    this.session = { selected, running, target: undefined, stage: 'ContinuousExposure' };
    const view = (name: 'View' | 'SecondView') => ({
      state: this.session.running ? 'working' : 'cancel',
      mode: 'star',
      cam_id: name === 'View' ? 0 : 1,
      stage: this.session.selected === name ? this.session.stage : 'Sleep',
      ...(name === 'View' && this.session.target ? { target_name: this.session.target } : {}),
    });
    this.on('iscope_get_app_state', () => ({ result: { View: view('View'), SecondView: view('SecondView'), selected_cam: this.session.selected } }));
    this.on('iscope_stop_view', async () => {
      if (this.viewDelayMs) await new Promise((r) => setTimeout(r, this.viewDelayMs));
      this.session.running = false;
      this.session.selected = 'View';
      this.session.stage = 'ContinuousExposure';
      return { result: 0 };
    });
    this.on('iscope_start_view', async (params: unknown) => {
      if (this.session.running) return { code: 524, error: 'function conflict' };
      if (this.viewDelayMs) await new Promise((r) => setTimeout(r, this.viewDelayMs));
      const p = params as { selected_cam?: string; target_name?: string };
      this.session.running = true;
      this.session.selected = p.selected_cam ?? 'View';
      this.session.target = p.target_name;
      return { result: 0 };
    });
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
    for (const t of this.streaming.values()) clearInterval(t);
    this.streaming.clear();
    await Promise.all([new Promise((r) => this.server.close(r)), new Promise((r) => this.imageServer.close(r)), new Promise((r) => this.wideImageServer.close(r))]);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method).filter((m) => m !== 'test_connection' && m !== 'image:test_connection' && m !== 'wide:test_connection');
  }

  /** the view starts so far, with their params */
  viewStarts(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === 'iscope_start_view').map((c) => c.params as Record<string, unknown>);
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
    if (h) return h(params, this);
    if (method === 'get_camera_bin') return { result: this.bin };
    if (method === 'set_camera_bin') {
      if (typeof params !== 'number') return { code: 104, error: 'expected int param' };
      if (params !== 1 && params !== 2) return { code: 204, error: 'out of limit' };
      this.bin = params;
      return { result: 0 };
    }
    if (method === 'get_setting') return { result: this.settings };
    if (method === 'set_setting') {
      const p = (params ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(p)) {
        const old = this.settings[k];
        this.settings[k] = v && typeof v === 'object' && old && typeof old === 'object' && !Array.isArray(v) ? { ...(old as object), ...(v as object) } : v;
      }
      return { result: 0 };
    }
    return { result: 0 };
  }

  private serveImages(s: net.Socket, camera: 'tele' | 'wide'): void {
    this.track(s);
    let buf = '';
    s.setEncoding('utf8');
    const prefix = camera === 'tele' ? 'image' : 'wide';
    s.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl).trim()) as { id: number; method: string };
        buf = buf.slice(nl + 1);
        this.calls.push({ method: `${prefix}:${m.method}`, params: undefined });
        s.write(`${JSON.stringify({ id: m.id, method: m.method, code: 0, result: 0 })}\r\n`);
        // begin_streaming pushes the exposures as they complete, until stop_streaming: here the one
        // frame the test set, every 100 ms
        if (m.method === 'begin_streaming' && !this.streaming.has(s)) {
          this.streaming.set(
            s,
            setInterval(() => {
              const f = camera === 'tele' ? this.frames.preview : this.frames.widePreview;
              if (f && !s.destroyed) s.write(f);
            }, 100),
          );
        } else if (m.method === 'stop_streaming' && this.streaming.has(s)) {
          clearInterval(this.streaming.get(s));
          this.streaming.delete(s);
        }
        const f = m.method === 'get_stacked_img' ? this.frames.stacked : m.method === 'get_current_img' ? (camera === 'tele' ? this.frames.preview : this.frames.widePreview) : undefined;
        if (f) s.write(f);
      }
    });
    s.on('close', () => {
      const t = this.streaming.get(s);
      if (t) clearInterval(t);
      this.streaming.delete(s);
    });
  }
}
