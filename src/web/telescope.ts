/**
 * The telescope as the web UI sees it, whatever the driver. Every driver serves the same UI
 * (public/) through this: the driver only decides how each request reaches its telescope.
 *
 * The state is the UI's shape (the Dwarf's TelescopeState field names, which the UI renders); a
 * driver publishes the fields its telescope has and leaves the rest out. `capabilities` says which
 * controls it can carry out, so the UI disables the rest (with the reason) instead of failing them.
 */
import type { Router } from 'express';
import type { ObserverLocation } from '../config.js';
import type { DriverId } from '../drivers/types.js';
import type { BodyName } from '../astro/sky.js';
import type { Source } from '../media/stream/source.js';
import type { ControlAction } from './routes/control.js';
import { HttpError } from './http.js';

/** What a driver can do, control by control (the UI's buttons and the routes behind them). */
export interface Capabilities {
  nudge: boolean;
  home: boolean;
  level: boolean;
  park: boolean;
  goto: boolean;
  photo: boolean;
  burst: boolean;
  record: boolean;
  timelapse: boolean;
  stack: boolean;
  autofocus: boolean;
  autofocusAstro: boolean;
  focusSteps: boolean;
  /** one tele frame measured for star sharpness */
  starFocus: boolean;
  /** the focus sweep on the stars */
  starTune: boolean;
  polarAlign: boolean;
  modes: boolean;
  exposure: boolean;
  gain: boolean;
  sync: boolean;
  liveView: boolean;
  rgb: boolean;
  /** the device switches (lights, the dew heater, power behaviour): WebTelescope.switches */
  switches: boolean;
  reboot: boolean;
  shutdown: boolean;
  /** the SD-card album, sessions on the card, transfers into the library */
  album: boolean;
  sessions: boolean;
  transfer: boolean;
  horizonSurvey: boolean;
  wire: boolean;
  /** the live views the telescope serves */
  video: Array<'tele' | 'wide' | 'stack'>;
  /**
   * One camera exposes at a time (the Seestar): the UI shows one view with a tele/wide switch, the
   * tele showing the live stack while it stacks, instead of a main view and thumbnails that would
   * compete for the camera.
   */
  singleView?: boolean;
}

/** A device switch as the UI shows it; `on` is null while the telescope has not said. */
export interface SwitchView {
  id: string;
  label: string;
  /** what it does, for the tooltip */
  hint: string;
  on: boolean | null;
}

/** The on/off switches the telescope has (each driver its own: the Dwarf's ring light, the Seestar's dew heater…). */
export interface DeviceSwitches {
  /** every switch with what the telescope last reported */
  list(): Promise<SwitchView[]>;
  /** set one; `result` says what happened (whether the telescope confirmed it, where it can) */
  set(id: string, on: boolean): Promise<{ result: string; switches: SwitchView[] }>;
}

/** A GoTo the shared routes have resolved and checked (altitude, the Sun). */
export type GotoTarget = { kind: 'body'; body: BodyName; label: string; oneClick: boolean } | { kind: 'position'; label: string; raHours: number; decDeg: number; oneClick: boolean };

/** The live views: frames for the video socket, the MJPEG route and snapshots. */
export interface VideoHub {
  get(name: string): Source;
  status(): Record<string, unknown>;
  /** the user released the telescope: drop what reads from it */
  release(): void;
  /** the telescope's address changed */
  retarget(): void;
  shutdown(): void;
}

export interface WebTelescope {
  readonly driver: DriverId;
  /** "DWARFLAB Dwarf 3", "ZWO Seestar" */
  readonly label: string;
  /** what the UI renders (see the module comment) */
  readonly state: Record<string, unknown> & { connected: boolean; released: boolean };
  readonly capabilities: Capabilities;
  /** the nudge slider's percent range per camera (the UI shows the rate); absent: the speed is passed as it is */
  readonly nudgeCurve?: { tele: readonly [number, number]; wide: readonly [number, number]; degPerSPerPercent: number; speedMin: number };
  readonly hub: VideoHub;
  location(): ObserverLocation | null;
  requireLocation(): ObserverLocation;
  /** the tele field of view in degrees (the nominal one until the telescope reports its own) */
  teleFovDeg(): { h: number; v: number };
  connectLink(): void;
  release(): void;
  /** E-Stop: stop all movement and operations, keeping the link. Returns what could not be confirmed stopped. */
  emergencyHalt(): Promise<string[]>;
  setHost(host: string): void;
  /** a manual control the route has validated (and checked against `capabilities`) */
  control(b: ControlAction): Promise<unknown>;
  goto(t: GotoTarget): Promise<unknown>;
  /** the device switches, where the driver has any (capabilities.switches) */
  switches?: DeviceSwitches;
  /** the obstruction survey, where the driver can run one */
  /** rehearsal (the Seestar's): everything but the sky, and no mask saved — for checking the mechanics */
  horizonSurvey?: { start(o: { calibrate?: boolean; rehearsal?: boolean }): Promise<{ summary: string }>; stop(): Promise<unknown>; assertAllowed(o?: { rehearsal?: boolean }): void };
  /** recent link traffic for /api/wire */
  wireLines?(n: number, o: { notifications: boolean }): string[];
  /** driver-only API under /api (the Seestar's tunnel and raw RPC) */
  routes?(): Router;
  on(event: 'state' | 'notification', listener: (...args: any[]) => void): unknown;
  off(event: 'state' | 'notification', listener: (...args: any[]) => void): unknown;
}

/** 501 for a control or route the driver's telescope has no equivalent of. */
export function unsupported(scope: Pick<WebTelescope, 'label'>, what: string): HttpError {
  return new HttpError(501, `${what} is not available on the ${scope.label}`);
}
