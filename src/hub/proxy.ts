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

/** Marks the hub's own "wait" page, so the hub's frame watchdog leaves it to reload itself. */
export const WAIT_PAGE_MARK = 'astro-hub-wait';

/**
 * A page load (the frame, a tab) rather than a script, stylesheet, image or API call. Only a page
 * gets the self-reloading HTML: the same page answered for a module of the app (or an image, or
 * fetch()) is an HTML document where a script or JSON was expected, and a single one of those
 * failing leaves the whole app unbooted: a black frame that never recovers.
 */
export function wantsPage(req: http.IncomingMessage): boolean {
  const dest = req.headers['sec-fetch-dest'];
  if (typeof dest === 'string' && dest) return dest === 'document' || dest === 'iframe';
  return req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');
}

function unavailable(req: http.IncomingMessage, res: http.ServerResponse, status: 502 | 503, name: string, why: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!wantsPage(req)) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' });
    res.end(JSON.stringify({ error: `${name}: ${why}` }));
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="${WAIT_PAGE_MARK}" content="1"><title>${escapeHtml(name)}</title>` +
      `<body style="background:#000;color:#dbe4f0;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center">` +
      `<div><p style="font-size:17px">${escapeHtml(name)}</p><p style="color:#8796ad">${escapeHtml(why)} This page reloads by itself.</p>` +
      `<script>setTimeout(()=>location.reload(),3000)</script></div>`,
  );
}

/** GET and HEAD carry no body and change nothing: one whose connection failed before any answer can be sent again. */
const RETRYABLE = new Set(['GET', 'HEAD', 'OPTIONS']);
const hasBody = (req: http.IncomingMessage): boolean => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

/** Called when a request to a running profile's process failed (after the retry): the hub logs it. */
export type UpstreamFailure = (target: ProxyTarget, req: http.IncomingMessage, rest: string, err: NodeJS.ErrnoException, attempts: number) => void;

/** Proxy one HTTP request; `target` is null for a profile that does not exist. */
export function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, target: ProxyTarget, rest: string, onFailure?: UpstreamFailure): void {
  guard(req);
  guard(res);
  if (!target.running) {
    unavailable(req, res, 503, target.name, target.active ? 'Starting…' : 'This profile is deactivated. Activate it in Profiles.');
    return;
  }
  // The child's connections are pooled (keep-alive). A pooled one the child has just closed fails the
  // next request on it with ECONNRESET before any answer: a request that can be repeated is, once, on
  // a fresh connection, instead of failing a module or an image of a page that is loading.
  const retryable = RETRYABLE.has(req.method ?? '') && !hasBody(req);
  let gone = false;
  let current: http.ClientRequest | null = null;
  // the browser went away (a closed MJPEG view, a cancelled image): stop pulling from the child
  res.on('close', () => {
    if (!res.writableFinished) gone = true;
    current?.destroy();
  });
  const send = (attempt: number): void => {
    let answered = false;
    const up = http.request(
      { host: '127.0.0.1', port: target.port, method: req.method, path: rest, headers: forwardHeaders(req), agent: attempt > 0 ? false : undefined },
      (r) => {
        answered = true;
        const headers = { ...r.headers };
        // a redirect the child answers with an absolute path stays inside its prefix
        const loc = headers.location;
        if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith('//')) {
          const id = splitPrefixed(req.url ?? '')?.id;
          if (id) headers.location = `/p/${id}${loc}`;
        }
        res.writeHead(r.statusCode ?? 502, r.statusMessage, headers);
        r.pipe(res);
      },
    );
    current = up;
    up.on('error', (err: NodeJS.ErrnoException) => {
      if (gone) return; // our own destroy() after the browser left: nobody to answer
      if (!answered && retryable && attempt === 0 && !res.headersSent) return send(1);
      onFailure?.(target, req, rest, err, attempt + 1);
      unavailable(req, res, 502, target.name, `Not answering right now (${err.code ?? err.message}).`);
    });
    if (!retryable) req.pipe(up);
    else {
      up.end();
      if (attempt === 0) req.resume();
    }
  };
  send(0);
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
