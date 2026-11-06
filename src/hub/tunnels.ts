/**
 * The multi-tunnel manager in the seestar-portfwd container (seestar-portfwd/src/manager.py): one
 * supervisor per ZWO profile, in the profile's slot. The hub asks for a profile's slot before it
 * starts the profile's process, gives it back when the profile is deactivated or removed (the
 * supervisor releases the telescope on its way out), and asks again every minute for every active
 * profile, so a tunnel container that restarted gets its slots back without anyone noticing.
 */
import { errMsg, logger } from '../log.js';
import type { Profile } from './profiles.js';

const log = logger('hub.tunnels');
const TIMEOUT_MS = 5000;

export interface TunnelManagerOptions {
  /** e.g. http://seestar-portfwd:4709; '' = no manager (the tunnel is run some other way) */
  url: string;
  token: string;
  fetchFn?: typeof fetch;
}

export class TunnelManager {
  /** the last problem per profile id, for the profile list */
  private readonly problems = new Map<string, string>();
  private warned = false;

  constructor(private readonly o: TunnelManagerOptions) {}

  get enabled(): boolean {
    return this.o.url !== '';
  }

  problem(id: string): string | null {
    return this.problems.get(id) ?? null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.o.token) h.Authorization = `Bearer ${this.o.token}`;
    return h;
  }

  private async call(method: 'PUT' | 'DELETE', slot: number, body?: unknown): Promise<void> {
    const res = await (this.o.fetchFn ?? fetch)(`${this.o.url}/tunnels/${slot}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(j?.error ?? `HTTP ${res.status}`);
    }
  }

  /** Make the profile's tunnel slot run (a no-op on the manager's side when it already does). */
  async ensure(p: Profile): Promise<void> {
    if (!this.enabled || p.driver !== 'seestar' || !p.seestar.zwo) return;
    // a tunnel the profile runs itself (SEESTAR_TUNNEL_COMMAND) needs no slot
    if (p.env.SEESTAR_TUNNEL_COMMAND) return;
    try {
      await this.call('PUT', p.slot, { user: p.seestar.user, password: p.seestar.password, sn: p.seestar.serial, country: p.seestar.country, legacy: !!p.legacy && p.slot === 0 });
      this.problems.delete(p.id);
      this.warned = false;
    } catch (e) {
      const why = `the ZWO tunnel manager at ${this.o.url} did not take slot ${p.slot}: ${errMsg(e)}`;
      if (this.problems.get(p.id) !== why) log.warn(`${p.name}: ${why}`);
      if (!this.warned) {
        this.warned = true;
        log.warn('is the seestar-portfwd container running with SEESTAR_TUNNEL_MULTI=1 (COMPOSE_PROFILES=seestar)?');
      }
      this.problems.set(p.id, why);
    }
  }

  /** Stop the profile's tunnel slot: its supervisor releases the telescope. */
  async release(p: Profile): Promise<void> {
    this.problems.delete(p.id);
    if (!this.enabled || p.driver !== 'seestar' || !p.seestar.zwo) return;
    try {
      await this.call('DELETE', p.slot);
    } catch (e) {
      log.warn(`${p.name}: could not stop tunnel slot ${p.slot}: ${errMsg(e)}`);
    }
  }
}
