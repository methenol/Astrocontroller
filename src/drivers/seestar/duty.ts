/** The Seestar as the duty loop sees it: its sensors, its measurements and its close-out. */
import type { DutyDevice } from '../../agent/duty.js';
import { band, type EventSink } from '../../agent/duty/sensors.js';
import type { Seestar } from './device.js';
import type { SeestarEvent } from './rpc.js';
import { TERMINAL_STATES, type SeestarState } from './state.js';

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

function watch(scope: Seestar, event: EventSink): () => void {
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
    closeOut: () => 'stop stacking if it still runs (stop_stacking) and park the scope (park).',
  };
}
