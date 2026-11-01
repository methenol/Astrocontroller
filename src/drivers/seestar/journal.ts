/** The Seestar as the night journal sees it (night/recorder.ts): its operations, focus and stack, from the folded state. */
import { analyze } from '../../media/images.js';
import type { JournalProbe, OpState, ScopeSnapshot } from '../../night/recorder.js';
import type { Seestar } from './device.js';
import { isStacking, TERMINAL_STATES } from './model.js';

function op(scope: Seestar, name: string): OpState {
  const o = scope.state.ops[name];
  if (!o) return 'idle';
  if (!TERMINAL_STATES.has(o.state)) return 'running';
  return o.state === 'complete' ? 'complete' : 'failed';
}

function subS(scope: Seestar): number | undefined {
  const v = (scope.state.deviceState as { setting?: { exp_ms?: { stack_l?: number } } } | null)?.setting?.exp_ms?.stack_l;
  return typeof v === 'number' && v > 0 ? v / 1000 : undefined;
}

export function seestarProbe(scope: Seestar): JournalProbe {
  return {
    snapshot(): ScopeSnapshot {
      const st = scope.state;
      const tune = st.focusTune as { running?: boolean; message?: string } | null;
      return {
        connected: st.connected && !st.released,
        goto: { state: op(scope, 'AutoGoto'), target: st.view.target },
        autofocus: { state: op(scope, 'AutoFocus') },
        fineFocus: { running: !!tune?.running, result: tune?.message },
        focusPosition: st.focus.position,
        stack: {
          running: isStacking(st),
          target: st.view.target,
          stacked: st.stack.stacked,
          rejected: st.stack.dropped,
          subS: subS(scope),
          gain: st.view.gain,
          filter: st.view.lpFilter === undefined ? undefined : st.view.lpFilter ? 'LP' : 'IRCUT',
          camera: 'tele',
          error: st.stack.lastError,
        },
        pointing: st.mount.raHours !== undefined && st.mount.decDeg !== undefined ? { raHours: st.mount.raHours, decDeg: st.mount.decDeg } : undefined,
      };
    },
    on: (e, f) => scope.on(e, f),
    off: (e, f) => scope.off(e, f),
    async assessStack() {
      if (!scope.state.connected) return null;
      const { image } = await scope.grabImage('tele', 'stacked');
      const a = analyze(image, 'tele');
      return { stars: a.stars.count, hfrPx: a.stars.medianHfrPx ?? null, background: Math.round(a.stats.median * 1000) / 1000 };
    },
  };
}
