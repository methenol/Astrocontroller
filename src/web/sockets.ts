/**
 * The two WebSockets the UI keeps open: /ws carries state, agent events, logs and jobs as JSON;
 * /ws/video carries live frames as binary messages [u8 source][f64 capture time ms][JPEG], which
 * reconnects by itself and needs no extra HTTP connections, unlike <img> MJPEG streams.
 */
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import sharp from 'sharp';
import { config } from '../config.js';
import { errMsg, logBus, recentLogs, logger } from '../log.js';
import * as library from '../library/transfer.js';
import * as processing from '../processing/queue.js';
import { toolEvents } from '../mcp/tools.js';
import { PromptBody, promptMode } from './routes/agent.js';
import { publicConfig, type WebContext } from './context.js';
import { requestHosts, sameOrigin } from './http.js';
import { toJson } from '../util/json.js';
import type { RainGuard } from '../astro/weather/guard.js';

const log = logger('web');

/** Journal changes reach the UI at most this often per night. */
const JOURNAL_PUSH_MS = 4_000;
const VIDEO_SOURCES = ['tele', 'wide', 'stack'] as const;
/** A client this far behind skips frames instead of queueing them. */
const VIDEO_BACKLOG_BYTES = 1_500_000;
/** A state client this far behind (a stalled phone) is dropped; it reconnects and gets a fresh hello. */
const STATE_BACKLOG_BYTES = 16 * 1024 * 1024;
/** Largest message a client may send: a prompt with its images, and a subscribe message. */
const STATE_MAX_PAYLOAD = 80 * 1024 * 1024;
const VIDEO_MAX_PAYLOAD = 4096;
const PING_MS = 15000;
const STREAM_STATUS_MS = 2000;
/** Notifications too frequent and too dull for the UI. */
const QUIET_NOTIFICATIONS = new Set(['temperature', 'cmosTemperature', 'intParam', 'systemResourceState']);

export interface Sockets {
  broadcast(msg: unknown): void;
  /** Stop timers and listeners and close every client. */
  close(): void;
}

