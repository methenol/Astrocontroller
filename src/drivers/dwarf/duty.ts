/** The Dwarf 3 as the duty loop sees it: its sensors, its measurements and its close-out. */
import { config } from '../../config.js';
import type { DutyDevice } from '../../agent/duty.js';
import { dwarfLines } from '../../agent/duty/measurements.js';
import { watchDwarf } from '../../agent/duty/sensors.js';
import type { Dwarf } from './device.js';
import type { StackSupervisor } from './stack-supervisor.js';

export function dwarfDuty(dwarf: Pick<Dwarf, 'state' | 'stackControl' | 'isTracking' | 'requireLocation' | 'on' | 'off'>): DutyDevice & { stackSupervisor?: StackSupervisor } {
  return {
    get state() {
      return dwarf.state;
    },
    /** acts on stacks that collect nothing (set by the runtime); its alarms show in the samples */
    stackSupervisor: undefined,
    requireLocation: () => dwarf.requireLocation(),
    measure(now) {
      return dwarfLines(dwarf, now, this.stackSupervisor);
    },
    watch: (now, event) => watchDwarf(dwarf, now, event),
    closeOut: () =>
      "park the scope (move_motors pitch_deg=2.5) and transfer every session still on the telescope's SD card (check list_device_sessions, then transfer_session — never assume what is on the card)" +
      (config.studio.autoProcess
        ? '; each transfer queues processing in AstroPhoto Studio by itself (processing_status shows the queue).'
        : '; auto-process is off in .env, so do not queue processing unless the objective says so.'),
  };
}
