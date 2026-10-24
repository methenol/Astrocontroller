/**
 * The duty loop's sensors: changes of the telescope's state (the driver's own sensors: the Dwarf's
 * are here, the Seestar's in drivers/seestar/duty.ts), transfer jobs and processing items that are
 * worth waking the agent for. Each becomes an event; `onlyOnDuty` events are dropped when no duty
 * is active.
 */
import type { Dwarf } from '../../drivers/dwarf/device.js';
import * as library from '../../library/transfer.js';
import * as processing from '../../processing/queue.js';
import * as dhttp from '../../drivers/dwarf/http.js';

export type EventSink = (text: string, onlyOnDuty?: boolean) => void;
export type SensedDwarf = Pick<Dwarf, 'state' | 'stackControl' | 'on' | 'off'>;
/** what the shared sensors need of any telescope */
export interface SensedDevice {
  readonly state: { released?: boolean };
  watch(now: () => number, event: EventSink): () => void;
}

/** A stack that ends within this long of a stop command was stopped on request. */
const REQUESTED_STOP_MS = 180_000;
/** Ids remembered to report each finished job or item once. */
const SEEN_KEPT = 500;

const JOB_FINISHED = new Set(['done', 'partial', 'failed', 'cancelled']);

/** Battery bands: a wake on entering a lower one. */
export const band = (b?: number) => (b === undefined ? 9 : b <= 10 ? 0 : b <= 15 ? 1 : b <= 25 ? 2 : 9);
export const special = (x?: string) => x === 'unresponsive' || x === 'contended';

/** Remembers the last state reported per id, bounded. */
class Seen {
  private readonly map = new Map<string, string>();

  /** True the first time `id` is seen in `state`. */
  first(id: string, state: string): boolean {
    if (this.map.get(id) === state) return false;
    this.map.delete(id);
    this.map.set(id, state);
    if (this.map.size > SEEN_KEPT) this.map.delete(this.map.keys().next().value!);
    return true;
  }
}

/** The Dwarf's telescope sensors. */
export function watchDwarf(d: SensedDwarf, now: () => number, event: EventSink): () => void {
  let stack = { tele: d.state.stacking.tele.state, wide: d.state.stacking.wide.state };
  let dark = d.state.darkCapture?.state;
  let connected = d.state.connected;
  let linkState = d.state.link?.state;
  let charging = d.state.charging;
  let batteryBand = band(d.state.battery);
  let cameraHung = false;

  const onState = () => {
    const s = d.state;
    for (const cam of ['tele', 'wide'] as const) {
      const cur = s.stacking[cam].state;
      if (stack[cam] === 'running' && cur !== 'running') {
        const ctl = d.stackControl[cam];
        const requested = ctl.stopRequestedAt && now() - ctl.stopRequestedAt < REQUESTED_STOP_MS;
        if (!requested) {
          const x = s.stacking[cam];
          const early = x.totalCount && (x.currentCount ?? 0) < x.totalCount;
          const msg = `${cam} live stacking ended without a stop command (${x.stackedCount ?? '?'} stacked of ${x.currentCount ?? '?'} taken${x.totalCount ? `, frame target ${x.totalCount}` : ''}): the frame target was reached, or the scope stopped it${early ? `. Before the frame target, so likely the scope's own stop (on 2026-10-11 the rotation axis' end of travel; telescope_status shows rotation). If the next GoTo or stack start is refused with -11501, Astrocontroller runs astro_recover itself; a power cycle is the last resort` : ''}`;
          event(msg, ctl.startedBy !== 'agent');
        }
      }
      stack[cam] = cur;
    }

    const dc = s.darkCapture?.state;
    if (dark === 'running' && dc && dc !== 'running') {
      const x = s.darkCapture!;
      event(dc === 'done' ? `dark master saved: ${x.master} (${x.exposureS} s, gain ${x.gain}, ${x.frames} frames)` : `dark capture ${x.exposureS} s ended: ${dc}${x.error ? ` — ${x.error}` : ''}`);
    }
    dark = dc;

    const ls = s.link?.state;
    const prevLs = linkState;
    if (ls !== prevLs && !s.released) {
      // a hung or contended telescope matters on duty or not: the user has to act
      if (ls === 'unresponsive') event(`the telescope STOPPED RESPONDING: ${s.link!.detail} Tell the user now; do not send telescope commands until it answers again (you will get an event).`);
      else if (ls === 'contended') event(`the telescope is being TAKEN BY ANOTHER CLIENT: ${s.link!.detail} Tell the user now.`);
      else if (ls === 'connected' && special(prevLs)) event('the telescope is answering commands again: check telescope_status (after a power cycle: motors_home, then sync_time_and_location) and carry on');
    }
    linkState = ls;
    if (connected !== s.connected && !s.released && !special(ls) && !special(prevLs)) {
      event(s.connected ? 'the telescope connection is back' : 'the telescope connection was lost', true);
    }
    connected = s.connected;

    if (charging !== undefined && s.charging !== undefined && charging !== s.charging) {
      event(s.charging ? `the telescope is now charging (battery ${s.battery ?? '?'}%)` : `the telescope is no longer charging (battery ${s.battery ?? '?'}%)`, true);
    }
    charging = s.charging ?? charging;

    // an unknown reading (disconnected) keeps the last band: the next reading is not a drop from 'full'
    if (s.battery !== undefined) {
      const b = band(s.battery);
      if (b < batteryBand) event(`battery down to ${s.battery}%`, true);
      batteryBand = b;
    }

    const hung = dhttp.apiHealth().cameraService === 'NOT RESPONDING';
    if (hung && !cameraHung) event("the telescope's camera service is NOT RESPONDING (camera calls time out); see the system prompt, 'When tools fail'", true);
    cameraHung = hung;
  };
  d.on('state', onState);
  return () => d.off('state', onState);
}

function watchJobs(d: SensedDevice, event: EventSink): () => void {
  const seen = new Seen();
  const onJob = (j: library.Job) => {
    if (!JOB_FINISHED.has(j.status) || !seen.first(j.id, j.status)) return;
    if (j.status === 'cancelled' && d.state.released) return;
    const err = j.error ? `: ${j.error.slice(0, 300)}` : '';
    const queued = (j.result as { processing?: { id?: string } } | undefined)?.processing?.id ? '; processing queued' : '';
    event(`transfer job ${j.id} (${j.description}) ${j.status}${err}${queued}`, j.origin !== 'agent');
  };
  library.jobBus.on('job', onJob);
  return () => library.jobBus.off('job', onJob);
}

function watchProcessing(event: EventSink): () => void {
  const seen = new Seen();
  const onItem = (it: processing.ProcessingItem) => {
    if (!seen.first(it.id, it.state)) return;
    if (it.state !== 'done' && it.state !== 'failed') return;
    const mine = it.origin === 'agent' || it.origin === 'transfer';
    event(`processing ${it.id} (${it.target}, ${it.profile}) ${it.state}${it.state === 'failed' && it.lastError ? `: ${it.lastError.slice(0, 200)}` : ''}${it.outputs?.length ? `; outputs: ${it.outputs.length} file(s)` : ''}`, !mine);
  };
  processing.processingBus.on('item', onItem);
  return () => processing.processingBus.off('item', onItem);
}

/** Start every sensor; returns the function that stops them. */
export function watchSensors(d: SensedDevice, now: () => number, event: EventSink): () => void {
  const offs = [d.watch(now, event), watchJobs(d, event), watchProcessing(event)];
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
