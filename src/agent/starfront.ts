/**
 * Autonomous nights at Starfront Observatories: left on for days or weeks, it puts the agent on a
 * night's duty whenever the roof over the scope opens, and lets it rest otherwise.
 *
 * - The roof: Starfront's own roof API (the one status.starfront.space reads), polled every
 *   STARFRONT_POLL_S. STARFRONT_BUILDING names the building the scope is in; without it any open
 *   roof counts, and the telescope confirms its own (below).
 * Between its phases the scope is parked and disconnected, so nothing holds it (or its single ZWO
 * session) while there is nothing to do; the agent connects when it needs it (5–10 min over ZWO).
 *
 * - Roof opens after sunset but before dark: the agent is woken to verify it (connect, raise the
 *   arm, look with the wide camera, report with starfront_roof), then parks and disconnects.
 * - STARFRONT_CONNECT_LEAD_MIN before the night plan's start (dark), with the roof open (or seen
 *   open): a duty starts until astronomical dawn with the night's objective (connect, then carry out
 *   the night plan). A roof that opens later starts it at once. The duty's END wake at dawn stops
 *   and parks (the driver's close-out); the night is transferred when the roof closes (below).
 * - The roof closes during the night: the agent is told at once (stop stacking, park, transfer,
 *   disconnect once the transfers have finished); it reopens: told again (connect, carry on).
 * - The roof status is authoritative: a roof reported closed is never checked with the telescope.
 *   Only at STARFRONT_ROOF_CHECK_TIME (19:00) with no status at all (roof API unreachable) is it
 *   checked the same way (connect, look, report, park, disconnect); open starts the night's duty at its time.
 *
 * These wakes are orders (duty.order): steps of a mode the owner turned on, which the agent carries
 * out even off duty.
 * - Nothing is transferred while the roof is open: Starfront asks that files are transferred once
 *   the night is done, to leave the bandwidth to those still imaging. Every session waits on the
 *   card until the roof closes, then they all go (processing queues itself after each). A night
 *   whose roof is still open at dawn is transferred when it closes in the morning (transferHold
 *   refuses the agent's transfers until then).
 *
 * A night is started once; a user's own duty is never replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, type ObserverLocation } from '../config.js';
import { errMsg, logger } from '../log.js';
import * as sky from '../astro/sky.js';
import { writeFileAtomic } from '../util/fs.js';
import { SafeEmitter } from '../util/events.js';
import type { DutyLoop } from './duty.js';

const log = logger('starfront');

export interface Roof {
  device_number: number;
  name: string;
  is_open: boolean;
  state_update?: string;
}

export const NIGHT_OBJECTIVE = [
  "Autonomous Starfront night: the roof is open. Carry out tonight's night plan (the owner's program, scheduled: night_plan) until astronomical dawn, maximising collection quality and integration time. A target that is not centred, is not at the absolute best focus, or is collected with incorrect settings (exposure, gain, filter) is unusable and a complete waste of collection. The target procedure (P3) is how quality is collected: run every step of it on every target; time spent on its steps is never lost time.",
  '1. If the scope is disconnected: seestar_connect (over ZWO Telescope Network this can take 5–10 min: end your turn with duty next_check in_s=120; you are woken when it is connected). Then seestar_status; open_arm if parked. If the roof was not verified with the telescope tonight and the building is not known, first confirm the sky with view_camera camera=wide pointed up and report it with starfront_roof.',
  "2. Before the plan starts (astronomical dark): get ready; nothing is stacked before then. Each sample's night plan line says what comes first.",
  "3. From the plan's start: run P3 on the plan's target, every step in order (settings, goto_target, autofocus, star_focus, start_stacking, then its checks on the first subs), and move to the next block's target when the plan moves on. Blocked or clouded: night_plan action=obscured target=<name> cause=obstruction|cloud and take the target it gives. Do not transfer while the roof is open (Starfront keeps the bandwidth for those imaging): every session waits on the card until the roof closes.",
  "4. If you are told the roof closed: stop_stacking and park at once; transfer tonight's sessions not yet in the library (list_device_sessions, transfer_session); when their finished events arrive, seestar_disconnect. Then wait (duty next_check 900). When it reopens: seestar_connect, open_arm, carry on from step 3 (night_plan action=now).",
  "5. At astronomical dawn the duty ends: stop stacking and park. If the roof has already closed, transfer the night's sessions not yet transferred and, once those transfers have finished, seestar_disconnect; if it is still open, wait: you are woken to transfer when it closes.",
].join('\n');

/** How the agent looks at the roof: connect, raise the arm, look up with the wide camera. */
const LOOK = 'seestar_connect if the scope is disconnected (over ZWO this can take 5–10 min: end your turn; you are woken when it is connected), then open_arm, move_motors altitude_deg=70, view_camera camera=wide (and sky_check).';

