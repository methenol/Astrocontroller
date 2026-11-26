/**
 * The dew heater's Auto mode (on by default). What it holds the heater to:
 *  - Under an observatory roof (Starfront's autonomous nights, WebTelescope.roof) with the roof
 *    status known: the roof decides. Open → on, closed → off.
 *  - Otherwise, parked: off. A parked scope is not in use, and the heater is the biggest drain on a
 *    battery; unparked, the forecast decides again (and turns it back on when dew is possible).
 *  - Otherwise the forecast: any chance of dew this hour or next (weather/dew.ts) → on. Without a
 *    risk it leaves the heater as it is: a heater on and not needed is cheap, one off and needed
 *    loses the night, so the forecast never turns it off. A forecast that cannot be read counts as
 *    a risk.
 * While Auto holds the heater one way, the web UI's switch the other way is refused (turn Auto off
 * first). It runs in the server, like the Rain Guard, so a closed phone does not leave the lens to fog.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { logger, errMsg } from '../log.js';
import { writeFileAtomic } from '../util/fs.js';
import { estop } from '../safety/estop.js';
import { dewRisk, type DewRisk } from '../astro/weather/dew.js';
import type { Forecast } from '../astro/weather/service.js';
import type { Site } from '../astro/sky.js';
import { unitFormat, type Units } from '../util/units.js';
import type { WebTelescope } from './telescope.js';

const log = logger('dew-auto');

/** the switch id both drivers give the dew heater */
export const DEW_SWITCH = 'lens_defog';
export const DEW_POLL_MS = 5 * 60e3;
/** after a failed attempt to turn the heater on, the next comes sooner */
const DEW_RETRY_MS = 60e3;

/** What Auto holds the heater to: on, off, or nothing (leave it as it is), and why. */
export interface DewHold {
  hold: boolean | null;
  /** roof: the observatory roof decides; parked: the scope is parked; forecast: the dew risk decides */
  source: 'roof' | 'parked' | 'forecast';
  reason: string;
}

export interface DewAutoStatus {
  auto: boolean;
  /** the last assessment's hold (null: none, or before the first check) */
  hold: boolean | null;
  source: DewHold['source'] | null;
  reason: string | null;
  lastCheck: string | null;
  /** when Auto last turned the heater on */
  lastTurnedOn: string | null;
  /** when Auto last turned the heater off (the roof closed, the scope parked) */
  lastTurnedOff: string | null;
  lastError: string | null;
}

export interface DewAutoOptions {
  scope: Pick<WebTelescope, 'state' | 'capabilities' | 'switches' | 'label' | 'roof' | 'parked' | 'on' | 'off'>;
  site: () => Site | null;
  tz: () => string;
  forecast: (site: Site, tz: string) => Promise<Forecast>;
  /** where the Auto setting is kept */
  file?: string;
  units?: () => Units;
  /** told whenever Auto switches the heater (the agent's duty log) */
  event?: (text: string) => void;
  now?: () => number;
}

export class DewAuto extends EventEmitter {
  private autoV = true;
  private assessed: DewHold | null = null;
  private lastCheck: number | null = null;
  private lastTurnedOn: number | null = null;
  private lastTurnedOff: number | null = null;
  private lastRoof: boolean | null = null;
  private lastParked: boolean | null = null;
  private stopRoof: (() => void) | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<DewAutoStatus> | null = null;
  private wasConnected = false;
  private readonly now: () => number;
  private readonly onState = (s: { connected?: boolean } | undefined) => {
    const c = !!s?.connected;
    const parked = this.parkedNow();
    // a telescope that has just connected may have come up with its heater off; parking turns it off, unparking may turn it on
    if ((c && !this.wasConnected) || parked !== this.lastParked) void this.check();
    this.wasConnected = c;
  };
  // the roof reports every poll: act on a change only
  private readonly onRoof = () => {
    if ((this.opts.scope.roof?.open() ?? null) !== this.lastRoof) void this.check();
  };

  constructor(private readonly opts: DewAutoOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.load();
  }

  get auto(): boolean {
    return this.autoV;
  }

  /** what Auto holds the heater to now, if anything: the web UI may not switch it the other way */
  holds(): (DewHold & { hold: boolean }) | null {
    const a = this.assessed;
    return this.autoV && a && a.hold !== null ? (a as DewHold & { hold: boolean }) : null;
  }

  start(): void {
    this.wasConnected = !!this.opts.scope.state.connected;
    this.opts.scope.on('state', this.onState);
    this.stopRoof = this.opts.scope.roof?.onChange(this.onRoof) ?? null;
    void this.check();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.opts.scope.off('state', this.onState);
    this.stopRoof?.();
    this.stopRoof = null;
  }

