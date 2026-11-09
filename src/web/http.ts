/** Small helpers shared by the web routes: one error shape, typed request bodies. */
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { errMsg } from '../log.js';
import { EStopError } from '../safety/estop.js';

/** Request bodies up to this many bytes (images sent to the agent from the web UI). */
export const BODY_LIMIT_BYTES = 60 * 1024 * 1024;

/** An error with the HTTP status it should answer with (400 when thrown as a plain Error). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (message: string) => new HttpError(404, message);
export const badRequest = (message: string) => new HttpError(400, message);

/**
 * Wrap an async handler: its return value is sent as JSON (or `{ ok: true }` for undefined) unless
 * the handler already answered (binary bodies); any error becomes `{ error }` with its status.
 */
export const route =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      if (!res.headersSent) res.status(err instanceof HttpError ? err.status : err instanceof EStopError ? 423 : 400).json({ error: errMsg(err) });
    }
  };

/** Parse a request body against a schema; the error names the first offending field. */
export function body<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  const r = schema.safeParse(req.body ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request body');
}

/**
 * Whether a browser request comes from this app's own pages. A request without an Origin header
 * (curl, the MCP client, a same-origin GET) is not a browser acting for another site and passes.
 * Without this check any web page the user visits could open the state socket and prompt the agent,
 * or post a body-less form to an action such as abort or reboot.
 */
export function sameOrigin(origin: string | undefined, hosts: Array<string | undefined>): boolean {
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false; // "null" (sandboxed frames, file://) and anything unparsable
  }
  return hosts.some((h) => !!h && h.split(',')[0].trim().toLowerCase() === host);
}

/** The hosts a request was addressed to: its Host, and the one a reverse proxy forwarded. */
export function requestHosts(req: { headers: Record<string, string | string[] | undefined> }): Array<string | undefined> {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return [one(req.headers.host), one(req.headers['x-forwarded-host'])];
}

/** Refuse state-changing API calls sent by another site's page (see sameOrigin). */
export function rejectCrossSite(req: Request, res: Response, next: () => void): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || sameOrigin(req.headers.origin, requestHosts(req))) return next();
  res.status(403).json({ error: `refused: a request from ${req.headers.origin} (another site) may not control this telescope` });
}

/** A query-string value as a string, or undefined when absent or empty. */
export function queryString(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** A query-string value as a finite number, or undefined. */
export function queryNumber(req: Request, key: string): number | undefined {
  const s = queryString(req, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The last error handler: a body that is not JSON or is too large (the body parser's errors) is
 * answered in the API's own shape — JSON-RPC for /mcp, `{ error }` elsewhere — instead of Express's
 * HTML page with a stack trace.
 */
export function jsonErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
  const raw = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : 500;
  const status = raw >= 400 && raw < 600 ? raw : 500;
  const message = e.type === 'entity.too.large' ? 'request body too large' : e.type === 'entity.parse.failed' ? 'request body is not valid JSON' : status < 500 ? errMsg(err) : 'internal error';
  if (req.path === '/mcp' || req.path.startsWith('/mcp/')) {
    res.status(status).json({ jsonrpc: '2.0', error: { code: e.type === 'entity.parse.failed' ? -32700 : -32600, message }, id: null });
    return;
  }
  res.status(status).json({ error: message });
}
