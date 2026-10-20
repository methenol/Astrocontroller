/**
 * The user released the telescope from the web UI (Disconnect), for example to use the DWARFLAB
 * app: no traffic of any kind (control link, HTTP, FTP, video) until they press Connect.
 * Dwarf.release()/reconnect() set it; every transport checks it before sending.
 */
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

export function assertLinked(): void {
  if (gate.released) throw new TelescopeReleasedError();
}