  status(): DewAutoStatus {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const a = this.assessed;
    return { auto: this.autoV, hold: a?.hold ?? null, source: a?.source ?? null, reason: a?.reason ?? null, lastCheck: iso(this.lastCheck), lastTurnedOn: iso(this.lastTurnedOn), lastTurnedOff: iso(this.lastTurnedOff), lastError: this.lastError };
  }

  setAuto(on: boolean): Promise<DewAutoStatus> {
    if (on !== this.autoV) {
      this.autoV = on;
      log.info(`dew heater Auto ${on ? 'on' : 'off'}`);
      this.save();
    }
    return this.check();
  }

  /** Assess the roof or the forecast and, with Auto on, hold the heater to it. One at a time. */
  check(): Promise<DewAutoStatus> {
    this.inFlight ??= this.run().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async assess(): Promise<DewHold> {
    const roof = this.opts.scope.roof?.open() ?? null;
    const parked = this.parkedNow();
    this.lastRoof = roof;
    this.lastParked = parked;
    // Starfront: the roof decides, parked or not (an open roof keeps the heater on through a park)
    if (roof !== null) return { hold: roof, source: 'roof', reason: `the Starfront roof is ${roof ? 'open' : 'closed'}` };
    if (parked) return { hold: false, source: 'parked', reason: 'the scope is parked (not in use)' };
    const r = await this.forecastRisk();
    return { hold: r.risk ? true : null, source: 'forecast', reason: r.reason };
  }

  private parkedNow(): boolean | null {
    return this.opts.scope.parked?.() ?? null;
  }

  private async forecastRisk(): Promise<DewRisk> {
    const site = this.opts.site();
    if (!site) return { risk: true, reason: 'the observer location is unknown, so the forecast cannot be read: on to be safe' };
    try {
      const f = await this.opts.forecast(site, this.opts.tz());
      return dewRisk(f.hours, f.current, this.now(), unitFormat(this.opts.units?.() ?? 'metric'));
    } catch (err) {
      return { risk: true, reason: `the forecast is unavailable (${errMsg(err)}): on to be safe` };
    }
  }

  private async run(): Promise<DewAutoStatus> {
    let retry = false;
    try {
      this.assessed = await this.assess();
      this.lastCheck = this.now();
      this.lastError = null;
      const { hold, reason } = this.assessed;
      if (this.autoV && hold !== null) retry = !(await this.ensure(hold, reason));
    } catch (err) {
      this.lastError = errMsg(err);
      log.warn(`dew heater Auto check failed: ${this.lastError}`);
      retry = true;
    }
    this.schedule(retry ? DEW_RETRY_MS : DEW_POLL_MS);
    return this.changed();
  }

  /** Switch the heater to `on` unless it already is; false when it could not be (and should be tried again soon). */
  private async ensure(on: boolean, reason: string): Promise<boolean> {
    const { scope } = this.opts;
    const sw = scope.capabilities.switches ? scope.switches : undefined;
    // nothing to do now; the next check (or the reconnect) tries again
    if (!sw || !scope.state.connected || scope.state.released || estop.engaged) return true;
    const heater = (await sw.list()).find((s) => s.id === DEW_SWITCH);
    // an unknown state counts as the wrong one
    if (!heater || heater.on === on) return true;
    const word = on ? 'on' : 'off';
    try {
      const r = await sw.set(DEW_SWITCH, on);
      if (on) this.lastTurnedOn = this.now();
      else this.lastTurnedOff = this.now();
      log.info(`dew heater Auto: turned the heater ${word} (${reason}): ${r.result}`);
      this.opts.event?.(`dew heater Auto turned the ${scope.label}'s dew heater ${word} (${reason})`);
      return true;
    } catch (err) {
      this.lastError = `could not turn the dew heater ${word}: ${errMsg(err)}`;
      log.warn(`dew heater Auto: ${this.lastError}`);
      return false;
    }
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), ms);
    this.timer.unref();
  }

  private changed(): DewAutoStatus {
    const s = this.status();
    this.emit('state', s);
    return s;
  }

  private load(): void {
    if (!this.opts.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8')) as { auto?: unknown };
      // anything but an explicit false keeps the default: on
      this.autoV = raw.auto !== false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`ignoring unreadable ${this.opts.file}: ${errMsg(err)}`);
    }
  }

  private save(): void {
    if (!this.opts.file) return;
    try {
      writeFileAtomic(this.opts.file, `${JSON.stringify({ auto: this.autoV }, null, 2)}\n`);
    } catch (err) {
      log.warn(`could not save the dew heater Auto setting: ${errMsg(err)}`);
    }
  }
}
