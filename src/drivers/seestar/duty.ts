/**
 * The Seestar as the duty loop sees it: its sensors, its measurements and its close-out, and the
 * stack supervisor (as the Dwarf's, stack-supervisor.ts): a stack that keeps "running" while it
 * rejects every frame, or gets none, is reported to the agent at once and stopped after
 * STACK_AUTOSTOP_MIN if it does not recover (the frames stacked so far are kept).
 */
import { config } from '../../config.js';
import { errMsg } from '../../log.js';
import type { DutyDevice } from '../../agent/duty.js';
import { band, type EventSink } from '../../agent/duty/sensors.js';
import type { Seestar } from './device.js';
import type { SeestarEvent } from './rpc.js';
import { TERMINAL_STATES, type SeestarState } from './state.js';

const SUPERVISE_EVERY_MS = 15_000;
/** a stack is judged only after this many sub lengths without a stacked frame (and never sooner than MIN_JUDGE_MS) */
const SUBS_BEFORE_ALARM = 5;
const MIN_JUDGE_MS = 5 * 60_000;
const DEFAULT_SUB_MS = 10_000;

const stacking = (st: SeestarState) => !!st.stack.state && !TERMINAL_STATES.has(st.stack.state) && st.stack.state !== 'idle';

function lines(scope: Seestar): string[] {
  const st = scope.state;
  if (st.released) return ['- telescope: RELEASED by the user (Disconnect in the web UI); nothing can be sent until they press Connect'];
  if (!st.connected) return [`- telescope: NOT CONNECTED${st.link?.lastError ? ` (${st.link.lastError})` : ''}`];
  const m = st.mount;
  const busy = scope.isBusy();
  const out = [
    `- telescope: connected; battery ${st.power.batteryPct ?? '?'}%${st.power.charging ? ' (charging)' : ''}; ${m.parked ? 'parked' : m.tracking ? 'tracking' : 'not tracking'}; ${m.eqMode ? 'EQ' : 'Alt-Az'} mode${busy ? `; busy: ${busy}` : ''}; storage ${st.storage.freeMB !== undefined ? `${(st.storage.freeMB / 1024).toFixed(1)} GB free` : '?'}; body ${st.power.tempC ?? '?'} °C`,
  ];
  const s = st.stack;
  if (stacking(st)) out.push(`- stacking: running${st.view.target ? ` on ${st.view.target}` : ''}, ${s.stacked ?? 0} stacked, ${s.dropped ?? 0} dropped${s.total ? ` (target ${s.total})` : ''}${s.lastError ? `; last error: ${s.lastError}` : ''}`);
  else out.push(`- stacking: ${s.state ?? 'idle'}${s.stacked ? ` (last stack: ${s.stacked} frames)` : ''}`);
  if (st.alert && Date.now() - st.alert.at < 15 * 60_000) out.push(`- last alert: ${st.alert.error ?? '?'}${st.alert.code !== undefined ? ` (code ${st.alert.code})` : ''}`);
  return out;
}

/** The stack sub length the scope is set to. */
function subMs(st: SeestarState): number {
  const v = (st.deviceState as { setting?: { exp_ms?: { stack_l?: number } } } | undefined)?.setting?.exp_ms?.stack_l;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_SUB_MS;
}

/**
 * Watches the running stack's counts: `rejecting` when frames keep coming but none stacks,
 * `stalled` when none comes at all.
 */