/** The roof reports open before dark: look, report, then leave the scope parked and disconnected until the night's duty. */
export const VERIFY_PROMPT = (time: string, duty: string) =>
  `Starfront roof opened (${time}), before dark. Verify it with the telescope: ${LOOK} Report what you saw with starfront_roof action=report open=true|false. Then park, and seestar_disconnect. Tonight's duty starts at ${duty}, when you are woken to connect again.`;

export const ROOF_CHECK_PROMPT = (time: string, duty?: string) =>
  `Starfront roof check (${time}): there is no roof status. Check the roof over the scope with the telescope: ${LOOK.replace('then open_arm', 'then open_arm')} Open sky (a twilight gradient, or a recognisable star field) = open; a dark ceiling, rafters, the inside of the building, or a dark frame with only noise or hot pixels (counted as "stars" under a closed roof) = closed; when in doubt, closed. Report it with starfront_roof action=report open=true|false. Then park, and seestar_disconnect. Open starts tonight's imaging duty${duty ? ` (at ${duty})` : ''}, when you are woken to connect again.`;

export const ROOF_CLOSING_ORDER =
  "the Starfront roof is CLOSING: stop_stacking and park NOW. Then transfer tonight's sessions not yet in the library (list_device_sessions, transfer_session), and when their finished events arrive, seestar_disconnect. Wait for the roof to reopen (duty next_check in_s=900); its reopening wakes you.";
/** The night is over and the roof has closed: the whole night goes into the library. */
export const ROOF_CLOSED_TRANSFER_ORDER = (night: string) =>
  `the Starfront roof has closed after the night of ${night}: park if the scope is not parked, then transfer the whole night. seestar_connect first if the scope is disconnected (5–10 min over ZWO; you are woken when it is connected), then list_device_sessions and transfer_session for every session not yet in the library (processing queues itself after each). When all their finished events have arrived (check jobs), seestar_disconnect.`;

/** Once the night is over, how long a roof with no status at all is waited for before the transfer goes ahead anyway. */
const NO_STATUS_GRACE_MS = 2 * 3600_000;

export const ROOF_REOPENED_ORDER =
  'the Starfront roof has REOPENED: seestar_connect if the scope is disconnected (5–10 min over ZWO; you are woken when it is connected), open_arm, then carry on with the night plan (night_plan action=now).';

interface NightRecord {
  /** the duty was started, and why */
  engagedAt?: number;
  engagedBy?: string;
  /** the telescope roof check was asked for */
  checkedAt?: number;
  /** the roof opened before dark: the agent was asked to verify it with the telescope */
  verifyAskedAt?: number;
  checkResult?: 'open' | 'closed';
  /** the night's duty ran and its roof has not been seen closed since its end: the transfer waits for it */
  transferDue?: boolean;
  /** the transfer at the roof's closing (after the night) was ordered */
  transferAskedAt?: number;
}

interface Persisted {
  enabled: boolean;
  /** buildings the scope may be in, learned from the telescope's roof checks (when STARFRONT_BUILDING is unset) */
  candidates?: number[];
  nights: Record<string, NightRecord>;
}

export interface StarfrontStatus {
  available: boolean;
  enabled: boolean;
  building: number | null;
  candidates: number[] | null;
  roof: 'open' | 'closed' | 'unknown';
  roofAt: number | null;
  roofError: string | null;
  night: string;
  window: { sunset: string | null; astroDusk: string | null; astroDawn: string | null };
  /** when the night's duty starts (the plan's start less the connect lead) */
  dutyAt: string | null;
  phase: string;
  tonight: NightRecord;
}

