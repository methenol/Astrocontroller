/**
 * An EventEmitter whose listeners cannot hurt the code that emits. With a plain emitter, a
 * listener that throws throws out of emit(): into a state update, a job queue (stalling every later
 * job), or a stream callback (an uncaught exception that ends the process). Here each listener is
 * called on its own, a failure is logged, and the rest still run. 'error' without a listener keeps
 * Node's behaviour (it throws), so a missing error handler is still noticed.
 */
import { EventEmitter } from 'node:events';
import { errMsg, logger } from '../log.js';

const log = logger('events');

export class SafeEmitter extends EventEmitter {
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error' && this.listenerCount('error') === 0) return super.emit(event, ...args);
    // rawListeners: once() wrappers remove themselves when called, as with a plain emit
    const fns = this.rawListeners(event) as Array<(...a: unknown[]) => unknown>;
    if (!fns.length) return false;
    for (const fn of fns) {
      try {
        fn.apply(this, args);
      } catch (err) {
        log.warn(`a "${String(event)}" listener failed: ${errMsg(err)}`);
      }
    }
    return true;
  }
}
