/**
 * The web UI (public/js) in a simulated browser: index.html in jsdom, the real modules imported as
 * the page imports them, with the server replaced by a fake fetch and fake WebSockets.
 *
 * The modules keep state at module level and register their handlers on import, so one test file
 * boots the UI once (node --test runs each file in its own process).
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

export type Handler = (path: string, init: { method: string; body?: unknown }) => unknown;

export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(d: string): void {
    this.sent.push(d);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** A JSON message from the server, or raw text. */
  push(m: unknown): void {
    this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  }

  /** A binary video frame: [u8 source][f64 ms][JPEG]. */
  frame(source: number, jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])): void {
    const buf = new ArrayBuffer(9 + jpeg.length);
    const v = new DataView(buf);
    v.setUint8(0, source);
    v.setFloat64(1, Date.now(), true);
    new Uint8Array(buf, 9).set(jpeg);
    this.onmessage?.({ data: buf });
  }
}

export const sockets: FakeSocket[] = [];
/** Every API call the page made: "GET captures", "POST control {...}". */
export const calls: Array<{ method: string; path: string; body?: unknown }> = [];
const routes = new Map<string, Handler>();
let confirmAnswer = true;

/** Answer `METHOD path` (path without "api/" and without the query) with what `h` returns; a thrown error is a 400. */
export function route(key: string, h: Handler): void {
  routes.set(key, h);
}
export const answerConfirm = (yes: boolean) => (confirmAnswer = yes);

export const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

export const stateSocket = () => sockets.filter((s) => s.url.endsWith('/ws')).at(-1)!;
export const videoSocket = () => sockets.filter((s) => s.url.endsWith('/ws/video')).at(-1)!;

export interface Ui {
  window: JSDOM['window'];
  document: Document;
  $: (s: string) => HTMLElement;
  setWide(wide: boolean): void;
}

export async function bootUi(opts: { wide?: boolean; storage?: Record<string, string> } = {}): Promise<Ui> {
  const html = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  for (const [k, v] of Object.entries(opts.storage ?? {})) w.localStorage.setItem(k, v);

  let wide = !!opts.wide;
  const mqListeners: Array<() => void> = [];
  Object.assign(w, {
    matchMedia: (media: string) => ({
      media,
      get matches() {
        return wide;
      },
      addEventListener: (_e: string, f: () => void) => mqListeners.push(f),
      removeEventListener: () => {},
    }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    confirm: () => confirmAnswer,
  });
  w.HTMLElement.prototype.setPointerCapture = () => {};
  w.HTMLElement.prototype.releasePointerCapture = () => {};
  if (!w.CSS?.escape) Object.assign(w, { CSS: { escape: (s: string) => s.replace(/["\\\]]/g, '\\$&') } });

  // the markdown renderer the page loads from /vendor/marked.js
  w.eval(fs.readFileSync(new URL('../../node_modules/marked/lib/marked.umd.js', import.meta.url), 'utf8'));

  const fakeFetch = async (input: string, init: { method?: string; body?: string } = {}) => {
    const u = new URL(input, 'http://localhost:8080/');
    const method = init.method ?? 'GET';
    const path = u.pathname.replace(/^\/api\//, '');
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, path: `${path}${u.search}`, body });
    const h = routes.get(`${method} ${path}`);
    if (!h) return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
    try {
      const out = await h(`${path}${u.search}`, { method, body });
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400 });
    }
  };

  // the page's timers never keep the test process alive
  const unref = <F extends (...a: never[]) => NodeJS.Timeout>(f: F) => ((...a: Parameters<F>) => f(...a).unref()) as unknown as F;
  const globals: Record<string, unknown> = {
    window: w,
    document: w.document,
    navigator: w.navigator,
    location: w.location,
    localStorage: w.localStorage,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    CSS: w.CSS,
    FileReader: w.FileReader,
    ResizeObserver: (w as unknown as { ResizeObserver: unknown }).ResizeObserver,
    WebSocket: FakeSocket,
    fetch: fakeFetch,
    confirm: () => confirmAnswer,
    requestAnimationFrame: (f: () => void) => setImmediate(f) as unknown as number,
    cancelAnimationFrame: (id: unknown) => clearImmediate(id as NodeJS.Immediate),
    getComputedStyle: w.getComputedStyle.bind(w),
    setInterval: unref(setInterval),
    setTimeout: unref(setTimeout),
  };
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  Object.defineProperty(w, 'WebSocket', { value: FakeSocket, configurable: true });
  Object.defineProperty(w, 'fetch', { value: fakeFetch, configurable: true });

  await import(new URL('../../public/js/main.js', import.meta.url).href);
  await tick();
  return {
    window: w,
    document: w.document,
    $: (s) => {
      const el = w.document.querySelector(s);
      if (!el) throw new Error(`no element ${s}`);
      return el as HTMLElement;
    },
    setWide: (v) => {
      wide = v;
      for (const f of mqListeners) f();
    },
  };
}
