/**
 * Reading the telescope's state and device information, and the system commands (clock and
 * location, power).
 */
import { config } from '../../config.js';
import { errMsg, logger } from '../../log.js';
import * as http from '../http.js';
import { Cmd } from '../protocol.js';
import { busyWith, isTracking, request, type Core, type Location } from './core.js';
import { notePhotoState } from './photo-watch.js';
import { noteCaptureState } from './session-finish.js';
import { applyDeviceStateInfo } from './state.js';
import { timezoneOffsetHours } from './util.js';

const log = logger('dwarf');

export type PowerAction = 'reboot' | 'shutdown' | 'rgb_on' | 'rgb_off' | 'indicator_on' | 'indicator_off';
const POWER_CMD: Readonly<Record<PowerAction, number>> = Object.freeze({ reboot: 13505, shutdown: 13502, rgb_on: 13500, rgb_off: 13501, indicator_on: 13503, indicator_off: 13504 });
/** The full state read is large; busy firmware takes a while to answer it. */
const STATE_READ_TIMEOUT_MS = 12_000;
/** Power commands are not acknowledged on fw 1.5.3: wait this long at most. */
const POWER_TIMEOUT_MS = 3000;
/** Consecutive state reads without a tele capture that end a tele stack still marked running. */
const NOT_CAPTURING_READS = 2;

export class SystemControl {
  /** consecutive state reads that showed no tele capture while the tele stack was marked running */
  private teleNotCapturingReads = 0;

  constructor(private readonly core: Core) {}

  /** Read the full device state and fold it into the published state. */
  async refreshState(): Promise<Record<string, unknown>> {
    const s = (await request(this.core, Cmd.TASK_GET_DEVICE_STATE_INFO, {}, { timeout: STATE_READ_TIMEOUT_MS })) as Record<string, any>;
    const { teleCapturing, teleCaptureState, telePhotoRunning, shootingModeId } = applyDeviceStateInfo(this.core.store.state, s ?? {});
    noteCaptureState(this.core, 'tele', teleCaptureState);
    notePhotoState(this.core, 'tele', telePhotoRunning);
    if (shootingModeId !== undefined) await this.setModeState(shootingModeId);
    // A stop notification lost in a dropped connection would leave the tele stack "running" for ever:
    // NOT_CAPTURING_READS state reads in a row without a capture end it.
    const { stacks } = this.core;
    if (this.core.store.state.stacking.tele.state === 'running' && !teleCapturing && !stacks.owns('tele', { startGraceOnly: true })) {
      if (++this.teleNotCapturingReads >= NOT_CAPTURING_READS) {
        log.warn(`the tele stack is marked running but the telescope reports no capture in ${NOT_CAPTURING_READS} state reads: marking it ended`);
        stacks.markIdle('tele');
        this.teleNotCapturingReads = 0;
      }
    } else {
      this.teleNotCapturingReads = 0;
    }
    this.core.store.changed();
    return s;
  }

  /** Record the shooting mode, named from the HTTP mode list when it answers. */
  async setModeState(id: number): Promise<void> {
    let name = String(id);
    try {
      name = (await http.getShootingModes()).find((m) => m.id === id)?.name ?? name;
    } catch {
      /* HTTP unavailable: the id stands */
    }
    this.core.store.state.shootingMode = { id, name };
  }

  async refreshDeviceInfo(): Promise<void> {
    try {
      const info = await http.getDeviceInfo();
      const fw = await http.getFirmware().catch(() => null);
      const st = this.core.store.state;
      st.device = { name: info.deviceName, serial: info.sn, ip: info.staIpAddress, firmware: fw?.version };
      if (info.sdCardInfo) st.storage = { availableGB: info.sdCardInfo.availableSize, totalGB: info.sdCardInfo.totalSize };
      this.core.store.changed();
    } catch (err) {
      log.debug(`device info unavailable: ${errMsg(err)}`);
    }
  }

  async syncTimeLocation(loc: Location | null = this.core.location()): Promise<string[]> {
    // the clock and site under a running capture or a tracking mount could disturb it (as on a reconnect)
    const what = 'setting the time and location';
    this.core.guards.assertNoOperation(what);
    const busy = busyWith(this.core) ?? (isTracking(this.core.store.state) ? 'tracking' : null);
    if (busy) throw new Error(`refused: ${what} while the telescope is busy with ${busy} could disturb it; do it when that has ended`);
    const done: string[] = [];
    const now = Date.now();
    const tzOffset = timezoneOffsetHours(config.observer.timezone, now) ?? -new Date(now).getTimezoneOffset() / 60;
    await request(this.core, Cmd.SYSTEM_SET_TIME, { timestamp: Math.floor(now / 1000), timezoneOffset: tzOffset });
    done.push(`time=${new Date(now).toISOString()} (UTC${tzOffset >= 0 ? '+' : ''}${tzOffset})`);
    await request(this.core, Cmd.SYSTEM_SET_TIME_ZONE, { timezone: config.observer.timezone }, { allowError: true });
    done.push(`timezone=${config.observer.timezone}`);
    if (loc) {
      await request(this.core, Cmd.SYSTEM_SET_LOCATION, { latitude: loc.lat, longitude: loc.lon, altitude: loc.elev, enable: true });
      done.push(`location=${loc.lat.toFixed(5)},${loc.lon.toFixed(5)} elev ${loc.elev}m`);
    }
    log.info(`synced ${done.join(', ')}`);
    return done;
  }

  /** fw 1.5.3 acts on these without acknowledging them; a reboot or shutdown closing the link is the command working. */
  async power(action: PowerAction): Promise<void> {
    if (!Object.hasOwn(POWER_CMD, action)) throw new Error(`unknown power action "${action}" (${Object.keys(POWER_CMD).join(', ')})`);
    try {
      await request(this.core, POWER_CMD[action], {}, { bestEffort: true, timeout: POWER_TIMEOUT_MS });
    } catch (err) {
      if (!((action === 'reboot' || action === 'shutdown') && /connection closed/.test(errMsg(err)))) throw err;
    }
  }
}
