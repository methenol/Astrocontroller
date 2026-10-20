import { validHost } from './host.js';
import { withoutCredentials } from '../util/url.js';

/**
 * Typed reads of environment variables. Every problem is collected rather than thrown at the first
 * one, so a misconfigured .env is reported in full at start-up (see Env.check).
 */
export class Env {
  private readonly problems: string[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private raw(name: string): string | undefined {
    const v = this.env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  }

  private bad(name: string, want: string, got: string): void {
    this.problems.push(`${name} must be ${want} (got "${got}")`);
  }

  str(name: string, fallback = ''): string {
    return this.raw(name) ?? fallback;
  }

  /** A number, optionally bounded (inclusive) and whole. */
  num(name: string, fallback: number, o: { min?: number; max?: number; int?: boolean } = {}): number {
    const v = this.optNum(name, o);
    return v ?? fallback;
  }

  optNum(name: string, o: { min?: number; max?: number; int?: boolean } = {}): number | null {
    const v = this.raw(name);
    if (v === undefined) return null;
    const n = Number(v);
    const range = o.min !== undefined && o.max !== undefined ? ` between ${o.min} and ${o.max}` : o.min !== undefined ? ` ≥ ${o.min}` : o.max !== undefined ? ` ≤ ${o.max}` : '';
    const want = `${o.int ? 'a whole number' : 'a number'}${range}`;
    if (!Number.isFinite(n) || (o.int && !Number.isInteger(n)) || (o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) {
      this.bad(name, want, v);
      return null;
    }
    return n;
  }

  port(name: string, fallback: number): number {
    return this.num(name, fallback, { min: 1, max: 65535, int: true });
  }

  bool(name: string, fallback: boolean): boolean {
    const v = this.raw(name)?.toLowerCase();
    if (v === undefined) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    this.bad(name, 'true or false', v);
    return fallback;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    this.bad(name, `one of ${allowed.join(' | ')}`, v);
    return fallback;
  }

  /** An http(s) URL without trailing slashes ('' when unset and allowed). */
  url(name: string, fallback: string): string {
    const v = this.raw(name) ?? fallback;
    if (v === '') return '';
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      // the value is echoed in the start-up error: never with the password it may carry
      this.bad(name, 'an http(s) URL', withoutCredentials(v));
      return fallback.replace(/\/+$/, '');
    }
    return v.replace(/\/+$/, '');
  }

  /** An IP address or host name. */
  host(name: string, fallback: string): string {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    if (validHost(v)) return v;
    this.bad(name, 'an IP address or host name', v);
    return fallback;
  }

  /** An IANA time zone such as Europe/Berlin. */
  timezone(name: string, fallback: string): string {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      return v;
    } catch {
      this.bad(name, 'an IANA time zone such as Europe/Berlin', v);
      return fallback;
    }
  }

  /** Report a problem that spans several variables. */
  report(problem: string): void {
    this.problems.push(problem);
  }

  json(name: string): Record<string, unknown> {
    const v = this.raw(name);
    if (v === undefined) return {};
    try {
      const o: unknown = JSON.parse(v);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      /* reported below */
    }
    this.bad(name, 'a JSON object', v);
    return {};
  }

  /** Throw once with every problem found, if any. */
  check(): void {
    if (this.problems.length) throw new Error(`configuration problems:\n  - ${this.problems.join('\n  - ')}`);
  }
}