export function superviseStack(scope: Seestar, event: EventSink, o: { autoStopAfterMs?: number; everyMs?: number; now?: () => number } = {}): () => void {
  const now = o.now ?? Date.now;
  const autoStopAfterMs = o.autoStopAfterMs ?? config.dwarf.stackAutoStopMin * 60_000;
  let seen = { stacked: -1, dropped: -1, stackedAt: now(), frameAt: now() };
  let alarm: { verdict: 'rejecting' | 'stalled'; since: number; stopping?: boolean } | null = null;
  const check = () => {
    const st = scope.state;
    if (!st.connected || !stacking(st)) {
      seen = { stacked: -1, dropped: -1, stackedAt: now(), frameAt: now() };
      alarm = null;
      return;
    }
    const stacked = st.stack.stacked ?? 0;
    const dropped = st.stack.dropped ?? 0;
    const t = now();
    if (stacked !== seen.stacked) seen.stackedAt = t;
    if (stacked !== seen.stacked || dropped !== seen.dropped) seen.frameAt = t;
    const fresh = seen.stacked === -1;
    seen = { ...seen, stacked, dropped };
    if (fresh) return;
    const judgeAfter = Math.max(MIN_JUDGE_MS, SUBS_BEFORE_ALARM * subMs(st));
    const verdict = t - seen.frameAt >= judgeAfter ? 'stalled' : t - seen.stackedAt >= judgeAfter ? 'rejecting' : null;
    if (!verdict) {
      if (alarm) event(`live stacking recovered: frames stack again (${stacked} stacked, ${dropped} dropped)`, true);
      alarm = null;
      return;
    }
    if (!alarm || alarm.verdict !== verdict) {
      alarm = { verdict, since: t };
      const what = verdict === 'stalled' ? `no frame for ${Math.round((t - seen.frameAt) / 60_000)} min` : `no frame stacked for ${Math.round((t - seen.stackedAt) / 60_000)} min while ${dropped} were dropped`;
      event(`live stacking is ${verdict.toUpperCase()}${st.view.target ? ` on ${st.view.target}` : ''}: ${what}${autoStopAfterMs ? `; it is stopped automatically in ${Math.round(autoStopAfterMs / 60_000)} min unless it recovers` : ''}. Check focus, clouds and tracking (analyze_subs, view_camera).`, true);
      return;
    }
    if (autoStopAfterMs && !alarm.stopping && t - alarm.since >= autoStopAfterMs) {
      alarm.stopping = true;
      const a = alarm;
      void scope.stopStack().then(
        () => event(`live stacking was STOPPED automatically: it was ${a.verdict} for ${Math.round((t - a.since) / 60_000)} min (${stacked} frames stacked are kept). Fix the cause, then start_stacking again.`, true),
        (e) => {
          a.stopping = false;
          a.since = now();
          event(`the automatic stop of a ${a.verdict} stack failed: ${errMsg(e)}`, true);
        },
      );
    }
  };
  const timer = setInterval(check, o.everyMs ?? SUPERVISE_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function watch(scope: Seestar, event: EventSink): () => void {
  const stopSupervisor = superviseStack(scope, event);
  let wasStacking = stacking(scope.state);
  let connected = scope.state.connected;
  let charging = scope.state.power.charging;
  let batteryBand = band(scope.state.power.batteryPct);
  const onState = () => {
    const st = scope.state;
    const now = stacking(st);
    if (wasStacking && !now) event(`live stacking ended (${st.stack.state ?? '?'}): ${st.stack.stacked ?? '?'} stacked, ${st.stack.dropped ?? '?'} dropped${st.stack.lastError ? `; ${st.stack.lastError}` : ''}`, st.stack.state !== 'fail');
    wasStacking = now;
    if (connected !== st.connected && !st.released) event(st.connected ? 'the telescope connection is back' : 'the telescope connection was lost', true);
    connected = st.connected;
    const c = st.power.charging;
    if (charging !== undefined && c !== undefined && charging !== c) event(c ? `the telescope is now charging (battery ${st.power.batteryPct ?? '?'}%)` : `the telescope is no longer charging (battery ${st.power.batteryPct ?? '?'}%)`, true);
    charging = c ?? charging;
    if (st.power.batteryPct !== undefined) {
      const b = band(st.power.batteryPct);
      if (b < batteryBand) event(`battery down to ${st.power.batteryPct}%`, true);
      batteryBand = b;
    }
  };
  const onEvent = (e: SeestarEvent) => {
    if (e.Event === 'Alert') event(`the Seestar raised an alert: ${String(e.error ?? '?')}${e.code !== undefined ? ` (code ${String(e.code)})` : ''}`, true);
  };
  scope.on('state', onState);
  scope.on('event', onEvent);
  return () => {
    stopSupervisor();
    scope.off('state', onState);
    scope.off('event', onEvent);
  };
}

export function seestarDuty(scope: Seestar): DutyDevice {
  return {
    get state() {
      return scope.state;
    },
    requireLocation: () => scope.requireLocation(),
    measure: () => lines(scope),
    watch: (_now, event) => watch(scope, event),
    closeOut: () => "stop stacking if it still runs (stop_stacking), park the scope (park), then transfer the night's sessions that are not in the library yet (list_device_sessions, transfer_session; processing queues itself).",
  };
}
