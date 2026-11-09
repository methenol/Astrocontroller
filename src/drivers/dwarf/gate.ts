/**
 * The user released the telescope from the web UI (Disconnect), for example to use the DWARFLAB
 * app: no traffic of any kind (control link, HTTP, FTP, video) until they press Connect.
 * Dwarf.release()/reconnect() set it; every transport checks it before sending.
 */
import { estop } from '../../safety/estop.js';

export const gate = { released: false };

export const RELEASED_MSG =
  'Astrocontroller is disconnected from the telescope: the user released it with the Disconnect button in the web UI. Nothing can be sent to the telescope until they press Connect; tell them what you need it for.';

/** Thrown instead of sending anything while the telescope is released. */
export class TelescopeReleasedError extends Error {
  override name = 'TelescopeReleasedError';
  constructor() {
    super(RELEASED_MSG);
  }
}

/** Commands that change nothing the E-Stop guards: holding the link, and waking the camera for the live view. */
const ALLOWED_UNDER_ESTOP = new Set(['SYSTEM_SET_MASTER', 'TASK_MANAGER_ENTER_CAMERA', 'CAMERA_TELE_SET_PREVIEW_QUALITY', 'CAMERA_WIDE_SET_PREVIEW_QUALITY']);
const READS = /(^|_)GET(_|$)/;

/** Under the E-Stop only reads and the commands above go out; anything unrecognised is refused. */
export function assertCommandAllowed(name: string): void {
  if (!READS.test(name) && !ALLOWED_UNDER_ESTOP.has(name)) estop.assertClear();
}

export function assertLinked(): void {
  if (gate.released) throw new TelescopeReleasedError();
}
