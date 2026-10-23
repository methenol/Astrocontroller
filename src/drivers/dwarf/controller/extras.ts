/**
 * The device switches the official SDK never registered: the anti-tangle (electronic) limit, the
 * lens defogger, automatic cooling, automatic shutdown, the boot power sound, and shooting
 * do-not-disturb.
 *
 * All six come from the APK's `WsCmd` (module `DEVICE`) and all six carry one `state` field, 0 off
 * and 1 on — `data.bean.ws.DeviceSwitchState`, whose beans the settings screen builds from a plain
 * boolean (`ElectronicLimitReq`, `WsSetLensDefogReq`, `WsSetAutoCoolingReq`, `WsSetAutoShutdownReq`).
 * The APK sends them with `fua.b()` without waiting for a reply, and learns the result from the
 * switch's own notification (`CMD_NOTIFY_*_STATE`, named and decoded by protocol/notify.ts) and from
 * the periodic state read. This does the same, so `confirmed` reports whether the device was seen to
 * agree within the window rather than pretending the send was acknowledged.
 *
 * `CMD_DEVICE_SET_POWER_SOUND` and `CMD_DEVICE_SHOOTING_DO_NOT_DISTURB` are declared by the APK but
 * its own UI never sends them: a `confirmed: false` from those two most likely means the firmware
 * does not implement them, not that the send failed.
 */
import { DwarfCommandError, type Notification } from '../link.js';
import { responseType } from '../protocol.js';
import { logger } from '../../../log.js';
import { commandInfo } from '../wire/index.js';
import { request, type Core } from './core.js';
import { deviceOn } from './util.js';
import type { TelescopeState } from './state.js';

const log = logger('dwarf');

/** `DeviceSwitchState.fromEnabled(enabled)`. */
const SWITCH = { off: 0, on: 1 } as const;
/** The APK declares no response payload for these; this is only a grace for one that answers anyway. */
const REPLY_MS = 50;
/** How long to wait for the reply of a command that does declare a response. */
const ANSWERED_REPLY_MS = 4_000;
/** How long to wait for the switch's own state notification. */
const NOTIFY_MS = 5_000;

export interface SwitchResult {
  /** the `ComResponse.code` the device answered with; 0 when it answered with none */
  code: number;
  /** the device reported the switch in the requested position (false: not seen in time) */
  confirmed: boolean;
}

export class DeviceExtrasControl {
  constructor(private readonly core: Core) {}

  /** Anti-tangle (electronic) limit: the mount stops before the cable can be wound up. */
  setAntiTangle(on: boolean): Promise<SwitchResult> {
    return this.set('CMD_DEVICE_ANTI_TANGLE', 'antiTangleState', on);
  }

  /** The lens defogger heater. */
  setLensDefog(on: boolean): Promise<SwitchResult> {
    return this.set('CMD_DEVICE_LENS_DEFOG', 'lensDefogState', on);
  }

  /** Automatic CMOS cooling: the firmware regulates the sensor instead of the user. */
  setAutoCooling(on: boolean): Promise<SwitchResult> {
    return this.set('CMD_DEVICE_AUTO_COOLING', 'autoCoolingState', on);
  }

  /** Automatic shutdown when idle. */
  setAutoShutdown(on: boolean): Promise<SwitchResult> {
    return this.set('CMD_DEVICE_AUTO_SHUTDOWN', 'autoShutdownState', on);
  }

  /** The startup power sound (the APK declares this command; its own UI never sends it). */
  setPowerSound(on: boolean): Promise<SwitchResult> {
    return this.set('CMD_DEVICE_SET_POWER_SOUND', 'powerSoundState', on);
  }

  /** Silence notifications while shooting (the APK declares this command; its own UI never sends it). */
  setDoNotDisturb(on: boolean): Promise<SwitchResult> {
    return this.set('CMD_DEVICE_SHOOTING_DO_NOT_DISTURB', 'shootingDoNotDisturbState', on);
  }

  /** What the telescope last reported, from the state read and the switch notifications. */
  switches(): NonNullable<TelescopeState['switches']> {
    return this.core.store.state.switches ?? {};
  }

  private async set(commandName: string, notification: string, on: boolean): Promise<SwitchResult> {
    const cmd = commandInfo(commandName).id;
    const state = on ? SWITCH.on : SWITCH.off;
    const matches = (n: Notification) => n.name === notification && deviceOn(n.data.state) === on;
    // Listen before sending. The switch reports itself as soon as it has been applied, which for a
    // device that answers nothing at all is the only evidence there is — a listener registered after
    // the reply wait would miss it and report a switch that did move as unconfirmed.
    const confirmed = this.core.link.waitFor(matches, NOTIFY_MS).then(
      () => true,
      () => false,
    );
    // The APK sends these without waiting for a reply, and its `WsCmd` declares no response payload;
    // holding the caller for a reply nobody asked for would stall every switch for the whole window.
    const reply = (await request(this.core, cmd, { state }, { bestEffort: true, timeout: responseType(cmd) ? ANSWERED_REPLY_MS : REPLY_MS })) as Record<string, any> | null;
    const code = typeof reply?.code === 'number' ? reply.code : 0;
    if (code < 0) throw new DwarfCommandError(cmd, code, reply ?? {});
    const seen = await confirmed;
    if (!seen) log.warn(`${commandName} (${on ? 'on' : 'off'}) sent; no ${notification} within ${NOTIFY_MS / 1000} s`);
    return { code, confirmed: seen };
  }
}
