/** The server's JSON API (relative to the page, so it works behind a path prefix). */
import { toast } from './dom.js';

/** A WebSocket URL next to the page. */
export const wsUrl = (p) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.replace(/[^/]*$/, '')}${p}`;

/** One path segment, encoded: names and ids may hold any character. */
export const seg = (s) => encodeURIComponent(String(s));

/** A capture's URL: every segment encoded, so a "#" or "?" in a file name stays part of the path. */
export const captureUrl = (p) => `captures/${String(p).split('/').map(encodeURIComponent).join('/')}`;

/** GET without a body, POST with one, or `method`. Throws the server's error message. */
export async function api(path, body, method) {
  const res = await fetch(`api/${path}`, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  const err = data && typeof data === 'object' ? data.error : undefined;
  if (!res.ok || err) throw new Error(typeof err === 'string' && err ? err : err ? JSON.stringify(err) : `HTTP ${res.status}`);
  return data ?? {};
}

/** Runs a telescope control action; toasts the outcome. Resolves undefined when it failed. */
export async function control(body, label) {
  try {
    const r = await api('control', body);
    if (label) toast(typeof r.result === 'string' ? r.result : `${label} ✓`);
    return r;
  } catch (e) {
    toast(`${label ?? body.action}: ${e.message}`, true);
    return undefined;
  }
}

/** The same API call fails silently into a toast: for buttons with nothing else to do on failure. */
export const apiToast = (path, body, method) => api(path, body, method).catch((e) => {
  toast(e.message, true);
  return undefined;
});