/** Create the socket servers on `server` and return the broadcaster; `ctx.broadcast` may call it later. */
export function mountSockets(server: http.Server, ctx: Omit<WebContext, 'broadcast'>, guard?: RainGuard): Sockets {
  const { scope, agent, duty } = ctx;
  const hub = scope.hub;
  const wss = new WebSocketServer({ noServer: true, maxPayload: STATE_MAX_PAYLOAD });
  const videoWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: VIDEO_MAX_PAYLOAD });

  const onUpgrade = (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    // browsers do not apply CORS to WebSockets: without this any page could drive the agent
    if (!sameOrigin(req.headers.origin, requestHosts(req))) {
      log.warn(`refused a WebSocket from ${req.headers.origin} (another site)`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (p === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else if (p === '/ws/video') videoWss.handleUpgrade(req, socket, head, (ws) => videoWss.emit('connection', ws, req));
    else socket.destroy();
  };
  server.on('upgrade', onUpgrade);

  // ---- video
  // One small copy per frame, shared by every viewer: the longest side fits LIVE_STREAM_WIDTH (a
  // portrait Seestar frame, 1080×1920, would pass a width-only limit of 1280 untouched).
  const small = new WeakMap<Buffer, Promise<Buffer>>();
  const smallCopy = (jpeg: Buffer): Promise<Buffer> => {
    let p = small.get(jpeg);
    if (!p) {
      const side = config.web.liveWidth;
      p = sharp(jpeg, { failOn: 'none' })
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
        .jpeg({ quality: 78, mozjpeg: false })
        .toBuffer();
      small.set(jpeg, p);
    }
    return p;
  };
  videoWss.on('connection', (ws) => {
    const subs = new Map<string, () => void>();
    const busy = new Set<number>();
    const sendFrame = (idx: number) => (f: { jpeg: Buffer; at: number }) => {
      // Slow client or a resize still in flight: skip this frame rather than queue it.
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount > VIDEO_BACKLOG_BYTES || busy.has(idx)) return;
      busy.add(idx);
      smallCopy(f.jpeg)
        .then((small) => {
          if (ws.readyState !== ws.OPEN) return;
          const header = Buffer.alloc(9);
          header.writeUInt8(idx, 0);
          header.writeDoubleLE(f.at, 1);
          ws.send(Buffer.concat([header, small]), { binary: true });
        })
        .catch((e) => log.debug(`video frame dropped: ${errMsg(e)}`))
        .finally(() => busy.delete(idx));
    };
    ws.on('message', (raw) => {
      let m: { type?: unknown; sources?: unknown; main?: unknown };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.type !== 'subscribe' || !Array.isArray(m.sources)) return;
      const want = new Set<string>(m.sources.filter((x): x is string => typeof x === 'string' && (VIDEO_SOURCES as readonly string[]).includes(x)));
      // `main` is the source in this viewer's main view: a telescope that streams one camera at a
      // time (the Seestar) selects that one, not whichever thumbnail is also on screen
      for (const name of VIDEO_SOURCES) hub.get(name).setPrimary(ws, want.has(name) && m.main === name);
      for (const [name, unsub] of subs) {
        if (want.has(name)) continue;
        unsub();
        subs.delete(name);
      }
      for (const name of want) {
        if (subs.has(name)) continue;
        try {
          subs.set(name, hub.get(name).subscribe(sendFrame(VIDEO_SOURCES.indexOf(name as (typeof VIDEO_SOURCES)[number]))));
        } catch (e) {
          log.debug(`video subscribe ${name}: ${errMsg(e)}`);
        }
      }
    });
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), PING_MS);
    ws.on('close', () => {
      clearInterval(ping);
      for (const unsub of subs.values()) unsub();
      subs.clear();
      for (const name of VIDEO_SOURCES) hub.get(name).setPrimary(ws, false);
    });
    ws.on('error', (e) => log.debug(`video socket: ${errMsg(e)}`));
  });

  // ---- state
  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    if (!clients.size) return;
    const data = toJson(msg);
    for (const c of clients) {
      if (c.readyState !== c.OPEN) continue;
      if (c.bufferedAmount > STATE_BACKLOG_BYTES) {
        log.debug('dropping a state client that stopped reading');
        c.terminate();
        continue;
      }
      c.send(data);
    }
  };
  const reply = (ws: WebSocket, msg: unknown) => ws.readyState === ws.OPEN && ws.send(toJson(msg));

  wss.on('connection', (ws) => {
    clients.add(ws);
    reply(ws, {
      type: 'hello',
      telescope: scope.state,
      agent: agent.status(),
      duty: duty.status(),
      history: agent.history,
      jobs: library.listJobs(),
      processing: processing.listItems(30),
      logs: recentLogs(150),
      config: publicConfig(scope),
      guard: guard?.status(),
    });
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), PING_MS);
    ws.on('close', () => {
      clearInterval(ping);
      clients.delete(ws);
    });
    ws.on('error', (e) => log.debug(`state socket: ${errMsg(e)}`));
    ws.on('message', async (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m?.type === 'prompt') {
          const p = PromptBody.safeParse(m);
          if (!p.success) throw new Error(p.error.issues[0] ? `${p.error.issues[0].path.join('.') || 'prompt'}: ${p.error.issues[0].message}` : 'invalid prompt');
          await agent.prompt(p.data.text, p.data.images ?? [], promptMode(p.data.mode));
        } else if (m?.type === 'abort') {
          // an interrupt ends the agent's turn only: a running duty carries on
          await agent.abort();
        }
      } catch (err) {
        reply(ws, { type: 'error', message: errMsg(err) });
      }
    });
  });

  // ---- what goes out to every client
  const offs: Array<() => void> = [];
  const on = <A extends unknown[]>(em: { on(e: string, f: (...a: A) => void): unknown; off(e: string, f: (...a: A) => void): unknown }, ev: string, f: (...a: A) => void) => {
    em.on(ev, f);
    offs.push(() => em.off(ev, f));
  };
  on(scope, 'state', (s: unknown) => broadcast({ type: 'telescope', state: s }));
  on(scope, 'notification', (n: { name: string; data: unknown; ts: number }) => {
    if (!QUIET_NOTIFICATIONS.has(n.name)) broadcast({ type: 'notify', name: n.name, data: n.data, ts: n.ts });
  });
  on(agent, 'event', (e: unknown) => broadcast({ type: 'agent', event: e }));
  on(agent, 'status', (s: unknown) => broadcast({ type: 'agentStatus', status: s }));
  on(duty, 'state', (d: unknown) => broadcast({ type: 'duty', duty: d }));
  on(logBus, 'log', (l: unknown) => broadcast({ type: 'log', entry: l }));
  on(library.jobBus, 'job', (j: unknown) => broadcast({ type: 'job', job: j }));
  on(processing.processingBus, 'item', (it: unknown) => broadcast({ type: 'processing', item: it }));
  on(toolEvents, 'image', (i: object) => broadcast({ type: 'capture', ...i }));
  on(toolEvents, 'stellarium', (t: object) => broadcast({ type: 'stellarium', ...t }));
  // the Plan and Journal tabs reload on these (the journal changes with every frame: at most every few seconds per night)
  const night = ctx.night;
  if (night) {
    on(night.plan, 'plan', (p: { night: string; generatedAt: number }) => broadcast({ type: 'plan', night: p.night, generatedAt: p.generatedAt }));
    on(night.plan, 'holds', () => broadcast({ type: 'plan', holds: true }));
    const sent = new Map<string, number>();
    const pending = new Set<string>();
    on(night.journal, 'change', (k: string) => {
      const last = sent.get(k) ?? 0;
      if (Date.now() - last >= JOURNAL_PUSH_MS) {
        sent.set(k, Date.now());
        broadcast({ type: 'journal', night: k });
      } else if (!pending.has(k)) {
        pending.add(k);
        setTimeout(() => {
          pending.delete(k);
          sent.set(k, Date.now());
          broadcast({ type: 'journal', night: k });
        }, JOURNAL_PUSH_MS).unref();
      }
    });
  }
  // every check is sent, changed or not: a page that stops hearing from the guard knows to worry
  if (guard) on(guard, 'state', (g: unknown) => broadcast({ type: 'guard', guard: g }));
  // Frame freshness per stream, so the UI can show a stalled view instead of a frozen-looking one.
  const streamTimer = setInterval(() => broadcast({ type: 'streams', streams: hub.status(), now: Date.now() }), STREAM_STATUS_MS);
  streamTimer.unref();

  return {
    broadcast,
    close() {
      clearInterval(streamTimer);
      for (const off of offs) off();
      server.off('upgrade', onUpgrade);
      for (const c of [...clients, ...videoWss.clients]) c.terminate();
      wss.close();
      videoWss.close();
    },
  };
}
