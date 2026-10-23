/** What every web route module is given. */
import type { Dwarf } from '../drivers/dwarf/device.js';
import type { StreamHub } from '../media/streams.js';
import type { AgentBridge } from '../agent/omp.js';
import type { DutyLoop } from '../agent/duty.js';
import { config, telescopeHostInfo } from '../config.js';
import { withoutCredentials } from '../util/url.js';

export interface WebContext {
  dwarf: Dwarf;
  hub: StreamHub;
  agent: AgentBridge;
  duty: DutyLoop;
  /** Send a message to every connected UI over the state socket. */
  broadcast(msg: unknown): void;
}

/** The settings the UI shows (nothing secret). */
export function publicConfig(dwarf: Dwarf) {
  const loc = dwarf.location();
  return {
    telescope: config.dwarf.host,
    telescopeHost: telescopeHostInfo(),
    observer: loc ? { ...loc, timezone: config.observer.timezone } : null,
    llm: { baseUrl: withoutCredentials(config.llm.baseUrl), model: config.llm.model, reasoningEffort: config.llm.reasoningEffort, vision: config.llm.vision },
    library: config.paths.library,
    minAltitude: config.observer.minAltitudeDeg,
  };
}

/** The observer site for astronomy helpers, or null when the location is unknown. */
export function observerSite(dwarf: Dwarf): { lat: number; lon: number; elev: number } | null {
  const loc = dwarf.location();
  return loc ? { lat: loc.lat, lon: loc.lon, elev: loc.elev } : null;
}

/** The observer site; throws (with the reason) when the location is unknown. */
export function requireSite(dwarf: Dwarf): { lat: number; lon: number; elev: number } {
  const loc = dwarf.requireLocation();
  return { lat: loc.lat, lon: loc.lon, elev: loc.elev };
}

/** The tele field of view in arcminutes (the nominal one until the telescope reports it). */
export function teleFovArcmin(dwarf: Dwarf): { w: number; h: number } {
  const fov = dwarf.state.fov.tele ?? { h: 2.95, v: 1.66 };
  return { w: fov.h * 60, h: fov.v * 60 };
}
