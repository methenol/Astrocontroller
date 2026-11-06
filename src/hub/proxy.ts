/**
 * /p/<id>/... → the profile's own process on 127.0.0.1:<port>/... : HTTP (the API, the MJPEG and
 * snapshot streams, the static app) and WebSocket upgrades (the state and video sockets). The
 * browser's Host header is passed on unchanged, so the child's same-origin checks see the address
 * the page was loaded from. The web UI uses page-relative URLs throughout (public/js/api.js), so it
 * works under the prefix as it does at the root.
 */
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { escapeHtml } from './html.js';

export interface ProxyTarget {
  port: number;
  name: string;
  /** the profile is active (its process is wanted) */
  active: boolean;
  running: boolean;
}

/**
 * Every socket the hub touches gets an error listener before anything else: a browser that resets
 * a connection (a closed tab, a phone leaving Wi-Fi, a stale tab's socket being refused) emits
 * ECONNRESET, and an 'error' event without a listener takes the whole hub down, and with it every
 * profile's process.
 */
export function guard(s: { on(e: 'error', f: (e: Error) => void): unknown }): void {
  s.on('error', () => undefined);
}

/** Answer an upgrade we will not proxy, and close the socket. */
export function refuseUpgrade(socket: Duplex, status: string): void {
  guard(socket);
  if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  else socket.destroy();
}

const PREFIX = /^\/p\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/;

/** The profile id and the path in its process, for a URL under /p/. */
export function splitPrefixed(url: string): { id: string; rest: string } | null {
  const q = url.indexOf('?');
  const pathname = q < 0 ? url : url.slice(0, q);
  const m = PREFIX.exec(pathname);
  if (!m) return null;
  return { id: m[1], rest: (m[2] ?? '/') + (q < 0 ? '' : url.slice(q)) };
}

/** Hop-by-hop headers are the connection's, not the request's (RFC 9110 §7.6.1). */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

function forwardHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
  const id = splitPrefixed(req.url ?? '')?.id;
  if (id) out['x-forwarded-prefix'] = `/p/${id}`;
  return out;
}

function unavailable(res: http.ServerResponse, name: string, why: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(name)}</title>` +
      `<body style="background:#000;color:#dbe4f0;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center">` +
      `<div><p style="font-size:17px">${escapeHtml(name)}</p><p style="color:#8796ad">${escapeHtml(why)}</p>` +
      `<script>setTimeout(()=>location.reload(),3000)</script></div>`,
  );
}

/** Proxy one HTTP request; `target` is null for a profile that does not exist. */
export function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, target: ProxyTarget, rest: string): void {
  guard(req);
  guard(res);
  if (!target.running) {
    unavailable(res, target.name, target.active ? 'Starting… this page reloads by itself.' : 'This profile is deactivated. Activate it in Profiles; this page reloads by itself.');
    return;
  }
  const up = http.request({ host: '127.0.0.1', port: target.port, method: req.method, path: rest, headers: forwardHeaders(req) }, (r) => {
    const headers = { ...r.headers };
    // a redirect the child answers with an absolute path stays inside its prefix
    const loc = headers.location;
    if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith('//')) {
      const id = splitPrefixed(req.url ?? '')?.id;
      if (id) headers.location = `/p/${id}${loc}`;
    }
    res.writeHead(r.statusCode ?? 502, r.statusMessage, headers);
    r.pipe(res);
  });
  up.on('error', () => unavailable(res, target.name, 'Starting… this page reloads by itself.'));
  // the browser went away (a closed MJPEG view): stop pulling from the child
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/** Proxy a WebSocket upgrade by splicing the two sockets together after the request line. */
export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: ProxyTarget, rest: string): void {
  guard(socket);
  if (!target.running) {
    refuseUpgrade(socket, '503 Service Unavailable');
    return;
  }
  const up = net.connect({ host: '127.0.0.1', port: target.port });
  let spliced = false;
  // on, never once: a second error on the same socket must find a listener too
  up.on('error', () => {
    if (!spliced) refuseUpgrade(socket, '502 Bad Gateway');
    else socket.destroy();
    up.destroy();
  });
  socket.on('error', () => up.destroy());
  up.once('connect', () => {
    const lines = [`${req.method} ${rest} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    const id = splitPrefixed(req.url ?? '')?.id;
    if (id) lines.push(`X-Forwarded-Prefix: /p/${id}`);
    spliced = true;
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });
}
