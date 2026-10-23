/**
 * The ZWO account API the Seestar app uses, read-only: log in and list the telescopes on the
 * account (owned and shared, which is how a rented Starfront scope appears) with their online
 * state. Allocating the P2P session itself is the tunnel's job (seestar-portfwd), not this module's.
 *
 *   login    POST https://api.seestar.com/v1/user/login            {authKey, password, authType}
 *   devices  GET  https://api-ithings.zwoastro.com/v1/my-device    Authorization: <accessToken>
 *   detail   GET  https://api-ithings.zwoastro.com/v1/my-device/detail?deviceSn&deviceModel
 */
import { config } from '../../config.js';

const API_SEESTAR = 'https://api.seestar.com';
const API_REMOTE = 'https://api-ithings.zwoastro.com';
const TIMEOUT_MS = 45_000;
/** the scope's state on the network */
const DEVICE_STATUS: Record<number, string> = { 0: 'inactive', 1: 'online', 2: 'offline', 3: 'shooting', 4: 'occupied' };
const REMOTE_MODE: Record<number, string> = { 0: 'p2p', 1: 'relay', 2: 'lan' };

export interface ZwoDevice {
  serial: string;
  model: string;
  name: string;
  status: string;
  remoteMode?: string;
  address?: string;
  timezone?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

type Fetch = typeof fetch;

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'x-service-platform': 'seestar', 'X-Lang': 'en', country_code: config.seestar.account.country };
  // the app sends the bare token in both, no "Bearer"
  if (token) h.Authorization = h['X-Astroimg-Authorization'] = token;
  return h;
}

async function call(f: Fetch, url: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 500) } };
  }
}

export async function login(user: string, password: string, f: Fetch = fetch): Promise<string> {
  const authType = /^\+?\d[\d\s-]{5,}$/.test(user) ? 'mobile' : 'email';
  const r = await call(f, `${API_SEESTAR}/v1/user/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ authKey: user, password, authType }) });
  const token = r.body?.data?.accessToken;
  if (r.status !== 200 || typeof token !== 'string') throw new Error(`ZWO login failed: HTTP ${r.status}${r.body?.msg ? ` (${r.body.msg})` : ''}`);
  return token;
}

const page = (data: unknown): Record<string, unknown>[] => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['items', 'list', 'records', 'data']) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
};

function device(d: Record<string, unknown>): ZwoDevice {
  const status = typeof d.deviceStatus === 'number' ? (DEVICE_STATUS[d.deviceStatus] ?? `unknown (${d.deviceStatus})`) : String(d.deviceStatus ?? 'unknown');
  return {
    serial: String(d.deviceSn ?? ''),
    model: String(d.deviceModel ?? ''),
    name: String(d.modelAndSn ?? `${d.deviceModel ?? ''} ${d.deviceSn ?? ''}`.trim()),
    status,
    remoteMode: typeof d.remoteMode === 'number' ? (REMOTE_MODE[d.remoteMode] ?? String(d.remoteMode)) : undefined,
    address: typeof d.address === 'string' ? d.address : undefined,
    timezone: typeof d.timezone === 'string' ? d.timezone : undefined,
    updatedAt: typeof d.updateTime === 'number' && d.updateTime > 0 ? new Date(d.updateTime * 1000).toISOString() : undefined,
    raw: d,
  };
}

/** The telescopes on the account, each with its detail (remote mode) merged in. */
export async function listDevices(o: { user?: string; password?: string; fetch?: Fetch } = {}): Promise<ZwoDevice[]> {
  const user = o.user ?? config.seestar.account.user;
  const password = o.password ?? config.seestar.account.password;
  if (!user || !password) throw new Error('set SEESTAR_USER and SEESTAR_PASSWORD (the ZWO account the telescope is on) to query ZWO Telescope Network');
  const f = o.fetch ?? fetch;
  const token = await login(user, password, f);
  const r = await call(f, `${API_REMOTE}/v1/my-device?current=1&pageSize=100&isContainShared=1`, { headers: headers(token) });
  if (r.status !== 200) throw new Error(`ZWO device list failed: HTTP ${r.status}${r.body?.msg ? ` (${r.body.msg})` : ''}`);
  const devices = page(r.body?.data);
  for (const d of devices) {
    if (!d.deviceSn || !d.deviceModel) continue;
    const q = new URLSearchParams({ deviceSn: String(d.deviceSn), deviceModel: String(d.deviceModel), onlyQueryOwner: 'false' });
    const det = await call(f, `${API_REMOTE}/v1/my-device/detail?${q}`, { headers: headers(token) }).catch(() => null);
    const data = det?.status === 200 ? det.body?.data : null;
    if (data && typeof data === 'object') for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) d[k] = v;
  }
  return devices.map(device);
}
