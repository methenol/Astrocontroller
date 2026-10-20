import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An offline stand-in for the DWARF 3 JSON API (port 8082), for tests: every answer is wrapped as
 * the firmware wraps it ({code, data}); routes are scripted per path; every request is recorded.
 */

export interface HttpRequestSeen {
  method: string;
  path: string;
  body: unknown;
}

type HttpAnswer = { code?: number; data?: unknown; status?: number; raw?: string } | unknown;
export type HttpHandler = (req: HttpRequestSeen) => HttpAnswer | Promise<HttpAnswer>;

/** The shooting modes of fw 1.5.3 that the tests need (ids as the firmware lists them). */
export const SHOOTING_MODES = [
  { id: 1, name: 'Normal', parentId: 0, shootingTechnology: [1, 3, 4, 5].map((id) => ({ id, cameraIds: [0, 1] })) },
  { id: 2, name: 'DSO', parentId: 0, shootingTechnology: [{ id: 2, cameraIds: [0, 1] }] },
  { id: 3, name: 'Planet', parentId: 0, shootingTechnology: [{ id: 4, cameraIds: [0] }] },
  { id: 4, name: 'Moon', parentId: 0, shootingTechnology: [{ id: 4, cameraIds: [0] }] },
  { id: 5, name: 'Sun', parentId: 0, shootingTechnology: [{ id: 4, cameraIds: [0] }] },
];

export class FakeHttpApi {
  private server!: http.Server;
  private routes = new Map<string, HttpHandler>();
  readonly requests: HttpRequestSeen[] = [];
  port = 0;

  constructor() {
    this.route('GET /shootingMode/getSupportedShootingModes', () => ({ data: { shootingModes: SHOOTING_MODES } }));
  }

  /** Script `METHOD /path`; the handler returns (or resolves) {code, data} (code defaults to 0), {status} for an HTTP error, or {raw} for a literal body. */
  route(key: string, h: HttpHandler): this {
    this.routes.set(key, h);
    return this;
  }

  requestsFor(path: string): HttpRequestSeen[] {
    return this.requests.filter((r) => r.path === path);
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const raw = Buffer.concat(chunks).toString();
        let body: unknown = raw;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          /* keep the raw text */
        }
        const path = (req.url ?? '/').split('?')[0];
        const seen = { method: req.method ?? 'GET', path, body };
        this.requests.push(seen);
        const h = this.routes.get(`${seen.method} ${path}`);
        if (!h) {
          res.writeHead(404).end();
          return;
        }
        const out = ((await h(seen)) ?? {}) as { code?: number; data?: unknown; status?: number; raw?: string };
        if (res.destroyed) return;
        if (out.status && out.status !== 200) {
          res.writeHead(out.status).end();
          return;
        }
        if (typeof out.raw === 'string') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(out.raw);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: out.code ?? 0, data: 'data' in out ? out.data : {} }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** The DSO-mode parameter schema as /shootingMode/getParamAndSetting lists it (only what these tests touch). */
export function dsoSchema() {
  const cam = (cameraId: number, base: number) => ({
    cameraId,
    generalParams: [
      { name: 'exp', paramId: String(base + 1), valueType: 1, values: [{ name: '1/2', value: 100 }, { name: '10', value: 150 }, { name: '15', value: 156 }, { name: '30', value: 170 }] },
      { name: 'gain', paramId: String(base + 2), valueType: 1, values: [0, 60, 80, 100] },
    ],
    specialParams: cameraId === 0 ? { filterType: { name: 'filterType', paramId: String(base + 3), valueType: 1, values: [0, 1, 2], currentValue: 0 } } : {},
  });
  return {
    cameraParams: [cam(0, 100), cam(1, 200)],
    shootingTechSettings: [
      { cameraId: 0, generalParams: [{ name: 'stackCount', paramId: '301', valueType: 0, minValue: 1, maxValue: 999 }] },
      { cameraId: 1, generalParams: [{ name: 'stackCount', paramId: '302', valueType: 0, minValue: 1, maxValue: 999 }] },
    ],
  };
}
