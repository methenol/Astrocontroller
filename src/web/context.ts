/** What every web route module is given. */
import type { AgentBridge } from '../agent/omp.js';
import type { DutyLoop } from '../agent/duty.js';
import type { NightServices } from '../night/index.js';
import { config, observerLocation, telescopeHostInfo } from '../config.js';
import { withoutCredentials } from '../util/url.js';
import type { WebTelescope } from './telescope.js';

export interface WebContext {
  /** the telescope, through its driver's adapter */
  scope: WebTelescope;
  agent: AgentBridge;
  duty: DutyLoop;
  /** the night plan, the program and the journal */
  night?: NightServices | null;
  /** Send a message to every connected UI over the state socket. */
  broadcast(msg: unknown): void;
}

/** The settings the UI shows (nothing secret). */
export function publicConfig(scope: WebTelescope) {
  const loc = scope.location();
  const host = telescopeHostInfo();
  return {
    driver: scope.driver,
    driverLabel: scope.label,
    capabilities: scope.capabilities,
    // Starfront's autonomous nights: offered on the agent tab only when this is on
    starfront: config.starfront.available,
    telescope: host.host,
    telescopeHost: host,
    observer: loc ? { ...loc, timezone: config.observer.timezone } : null,
    llm: { baseUrl: withoutCredentials(config.llm.baseUrl), model: config.llm.model, reasoningEffort: config.llm.reasoningEffort, vision: config.llm.vision },
    library: config.paths.library,
    minAltitude: config.observer.minAltitudeDeg,
    units: config.units,
    // The Stellarium tab's observer is the site in .env (OBSERVER_*), not a location the telescope reported.
    stellarium: { site: observerLocation(), timezone: config.observer.timezone, stream: config.stellarium.stream, dataUrl: config.stellarium.dataUrl },
  };
}

type Located = Pick<WebTelescope, 'location' | 'requireLocation'>;

/** The observer site for astronomy helpers, or null when the location is unknown. */
export function observerSite(scope: Located): { lat: number; lon: number; elev: number } | null {
  const loc = scope.location();
  return loc ? { lat: loc.lat, lon: loc.lon, elev: loc.elev } : null;
}

/** The observer site; throws (with the reason) when the location is unknown. */
export function requireSite(scope: Located): { lat: number; lon: number; elev: number } {
  const loc = scope.requireLocation();
  return { lat: loc.lat, lon: loc.lon, elev: loc.elev };
}

/** The tele field of view in arcminutes. */
export function teleFovArcmin(scope: Pick<WebTelescope, 'teleFovDeg'>): { w: number; h: number } {
  const fov = scope.teleFovDeg();
  return { w: fov.h * 60, h: fov.v * 60 };
}
