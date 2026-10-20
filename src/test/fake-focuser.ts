import type { FakeDwarf } from './fake-dwarf.js';
import { FOCUS_MAX } from '../dwarf/device.js';
import { Cmd } from '../dwarf/protocol.js';

/**
 * The focuser as the firmware drives it (fw 1.5.3): single steps of 1 unit, never answered;
 * position notifications batched and late (over the 2026-10-12 link, seconds late in bursts);
 * the device state read carries the true position. `dropEvery` loses steps like a busy firmware.
 */
export class FakeFocuser {
  pos: number;
  steps = 0;
  private timer: NodeJS.Timeout;
  private dirty = false;
  constructor(
    fake: FakeDwarf,
    start: number,
    o: { burstMs?: number; dropEvery?: number } = {},
  ) {
    this.pos = start;
    fake.on(Cmd.FOCUS_MANUAL_SINGLE_STEP_FOCUS, (req) => {
      this.steps++;
      if (o.dropEvery && this.steps % o.dropEvery === 0) return undefined;
      this.pos = Math.max(0, Math.min(FOCUS_MAX, this.pos + (Number(req.data.direction ?? 0) === 0 ? 1 : -1)));
      this.dirty = true;
      return undefined;
    });
    fake.on(Cmd.TASK_GET_DEVICE_STATE_INFO, () => ({ focusMotorStateInfo: { focusPosition: { pos: this.pos } } }));
    // a burst of the latest position now and then, not one per step
    this.timer = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      void fake.notify('focusPosition', { pos: this.pos }).catch(() => {});
    }, o.burstMs ?? 300);
  }
  stop() {
    clearInterval(this.timer);
  }
}
