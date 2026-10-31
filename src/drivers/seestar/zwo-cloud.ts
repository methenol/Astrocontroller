/**
 * The ZWO account's view of its telescopes (api.seestar.com / api-ithings.zwoastro.com): whether the
 * scope is online, occupied by another app, or shooting, before a tunnel session is asked for.
 */
import { config } from '../../config.js';

const LOGIN_URL = 'https://api.seestar.com/v1/user/login';
const DEVICES_URL = 'https://api-ithings.zwoastro.com/v1/my-device';
const TIMEOUT_MS = 45_000;

export const DEVICE_STATUS: Record<number, string> = { 0: 'inactive', 1: 'online', 2: 'offline', 3: 'shooting', 4: 'occupied' };
export const REMOTE_MODE: Record<number, string> = { 0: 'p2p', 1: 'relay', 2: 'lan' };

export interface ZwoDevice {
  serial: string;
  model: string;
  name: string;
  status: string;
  remoteMode: string | null;
  address: string | null;
  timezone: string | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
}

/** the .env account (SEESTAR_USER / SEESTAR_PASSWORD / SEESTAR_COUNTRY) */
export const accountOptions = (): CloudOptions => ({ user: config.seestar.account.user, password: config.seestar.account.password, country: config.seestar.account.country });

export interface CloudOptions {
  user: string;
  password: string;
  country?: string;
  fetch?: typeof fetch;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function headers(country: string, token?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'x-service-platform': 'seestar', 'X-Lang': 'en', country_code: country };
  if (token) {
    h.Authorization = token;
    h['X-Astroimg-Authorization'] = token;
  }
  return h;
}

export async function login(user: string, password: string, fetchFn: typeof fetch = fetch, country = 'US'): Promise<string> {
  const authType = /^\+?\d[\d\s-]{5,}$/.test(user) ? 'mobile' : 'email';
  const res = await fetchFn(LOGIN_URL, { method: 'POST', headers: headers(country), body: JSON.stringify({ authKey: user, password, authType }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = obj(await res.json().catch(() => null));
  const token = str(obj(body?.data)?.accessToken);
  if (!res.ok || !token) throw new Error(`ZWO login failed: HTTP ${res.status} (${str(body?.msg) ?? str(body?.message) ?? 'no token in the reply'})`);
  return token;
}

function items(body: Obj | null): Obj[] {
  const data = body?.data;
  const d = obj(data);
  const list = Array.isArray(data) ? data : (d?.items ?? d?.list ?? d?.records ?? d?.data);
  return Array.isArray(list) ? list.map(obj).filter((x): x is Obj => !!x) : [];
}

function toDevice(raw: Obj): ZwoDevice {
  const serial = str(raw.deviceSn) ?? str(raw.sn) ?? '';
  const model = str(raw.deviceModel) ?? str(raw.model) ?? '';
  const status = num(raw.status);
  const mode = num(raw.remoteMode) ?? num(raw.remote_mode);
  const updated = num(raw.updateTime);
  return {
    serial,
    model,
    name: str(raw.deviceName) ?? str(raw.name) ?? `${model} ${serial}`.trim(),
    status: status === null ? (str(raw.status) ?? 'unknown') : (DEVICE_STATUS[status] ?? `status ${status}`),
    remoteMode: mode === null ? null : (REMOTE_MODE[mode] ?? `mode ${mode}`),
    address: str(raw.ip) ?? str(raw.address) ?? null,
    timezone: str(raw.timezone) ?? str(raw.timeZone) ?? null,
    updatedAt: updated ? new Date(updated * (updated < 1e12 ? 1000 : 1)).toISOString() : null,
    raw,
  };
}

/** The account's telescopes, each merged with its detail record. */
export async function listDevices(o: CloudOptions = accountOptions()): Promise<ZwoDevice[]> {
  if (!o.user || !o.password) throw new Error('SEESTAR_USER and SEESTAR_PASSWORD are not set: no ZWO account to ask');
  const fetchFn = o.fetch ?? fetch;
  const country = o.country ?? 'US';
  const token = await login(o.user, o.password, fetchFn, country);
  const h = headers(country, token);
  const res = await fetchFn(`${DEVICES_URL}?current=1&pageSize=100&isContainShared=1`, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = obj(await res.json().catch(() => null));
  if (!res.ok) throw new Error(`ZWO device list failed: HTTP ${res.status} (${str(body?.msg) ?? 'no detail'})`);
  const out: ZwoDevice[] = [];
  for (const raw of items(body)) {
    const sn = str(raw.deviceSn) ?? str(raw.sn);
    const model = str(raw.deviceModel) ?? str(raw.model);
    let merged = raw;
    if (sn && model) {
      try {
        const dr = await fetchFn(`${DEVICES_URL}/detail?deviceSn=${encodeURIComponent(sn)}&deviceModel=${encodeURIComponent(model)}&onlyQueryOwner=false`, { headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const detail = obj(obj(await dr.json().catch(() => null))?.data);
        if (dr.ok && detail) merged = { ...raw, ...detail };
      } catch {
        /* the list entry is enough */
      }
    }
    out.push(toDevice(merged));
  }
  return out;
}