export interface StarfrontDeps {
  duty: Pick<DutyLoop, 'start' | 'event' | 'order' | 'status'>;
  /** the night plan's start (dark), ms; the duty starts the connect lead before it */
  planStart?: () => number | null;
  connectLeadMin?: number;
  site: () => ObserverLocation;
  fetchRoofs?: () => Promise<Roof[]>;
  now?: () => number;
  file?: string;
  building?: number;
  checkTime?: string;
  pollS?: number;
}

async function fetchRoofs(): Promise<Roof[]> {
  const res = await fetch(config.starfront.roofUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`roof status HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('roof status is not a list');
  return body.filter((r): r is Roof => !!r && typeof r === 'object' && typeof (r as Roof).device_number === 'number' && typeof (r as Roof).is_open === 'boolean');
}

/** "HH:MM" in the observer's zone, now. */
function localHm(at: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: config.observer.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

export class StarfrontNights extends SafeEmitter {
  private st: Persisted;
  private timer: NodeJS.Timeout | null = null;
  private roofs: Roof[] | null = null;
  private roofAt: number | null = null;
  private roofError: string | null = null;
  private wasOpen: boolean | null = null;
  private readonly now: () => number;
  private readonly file: string;

  constructor(private readonly d: StarfrontDeps) {
    super();
    this.now = d.now ?? Date.now;
    this.file = d.file ?? path.join(config.paths.data, 'starfront.json');
    this.st = this.load();
  }

  private get building(): number {
    return this.d.building ?? config.starfront.building;
  }

  private load(): Persisted {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Persisted;
      return { enabled: !!v.enabled, candidates: v.candidates, nights: v.nights ?? {} };
    } catch {
      return { enabled: false, nights: {} };
    }
  }

  private save(): void {
    // a fortnight of nights is plenty for the record
    const keys = Object.keys(this.st.nights).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete this.st.nights[k];
    try {
      writeFileAtomic(this.file, JSON.stringify(this.st, null, 2));
    } catch (e) {
      log.warn(`could not save ${this.file}: ${errMsg(e)}`);
    }
    this.emit('status', this.status());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), (this.d.pollS ?? config.starfront.pollS) * 1000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** the owner has the mode on */
  get enabled(): boolean {
    return this.st.enabled;
  }

  setEnabled(on: boolean): StarfrontStatus {
    this.st.enabled = on;
    log.info(`autonomous Starfront nights ${on ? 'enabled' : 'disabled'}`);
    this.save();
    if (on) void this.tick();
    return this.status();
  }

  /** The night a moment belongs to: the local date of its sunset. */
  private nightOf(at: number): { key: string; w: ReturnType<typeof sky.nightWindow> } {
    const w = sky.nightWindow(this.d.site(), new Date(at));
    const ref = w.sunset ?? w.darkStart ?? new Date(at);
    return { key: sky.localDate(ref, config.observer.timezone), w };
  }

  /** When the night's duty starts: the plan's start (else astronomical dusk) less the connect lead. */
  private dutyAt(w: ReturnType<typeof sky.nightWindow>): number | null {
    const start = this.d.planStart?.() ?? w.astroDusk?.getTime() ?? w.darkStart?.getTime() ?? null;
    return start === null ? null : start - (this.d.connectLeadMin ?? config.starfront.connectLeadMin) * 60_000;
  }

  /** Our roof as the API reports it: the building's, or (unknown building) any of the candidates'. */
  roofOpen(): boolean | null {
    if (!this.roofs) return null;
    if (this.building) {
      const r = this.roofs.find((x) => x.device_number === this.building);
      return r ? r.is_open : null;
    }
    const cands = this.st.candidates ?? this.roofs.map((r) => r.device_number);
    const mine = this.roofs.filter((r) => cands.includes(r.device_number));
    return mine.length ? mine.some((r) => r.is_open) : null;
  }

  async tick(): Promise<void> {
    try {
      this.roofs = await (this.d.fetchRoofs ?? fetchRoofs)();
      this.roofAt = this.now();
      this.roofError = null;
    } catch (e) {
      this.roofError = errMsg(e);
      log.debug(`roof status: ${this.roofError}`);
    }
    if (!this.st.enabled) return;
    const now = this.now();
    const { key, w } = this.nightOf(now);
    const night = (this.st.nights[key] ??= {});
    const open = this.roofOpen();
    const after = (d: Date | null) => !!d && now >= d.getTime();
    const before = (d: Date | null) => !!d && now < d.getTime();
    // the imaging night: from sunset (the roof may open in twilight) until the darkness ends
    const inNight = after(w.sunset) && before(w.darkEnd);
    const duty = this.d.duty.status();

    // the roof changed during a night already started: tell the agent at once
    if (night.engagedAt && this.wasOpen !== null && open !== null && open !== this.wasOpen && duty.status !== 'off') {
      this.d.duty.order(open ? ROOF_REOPENED_ORDER : ROOF_CLOSING_ORDER);
    }
    if (open !== null) this.wasOpen = open;
    // during a night on duty, the roof closing has the agent park and transfer (the closing order);
    // reopened, the sessions taken from then on wait for the next closing
    if (inNight && night.transferDue !== undefined && open !== null && night.transferDue !== open) {
      night.transferDue = open;
      this.save();
    }

    // a night that is over, its roof now closed: transfer it
    if (this.closedTransfer(key, open)) return;

    if (!inNight || night.engagedAt) {
      this.publish();
      return;
    }
    const dutyAt = this.dutyAt(w);
    const time = now >= (dutyAt ?? 0);
    if (open === true || night.checkResult === 'open') {
      const why = open !== true ? 'the telescope saw the roof open' : this.building ? `the roof of building ${this.building} opened` : 'a Starfront roof opened (building not set: the telescope confirms it)';
      if (time) {
        this.engage(key, night, why);
        return;
      }
      // open before dark: the agent verifies it now, then leaves the scope parked and disconnected until the duty
      if (open === true && !night.verifyAskedAt && !night.checkResult) {
        night.verifyAskedAt = now;
        log.info(`roof open before dark: asking the agent to verify it (the duty starts at ${localHm(dutyAt!)})`);
        this.d.duty.order(VERIFY_PROMPT(localHm(now), localHm(dutyAt!)));
        this.save();
        return;
      }
      this.publish();
      return;
    }
    // The roof status is authoritative: closed means closed, and the scope is never raised to look.
    // Only with no status at all (the roof API unreachable, or no roof matching) is the telescope asked, at the check time, once a night.
    const checkAt = this.d.checkTime ?? config.starfront.roofCheckTime;
    if (open === null && !night.checkedAt && now >= sky.parseLocal(`${key}T${checkAt}`, config.observer.timezone).getTime()) {
      night.checkedAt = now;
      log.info(`roof status unknown at ${checkAt}: asking the agent to check it with the telescope`);
      this.d.duty.order(ROOF_CHECK_PROMPT(localHm(now), dutyAt && !time ? localHm(dutyAt) : undefined));
      this.save();
      return;
    }
    this.publish();
  }

  private engage(key: string, night: NightRecord, why: string): void {
    const duty = this.d.duty.status();
    if (duty.status !== 'off') {
      // never replace a duty someone else started; this night is counted as taken
      night.engagedAt = this.now();
      night.engagedBy = `not started: a duty was already ${duty.status} (${duty.objective?.slice(0, 80) ?? ''})`;
      this.save();
      return;
    }
    try {
      this.d.duty.start({ objective: NIGHT_OBJECTIVE, until: 'dawn', by: 'user', via: "Starfront's autonomous nights" });
      night.engagedAt = this.now();
      night.engagedBy = why;
      night.transferDue = true;
      log.info(`night ${key} started: ${why}`);
    } catch (e) {
      log.warn(`could not start the night's duty: ${errMsg(e)}`);
    }
    this.save();
  }

  /**
   * The agent's roof check with the telescope. Open starts tonight's duty; either way, with the
   * building unknown, the result narrows down which roof is the scope's.
   */
  report(open: boolean): StarfrontStatus {
    const now = this.now();
    const { key, w } = this.nightOf(now);
    const night = (this.st.nights[key] ??= {});
    night.checkResult = open ? 'open' : 'closed';
    if (!this.building && this.roofs?.length) {
      const all = this.roofs.map((r) => r.device_number);
      const agree = this.roofs.filter((r) => r.is_open === open).map((r) => r.device_number);
      const next = (this.st.candidates ?? all).filter((n) => agree.includes(n));
      // a contradiction (no roof agrees): start over rather than lock onto nothing
      this.st.candidates = next.length ? next : all;
      if (next.length === 1) log.info(`the scope's roof is building ${next[0]} (learned from the telescope's roof checks)`);
    }
    // seen open: the duty starts at its time (the tick), or now if that has come
    const dutyAt = this.dutyAt(w);
    if (open && !night.engagedAt && now < (w.darkEnd?.getTime() ?? 0) && now >= (dutyAt ?? 0)) this.engage(key, night, 'the telescope saw the roof open');
    else this.save();
    return this.status();
  }

  /**
   * A night whose duty ran, now over (`key` is a later night) with its roof still open at its end, is
   * transferred once the roof reports closed (or, with no roof status at all, a while after the
   * darkness ended).
   */
  private closedTransfer(key: string, open: boolean | null): boolean {
    const now = this.now();
    const due = Object.keys(this.st.nights).filter((k) => k < key && this.st.nights[k].transferDue);
    if (!due.length || open === true) return false;
    if (open === null) {
      const at = this.st.nights[due[due.length - 1]].engagedAt;
      const w = at ? sky.nightWindow(this.d.site(), new Date(at)) : null;
      if (!w?.darkEnd || now < w.darkEnd.getTime() + NO_STATUS_GRACE_MS) return false;
    }
    for (const k of due) {
      this.st.nights[k].transferDue = false;
      this.st.nights[k].transferAskedAt = now;
    }
    const nights = due.join(', ');
    log.info(`night ${nights} over and the roof ${open === false ? 'closed' : 'status unknown'}: asking the agent to transfer it`);
    this.d.duty.order(ROOF_CLOSED_TRANSFER_ORDER(nights));
    this.save();
    return true;
  }

  /**
   * Why the agent may not transfer now (null: it may): while a night's roof is open, Starfront's
   * bandwidth is left to those imaging; the night is transferred when the roof closes.
   */
  transferHold(): string | null {
    if (!this.st.enabled) return null;
    if (this.roofOpen() === false) return null;
    if (!Object.values(this.st.nights).some((n) => n.transferDue)) return null;
    return 'Autonomous Starfront night: nothing is transferred while the roof is open (Starfront asks that files are transferred once the night is done, to leave the bandwidth to those imaging). The whole night is transferred when the roof closes; you are woken for it. Leave the sessions on the card until then.';
  }

  private publish(): void {
    this.emit('status', this.status());
  }

  status(): StarfrontStatus {
    const now = this.now();
    let key = '';
    let w: ReturnType<typeof sky.nightWindow> | null = null;
    try {
      ({ key, w } = this.nightOf(now));
    } catch {
      /* no location */
    }
    const tz = config.observer.timezone;
    const open = this.roofOpen();
    const night = (key && this.st.nights[key]) || {};
    const duty = this.d.duty.status();
    const dutyAt = w ? this.dutyAt(w) : null;
    const phase = !this.st.enabled
      ? 'off'
      : night.engagedAt && duty.status !== 'off'
        ? 'imaging night on duty'
        : night.checkResult === 'open' && dutyAt && now < dutyAt
          ? `roof verified open: the scope is parked and disconnected until the duty at ${localHm(dutyAt)}`
          : night.verifyAskedAt && !night.checkResult
            ? 'roof open before dark: the agent is verifying it'
          : Object.keys(this.st.nights).some((k) => k < key && this.st.nights[k].transferDue)
            ? 'night over: the transfer waits for the roof to close'
        : w?.sunset && now < w.sunset.getTime()
          ? `waiting for the night (sunset ${sky.fmtTime(w.sunset, tz)})`
          : open
            ? 'roof open'
            : `waiting for the roof to open${night.checkedAt ? '' : ` (telescope check at ${config.starfront.roofCheckTime})`}`;
    return {
      available: config.starfront.available,
      enabled: this.st.enabled,
      building: this.building || (this.st.candidates?.length === 1 ? this.st.candidates[0] : null),
      candidates: this.building ? null : (this.st.candidates ?? null),
      roof: open === null ? 'unknown' : open ? 'open' : 'closed',
      roofAt: this.roofAt,
      roofError: this.roofError,
      night: key,
      window: { sunset: w ? sky.fmtTime(w.sunset, tz) : null, astroDusk: w ? sky.fmtTime(w.astroDusk, tz) : null, astroDawn: w ? sky.fmtTime(w.astroDawn, tz) : null },
      dutyAt: dutyAt ? localHm(dutyAt) : null,
      phase,
      tonight: night,
    };
  }
}
