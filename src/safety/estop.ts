/**
 * The E-Stop: halts what the telescope is doing and refuses every command that would move it or
 * change it, until the user presses Enable Control. It is separate from Disconnect: the link, the
 * status polling and the live views stay up, and the agent can still be talked to.
 *
 * The transports check it per command, so nothing that reaches the telescope can go around it (a
 * routine already running, a background service, the agent's tools). The stop commands of the halt
 * itself run inside runHalt().
 *
 * CONTROL_ENABLED_ON_STARTUP=false starts the process with it engaged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import { SafeEmitter } from '../util/events.js';

export const ESTOP_MSG =
  'E-Stop is engaged: telescope control is locked out. Status and conversation still work, but movement, captures, settings and transfers are refused until the user presses Enable Control in the web UI. Only the user can do that; tell them what you need it for and do not retry.';

/** Thrown instead of sending a control command while the E-Stop is engaged. */
export class EStopError extends Error {
  override name = 'EStopError';
  constructor() {
    super(ESTOP_MSG);
  }
}

export interface EStopStatus {
  engaged: boolean;
  since: number | null;
  /** startup: CONTROL_ENABLED_ON_STARTUP=false; user: the E-STOP button */
  source: 'startup' | 'user' | null;
  /** what the halt could not confirm stopped */
  haltFailed: string[];
}

const halting = new AsyncLocalStorage<boolean>();

class EStop extends SafeEmitter {
  private current: EStopStatus = { engaged: false, since: null, source: null, haltFailed: [] };

  constructor(engagedAtStart: boolean) {
    super();
    if (engagedAtStart) this.current = { engaged: true, since: Date.now(), source: 'startup', haltFailed: [] };
  }

  get engaged(): boolean {
    return this.current.engaged;
  }

  status(): EStopStatus {
    return { ...this.current, haltFailed: [...this.current.haltFailed] };
  }

  /**
   * Lock control out, at once. True when the caller should halt: the start-up lock sends no stop
   * commands, so a press during it still halts what the telescope was already doing.
   */
  engage(source: 'startup' | 'user'): boolean {
    if (this.current.engaged && this.current.source === source) return false;
    this.current = { engaged: true, since: Date.now(), source, haltFailed: [] };
    this.emit('state', this.status());
    return true;
  }

  /** Enable Control. What was halted stays halted: nothing is resumed. */
  reset(): void {
    if (!this.current.engaged) return;
    this.current = { engaged: false, since: null, source: null, haltFailed: [] };
    this.emit('state', this.status());
  }

  /** Record what the halt could not confirm stopped. */
  haltFinished(failed: string[]): void {
    if (!this.current.engaged) return;
    this.current = { ...this.current, haltFailed: failed };
    this.emit('state', this.status());
  }

  /** Run the halt: only the commands sent from inside `fn` pass while engaged. */
  runHalt<T>(fn: () => Promise<T>): Promise<T> {
    return halting.run(true, fn);
  }

  /** Throws while engaged, except inside the halt. */
  assertClear(): void {
    if (this.current.engaged && !halting.getStore()) throw new EStopError();
  }
}

export const estop = new EStop(!config.control.enabledOnStartup);
